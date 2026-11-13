#!/usr/bin/env node
// atf — reference CLI for the Agent Task Framework protocol.
import fs from 'node:fs';
import path from 'node:path';
import {
  TASK_STATUSES,
  PLAN_STATUSES,
  TERMINAL,
  NOTE_KINDS,
  ARTIFACT_KINDS,
  canTransition,
  findCycles,
  attentionFor,
  launchPlan,
  RESUME_POLICIES,
  driverInbox,
  planSummary,
} from '../src/core.mjs';
import {
  findRoot,
  initRoot,
  listPlanIds,
  getCurrentPlan,
  setCurrentPlan,
  loadPlan,
  readEvents,
  transact,
  resolveActor,
  newPlanId,
  eventsPath,
  knownRoots,
  registerRoot,
  projectName,
  skillStatus,
  SKILL_SRC,
} from '../src/store.mjs';

const HELP = `atf — Agent Task Framework

Setup / plans
  atf init                              create .atf/ in the current directory
  atf plan new <title> [--goal G] [--desc D]   create plan, make it current
  atf plan list | use <id>
  atf plan show [id]                    plan overview: structure, ownership, decisions, artifacts
  atf plan update [--title T] [--goal G] [--desc D] [--resume auto|resume|fresh]
  atf plan status <${PLAN_STATUSES.join('|')}> [-m msg]

Tasks (coordinator)
  atf add <title> [--desc D] [--accept A]... [--dep T1]... [--parent T1]
                  [--label L]... [--priority N] [--assign WHO] [--resume auto|resume|fresh]
                  [--agent NAME]   agent definition to run the task with (e.g. reviewer)
  atf edit <task> [same flags as add; --dep/--accept/--label replace lists]
  atf assign <task> <who|->            assign / unassign. Assigning a parent task hands the
                                        whole subtree (work package) to that agent

Tasks (worker)
  atf next [--package] [-m msg]         start next ready task: assigned to you, then inside your
                                        work packages, then unowned (--package: never unowned)
  atf start <task> [-m msg]             -> in_progress (claims it if unassigned)
  atf progress <task> <msg> [--pct N]   heartbeat / milestone
  atf note <task> <msg> [--kind ${NOTE_KINDS.join('|')}]
  atf artifact <task> <ref> [--kind ${ARTIFACT_KINDS.join('|')}] [--desc D]
  atf note <task> "<done / left / how to verify>" --kind checkpoint
                                        where the work stands (required before block)
  atf session <task> <ref> [--kind K] [--for WHO]
                                        record an agent session reference (for resuming)
  atf resume-info <task> [--for WHO]    resume or fresh? (used by launchers)
  atf block <task> -m <reason> [--on T8,T9]
                                        needs help / input. --on: blocked on other tasks;
                                        becomes resumable automatically when they are done
  atf review <task> -m <summary>        ready for coordinator review
  atf done <task> -m <summary>
  atf fail <task> -m <reason>
  atf cancel | reopen | release <task> [-m msg]

Viewing
  atf status [--watch]                  board summary (--watch: live-updating)
  atf list [--status S] [--ready] [--mine] [--assignee WHO]   (--mine includes your packages)
  atf show <task>
  atf log [-n N] [--follow]
  atf plans [--all] [--closed]          active plans in this project / all known projects
  atf inbox [--all]                     what needs you: reviews, questions, failures, finished plans
  atf projects [add [dir]]              known projects (registered on init / plan creation)
  atf skill [status|install|uninstall]  link the agent skill into ~/.agents/skills (and
                                        ~/.claude/skills) so agents discover it automatically
  atf wait [--timeout MS]               block until something needs YOU: ready/unblocked work in
                                        your packages, or (coordinator) reviews/blockers/finished tasks.
                                        Returns at once if something already does.
  atf wait --task T1,T2 [--status S,..] wait for specific tasks to reach a status
  atf validate

Global flags
  --plan ID     plan to act on      (default: $ATF_PLAN, then .atf/current)
  --as WHO      actor id            (default: $ATF_ACTOR, then $USER)
  --role R      actor role          (default: $ATF_ROLE, e.g. coordinator|subagent)
  --json        machine-readable output
  --force       bypass transition/ownership checks
`;

// ---------- args ----------
const BOOL = new Set(['json', 'force', 'follow', 'ready', 'mine', 'help', 'all', 'watch', 'package', 'closed']);
const MULTI = new Set(['accept', 'dep', 'label']);
const SHORT = { m: 'message', n: 'limit', h: 'help', j: 'json' };

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    let key = null;
    let val;
    if (a.startsWith('--')) {
      key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) [key, val] = [key.slice(0, eq), key.slice(eq + 1)];
    } else if (/^-[a-z]$/i.test(a)) {
      key = SHORT[a[1]] || a[1];
    } else {
      pos.push(a);
      continue;
    }
    if (BOOL.has(key)) {
      flags[key] = val === undefined ? true : val !== 'false';
      continue;
    }
    if (val === undefined) {
      if (i + 1 >= argv.length) die(`flag --${key} needs a value`);
      val = argv[++i];
    }
    if (MULTI.has(key)) (flags[key] ??= []).push(val);
    else flags[key] = val;
  }
  return { pos, flags };
}

