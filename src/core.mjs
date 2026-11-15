// ATF core: event schema constants + pure fold (events -> plan state).
// No I/O here, so frontends (browser, TUI, herdr plugin) can import it directly.

export const PROTOCOL_VERSION = 1;

/**
 * The person driving the agents acts as this actor (the board does; on the command line
 * `--as human`), so their writes are never mistaken for the coordinator's: a coordinator
 * started by hand defaults to the user's name too, and a wait skips the actor's own events.
 */
export const HUMAN = 'human';

/**
 * Relayed decisions (§13.3): the human said it in the coordinator's chat and the
 * coordinator recorded it. `data.relayed = {from, quote, via}`; the event's actor stays
 * the coordinator. Folded entries carry `relayed`, and count as the human's decision.
 */
const relayOf = (d) => (d?.relayed?.from ? { relayed: { from: d.relayed.from, quote: d.relayed.quote ?? '', via: d.relayed.via ?? 'chat' } } : {});
/** Did the human make this note / decision (directly, or relayed by the coordinator)? */
export const byHuman = (n) => n?.actor === HUMAN || n?.relayed?.from === HUMAN;
export const PLAN_STATUSES = ['active', 'paused', 'completed', 'failed', 'cancelled'];
export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'review', 'done', 'failed', 'cancelled'];
export const TERMINAL = new Set(['done', 'failed', 'cancelled']);
export const NOTE_KINDS = ['info', 'question', 'decision', 'warning', 'checkpoint', 'feedback'];
export const RESUME_POLICIES = ['auto', 'resume', 'fresh'];
export const ARTIFACT_KINDS = ['file', 'commit', 'branch', 'pr', 'url', 'other'];

// Allowed task status transitions (enforced by writers, NOT by fold).
export const TRANSITIONS = {
  todo: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['todo', 'blocked', 'review', 'done', 'failed', 'cancelled'],
  blocked: ['todo', 'in_progress', 'failed', 'cancelled'],
  review: ['todo', 'in_progress', 'done', 'failed', 'cancelled'], // todo: changes requested
  done: ['todo'], // reopen
  failed: ['todo', 'cancelled'], // retry
  cancelled: ['todo'],
};

export function canTransition(from, to) {
  return from === to ? false : (TRANSITIONS[from] || []).includes(to);
}

