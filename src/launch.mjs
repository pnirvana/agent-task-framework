// Starting agents and their lifecycle, for any place agents run in (a "backend": herdr
// panes, ATF's session daemon).
//
// ATF core decides *whether* the next agent on a task resumes an earlier session or
// starts fresh (launchPlan). This module decides *how*: which agent kind, which
// arguments, which prompt, what is recorded. Where the agent's terminal lives is the
// backend's:
//
//   name                    'herdr' | 'sessions' (ATF_HARNESS of the agents it starts)
//   stateDir()              where the registry, nudges and wake files live
//   config()                the backend's settings (agent_kind, agents, lifecycle, …)
//   local(actor)            is this actor's agent controllable from here?
//   socket()                identifies this backend instance (recorded with agents)
//   agents(root)            running agents working in the project: Map name -> agent
//                           {name, handle, status, workspace, …}
//   find(s, actor, agents)  the running agent of an ATF actor (by name, else by where it
//                           last wrote from)
//   sessionRef(handle|name, root)  the harness session id of a running agent, if known
//   nameTaken(name)         an agent name is unique per backend instance
//   open(spec)              starts the agent; -> {handle, workspace, created?}
//                           spec: {role, name, label, kind, args, env, cwd, root, place}
//   prompt(handle, text)    gives a running agent a prompt (first one, nudges, handoff)
//   interrupt(handle)       stops what it does (esc)
//   close(handle)           ends it
//   coordinatorPlace?(o)    where a coordinator goes (herdr: its workspace, a leftover pane)
//
// Everything agent-specific is in AGENT_KINDS, which users can extend or override in the
// backend's config ("agents": {...}).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMINAL, attentionFor, launchPlan } from './core.mjs';
import { listPlanIds, loadPlan, transact, skillInstalled, resolveActor, hasLiveWaiter } from './store.mjs';
import { resolveAgentDef, piArgsForAgent } from './agents.mjs';
import { SKILL_DIR, buildPrompt, coordinatorPrompt } from './prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ATF_BIN = path.resolve(HERE, '../bin');
export { SKILL_DIR, buildPrompt, coordinatorPrompt };
const WAKE_EXT = path.resolve(HERE, '../adapters/pi/atf.ts');
const LIVE_EXT = path.resolve(HERE, '../adapters/pi/atf-live.ts');
const OPENCODE_PLUGIN = path.resolve(HERE, '../adapters/opencode/atf.mjs');

/**
 * opencode's extra config for agents ATF starts: the ATF plugin (live view, SPEC §14),
 * merged into an OPENCODE_CONFIG_CONTENT the user may already have.
 */
function opencodeConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}') || {};
  } catch {}
  const plugin = `file://${OPENCODE_PLUGIN}`;
  return JSON.stringify({ ...cfg, plugin: [...new Set([...(Array.isArray(cfg.plugin) ? cfg.plugin : []), plugin])] });
}
/** A kind's extra environment (`env` in its config), placeholders filled in. */
export const kindEnv = (kindCfg) => Object.fromEntries(Object.entries(kindCfg.env || {}).map(([k, v]) => [k, String(v).replace('{opencodeConfig}', () => opencodeConfig())]));

/**
 * Per agent kind: extra args to start fresh, args to resume a session, and whether the
 * agent loads the ATF skill natively. `{skill}` and `{session}` are substituted.
 * Kinds without `resume` always start fresh (from checkpoint + task history).
 * `prompt`: how the kind takes its first prompt on the command line (`{prompt}`), for
 * backends that start the agent with it (sessions); herdr types it in once it is ready.
 */