// ---------- output helpers ----------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c(2), bold = c(1), red = c(31), green = c(32), yellow = c(33), blue = c(34), magenta = c(35), cyan = c(36);
const STATUS_STYLE = {
  todo: [dim, '○'],
  in_progress: [blue, '◐'],
  blocked: [red, '⊘'],
  review: [magenta, '◎'],
  done: [green, '●'],
  failed: [red, '✗'],
  cancelled: [dim, '–'],
};
const badge = (s) => {
  const [f, g] = STATUS_STYLE[s] || [String, '?'];
  return f(`${g} ${s}`);
};

class AtfError extends Error {}
// Throw (never exit) so locks held by transact() are always released.
function die(msg) {
  throw new AtfError(msg);
}
function report(msg) {
  if (FLAGS?.json) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  else process.stderr.write(`atf: ${msg}\n`);
  process.exit(1);
}
function out(json, human) {
  if (FLAGS.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
  else if (human !== undefined) process.stdout.write(human + (human.endsWith('\n') ? '' : '\n'));
}
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - Date.parse(ts)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// ---------- context ----------
/** Roots in scope: all known projects with --all, else the current one. */
function scopeRoots() {
  if (FLAGS.all) {
    const cur = findRoot();
    const roots = knownRoots();
    if (cur && !roots.includes(cur)) roots.unshift(cur);
    return roots;
  }
  const r = findRoot();
  if (!r) die('no .atf directory found (use --all for all known projects)');
  return [r];
}

let FLAGS;
function ctx({ needPlan = true } = {}) {
  const root = findRoot();
  if (!root) die('no .atf directory found (run `atf init`, or set ATF_DIR)');
  const planId = FLAGS.plan || getCurrentPlan(root);
  if (needPlan) {
    if (!planId) die('no current plan (use --plan, $ATF_PLAN, or `atf plan new`)');
    if (!fs.existsSync(eventsPath(root, planId))) die(`plan not found: ${planId}`);
  }
  const actor = resolveActor({ id: FLAGS.as, role: FLAGS.role });
  return { root, planId, actor };
}

function requireTask(state, id) {
  if (!id) die('task id required');
  const t = state.tasks[id] || state.tasks[id.toUpperCase()] || state.tasks['T' + id];
  if (!t) die(`unknown task: ${id}`);
  return t;
}

function nextTaskId(state) {
  let n = 0;
  for (const id of state.order) {
    const m = /^T(\d+)$/.exec(id);
    if (m) n = Math.max(n, +m[1]);
  }
  return `T${n + 1}`;
}

function taskFieldsFromFlags(f, state, selfId) {
  const d = {};
  if (f.title !== undefined) d.title = f.title;
  if (f.desc !== undefined) d.description = f.desc;
  if (f.accept) d.acceptance = f.accept;
  if (f.label) d.labels = f.label.flatMap((l) => l.split(',')).map((s) => s.trim()).filter(Boolean);
  if (f.agent !== undefined) d.agent = f.agent === '-' || f.agent === '' ? null : f.agent;
  if (f.resume !== undefined) {
    if (!RESUME_POLICIES.includes(f.resume)) die(`--resume must be one of ${RESUME_POLICIES.join(', ')}`);
    d.resume = f.resume;
  }
  if (f.priority !== undefined) {
    d.priority = Number(f.priority);
    if (!Number.isFinite(d.priority)) die('--priority must be a number');
  }
  if (f.dep) {
    d.deps = f.dep.flatMap((x) => x.split(',')).map((s) => s.trim()).filter(Boolean);
    for (const dep of d.deps) {
      if (!state.tasks[dep]) die(`unknown dependency: ${dep}`);
      if (dep === selfId) die('task cannot depend on itself');
    }
  }
  if (f.parent !== undefined) {
    if (f.parent && !state.tasks[f.parent]) die(`unknown parent: ${f.parent}`);
    for (let p = f.parent; p; p = state.tasks[p]?.parent)
      if (p === selfId) die('parent would create a cycle');
    d.parent = f.parent || null;
  }
  return d;
}

// ---------- rendering ----------
/** Tree prefix with connectors: "│  ├─ ". `lastFlags[i]` = ancestor i is the last child. */
function treeRows(state) {
  const rows = [];
  const visit = (id, prefix, isLast, depth) => {
    rows.push({ id, prefix: depth ? prefix + (isLast ? '└─ ' : '├─ ') : '' });
    const kids = state.tasks[id].children;
    kids.forEach((c, i) => visit(c, depth ? prefix + (isLast ? '   ' : '│  ') : '', i === kids.length - 1, depth + 1));
  };
  const roots = state.order.filter((id) => !state.tasks[id].parent || !state.tasks[state.tasks[id].parent]);
  roots.forEach((id, i) => visit(id, '', i === roots.length - 1, 0));
  return rows;
}
function treeOrder(state) {
  return treeRows(state).map((r) => r.id);
}
function ownerLabel(t) {
  if (t.assignee) return cyan(`@${t.assignee}`);
  if (t.owner) return dim(cyan(`@${t.owner}`)); // inherited from the work package
  return '';
}
function renderTaskLine(t, state, prefix = '') {
  const st = t.rollup_status ?? t.status;
  const bits = [];
  if (t.children.length) {
    const leaves = t.children.length;
    const done = t.children.filter((c) => (state.tasks[c].rollup_status ?? state.tasks[c].status) === 'done').length;
    bits.push(dim(`[${done}/${leaves}${t.rollup_percent != null ? ` · ${t.rollup_percent}%` : ''}]`));
  }
  const who = ownerLabel(t);
  if (who) bits.push(t.children.length && t.assignee ? `${who}${dim(' (package)')}` : who);
  if (t.status === 'in_progress' && t.percent != null) bits.push(yellow(`${t.percent}%`));
  if (t.ready) bits.push(green('ready'));
  if (t.status === 'todo' && t.waiting_on.length) bits.push(dim(`waits on ${t.waiting_on.join(',')}`));
  if (t.status === 'blocked' && t.blocked_on.length) bits.push(t.can_resume ? green(`can resume (${t.blocked_on.join(',')} done)`) : dim(`blocked on ${t.blocked_on.join(',')}`));
  return `${dim(prefix)}${bold(t.id)} ${badge(st)}  ${t.children.length ? bold(t.title) : t.title}  ${bits.join(' ')}`;
}
function breadcrumb(t, state) {
  return t.path.map((id) => `${id} ${state.tasks[id].title}`).join(' › ');
}
function renderStatus(state) {
  const pct = Math.round(state.progress * 100);
  const width = 24;
  const fill = Math.round((pct / 100) * width);
  const bar = green('█'.repeat(fill)) + dim('░'.repeat(width - fill));
  const counts = TASK_STATUSES.filter((s) => state.counts[s]).map((s) => `${s} ${state.counts[s]}`).join(' · ');
  const lines = [
    `${bold(state.title)} ${dim(`[${state.id}]`)} ${state.status !== 'active' ? yellow(state.status) : ''}`,
    state.goal ? dim(`goal: ${state.goal}`) : null,
    `${bar} ${pct}%  ${dim(counts || 'no tasks')}`,
    '',
    ...treeRows(state).map((r) => renderTaskLine(state.tasks[r.id], state, r.prefix)),
  ].filter((l) => l !== null);
  const attention = state.order
    .map((id) => state.tasks[id])
    .filter((t) => t.status === 'blocked' || t.status === 'review');
  if (attention.length) {
    lines.push('', bold('needs attention:'));
    for (const t of attention) lines.push(`  ${t.id} ${badge(t.status)} ${t.last_message || ''}`);
  }
  const actors = Object.values(state.actors).filter((a) => a.owned.some((id) => !TERMINAL.has(state.tasks[id].status)));
  if (actors.length) {
    lines.push('', bold('agents:'));
    for (const a of actors) lines.push(renderActorLine(a, state));
  }
  return lines.join('\n');
}
function renderActorLine(a, state) {
  const owned = a.owned.map((id) => state.tasks[id]);
  const done = owned.filter((t) => t.status === 'done').length;
  const active = owned.filter((t) => !TERMINAL.has(t.status) && t.status !== 'todo').map((t) => `${t.id}(${t.status})`);
  const pk = a.packages.length ? ` packages ${a.packages.join(',')}` : '';
  return `  ${cyan(a.id)} ${dim(a.role || '')}${pk} · ${done}/${owned.length} done${active.length ? ' · ' + active.join(' ') : ''} ${a.last_seen ? dim(`seen ${ago(a.last_seen)}`) : dim('not started')}`;
}
function renderPlan(state) {
  const L = [renderStatus(state).split('\n').slice(0, 3).join('\n')];
  L.push(dim(`created ${state.created_at?.slice(0, 16).replace('T', ' ')} by ${state.created_by ?? '?'} · updated ${ago(state.updated_at)}`));
  if (state.status_message) L.push('', bold('status: ') + state.status_message);
  if (state.description) L.push('', state.description);
  L.push('', bold('structure:'), ...treeRows(state).map((r) => '  ' + renderTaskLine(state.tasks[r.id], state, r.prefix)));
  const actors = Object.values(state.actors).filter((a) => a.owned.length || a.packages.length);
  if (actors.length) L.push('', bold('ownership:'), ...actors.map((a) => renderActorLine(a, state)));
  const notes = state.order.flatMap((id) => state.tasks[id].notes.map((n) => ({ ...n, task: id })));
  for (const [kind, title] of [['decision', 'decisions'], ['question', 'open questions'], ['warning', 'warnings']]) {
    const ns = notes.filter((n) => n.kind === kind);
    if (ns.length) L.push('', bold(title + ':'), ...ns.map((n) => `  ${n.task} ${cyan(n.actor ?? '')}: ${n.message}`));
  }
  const arts = state.order.flatMap((id) => state.tasks[id].artifacts.map((x) => ({ ...x, task: id })));
  if (arts.length) L.push('', bold('artifacts:'), ...arts.map((x) => `  ${x.task} ${x.kind}: ${x.ref}${x.description ? dim(' — ' + x.description) : ''}`));
  return L.join('\n');
}
function renderTask(t, state) {
  const L = [];
  if (t.path.length) L.push(dim(breadcrumb(t, state) + ' ›'));
  L.push(`${bold(t.id)} ${badge(t.rollup_status ?? t.status)}  ${bold(t.title)}`);
  if (t.assignee) L.push(`assignee: ${cyan(t.assignee)}${t.children.length ? dim(' (owns this work package)') : ''}`);
  if (t.agent) L.push(`agent:    ${magenta(t.agent)} ${dim('(agent definition to run it with)')}`);
  else if (t.owner) L.push(`owner:    ${cyan(t.owner)} ${dim(`(via package ${[...t.path].reverse().find((id) => state.tasks[id].assignee)})`)}`);
  if (t.children.length)
    L.push(`subtasks: ${t.children.map((id) => `${id}(${state.tasks[id].rollup_status ?? state.tasks[id].status}${state.tasks[id].owner && state.tasks[id].owner !== t.owner ? ' @' + state.tasks[id].owner : ''})`).join(', ')}`);
  if (t.blocked_on.length) L.push(`blocked on: ${t.blocked_on.map((d) => `${d}(${state.tasks[d]?.rollup_status ?? state.tasks[d]?.status ?? '?'})`).join(', ')}${t.can_resume ? green('  → can resume') : ''}`);
  if (t.deps.length) L.push(`deps:     ${t.deps.map((d) => `${d}(${state.tasks[d]?.rollup_status ?? state.tasks[d]?.status ?? '?'})`).join(', ')}`);
  if (t.labels.length) L.push(`labels:   ${t.labels.join(', ')}`);
  if (t.percent != null && !t.children.length) L.push(`progress: ${t.percent}%`);
  if (t.rollup_percent != null) L.push(`progress: ${t.rollup_percent}% (rolled up)`);
  if (t.description) L.push('', t.description);
  if (t.acceptance.length) L.push('', bold('acceptance criteria:'), ...t.acceptance.map((a) => `  - [${t.status === 'done' ? 'x' : ' '}] ${a}`));
  if (t.checkpoint && !TERMINAL.has(t.status))
    L.push('', bold('checkpoint') + dim(` (${t.checkpoint.actor ?? '?'}, ${ago(t.checkpoint.ts)}):`), t.checkpoint.message);
  if (t.result) L.push('', bold('result:'), t.result);
  const sess = Object.values(t.sessions || {});
  if (sess.length || t.resume) L.push('', bold('agent context:') + dim(` resume policy ${t.resume_policy}`), ...sess.map((x) => `  ${cyan(x.actor ?? '?')} ${x.kind ?? ''} session ${dim(x.ref)}`));
  if (t.artifacts.length) L.push('', bold('artifacts:'), ...t.artifacts.map((a) => `  ${a.kind}: ${a.ref}${a.description ? dim(' — ' + a.description) : ''}`));
  if (t.notes.length) L.push('', bold('notes:'), ...t.notes.map((n) => `  ${dim(n.ts.slice(11, 19))} ${n.kind !== 'info' ? yellow(`[${n.kind}] `) : ''}${n.actor ? cyan(n.actor) + ': ' : ''}${n.message}`));
  const hist = t.history.slice(-8);
  if (hist.length) {
    L.push('', bold('recent activity:'));
    for (const h of hist) {
      const what =
        h.type === 'status' ? `${h.from} → ${h.to}` : h.type === 'assigned' ? `assigned ${h.assignee ?? '(none)'}` : `progress${h.percent != null ? ` ${h.percent}%` : ''}`;
      L.push(`  ${dim(h.ts.slice(11, 19))} ${h.actor ? cyan(h.actor) + ' ' : ''}${what}${h.message ? dim(' — ' + h.message) : ''}`);
    }
  }
  return L.join('\n');
}
function renderEvent(e) {
  const d = e.data || {};
  const bits = [d.status, d.percent != null ? `${d.percent}%` : null, d.assignee !== undefined ? `→ ${d.assignee ?? '(none)'}` : null, d.title, d.kind, d.ref, d.message]
    .filter((x) => x !== undefined && x !== null && x !== '');
  return `${dim(`#${e.seq} ${e.ts.slice(11, 19)}`)} ${cyan(e.actor?.id ?? '?')} ${bold(e.type)}${e.task ? ' ' + e.task : ''} ${bits.join(' · ')}`;
}

// ---------- status transitions ----------
function statusCmd(target, msgRequired) {
  return (pos) => {
    const { root, planId, actor } = ctx();
    const msg = FLAGS.message;
    if (msgRequired && !msg) die(`-m <message> is required for ${target}`);
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      if (!FLAGS.force) {
        if (!canTransition(t.status, target)) die(`cannot move ${t.id} from ${t.status} to ${target} (use --force)`);
        if (target === 'in_progress' && t.waiting_on.length) die(`${t.id} waits on ${t.waiting_on.join(', ')} (use --force)`);
        if (target === 'in_progress' && t.children.length) die(`${t.id} has subtasks; start those instead (use --force)`);
        if (t.owner && t.owner !== actor.id && actor.role !== 'coordinator' && target !== 'todo')
          die(`${t.id} is ${t.assignee ? 'assigned to' : 'in a work package owned by'} ${t.owner} (use --force)`);
      }
      const evs = [];
      if (target === 'in_progress' && t.assignee !== actor.id && (!t.assignee || FLAGS.force || t.owner === actor.id))
        evs.push({ type: 'task.assigned', task: t.id, data: { assignee: actor.id } });
      const data = { status: target, ...(msg ? { message: msg } : {}) };
      if (FLAGS.on) {
        if (target !== 'blocked') die('--on only applies to block');
        data.on = FLAGS.on.split(',').map((x) => x.trim()).filter(Boolean);
        for (const d of data.on) if (!st.tasks[d]) die(`unknown task in --on: ${d}`);
      }
      evs.push({ type: 'task.status', task: t.id, data });
      return evs;
    });
    const t = requireTask(state, pos[0]);
    out({ ok: true, task: t }, `${t.id} ${badge(t.status)}${t.assignee ? ' ' + cyan('@' + t.assignee) : ''}`);
  };
}