const TASK_FIELDS = ['title', 'description', 'acceptance', 'deps', 'parent', 'labels', 'priority', 'meta', 'resume', 'agent', 'origin', 'reviewer', 'review'];
const PLAN_FIELDS = ['title', 'goal', 'description', 'labels', 'meta', 'resume', 'coordinator', 'docs'];
/** Who a question-block is for: the coordinator (default) or the human (an escalation). */
export const BLOCK_FOR = ['coordinator', 'human'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function newTask(id, ev) {
  return {
    id,
    title: '',
    description: '',
    acceptance: [],
    deps: [],
    parent: null,
    labels: [],
    priority: 0,
    meta: {},
    status: 'todo',
    blocked_on: [],
    blocked_seq: null,
    blocked_for: null, // question-blocks: who must answer, 'coordinator' or 'human'
    recommend: null, // the coordinator's recommendation on a question for the human
    resume: null, // per-task resume policy (overrides the plan's)
    agent: null, // name of the agent definition to run this task with (opaque; launchers resolve it)
    origin: null, // task this one is a follow-up of (scope found while reviewing it)
    reviewer: null, // who must review it: null/'coordinator' (default) or e.g. 'human'
    review: false, // must go through review before done (implied by a reviewer)
    fresh_next: false, // the next attempt starts with a fresh agent (changes --fresh)
    feedback: [], // change requests: [{round, seq, ts, actor, message}]
    changes_requested: false, // sent back with requested changes, not yet resubmitted
    checkpoint: null, // latest checkpoint note: where the work stands
    sessions: {}, // actor -> {kind, ref, ts}: opaque harness session references
    session: null, // latest session reference
    assignee: null,
    percent: null,
    last_message: null,
    notes: [],
    artifacts: [],
    history: [],
    created_at: ev.ts,
    created_by: ev.actor?.id ?? null,
    updated_at: ev.ts,
    started_at: null,
    finished_at: null,
  };
}

/**
 * Fold an ordered list of events into plan state.
 * Lenient by design: unknown event types are ignored, events for unknown
 * tasks are reported in `warnings` and skipped. Never throws on bad data.
 */
export function fold(events) {
  const plan = {
    id: null,
    title: '',
    goal: '',
    description: '',
    labels: [],
    meta: {},
    status: 'active',
    created_at: null,
    updated_at: null,
    tasks: {},
    order: [],
    actors: {},
    reviews: [], // submitted batch reviews: [{seq, ts, actor, summary, items}]
    docs: [], // the plan's documents (design.md, plan.md, …): paths relative to the project
    notes: [], // plan-level notes: [{seq, ts, actor, kind, message, for}]
    checkpoint: null, // latest plan-level checkpoint: where the plan stands (coordinator handoff)
    session: null, // the coordinator's session {kind, ref, actor, ts}: resume the plan
    last_seq: 0,
    warnings: [],
  };

  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || !ev.type) continue;
    if (typeof ev.seq === 'number') plan.last_seq = Math.max(plan.last_seq, ev.seq);
    plan.updated_at = ev.ts ?? plan.updated_at;
    if (ev.actor?.id) {
      const a = (plan.actors[ev.actor.id] ??= { id: ev.actor.id, first_seen: ev.ts });
      Object.assign(a, pick(ev.actor, ['role', 'harness', 'ctx']), { last_seen: ev.ts });
    }
    const d = ev.data || {};

    if (ev.type.startsWith('plan.')) {
      switch (ev.type) {
        case 'plan.created':
          plan.id = ev.plan;
          plan.created_at = ev.ts;
          plan.created_by = ev.actor?.id ?? null;
          plan.coordinator = ev.actor?.id ?? null; // whoever creates a plan coordinates it unless named otherwise
          Object.assign(plan, pick(d, PLAN_FIELDS));
          break;
        case 'plan.updated':
          Object.assign(plan, pick(d, PLAN_FIELDS));
          break;
        case 'plan.note': {
          const n = { seq: ev.seq, ts: ev.ts, actor: ev.actor?.id ?? null, kind: d.kind || 'info', message: d.message ?? '', for: d.for ?? null, ...relayOf(d) };
          plan.notes.push(n);
          if (n.kind === 'checkpoint') plan.checkpoint = n;
          break;
        }
        case 'plan.session':
          if (d.ref) plan.session = { kind: d.kind ?? null, ref: d.ref, actor: d.actor ?? ev.actor?.id ?? null, ts: ev.ts };
          break;
        case 'plan.review':
          // one submitted review (a batch of approvals / change requests / notes)
          plan.reviews.push({ seq: ev.seq, ts: ev.ts, actor: ev.actor?.id ?? null, summary: d.summary ?? '', items: d.items ?? [] });
          break;
        case 'plan.status':
          if (PLAN_STATUSES.includes(d.status)) {
            plan.status = d.status;
            plan.status_message = d.message ?? null;
          }
          break;
      }
      continue;
    }

    if (!ev.type.startsWith('task.')) continue; // x.* and future types: ignore
    const id = ev.task;
    if (ev.type === 'task.created') {
      if (plan.tasks[id]) {
        plan.warnings.push(`seq ${ev.seq}: duplicate task.created for ${id}`);
        continue;
      }
      plan.tasks[id] = Object.assign(newTask(id, ev), pick(d, TASK_FIELDS));
      if (d.assignee) plan.tasks[id].assignee = d.assignee;
      plan.order.push(id);
      continue;
    }
    const t = plan.tasks[id];
    if (!t) {
      plan.warnings.push(`seq ${ev.seq}: ${ev.type} for unknown task ${id}`);
      continue;
    }
    t.updated_at = ev.ts;
    const entry = { seq: ev.seq, ts: ev.ts, actor: ev.actor?.id ?? null, ...relayOf(d) };

    switch (ev.type) {
      case 'task.updated':
        Object.assign(t, pick(d, TASK_FIELDS));
        break;
      case 'task.assigned':
        t.assignee = d.assignee ?? null;
        t.history.push({ ...entry, type: 'assigned', assignee: t.assignee });
        break;
      case 'task.status': {
        if (!TASK_STATUSES.includes(d.status)) break;
        const from = t.status;
        t.status = d.status;
        if (d.status === 'in_progress' && !t.started_at) t.started_at = ev.ts;
        if (TERMINAL.has(d.status)) t.finished_at = ev.ts;
        else t.finished_at = null;
        if (d.status === 'done') t.percent = 100;
        if (d.status === 'todo') t.percent = null;
        if (d.message) t.last_message = d.message;
        if (d.status === 'done' && d.message) t.result = d.message;
        else if (from === 'done') t.result = null; // reopened / sent back: no longer the result
        // `fresh`: the next attempt starts from a clean agent (one-shot, cleared on start)
        if (d.fresh) t.fresh_next = true;
        else if (d.status === 'in_progress') t.fresh_next = false;
        // `on`: tasks this one is blocked on (a dependency discovered mid-task)
        t.blocked_on = d.status === 'blocked' && Array.isArray(d.on) ? d.on : [];
        t.blocked_seq = d.status === 'blocked' ? ev.seq : null;
        t.blocked_for = d.status === 'blocked' && !t.blocked_on.length ? (d.for === 'human' ? 'human' : 'coordinator') : null;
        // the coordinator's view on a question it escalates to the human (§13.4)
        t.recommend = d.status === 'blocked' && d.recommend ? d.recommend : null;
        t.history.push({ ...entry, type: 'status', from, to: d.status, message: d.message ?? null, ...(d.changes ? { changes: true } : {}) });
        // "request changes": back to the owner with feedback (status todo, data.changes)
        if (d.changes) {
          t.feedback.push({ round: t.feedback.length + 1, ...entry, message: d.message ?? '' });
          t.changes_requested = true;
        } else if (['review', 'done', 'cancelled', 'failed'].includes(d.status)) t.changes_requested = false;
        break;
      }
      case 'task.progress':
        if (typeof d.percent === 'number') t.percent = Math.max(0, Math.min(100, d.percent));
        if (d.message) t.last_message = d.message;
        t.history.push({ ...entry, type: 'progress', percent: d.percent ?? null, message: d.message ?? null });
        break;
      case 'task.note':
        t.notes.push({ ...entry, kind: d.kind || 'info', message: d.message });
        if (d.kind === 'checkpoint') t.checkpoint = { ...entry, message: d.message };
        break;
      case 'task.session': {
        // Opaque reference to an agent session that worked on this task (e.g. a pi
        // session file or a claude session id). ATF stores it; only launchers read it.
        if (!d.ref) break;
        const who = d.actor ?? ev.actor?.id ?? null;
        const ref = { kind: d.kind ?? null, ref: d.ref, ts: ev.ts, actor: who };
        if (who) t.sessions[who] = ref;
        t.session = ref;
        break;
      }
      case 'task.artifact':
        t.artifacts.push({ ...entry, kind: d.kind || 'other', ref: d.ref, description: d.description ?? null });
        break;
    }
  }

  derive(plan);
  return plan;
}

