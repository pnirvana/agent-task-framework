// Agent launching and lifecycle for the herdr adapter.
//
// ATF core decides *whether* the next agent on a task resumes an earlier session or
// starts fresh (launchPlan). This module decides *how*: which pane, which agent kind,
// which arguments. Everything agent-specific is in the AGENT_KINDS table, which users
// can extend or override via the plugin config ("agents": {...}).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMINAL, attentionFor, launchPlan } from '../../../src/core.mjs';
import { listPlanIds, loadPlan, transact, skillInstalled, resolveActor, hasLiveWaiter } from '../../../src/store.mjs';
import { herdr, notify, pluginConfig, sameServer, currentSocket, liveAgents, inProject, boardPaneIds, pluginStateDir } from './herdr.mjs';
import { chooseSplit, tabLayout, withPlacementLock } from './layout.mjs';
import { resolveAgentDef, piArgsForAgent } from './agents.mjs';
import { SKILL_DIR, buildPrompt, coordinatorPrompt } from '../../../src/prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ATF_BIN = path.resolve(HERE, '../../../bin');
export { SKILL_DIR, buildPrompt, coordinatorPrompt };
const WAKE_EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../pi/atf.ts');

/**
 * Per agent kind: extra args to start fresh, args to resume a session, and whether the
 * agent loads the ATF skill natively. `{skill}` and `{session}` are substituted.
 * Kinds without `resume` always start fresh (from checkpoint + task history).
 */
export const AGENT_KINDS = {
  // coordinator: extra args for the plan's coordinator only (the wake extension: it waits
  // for the plan in the background, so pi is idle and promptable while nothing needs it)
  pi: { start: ['--skill', '{skill}'], resume: ['--session', '{session}', '--skill', '{skill}'], coordinator: ['-e', '{wake}'], nativeSkill: true },
  claude: { start: [], resume: ['--resume', '{session}'] },
  // GitHub Copilot CLI: ATF picks the session id ({newsession}) and records it. The
  // coordinator is woken by the ATF Copilot extension (atf-copilot install), which reads
  // ATF_WAKE from the environment (wakeEnv): an extension cannot set the agent's env.
  copilot: { start: ['--experimental', '--session-id', '{newsession}'], resume: ['--experimental', '--resume', '{session}'], wakeEnv: true, nativeSkill: true },
  codex: { start: [], resume: ['resume', '{session}'] },
};

export function agentKinds() {
  return { ...AGENT_KINDS, ...(pluginConfig().agents || {}) };
}

export const lifecycle = () => process.env.ATF_LIFECYCLE_MODE || pluginConfig().lifecycle || 'ephemeral';
const GRACE_MS = 15_000; // idle this long (with nothing in progress) before an agent ATF launched is closed

// ---------- plugin state ----------
export const stateDir = pluginStateDir;
const readJson = (f, d = {}) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), f), 'utf8'));
  } catch {
    return d;
  }
};
const writeJson = (f, v) => {
  const p = path.join(stateDir(), f);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p); // atomic: readers never see a half-written file
};
/** Agents launched by ATF (only these are ever closed or relaunched automatically). */
const regKey = (root, name) => `${root}#${name}`;
export const readRegistry = () => readJson('agents.json');
/**
 * Read-modify-write of the agent registry under a lock, with a fresh read: parallel
 * spawns and sweeps each change their own entries without overwriting each other's.
 */
export function updateRegistry(fn) {
  const lock = path.join(stateDir(), 'agents.lock');
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() - t0 > 10_000) break; // give up waiting rather than block an agent
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const reg = readRegistry();
    fn(reg);
    writeJson('agents.json', reg);
    return reg;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// ---------- placement ----------
/** Where new agent panes go: `tab` (default) an "agents" tab, `split` the coordinator's tab. */
export const agentPlacement = (flag) => {
  const p = flag || process.env.ATF_AGENT_PLACEMENT || pluginConfig().agent_placement || 'tab';
  if (!['tab', 'split'].includes(p)) throw new Error(`agent placement must be tab or split (got ${p})`);
  return p;
};

