// What needs the human, per plan: every frontend's "needs you" and the notifications read
// it from here, so they always agree. The plan's events say what waits for whom; whether
// agents run, and what they do, comes from the frontend's liveness source (herdr, ATF's
// session daemon), passed in as `lv`:
//
//   lv.known             is liveness available at all (false: no herdr, no sessions)
//   lv.local(actor)      can this actor's agent be seen and controlled from here? (an
//                        actor in another herdr session, on another machine: no)
//   lv.agent(st, id)     the running agent of actor `id` in plan `st`, or null:
//                        { status: 'working'|'idle'|'blocked'|'done', since: ms epoch,
//                          handle: what the backend controls it by (herdr pane, session id),
//                          ...backend fields }
//
// `blocked` means the agent waits for the human in its own terminal (a tool approval, a
// question in its prompt); `idle`/`done` that it finished its turn.
import { TERMINAL, driverInbox, humanTasks, HUMAN } from './core.mjs';
import { hasLiveWaiter } from './store.mjs';

export const STALE_MS = 90_000; // task in_progress but its agent idle for this long => flag
export const WAITING_MS = 8000; // coordinator idle this long while its plan is active => waits for you

/** No liveness source: nothing is known to run, every actor counts as local. */
export const NO_LIVENESS = { known: false, local: () => true, agent: () => null };

const idle = (a) => ['idle', 'done'].includes(a?.status);

/** Does this actor run where we cannot see or control it (another herdr session, machine)? */
export const elsewhere = (lv, st, who) => !!st.actors[who] && !lv.local(st.actors[who]);

/** The running agent of an actor in plan `st` (only for actors seen from here). */
export function liveAgent(lv, st, actorId) {
  if (!actorId) return null;
  const actor = st.actors[actorId];
  if (actor && !lv.local(actor)) return null;
  return lv.agent(st, actorId) || null;
}

/** The agent working on task `t`, flagged `stale` when it idles with the task in progress. */
export function agentFor(lv, st, t) {
  const a = liveAgent(lv, st, t?.owner);
  if (!a) return null;
  const stale = t.status === 'in_progress' && idle(a) && Date.now() - a.since > STALE_MS;
  return { ...a, stale };
}

export function coordinatorOf(lv, st) {
  const id = st.coordinator || Object.values(st.actors).find((a) => a.role === 'coordinator')?.id || null;
  return { id, live: id ? liveAgent(lv, st, id) : null, away: !!id && elsewhere(lv, st, id) };
}

/** driverInbox plus stalled agents (needs liveness). p: {root, id, st}. */
export function inboxOf(lv, p) {
  const items = driverInbox(p.st).map((it) => ({ ...it, root: p.root, plan: p.id, st: p.st }));
  for (const tid of p.st.order) {
    const t = p.st.tasks[tid];
    if (t.status !== 'in_progress' || t.children.length || !t.owner) continue;
    const a = agentFor(lv, p.st, t);
    if (a?.stale) items.push({ kind: 'stale', task: tid, ts: new Date(a.since).toISOString(), actor: t.owner, message: `${t.owner} idle, task still in progress`, root: p.root, plan: p.id, st: p.st });
  }
  return items;
}

/**
 * A plan's attention items, split into what needs the human (`mine`) and what its live
 * coordinator handles (`queued`), plus the human's own tasks (`todos`). Without liveness
 * nothing is known to run: all of it is the human's. p: {root, id, st, key}.
 */
export function attentionOf(lv, p) {
  const st = p.st;
  const mine = [];
  const queued = [];
  const at = (x) => ({ ...x, root: p.root, plan: p.id, st, key: p.key });
  const coord = coordinatorOf(lv, st);
  // an agent waiting for the human in its own terminal (an approval, a question)
  for (const a of Object.values(st.actors)) {
    const la = liveAgent(lv, st, a.id);
    if (la?.status !== 'blocked') continue;
    const t = st.order.map((id) => st.tasks[id]).find((x) => x.owner === a.id && x.status === 'in_progress' && !x.children.length);
    mine.push(at({ kind: 'prompt', actor: a.id, pane: la.handle, task: t?.id ?? null, ts: new Date(la.since).toISOString() }));
  }
  const handles = (!!coord.live && coord.live.status !== 'blocked') || coord.away;
  // nobody decides or starts anything for this plan: the human must start a coordinator
  const openWork = st.order.some((id) => !st.tasks[id].children.length && !TERMINAL.has(st.tasks[id].status));
  if (lv.known && st.status === 'active' && openWork && !coord.live && !coord.away) mine.push(at({ kind: 'no-coordinator', actor: null, task: null, ts: st.updated_at }));
  const finished = st.order.some((id) => !st.tasks[id].children.length) && st.order.every((id) => st.tasks[id].children.length || TERMINAL.has(st.tasks[id].status));
  // an idle coordinator waits for the human, unless its harness wakes it (a live `atf wait
  // --new` waiter: the pi extension, Copilot): then idling is how it waits for the plan
  if (st.status === 'active' && !finished && coord.live && idle(coord.live) && Date.now() - coord.live.since > WAITING_MS && !hasLiveWaiter(p.root, p.id, coord.id))
    mine.push(at({ kind: 'coordinator', actor: coord.id, pane: coord.live.handle, task: null, ts: new Date(coord.live.since).toISOString() }));
  for (const it of inboxOf(lv, p)) {
    // items for the human, and the coordinator's own when no coordinator handles them
    const human = it.for === HUMAN || !handles;
    (human ? mine : queued).push(at(it));
  }
  // the human's own tasks: listed apart from what needs them now (and notified once)
  const todos = humanTasks(st).map(at);
  return { mine, queued, coord, todos };
}
