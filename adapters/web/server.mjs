#!/usr/bin/env node
// atf-web: ATF in the browser (docs/webui-design.md §4.4). One server per user, on
// 127.0.0.1 only: reach it through one SSH tunnel (ssh -L 7420:localhost:7420 devpod).
//
//   GET  /?token=…          sets the session cookie (the URL atf-web prints)
//   GET  /api/overview      projects, their plans (open plans with their folded state),
//                           what needs the human, the plans' agents
//   GET  /api/plan          ?root&plan   one plan (closed ones too)
//   GET  /api/brief         ?root&plan[&task]   what to know to act on a task / the plan
//   GET  /api/doc           ?root&plan&doc      a plan document
//   GET  /api/log           ?root&plan[&n]      the plan's last events
//   GET  /api/live          ?root&plan&task     a task's runs (builds, tests, pipelines)
//   GET  /api/live/run      ?root&plan&task&ref[&raw][&item]  one run: its view, output, an item
//   GET  /api/changes       ?root&plan          files each task changed, with line counts
//   GET  /api/diff          ?root&plan[&task][&file]  the patch of a task / the plan / a file
//   GET  /api/file          ?root&path          a file of the project (the file viewer)
//   POST /api/action        {root, plan, action, task?, message?, status?}  as the human
//   POST /api/coordinator   {root, plan, fresh?, kind?}  start / resume / replace it
//   GET  /api/stream        server-sent events: {plans: [key], sessions: bool} on changes
//   GET  /api/overview?only=<key>\t<seq>\n…   only those plans (the rest {key, same}); of each,
//                          the tasks changed since the version (seq) the page has (`delta`)
//   GET  /api/task         one task in full (history, notes, artifacts), for its page
//   POST /api/shell        a new shell (in a plan's project, or home); /api/shell/close ends one
//   WS   /ws                the agents' terminals and the shells, relayed to atf-sessiond
//
// Reads go through store/core, writes through src/actions.mjs (the same events as the
// board and the CLI). The server also runs the supervisor (src/supervisor.mjs).
import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { knownRoots, listPlanIds, readEvents, eventsPath, readConfig } from '../../src/store.mjs';
import { fold, brief, HUMAN } from '../../src/core.mjs';
import { attentionOf, liveAgent } from '../../src/attention.mjs';
import { humanAction, ACTIONS } from '../../src/actions.mjs';
import { liveDir, activeRuns, taskLive, liveBadge, liveView, liveItem, hasView, hasItem, readTail, earlierText, loadLiveKinds, enableAutoRefresh } from '../../src/live.mjs';
import { planChanges, changeMode, levelSets, totals, onlyFile, patchText, projectPath } from '../../src/changes.mjs';
import { keyOf, describe } from '../../src/notify.mjs';
import { userConfigDir } from '../../src/config.mjs';
import { sessionsBackend, sessionsLiveness, sessionAgent, socketPath, ensureDaemon, connect } from '../../src/sessions.mjs';
import { startSupervisor } from '../../src/supervisor.mjs';
import { wsAccept } from './ws.mjs';
import { relay } from './relay.mjs';
import { fork } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const SESSIONS_CLI = path.resolve(HERE, '../../bin/atf-sessions.mjs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

/** The token in the URL atf-web prints: ~/.config/atf/web-token (0600), made once. */
export function webToken(file = path.join(userConfigDir(), 'web-token')) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const strip = ({ st, ...rest }) => rest; // attention items carry their plan; the client has it
/** An item that needs the human, with what a notification says and its identity. */
const said = (it) => ({ ...strip(it), text: describe(it), nkey: keyOf(it) });

/** Per task with something live: what runs or waits now, else a failed run ({glyph, text, color}). */
function liveBadges(root, id, st, runs = activeRuns(root, id), lives = new Map()) {
  const out = {};
  for (const tid of st.order) {
    const t = st.tasks[tid];
    if (t.children.length || ['todo', 'cancelled'].includes(t.status)) continue;
    const b = liveBadge(liveOf(lives, t, runs));
    if (b) out[tid] = b;
  }
  return out;
}

/**
 * Per task in flight (in progress, blocked, in review): its run at a glance, for the
 * cockpit: the run running or waiting now, else its latest current one; the kind's compact
 * view (what the board shows below a task), at most 7 lines of [text, style] segments.
 */
/** A task's live runs, once per overview (badges and glances share them). */
const liveOf = (lives, t, runs) => {
  if (!lives.has(t.id)) lives.set(t.id, taskLive(t, runs));
  return lives.get(t.id);
};
function liveGlances(root, id, st, runs = activeRuns(root, id), lives = new Map()) {
  const out = {};
  for (const tid of st.order) {
    const t = st.tasks[tid];
    if (t.children.length || !['in_progress', 'blocked', 'review'].includes(t.status)) continue;
    const live = liveOf(lives, t, runs);
    const r = live.now.find((x) => x.waiting) || live.now[0] || live.recorded[0];
    if (!r) continue;
    let lines = [];
    try {
      lines = liveView(r, r.summary, { width: 110, full: false, active: !!r.active })
        .filter((l) => !l.section)
        .slice(0, 7)
        .map((l) => [...l]);
    } catch {}
    out[tid] = { ...runOut(r), lines, runs: live.now.length + live.recorded.length };
  }
  return out;
}

/** A run or artifact for the client: what the list and the view's head show. */
const runOut = (x) => ({
  ref: x.out || x.ref,
  kind: x.kind,
  cmd: x.cmd ?? null,
  cwd: x.cwd ?? null,
  since: x.since ?? null,
  ts: x.ts ?? null,
  exit: x.exit ?? null,
  duration_ms: x.duration_ms ?? null,
  active: !!x.active,
  waiting: !!x.waiting,
  approval: !!x.approval,
  live: !!x.live,
  superseded: !!x.superseded,
  actor: x.actor ?? null,
  description: x.description ?? null,
  summary: { state: x.summary.state, line: x.summary.line, counts: x.summary.counts, mtime: x.summary.mtime ?? null },
  view: hasView(x.kind),
  items: hasItem(x.kind),
});
/** The runs of a task, in the order the board's live view goes through them. */
function liveRunsOf(root, id, st, task) {
  const t = st.tasks[task];
  if (!t) throw Object.assign(new Error(`unknown task ${task}`), { status: 404 });
  const live = taskLive(t, activeRuns(root, id));
  return { live, runs: [...live.now.filter((n) => n.waiting), ...live.now.filter((n) => !n.waiting), ...live.recorded] };
}
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ORPHAN_MS = 10 * 60_000; // a task in progress without an agent and without activity this long: flagged
const MAX_FILE = 2 << 20; // the file viewer shows at most this much of a file

/**
 * Start the server. Returns {server, url, port, close()}. Options: port (0: any free),
 * token, supervise (run the supervisor; default true), pollMs (change detection).
 */
export async function startWebServer({ port = 7420, host = '127.0.0.1', token = webToken(), supervise = true, pollMs = 1000, log = () => {} } = {}) {
  const socket = socketPath();
  ensureDaemon(socket);
  // live kinds from plugins (docs/live-plugins.md); their refresh (e.g. a CI API) runs in
  // the background for what is looked at
  enableAutoRefresh();
  await loadLiveKinds().catch((e) => log(`live plugins: ${e.message}`));
  const backend = sessionsBackend({ socket });

  // ---------- sessions: one connection, a current list ----------
  let sessions = [];
  let daemon = null;
  const refreshSessions = async () => {
    try {
      if (!daemon) {
        daemon = connect((m) => {
          if (m.ev === 'sessions') sessions = m.list;
          if (m.ev === 'closed') daemon = null;
        }, socket);
      }
      sessions = (await daemon.request({ op: 'list' })).list;
    } catch (e) {
      daemon = null;
      try {
        ensureDaemon(socket); // it ended (atf-sessions stop): start a new one
      } catch {}
    }
  };
  await refreshSessions();

  // ---------- plans: folded once per change of their log ----------
  const planCache = new Map(); // key -> {sig, st}
  const repoCache = new Map(); // root -> git common dir (worktrees of one repository group under it)
  const roots = () => {
    const seen = new Map();
    for (const r of [...knownRoots(), ...sessions.map((x) => x.meta?.root).filter(Boolean)]) {
      const k = real(r);
      if (!seen.has(k) && fs.existsSync(path.join(k, 'plans'))) seen.set(k, k);
    }
    return [...seen.values()];
  };
  const sigOf = (root, id) => {
    try {
      const s = fs.statSync(eventsPath(root, id));
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return 'none';
    }
  };
  function plan(root, id) {
    return entry(root, id).st;
  }
  function entry(root, id) {
    const key = `${root}#${id}`;
    const sig = sigOf(root, id);
    const hit = planCache.get(key);
    if (hit?.sig === sig) return hit;
    const st = fold(readEvents(root, id));
    st.root = root;
    const e = { sig, st, slim: null };
    planCache.set(key, e);
    return e;
  }
  /**
   * A plan as the cockpit gets it: per task what the panels show (state, owner, tree, steps,
   * dependencies, acceptance), its long parts (history, notes, artifacts, attempts, the
   * description beyond a line) left to /api/task when a task is opened; the plan's last
   * notes. A big plan is a few KB per task less on every refresh.
   */
  const LITE = ['id', 'title', 'status', 'rollup_status', 'owner', 'assignee', 'reviewer', 'agent', 'parent', 'depth', 'path', 'children', 'deps', 'waiting_on', 'blocked_on', 'blocked_for', 'ready', 'steps', 'percent', 'last_message', 'acceptance', 'priority', 'labels', 'changes_requested', 'created_at', 'started_at', 'updated_at', 'finished_at'];
  const RUN_KINDS = new Set(['maven', 'tests', 'pipeline', 'build', 'deploy', 'wait']);
  const PLAN_DROP = new Set(['tasks', 'actors', 'reviews', 'questions', 'human_input', 'meta', 'session', 'notes']);
  function slimPlan(root, id) {
    const e = entry(root, id);
    if (!e.slim) {
      const tasks = {};
      for (const [tid, t] of Object.entries(e.st.tasks)) {
        const x = {};
        for (const k of LITE) if (t[k] !== undefined) x[k] = t[k];
        x.description = t.description && t.description.length > 300 ? t.description.slice(0, 300) + '…' : t.description;
        x.artifacts_total = t.artifacts.length;
        x.history_total = t.history.length;
        tasks[tid] = x;
      }
      const plan = {};
      for (const [k, v] of Object.entries(e.st)) if (!PLAN_DROP.has(k)) plan[k] = v;
      e.slim = { ...plan, notes: (e.st.notes || []).slice(-15), tasks };
      // this version's tasks as sent, to send a page that has it only what changed since
      const v = versionsOf(`${root}#${id}`);
      v.set(e.st.last_seq, Object.fromEntries(Object.entries(tasks).map(([tid, x]) => [tid, JSON.stringify(x)])));
      while (v.size > VERSIONS) v.delete(v.keys().next().value);
    }
    return e.slim;
  }
  // per plan, its last versions' tasks (seq -> {task id: JSON}); a page names the version it has
  const VERSIONS = 30;
  const versions = new Map();
  const versionsOf = (key) => (versions.has(key) || versions.set(key, new Map()), versions.get(key));
  /**
   * The plan for a page that has version `seq`: its tasks that differ from that version
   * (`delta`: seq, `removed`: ids gone); everything when that version is not kept.
   */
  function planSince(root, id, seq) {
    const st = slimPlan(root, id);
    const old = seq != null ? versionsOf(`${root}#${id}`).get(seq) : null;
    if (!old || seq === st.last_seq) return old ? { st: { ...st, tasks: {} }, delta: seq, removed: [] } : { st };
    const now = versionsOf(`${root}#${id}`).get(st.last_seq);
    const tasks = {};
    for (const [tid, j] of Object.entries(now)) if (old[tid] !== j) tasks[tid] = st.tasks[tid];
    return { st: { ...st, tasks }, delta: seq, removed: Object.keys(old).filter((tid) => !(tid in now)) };
  }
  /** One task in full, for its page: the last of its history and artifacts (runs: /api/live). */
  function fullTask(root, id, tid) {
    const t = plan(root, id).tasks[tid];
    if (!t) return null;
    return { ...t, history: t.history.slice(-200), history_total: t.history.length, artifacts: t.artifacts.filter((a) => !a.live && !a.cmd && !RUN_KINDS.has(a.kind)).slice(-100), artifacts_total: t.artifacts.length };
  }
  function repoOf(root) {
    if (!repoCache.has(root)) {
      let repo = null;
      try {
        repo = real(path.resolve(path.dirname(root), execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: path.dirname(root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()));
        repo = path.basename(repo) === '.git' ? path.dirname(repo) : repo;
      } catch {}
      repoCache.set(root, repo);
    }
    return repoCache.get(root);
  }

  const agentsOf = (root, id) => sessions.filter((x) => x.meta?.root && real(x.meta.root) === root && (x.meta.plan === id || (!x.meta.plan && x.meta.role === 'coordinator'))).map(sessionAgent);

  /**
   * Per task in progress with an agent owner and no session of it here: `elsewhere` when
   * its writes came from herdr or another daemon; `orphan` when nothing happened on it for
   * ORPHAN_MS either (no command running, no update): work nobody does, which the cockpit
   * flags. An agent ATF did not start (a subagent of your own harness) is active, not lost.
   */
  function healthOf(lv, root, id, st) {
    const out = {};
    const runs = activeRuns(root, id);
    for (const tid of st.order) {
      const t = st.tasks[tid];
      if (t.status !== 'in_progress' || t.children.length || !t.owner || t.owner === HUMAN) continue;
      if (liveAgent(lv, { ...st, root }, t.owner)) continue;
      const actor = st.actors[t.owner];
      if (actor && !lv.local(actor)) out[tid] = 'elsewhere';
      else if (!runs.some((r) => r.task === tid) && Date.now() - Date.parse(t.updated_at) > ORPHAN_MS) out[tid] = 'orphan';
    }
    return out;
  }

  /** One plan for the client: its state, attention, agents. Closed plans: no attention. */
  function planView(root, id, lv = sessionsLiveness(sessions, socket), seq = null) {
    const st = plan(root, id);
    const key = `${root}#${id}`;
    const open = ['active', 'paused'].includes(st.status);
    const att = open ? attentionOf(lv, { root, id, st, key }) : { mine: [], queued: [], todos: [], coord: { id: st.coordinator || null, live: null, away: false } };
    const runs = open ? activeRuns(root, id) : [];
    const lives = new Map();
    return {
      key,
      root,
      id,
      ...(open ? planSince(root, id, seq) : { st: slimPlan(root, id) }),
      open,
      attention: { mine: att.mine.map(said), queued: att.queued.map(strip), todos: att.todos.map(said) },
      live: open ? liveBadges(root, id, st, runs, lives) : {},
      glance: open ? liveGlances(root, id, st, runs, lives) : {},
      health: open ? healthOf(lv, root, id, st) : {},
      coordinator: { id: att.coord.id, live: att.coord.live, away: att.coord.away },
      agents: agentsOf(root, id),
    };
  }

  /** `only`: the keys of the plans to send (the others the page has: {key, same: true}). */
  function overview(only = null) {
    const lv = sessionsLiveness(sessions, socket);
    const projects = roots().map((root) => {
      const plans = listPlanIds(root).map((id) => {
        const key = `${root}#${id}`;
        if (only && !only.has(key)) {
          const st = plan(root, id);
          if (['active', 'paused'].includes(st.status)) return { key, root, id, open: true, same: true };
        }
        const v = planView(root, id, lv, only?.get(key) ?? null);
        if (v.open) return v;
        // a closed plan: enough to list it
        const { st } = v;
        return { key: v.key, root, id, open: false, summary: { title: st.title, status: st.status, progress: st.progress, total: st.total, updated_at: st.updated_at } };
      });
      return { root, dir: path.dirname(root), name: path.basename(path.dirname(root)), repo: repoOf(root), plans };
    });
    return { human: HUMAN, now: Date.now(), home: os.homedir(), projects, shells: shellsOf(), sessions: sessions.length };
  }

  // ---------- shells: the user's own terminals on this machine, in the daemon too ----------
  // (role 'shell' in their meta: not an agent, never found as one, left alone by the supervisor)
  const isShell = (x) => x.meta?.role === 'shell';
  /**
   * A shell's state: a command running (its terminal's foreground process is not the shell:
   * `working`, with the command's name) or the shell at its prompt (`idle`); `since` when
   * that last changed. Its output says nothing here: typing echoes, prompts redraw.
   */
  const shellsOf = () =>
    sessions.filter(isShell).map((x) => {
      const f = shellFg.get(x.id);
      return { id: x.id, name: x.meta.name, cwd: x.cwd, pk: x.meta.pk ?? null, project: x.meta.project ?? null, started: x.started, exited: !!x.exited, code: x.code ?? null, status: x.exited ? 'exited' : f?.fg ? 'working' : 'idle', fg: x.exited ? null : f?.fg ?? null, since: x.exited ? x.lastOutput : f?.since ?? x.started };
    });
  // per shell: what runs in its foreground ({fg: command name | null, since}), every poll
  const shellFg = new Map();
  const ps = (args) => new Promise((resolve) => execFile('ps', args, { timeout: 2000 }, (err, out) => resolve(err ? '' : out)));
  async function pollShells() {
    const live = sessions.filter((x) => isShell(x) && !x.exited && x.pid);
    for (const id of shellFg.keys()) if (!live.some((x) => x.id === id)) shellFg.delete(id);
    if (!live.length) return;
    const tp = new Map();
    for (const l of (await ps(['-o', 'pid=,tpgid=', '-p', live.map((x) => x.pid).join(',')])).split('\n')) {
      const [pid, tpgid] = l.trim().split(/\s+/).map(Number);
      if (pid) tp.set(pid, tpgid);
    }
    const fgPids = [...new Set(live.map((x) => tp.get(x.pid)).filter((g) => g > 0 && !live.some((x) => x.pid === g)))];
    const names = new Map();
    if (fgPids.length)
      for (const l of (await ps(['-o', 'pid=,comm=', '-p', fgPids.join(',')])).split('\n')) {
        const m = l.trim().match(/^(\d+)\s+(.*)$/);
        if (m) names.set(Number(m[1]), path.basename(m[2]).replace(/^-/, ''));
      }
    for (const x of live) {
      const g = tp.get(x.pid);
      const fg = g > 0 && g !== x.pid ? names.get(g) ?? 'a command' : null;
      const prev = shellFg.get(x.id);
      if (!prev || prev.fg !== fg) shellFg.set(x.id, { fg, since: Date.now() });
    }
  }
  /** A new shell: the user's login shell, in a plan's project folder (or home). */
  async function newShell({ root, plan, cols, rows }) {
    const r = root ? known(root, plan) : null;
    const cwd = r ? path.dirname(r) : os.homedir();
    const n = sessions.filter(isShell).length + 1;
    const id = `sh-${crypto.randomBytes(3).toString('hex')}`;
    const name = `shell ${n}`;
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^ATF_(PLAN|ACTOR|ROLE|DIR)$/.test(k)) delete env[k]; // not an agent of a plan
    const shell = process.env.SHELL || '/bin/sh';
    await daemon.request({ op: 'create', id, name, argv: [shell, '-l'], cwd, env, cols: cols || 120, rows: rows || 32, meta: { role: 'shell', name, actor: `shell:${id}`, pk: r && plan ? `${r}#${plan}` : null, project: r ? path.basename(cwd) : null } });
    await refreshSessions();
    return { ok: true, id, name, cwd };
  }

  const known = (root, id) => {
    const r = root && real(root);
    if (!r || !roots().includes(r)) throw Object.assign(new Error(`unknown project ${root}`), { status: 404 });
    if (id && !listPlanIds(r).includes(id)) throw Object.assign(new Error(`unknown plan ${id}`), { status: 404 });
    return r;
  };

  // ---------- changes (git): per plan, again when it changed or after a while ----------
  const changesCache = new Map(); // key -> {seq, at, promise}
  function changesOf(root, id) {
    const key = `${root}#${id}`;
    const st = plan(root, id);
    const hit = changesCache.get(key);
    // the working tree changes without events (an agent edits): at most 10 s old
    if (hit && hit.seq === st.last_seq && Date.now() - hit.at < 10_000) return hit.promise;
    const promise = planChanges(path.dirname(root), st, { mode: changeMode(readConfig(root)) });
    changesCache.set(key, { seq: st.last_seq, at: Date.now(), promise });
    promise.catch(() => changesCache.delete(key));
    return promise;
  }

  /** A file inside the project, for the file viewer: never outside it (symlinks resolved). */
  function readProjectFile(root, rel) {
    if (!rel) throw Object.assign(new Error('which file?'), { status: 400 });
    const dir = real(path.dirname(root));
    let file;
    try {
      file = fs.realpathSync(path.resolve(dir, rel));
    } catch {
      throw Object.assign(new Error(`no file ${rel}`), { status: 404 });
    }
    if (file !== dir && !file.startsWith(dir + path.sep)) throw Object.assign(new Error('outside the project'), { status: 403 });
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw Object.assign(new Error(`${rel} is not a file`), { status: 400 });
    const out = { path: path.relative(dir, file), size: stat.size, mtime: stat.mtimeMs, truncated: stat.size > MAX_FILE };
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, MAX_FILE));
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (buf.subarray(0, 8192).includes(0)) return { ...out, binary: true, text: null };
      return { ...out, binary: false, text: buf.toString('utf8') };
    } finally {
      fs.closeSync(fd);
    }
  }

  // ---------- change detection, server-sent events ----------
  const streams = new Set();
  let lastSigs = new Map();
  let lastSessions = '';
  const liveSig = (root, id) => {
    const d = liveDir(root, id);
    const parts = [];
    // what running commands write (a build's progress changes the task's badge)
    for (const r of activeRuns(root, id)) {
      try {
        parts.push(`${r.out}:${fs.statSync(r.out).size}`);
      } catch {}
    }
    for (const sub of ['', 'status']) {
      try {
        for (const f of fs.readdirSync(path.join(d, sub))) if (f.endsWith('.json')) parts.push(`${sub}/${f}:${fs.statSync(path.join(d, sub, f)).mtimeMs}`);
      } catch {}
    }
    return parts.join(',');
  };
  async function poll() {
    await refreshSessions();
    const changed = [];
    const sigs = new Map();
    for (const root of roots())
      for (const id of listPlanIds(root)) {
        const key = `${root}#${id}`;
        const sig = `${sigOf(root, id)}|${liveSig(root, id)}`;
        sigs.set(key, sig);
        if (lastSigs.get(key) !== sig) changed.push(key);
      }
    // sessions: which exist, and what their agents do
    await pollShells();
    // (a shell: whether a command runs, not its output)
    const sSig = sessions.map((x) => `${x.id}:${x.exited}:${isShell(x) ? shellFg.get(x.id)?.fg ?? '' : sessionAgent(x).status}`).join(',');
    const sChanged = sSig !== lastSessions;
    lastSessions = sSig;
    const first = !lastSigs.size;
    lastSigs = sigs;
    if (!first && (changed.length || sChanged)) for (const s of streams) s.write(`data: ${JSON.stringify({ plans: changed, sessions: sChanged })}\n\n`);
  }
  let polling = false;
  const pollTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      await poll();
    } catch (e) {
      log(`poll: ${e.message}`);
    } finally {
      polling = false;
    }
  }, pollMs);
  const keepAlive = setInterval(() => streams.forEach((s) => s.write(': keep-alive\n\n')), 25_000);

  const stopSupervisor = supervise ? startSupervisor(backend, { onActions: (a) => a.forEach((x) => log(`supervisor: ${x}`)), onError: (e) => log(`supervisor: ${e.message}`) }) : () => {};

  // ---------- HTTP ----------
  const cookieOk = (req) => (req.headers.cookie || '').split(/;\s*/).includes(`atf_token=${token}`);
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    try {
      return new URL(o).host === req.headers.host;
    } catch {
      return false;
    }
  };
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let b = '';
      req.on('data', (d) => {
        b += d;
        if (b.length > 1 << 20) reject(Object.assign(new Error('too large'), { status: 413 })), req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(b ? JSON.parse(b) : {});
        } catch {
          reject(Object.assign(new Error('not JSON'), { status: 400 }));
        }
      });
    });

  /** Start / resume / replace a coordinator: in a child process (a handoff can take minutes). */
  const coordinate = (root, id, { fresh, kind }) =>
    new Promise((resolve) => {
      const args = [SESSIONS_CLI, 'coordinate', '--plan', id, ...(fresh ? ['--fresh'] : []), ...(kind ? ['--kind', String(kind)] : [])];
      const env = { ...process.env, ATF_DIR: root, ATF_SESSIOND_SOCKET: socket };
      for (const k of ['ATF_PLAN', 'ATF_ACTOR', 'ATF_ROLE', 'ATF_BACKEND']) delete env[k];
      execFile(process.execPath, args, { cwd: path.dirname(root), env, timeout: 300_000 }, (err, stdout, stderr) => {
        resolve(err ? { ok: false, message: String(stderr || err.message).trim().replace(/^atf-sessions: /, '') } : { ok: true, message: stdout.trim() });
      });
    });

  async function api(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    const route = `${req.method} ${url.pathname}`;
    if (req.method === 'POST' && !/^application\/json\b/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON only' });
    switch (route) {
      case 'GET /api/overview': {
        // only=<key>\t<the version the page has>, a line per plan
        const only = url.searchParams.get('only');
        const want = only == null ? null : new Map(only.split('\n').filter(Boolean).map((l) => { const [k, v] = l.split('\t'); return [k, v ? Number(v) : null]; }));
        return json(res, 200, overview(want));
      }
      case 'GET /api/task': {
        const root = known(url.searchParams.get('root'), url.searchParams.get('plan'));
        const t = fullTask(root, url.searchParams.get('plan'), url.searchParams.get('task'));
        return t ? json(res, 200, t) : json(res, 404, { error: 'no such task' });
      }
      case 'GET /api/plan':
        return json(res, 200, planView(known(q.root, q.plan), q.plan));
      case 'GET /api/brief': {
        const st = plan(known(q.root, q.plan), q.plan);
        const b = brief(st, q.task || null);
        return b ? json(res, 200, b) : json(res, 404, { error: `unknown task ${q.task}` });
      }
      case 'GET /api/log': {
        // the plan's events, newest last (the Log view): the last `n` (default 400)
        const root = known(q.root, q.plan);
        const evs = readEvents(root, q.plan);
        const n = Math.min(Number(q.n) || 400, 5000);
        return json(res, 200, { total: evs.length, events: evs.slice(-n) });
      }
      case 'GET /api/live': {
        const root = known(q.root, q.plan);
        const { live, runs } = liveRunsOf(root, q.plan, plan(root, q.plan), q.task);
        return json(res, 200, { runs: runs.map(runOut), earlier: live.earlier.map(runOut), earlierText: earlierText(live) });
      }
      case 'GET /api/live/run': {
        // only runs ATF recorded for the task: the view reads their files, nothing else
        const root = known(q.root, q.plan);
        const st = plan(root, q.plan);
        const { live, runs } = liveRunsOf(root, q.plan, st, q.task);
        const x = [...runs, ...live.earlier].find((y) => (y.out || y.ref) === q.ref);
        if (!x) return json(res, 404, { error: 'no such run on this task (it may have ended: reload the list)' });
        const out = { run: runOut(x) };
        if (q.item != null) out.item = liveItem(x, x.summary, q.item, { width: 140 }) || [[['(no details for this item)', 'dim']]];
        else if (q.raw != null || !hasView(x.kind)) {
          const file = x.out || x.ref;
          const text = readTail(file, 512 << 10);
          out.raw = text == null ? null : text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
        } else out.lines = liveView(x, x.summary, { width: 140, full: true, active: !!x.active }).map((l) => ({ segs: [...l], section: l.section ?? null, folded: !!l.folded, item: l.item ?? null }));
        return json(res, 200, out);
      }
      case 'GET /api/changes': {
        const root = known(q.root, q.plan);
        const c = await changesOf(root, q.plan);
        const sets = (list) => list.map((x) => ({ repo: x.repo, rel: x.rel, branch: x.branch ?? null, live: !!x.live && !x.target, files: x.files.map((f) => ({ ...f, project: projectPath(x, f) })) }));
        const per = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { sets: sets(v), totals: totals(v) }]));
        return json(res, 200, { mode: c.mode, tasks: per(c.tasks), groups: per(c.groups), plan: { sets: sets(c.plan), totals: totals(c.plan) } });
      }
      case 'GET /api/diff': {
        const root = known(q.root, q.plan);
        const c = await changesOf(root, q.plan);
        let sets = levelSets(c, q.task || null);
        if (q.file) sets = onlyFile(sets, path.dirname(root), q.file);
        return json(res, 200, { text: sets.length ? await patchText(sets) : '' });
      }
      case 'GET /api/file': {
        const root = known(q.root);
        return json(res, 200, readProjectFile(root, q.path));
      }
      case 'GET /api/doc': {
        const root = known(q.root, q.plan);
        const st = plan(root, q.plan);
        // only the plan's own documents, inside the project
        if (!st.docs.includes(q.doc)) return json(res, 404, { error: 'not a document of this plan' });
        const file = path.resolve(path.dirname(root), q.doc);
        if (!file.startsWith(path.dirname(root) + path.sep)) return json(res, 403, { error: 'outside the project' });
        return json(res, 200, { doc: q.doc, text: fs.readFileSync(file, 'utf8') });
      }
      case 'POST /api/action': {
        const b = await readBody(req);
        if (!ACTIONS.includes(b.action)) return json(res, 400, { error: `unknown action ${b.action}` });
        const root = known(b.root, b.plan);
        const r = humanAction(root, b.plan, b.action, { task: b.task, message: b.message, status: b.status });
        poll().catch(() => {});
        return json(res, r.ok ? 200 : 409, r);
      }
      case 'POST /api/shell': {
        const b = await readBody(req);
        try {
          const r = await newShell(b);
          poll().catch(() => {});
          return json(res, 200, r);
        } catch (e) {
          return json(res, e.status || 500, { ok: false, message: e.message });
        }
      }
      case 'POST /api/shell/close': {
        const b = await readBody(req);
        const x = sessions.find((y) => y.id === b.id);
        if (!x || !isShell(x)) return json(res, 404, { ok: false, message: 'no such shell' });
        await daemon.request({ op: 'remove', id: x.id });
        await refreshSessions();
        poll().catch(() => {});
        return json(res, 200, { ok: true });
      }
      case 'POST /api/coordinator': {
        const b = await readBody(req);
        const root = known(b.root, b.plan);
        const r = await coordinate(root, b.plan, b);
        poll().catch(() => {});
        return json(res, r.ok ? 200 : 409, r);
      }
      case 'GET /api/stream': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': hello\n\n');
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      default:
        return json(res, 404, { error: `no ${route}` });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL('http://x' + (req.url.startsWith('/') ? req.url : '/' + req.url)); // never throws on '//…'
    if (url.searchParams.get('token') === token) {
      res.writeHead(302, { 'Set-Cookie': `atf_token=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
      return res.end();
    }
    if (!cookieOk(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Open the URL with the token that atf-web printed (atf-web url shows it again).\n');
    }
    if (url.pathname.startsWith('/api/')) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request' });
      try {
        return await api(req, res, url);
      } catch (e) {
        return json(res, e.status || 500, { error: e.message });
      }
    }
    let rel;
    try {
      rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      return res.writeHead(400).end();
    }
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(404).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  // ---------- the terminals: relayed in a process of their own (relay.mjs) ----------
  // atf-web checks a connection, then hands it to the relay: typing and output never wait
  // for this process (a refresh of the board). Without the relay (it ended): relayed here.
  const relayStats = { handed: 0, here: 0 }; // connections relayed by the relay process / here
  let relayProc = null;
  let relayReady = false;
  let closing = false;
  const startRelay = () => {
    relayReady = false;
    relayProc = fork(path.join(HERE, 'relay.mjs'), [socket], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'json' });
    relayProc.on('message', (m) => m?.type === 'ready' && (relayReady = true));
    relayProc.on('exit', (code) => {
      relayReady = false;
      relayProc = null;
      if (closing) return;
      log(`relay ended (${code}): restarting`);
      setTimeout(() => !closing && startRelay(), 1000).unref();
    });
  };
  startRelay();
  server.on('upgrade', (req, sock) => {
    if (!cookieOk(req) || !sameOrigin(req) || req.url !== '/ws') return sock.destroy();
    if (relayReady && relayProc?.connected) {
      sock.pause();
      relayStats.handed++;
      return relayProc.send({ type: 'ws', headers: { 'sec-websocket-key': req.headers['sec-websocket-key'] } }, sock, (err) => err && sock.destroy());
    }
    relayStats.here++;
    relay(wsAccept(req, sock), socket);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    server,
    port: actual,
    url: `http://localhost:${actual}/?token=${token}`,
    overview,
    relay: () => ({ ...relayStats, ready: relayReady, pid: relayProc?.pid ?? null }),
    close: () =>
      new Promise((resolve) => {
        closing = true;
        relayProc?.kill();
        clearInterval(pollTimer);
        clearInterval(keepAlive);
        stopSupervisor();
        daemon?.close();
        for (const s of streams) s.end();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------- the command ----------
const HELP = `atf-web — ATF in the browser

  atf-web [--port 7420]     serve on 127.0.0.1 (prints the URL to open, with its token)
  atf-web url               the URL again
  atf-web --no-supervise    without the supervisor (when atf-sessions supervise runs)

From another machine: ssh -L 7420:localhost:7420 <host>, then open the URL there.
Agents run in atf-sessiond (started when needed); they outlive the server.
`;

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] ?? true : undefined;
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const port = Number(flag('port') || process.env.ATF_WEB_PORT || 7420);
  if (argv[0] === 'url') {
    process.stdout.write(`http://localhost:${port}/?token=${webToken()}\n`);
    process.exit(0);
  }
  process.on('SIGHUP', () => {}); // survive the terminal that started it
  const stamp = () => new Date().toLocaleTimeString();
  startWebServer({ port, supervise: !argv.includes('--no-supervise'), log: (m) => process.stdout.write(`${stamp()} ${m}\n`) })
    .then((w) => process.stdout.write(`atf-web: ${w.url}\n`))
    .catch((e) => {
      process.stderr.write(`atf-web: ${e.code === 'EADDRINUSE' ? `port ${port} is in use (another atf-web? --port N)` : e.message}\n`);
      process.exit(1);
    });
}