/**
 * Create a pane for a new agent. `tab` (default): in the workspace's "agents" tab (a
 * balanced grid there; another "agents-N" tab when it is full), so the tab the human
 * works in (coordinator, board) keeps its layout. `split`: split the largest pane of the
 * reference tab along its longer side (never the board), overflowing into an "agents"
 * tab. `direction` forces a plain split of the reference pane.
 */
export function placeAgentPane({ cwd, env, refPane, direction, workspace, placement = 'tab' }) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const splitOf = (pane, dir) => herdr(['pane', 'split', '--pane', pane, '--direction', dir, '--cwd', cwd, '--no-focus', ...envArgs])?.pane?.pane_id;
  if (refPane && direction) return splitOf(refPane, direction);
  const exclude = boardPaneIds();
  if (refPane && placement === 'split') {
    const c = chooseSplit(refPane, { exclude });
    if (c) return splitOf(c.pane, c.direction);
  }
  // the project's workspace (where its agents were), not wherever the writer happens to be
  const ws = (refPane && tabLayout(refPane)?.workspace_id) || workspace || process.env.HERDR_WORKSPACE_ID;
  const tabs = (herdr(['tab', 'list', ...(ws ? ['--workspace', ws] : [])])?.tabs || []).filter((t) => /^agents/.test(t.label || ''));
  for (const t of tabs) {
    const anyPane = (herdr(['pane', 'list', '--workspace', t.workspace_id])?.panes || []).find((p) => p.tab_id === t.tab_id);
    const c = anyPane && chooseSplit(anyPane.pane_id, { exclude });
    if (c) return splitOf(c.pane, c.direction);
  }
  const label = tabs.length ? `agents-${tabs.length + 1}` : 'agents';
  return herdr(['tab', 'create', ...(ws ? ['--workspace', ws] : []), '--cwd', cwd, '--label', label, '--no-focus', ...envArgs])?.root_pane?.pane_id;
}

const paneWorkspace = (pane) => herdr(['pane', 'get', pane])?.pane?.workspace_id ?? (String(pane).includes(':') ? String(pane).split(':')[0] : null);

// ---------- prompts: src/prompts.mjs ----------

// ---------- launching ----------
export function recordSession(root, planId, taskIds, name, kind, pane = null, known = null) {
  // by pane when known: names repeat across projects; never another project's agent
  const a = herdr(['agent', 'get', pane || name])?.agent;
  if (a && !inProject(a, root)) return null;
  // herdr's session reference, else the one ATF chose at launch ({newsession})
  const ref = a?.agent_session?.value || known;
  if (!ref || !taskIds.length) return null;
  const state = loadPlan(root, planId);
  const fresh = taskIds.filter((id) => state.tasks[id] && state.tasks[id].sessions[name]?.ref !== ref);
  if (fresh.length)
    transact(root, planId, { id: 'atf-herdr', role: 'launcher', harness: 'herdr' }, () =>
      fresh.map((id) => ({ type: 'task.session', task: id, data: { ref, kind, actor: name } })),
    );
  return ref;
}

/**
 * Start an agent for `taskId` (a leaf or a work package). Mode comes from ATF's
 * launchPlan unless forced. Returns {name, pane, mode, kind}.
 */