export const AGENT_KINDS = {
  // coordinator: extra args for the plan's coordinator only (the wake extension: it waits
  // for the plan in the background, so pi is idle and promptable while nothing needs it)
  // agent: extra args for subagents only (the live extension: what they run and wait for, §14)
  pi: { start: ['--skill', '{skill}'], resume: ['--session', '{session}', '--skill', '{skill}'], coordinator: ['-e', '{wake}'], agent: ['-e', '{live}'], prompt: ['{prompt}'], nativeSkill: true },
  claude: { start: [], resume: ['--resume', '{session}'], prompt: ['{prompt}'] },
  // GitHub Copilot CLI: ATF picks the session id ({newsession}) and records it. The
  // coordinator is woken by the ATF Copilot extension (atf-copilot install), which reads
  // ATF_WAKE from the environment (wakeEnv): an extension cannot set the agent's env.
  copilot: { start: ['--experimental', '--session-id', '{newsession}'], resume: ['--experimental', '--resume', '{session}'], prompt: ['-i', '{prompt}'], wakeEnv: true, nativeSkill: true },
  codex: { start: [], resume: ['resume', '{session}'], prompt: ['{prompt}'] },
  // opencode: the ATF plugin (live view) through its config env; sessions are opencode's
  // own ids (not known at start): agents start fresh from the task's checkpoint
  opencode: { start: [], env: { OPENCODE_CONFIG_CONTENT: '{opencodeConfig}' }, prompt: ['--prompt', '{prompt}'], nativeSkill: true },
};

export function agentKinds(backend) {
  return { ...AGENT_KINDS, ...(backend.config().agents || {}) };
}
const defaultKind = (backend) => process.env.ATF_AGENT_KIND || backend.config().agent_kind || 'pi';

export const lifecycle = (backend) => process.env.ATF_LIFECYCLE_MODE || backend.config().lifecycle || 'ephemeral';
const GRACE_MS = 15_000; // idle this long (with nothing in progress) before an agent ATF launched is closed

/**
 * Which backend starts agents here: $ATF_BACKEND (set by the launcher for the agents it
 * starts), else herdr when inside herdr, else none (the harness's own subagents through
 * `atf dispatch`).
 */
export function backendName(env = process.env) {
  if (env.ATF_BACKEND) return env.ATF_BACKEND;
  if (env.HERDR_ENV === '1') return 'herdr';
  return null;
}

// ---------- backend state: registry, nudges ----------
const readJson = (backend, f, d = {}) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(backend.stateDir(), f), 'utf8'));
  } catch {
    return d;
  }
};
const writeJson = (backend, f, v) => {
  const p = path.join(backend.stateDir(), f);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p); // atomic: readers never see a half-written file
};
/** Agents launched by ATF (only these are ever closed or relaunched automatically). */
export const regKey = (root, name) => `${root}#${name}`;
export const readRegistry = (backend) => readJson(backend, 'agents.json');
/**
 * Read-modify-write of the agent registry under a lock, with a fresh read: parallel
 * spawns and sweeps each change their own entries without overwriting each other's.
 */