/** Compute derived fields: readiness, children, counts, overall progress. */
export function derive(plan) {
  const tasks = plan.tasks;
  for (const t of Object.values(tasks)) (t.children = []), (t.followups = []);
  for (const id of plan.order) if (tasks[id].origin && tasks[tasks[id].origin]) tasks[tasks[id].origin].followups.push(id);
  for (const id of plan.order) {
    const t = tasks[id];
    if (t.parent && tasks[t.parent]) tasks[t.parent].children.push(id);
  }
  // Ancestry + ownership. Assigning a parent task hands its whole subtree (a "work
  // package") to that actor: descendants without their own assignee inherit `owner`.
  for (const t of Object.values(tasks)) {
    t.path = [];
    for (let p = t.parent, guard = 0; p && tasks[p] && guard < 32; p = tasks[p].parent, guard++) t.path.unshift(p);
    t.depth = t.path.length;
    t.owner = t.assignee ?? [...t.path].reverse().map((id) => tasks[id].assignee).find(Boolean) ?? null;
  }

  // Parent tasks are containers: their status/percent roll up from children.
  const leafPct = (t) => (t.status === 'done' ? 100 : t.status === 'cancelled' ? null : t.percent ?? 0);
  const rollup = (t) => {
    if (!t.children.length) return leafPct(t);
    const vals = t.children.map((c) => rollup(tasks[c])).filter((v) => v !== null);
    t.rollup_percent = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    // a child blocked `--on` other tasks is waiting, not stuck on a question (same for a
    // sub-package whose blocked rollup only comes from such waits)
    const kids = t.children.map((c) => {
      const k = tasks[c];
      return k.children.length ? { status: k.rollup_status, waiting: !!k.rollup_waiting } : { status: k.status, waiting: k.status === 'blocked' && k.blocked_on.length > 0 };
    });
    t.rollup_status = rollupStatus(kids);
    t.rollup_waiting = t.rollup_status === 'blocked' && !kids.some((k) => k.status === 'blocked' && !k.waiting);
    return t.rollup_percent;
  };
  for (const t of Object.values(tasks)) {
    delete t.rollup_status;
    delete t.rollup_percent;
    delete t.rollup_waiting;
  }
  for (const id of plan.order) if (!tasks[id].parent || !tasks[tasks[id].parent]) rollup(tasks[id]);

  // Counts and overall progress are over leaf tasks (units of work).
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0]));
  let leaves = 0;
  let doneLeaves = 0;
  for (const id of plan.order) {
    const t = tasks[id];
    if (t.children.length) continue;
    counts[t.status] = (counts[t.status] || 0) + 1;
    if (t.status !== 'cancelled') {
      leaves++;
      if (t.status === 'done') doneLeaves++;
    }
  }
  const eff = (t) => t.rollup_status ?? t.status;
  for (const t of Object.values(tasks)) {
    t.waiting_on = (t.deps || []).filter((d) => !tasks[d] || eff(tasks[d]) !== 'done');
    t.ready = t.status === 'todo' && t.waiting_on.length === 0 && t.children.length === 0;
  }
  for (const t of Object.values(tasks)) {
    t.can_resume = t.status === 'blocked' && t.blocked_on.length > 0 && t.blocked_on.every((d) => tasks[d] && eff(tasks[d]) === 'done');
    // a question-block is "answered" once someone other than the owner adds a note after
    // it; a block for the human only by the human
    t.answered =
      t.status === 'blocked' &&
      !t.blocked_on.length &&
      t.notes.some((n) => n.seq > (t.blocked_seq ?? Infinity) && n.actor && n.actor !== t.owner && n.kind !== 'checkpoint' && (t.blocked_for !== 'human' || byHuman(n)));
    // the human's input not yet handled by the coordinator: notes by the human after the
    // coordinator last wrote on the task (v2: the human talks to the coordinator)
    const coordLast = Math.max(0, ...t.history.filter((h) => h.actor === plan.coordinator).map((h) => h.seq), ...t.notes.filter((n) => n.actor === plan.coordinator).map((n) => n.seq));
    t.human_input = t.notes.filter((n) => n.actor === HUMAN && n.seq > coordLast && n.kind !== 'checkpoint');
    // v2: a new agent instance starts fresh unless resuming is asked for
    t.resume_policy = t.resume ?? plan.resume ?? 'fresh';
  }
  // plan level: open questions for the human, and the human's input for the coordinator
  const planCoordLast = Math.max(0, ...plan.notes.filter((n) => n.actor === plan.coordinator).map((n) => n.seq));
  plan.human_input = plan.notes.filter((n) => n.actor === HUMAN && n.seq > planCoordLast && n.kind !== 'checkpoint');
  plan.questions = plan.notes.filter((n, i) => n.kind === 'question' && n.for === 'human' && !plan.notes.slice(i + 1).some(byHuman));
  plan.counts = counts;
  plan.total = plan.order.length;
  plan.progress = leaves ? doneLeaves / leaves : 0;
  const open = (t) => !TERMINAL.has(t.rollup_status ?? t.status);
  // Make sure assignees that never wrote an event (assigned by the coordinator) are listed.
  for (const id of plan.order) {
    const who = tasks[id].assignee;
    if (who && !plan.actors[who]) plan.actors[who] = { id: who, first_seen: null, last_seen: null, inferred: true };
  }
  for (const a of Object.values(plan.actors)) {
    a.tasks = plan.order.filter((id) => tasks[id].assignee === a.id && !tasks[id].children.length && open(tasks[id]));
    a.packages = plan.order.filter((id) => tasks[id].assignee === a.id && tasks[id].children.length);
    a.owned = plan.order.filter((id) => tasks[id].owner === a.id && !tasks[id].children.length);
    // no role written yet (e.g. assigned but not started): derive one for display
    if (!a.role) {
      const role = plan.coordinator === a.id ? 'coordinator' : a.owned.length || a.packages.length || a.tasks.length ? 'subagent' : null;
      if (role) Object.assign(a, { role, role_inferred: true });
    }
  }
  return plan;
}