export function launchAgent({ root, planId, taskId, name, kind, agent, early = false, refPane, direction, workspace, placement, force, extraArgs = [], assign = true }) {
  const s = loadPlan(root, planId);
  const target = s.tasks[taskId];
  if (!target) throw new Error(`unknown task ${taskId}`);
  // one agent per owner at a time: a running one continues with its work (it finishes,
  // then the coordinator starts the next)
  const running = liveAgents(root).get(name);
  if (running) throw new Error(`agent "${name}" is still running (pane ${running.pane_id}, ${running.agent_status}); wait until it ends, or pass another --name`);
  const kinds = agentKinds();
  kind = kind || process.env.ATF_AGENT_KIND || pluginConfig().agent_kind || 'pi';
  const kindCfg = kinds[kind] || { start: [] };
  const isPackage = target.children.length > 0;
  // the leaf the agent starts on: the task itself, or the next ready leaf of the package
  const leaf = isPackage
    ? s.order.map((id) => s.tasks[id]).find((t) => !t.children.length && t.path.includes(target.id) && (t.ready || t.can_resume || t.answered)) || target
    : target;
  // agent definition: explicit, else the task's, else its work package's
  agent = agent || leaf.agent || target.agent || [...leaf.path].reverse().map((id) => s.tasks[id].agent).find(Boolean) || null;
  let agentArgs = [];
  if (agent) {
    if (kind !== 'pi') throw new Error(`agent definitions are supported for pi only (task wants "${agent}", kind is ${kind})`);
    const def = resolveAgentDef(agent, path.dirname(root));
    if (!def) throw new Error(`unknown agent definition "${agent}" (see \`atf-herdr agents\`)`);
    const r = piArgsForAgent(def, stateDir());
    agentArgs = r.args;
    for (const n of r.notes) process.stderr.write(`atf-herdr: note: ${n}\n`);
  }
  const lp = launchPlan(s, leaf.id, name);
  let mode = force || lp.mode;
  if (mode === 'resume' && (!lp.session && !force)) mode = 'fresh';
  const session = lp.session?.ref;
  if (mode === 'resume' && (!kindCfg.resume || !session)) mode = 'fresh'; // agent kind can't resume: fresh + checkpoint

  const env = {
    ATF_DIR: root,
    ATF_PLAN: planId,
    ATF_ACTOR: name,
    ATF_ROLE: 'subagent',
    ATF_HARNESS: 'herdr',
    ATF_LIFECYCLE: lifecycle(),
    PATH: `${ATF_BIN}:${process.env.PATH}`, // `atf` resolvable without a global install
  };
  placement = agentPlacement(placement);
  const pane = withPlacementLock(() => placeAgentPane({ cwd: path.dirname(root), env, refPane, direction, workspace, placement }));
  if (!pane) throw new Error('could not create a pane');
  const newSession = crypto.randomUUID();
  const sub = (a) => a.replace('{skill}', SKILL_DIR).replace('{session}', session ?? '').replace('{newsession}', newSession);
  // an installed skill is discovered by the agent itself: don't pass it again
  const withoutSkill = (list) => (skillInstalled() ? list.filter((a, i) => a !== '{skill}' && list[i + 1] !== '{skill}') : list);
  const kindArgs = withoutSkill(mode === 'resume' ? kindCfg.resume : kindCfg.start || []);
  const known = mode === 'resume' ? session : kindArgs.includes('{newsession}') ? newSession : null;
  const args = [...kindArgs.map(sub), ...agentArgs, ...extraArgs];
  const started = herdr(['agent', 'start', name, '--kind', kind, '--pane', pane, ...(args.length ? ['--', ...args] : [])], { timeout: 60_000 });
  if (!started) {
    herdr(['pane', 'close', pane]);
    throw new Error(`herdr could not start ${kind} agent "${name}"`);
  }
  herdr(['pane', 'rename', pane, name]); // the pane shows who works in it, not the tab it sits in
  // register before anything writes to the plan: hooks fired by the assignment below
  // must already know this agent was just launched (no duplicate kickoff nudge)
  updateRegistry((reg) => {
    reg[regKey(root, name)] = { name, kind, agent, root, plan: planId, task: target.id, pane, workspace: paneWorkspace(pane), socket: currentSocket(), launchedAt: Date.now(), idleSince: null, session: known };
  });
  if (assign && target.assignee !== name && !(target.owner === name && !isPackage)) {
    // write as whoever called spawn, with the same identity the atf CLI uses for them
    // (ATF_ACTOR, else the user name), so the coordinator appears under one name
    transact(root, planId, { ...resolveActor(), role: 'coordinator' }, () => [
      { type: 'task.assigned', task: target.id, data: { assignee: name } },
    ]);
  }
  const fresh = loadPlan(root, planId);
  herdr(['agent', 'prompt', pane, buildPrompt({ s: fresh, t: fresh.tasks[leaf.id], name, mode, pkg: isPackage ? fresh.tasks[target.id] : null, kindCfg, early })]);
  // file the session on what was spawned (the package or the task), not on a guess of
  // which leaf the agent will pick: leaves get it when the agent works on them (hook)
  recordSession(root, planId, [target.id], name, kind, pane, known);
  return { name, pane, mode, kind, agent, leaf: leaf.id, reason: lp.reason };
}

