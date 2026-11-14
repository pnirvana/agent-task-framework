// Agent launching and lifecycle for the herdr adapter.
//
// ATF core decides *whether* the next agent on a task resumes an earlier session or
// starts fresh (launchPlan). This module decides *how*: which pane, which agent kind,
// which arguments. Everything agent-specific is in the AGENT_KINDS table, which users
// can extend or override via the plugin config ("agents": {...}).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMINAL, attentionFor, launchPlan } from '../../../src/core.mjs';
import { listPlanIds, loadPlan, transact, skillInstalled, resolveActor } from '../../../src/store.mjs';
import { herdr, pluginConfig, sameServer, currentSocket, liveAgents, boardPaneIds, pluginStateDir } from './herdr.mjs';
import { chooseSplit, tabLayout, withPlacementLock } from './layout.mjs';
import { resolveAgentDef, piArgsForAgent } from './agents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ATF_BIN = path.resolve(HERE, '../../../bin');
export const SKILL_DIR = path.resolve(HERE, '../../../skill/atf');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');

/**
 * Per agent kind: extra args to start fresh, args to resume a session, and whether the
 * agent loads the ATF skill natively. `{skill}` and `{session}` are substituted.
 * Kinds without `resume` always start fresh (from checkpoint + task history).
 */
export const AGENT_KINDS = {
  pi: { start: ['--skill', '{skill}'], resume: ['--session', '{session}', '--skill', '{skill}'], nativeSkill: true },
  claude: { start: [], resume: ['--resume', '{session}'] },
  codex: { start: [], resume: ['resume', '{session}'] },
};

export function agentKinds() {
  return { ...AGENT_KINDS, ...(pluginConfig().agents || {}) };
}

export const lifecycle = () => process.env.ATF_LIFECYCLE_MODE || pluginConfig().lifecycle || 'ephemeral';
const GRACE_MS = 15_000; // idle this long (with nothing to do) before an ephemeral agent is closed
const RELAUNCH_COOLDOWN_MS = 60_000;

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
/**
 * Create a pane for a new agent: split the largest pane of the reference tab along its
 * longer side (never the board), else reuse/open an "agents" tab. `direction` forces a
 * plain split of the reference pane.
 */
