// Notifications when the human is needed: exactly what the board shows as "needs you"
// (attention.mjs): a question or review for them, a plan question, a finished plan, a
// plan without a coordinator, a coordinator waiting for them, an agent waiting for input.
// Each item is notified once, when it appears; it notifies again only after it went away
// and came back. Channels (per user, ~/.config/atf/config.toml [notify]):
//   herdr     herdr's own notification (its [ui.toast] delivery decides how it shows)
//   terminal  sequences written to the terminal the herdr client runs in, which also
//             works over SSH: "toast" (OSC 777, Windows Terminal 1.26+ with
//             compatibility.allowOSC777, also foot/WezTerm/Ghostty), "bell" (BEL: taskbar
//             flash / tab bell), "progress" (OSC 9;4: a yellow tab and taskbar mark while
//             anything waits for the human, Windows Terminal 1.6+)
//   command   a shell command, with $ATF_NOTIFY_TITLE, $ATF_NOTIFY_BODY, $ATF_NOTIFY_COUNT
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { listPlanIds, loadPlan, knownRoots, projectName } from '../../../src/store.mjs';
import { userConfig } from '../../../src/changes.mjs';
import { notify as herdrNotify, pluginStateDir, agentIndexSync } from './herdr.mjs';
import { attentionOf } from './attention.mjs';

const TERMINAL_KINDS = ['toast', 'bell', 'progress'];
// derived from live herdr state, not from an event: must hold a moment before it counts
const LIVE_KINDS = new Set(['prompt', 'no-coordinator', 'coordinator', 'stale']);

export function notifyConfig(cfg = userConfig().notify || {}) {
  const env = process.env.ATF_NOTIFY_TERMINAL;
  const term = env != null ? env.split(',') : cfg.terminal === true ? TERMINAL_KINDS : Array.isArray(cfg.terminal) ? cfg.terminal : [];
  return {
    herdr: cfg.herdr !== false,
    terminal: term.map((s) => String(s).trim()).filter((s) => TERMINAL_KINDS.includes(s)),
    command: process.env.ATF_NOTIFY_COMMAND || cfg.command || null,
    settleMs: Number(cfg.settle_seconds ?? 5) * 1000,
  };
}

/** An item's identity: the same question / review / waiting agent keeps its key. */
const keyOf = (it) => [it.root, it.plan, it.kind, it.task ?? '', LIVE_KINDS.has(it.kind) ? (it.actor ?? '') : (it.ts ?? '')].join('|');

const firstLine = (s, n = 140) => {
  const t = String(s ?? '').split('\n')[0].trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** One line: what the human is needed for. */
export function describe(it) {
  const t = it.task ? it.st.tasks[it.task] : null;
  const title = t ? ` (${firstLine(t.title, 60)})` : '';
  switch (it.kind) {
    case 'question':
      return `${it.task} asks: ${firstLine(it.message)}`;
    case 'your-review':
      return `${it.task} waits for your review${title}`;
    case 'review':
      return `${it.task} in review${title}`;
    case 'failed':
      return `${it.task} failed: ${firstLine(it.message)}`;
    case 'plan-question':
      return `plan question: ${firstLine(it.message)}`;
    case 'finished':
      return 'all tasks finished: close the plan';
    case 'no-coordinator':
      return 'no coordinator running: start one (board: s)';
    case 'coordinator':
      return `${it.actor} waits for you`;
    case 'prompt':
      return `${it.actor} waits for input${it.task ? ` on ${it.task}` : ''}`;
    case 'stale':
      return `${it.task}: ${firstLine(it.message)}`;
    default:
      return `${it.kind}${it.task ? ' ' + it.task : ''}`;
  }
}

/** What to say for newly appeared items: {title, body}. */
export function message(items) {
  if (items.length === 1) {
    const it = items[0];
    return { title: `ATF · ${it.st.title}`, body: describe(it) };
  }
  const plans = new Set(items.map((it) => it.st.title));
  return {
    title: `ATF · ${items.length} things need you${plans.size === 1 ? ` · ${[...plans][0]}` : ''}`,
    body: items.map((it) => (plans.size === 1 ? '' : `${it.st.title}: `) + describe(it)).join(' · '),
  };
}

// ---------- the terminal of the herdr client ----------

/**
 * Terminals that herdr clients run in (the user's own terminal, also over SSH): the tty
 * of every `herdr` client process of this user. Panes have their own ptys and are skipped.
 */
export function clientTtys() {
  let out = '';
  try {
    out = execFileSync('ps', ['-u', String(process.getuid()), '-o', 'pid=,ppid=,tty=,args='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return [];
  }
  const procs = out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, tty, args]) => ({ pid, ppid, tty, argv: args.split(/\s+/) }));
  const isHerdr = (p) => path.basename(p.argv[0]) === 'herdr';
  const servers = new Set(procs.filter((p) => isHerdr(p) && p.argv[1] === 'server').map((p) => p.pid));
  const paneTtys = new Set(procs.filter((p) => servers.has(p.ppid)).map((p) => p.tty));
  const client = (a) => a.length === 1 || (a[1].startsWith('--') && a[1] !== '--machine') || (a[1] === 'session' && a[2] === 'attach');
  const ttys = procs.filter((p) => isHerdr(p) && client(p.argv) && /^(tty|pts\/)/.test(p.tty) && !paneTtys.has(p.tty)).map((p) => `/dev/${p.tty}`);
  return [...new Set(ttys)];
}