// ---------- the coordinator ----------
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Start (or resume) the coordinator of a plan in its own tab (SPEC §12.6). By default the
 * plan's recorded coordinator session is resumed; `fresh` starts a new session, and a
 * coordinator that is still running is first asked for a plan checkpoint, then replaced.
 * Returns {name, pane, mode}; mode 'running' if one runs already (nothing started).
 */
export function launchCoordinator({ root, planId, fresh = false, kind, handoffMs = 180_000, say = () => {}, dryRun = false }) {
  const s = loadPlan(root, planId);
  const name = s.coordinator || resolveActor().id;
  kind = kind || process.env.ATF_AGENT_KIND || pluginConfig().agent_kind || 'pi';
  const kindCfg = agentKinds()[kind] || { start: [] };
  const live = liveAgents(root);
  const livePane = new Map([...live.values()].map((a) => [a.pane_id, a]));
  const actor = s.actors[name];
  const running = actor && sameServer(actor) ? liveAgentOf(s, actor, live, livePane) : live.get(name) || null;
  const mode = !fresh && s.session?.ref && kindCfg.resume ? 'resume' : 'fresh';
  if (dryRun) return { name, pane: running?.pane_id ?? null, mode: running && !fresh ? 'running' : mode, session: mode === 'resume' ? s.session.ref : null };
  let workspace = (actor && sameServer(actor) && actor.ctx?.herdr_workspace) || process.env.HERDR_WORKSPACE_ID || null;
  if (running) {
    if (!fresh) return { name, pane: running.pane_id, mode: 'running' };
    workspace = running.workspace_id || workspace;
    // hand over: interrupt it (it may sit in `atf wait`), ask for the plan checkpoint, replace it
    const before = s.checkpoint?.seq ?? 0;
    if (running.agent_status === 'working') herdr(['agent', 'send-keys', running.pane_id, 'esc']), sleepMs(1500);
    herdr(['agent', 'prompt', running.pane_id, `[ATF] A new coordinator session takes over plan "${s.title}" (--plan ${s.id}). Write the handoff now: \`atf plan checkpoint --plan ${s.id} "<where the plan stands, what you are waiting for, what comes next, decisions not yet in the documents>"\`, then end your turn.`]);
    say(`asked ${name} for a plan checkpoint…`);
    let got = false;
    for (const t0 = Date.now(); Date.now() - t0 < handoffMs; sleepMs(1000))
      if ((loadPlan(root, planId).checkpoint?.seq ?? 0) > before) {
        got = true;
        break;
      }
    if (!got) say(`warning: ${name} wrote no checkpoint within ${Math.round(handoffMs / 1000)} s; the new session starts from the last one${s.checkpoint ? '' : ' (there is none)'}`);
    sleepMs(2000); // let it end its turn
    herdr(['pane', 'close', running.pane_id]);
  }
  const env = { ATF_DIR: root, ATF_PLAN: planId, ATF_ACTOR: name, ATF_ROLE: 'coordinator', ATF_HARNESS: 'herdr', PATH: `${ATF_BIN}:${process.env.PATH}` };
  // a harness whose wake extension cannot set the agent's env (Copilot): the arm file is set here
  if (kindCfg.wakeEnv) env.ATF_WAKE = path.join(stateDir(), `wake-${planId}.json`);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const tab = herdr(['tab', 'create', ...(workspace ? ['--workspace', workspace] : []), '--cwd', path.dirname(root), '--label', `plan: ${s.title}`.slice(0, 40), '--focus', ...envArgs]);
  const pane = tab?.root_pane?.pane_id;
  if (!pane) throw new Error('could not open a tab for the coordinator');
  // herdr agent names are unique per server: another project may have a "coordinator"
  const hname = herdr(['agent', 'get', name])?.agent ? `${name}-${s.id.slice(-4)}` : name;
  const session = mode === 'resume' ? s.session.ref : '';
  const withoutSkill = (list) => (skillInstalled() ? list.filter((a, i) => a !== '{skill}' && list[i + 1] !== '{skill}') : list);
  const newSession = crypto.randomUUID();
  const kindArgs = [...withoutSkill(mode === 'resume' ? kindCfg.resume : kindCfg.start || []), ...(kindCfg.coordinator || [])];
  const args = kindArgs.map((a) => a.replace('{skill}', SKILL_DIR).replace('{session}', session).replace('{newsession}', newSession).replace('{wake}', WAKE_EXT));
  if (!herdr(['agent', 'start', hname, '--kind', kind, '--pane', pane, ...(args.length ? ['--', ...args] : [])], { timeout: 60_000 })) {
    herdr(['pane', 'close', pane]);
    throw new Error(`herdr could not start ${kind} agent "${hname}"`);
  }
  herdr(['pane', 'rename', pane, name]);
  updateRegistry((reg) => {
    reg[regKey(root, name)] = { name: hname, actor: name, role: 'coordinator', kind, root, plan: planId, pane, workspace: paneWorkspace(pane), socket: currentSocket(), launchedAt: Date.now() };
  });
  herdr(['agent', 'prompt', pane, coordinatorPrompt(s, mode, name)]);
  // the plan's session: what `s` on the board resumes next time
  const ref = herdr(['agent', 'get', pane])?.agent?.agent_session?.value || (kindArgs.includes('{newsession}') ? newSession : null);
  if (ref && ref !== s.session?.ref) transact(root, planId, { id: 'atf-herdr', role: 'launcher', harness: 'herdr' }, () => [{ type: 'plan.session', data: { ref, kind, actor: name } }]);
  return { name, hname, pane, mode };
}