/**
 * What needs this actor right now (level-triggered, so it can't be missed):
 *  - for the owner: ready leaves, and blocked tasks whose `blocked_on` tasks are now done
 *  - for coordinators: ready tasks nobody owns (`dispatch`), tasks in review, blocked tasks
 *    that need its decision (blocked without `on` and not for the human), work waiting
 *    for an owner that has nothing in progress (`start`, `changes`, `unblocked`,
 *    `answered`: start a new agent instance), and the human's input on a task or on the
 *    plan (`human`; task null for the plan)
 * Returns [{task, reason}] in plan order.
 */
export function attentionFor(plan, actorId, role) {
  const out = [];
  // v2: subagents exit when they finish or block. An owner with nothing in progress has no
  // running agent (as far as ATF can tell); its work waits for the coordinator to start one.
  const busy = new Set(plan.order.filter((id) => plan.tasks[id].status === 'in_progress' && !plan.tasks[id].children.length).map((id) => plan.tasks[id].owner));
  for (const id of plan.order) {
    const t = plan.tasks[id];
    if (t.children.length) continue;
    if (t.owner === actorId) {
      if (t.ready) out.push({ task: id, reason: t.changes_requested ? 'changes' : 'ready' });
      else if (t.can_resume) out.push({ task: id, reason: 'unblocked' });
      else if (t.answered) out.push({ task: id, reason: 'answered' });
    }
    if (role === 'coordinator') {
      if (t.ready && !t.owner) out.push({ task: id, reason: 'dispatch' }); // ready, nobody to do it
      // tasks that ask a specific reviewer (e.g. the human) are not the coordinator's to approve
      if (t.status === 'review' && (!t.reviewer || t.reviewer === 'coordinator' || t.reviewer === actorId)) out.push({ task: id, reason: 'review' });
      else if (t.status === 'blocked' && !t.blocked_on.length && !t.answered && t.blocked_for !== 'human') out.push({ task: id, reason: 'blocked' });
      // work for an owner that is not working: start a new agent instance for it
      // (`changes`: sent back after review; `unblocked`: its dependencies are done;
      // `answered`: its question was answered; `start`: ready, e.g. next in a package)
      // (after the human's input on the task is handled: that comes first, as `human`)
      else if (t.owner && t.owner !== actorId && !busy.has(t.owner) && !t.human_input.length) {
        if (t.ready) out.push({ task: id, reason: t.changes_requested ? 'changes' : 'start' });
        else if (t.can_resume) out.push({ task: id, reason: 'unblocked' });
        else if (t.answered) out.push({ task: id, reason: 'answered' });
      }
    }
  }
  if (role === 'coordinator') {
    // the human's input (answers, change requests, remarks) on any task: the coordinator decides
    for (const id of plan.order) if (plan.tasks[id].human_input?.length) out.push({ task: id, reason: 'human' });
    if (plan.human_input?.length) out.push({ task: null, reason: 'human' });
  }
  return out;
}

