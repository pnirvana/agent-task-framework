// What needs the human, per plan: the board's "needs you" and the notifications (notify.mjs)
// read it from here, so both always agree. Liveness comes from herdr: `lv` is
// {agents: agentIndex() map, sinceOf(pane) -> ms since that pane's agent has its status}.
import { TERMINAL, driverInbox, HUMAN } from '../../../src/core.mjs';
import { hasLiveWaiter } from '../../../src/store.mjs';
import { sameServer, inProject, inHerdr } from './herdr.mjs';

export const STALE_MS = 90_000; // task in_progress but its herdr agent idle for this long => flag
export const WAITING_MS = 8000; // coordinator idle this long while its plan is active => waits for you

/** Does this actor run in another herdr session (server)? */
export const elsewhere = (st, who) => !!st.actors[who] && !sameServer(st.actors[who]);

/** Live herdr agent of an actor in plan `st` (only for actors of this herdr server). */
export function liveAgent(lv, st, actorId) {
  if (!actorId) return null;
  const actor = st.actors[actorId];
  if (actor && !sameServer(actor)) return null;
  // names repeat across projects (every project may have a "coordinator"): an agent
  // working in another project's directory is not this plan's
  const here = (x) => !!x && inProject(x, st.root);
  const byPane = actor?.ctx?.herdr_pane && lv.agents.get(`pane:${actor.ctx.herdr_pane}`);
  const a = [byPane, ...(lv.agents.get(`names:${actorId}`) || [])].find(here);
  if (!a) return null;
  return { ...a, since: lv.sinceOf(a.pane_id) ?? Date.now() };
}

export function agentFor(lv, st, t) {
  const a = liveAgent(lv, st, t?.owner);
  if (!a) return null;
  const stale = t.status === 'in_progress' && ['idle', 'done'].includes(a.agent_status) && Date.now() - a.since > STALE_MS;
  return { ...a, stale };
}

export function coordinatorOf(lv, st) {
  const id = st.coordinator || Object.values(st.actors).find((a) => a.role === 'coordinator')?.id || null;
  return { id, live: id ? liveAgent(lv, st, id) : null, away: !!id && elsewhere(st, id) };
}

/** driverInbox plus stalled agents (needs live herdr state). p: {root, id, st}. */
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
 * coordinator handles (`queued`). Without herdr there is no liveness: all of it is mine.
 * p: {root, id, st, key}.
 */
export function attentionOf(lv, p) {
  const st = p.st;
  const mine = [];
  const queued = [];
  const at = (x) => ({ ...x, root: p.root, plan: p.id, st, key: p.key });
  const coord = coordinatorOf(lv, st);
  for (const a of Object.values(st.actors)) {
    const la = liveAgent(lv, st, a.id);
    if (la?.agent_status !== 'blocked') continue;
    const t = st.order.map((id) => st.tasks[id]).find((x) => x.owner === a.id && x.status === 'in_progress' && !x.children.length);
    mine.push(at({ kind: 'prompt', actor: a.id, pane: la.pane_id, task: t?.id ?? null, ts: new Date(la.since).toISOString() }));
  }
  const handles = (!!coord.live && coord.live.agent_status !== 'blocked') || coord.away;
  // nobody decides or starts anything for this plan: the human must start a coordinator
  const openWork = st.order.some((id) => !st.tasks[id].children.length && !TERMINAL.has(st.tasks[id].status));
  if (inHerdr() && st.status === 'active' && openWork && !coord.live && !coord.away) mine.push(at({ kind: 'no-coordinator', actor: null, task: null, ts: st.updated_at }));
  const finished = st.order.some((id) => !st.tasks[id].children.length) && st.order.every((id) => st.tasks[id].children.length || TERMINAL.has(st.tasks[id].status));
  // an idle coordinator waits for the human, unless its harness wakes it (a live `atf wait
  // --new` waiter: the pi extension, Copilot): then idling is how it waits for the plan
  if (st.status === 'active' && !finished && coord.live && ['idle', 'done'].includes(coord.live.agent_status) && Date.now() - coord.live.since > WAITING_MS && !hasLiveWaiter(p.root, p.id, coord.id))
    mine.push(at({ kind: 'coordinator', actor: coord.id, pane: coord.live.pane_id, task: null, ts: new Date(coord.live.since).toISOString() }));
  for (const it of inboxOf(lv, p)) {
    // items for the human, and the coordinator's own when no coordinator handles them
    const human = it.for === HUMAN || !handles;
    (human ? mine : queued).push(at(it));
  }
  return { mine, queued, coord };
}