export function placeAgentPane({ cwd, env, refPane, direction, workspace }) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  const splitOf = (pane, dir) => herdr(['pane', 'split', '--pane', pane, '--direction', dir, '--cwd', cwd, '--no-focus', ...envArgs])?.pane?.pane_id;
  if (refPane && direction) return splitOf(refPane, direction);
  const exclude = boardPaneIds();
  if (refPane) {
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

// ---------- prompts ----------
function lastNoteFromOthers(t) {
  return [...t.notes].reverse().find((n) => n.actor && n.actor !== t.owner && n.kind !== 'checkpoint');
}

function wasReopened(t) {
  return t.status === 'todo' && t.history.some((h) => h.type === 'status' && h.to === 'todo' && ['review', 'done', 'failed', 'blocked'].includes(h.from));
}

/** Why the agent is (re)started, in words, for the prompt. */
function situation(s, t) {
  if (t.changes_requested) {
    const fb = t.feedback[t.feedback.length - 1];
    return `changes were requested (review round ${fb.round}) by ${fb.actor ?? 'the coordinator'}: "${fb.message}". Address every point, say in an atf note how, then send it to review again.`;
  }
  if (t.can_resume) return `${t.blocked_on.join(', ')} ${t.blocked_on.length > 1 ? 'are' : 'is'} done now (you were blocked on ${t.blocked_on.length > 1 ? 'them' : 'it'}).`;
  if (t.answered) {
    const n = lastNoteFromOthers(t);
    return `your question was answered${n ? ` by ${n.actor}: "${n.message}"` : ''}.`;
  }
  if (wasReopened(t)) {
    const h = [...t.history].reverse().find((x) => x.type === 'status' && x.to === 'todo');
    return `it was reopened by ${h?.actor ?? 'the coordinator'}${h?.message ? `: "${h.message}"` : ''}.`;
  }
  return null;
}

export function buildPrompt({ s, t, name, mode, pkg, kindCfg, early = false }) {
  const skill = kindCfg.nativeSkill || skillInstalled() ? 'Follow the atf skill (load it if it is not loaded yet).' : `First read ${SKILL_FILE} and follow its subagent section.`;
  const why = situation(s, t);
  if (mode === 'resume')
    return (
      `[ATF] You are resumed in your earlier session for ${t.id} (${t.title})${why ? `: ${why}` : '.'} ` +
      `Run \`atf show ${t.id}\` to see what changed, then \`atf start ${t.id}\` and continue where you left off. ${skill}`
    );
  if (early && t.waiting_on?.length)
    return (
      `You are subagent "${name}". Your ATF task is ${t.id}: ${t.title}. It is started EARLY: it depends on ${t.waiting_on.join(', ')}, which ${t.waiting_on.length > 1 ? 'are' : 'is'} not done yet. ` +
      `Run \`atf show ${t.id}\`, then \`atf start ${t.id} --early\` and do everything that does not need ${t.waiting_on.join(', ')}. ` +
      `When you reach what does, write a checkpoint (\`atf note ${t.id} --kind checkpoint "done: … left: …"\`) and run \`atf block ${t.id} --on ${t.waiting_on.join(',')} -m "<what you need>"\`; you will be resumed when it is done. ${skill}`
    );
  const history = t.started_at
    ? ` This task was worked on before by another session: \`atf show ${t.id}\` has its checkpoint, notes and earlier result${why ? `, and ${why}` : '.'} Continue from there instead of starting over.`
    : '';
  if (pkg)
    return (
      `You are subagent "${name}". You own ATF work package ${pkg.id}: ${pkg.title} (the whole subtree); your next task is ${t.id}: ${t.title}.${history} ` +
      `Run \`atf show ${pkg.id}\` and \`atf list --mine\` to see the package. Then loop: \`atf next --package\`, do the task, finish it ` +
      `(done/review/block/fail). You may split a task with \`atf add <title> --parent <id>\`. ${skill}`
    );
  return (
    `You are subagent "${name}". Your ATF task is ${t.id}: ${t.title}.${history} ` +
    `Run \`atf show ${t.id}\` for details and acceptance criteria, then \`atf start ${t.id}\` and do the work. ${skill} ` +
    (t.review || (t.reviewer && t.reviewer !== 'coordinator')
      ? `Report progress with atf. This task needs review: finish with \`atf review ${t.id} -m "<summary + what to check>"\` (not done), or block/fail.`
      : `Report progress with atf and finish with atf done/review/block/fail.`)
  );
}

// ---------- launching ----------
export function recordSession(root, planId, taskIds, name, kind) {
  const a = herdr(['agent', 'get', name])?.agent;
  const ref = a?.agent_session?.value;
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
export function launchAgent({ root, planId, taskId, name, kind, agent, early = false, refPane, direction, workspace, force, extraArgs = [], assign = true }) {
  const s = loadPlan(root, planId);
  const target = s.tasks[taskId];
  if (!target) throw new Error(`unknown task ${taskId}`);
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
  const pane = withPlacementLock(() => placeAgentPane({ cwd: path.dirname(root), env, refPane, direction, workspace }));
  if (!pane) throw new Error('could not create a pane');
  const sub = (a) => a.replace('{skill}', SKILL_DIR).replace('{session}', session ?? '');
  // an installed skill is discovered by the agent itself: don't pass it again
  const withoutSkill = (list) => (skillInstalled() ? list.filter((a, i) => a !== '{skill}' && list[i + 1] !== '{skill}') : list);
  const args = [...withoutSkill(mode === 'resume' ? kindCfg.resume : kindCfg.start || []).map(sub), ...agentArgs, ...extraArgs];
  const started = herdr(['agent', 'start', name, '--kind', kind, '--pane', pane, ...(args.length ? ['--', ...args] : [])], { timeout: 60_000 });
  if (!started) {
    herdr(['pane', 'close', pane]);
    throw new Error(`herdr could not start ${kind} agent "${name}"`);
  }
  // register before anything writes to the plan: hooks fired by the assignment below
  // must already know this agent was just launched (no duplicate kickoff nudge)
  updateRegistry((reg) => {
    reg[regKey(root, name)] = { name, kind, agent, root, plan: planId, task: target.id, pane, workspace: paneWorkspace(pane), socket: currentSocket(), launchedAt: Date.now(), idleSince: null };
  });
  if (assign && target.assignee !== name && !(target.owner === name && !isPackage)) {
    // write as whoever called spawn, with the same identity the atf CLI uses for them
    // (ATF_ACTOR, else the user name), so the coordinator appears under one name
    transact(root, planId, { ...resolveActor(), role: 'coordinator' }, () => [
      { type: 'task.assigned', task: target.id, data: { assignee: name } },
    ]);
  }
  const fresh = loadPlan(root, planId);
  herdr(['agent', 'prompt', name, buildPrompt({ s: fresh, t: fresh.tasks[leaf.id], name, mode, pkg: isPackage ? fresh.tasks[target.id] : null, kindCfg, early })]);
  // file the session on what was spawned (the package or the task), not on a guess of
  // which leaf the agent will pick: leaves get it when the agent works on them (hook)
  recordSession(root, planId, [target.id], name, kind);
  return { name, pane, mode, kind, agent, leaf: leaf.id, reason: lp.reason };
}

/**
 * Called from the ATF hook for each write: when an agent ATF launched changes the status
 * of a task (starts, blocks, submits, finishes it), file its session on that task, so a
 * later relaunch of that task resumes the session that actually worked on it.
 */
export function recordSessionsForEvents(root, planId, events) {
  const reg = readRegistry();
  const byActor = new Map();
  for (const e of events) {
    if (e.type !== 'task.status' || !e.task || !e.actor?.id) continue;
    const rec = reg[regKey(root, e.actor.id)];
    if (!rec || (rec.socket && currentSocket() && rec.socket !== currentSocket())) continue;
    if (!byActor.has(rec)) byActor.set(rec, new Set());
    byActor.get(rec).add(e.task);
  }
  for (const [rec, tasks] of byActor) recordSession(root, planId, [...tasks], rec.name, rec.kind);
}

// ---------- lifecycle sweep ----------
export function nudgeText(s, actor, att) {
  const items = att.map((a) => `${a.task} ${a.reason} (${s.tasks[a.task]?.title ?? ''})`).join('; ');
  if (actor.role === 'coordinator')
    return `[ATF] Plan "${s.title}" (--plan ${s.id}) needs you: ${items}. Handle these (atf show <id> --plan ${s.id}; approve with atf done -m, atf changes -m, or answer), then continue monitoring with \`atf wait --plan ${s.id}\`.`;
  // what to run depends on the reason and on whether the task came with a work package
  const how = (a) => {
    const t = s.tasks[a.task];
    if (a.reason === 'changes') return `${a.task}: changes were requested, read the feedback with \`atf show ${a.task}\`, then \`atf start ${a.task}\``;
    if (a.reason === 'unblocked') return `${a.task}: \`atf start ${a.task}\` and continue from your checkpoint (blocked on ${t.blocked_on.join(',')}, now done)`;
    if (a.reason === 'answered') return `${a.task}: your question was answered (\`atf show ${a.task}\`), then \`atf start ${a.task}\``;
    const viaPackage = t && t.assignee !== actor.id; // owned through an assigned parent
    return viaPackage ? `${a.task}: \`atf next --package\`` : `${a.task}: \`atf start ${a.task}\``;
  };
  const steps = [...new Set(att.map(how))];
  return `[ATF] Work is available for you in plan "${s.title}" (--plan ${s.id}): ${items}. ${steps.length > 1 ? 'Next: ' + steps.join('; ') : 'Next: ' + steps[0]}.`;
}

// Has the agent acted (written to ATF) since it was launched? Then it has read its
// kickoff prompt, and the post-launch cooldown no longer applies.
const actedSince = (actor, launchedAt) => !!(actor.last_seen && Date.parse(actor.last_seen) >= launchedAt);
// An agent that wrote this recently and is busy is most likely just finishing its turn:
// check again soon instead of at the normal cadence.
const WRAP_UP_MS = 60_000;

/**
 * One pass over all active plans in `root`:
 *  - live + idle + something needs it      -> nudge (prompt) it, once per situation
 *  - live + idle + nothing to do (ephemeral)-> after a grace period: save session refs, close pane
 *  - gone + something needs it (ATF-spawned)-> relaunch: resume the task's session or start fresh
 * Returns {actions, pending, soon}: pending = sweep again at the normal cadence; soon =
 * an agent is about to need a nudge or relaunch (or another sweep held the lock): in seconds.
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
  let soon = false; // something is about to need a nudge/relaunch: sweep again in seconds
  const reg = readRegistry(); // snapshot; changes are written back per entry at the end
  const touched = new Set();
  const nudges = readJson('nudges.json');
  const live = liveAgents();
  const livePane = new Map([...live.values()].map((a) => [a.pane_id, a]));
  const now = Date.now();

  for (const id of listPlanIds(root)) {
    const s = loadPlan(root, id);
    // closed plans: nothing to nudge or relaunch, but their idle ATF agents still get closed
    const planOpen = s.status === 'active';
    if (!planOpen && !Object.values(s.actors).some((a) => live.has(a.id) && reg[regKey(root, a.id)])) continue;
    for (const actor of Object.values(s.actors)) {
      if (!sameServer(actor)) continue; // agents of another herdr session are not ours to manage
      let rec = reg[regKey(root, actor.id)];
      if (rec?.socket && currentSocket() && rec.socket !== currentSocket()) rec = undefined;
      if (!planOpen && rec?.plan !== s.id) continue; // closed plan: only agents launched for it
      if (rec) touched.add(regKey(root, actor.id));
      let agent = liveAgentOf(s, actor, live, livePane);
      const role = actor.role === 'coordinator' ? 'coordinator' : 'subagent';
      const att = planOpen ? attentionFor(s, actor.id, role) : [];
      // changes --fresh: a fresh agent takes the next attempt, so this one is closed and relaunched
      if (agent && rec && ['idle', 'done'].includes(agent.agent_status) && att.some((a) => s.tasks[a.task]?.fresh_next)) {
        recordSession(root, s.id, workedThisLaunch(s, actor, rec), actor.id, rec.kind);
        herdr(['pane', 'close', agent.pane_id]);
        rec.pane = null;
        rec.closedAt = now;
        actions.push(`closed ${actor.id} for a fresh attempt`);
        agent = null;
        att.sort((a, b) => Number(!!s.tasks[b.task]?.fresh_next) - Number(!!s.tasks[a.task]?.fresh_next));
      }
      const nkey = `${root}#${s.id}#${actor.id}`;
      const attKey = att.map((a) => `${a.task}:${a.reason}`).join(',');
      if (!att.length) delete nudges[nkey];

      if (agent) {
        const idle = ['idle', 'done'].includes(agent.agent_status);
        if (!idle) {
          if (rec) rec.idleSince = null;
          if (rec) pending = true;
          // work is waiting for it and it wrote recently: it is probably wrapping up its turn
          if (att.length && nudges[nkey] !== attKey && actor.last_seen && now - Date.parse(actor.last_seen) < WRAP_UP_MS) soon = true;
          continue;
        }
        if (att.length) {
          // a just-launched agent is idle until it reads its kickoff prompt: don't double-prompt it
          // (once it has written anything, it has read it)
          const justLaunched = rec?.launchedAt && now - rec.launchedAt < RELAUNCH_COOLDOWN_MS && !actedSince(actor, rec.launchedAt);
          if (justLaunched) {
            pending = true; // its first atf write fires the hook, which sweeps at once
            continue;
          }
          if (nudges[nkey] !== attKey && herdr(['agent', 'prompt', agent.name, nudgeText(s, actor, att)])) {
            nudges[nkey] = attKey;
            actions.push(`nudged ${actor.id}: ${attKey}`);
          }
          if (rec) rec.idleSince = null;
          continue;
        }
        // idle with nothing to do: only ATF-spawned agents in ephemeral mode are closed
        if (!rec || lifecycle() !== 'ephemeral') continue;
        const working = s.order.some((tid) => s.tasks[tid].owner === actor.id && s.tasks[tid].status === 'in_progress' && !s.tasks[tid].children.length);
        if (working) continue; // stale rather than finished: leave it for a human to look at
        if (!rec.idleSince) {
          rec.idleSince = now;
          pending = true;
          continue;
        }
        if (now - rec.idleSince < GRACE_MS) {
          pending = true;
          continue;
        }
        recordSession(root, s.id, workedThisLaunch(s, actor, rec), actor.id, rec.kind);
        herdr(['pane', 'close', agent.pane_id]);
        rec.pane = null;
        rec.idleSince = null;
        rec.closedAt = now;
        actions.push(`closed ${actor.id} (idle, nothing to do)`);
        continue;
      }

      // not alive
      if (!att.length || !rec || rec.plan !== s.id) continue;
      // cooldown against relaunch loops (e.g. an agent that dies on start), not for one that worked and exited
      if (rec.launchedAt && now - rec.launchedAt < RELAUNCH_COOLDOWN_MS && !actedSince(actor, rec.launchedAt)) {
        pending = true;
        continue;
      }
      const first = s.tasks[att[0].task];
      const pkgId = [...first.path].reverse().find((pid) => s.tasks[pid].assignee === actor.id);
      try {
        const refPane = Object.values(reg).find((r) => r.pane && r.root === root && live.has(r.name))?.pane || coordinatorPane(s, live, livePane);
        // no live pane to place it next to: the workspace it ran in before, or the coordinator's
        const coord = Object.values(s.actors).find((a) => a.role === 'coordinator' && sameServer(a));
        const workspace = rec.workspace || coord?.ctx?.herdr_workspace || null;
        const r = launchAgent({ root, planId: s.id, taskId: pkgId && first.ready && !first.assignee ? pkgId : first.id, name: actor.id, kind: rec.kind, agent: rec.agent, refPane, workspace, assign: false });
        touched.delete(regKey(root, actor.id)); // launchAgent wrote the fresh entry itself
        actions.push(`relaunched ${actor.id} for ${r.leaf} (${r.mode}: ${r.reason})`);
        pending = true;
      } catch (e) {
        actions.push(`relaunch of ${actor.id} failed: ${e.message}`);
      }
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

function coordinatorPane(s, live, livePane) {
  for (const a of Object.values(s.actors)) {
    if (a.role !== 'coordinator') continue;
    const l = liveAgentOf(s, a, live, livePane);
    if (l) return l.pane_id;
  }
  return null;
}

/** Leaves this actor changed during its current launch (to file that launch's session on). */
function workedThisLaunch(s, actor, rec) {
  const since = rec?.launchedAt ?? 0;
  return s.order.filter((tid) => {
    const t = s.tasks[tid];
    return t.owner === actor.id && !t.children.length && t.history.some((h) => h.actor === actor.id && Date.parse(h.ts) >= since - 1000);
  });
}