/**
 * What in this plan needs a decision (as opposed to an agent's own work): tasks in
 * review, question-blocks (blocked without `on`), failed tasks, open plan questions for
 * the human, and a plan whose work is all finished but which is still open. Each item
 * says `for` whom: 'human' or 'coordinator' (or a named reviewer). Oldest first.
 * Harness-specific signals (e.g. stalled agents) are added by frontends.
 */
export function driverInbox(plan) {
  // `for`: who acts on the item. Frontends show the human's items as "needs you", and the
  // coordinator's too when no coordinator is running (else they would wait unseen).
  const items = [];
  const since = (t, status) => [...t.history].reverse().find((h) => h.type === 'status' && h.to === status)?.ts ?? t.updated_at;
  for (const id of plan.order) {
    const t = plan.tasks[id];
    if (t.children.length) continue;
    if (t.status === 'review') {
      const human = !!t.reviewer && t.reviewer !== 'coordinator';
      items.push({ kind: human ? 'your-review' : 'review', for: t.reviewer === HUMAN ? 'human' : human ? t.reviewer : 'coordinator', task: id, ts: since(t, 'review'), actor: t.owner, message: t.last_message, reviewer: t.reviewer });
    } else if (t.status === 'blocked' && !t.blocked_on.length && !t.answered) items.push({ kind: 'question', for: t.blocked_for ?? 'coordinator', task: id, ts: since(t, 'blocked'), actor: t.owner, message: t.last_message });
    else if (t.status === 'failed') items.push({ kind: 'failed', for: 'coordinator', task: id, ts: since(t, 'failed'), actor: t.owner, message: t.last_message });
  }
  for (const q of plan.questions ?? []) items.push({ kind: 'plan-question', for: 'human', task: null, ts: q.ts, actor: q.actor, message: q.message });
  const leaves = plan.order.filter((id) => !plan.tasks[id].children.length);
  if (plan.status === 'active' && leaves.length && leaves.every((id) => TERMINAL.has(plan.tasks[id].status)))
    items.push({ kind: 'finished', for: 'human', task: null, ts: plan.updated_at, actor: null, message: 'all tasks finished; close the plan' });
  return items.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
}

