// ATF core: event schema constants + pure fold (events -> plan state).
// No I/O here, so frontends (browser, TUI, herdr plugin) can import it directly.

export const PROTOCOL_VERSION = 1;

export const PLAN_STATUSES = ['active', 'paused', 'completed', 'failed', 'cancelled'];
export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'review', 'done', 'failed', 'cancelled'];
export const TERMINAL = new Set(['done', 'failed', 'cancelled']);
export const NOTE_KINDS = ['info', 'question', 'decision', 'warning', 'checkpoint'];
export const RESUME_POLICIES = ['auto', 'resume', 'fresh'];
export const ARTIFACT_KINDS = ['file', 'commit', 'branch', 'pr', 'url', 'other'];

// Allowed task status transitions (enforced by writers, NOT by fold).
export const TRANSITIONS = {
  todo: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['todo', 'blocked', 'review', 'done', 'failed', 'cancelled'],
  blocked: ['todo', 'in_progress', 'failed', 'cancelled'],
  review: ['in_progress', 'done', 'failed', 'cancelled'],
  done: ['todo'], // reopen
  failed: ['todo', 'cancelled'], // retry
  cancelled: ['todo'],
};

export function canTransition(from, to) {
  return from === to ? false : (TRANSITIONS[from] || []).includes(to);
}

const TASK_FIELDS = ['title', 'description', 'acceptance', 'deps', 'parent', 'labels', 'priority', 'meta', 'resume'];
const PLAN_FIELDS = ['title', 'goal', 'description', 'labels', 'meta', 'resume'];

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
    resume: null, // per-task resume policy (overrides the plan's)
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
          Object.assign(plan, pick(d, PLAN_FIELDS));
          break;
        case 'plan.updated':
          Object.assign(plan, pick(d, PLAN_FIELDS));
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
    const entry = { seq: ev.seq, ts: ev.ts, actor: ev.actor?.id ?? null };

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
        // `on`: tasks this one is blocked on (a dependency discovered mid-task)
        t.blocked_on = d.status === 'blocked' && Array.isArray(d.on) ? d.on : [];
        t.blocked_seq = d.status === 'blocked' ? ev.seq : null;
        t.history.push({ ...entry, type: 'status', from, to: d.status, message: d.message ?? null });
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
  for (const t of Object.values(tasks)) t.children = [];
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
    t.rollup_status = rollupStatus(t.children.map((c) => tasks[c].rollup_status ?? tasks[c].status));
    return t.rollup_percent;
  };
  for (const t of Object.values(tasks)) {
    delete t.rollup_status;
    delete t.rollup_percent;
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
    // a question-block is "answered" once someone other than the owner adds a note after it
    t.answered = t.status === 'blocked' && !t.blocked_on.length && t.notes.some((n) => n.seq > (t.blocked_seq ?? Infinity) && n.actor && n.actor !== t.owner);
    t.resume_policy = t.resume ?? plan.resume ?? 'auto';
  }
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
  }
  return plan;
}

/**
 * What needs this actor right now (level-triggered, so it can't be missed):
 *  - for the owner: ready leaves, and blocked tasks whose `blocked_on` tasks are now done
 *  - for coordinators: tasks in review, and blocked tasks that need a decision
 *    (blocked without `on`, i.e. a question/problem rather than a dependency)
 * Returns [{task, reason}] in plan order.
 */
export function attentionFor(plan, actorId, role) {
  const out = [];
  for (const id of plan.order) {
    const t = plan.tasks[id];
    if (t.children.length) continue;
    if (t.owner === actorId) {
      if (t.ready) out.push({ task: id, reason: 'ready' });
      else if (t.can_resume) out.push({ task: id, reason: 'unblocked' });
      else if (t.answered) out.push({ task: id, reason: 'answered' });
    }
    if (role === 'coordinator') {
      if (t.status === 'review') out.push({ task: id, reason: 'review' });
      else if (t.status === 'blocked' && !t.blocked_on.length) out.push({ task: id, reason: 'blocked' });
    }
  }
  return out;
}

/**
 * What in this plan needs the human driving the agents (as opposed to an agent):
 * tasks in review, question-blocks (blocked without `on`), failed tasks, and a plan
 * whose work is all finished but which is still open. Oldest first.
 * Harness-specific signals (e.g. stalled agents) are added by frontends.
 */
export function driverInbox(plan) {
  const items = [];
  const since = (t, status) => [...t.history].reverse().find((h) => h.type === 'status' && h.to === status)?.ts ?? t.updated_at;
  for (const id of plan.order) {
    const t = plan.tasks[id];
    if (t.children.length) continue;
    if (t.status === 'review') items.push({ kind: 'review', task: id, ts: since(t, 'review'), actor: t.owner, message: t.last_message });
    else if (t.status === 'blocked' && !t.blocked_on.length && !t.answered) items.push({ kind: 'question', task: id, ts: since(t, 'blocked'), actor: t.owner, message: t.last_message });
    else if (t.status === 'failed') items.push({ kind: 'failed', task: id, ts: since(t, 'failed'), actor: t.owner, message: t.last_message });
  }
  const leaves = plan.order.filter((id) => !plan.tasks[id].children.length);
  if (plan.status === 'active' && leaves.length && leaves.every((id) => TERMINAL.has(plan.tasks[id].status)))
    items.push({ kind: 'finished', task: null, ts: plan.updated_at, actor: null, message: 'all tasks finished; close the plan' });
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
 * Rule: context belongs to the task. A task that was already worked on (blocked,
 * answered, reopened after review) resumes the session that worked on it; a task
 * never started gets a fresh agent. Policies: 'auto' (that rule), 'resume'
 * (always resume if a session exists), 'fresh' (never). Without a session reference
 * the answer is always fresh; the checkpoint note then carries the state.
 * Pure and harness-independent: launchers decide *how* to resume.
 */
export function launchPlan(plan, taskId, actorId = null) {
  const t = plan.tasks[taskId];
  if (!t) return null;
  const policy = t.resume_policy ?? t.resume ?? plan.resume ?? 'auto';
  const session = (actorId && t.sessions[actorId]) || t.session || null;
  const worked = !!t.started_at;
  let mode = 'fresh';
  let reason = 'task not started yet';
  if (policy === 'fresh') reason = 'policy: fresh';
  else if (!session) reason = worked ? 'no session reference recorded; continue from checkpoint/notes' : reason;
  else if (policy === 'resume' || worked) (mode = 'resume'), (reason = policy === 'resume' ? 'policy: resume' : 'task was already worked on');
  return { mode, session: mode === 'resume' ? session : null, checkpoint: t.checkpoint, policy, reason, worked };
}

/** Status of a parent task derived from its children's (effective) statuses. */
export function rollupStatus(ss) {
  if (!ss.length) return 'todo';
  if (ss.every((s) => s === 'cancelled')) return 'cancelled';
  if (ss.every((s) => s === 'done' || s === 'cancelled')) return 'done';
  if (ss.includes('failed')) return 'failed';
  if (ss.includes('blocked')) return 'blocked';
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
