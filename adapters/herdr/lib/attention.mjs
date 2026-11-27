// herdr as the liveness source of src/attention.mjs (what needs the human). The board and
// the notifications (notify.mjs) call these with herdr's agent index:
// `raw` = {agents: agentIndex() map, sinceOf(pane) -> ms since that pane's agent has its status}.
import * as core from '../../../src/attention.mjs';
import { sameServer, inProject, inHerdr } from './herdr.mjs';

export { STALE_MS, WAITING_MS } from '../../../src/attention.mjs';

/** herdr's agents as a liveness source: `status` and `handle` (the pane) on herdr's agent object. */
export function herdrLiveness(raw) {
  if (raw?.agent) return raw; // already one
  return {
    known: inHerdr(),
    local: sameServer,
    agent(st, actorId) {
      const actor = st.actors[actorId];
      // names repeat across projects (every project may have a "coordinator"): an agent
      // working in another project's directory is not this plan's
      const here = (x) => !!x && inProject(x, st.root);
      const byPane = actor?.ctx?.herdr_pane && raw.agents.get(`pane:${actor.ctx.herdr_pane}`);
      const a = [byPane, ...(raw.agents.get(`names:${actorId}`) || [])].find(here);
      if (!a) return null;
      return { ...a, status: a.agent_status, handle: a.pane_id, since: raw.sinceOf(a.pane_id) ?? Date.now() };
    },
  };
}

/** Does this actor run in another herdr session (server)? */
export const elsewhere = (st, who) => !!st.actors[who] && !sameServer(st.actors[who]);
export const liveAgent = (raw, st, actorId) => core.liveAgent(herdrLiveness(raw), st, actorId);
export const agentFor = (raw, st, t) => core.agentFor(herdrLiveness(raw), st, t);
export const coordinatorOf = (raw, st) => core.coordinatorOf(herdrLiveness(raw), st);
export const inboxOf = (raw, p) => core.inboxOf(herdrLiveness(raw), p);
export const attentionOf = (raw, p) => core.attentionOf(herdrLiveness(raw), p);