/**
 * Called from the ATF hook for each write: when an agent ATF launched changes the status
 * of a task (starts, blocks, submits, finishes it), file its session on that task, so a
 * later relaunch of that task resumes the session that actually worked on it.
 */
export function recordSessionsForEvents(root, planId, events) {
  const reg = readRegistry();
  const byActor = new Map();
  // a coordinator ATF started: keep the plan's session current (resuming the plan uses it)
  const coordRec = Object.values(reg).find((r) => r.role === 'coordinator' && r.root === root && r.plan === planId && events.some((e) => e.actor?.id === r.actor));
  if (coordRec && coordRec.pane && !(coordRec.socket && currentSocket() && coordRec.socket !== currentSocket())) {
    const a = herdr(['agent', 'get', coordRec.pane])?.agent;
    const ref = a && inProject(a, root) ? a.agent_session?.value : null;
    if (ref && loadPlan(root, planId).session?.ref !== ref)
      transact(root, planId, { id: 'atf-herdr', role: 'launcher', harness: 'herdr' }, () => [{ type: 'plan.session', data: { ref, kind: coordRec.kind, actor: coordRec.actor } }]);
  }
  for (const e of events) {
    if (reg[regKey(root, e.actor?.id)]?.role === 'coordinator') continue;
    if (e.type !== 'task.status' || !e.task || !e.actor?.id) continue;
    const rec = reg[regKey(root, e.actor.id)];
    if (!rec || (rec.socket && currentSocket() && rec.socket !== currentSocket())) continue;
    if (!byActor.has(rec)) byActor.set(rec, new Set());
    byActor.get(rec).add(e.task);
  }
  for (const [rec, tasks] of byActor) recordSession(root, planId, [...tasks], rec.name, rec.kind, rec.pane, rec.session);
}

// ---------- lifecycle sweep ----------
/** The prompt that wakes an idle coordinator: what needs it, and how to go on. */
export function nudgeText(s, actor, att, stalled = []) {
  const items = [
    ...att.map((a) => (a.task ? `${a.task} ${a.reason} (${s.tasks[a.task]?.title ?? ''})` : `plan: ${a.reason}`)),
    ...stalled.map((t) => `${t.id} stalled (its agent ${t.owner} is idle but the task is still in progress)`),
  ].join('; ');
  return `[ATF] Plan "${s.title}" (--plan ${s.id}) needs you: ${items}. Handle these (atf show <id> --plan ${s.id}; spawn agents with atf-herdr spawn <id>), then continue with \`atf wait --plan ${s.id}\`.`;
}

