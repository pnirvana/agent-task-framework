// Bring ATF back after herdr (or the machine) went down: SPEC §12.6.
//
// herdr restores workspaces, tabs, panes (with their names) and resumes pi in its last
// session, but processes and environments are gone: a resumed coordinator no longer
// knows its plan (no ATF_* env, no wake extension), a subagent's pane holds a stray
// session, and a board pane is a bare shell. `restore` (run by the plugin's startup hook,
// or by hand) repairs what ATF started, and nothing else:
//  - subagents: their panes are closed; their tasks are left to the coordinator
//  - coordinators: relaunched in the spot of their restored pane, resuming the plan's
//    session, told that they were restarted and which tasks lost their agent
//  - boards: the shell where a board was gets the board again
import fs from 'node:fs';
import { knownRoots, listPlanIds, loadPlan, hasLiveWaiter, readEvents, findRoot } from '../../../src/store.mjs';
import { revivedPrompt } from '../../../src/prompts.mjs';
import { herdr, currentSocket, notify, pluginConfig, isBoardPane, isLiveBoard } from './herdr.mjs';
import { readRegistry, updateRegistry, launchCoordinator } from './launch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUSY = new Set(['working', 'blocked']);

/** Pane list once it stopped changing (herdr may still be starting agents in it). */
async function settledPanes(maxMs) {
  let last = null;
  for (const t0 = Date.now(); ; await sleep(1500)) {
    const panes = herdr(['pane', 'list'])?.panes || [];
    const sig = panes.map((p) => `${p.pane_id}:${p.agent ?? ''}`).join(',');
    if (sig === last || Date.now() - t0 > maxMs) return panes;
    last = sig;
  }
}

/**
 * Repair what ATF started. `openBoard({root, target, workspace})` opens a board beside
 * `target` (the CLI's toggleBoard). Returns a report; `dryRun` only reports.
 */
