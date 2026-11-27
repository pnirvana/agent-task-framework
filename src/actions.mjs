// The human's actions, as every frontend writes them (the herdr board, the web UI): the
// same events through the same transaction, so what the coordinator sees does not depend
// on where the human clicked. v2 (SPEC §12): what the human writes goes to the
// coordinator, which decides; only approving a review and finishing the human's own
// tasks take effect directly.
import { HUMAN, TERMINAL } from './core.mjs';
import { transact, resolveActor, reviewEvents, loadPlan } from './store.mjs';

/** The human's identity for writes (frontends write as the human, never as an agent). */
export const humanActor = () => resolveActor({ id: HUMAN, role: 'human' });

export const ACTIONS = ['approve', 'changes', 'note', 'plan-note', 'finish', 'close-plan'];

/**
 * Do `action` on plan `planId` as the human. Returns {ok, message} (message: what to tell
 * the human); throws on errors from the store (lock, unknown plan).
 *   approve    {task, message?}  a task in review: done
 *   changes    {task, message}   a change request on a task, for the coordinator
 *   note       {task, message}   an answer (a question) or a message on a task, for the coordinator
 *   plan-note  {message}         on the plan (answers the plan's questions), for the coordinator
 *   finish     {task, message?}  a task of the human's own: done (what waited on it can start)
 *   close-plan {message?, status?}  completed (default), failed or cancelled
 */
export function humanAction(root, planId, action, opts = {}, actor = humanActor()) {
  const text = String(opts.message ?? '').trim();
  const st = loadPlan(root, planId);
  const task = opts.task ? st.tasks[opts.task] : null;
  const needTask = () => {
    if (!task) throw new Error(opts.task ? `unknown task ${opts.task}` : 'which task?');
    return task;
  };
  const write = (events, message) => {
    transact(root, planId, actor, () => events);
    return { ok: true, message };
  };
  switch (action) {
    case 'approve':
    case 'changes': {
      const t = needTask();
      if (action === 'approve' && t.status !== 'review') return { ok: false, message: `${t.id} is not in review` };
      if (action === 'changes' && !text) return { ok: false, message: 'what should change?' };
      let res;
      transact(root, planId, actor, (s) => {
        res = reviewEvents(s, [{ task: t.id, action: action === 'approve' ? 'approve' : 'change', message: text }], actor);
        return res.events;
      });
      if (res.refused.length) return { ok: false, message: `not sent: ${res.refused[0].why}` };
      return { ok: true, message: action === 'approve' ? `approved ${t.id}: done` : `change request for ${t.id} sent to the coordinator (it decides what happens)` };
    }
    case 'note': {
      const t = needTask();
      if (!text) return { ok: false, message: 'nothing to send' };
      const question = t.status === 'blocked' && !t.blocked_on.length;
      return write([{ type: 'task.note', task: t.id, data: { message: text, kind: 'info' } }], `${question ? 'answer' : 'message'} on ${t.id} sent to the coordinator`);
    }
    case 'plan-note':
      if (!text) return { ok: false, message: 'nothing to send' };
      return write([{ type: 'plan.note', data: { message: text, kind: 'info' } }], `sent to the coordinator of "${st.title}"`);
    case 'finish': {
      const t = needTask();
      if (TERMINAL.has(t.status)) return { ok: false, message: `${t.id} is already ${t.status}` };
      const evs = [];
      if (t.status === 'todo' || t.status === 'blocked') evs.push({ type: 'task.status', task: t.id, data: { status: 'in_progress' } });
      evs.push({ type: 'task.status', task: t.id, data: { status: 'done', message: text || 'done' } });
      const waited = st.order.some((x) => st.tasks[x].waiting_on?.includes(t.id));
      return write(evs, `${t.id} done${waited ? ': what waited on it can start' : ''}`);
    }
    case 'close-plan': {
      const status = opts.status || 'completed';
      if (!['completed', 'failed', 'cancelled'].includes(status)) return { ok: false, message: `a plan closes as completed, failed or cancelled, not ${status}` };
      if (!['active', 'paused'].includes(st.status)) return { ok: false, message: `${st.title} is already ${st.status}` };
      return write([{ type: 'plan.status', data: { status, message: text || 'closed by the human' } }], `closed "${st.title}"`);
    }
    default:
      throw new Error(`unknown action ${action} (${ACTIONS.join(', ')})`);
  }
}