export function updateRegistry(backend, fn) {
  const lock = path.join(backend.stateDir(), 'agents.lock');
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
    const reg = readRegistry(backend);
    fn(reg);
    writeJson(backend, 'agents.json', reg);
    return reg;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
/** A registry entry made by another instance of the backend (another herdr server). */
const foreign = (backend, rec) => !!(rec?.socket && backend.socket() && rec.socket !== backend.socket());
const launcherActor = (backend) => ({ id: `atf-${backend.name}`, role: 'launcher', harness: backend.name });

// ---------- arguments ----------
const withoutSkill = (list) => (skillInstalled() ? list.filter((a, i) => a !== '{skill}' && list[i + 1] !== '{skill}') : list);

/** The arguments of an agent definition (pi only), or none. */
function agentDefArgs(backend, agent, kind, cwd) {
  if (!agent) return [];
  if (kind !== 'pi') throw new Error(`agent definitions are supported for pi only ("${agent}", kind is ${kind})`);
  const def = resolveAgentDef(agent, cwd);
  if (!def) throw new Error(`unknown agent definition "${agent}" (see \`atf-herdr agents\`)`);
  const r = piArgsForAgent(def, backend.stateDir());
  for (const n of r.notes) process.stderr.write(`atf: note: ${n}\n`);
  return r.args;
}

/** Fill a kind's placeholders. */
const fill = (list, vals) => list.map((a) => a.replace(/\{(skill|session|newsession|wake|live)\}/g, (_, k) => vals[k] ?? ''));

/** The base environment of an agent ATF starts. */
const agentEnv = (backend, root, extra) => ({ ATF_DIR: root, ATF_HARNESS: backend.name, ATF_BACKEND: backend.name, PATH: `${ATF_BIN}:${process.env.PATH}`, ...extra });

// ---------- launching ----------
export function recordSession(backend, root, planId, taskIds, name, kind, handle = null, known = null) {
  // the harness's session reference (by handle when known: names repeat across projects),
  // else the one ATF chose at launch ({newsession})
  const seen = backend.sessionRef(handle || name, root);
  if (seen === false) return null; // that agent works in another project
  const ref = seen || known;
  if (!ref || !taskIds.length) return null;
  const state = loadPlan(root, planId);
  const fresh = taskIds.filter((id) => state.tasks[id] && state.tasks[id].sessions[name]?.ref !== ref);
  if (fresh.length) transact(root, planId, launcherActor(backend), () => fresh.map((id) => ({ type: 'task.session', task: id, data: { ref, kind, actor: name } })));
  return ref;
}

/**
 * Start an agent for `taskId` (a leaf or a work package). Mode comes from ATF's
 * launchPlan unless forced. `place` is the backend's placement (herdr: refPane,
 * direction, workspace, placement). Returns {name, pane, mode, kind, agent, leaf, reason}.
 */
export function launchAgent({ backend, root, planId, taskId, name, kind, agent, early = false, place = {}, force, extraArgs = [], assign = true }) {
  const s = loadPlan(root, planId);
  const target = s.tasks[taskId];
  if (!target) throw new Error(`unknown task ${taskId}`);
  // one agent per owner at a time: a running one continues with its work (it finishes,
  // then the coordinator starts the next)
  const running = backend.agents(root).get(name);
  if (running) throw new Error(`agent "${name}" is still running (${running.handle}, ${running.status}); wait until it ends, or pass another --name`);
  kind = kind || defaultKind(backend);
  const kindCfg = agentKinds(backend)[kind] || { start: [] };
  const isPackage = target.children.length > 0;
  // the leaf the agent starts on: the task itself, or the next ready leaf of the package
  const leaf = isPackage
    ? s.order.map((id) => s.tasks[id]).find((t) => !t.children.length && t.path.includes(target.id) && (t.ready || t.can_resume || t.answered)) || target
    : target;
  // agent definition: explicit, else the task's, else its work package's
  agent = agent || leaf.agent || target.agent || [...leaf.path].reverse().map((id) => s.tasks[id].agent).find(Boolean) || null;
  const agentArgs = agentDefArgs(backend, agent, kind, path.dirname(root));
  const lp = launchPlan(s, leaf.id, name);
  let mode = force || lp.mode;
  if (mode === 'resume' && !lp.session && !force) mode = 'fresh';
  const session = lp.session?.ref;
  if (mode === 'resume' && (!kindCfg.resume || !session)) mode = 'fresh'; // agent kind can't resume: fresh + checkpoint

  const env = agentEnv(backend, root, { ATF_PLAN: planId, ATF_ACTOR: name, ATF_ROLE: 'subagent', ATF_LIFECYCLE: lifecycle(backend), ...kindEnv(kindCfg) });
  const newSession = crypto.randomUUID();
  const kindArgs = [...withoutSkill(mode === 'resume' ? kindCfg.resume : kindCfg.start || []), ...(kindCfg.agent || [])];
  const known = mode === 'resume' ? session : kindArgs.includes('{newsession}') ? newSession : null;
  const args = [...fill(kindArgs, { skill: SKILL_DIR, session, newsession: newSession, live: LIVE_EXT }), ...agentArgs, ...extraArgs];
  const opened = backend.open({ role: 'subagent', name, label: name, kind, kindCfg, args, env, cwd: path.dirname(root), root, place });
  // register before anything writes to the plan: hooks fired by the assignment below
  // must already know this agent was just launched (no duplicate kickoff nudge)
  updateRegistry(backend, (reg) => {
    reg[regKey(root, name)] = { name, kind, agent, root, plan: planId, task: target.id, pane: opened.handle, workspace: opened.workspace ?? null, socket: backend.socket(), launchedAt: Date.now(), idleSince: null, session: known };
  });
  if (assign && target.assignee !== name && !(target.owner === name && !isPackage)) {
    // write as whoever called spawn, with the same identity the atf CLI uses for them
    // (ATF_ACTOR, else the user name), so the coordinator appears under one name
    transact(root, planId, { ...resolveActor(), role: 'coordinator' }, () => [{ type: 'task.assigned', task: target.id, data: { assignee: name } }]);
  }
  const fresh = loadPlan(root, planId);
  backend.prompt(opened.handle, buildPrompt({ s: fresh, t: fresh.tasks[leaf.id], name, mode, pkg: isPackage ? fresh.tasks[target.id] : null, kindCfg, early }));
  // file the session on what was spawned (the package or the task), not on a guess of
  // which leaf the agent will pick: leaves get it when the agent works on them (hook)
  recordSession(backend, root, planId, [target.id], name, kind, opened.handle, known);
  return { name, pane: opened.handle, mode, kind, agent, leaf: leaf.id, reason: lp.reason };
}

// ---------- the coordinator ----------
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The running agent of the plan's coordinator, if any. */
function runningCoordinator(backend, root, s, name) {
  const agents = backend.agents(root);
  const actor = s.actors[name];
  return actor && backend.local(actor) ? backend.find(s, actor, agents) : agents.get(name) || null;
}

/**
 * Start (or resume) the coordinator of a plan (SPEC §12.6). By default the plan's recorded
 * coordinator session is resumed; `fresh` starts a new session, and a coordinator that is
 * still running is first asked for a plan checkpoint, then replaced. `place` is the
 * backend's (herdr: workspace, inPlaceOf, reusePane). Returns {name, hname, pane, mode,
 * created, leftover}; mode 'running' if one runs already (nothing started).
 */
export function launchCoordinator({ backend, root, planId, fresh = false, kind, agent, handoffMs = 180_000, say = () => {}, dryRun = false, place = {}, prompt = null }) {
  const s = loadPlan(root, planId);
  const name = s.coordinator || resolveActor().id;
  const prev = readRegistry(backend)[regKey(root, name)];
  kind = kind || (prev?.plan === planId && prev?.kind) || defaultKind(backend);
  // the agent definition it ran with last time, unless another is asked for (none: '')
  agent = agent ?? (prev?.plan === planId ? prev.agent : null) ?? null;
  const kindCfg = agentKinds(backend)[kind] || { start: [] };
  let running = runningCoordinator(backend, root, s, name);
  // the backend decides where it goes (herdr: the plan's workspace, a pane left over)
  const where = backend.coordinatorPlace ? backend.coordinatorPlace({ root, planId, s, name, prev, running, place }) : { running };
  running = where.running;
  const mode = !fresh && s.session?.ref && kindCfg.resume ? 'resume' : 'fresh';
  if (dryRun) return { name, pane: running?.handle ?? null, mode: running && !fresh ? 'running' : mode, session: mode === 'resume' ? s.session.ref : null, leftover: where.leftover ?? null };
  if (running) {
    if (!fresh) return { name, pane: running.handle, mode: 'running' };
    where.workspace = running.workspace || where.workspace;
    // hand over: interrupt it (it may sit in `atf wait`), ask for the plan checkpoint, replace it
    const before = s.checkpoint?.seq ?? 0;
    if (running.status === 'working') backend.interrupt(running.handle), sleepMs(1500);
    backend.prompt(running.handle, `[ATF] A new coordinator session takes over plan "${s.title}" (--plan ${s.id}). Write the handoff now: \`atf plan checkpoint --plan ${s.id} "<where the plan stands, what you are waiting for, what comes next, decisions not yet in the documents>"\`, then end your turn.`);
    say(`asked ${name} for a plan checkpoint…`);
    let got = false;
    for (const t0 = Date.now(); Date.now() - t0 < handoffMs; sleepMs(1000))
      if ((loadPlan(root, planId).checkpoint?.seq ?? 0) > before) {
        got = true;
        break;
      }
    if (!got) say(`warning: ${name} wrote no checkpoint within ${Math.round(handoffMs / 1000)} s; the new session starts from the last one${s.checkpoint ? '' : ' (there is none)'}`);
    sleepMs(2000); // let it end its turn
    backend.close(running.handle);
  }
  const env = agentEnv(backend, root, { ATF_PLAN: planId, ATF_ACTOR: name, ATF_ROLE: 'coordinator', ...kindEnv(kindCfg) });
  // a harness whose wake extension cannot set the agent's env (Copilot): the arm file is set here
  if (kindCfg.wakeEnv) env.ATF_WAKE = path.join(backend.stateDir(), `wake-${planId}.json`);
  // agent names are unique per backend instance: another project may have a "coordinator"
  const hname = backend.nameTaken(name) ? `${name}-${s.id.slice(-4)}` : name;
  const newSession = crypto.randomUUID();
  const kindArgs = [...withoutSkill(mode === 'resume' ? kindCfg.resume : kindCfg.start || []), ...(kindCfg.coordinator || [])];
  const args = [...fill(kindArgs, { skill: SKILL_DIR, session: mode === 'resume' ? s.session.ref : '', newsession: newSession, wake: WAKE_EXT }), ...agentDefArgs(backend, agent, kind, path.dirname(root))];
  const opened = backend.open({ role: 'coordinator', name: hname, actor: name, label: `plan: ${s.title}`, kind, kindCfg, args, env, cwd: path.dirname(root), root, place: where });
  updateRegistry(backend, (reg) => {
    reg[regKey(root, name)] = { name: hname, actor: name, role: 'coordinator', kind, agent: agent || null, root, plan: planId, pane: opened.handle, workspace: opened.workspace ?? null, socket: backend.socket(), launchedAt: Date.now() };
  });
  backend.prompt(opened.handle, prompt ?? coordinatorPrompt(s, mode, name));
  // the plan's session: what resuming the plan starts next time
  const ref = backend.sessionRef(opened.handle, root) || (kindArgs.includes('{newsession}') ? newSession : null);
  if (ref && ref !== s.session?.ref) transact(root, planId, launcherActor(backend), () => [{ type: 'plan.session', data: { ref, kind, actor: name } }]);
  return { name, hname, pane: opened.handle, mode, created: opened.created ?? null, leftover: where.inPlaceOf === where.leftover ? null : where.leftover ?? null };
}

/**
 * A coordinator for a project without a plan yet: it starts the design discussion with
 * the human and creates the plan itself (`atf plan new`); the hook then ties that plan to
 * this coordinator (linkNewPlan). `place` is the backend's (herdr: {pane} to start in).
 */
export function launchNewCoordinator({ backend, root, place = {}, kind, agent, prompt = null }) {
  const name = resolveActor().id;
  kind = kind || defaultKind(backend);
  const kindCfg = agentKinds(backend)[kind] || { start: [] };
  const newSession = crypto.randomUUID();
  const kindArgs = withoutSkill([...(kindCfg.start || []), ...(kindCfg.coordinator || [])]);
  const args = [...fill(kindArgs, { skill: SKILL_DIR, newsession: newSession, wake: WAKE_EXT }), ...agentDefArgs(backend, agent, kind, path.dirname(root))];
  const hname = backend.nameTaken(name) ? `${name}-${crypto.randomUUID().slice(0, 4)}` : name;
  const env = newCoordinatorEnv(backend, root, kind);
  const opened = backend.open({ role: 'new', name: hname, actor: name, label: 'new plan', kind, kindCfg, args, env, cwd: path.dirname(root), root, place });
  updateRegistry(backend, (reg) => {
    reg[regKey(root, name)] = { name: hname, actor: name, role: 'coordinator', kind, agent: agent || null, root, plan: null, pane: opened.handle, workspace: opened.workspace ?? null, socket: backend.socket(), launchedAt: Date.now(), session: kindArgs.includes('{newsession}') ? newSession : null };
  });
  if (prompt) backend.prompt(opened.handle, prompt);
  return { name, hname, pane: opened.handle, kind };
}

/** Its environment: a coordinator of whatever plan it creates in `root`. */
export const newCoordinatorEnv = (backend, root, kind) => {
  const kindCfg = agentKinds(backend)[kind || defaultKind(backend)] || {};
  return agentEnv(backend, root, { ATF_ACTOR: resolveActor().id, ATF_ROLE: 'coordinator', ...kindEnv(kindCfg) });
};

/**
 * A plan was created (from the hook): the coordinator ATF started for the project
 * without a plan (launchNewCoordinator) is now this plan's: its record and the plan's
 * session, so resuming, a sweep and a restore find it.
 */
export function linkNewPlan(backend, root, planId, events) {
  const created = events.find((e) => e.type === 'plan.created');
  if (!created) return;
  const key = regKey(root, created.actor?.id);
  const rec = readRegistry(backend)[key];
  if (!rec || rec.role !== 'coordinator' || rec.plan) return;
  updateRegistry(backend, (reg) => {
    if (reg[key] && !reg[key].plan) reg[key].plan = planId;
  });
  const ref = (rec.pane && backend.sessionRef(rec.pane, root)) || rec.session || null;
  if (ref) transact(root, planId, launcherActor(backend), () => [{ type: 'plan.session', data: { ref, kind: rec.kind, actor: rec.actor } }]);
}

/**
 * Called from the ATF hook for each write: when an agent ATF launched changes the status
 * of a task (starts, blocks, submits, finishes it), file its session on that task, so a
 * later relaunch of that task resumes the session that actually worked on it.
 */
export function recordSessionsForEvents(backend, root, planId, events) {
  const reg = readRegistry(backend);
  const byActor = new Map();
  // a coordinator ATF started: keep the plan's session current (resuming the plan uses it)
  const coordRec = Object.values(reg).find((r) => r.role === 'coordinator' && r.root === root && r.plan === planId && events.some((e) => e.actor?.id === r.actor));
  if (coordRec && coordRec.pane && !foreign(backend, coordRec)) {
    const ref = backend.sessionRef(coordRec.pane, root);
    if (ref && loadPlan(root, planId).session?.ref !== ref) transact(root, planId, launcherActor(backend), () => [{ type: 'plan.session', data: { ref, kind: coordRec.kind, actor: coordRec.actor } }]);
  }
  for (const e of events) {
    if (reg[regKey(root, e.actor?.id)]?.role === 'coordinator') continue;
    if (e.type !== 'task.status' || !e.task || !e.actor?.id) continue;
    const rec = reg[regKey(root, e.actor.id)];
    if (!rec || foreign(backend, rec)) continue;
    if (!byActor.has(rec)) byActor.set(rec, new Set());
    byActor.get(rec).add(e.task);
  }
  for (const [rec, tasks] of byActor) recordSession(backend, root, planId, [...tasks], rec.name, rec.kind, rec.pane, rec.session);
}

// ---------- lifecycle sweep ----------
/** The prompt that wakes an idle coordinator: what needs it, and how to go on. */
export function nudgeText(s, actor, att, stalled = []) {
  const items = [
    ...att.map((a) => (a.task ? `${a.task} ${a.reason} (${s.tasks[a.task]?.title ?? ''})` : `plan: ${a.reason}`)),
    ...stalled.map((t) => `${t.id} stalled (its agent ${t.owner} is idle but the task is still in progress)`),
  ].join('; ');
  return `[ATF] Plan "${s.title}" (--plan ${s.id}) needs you: ${items}. Handle these (atf show <id> --plan ${s.id}; spawn agents with atf spawn <id>), then continue with \`atf wait --plan ${s.id}\`.`;
}

// An agent that wrote this recently and is busy is most likely just finishing its turn:
// check again soon instead of at the normal cadence.
const WRAP_UP_MS = 60_000;
const STALL_MS = 90_000; // a subagent idle this long with a task in progress has stalled
const idle = (a) => ['idle', 'done'].includes(a.status);

/**
 * One pass over the plans in `root` (v2: the coordinator decides, SPEC §12):
 *  - subagents ATF launched that are idle with nothing in progress -> after a grace
 *    period: record their session, close them (they finished or blocked)
 *  - an idle coordinator with something to handle (or stalled subagents) -> nudge it,
 *    once per situation
 *  - an active plan without a running coordinator -> logged once (frontends notify)
 * Subagents are never relaunched, resumed or nudged: the coordinator starts new ones.
 * Returns {actions, pending, soon}: pending = sweep again at the normal cadence; soon =
 * the coordinator is about to need a nudge (or another sweep held the lock): in seconds.
 */
export function lifecycleSweep(backend, root) {
  // one sweep at a time per machine; a concurrent one is skipped (and rescheduled)
  const lock = path.join(backend.stateDir(), 'sweep.lock');
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
    const res = sweepLocked(backend, root);
    if (res.actions.length) fs.appendFileSync(path.join(backend.stateDir(), 'lifecycle.log'), res.actions.map((a) => `${new Date().toISOString()} ${path.basename(path.dirname(root))} ${a}\n`).join(''));
    return res;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function sweepLocked(backend, root) {
  const actions = [];
  let pending = false;
  let soon = false;
  const reg = readRegistry(backend); // snapshot; changes are written back per entry at the end
  const touched = new Set();
  const nudges = readJson(backend, 'nudges.json');
  const agents = backend.agents(root); // this project's agents only: names repeat across projects
  const now = Date.now();
  const closed = new Set(); // actors closed in this pass (an actor may appear in several plans)

  for (const id of listPlanIds(root)) {
    const s = loadPlan(root, id);
    const planOpen = s.status === 'active';
    const coordId = s.coordinator || Object.values(s.actors).find((a) => a.role === 'coordinator')?.id || null;
    const stalled = [];

    // ---- subagents ATF launched: close the ones that are done
    for (const actor of Object.values(s.actors)) {
      if (!backend.local(actor) || actor.id === coordId || closed.has(actor.id)) continue;
      let rec = reg[regKey(root, actor.id)];
      if (foreign(backend, rec)) rec = undefined;
      if (rec?.role === 'coordinator') continue;
      const agent = backend.find(s, actor, agents);
      if (!agent) continue;
      const working = s.order.some((tid) => s.tasks[tid].owner === actor.id && s.tasks[tid].status === 'in_progress' && !s.tasks[tid].children.length);
      if (rec) touched.add(regKey(root, actor.id));
      if (!idle(agent)) {
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
      if (!rec || lifecycle(backend) !== 'ephemeral') continue;
      if (!rec.idleSince) {
        rec.idleSince = now;
        pending = true;
        continue;
      }
      if (now - rec.idleSince < GRACE_MS) {
        pending = true;
        continue;
      }
      recordSession(backend, root, s.id, workedThisLaunch(s, actor, rec), actor.id, rec.kind, agent.handle, rec.session);
      backend.close(agent.handle);
      rec.pane = null;
      rec.idleSince = null;
      rec.closedAt = now;
      closed.add(actor.id);
      actions.push(`closed ${actor.id} (finished its assignment)`);
    }

    if (!planOpen || !coordId) continue;
    // ---- the coordinator
    const coord = s.actors[coordId];
    if (coord && !backend.local(coord)) continue; // runs elsewhere (another herdr session)
    const agent = coord && backend.find(s, coord, agents);
    const nkey = `${root}#${s.id}#${coordId}`;
    if (!agent) {
      // nobody decides for this plan: the human is notified (frontends: "no-coordinator")
      // and offered to start one. Logged once here.
      const open = s.order.some((tid) => !s.tasks[tid].children.length && !TERMINAL.has(s.tasks[tid].status));
      if (open && nudges[`${nkey}#absent`] !== true) {
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
    if (!idle(agent)) {
      // busy (e.g. in `atf wait`, which reports it): if it wrote just now it is probably
      // wrapping up its turn, so look again in seconds
      if (nudges[nkey] !== attKey && coord.last_seen && now - Date.parse(coord.last_seen) < WRAP_UP_MS) soon = true;
      pending = true;
      continue;
    }
    if (nudges[nkey] !== attKey && backend.prompt(agent.handle, nudgeText(s, coord, att, stalled))) {
      nudges[nkey] = attKey;
      actions.push(`nudged ${coordId}: ${attKey}`);
    }
  }
  updateRegistry(backend, (fresh) => {
    for (const k of touched) {
      if (!fresh[k] || !reg[k]) continue;
      if (fresh[k].launchedAt !== reg[k].launchedAt) continue; // relaunched meanwhile: keep the newer entry
      for (const f of ['idleSince', 'pane', 'closedAt']) fresh[k][f] = reg[k][f];
    }
  });
  writeJson(backend, 'nudges.json', nudges);
  return { actions, pending, soon };
}

/** Leaves this actor changed during its current launch (to file that launch's session on). */
function workedThisLaunch(s, actor, rec) {
  const since = rec?.launchedAt ?? 0;
  return s.order.filter((tid) => {
    const t = s.tasks[tid];
    return t.owner === actor.id && !t.children.length && t.history.some((h) => h.actor === actor.id && Date.parse(h.ts) >= since - 1000);
  });
}