/** Compact per-plan summary for overviews. */
export function planSummary(plan) {
  const leaves = plan.order.map((id) => plan.tasks[id]).filter((t) => !t.children.length);
  const owners = new Set(leaves.filter((t) => !TERMINAL.has(t.status) && t.owner).map((t) => t.owner));
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    progress: plan.progress,
    counts: plan.counts,
    total: leaves.length,
    agents: [...owners],
    ready_unowned: leaves.filter((t) => t.ready && !t.owner).length,
    inbox: driverInbox(plan).length,
    updated_at: plan.updated_at,
  };
}

/**
 * Should the next agent for this task resume an earlier session or start fresh?
 * Policies: 'fresh' (the default: a new instance with a focused prompt; the checkpoint,
 * feedback and history carry the state), 'auto' (resume the session of a task that was
 * already worked on, fresh for one never started), 'resume' (always resume if a session
 * exists). Without a session reference the answer is always fresh.
 * Pure and harness-independent: launchers decide *how* to resume.
 */
export function launchPlan(plan, taskId, actorId = null) {
  const t = plan.tasks[taskId];
  if (!t) return null;
  const policy = t.fresh_next ? 'fresh' : t.resume_policy ?? t.resume ?? plan.resume ?? 'fresh';
  const session = (actorId && t.sessions[actorId]) || t.session || null;
  const worked = !!t.started_at;
  let mode = 'fresh';
  let reason = 'task not started yet';
  if (policy === 'fresh') reason = 'policy: fresh';
  else if (!session) reason = worked ? 'no session reference recorded; continue from checkpoint/notes' : reason;
  else if (policy === 'resume' || worked) (mode = 'resume'), (reason = policy === 'resume' ? 'policy: resume' : 'task was already worked on');
  return { mode, session: mode === 'resume' ? session : null, checkpoint: t.checkpoint, policy, reason, worked };
}

