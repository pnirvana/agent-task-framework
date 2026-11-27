// herdr as a backend of the launcher (src/launch.mjs): agents in herdr panes, the plan's
// coordinator in its workspace. The exports below keep the herdr adapter's signatures
// (atf-herdr, the board, restore, the hook), bound to this backend.
import path from 'node:path';
import * as core from '../../../src/launch.mjs';
import { loadPlan, resolveActor } from '../../../src/store.mjs';
import { herdr, paneText, startFailure, pluginConfig, sameServer, currentSocket, liveAgents, inProject, boardPaneIds, pluginStateDir } from './herdr.mjs';
import { chooseSplit, tabLayout, withPlacementLock } from './layout.mjs';

export { ATF_BIN, SKILL_DIR, buildPrompt, coordinatorPrompt, AGENT_KINDS, nudgeText } from '../../../src/launch.mjs';

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

/**
 * The first of `candidates` (workspace ids) that still exists and still works in the
 * project (herdr may give a closed workspace's id to a new one), else a workspace named
 * after the project's folder; null when there is none.
 */
function planWorkspace(root, candidates) {
  const dir = path.dirname(root);
  const inDir = (p) => [p.foreground_cwd, p.cwd].some((c) => c && (c === dir || c.startsWith(dir + path.sep)));
  const panes = herdr(['pane', 'list'])?.panes || [];
  for (const ws of candidates.filter(Boolean)) if (panes.some((p) => p.workspace_id === ws && inDir(p))) return ws;
  const named = (herdr(['workspace', 'list'])?.workspaces || []).find((w) => w.label === path.basename(dir) && panes.some((p) => p.workspace_id === w.workspace_id && inDir(p)));
  return named?.workspace_id ?? null;
}

/**
 * The pane a coordinator starts in: a new tab, or (inPlaceOf) the spot of an existing
 * pane, e.g. one herdr restored with a bare agent in it: split off it with the
 * coordinator's environment, then that pane is closed, so the layout stays as it was.
 */
function coordinatorPane({ env, cwd, workspace, inPlaceOf, label, newWorkspace = null }) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  if (inPlaceOf) {
    const pane = herdr(['pane', 'split', '--pane', inPlaceOf, '--direction', 'right', '--cwd', cwd, '--no-focus', ...envArgs])?.pane?.pane_id;
    if (pane) {
      herdr(['pane', 'close', inPlaceOf]);
      return { pane, tab: null };
    }
  }
  if (newWorkspace) {
    // a workspace of its own (as atf-herdr new makes): named after the project's folder
    const ws = herdr(['workspace', 'create', '--cwd', cwd, '--label', newWorkspace, '--focus', ...envArgs]);
    const pane = ws?.root_pane?.pane_id;
    if (!pane) throw new Error('could not create a workspace for the coordinator');
    if (ws.tab?.tab_id) herdr(['tab', 'rename', ws.tab.tab_id, label.slice(0, 40)]);
    return { pane, tab: ws.tab?.tab_id ?? null };
  }
  const tab = herdr(['tab', 'create', ...(workspace ? ['--workspace', workspace] : []), '--cwd', cwd, '--label', label.slice(0, 40), '--focus', ...envArgs]);
  const pane = tab?.root_pane?.pane_id;
  if (!pane) throw new Error('could not open a tab for the coordinator');
  return { pane, tab: tab?.tab?.tab_id ?? null };
}

function startIn(pane, hname, kind, args, root) {
  if (!herdr(['agent', 'start', hname, '--kind', kind, '--pane', pane, ...(args.length ? ['--', ...args] : [])], { timeout: 60_000 })) {
    const why = startFailure(kind, paneText(pane), path.dirname(root));
    herdr(['pane', 'close', pane]);
    throw new Error(`herdr could not start ${kind} agent "${hname}"${why ? `: ${why}` : ''}`);
  }
}

// ---------- the backend ----------
const asAgent = (a) => ({ ...a, handle: a.pane_id, status: a.agent_status, workspace: a.workspace_id });

