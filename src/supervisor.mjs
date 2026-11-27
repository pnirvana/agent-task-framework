// The supervisor (docs/webui-design.md §4.3): what atf-herdr's hook and delayed sweeps do
// inside herdr, for a backend without them (sessions). It runs in a long-lived process
// (the web server, or `atf-sessions supervise`) whether or not anyone watches:
//   - new events of plans with agents of this backend: file the agents' harness sessions
//     on the tasks they worked on, tie a new plan to the coordinator that created it;
//   - the lifecycle sweep (src/launch.mjs): close subagents that finished, nudge an idle
//     coordinator that has something to handle, report a plan without a coordinator;
//   - forget subagent sessions that exited by themselves a while ago.
import { listPlanIds, readEvents } from './store.mjs';
import { lifecycleSweep, recordSessionsForEvents, linkNewPlan, readRegistry } from './launch.mjs';

const EXITED_KEEP_MS = 5 * 60_000;

/**
 * One pass. `seen` (Map "root#plan" -> event count) carries what earlier passes read;
 * plans it has not seen yet are taken as they are (their history is not replayed).
 * Returns {actions: [string]}.
 */
export function superviseOnce(backend, seen = new Map(), { sessions = null } = {}) {
  const actions = [];
  const list = sessions ?? (backend.sessions ? backend.sessions() : []);
  const roots = new Set([...list.map((x) => x.meta?.root), ...Object.values(readRegistry(backend)).map((r) => r.root)].filter(Boolean));
  for (const root of roots) {
    try {
      for (const planId of listPlanIds(root)) {
        const key = `${root}#${planId}`;
        const events = readEvents(root, planId);
        const before = seen.get(key);
        seen.set(key, events.length);
        if (before == null || events.length <= before) continue;
        const fresh = events.slice(before);
        linkNewPlan(backend, root, planId, fresh);
        recordSessionsForEvents(backend, root, planId, fresh);
      }
      const r = lifecycleSweep(backend, root);
      actions.push(...r.actions);
    } catch (e) {
      actions.push(`error in ${root}: ${e.message}`);
    }
  }
  // a subagent that ended by itself: its session is kept a while (its last screen), then dropped
  for (const x of list) {
    if (x.exited && x.meta?.role === 'subagent' && Date.now() - x.lastOutput > EXITED_KEEP_MS) {
      backend.close(x.id);
      actions.push(`removed exited session of ${x.meta.name}`);
    }
  }
  return { actions };
}

/** Run superviseOnce every `intervalMs` until stopped: returns stop(). */
export function startSupervisor(backend, { intervalMs = 5000, onActions = () => {}, onError = () => {} } = {}) {
  const seen = new Map();
  let timer = null,
    stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      const { actions } = superviseOnce(backend, seen);
      if (actions.length) onActions(actions);
    } catch (e) {
      onError(e);
    }
    timer = setTimeout(tick, intervalMs);
  };
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