/**
 * May `actor` ({id, role}) decide on a review of task `t` (approve it, request changes,
 * reopen it)? A named reviewer decides alone ('human' = the actor "human", or any actor
 * with role human);
 * otherwise the coordinator, or the human. Returns null if allowed, else the reason.
 */
export function reviewRefusal(t, actor) {
  const named = t.reviewer && t.reviewer !== 'coordinator' ? t.reviewer : null;
  if (named) {
    if (actor.id === named || (named === 'human' && actor.role === 'human')) return null;
    return `${t.id} is reviewed by ${named}${named === 'human' ? ' (on the board, or `atf feedback approve|change … --as human`)' : ''}, not by ${actor.id}`;
  }
  if (actor.role === 'coordinator' || actor.role === 'human') return null;
  return `only the coordinator (or the human) reviews ${t.id}`;
}

/**
 * Role of an actor whose role was not given explicitly (no --role / $ATF_ROLE):
 * the plan's recorded coordinator is 'coordinator'; otherwise the role the actor used
 * in earlier events; otherwise 'agent'. Returns {role, source}.
 */
export function inferRole(plan, actorId) {
  if (actorId === HUMAN) return { role: 'human', source: 'the human (actor "human")' };
  if (plan?.coordinator && plan.coordinator === actorId) return { role: 'coordinator', source: 'recorded as this plan\'s coordinator' };
  const known = plan?.actors?.[actorId];
  const prev = known && !known.role_inferred ? known.role : null; // only roles the actor itself wrote
  if (prev && prev !== 'agent') return { role: prev, source: 'role used in earlier events of this plan' };
  return { role: 'agent', source: 'default (not the plan\'s coordinator, no ATF_ROLE)' };
}

/**
 * Status of a parent task derived from its children's (effective) statuses. Items are
 * statuses or {status, waiting}; `waiting` marks a child blocked on other tasks
 * (`block --on`) rather than on a question. Such a child counts as work in progress;
 * the parent is blocked only by a question-block, or when everything still open in it
 * is waiting.
 */
export function rollupStatus(items) {
  const xs = items.map((x) => (typeof x === 'string' ? { status: x, waiting: false } : x));
  const ss = xs.map((x) => x.status);
  if (!ss.length) return 'todo';
  if (ss.every((s) => s === 'cancelled')) return 'cancelled';
  if (ss.every((s) => s === 'done' || s === 'cancelled')) return 'done';
  if (ss.includes('failed')) return 'failed';
  if (xs.some((x) => x.status === 'blocked' && !x.waiting)) return 'blocked';
  const open = xs.filter((x) => !TERMINAL.has(x.status));
  if (open.length && open.every((x) => x.status === 'blocked')) return 'blocked'; // all of it waits
  if (ss.includes('blocked')) return 'in_progress'; // some of it waits, the rest goes on
  if (ss.every((s) => s === 'todo')) return 'todo';
  if (ss.every((s) => TERMINAL.has(s) || s === 'review')) return 'review';
  return 'in_progress';
}