const clean = (s) => String(s).replace(/[\x00-\x1f\x7f\x9c;]/g, (c) => (c === ';' ? ',' : ' '));
export const SEQ = {
  toast: (title, body) => `\x1b]777;notify;${clean(title)};${clean(body)}\x1b\\`,
  bell: () => '\x07',
  progress: (on) => (on ? '\x1b]9;4;4;100\x1b\\' : '\x1b]9;4;0;0\x1b\\'),
};

function writeTty(dev, data) {
  try {
    const fd = fs.openSync(dev, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    try {
      fs.writeSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

// ---------- the tick ----------

const stateFile = () => path.join(pluginStateDir(), 'attention.json');

function withLock(fn) {
  const lock = path.join(pluginStateDir(), 'attention.lock');
  try {
    fs.mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < 30_000) return null; // another tick runs: it sees the same
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
    } catch {
      return null;
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Look at every open plan of every known project; notify what newly needs the human and
 * keep the terminal's "waiting" mark in line with it. Cheap, and safe to call from
 * every hook, sweep and board refresh (one tick at a time; state in the plugin state dir).
 * Returns {count (items waiting), sent (newly notified), pending (an item still settling:
 * tick again in `settleMs`), watch (a live coordinator may start waiting: keep ticking)}.
 * Options for tests: agents (herdr agent index), roots, ttys, now, cfg.
 */
export function notifyTick(opts = {}) {
  return withLock(() => tick(opts)) ?? { count: 0, sent: 0, pending: true, watch: false, busy: true };
}

function tick({ agents = null, roots = null, extraRoots = [], ttys = null, now = Date.now(), cfg = notifyConfig() } = {}) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {}
  state.seen ??= {};
  state.notified ??= {};
  state.since ??= {};
  state.marked ??= {};
  agents ??= agentIndexSync();
  // how long each herdr agent has had its status (herdr does not say)
  const panes = new Set();
  for (const [k, a] of agents) {
    if (!k.startsWith('pane:')) continue;
    panes.add(a.pane_id);
    const prev = state.since[a.pane_id];
    if (!prev || prev.status !== a.agent_status) state.since[a.pane_id] = { status: a.agent_status, since: now };
  }
  for (const p of Object.keys(state.since)) if (!panes.has(p)) delete state.since[p];
  const lv = { agents, sinceOf: (pane) => state.since[pane]?.since };

  const items = new Map();
  let watch = false;
  for (const root of new Set([...(roots ?? knownRoots()), ...extraRoots])) {
    let ids = [];
    try {
      ids = listPlanIds(root);
    } catch {
      continue;
    }
    for (const id of ids) {
      let st;
      try {
        st = loadPlan(root, id);
      } catch {
        continue;
      }
      if (st.status !== 'active' && st.status !== 'paused') continue;
      Object.defineProperty(st, 'root', { value: root, enumerable: false });
      const att = attentionOf(lv, { root, id, st, key: `${root}#${id}` });
      for (const it of att.mine) items.set(keyOf(it), it);
      if (st.status === 'active' && att.coord.live) watch = true;
    }
  }

  // forget what went away (it notifies again if it comes back)
  for (const k of Object.keys(state.seen)) if (!items.has(k)) delete state.seen[k], delete state.notified[k];
  const fresh = [];
  let pending = false;
  for (const [k, it] of items) {
    state.seen[k] ??= now;
    if (state.notified[k]) continue;
    if (LIVE_KINDS.has(it.kind) && now - state.seen[k] < cfg.settleMs) pending = true;
    else fresh.push([k, it]);
  }

  const termTtys = cfg.terminal.length ? (ttys ?? clientTtys()) : [];
  if (fresh.length) {
    const list = fresh.map(([, it]) => it);
    const { title, body } = message(list);
    // herdr notices agents waiting for input itself
    const forHerdr = list.filter((it) => it.kind !== 'prompt');
    if (cfg.herdr && forHerdr.length) {
      const m = message(forHerdr);
      herdrNotify(m.title, m.body, forHerdr.every((it) => it.kind === 'finished') ? 'done' : 'request');
    }
    const seq = (cfg.terminal.includes('toast') ? SEQ.toast(title, body) : '') + (cfg.terminal.includes('bell') ? SEQ.bell() : '');
    if (seq) for (const t of termTtys) writeTty(t, seq);
    if (cfg.command) {
      try {
        spawn('sh', ['-c', cfg.command], { detached: true, stdio: 'ignore', env: { ...process.env, ATF_NOTIFY_TITLE: title, ATF_NOTIFY_BODY: body, ATF_NOTIFY_COUNT: String(items.size) } }).unref();
      } catch {}
    }
    for (const [k] of fresh) state.notified[k] = now;
  }
  // the "waiting for you" mark: on while anything (notified) waits, per terminal
  if (cfg.terminal.includes('progress')) {
    const on = [...items.keys()].some((k) => state.notified[k]);
    for (const t of termTtys) if (!!state.marked[t] !== on && writeTty(t, SEQ.progress(on))) state.marked[t] = on;
  }
  for (const t of Object.keys(state.marked)) if (!termTtys.includes(t)) delete state.marked[t];
  try {
    const tmp = stateFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile());
  } catch {}
  return { count: items.size, sent: fresh.length, pending, watch, items: [...items.values()].map((it) => ({ kind: it.kind, plan: it.plan, task: it.task ?? null, project: projectName(it.root), text: describe(it) })) };
}