// ---------- commands ----------
const commands = {
  init() {
    const root = initRoot();
    out({ ok: true, root }, `initialized ${root}`);
  },

  plan(pos) {
    const sub = pos.shift() || 'show';
    if (sub === 'new' || sub === 'create') {
      const { root, actor } = ctx({ needPlan: false });
      const title = pos.join(' ');
      if (!title) die('plan title required');
      const id = FLAGS.id || newPlanId(title);
      if (fs.existsSync(eventsPath(root, id))) die(`plan exists: ${id}`);
      const data = { title };
      if (FLAGS.goal) data.goal = FLAGS.goal;
      if (FLAGS.desc) data.description = FLAGS.desc;
      transact(root, id, actor, () => [{ type: 'plan.created', data }]);
      setCurrentPlan(root, id);
      return out({ ok: true, plan: id }, `created plan ${bold(id)} (now current)\n${dim(`export ATF_PLAN=${id}`)}`);
    }
    if (sub === 'list') {
      const { root } = ctx({ needPlan: false });
      const cur = getCurrentPlan(root);
      const plans = listPlanIds(root).map((id) => {
        const s = loadPlan(root, id);
        return { id, title: s.title, status: s.status, progress: s.progress, total: s.total, updated_at: s.updated_at, current: id === cur };
      });
      plans.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      return out(plans, plans.map((p) => `${p.current ? green('*') : ' '} ${bold(p.id)} ${p.title} ${dim(`${p.status} · ${Math.round(p.progress * 100)}% of ${p.total} · ${ago(p.updated_at)}`)}`).join('\n') || 'no plans');
    }
    if (sub === 'use') {
      const { root } = ctx({ needPlan: false });
      if (!pos[0] || !fs.existsSync(eventsPath(root, pos[0]))) die(`plan not found: ${pos[0]}`);
      setCurrentPlan(root, pos[0]);
      return out({ ok: true, plan: pos[0] }, `current plan: ${pos[0]}`);
    }
    if (sub === 'show') {
      if (pos[0]) FLAGS.plan = pos[0];
      const { root, planId } = ctx();
      const state = loadPlan(root, planId);
      return out(state, renderPlan(state));
    }
    if (sub === 'update') {
      const { root, planId, actor } = ctx();
      const data = {};
      if (FLAGS.title) data.title = FLAGS.title;
      if (FLAGS.goal) data.goal = FLAGS.goal;
      if (FLAGS.desc) data.description = FLAGS.desc;
      if (FLAGS.resume) {
        if (!RESUME_POLICIES.includes(FLAGS.resume)) die(`--resume must be one of ${RESUME_POLICIES.join(', ')}`);
        data.resume = FLAGS.resume;
      }
      if (!Object.keys(data).length) die('nothing to update');
      transact(root, planId, actor, () => [{ type: 'plan.updated', data }]);
      return out({ ok: true }, 'plan updated');
    }
    if (sub === 'status') {
      const { root, planId, actor } = ctx();
      if (!PLAN_STATUSES.includes(pos[0])) die(`plan status must be one of ${PLAN_STATUSES.join(', ')}`);
      transact(root, planId, actor, () => [{ type: 'plan.status', data: { status: pos[0], ...(FLAGS.message ? { message: FLAGS.message } : {}) } }]);
      return out({ ok: true }, `plan ${planId}: ${pos[0]}`);
    }
    die(`unknown plan subcommand: ${sub}`);
  },

  add(pos) {
    const { root, planId, actor } = ctx();
    const title = pos.join(' ');
    if (!title) die('task title required');
    let id;
    const { state } = transact(root, planId, actor, (st) => {
      id = FLAGS.id || nextTaskId(st);
      if (st.tasks[id]) die(`task exists: ${id}`);
      const data = { title, ...taskFieldsFromFlags(FLAGS, st, id) };
      if (FLAGS.assign) data.assignee = FLAGS.assign;
      return [{ type: 'task.created', task: id, data }];
    });
    out({ ok: true, task: state.tasks[id] }, renderTaskLine(state.tasks[id], state));
  },

  edit(pos) {
    const { root, planId, actor } = ctx();
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      const data = taskFieldsFromFlags(FLAGS, st, t.id);
      if (!Object.keys(data).length) die('nothing to update');
      return [{ type: 'task.updated', task: t.id, data }];
    });
    const t = requireTask(state, pos[0]);
    const cyc = findCycles(state);
    if (cyc.length) process.stderr.write(yellow(`warning: dependency cycle ${cyc[0].join(' → ')}\n`));
    out({ ok: true, task: t }, renderTaskLine(t, state));
  },

  assign(pos) {
    const { root, planId, actor } = ctx();
    const who = pos[1] === '-' || pos[1] === undefined ? null : pos[1];
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      return [{ type: 'task.assigned', task: t.id, data: { assignee: who } }];
    });
    const t = requireTask(state, pos[0]);
    out({ ok: true, task: t }, `${t.id} → ${who ?? '(unassigned)'}`);
  },

  next() {
    const { root, planId, actor } = ctx();
    let picked;
    const { state } = transact(root, planId, actor, (st) => {
      const ready = st.order.map((id) => st.tasks[id]).filter((t) => t.ready);
      // 1. tasks assigned to me, 2. unassigned tasks inside my work packages, 3. unowned tasks
      const mine = ready.filter((t) => t.assignee === actor.id);
      const pkg = ready.filter((t) => !t.assignee && t.owner === actor.id);
      const free = ready.filter((t) => !t.owner);
      const pool = (mine.length ? mine : pkg.length ? pkg : FLAGS.package ? [] : free).sort((a, b) => (b.priority || 0) - (a.priority || 0));
      picked = pool[0];
      if (!picked) return [];
      const evs = [];
      if (picked.assignee !== actor.id) evs.push({ type: 'task.assigned', task: picked.id, data: { assignee: actor.id } });
      evs.push({ type: 'task.status', task: picked.id, data: { status: 'in_progress', ...(FLAGS.message ? { message: FLAGS.message } : {}) } });
      return evs;
    });
    if (!picked) {
      const active = state.order.filter((id) => !TERMINAL.has(state.tasks[id].status));
      return out({ ok: true, task: null, remaining: active.length }, active.length ? 'no ready task for you right now; run `atf wait` to block until something needs you' : 'all tasks finished');
    }
    const t = state.tasks[picked.id];
    out({ ok: true, task: t }, renderTask(t, state));
  },

  start: statusCmd('in_progress', false),
  block: statusCmd('blocked', true),
  review: statusCmd('review', true),
  done: statusCmd('done', true),
  fail: statusCmd('failed', true),
  cancel: statusCmd('cancelled', false),
  reopen: statusCmd('todo', false),

  release(pos) {
    const { root, planId, actor } = ctx();
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      const evs = [];
      if (t.status !== 'todo') evs.push({ type: 'task.status', task: t.id, data: { status: 'todo', ...(FLAGS.message ? { message: FLAGS.message } : {}) } });
      evs.push({ type: 'task.assigned', task: t.id, data: { assignee: null } });
      return evs;
    });
    out({ ok: true, task: requireTask(state, pos[0]) }, `${pos[0]} released`);
  },

  progress(pos) {
    const { root, planId, actor } = ctx();
    const message = pos.slice(1).join(' ') || FLAGS.message;
    const data = {};
    if (message) data.message = message;
    if (FLAGS.pct !== undefined) {
      data.percent = Number(FLAGS.pct);
      if (!Number.isFinite(data.percent)) die('--pct must be a number');
    }
    if (!Object.keys(data).length) die('progress needs a message and/or --pct');
    transact(root, planId, actor, (st) => [{ type: 'task.progress', task: requireTask(st, pos[0]).id, data }]);
    out({ ok: true }, dim('ok'));
  },

  note(pos) {
    const { root, planId, actor } = ctx();
    const message = pos.slice(1).join(' ') || FLAGS.message;
    if (!message) die('note message required');
    const kind = FLAGS.kind || 'info';
    if (!NOTE_KINDS.includes(kind)) die(`--kind must be one of ${NOTE_KINDS.join(', ')}`);
    transact(root, planId, actor, (st) => [{ type: 'task.note', task: requireTask(st, pos[0]).id, data: { message, kind } }]);
    out({ ok: true }, dim('ok'));
  },

  artifact(pos) {
    const { root, planId, actor } = ctx();
    if (!pos[1]) die('artifact ref required');
    const kind = FLAGS.kind || (fs.existsSync(pos[1]) ? 'file' : /^https?:/.test(pos[1]) ? 'url' : 'other');
    if (!ARTIFACT_KINDS.includes(kind)) die(`--kind must be one of ${ARTIFACT_KINDS.join(', ')}`);
    const data = { kind, ref: pos[1], ...(FLAGS.desc ? { description: FLAGS.desc } : {}) };
    transact(root, planId, actor, (st) => [{ type: 'task.artifact', task: requireTask(st, pos[0]).id, data }]);
    out({ ok: true }, dim('ok'));
  },

  session(pos) {
    // Record an opaque harness session reference for a task (launchers resume from it).
    const { root, planId, actor } = ctx();
    if (!pos[1]) die('usage: atf session <task> <ref> [--kind K] [--for ACTOR]');
    transact(root, planId, actor, (st) => [
      { type: 'task.session', task: requireTask(st, pos[0]).id, data: { ref: pos[1], ...(FLAGS.kind ? { kind: FLAGS.kind } : {}), ...(FLAGS.for ? { actor: FLAGS.for } : {}) } },
    ]);
    out({ ok: true }, dim('ok'));
  },

  'resume-info'(pos) {
    // For launchers in any language: should the next agent on this task resume or start fresh?
    const { root, planId } = ctx();
    const state = loadPlan(root, planId);
    const t = requireTask(state, pos[0]);
    const lp = launchPlan(state, t.id, FLAGS.for || t.owner);
    out(lp, `${t.id}: ${bold(lp.mode)} (${lp.reason})${lp.session ? `\nsession: ${lp.session.kind ?? ''} ${lp.session.ref}` : ''}${lp.checkpoint ? `\ncheckpoint: ${lp.checkpoint.message}` : ''}`);
  },

  plans() {
    // Active plans in this project, or across all known projects (--all).
    const roots = scopeRoots();
    const rows = [];
    for (const root of roots)
      for (const id of listPlanIds(root)) {
        const st = loadPlan(root, id);
        if (!FLAGS.closed && !['active', 'paused'].includes(st.status)) continue;
        rows.push({ project: projectName(root), root, ...planSummary(st) });
      }
    rows.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    const human = rows.map((r) => {
      const pct = Math.round(r.progress * 100);
      const bits = [`${r.counts.done}/${r.total} done`, r.agents.length ? `agents ${r.agents.join(',')}` : null, r.ready_unowned ? green(`${r.ready_unowned} ready unassigned`) : null, r.inbox ? red(`${r.inbox} need you`) : null].filter(Boolean);
      return `${dim(r.project.padEnd(18))} ${bold(r.title)} ${dim(`[${r.id}]`)} ${pct}%  ${bits.join(' · ')} ${dim(ago(r.updated_at))}`;
    });
    out(rows, human.join('\n') || 'no active plans');
  },

  inbox() {
    // Everything across plans that needs the human driving the agents, oldest first.
    const items = [];
    for (const root of scopeRoots())
      for (const id of listPlanIds(root)) {
        const st = loadPlan(root, id);
        if (st.status !== 'active') continue;
        for (const it of driverInbox(st)) items.push({ project: projectName(root), root, plan: id, plan_title: st.title, title: it.task ? st.tasks[it.task].title : null, ...it });
      }
    items.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    const color = { review: magenta, question: red, failed: red, finished: green };
    out(items, items.map((i) => `${(color[i.kind] || String)(i.kind.padEnd(9))} ${dim(i.project + ' / ' + i.plan_title)}  ${i.task ? bold(i.task) + ' ' + i.title : ''}${i.message ? dim(' — ' + i.message) : ''} ${dim(ago(i.ts))}`).join('\n') || 'inbox empty');
  },

  skill(pos) {
    const sub = pos[0] || 'status';
    if (sub === 'install' || sub === 'uninstall') {
      const done = [];
      for (const t of skillStatus()) {
        if (sub === 'install') {
          if (t.state === 'installed') continue;
          if (t.state === 'other') die(`${t.link} exists and is not this skill; remove it first`);
          fs.mkdirSync(t.dir, { recursive: true });
          fs.symlinkSync(SKILL_SRC, t.link);
          done.push(`linked ${t.link} -> ${SKILL_SRC}`);
        } else if (t.state === 'installed') {
          fs.unlinkSync(t.link);
          done.push(`removed ${t.link}`);
        }
      }
      return out({ ok: true, changes: done, status: skillStatus() }, done.join('\n') || `nothing to ${sub}`);
    }
    if (sub !== 'status') die('usage: atf skill [status|install|uninstall]');
    const st = skillStatus();
    out(st, st.map((t) => `${t.state === 'installed' ? green('✓') : t.state === 'other' ? yellow('!') : dim('·')} ${t.id.padEnd(7)} ${t.link} ${dim(t.state)}`).join('\n'));
  },

  projects(pos) {
    if (pos[0] === 'add') {
      const r = findRoot(pos[1] || process.cwd());
      if (!r) die('no .atf found there');
      registerRoot(r);
      return out({ ok: true, root: r }, `registered ${r}`);
    }
    const roots = knownRoots();
    out(roots, roots.map((r) => `${projectName(r).padEnd(20)} ${dim(r)}`).join('\n') || 'no known projects');
  },

  status() {
    const { root, planId } = ctx();
    const state = loadPlan(root, planId);
    if (!FLAGS.watch) return out(state, renderStatus(state));
    const draw = () => process.stdout.write('\x1b[H\x1b[2J' + renderStatus(loadPlan(root, planId)) + '\n' + dim(`\nwatching ${planId} · ctrl+c to exit`) + '\n');
    draw();
    fs.watchFile(eventsPath(root, planId), { interval: 300 }, draw);
    setInterval(draw, 15_000); // refresh relative times
  },

  list() {
    const { root, planId, actor } = ctx();
    const state = loadPlan(root, planId);
    let ts = treeOrder(state).map((id) => state.tasks[id]);
    if (FLAGS.status) {
      const ss = FLAGS.status.split(',');
      ts = ts.filter((t) => ss.includes(t.status));
    }
    if (FLAGS.ready) ts = ts.filter((t) => t.ready);
    if (FLAGS.mine) ts = ts.filter((t) => t.owner === actor.id);
    if (FLAGS.assignee) ts = ts.filter((t) => t.assignee === FLAGS.assignee);
    const filtered = FLAGS.status || FLAGS.ready || FLAGS.mine || FLAGS.assignee;
    const prefixes = Object.fromEntries(treeRows(state).map((r) => [r.id, r.prefix]));
    // filtered lists lose the tree shape, so show each task's path instead
    const line = (t) => (filtered ? renderTaskLine(t, state) + (t.path.length ? dim(`  in ${t.path.join(' › ')}`) : '') : renderTaskLine(t, state, prefixes[t.id]));
    out(ts, ts.map(line).join('\n') || 'no tasks');
  },

  show(pos) {
    const { root, planId } = ctx();
    const state = loadPlan(root, planId);
    const t = requireTask(state, pos[0]);
    out(t, renderTask(t, state));
  },

  log() {
    const { root, planId } = ctx();
    const n = Number(FLAGS.limit || 30);
    const p = eventsPath(root, planId);
    const evs = readEvents(root, planId);
    const print = (list) => {
      for (const e of list) process.stdout.write((FLAGS.json ? JSON.stringify(e) : renderEvent(e)) + '\n');
    };
    print(evs.slice(-n));
    if (!FLAGS.follow) return;
    let last = evs.length ? evs[evs.length - 1].seq : 0;
    fs.watchFile(p, { interval: 300 }, () => {
      const fresh = readEvents(root, planId).filter((e) => e.seq > last);
      if (fresh.length) {
        last = fresh[fresh.length - 1].seq;
        print(fresh);
      }
    });
  },

  wait() {
    const { root, planId, actor } = ctx();
    const p = eventsPath(root, planId);
    const explicit = !!(FLAGS.task || FLAGS.status);
    const tasks = FLAGS.task ? FLAGS.task.split(',') : null;
    const statuses = (FLAGS.status || 'done,failed,blocked,review').split(',');
    const timeout = FLAGS.timeout ? Number(FLAGS.timeout) : 0;
    const startSeq = loadPlan(root, planId).last_seq;
    const leaves = (st) => st.order.map((id) => st.tasks[id]).filter((t) => !t.children.length);

    const finish = (st, attention, events, note) => {
      fs.unwatchFile(p);
      const human = [
        note,
        ...attention.map((a) => `${bold(a.task)} ${a.reason === 'ready' || a.reason === 'unblocked' ? green(a.reason) : magenta(a.reason)}  ${st.tasks[a.task]?.title ?? ''}${a.reason === 'unblocked' ? dim(` (was blocked on ${st.tasks[a.task].blocked_on.join(',')})`) : ''}`),
        ...events.map(renderEvent),
      ].filter(Boolean);
      out({ ok: true, attention, events, ...(note ? { note } : {}) }, human.join('\n'));
      process.exit(0);
    };

    const evaluate = () => {
      const st = loadPlan(root, planId);
      const evs = readEvents(root, planId).filter((e) => e.seq > startSeq);
      if (explicit) {
        // level: requested tasks already in a requested status; edge: matching status events
        const level = (tasks || []).filter((id) => statuses.includes(st.tasks[id]?.rollup_status ?? st.tasks[id]?.status)).map((id) => ({ task: id, reason: st.tasks[id].rollup_status ?? st.tasks[id].status }));
        const hits = evs.filter((e) => e.type === 'task.status' && statuses.includes(e.data?.status) && (!tasks || tasks.includes(e.task)));
        if (level.length || hits.length) finish(st, level, hits);
        return;
      }
      // Default: level-triggered on what needs *this* actor, so a wakeup can never be missed.
      const attention = attentionFor(st, actor.id, actor.role);
      const isCoord = actor.role === 'coordinator';
      const hits = evs.filter(
        (e) =>
          e.actor?.id !== actor.id &&
          ((isCoord && e.type === 'task.status' && ['done', 'failed', 'blocked', 'review'].includes(e.data?.status)) ||
            (e.task && st.tasks[e.task]?.owner === actor.id && ['task.status', 'task.note', 'task.assigned', 'task.updated'].includes(e.type))),
      );
      if (attention.length || hits.length) return finish(st, attention, hits);
      if (isCoord && leaves(st).length && leaves(st).every((t) => TERMINAL.has(t.status))) return finish(st, [], [], 'all tasks are finished');
      if (!isCoord && !leaves(st).some((t) => t.owner === actor.id && !TERMINAL.has(t.status))) return finish(st, [], [], 'you own no open tasks');
      // Ephemeral agents don't idle: the launcher resumes or replaces them when work is available.
      if (!isCoord && process.env.ATF_LIFECYCLE === 'ephemeral')
        return finish(st, [], [], 'nothing needs you right now. Lifecycle is ephemeral: make sure blocked tasks have a checkpoint note, then end your turn; you will be resumed when work is available.');
    };

    evaluate(); // return at once if something already needs you
    fs.watchFile(p, { interval: 300 }, evaluate);
    if (timeout)
      setTimeout(() => {
        fs.unwatchFile(p);
        const st = loadPlan(root, planId);
        const mine = leaves(st).filter((t) => t.owner === actor.id && !TERMINAL.has(t.status));
        const why = mine.map((t) => `${t.id} ${t.status}${t.waiting_on.length ? ` (waits on ${t.waiting_on.join(',')})` : t.blocked_on.length ? ` (blocked on ${t.blocked_on.join(',')})` : ''}`);
        out({ ok: false, timeout: true, open: why }, `timeout: nothing needs you yet${why.length ? '. Your open tasks: ' + why.join('; ') : ''}. Run atf wait again.`);
        process.exit(2);
      }, timeout);
  },

  validate() {
    const { root, planId } = ctx();
    const evs = readEvents(root, planId);
    const state = loadPlan(root, planId);
    const problems = [...state.warnings];
    let prev = 0;
    for (const e of evs) {
      if (e.seq <= prev) problems.push(`seq not increasing at #${e.seq}`);
      prev = e.seq;
      if (e.plan !== planId) problems.push(`#${e.seq}: plan field ${e.plan} != ${planId}`);
    }
    for (const cyc of findCycles(state)) problems.push(`dependency cycle: ${cyc.join(' → ')}`);
    for (const t of Object.values(state.tasks)) {
      for (const d of t.deps) if (!state.tasks[d]) problems.push(`${t.id}: unknown dep ${d}`);
      if (t.status === 'done' && t.waiting_on.length) problems.push(`${t.id}: done while deps unfinished (${t.waiting_on.join(',')})`);
    }
    out({ ok: problems.length === 0, problems }, problems.length ? problems.map((x) => red('✗ ') + x).join('\n') : green('✓ valid'));
    if (problems.length) process.exitCode = 1;
  },
};

// ---------- main ----------
try {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  FLAGS = flags;
  const cmd = pos.shift();
  if (!cmd || flags.help || cmd === 'help') {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const handler = commands[cmd];
  if (!handler) die(`unknown command: ${cmd} (see atf help)`);
  handler(pos);
} catch (e) {
  report(e.message);
}