/** Detect dependency cycles; returns array of cycles (each an array of ids). */
export function findCycles(plan) {
  const cycles = [];
  const state = {};
  const stack = [];
  const visit = (id) => {
    state[id] = 1;
    stack.push(id);
    for (const d of plan.tasks[id]?.deps || []) {
      if (!plan.tasks[d]) continue;
      if (state[d] === 1) cycles.push(stack.slice(stack.indexOf(d)).concat(d));
      else if (!state[d]) visit(d);
    }
    stack.pop();
    state[id] = 2;
  };
  for (const id of plan.order) if (!state[id]) visit(id);
  return cycles;
}

/**
 * Everything a human needs to act on one request (§13.5), from the plan alone: the
 * question with who originally asked and the coordinator's recommendation, or the
 * submitted review with its acceptance criteria, notes and artifacts. `taskId` null: the
 * plan's open questions. Frontends add harness data (e.g. changed lines from git).
 */
export function brief(plan, taskId = null) {
  if (!taskId)
    return { kind: 'plan', plan: plan.id, title: plan.title, goal: plan.goal ?? null, docs: plan.docs ?? [], questions: (plan.questions ?? []).map((q) => ({ ts: q.ts, actor: q.actor, message: q.message })), checkpoint: plan.checkpoint?.message ?? null };
  const t = plan.tasks[taskId];
  if (!t) return null;
  const item = driverInbox(plan).find((i) => i.task === taskId) ?? null;
  const lastTo = (status) => [...t.history].reverse().find((h) => h.type === 'status' && h.to === status) ?? null;
  const out = {
    kind: item?.kind ?? 'task',
    for: item?.for ?? null,
    plan: plan.id,
    task: { id: t.id, title: t.title, status: t.status, owner: t.owner ?? null, reviewer: t.reviewer ?? null, path: t.path.map((id) => plan.tasks[id]?.title ?? id), description: t.description ?? null, acceptance: t.acceptance ?? [] },
    artifacts: t.artifacts ?? [],
  };
  if (t.status === 'blocked' && !t.blocked_on.length) {
    const b = lastTo('blocked');
    // escalated by the coordinator: the question as the agent first asked it
    const orig = b?.actor === plan.coordinator ? [...t.history].reverse().find((h) => h.type === 'status' && h.to === 'blocked' && h.seq < b.seq && h.actor !== plan.coordinator) : null;
    out.question = { for: t.blocked_for, message: b?.message ?? t.last_message ?? null, asked_by: b?.actor ?? null, ts: b?.ts ?? null, recommend: t.recommend ?? null, original: orig ? { actor: orig.actor, message: orig.message, ts: orig.ts } : null };
  }
  if (t.status === 'review') {
    const r = lastTo('review');
    const started = lastTo('in_progress')?.seq ?? 0;
    out.review = {
      submitted: r ? { actor: r.actor, message: r.message, ts: r.ts } : null,
      notes: t.notes.filter((n) => n.seq > started && n.actor === r?.actor && n.kind !== 'checkpoint').slice(-3).map((n) => ({ kind: n.kind, message: n.message })),
      assessment: [...t.notes].reverse().find((n) => n.seq > (r?.seq ?? 0) && n.actor === plan.coordinator)?.message ?? null,
      round: t.feedback.length + 1,
    };
  }
  if (t.status === 'failed') out.failure = { message: lastTo('failed')?.message ?? t.last_message ?? null, actor: lastTo('failed')?.actor ?? null };
  return out;
}