// An agent that wrote this recently and is busy is most likely just finishing its turn:
// check again soon instead of at the normal cadence.
const WRAP_UP_MS = 60_000;
const STALL_MS = 90_000; // a subagent idle this long with a task in progress has stalled

/**
 * One pass over the plans in `root` (v2: the coordinator decides, SPEC §12):
 *  - subagents ATF launched that are idle with nothing in progress -> after a grace
 *    period: record their session, close the pane (they finished or blocked)
 *  - an idle coordinator with something to handle (or stalled subagents) -> nudge it,
 *    once per situation
 *  - an active plan without a running coordinator -> one herdr notification
 * Subagents are never relaunched, resumed or nudged: the coordinator starts new ones.
 * Returns {actions, pending, soon}: pending = sweep again at the normal cadence; soon =
 * the coordinator is about to need a nudge (or another sweep held the lock): in seconds.
 */
export function lifecycleSweep(root) {
  // one sweep at a time per machine; a concurrent one is skipped (and rescheduled)
  const lock = path.join(stateDir(), 'sweep.lock');
  try {
    fs.mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < 120_000) return { actions: [], pending: true, soon: true, busy: true };
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
    } catch {
      return { actions: [], pending: true, soon: true, busy: true };
    }
  }
  try {
    const res = sweepLocked(root);
    if (res.actions.length)
      fs.appendFileSync(path.join(stateDir(), 'lifecycle.log'), res.actions.map((a) => `${new Date().toISOString()} ${path.basename(path.dirname(root))} ${a}\n`).join(''));
    return res;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function sweepLocked(root) {
  const actions = [];
  let pending = false;
  let soon = false;
  const reg = readRegistry(); // snapshot; changes are written back per entry at the end
  const touched = new Set();
  const nudges = readJson('nudges.json');
  const live = liveAgents(root); // this project's agents only: names repeat across projects
  const livePane = new Map([...live.values()].map((a) => [a.pane_id, a]));
  const now = Date.now();
  const closed = new Set(); // actors closed in this pass (an actor may appear in several plans)

  for (const id of listPlanIds(root)) {
    const s = loadPlan(root, id);
    const planOpen = s.status === 'active';
    const coordId = s.coordinator || Object.values(s.actors).find((a) => a.role === 'coordinator')?.id || null;
    const stalled = [];

    // ---- subagents ATF launched: close the ones that are done
    for (const actor of Object.values(s.actors)) {
      if (!sameServer(actor) || actor.id === coordId || closed.has(actor.id)) continue;
      let rec = reg[regKey(root, actor.id)];
      if (rec?.socket && currentSocket() && rec.socket !== currentSocket()) rec = undefined;
      if (rec?.role === 'coordinator') continue;
      const agent = liveAgentOf(s, actor, live, livePane);
      if (!agent) continue;
      const working = s.order.some((tid) => s.tasks[tid].owner === actor.id && s.tasks[tid].status === 'in_progress' && !s.tasks[tid].children.length);
      const idle = ['idle', 'done'].includes(agent.agent_status);
      if (rec) touched.add(regKey(root, actor.id));
      if (!idle) {
        if (rec) (rec.idleSince = null), (pending = true);
        continue;
      }
      if (working) {
        // idle with a task in progress: it stopped without reporting; the coordinator decides
        if (!rec || !rec.idleSince) {
          if (rec) rec.idleSince = now;
          pending = true;
        } else if (now - rec.idleSince > STALL_MS) {
          for (const tid of s.order) if (s.tasks[tid].owner === actor.id && s.tasks[tid].status === 'in_progress' && !s.tasks[tid].children.length) stalled.push(s.tasks[tid]);
        } else pending = true;
        continue;
      }
      // finished, blocked or submitted: it ends; only agents ATF launched are closed
      if (!rec || lifecycle() !== 'ephemeral') continue;
      if (!rec.idleSince) {
        rec.idleSince = now;
        pending = true;
        continue;
      }
      if (now - rec.idleSince < GRACE_MS) {
        pending = true;
        continue;
      }
      recordSession(root, s.id, workedThisLaunch(s, actor, rec), actor.id, rec.kind, agent.pane_id, rec.session);
      herdr(['pane', 'close', agent.pane_id]);
      rec.pane = null;
      rec.idleSince = null;
      rec.closedAt = now;
      closed.add(actor.id);
      actions.push(`closed ${actor.id} (finished its assignment)`);
    }

    if (!planOpen || !coordId) continue;
    // ---- the coordinator
    const coord = s.actors[coordId];
    if (coord && !sameServer(coord)) continue; // runs in another herdr session
    const agent = coord && liveAgentOf(s, coord, live, livePane);
    const nkey = `${root}#${s.id}#${coordId}`;
    if (!agent) {
      // nobody decides for this plan: tell the human once (the board offers to start one)
      const open = s.order.some((tid) => !s.tasks[tid].children.length && !TERMINAL.has(s.tasks[tid].status));
      if (open && nudges[`${nkey}#absent`] !== true) {
        notify(`ATF: no coordinator for "${s.title}"`, 'start one from the board (s) or with atf-herdr coordinate', 'request');
        nudges[`${nkey}#absent`] = true;
        actions.push(`no coordinator running for ${s.id}`);
      }
      continue;
    }
    delete nudges[`${nkey}#absent`];
    const att = attentionFor(s, coordId, 'coordinator');
    const attKey = [...att.map((a) => `${a.task}:${a.reason}`), ...stalled.map((t) => `${t.id}:stalled`)].join(',');
    if (!attKey) {
      delete nudges[nkey];
      continue;
    }
    // an idle coordinator with a background waiter (the pi extension's `atf wait --new`) is
    // woken by it when something needs it: no nudge on top
    if (hasLiveWaiter(root, s.id, coordId)) {
      delete nudges[nkey];
      continue;
    }
    if (!['idle', 'done'].includes(agent.agent_status)) {
      // busy (e.g. in `atf wait`, which reports it): if it wrote just now it is probably
      // wrapping up its turn, so look again in seconds
      if (nudges[nkey] !== attKey && coord.last_seen && now - Date.parse(coord.last_seen) < WRAP_UP_MS) soon = true;
      pending = true;
      continue;
    }
    if (nudges[nkey] !== attKey && herdr(['agent', 'prompt', agent.pane_id, nudgeText(s, coord, att, stalled)])) {
      nudges[nkey] = attKey;
      actions.push(`nudged ${coordId}: ${attKey}`);
    }
  }
  updateRegistry((fresh) => {
    for (const k of touched) {
      if (!fresh[k] || !reg[k]) continue;
      if (fresh[k].launchedAt !== reg[k].launchedAt) continue; // relaunched meanwhile: keep the newer entry
      for (const f of ['idleSince', 'pane', 'closedAt']) fresh[k][f] = reg[k][f];
    }
  });
  writeJson('nudges.json', nudges);
  return { actions, pending, soon };
}

/**
 * The live herdr agent of an ATF actor: by name (agents ATF launched are named after
 * their actor), else by the herdr pane its last ATF write came from (a coordinator
 * started by hand has its own herdr name, e.g. "pi", but writes as $ATF_ACTOR/$USER).
 */
function liveAgentOf(s, actor, live, livePane) {
  const byName = live.get(actor.id);
  if (byName) return byName;
  const a = actor.ctx?.herdr_pane && livePane.get(actor.ctx.herdr_pane);
  if (!a || (s.actors[a.name] && a.name !== actor.id)) return null; // that pane belongs to another actor now
  return a;
}


/** Leaves this actor changed during its current launch (to file that launch's session on). */
function workedThisLaunch(s, actor, rec) {
  const since = rec?.launchedAt ?? 0;
  return s.order.filter((tid) => {
    const t = s.tasks[tid];
    return t.owner === actor.id && !t.children.length && t.history.some((h) => h.actor === actor.id && Date.parse(h.ts) >= since - 1000);
  });
}