export async function restore({ openBoard = null, dryRun = false, settleMs = 20_000, say = () => {} } = {}) {
  const sock = currentSocket();
  const report = { coordinators: [], closed: [], boards: 0, orphaned: 0, skipped: [] };
  let panes = await settledPanes(settleMs);
  const byId = new Map(panes.map((p) => [p.pane_id, p]));
  const agents = herdr(['agent', 'list'])?.agents || [];
  const bySession = new Map(agents.filter((a) => a.agent_session?.value).map((a) => [a.agent_session.value, a]));
  const agentIn = (pane) => agents.find((a) => a.pane_id === pane);
  const mine = (r) => !r.socket || !sock || r.socket === sock;
  // where an agent ATF started is now: its pane (same id, still named after it), else the
  // pane whose agent herdr resumed into its session
  const paneOf = (r, sessions = []) => {
    const p = r.pane && byId.get(r.pane);
    if (p && p.label === (r.actor || r.name)) return p;
    for (const ref of sessions.filter(Boolean)) {
      const a = bySession.get(ref);
      if (a && byId.get(a.pane_id)) return byId.get(a.pane_id);
    }
    return null;
  };
  const plans = new Map(); // `${root}#${plan}` -> state
  const planOf = (root, id) => {
    const k = `${root}#${id}`;
    if (!plans.has(k)) {
      try {
        plans.set(k, loadPlan(root, id));
      } catch {
        plans.set(k, null);
      }
    }
    return plans.get(k);
  };
  const reg = readRegistry();

  // ---- subagents: close their panes (the coordinator decides about their tasks)
  for (const [key, r] of Object.entries(reg)) {
    if (r.role === 'coordinator' || !r.pane || !mine(r)) continue;
    const s = r.plan && planOf(r.root, r.plan);
    const sessions = [r.session, ...(s ? s.order.map((id) => s.tasks[id].sessions?.[r.name]?.ref) : [])];
    const p = paneOf(r, sessions);
    if (!p) continue;
    if (BUSY.has(agentIn(p.pane_id)?.agent_status)) {
      report.skipped.push(`${r.name} (working)`); // still alive (e.g. after a live handoff)
      continue;
    }
    if (!dryRun) {
      herdr(['pane', 'close', p.pane_id]);
      updateRegistry((fresh) => {
        if (fresh[key]?.launchedAt === r.launchedAt) (fresh[key].pane = null), (fresh[key].closedAt = Date.now());
      });
    }
    report.closed.push(r.name);
    if (!dryRun) say(`closed ${r.name} (${p.pane_id})`);
  }

  // ---- coordinators: the ones ATF started, and any agent herdr resumed into a plan's session
  const coords = [];
  for (const r of Object.values(reg)) if (r.role === 'coordinator' && r.plan && mine(r)) coords.push({ root: r.root, plan: r.plan, actor: r.actor, rec: r });
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  for (const root of knownRoots())
    for (const id of listPlanIds(root))
      if (!coords.some((c) => real(c.root) === real(root) && c.plan === id)) {
        const s = planOf(root, id);
        if (s?.session?.ref && bySession.has(s.session.ref)) coords.push({ root, plan: id, actor: s.coordinator, rec: null });
      }
  for (const c of coords) {
    const s = planOf(c.root, c.plan);
    if (!s) continue;
    const ref = s.session?.ref;
    const p = c.rec ? paneOf(c.rec, [ref]) : byId.get(bySession.get(ref)?.pane_id);
    if (!p) continue; // not running when herdr went down (or closed on purpose): left to `s`
    const label = `${s.title} (${c.actor})`;
    if (hasLiveWaiter(c.root, c.plan, c.actor) || BUSY.has(agentIn(p.pane_id)?.agent_status)) {
      report.skipped.push(`${label}: still running`);
      continue;
    }
    if (!['active', 'paused'].includes(s.status)) {
      if (!dryRun) herdr(['pane', 'close', p.pane_id]); // the plan is closed: its coordinator is not needed
      continue;
    }
    const orphaned = s.order.map((id) => s.tasks[id]).filter((t) => !t.children.length && t.status === 'in_progress' && t.owner && t.owner !== c.actor);
    const last = readEvents(c.root, c.plan).at(-1)?.ts;
    report.orphaned += orphaned.length;
    if (dryRun) {
      report.coordinators.push(`${label} in ${p.pane_id}`);
      continue;
    }
    try {
      const prompt = revivedPrompt(s, c.actor, { lastEvent: last ? new Date(last).toLocaleString() : null, orphaned });
      const r = launchCoordinator({ root: c.root, planId: c.plan, workspace: p.workspace_id, inPlaceOf: p.pane_id, prompt });
      if (r.mode === 'running') {
        report.skipped.push(`${label}: already running in ${r.pane}`);
        continue;
      }
      report.coordinators.push(s.title);
      say(`restarted the coordinator of ${s.title} (${r.pane})`);
    } catch (e) {
      report.skipped.push(`${label}: ${e.message}`);
    }
  }

  // ---- boards: a shell where a board was (herdr cannot restart a plugin pane)
  if (openBoard) {
    panes = herdr(['pane', 'list'])?.panes || [];
    for (const b of panes.filter((p) => isBoardPane(p) && !p.agent && !isLiveBoard(p))) {
      const near = panes.find((p) => p.tab_id === b.tab_id && p.pane_id !== b.pane_id && !isBoardPane(p));
      const root = [near?.foreground_cwd, near?.cwd, b.cwd].filter(Boolean).map((d) => findRoot(d)).find(Boolean) || null;
      if (dryRun) {
        report.boards++;
        continue;
      }
      herdr(['plugin', 'pane', 'close', b.pane_id]) || herdr(['pane', 'close', b.pane_id]);
      if (!near) continue; // the board was alone in its tab: that tab is gone now
      const err = openBoard({ root, target: near.pane_id, workspace: b.workspace_id, tab: b.tab_id });
      if (err) report.skipped.push(`board in ${b.workspace_id}: ${err}`);
      else report.boards++;
    }
  }
  return report;
}

/** One line for the human: what was restored. */
export function restoreSummary(r) {
  const bits = [];
  if (r.coordinators.length) bits.push(`coordinator${r.coordinators.length === 1 ? '' : 's'} of ${r.coordinators.join(', ')} restarted`);
  if (r.orphaned) bits.push(`${r.orphaned} task${r.orphaned === 1 ? '' : 's'} in progress handed to ${r.coordinators.length === 1 ? 'it' : 'them'}`);
  if (r.closed.length) bits.push(`${r.closed.length} stale agent pane${r.closed.length === 1 ? '' : 's'} closed`);
  if (r.boards) bits.push(`${r.boards} board${r.boards === 1 ? '' : 's'} reopened`);
  return bits.join('; ');
}

/** After a herdr start (plugin startup hook): restore unless `restore = "off"`, and say so. */
export async function restoreOnStartup(opts) {
  if (String(pluginConfig().restore ?? 'auto') === 'off') return null;
  const r = await restore(opts);
  const line = restoreSummary(r);
  if (line) notify('ATF restored after a restart', line, 'none');
  return r;
}