export const herdrBackend = {
  name: 'herdr',
  stateDir: pluginStateDir,
  config: pluginConfig,
  local: sameServer,
  socket: currentSocket,
  agents(root) {
    const m = new Map();
    for (const [n, a] of liveAgents(root)) m.set(n, asAgent(a));
    return m;
  },
  /**
   * By name (agents ATF launched are named after their actor), else by the herdr pane its
   * last ATF write came from (a coordinator started by hand has its own herdr name, e.g.
   * "pi", but writes as $ATF_ACTOR/$USER).
   */
  find(s, actor, agents) {
    const byName = agents.get(actor.id);
    if (byName) return byName;
    const pane = actor.ctx?.herdr_pane;
    const a = pane && [...agents.values()].find((x) => x.handle === pane);
    if (!a || (s.actors[a.name] && a.name !== actor.id)) return null; // that pane belongs to another actor now
    return a;
  },
  sessionRef(handle, root) {
    const a = herdr(['agent', 'get', handle])?.agent;
    if (a && !inProject(a, root)) return false; // never another project's agent
    return a?.agent_session?.value || null;
  },
  nameTaken: (name) => !!herdr(['agent', 'get', name])?.agent,
  open({ role, name, actor, label, kind, args, env, cwd, root, place = {} }) {
    if (role === 'subagent') {
      const placement = agentPlacement(place.placement);
      const pane = withPlacementLock(() => placeAgentPane({ cwd, env, refPane: place.refPane, direction: place.direction, workspace: place.workspace, placement }));
      if (!pane) throw new Error('could not create a pane');
      startIn(pane, name, kind, args, root);
      herdr(['pane', 'rename', pane, name]); // the pane shows who works in it, not the tab it sits in
      return { handle: pane, workspace: paneWorkspace(pane) };
    }
    if (role === 'new') {
      startIn(place.pane, name, kind, args, root);
      herdr(['pane', 'rename', place.pane, actor]);
      return { handle: place.pane, workspace: paneWorkspace(place.pane) };
    }
    // the coordinator: in the plan's workspace, in place of a pane, or a workspace of its own
    const created = !place.workspace && !place.inPlaceOf;
    const { pane, tab } = coordinatorPane({ env, cwd, workspace: place.workspace, inPlaceOf: place.inPlaceOf, label, newWorkspace: created ? path.basename(cwd) : null });
    startIn(pane, name, kind, args, root);
    herdr(['pane', 'rename', pane, actor]);
    const workspace = paneWorkspace(pane);
    return { handle: pane, workspace, created: created ? { workspace, tab } : null };
  },
  prompt: (handle, text) => !!herdr(['agent', 'prompt', handle, text]),
  interrupt: (handle) => herdr(['agent', 'send-keys', handle, 'esc']),
  close: (handle) => herdr(['pane', 'close', handle]),
  /** The plan's workspace (where its coordinator last ran, or the project's), a leftover shell. */
  coordinatorPlace({ root, planId, s, name, prev, running, place }) {
    let inPlaceOf = place.inPlaceOf ?? null;
    // the pane it replaces: herdr restored a bare agent there, under the coordinator's name
    if (inPlaceOf && running?.handle === inPlaceOf) running = null;
    // the shell left where it ran before (the human quit the agent): it starts there, when
    // asked to (the human confirmed closing that pane)
    const leftover = running || inPlaceOf ? null : leftoverPane(root, planId);
    if (leftover && place.reusePane) inPlaceOf = leftover;
    const actor = s.actors[name];
    const workspace = place.workspace || (inPlaceOf ? null : planWorkspace(root, [prev?.plan === planId && prev.workspace, actor && sameServer(actor) && actor.ctx?.herdr_workspace]));
    return { running, leftover, inPlaceOf, workspace };
  },
};

// ---------- the adapter's API, bound to herdr ----------
const B = herdrBackend;
export const agentKinds = () => core.agentKinds(B);
export const lifecycle = () => core.lifecycle(B);
export const stateDir = pluginStateDir;
export const readRegistry = () => core.readRegistry(B);
export const updateRegistry = (fn) => core.updateRegistry(B, fn);
export const recordSession = (...a) => core.recordSession(B, ...a);
export const launchAgent = ({ refPane, direction, workspace, placement, ...o }) => core.launchAgent({ backend: B, ...o, place: { refPane, direction, workspace, placement } });
export const launchCoordinator = ({ workspace, inPlaceOf, reusePane, ...o }) => core.launchCoordinator({ backend: B, ...o, place: { workspace, inPlaceOf, reusePane } });
export const launchNewCoordinator = ({ pane, ...o }) => core.launchNewCoordinator({ backend: B, ...o, place: { pane } });
export const newCoordinatorEnv = (root, kind) => core.newCoordinatorEnv(B, root, kind);
export const linkNewPlan = (...a) => core.linkNewPlan(B, ...a);
export const recordSessionsForEvents = (...a) => core.recordSessionsForEvents(B, ...a);
export const lifecycleSweep = (root) => core.lifecycleSweep(B, root);

/**
 * The pane a plan's coordinator last ran in, when it is now a bare shell (the human quit
 * the agent, the pane stayed): still named after it, nothing running. Null otherwise.
 */
export function leftoverPane(root, planId) {
  const s = loadPlan(root, planId);
  const name = s.coordinator || resolveActor().id;
  const prev = readRegistry()[core.regKey(root, name)];
  if (prev?.plan !== planId || !prev.pane || (prev.socket && prev.socket !== currentSocket())) return null;
  const p = (herdr(['pane', 'list'])?.panes || []).find((x) => x.pane_id === prev.pane);
  return p && !p.agent && p.label === name ? p.pane_id : null;
}
