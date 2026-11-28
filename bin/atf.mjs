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
  inferRole,
  launchPlan,
  RESUME_POLICIES,
  driverInbox,
  humanTasks,
  planSummary,
  reviewRefusal,
  HUMAN,
  BLOCK_FOR,
  brief,
} from '../src/core.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backendName, AGENT_KINDS } from '../src/launch.mjs';
import { daemonUp as sessionsDaemonUp } from '../src/sessions.mjs';
import { buildPrompt } from '../src/prompts.mjs';
import { planChanges, levelSets, totals, onlyFile, projectPath, viewerCommand, patchText, changeMode, diffTool, fileOrigin } from '../src/changes.mjs';
import { activeRuns, taskLive, elapsed, readTail, earlierText, liveView, liveItem, loadLiveKinds, liveKinds, liveKind, refreshLive, refreshError, enableAutoRefresh, summarizeText, classify, registerLiveKind, STYLES } from '../src/live.mjs';
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
  readCursor,
  writeCursor,
  readSeen,
  writeSeen,
  registerWaiter,
  readDrafts,
  writeDrafts,
  reviewEvents,
  knownRoots,
  registerRoot,
  projectName,
  skillStatus,
  SKILL_SRC,
  readConfig,
} from '../src/store.mjs';
import { readConfigFile, writeConfigFile } from '../src/toml.mjs';
import { configPlaces, initConfigFile } from '../src/config.mjs';

const HELP = `atf — Agent Task Framework

Setup / plans
  atf init                              create .atf/ in the current directory (the project root)
  atf plan new <title> [--goal G] [--desc D] [--doc design.md]... [--ids outline|flat]
                                        create plan, make it current; subtask ids are
                                        numbered under their parent (T6.2), unless --ids flat
                                        (--doc: the plan's documents, read by every new coordinator)
  atf plan list | use <id>
  atf plan show [id]                    plan overview: structure, ownership, decisions, artifacts
  atf plan new <title> ... [--coordinator NAME]   (default: you become its coordinator)
  atf plan new <title> ... [--harness KIND] [--coordinator-model M] …   as for plan update
  atf plan update [--title T] [--goal G] [--desc D] [--doc PATH]... [--resume fresh|auto|resume]
                  [--parent-review on|off]   parents with criteria are reviewed when their
                                        subtasks are done (new plans: on; older plans: off)
                  [--coordinator NAME]    (--doc replaces the list; --doc - clears it)
                  [--harness KIND]        the agent kind that runs this plan's coordinator and
                                        agents (pi, copilot, claude, codex, opencode), whoever
                                        starts them; --harness - clears it (the launcher's default)
                  [--coordinator-model M] [--coordinator-thinking L]   for that harness only
                  [--agent-model M] [--agent-thinking L]               (- clears one); else the
                                        launcher's config [sessions.<kind>] (herdr: [<kind>])
  atf plan checkpoint "<where the plan stands, what you wait for, what is next>"
                                        (coordinator) handoff to the next coordinator session
  atf plan ask "<question>"             (coordinator) a question for the human about the whole plan
  atf plan note "<text>" [--kind K] [--for human]   a plan-level note
  atf plan session <ref> [--kind K]     record the coordinator's session (launchers)
  atf whoami                            who ATF thinks you are: identity, role and why, plan
  atf plan status <${PLAN_STATUSES.join('|')}> [-m msg] [--relay "<the human's words>"]  (closing: the human's decision)

Tasks (coordinator)
  atf add <title> [--desc D] [--accept A]... [--dep T1]... [--parent T1]
                  [--label L]... [--priority N] [--assign WHO] [--resume fresh|auto|resume]
                  [--agent NAME]   agent definition to run the task with (e.g. reviewer)
                  [--from T3]      follow-up of T3 (scope found in review); placed under T3's
                                   parent; copies nothing else from T3 (not its assignee,
                                   --agent, --review, labels): pass what it needs
                  [--review]       must go to review before done (--review=false clears it)
                  [--reviewer human]  who must review it (default: the coordinator; implies --review)
  atf edit <task> [same flags as add; --dep/--accept/--label replace lists]
  atf assign <task> <who|->            assign / unassign. Assigning a parent task hands the
                                        whole subtree (work package) to that agent

Tasks (worker)
  atf next [--package] [-m msg]         start next ready task: assigned to you, then inside your
                                        work packages, then unowned (--package: never unowned)
  atf start <task> [-m msg] [--early]   -> in_progress (claims it if unassigned); --early:
                                        before its dependencies are done (do what you can,
                                        then block --on them)
  atf progress <task> <msg> [--pct N]   heartbeat / milestone
  atf steps <task> "<step>" "<step>" …  the parts of the task's work (e.g. one per service
                                        to deploy); its percent follows them
  atf step <task> <n|title> [done|start|skip] [-m note]   check a step off
  atf note <task> <msg> [--kind ${NOTE_KINDS.join('|')}]
  atf artifact <task> <ref> [--kind ${ARTIFACT_KINDS.join('|')}] [--desc D]
  atf artifact <task> <file> --live [--kind log|maven|tests|pipeline] [--cwd DIR]
                                        a file you watch (background build, server log):
                                        the board shows it while the task runs (--cwd: where
                                        a maven build runs, for its test reports)
  atf diff [task] [--file F] [--patch | --open [--tool T]]
                                        files a task changed (a parent: its subtree; none:
                                        the plan) with line counts; --patch the combined
                                        diff, --open it in your diff viewer (SPEC §15)
  atf note <task> "<done / left / how to verify>" --kind checkpoint
                                        where the work stands (write one before you block or stop)
  atf session <task> <ref> [--kind K] [--for WHO]
                                        record an agent session reference (for resuming)
  atf resume-info <task> [--for WHO]    resume or fresh? (used by launchers)
  atf spawn <task> [--name N] [--kind K] [--agent A] [--early] [--fresh|--resume]
                                        coordinator: start a new agent for the task in its own
                                        session (herdr pane, or ATF's sessions); it is assigned
                                        the task and given its prompt
  atf coordinate [plan] [--fresh] [--kind K]
                                        start the plan's coordinator (resumes its session;
                                        --fresh: a new one, after a checkpoint handoff)
  atf dispatch <task> [--name N] [--early]  coordinator: assign it and print the prompt for a
                                        subagent of your own harness (it adds --as N to atf commands)
  atf block <task> -m <reason> [--on T8,T9]
                                        needs a decision: a question for the coordinator (write
                                        a checkpoint first, then end). --on: blocked on other
                                        tasks; the coordinator restarts it when they are done
  atf block <task> --for human -m "<question>" [--recommend "<your view>"]
                                        (coordinator) escalate a question (or a failed task) to
                                        the human; their answer comes back to you
  atf done <task> -m <summary>          criteria met and verified by you (the normal ending)
  atf review <task> -m <summary>        someone must check it first: required for --review
                                        tasks; else for unverifiable criteria, deviations,
                                        risky changes, proposals
  atf fail <task> -m <reason>
  atf feedback approve|change|note <task> ["text"] [--file F --line N]
                                        draft review feedback (nothing is sent yet)
  atf feedback [list] | drop [task] | submit
                                        submit applies all drafts in one write: approvals,
                                        tasks sent back with all their points, notes
  atf review <task> -m "what to check" --by human
                                        ask a specific reviewer (e.g. the human) instead
                                        of the coordinator
  atf changes <task> -m "1. … 2. …" [--fresh]
                                        (coordinator) a new attempt with instructions: a
                                        task in review or done sent back, or one that
                                        failed, is blocked or went the wrong way; then
                                        start an agent for it.
                                        As the human: a change request for the coordinator
  atf cancel | reopen | release <task> [-m msg]

Relaying the human's decisions (coordinator; the human said it in your chat)
  atf note <task> --relay "<their words>"        an answer / decision, verbatim
  atf done <task> --relay "<their words>"        their approval (also of a review for the human)
  atf changes <task> --relay "<their words>" -m "1. …"   their change request, your instructions
  atf plan note --relay "<their words>"           on the plan (answers a plan question)
  atf plan status completed --relay "<their words>" -m "<summary>"   they agreed to close the plan

Viewing
  atf status [--watch]                  board summary (--watch: live-updating)
  atf list [--status S] [--ready] [--mine] [--assignee WHO]   (--mine includes your packages)
  atf show <task>
  atf log [-n N] [--follow]
  atf plans [--all] [--closed]          active plans in this project / all known projects
  atf inbox [--all] [--for human]       what needs a decision, and for whom (human / coordinator)
  atf live <task> [--watch] [--run F] [--all]
                                        what the task's agent runs: Maven test progress, outputs
                                        (--all: also runs replaced by newer ones)
  atf live-kinds                        live kinds: built-in and from plugins (~/.config/atf/live)
  atf live-try <kind|plugin.mjs> <output-file> [--cmd C] [--cwd D] [--exit N] [--active]
                                        try a kind on a saved output: match, refresh, summary,
                                        view, open (writing plugins: docs/live-plugins.md)
  atf brief <task>|plan                 what the human needs to act on a request: the question
                                        (who asked, the recommendation) or the review (submission,
                                        acceptance, changed files)
  atf projects [add [dir]]              known projects (registered on init / plan creation)
  atf config [migrate | init [user|plugin|project]]
                                        the config files in use (project .atf/config.toml, your
                                        ~/.config/atf/config.toml, the herdr plugin's) and errors
                                        in them; init writes one with every option commented out
                                        (default: yours); migrate converts old config.json files
  atf skill [status|install|uninstall]  link the agent skill into ~/.agents/skills (and
                                        ~/.claude/skills) so agents discover it automatically
  atf wait [--timeout MS] [--since SEQ] (coordinator) block until something needs you: tasks to
                                        dispatch or restart, reviews, questions, finished or failed
                                        tasks, the human's input. Reports everything since your last
                                        wait (per-actor cursor), so nothing between waits is missed.
                                        Subagents do not wait: they finish and end.
                                        With $ATF_WAKE set (a harness wakes the agent, e.g. the
                                        pi extension), it does not block: it reports what needs
                                        you now, else tells you to end your turn.
  atf wait --new                        (harness) block until something not reported yet needs
                                        the actor: wakes an idle agent once per item
  atf wait --task T1,T2 [--status S,..] wait for specific tasks to reach a status
  atf validate

Global flags
  --plan ID     plan to act on      (default: $ATF_PLAN, then .atf/current)
  --as WHO      actor id            (default: $ATF_ACTOR, then $USER); a subagent in its
                coordinator's shell (atf dispatch) adds it to every command
  --role R      actor role          (default: $ATF_ROLE, e.g. coordinator|subagent)
  --json        machine-readable output
  --force       bypass transition/ownership checks
`;

// ---------- args ----------
const BOOL = new Set(['json', 'force', 'follow', 'ready', 'mine', 'help', 'all', 'watch', 'package', 'closed', 'fresh', 'early', 'review', 'new', 'live', 'active', 'no-refresh', 'open', 'patch']);
const MULTI = new Set(['accept', 'dep', 'label', 'doc']);
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
const dim = c(2), bold = c(1), inverse = c(7), red = c(31), green = c(32), yellow = c(33), blue = c(34), magenta = c(35), cyan = c(36);
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
  if (actor.id === HUMAN && !FLAGS.role) actor.role = 'human'; // whatever $ATF_ROLE the shell has
  // $ATF_ROLE belongs to $ATF_ACTOR: `--as <other>` (a subagent in the coordinator's shell,
  // atf dispatch) does not inherit it
  const envRole = process.env.ATF_ROLE && (!FLAGS.as || FLAGS.as === process.env.ATF_ACTOR) ? process.env.ATF_ROLE : null;
  // No explicit role (--role / $ATF_ROLE): infer it from the plan, so a coordinator that
  // was started by hand (no ATF env) is still treated as the coordinator.
  actor.role_source = FLAGS.role ? '--role' : envRole ? '$ATF_ROLE' : null;
  if (!actor.role_source) {
    if (planId && fs.existsSync(eventsPath(root, planId))) {
      const r = inferRole(loadPlan(root, planId), actor.id);
      actor.role = r.role;
      actor.role_source = r.source;
    } else actor.role_source = 'default';
  }
  const { role_source, ...written } = actor; // role_source is for whoami only, not stored
  return { root, planId, actor: written, roleSource: role_source };
}

/** Refuse writes that would create a dependency cycle (it would deadlock the tasks in it). */
function rejectCycles(st, evs) {
  if (FLAGS.force) return;
  const tasks = { ...st.tasks };
  const order = [...st.order];
  for (const e of evs) {
    if (!e.task || !e.data?.deps) continue;
    if (!tasks[e.task]) order.push(e.task);
    tasks[e.task] = { ...(tasks[e.task] || {}), deps: e.data.deps };
  }
  const cyc = findCycles({ tasks, order });
  if (cyc.length) die(`dependency cycle ${cyc[0].join(' → ')}: the tasks in it would wait on each other forever (use --force)`);
}

const needsReview = (t) => !!(t.review || (t.reviewer && t.reviewer !== 'coordinator'));

function requireTask(state, id) {
  if (!id) die('task id required');
  const t = state.tasks[id] || state.tasks[id.toUpperCase()] || state.tasks['T' + id];
  if (!t) die(`unknown task: ${id}`);
  return t;
}

function nextTaskId(state, parent = null) {
  // outline ids (new plans): a subtask is numbered under its parent, T6 → T6.1, T6.2, …
  if (state.outline_ids && parent) {
    const prefix = parent + '.';
    const re = { exec: (id) => (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)) ? [id, id.slice(prefix.length)] : null) };
    let k = 0;
    for (const id of state.order) {
      const m = re.exec(id);
      if (m) k = Math.max(k, +m[1]);
    }
    return `${parent}.${k + 1}`;
  }
  let n = 0;
  for (const id of state.order) {
    const m = /^T(\d+)$/.exec(id);
    if (m) n = Math.max(n, +m[1]);
  }
  return `T${n + 1}`;
}

/** An id as written by a person ("6.2", "t6") → the task's id, if there is one. */
const canonId = (state, x) => (x && !state.tasks[x] ? [String(x).toUpperCase(), 'T' + x].find((y) => state.tasks[y]) ?? x : x);

function taskFieldsFromFlags(f, state, selfId) {
  f = { ...f };
  if (f.parent) f.parent = canonId(state, f.parent);
  if (f.from) f.from = canonId(state, f.from);
  if (f.dep) f.dep = f.dep.flatMap((x) => String(x).split(',')).map((x) => canonId(state, x.trim()));
  const d = {};
  if (f.title !== undefined) d.title = f.title;
  if (f.desc !== undefined) d.description = f.desc;
  if (f.accept) d.acceptance = f.accept;
  if (f.label) d.labels = f.label.flatMap((l) => l.split(',')).map((s) => s.trim()).filter(Boolean);
  if (f.agent !== undefined) d.agent = f.agent === '-' || f.agent === '' ? null : f.agent;
  if (f.reviewer !== undefined) d.reviewer = f.reviewer === '-' || f.reviewer === '' ? null : f.reviewer;
  if (f.review !== undefined) d.review = !!f.review;
  if (f.from !== undefined) {
    if (!state.tasks[f.from]) die(`unknown task in --from: ${f.from}`);
    d.origin = f.from;
    // a follow-up lands where its origin lives (same work package) unless placed explicitly
    if (f.parent === undefined && state.tasks[f.from].parent) d.parent = state.tasks[f.from].parent;
  }
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
  if (t.changes_requested) bits.push(magenta(`↺ attempt ${t.attempts?.length ?? t.feedback.length + 1}`));
  else if ((t.attempts?.length ?? 1) > 1) bits.push(dim(`attempt ${t.attempts.length}`));
  else if (t.ready) bits.push(green('ready'));
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
    // a task blocked --on other tasks just waits for them: not a matter for anyone
    .filter((t) => (t.status === 'blocked' && !t.blocked_on.length && !t.answered) || t.status === 'review' || t.human_input?.length);
  if (attention.length || state.questions?.length || state.human_input?.length) {
    lines.push('', bold('needs attention:'));
    for (const q of state.questions ?? []) lines.push(`  ${bold('plan')} ${red('question')}${magenta(' for human')} ${q.message}`);
    for (const n of state.human_input ?? []) lines.push(`  ${bold('plan')} ${magenta('human input')}${dim(' for coordinator')} ${n.message}`);
    for (const t of attention) {
      if (t.status === 'review' || (t.status === 'blocked' && !t.blocked_on.length && !t.answered)) {
        const who = t.status === 'review' ? (t.reviewer && t.reviewer !== 'coordinator' ? t.reviewer : 'coordinator') : t.blocked_for ?? 'coordinator';
        lines.push(`  ${t.id} ${badge(t.status)}${who === 'coordinator' ? dim(' for coordinator') : magenta(` for ${who}`)} ${t.last_message || ''}`);
      }
      if (t.human_input?.length) lines.push(`  ${t.id} ${magenta('human input')}${dim(' for coordinator')} ${t.human_input.map((n) => n.message).join(' | ')}`);
    }
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
/**
 * The plan's harness after --harness / --coordinator-model / --coordinator-thinking /
 * --agent-model / --agent-thinking (docs/harness-settings-design.md), onto `cur`; '' or -
 * clears a value (--harness -: all of it). Null: no such flag given.
 */
function harnessFromFlags(cur = null) {
  const keys = ['harness', 'coordinator-model', 'coordinator-thinking', 'agent-model', 'agent-thinking'];
  if (!keys.some((k) => FLAGS[k] !== undefined)) return null;
  const clear = (v) => v === '-' || v === '' || v === true;
  if (FLAGS.harness !== undefined && clear(FLAGS.harness)) return {};
  const h = { kind: cur?.kind ?? null, coordinator: { ...(cur?.coordinator || {}) }, agent: { ...(cur?.agent || {}) } };
  if (FLAGS.harness !== undefined) {
    if (!/^[a-z][\w-]*$/.test(FLAGS.harness)) die(`--harness: an agent kind such as ${Object.keys(AGENT_KINDS).join(', ')}`);
    // another harness: the model settings were the old one's (model ids are a harness's own)
    if (h.kind && h.kind !== FLAGS.harness) (h.coordinator = {}), (h.agent = {});
    h.kind = FLAGS.harness;
  }
  for (const [flag, role, key] of [['coordinator-model', 'coordinator', 'model'], ['coordinator-thinking', 'coordinator', 'thinking'], ['agent-model', 'agent', 'model'], ['agent-thinking', 'agent', 'thinking']]) {
    if (FLAGS[flag] === undefined) continue;
    if (clear(FLAGS[flag])) delete h[role][key];
    else h[role][key] = String(FLAGS[flag]);
  }
  if ((Object.keys(h.coordinator).length || Object.keys(h.agent).length) && !h.kind) die('model and thinking settings belong to a harness: --harness <kind> (model ids are a harness\'s own)');
  const levels = AGENT_KINDS[h.kind]?.levels;
  for (const role of ['coordinator', 'agent']) if (levels && h[role].thinking && !levels.includes(h[role].thinking)) die(`--${role}-thinking: ${h.kind} takes ${levels.join(', ')}`);
  return h;
}
const harnessText = (h) =>
  !h?.kind
    ? ''
    : [h.kind, ...['coordinator', 'agent'].map((r) => (h[r] && Object.keys(h[r]).length ? `${r}: ${[h[r].model, h[r].thinking && `thinking ${h[r].thinking}`].filter(Boolean).join(', ')}` : null))].filter(Boolean).join(' · ');

function renderPlan(state) {
  const L = [renderStatus(state).split('\n').slice(0, 3).join('\n')];
  L.push(dim(`created ${state.created_at?.slice(0, 16).replace('T', ' ')} by ${state.created_by ?? '?'} · updated ${ago(state.updated_at)} · ${state.parent_review ? 'parent_review: parents with criteria are reviewed when their subtasks are done' : 'parents are containers (atf plan update --parent-review on)'}`));
  if (state.status_message) L.push('', bold('status: ') + state.status_message);
  if (state.description) L.push('', state.description);
  if (state.docs?.length) L.push('', bold('documents:') + dim(' (read these first: the plan\'s design and approach)'), ...state.docs.map((d) => `  ${d}`));
  if (state.checkpoint) L.push('', bold('plan checkpoint') + dim(` (${state.checkpoint.actor ?? '?'}, ${ago(state.checkpoint.ts)}):`), state.checkpoint.message);
  if (state.questions?.length) L.push('', bold('open questions for the human:'), ...state.questions.map((q) => `  ${q.message}`));
  const pnotes = state.notes.filter((n) => n.kind !== 'checkpoint' && !(state.questions ?? []).includes(n));
  if (pnotes.length) L.push('', bold('plan notes:'), ...pnotes.slice(-10).map((n) => `  ${n.kind !== 'info' ? yellow(`[${n.kind}] `) : ''}${cyan(n.actor ?? '?')}: ${n.message}`));
  if (state.harness?.kind) L.push('', `${bold('harness:')} ${harnessText(state.harness)}`);
  if (state.session) L.push('', `${bold('coordinator session:')} ${cyan(state.session.actor ?? '?')} ${state.session.kind ?? ''} ${dim(state.session.ref)}`);
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
/** `atf live --watch`: redraw every second until q / ctrl+c / esc. */
function watchLive(render) {
  const draw = () => process.stdout.write('\x1b[H\x1b[2J' + render() + '\n\n' + dim('watching · q quits'));
  process.stdout.write('\x1b[?25l');
  const quit = () => (process.stdout.write('\x1b[?25h\n'), process.exit(0));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on('data', (d) => /[q\x03\x1b]/.test(String(d)) && quit());
  }
  process.on('SIGINT', quit);
  draw();
  setInterval(draw, 1000);
}

/** §14: what runs for a task now and its recorded runs / live files, one line each. */
function liveLines(t, runs, indent = '  ') {
  const live = taskLive(t, runs);
  const col = { ok: green, failed: red, waiting: yellow, running: cyan, gone: dim, unknown: String };
  const L = [];
  for (const r of live.now) L.push(`${indent}${(r.waiting ? yellow : cyan)(r.waiting ? '⧖ waiting' : '⚙ running')} ${dim(elapsed(r.since))} ${r.kind ?? 'cmd'}: ${r.summary.line}${dim('  $ ' + String(r.cmd).split('\n')[0].slice(0, 70))}`);
  for (const a of live.recorded.slice(0, 6)) {
    const s = a.summary;
    const when = a.exit != null ? `exit ${a.exit}${a.duration_ms ? ', ' + elapsed(0, a.duration_ms) : ''}` : a.live ? 'live' : '';
    const rel = path.relative(process.cwd(), a.ref);
    const where = a.cmd && !a.live ? '$ ' + String(a.cmd).split('\n')[0].slice(0, 60) : rel.startsWith('../..') ? a.ref : rel; // the output file: atf show --json
    L.push(`${indent}${(col[s.state] || String)(a.kind)} ${s.line}${when ? dim(' (' + when + ')') : ''}${dim('  ' + where)}`);
    for (const d of s.details.slice(0, 4)) L.push(`${indent}    ${dim(d)}`);
  }
  if (live.earlier.length) L.push(`${indent}${dim(earlierText(live) + ` (atf live ${t.id} --all)`)}`);
  return L;
}
function renderTask(t, state) {
  const L = [];
  if (t.path.length) L.push(dim(breadcrumb(t, state) + ' ›'));
  L.push(`${bold(t.id)} ${badge(t.rollup_status ?? t.status)}  ${bold(t.title)}`);
  if (t.assignee) L.push(`assignee: ${cyan(t.assignee)}${t.children.length ? dim(' (owns this work package)') : ''}`);
  if (t.agent) L.push(`agent:    ${magenta(t.agent)} ${dim('(agent definition to run it with)')}`);
  if (t.reviewer) L.push(`reviewer: ${magenta(t.reviewer)} ${dim('(must approve it, not the coordinator)')}`);
  else if (t.review) L.push(`review:   ${magenta('required')} ${dim(`(finish with atf review ${t.id} -m "what to check", not done)`)}`);
  if (t.origin) L.push(`follow-up of: ${t.origin} ${dim(state.tasks[t.origin]?.title ?? '')}`);
  if (!t.assignee && t.owner) L.push(`owner:    ${cyan(t.owner)} ${dim(`(via package ${[...t.path].reverse().find((id) => state.tasks[id].assignee)})`)}`);
  if (t.followups?.length) L.push(`follow-ups:   ${t.followups.map((id) => `${id}(${state.tasks[id].status})`).join(', ')}`);
  if (t.children.length)
    L.push(`subtasks: ${t.children.map((id) => `${id}(${state.tasks[id].rollup_status ?? state.tasks[id].status}${state.tasks[id].owner && state.tasks[id].owner !== t.owner ? ' @' + state.tasks[id].owner : ''})`).join(', ')}`);
  if (t.status === 'blocked' && !t.blocked_on.length) L.push(`question for: ${t.blocked_for === 'human' ? magenta('the human') : 'the coordinator'}${t.answered ? green('  (answered)') : ''}`);
  if (t.recommend) L.push(`recommended: ${t.recommend} ${dim('(the coordinator)')}`);
  if (t.human_input?.length) L.push(`human input: ${magenta(t.human_input.map((n) => n.message).join(' | '))} ${dim('(for the coordinator, not handled yet)')}`);
  if (t.blocked_on.length) L.push(`blocked on: ${t.blocked_on.map((d) => `${d}(${state.tasks[d]?.rollup_status ?? state.tasks[d]?.status ?? '?'})`).join(', ')}${t.can_resume ? green('  → can resume') : ''}`);
  if (t.deps.length) L.push(`deps:     ${t.deps.map((d) => `${d}(${state.tasks[d]?.rollup_status ?? state.tasks[d]?.status ?? '?'})`).join(', ')}`);
  if (t.labels.length) L.push(`labels:   ${t.labels.join(', ')}`);
  if (t.percent != null && !t.children.length) L.push(`progress: ${t.percent}%`);
  if (t.rollup_percent != null) L.push(`progress: ${t.rollup_percent}% (rolled up)`);
  if (t.attempts?.length > 1 || t.attempts?.[0]?.instructions) {
    // every earlier attempt: who worked on it, how it ended, and the instructions that followed
    L.push('', bold(`attempts (${t.attempts.length}):`));
    for (const a of t.attempts) {
      const cur = a === t.attempts[t.attempts.length - 1];
      if (a.instructions) L.push(`  ${bold(`${a.n}.`)} ${dim(`instructions from ${a.by ?? '?'}:`)} ${cur && t.changes_requested ? magenta(a.instructions) : a.instructions}`);
      const who = a.actors.length ? a.actors.join(', ') : null;
      const end = a.ended ? (a.ended.stopped ? `stopped while ${a.ended.status}` : a.ended.status) : a.started_at ? 'in progress' : 'not started';
      L.push(`  ${a.instructions ? '   ' : bold(`${a.n}.`) + ' '}${who ? cyan(who) + ' ' : ''}${end === 'failed' ? red(end) : dim(end)}${a.ended?.message ? dim(' — ') + a.ended.message : ''}`);
    }
  }
  if (t.steps?.length) L.push('', ...stepsText(t).split('\n').map((l, i) => (i ? l : bold('steps') + dim(l.slice(t.id.length + 6)))));
  if (t.description) L.push('', t.description);
  if (t.acceptance.length) L.push('', bold('acceptance criteria:'), ...t.acceptance.map((a) => `  - [${t.status === 'done' ? 'x' : ' '}] ${a}`));
  if (t.checkpoint && !TERMINAL.has(t.status))
    L.push('', bold('checkpoint') + dim(` (${t.checkpoint.actor ?? '?'}, ${ago(t.checkpoint.ts)}):`), t.checkpoint.message);
  if (t.result) L.push('', bold('result:'), t.result);
  const sess = Object.values(t.sessions || {});
  if (sess.length || t.resume) L.push('', bold('agent context:') + dim(` resume policy ${t.resume_policy}`), ...sess.map((x) => `  ${cyan(x.actor ?? '?')} ${x.kind ?? ''} session ${dim(x.ref)}`));
  const outputs = t.artifacts.filter((a) => !a.live && !a.cmd); // live files and runs: under live
  if (outputs.length) L.push('', bold('artifacts:'), ...outputs.map((a) => `  ${a.kind}: ${a.ref}${a.description ? dim(' — ' + a.description) : ''}`));
  const ll = liveLines(t, state.runs || []);
  if (ll.length) L.push('', bold('live:'), ...ll);
  if (t.notes.length) L.push('', bold('notes:'), ...t.notes.map((n) => `  ${dim(n.ts.slice(11, 19))} ${n.kind !== 'info' ? yellow(`[${n.kind}] `) : ''}${n.relayed ? quoteOf(n.relayed) + (n.message !== n.relayed.quote ? dim(' → ') + n.message : '') : (n.actor ? cyan(n.actor) + ': ' : '') + n.message}`));
  const hist = t.history.slice(-8);
  if (hist.length) {
    L.push('', bold('recent activity:'));
    for (const h of hist) {
      const what =
        h.type === 'status' ? `${h.from} → ${h.to}` : h.type === 'assigned' ? `assigned ${h.assignee ?? '(none)'}` : h.type === 'step' || h.type === 'steps' ? h.type : `progress${h.percent != null ? ` ${h.percent}%` : ''}`;
      L.push(`  ${dim(h.ts.slice(11, 19))} ${h.relayed ? magenta('human') + dim(' via ') + cyan(h.actor) + ' ' : h.actor ? cyan(h.actor) + ' ' : ''}${what}${h.relayed ? dim(` — “${h.relayed.quote}”`) : ''}${h.message && h.message !== h.relayed?.quote ? dim(' — ' + h.message) : ''}`);
    }
  }
  return L.join('\n');
}
function renderEvent(e) {
  const d = e.data || {};
  if (e.type === 'plan.review') return `${dim(`#${e.seq} ${e.ts.slice(11, 19)}`)} ${cyan(e.actor?.id ?? '?')} ${bold('review submitted')} ${d.summary ?? ''}`;
  const upd = e.type === 'task.updated' ? Object.entries(d).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : typeof v === 'object' && v ? JSON.stringify(v) : v}`).join(' ') : null;
  const bits = [
    d.status,
    d.on?.length ? `on ${d.on.join(',')}` : null,
    d.for ? `for ${d.for}` : null,
    d.relayed ? `decided by the human: “${d.relayed.quote}”` : null,
    d.recommend ? `recommends: ${d.recommend}` : null,
    d.changes ? 'changes requested' : null,
    d.fresh ? 'fresh' : null,
    d.early?.length ? `early (${d.early.join(',')} not done)` : null,
    d.percent != null ? `${d.percent}%` : null,
    d.assignee !== undefined ? `→ ${d.assignee ?? '(none)'}` : null,
    upd,
    e.type === 'task.updated' ? null : d.title,
    d.phase ? `snapshot ${d.phase}: ${(d.repos || []).map((r) => r.path).join(', ')}` : null,
    d.kind,
    d.ref,
    d.message,
  ]
    .filter((x) => x !== undefined && x !== null && x !== '');
  return `${dim(`#${e.seq} ${e.ts.slice(11, 19)}`)} ${cyan(e.actor?.id ?? '?')} ${bold(e.type)}${e.task ? ' ' + e.task : ''} ${bits.join(' · ')}`;
}

// ---------- briefs (§13.5) ----------
/** Changed lines per file artifact: from git when the file is in a repo, else its length. */
function fileStats(dir, artifacts) {
  const git = (cwd, args) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
    } catch {
      return null;
    }
  };
  const stats = [];
  const seen = new Set();
  for (const a of artifacts.filter((x) => x.kind === 'file' && !seen.has(x.ref) && seen.add(x.ref))) {
    const abs = path.resolve(dir, a.ref);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      stats.push({ path: a.ref, state: fs.existsSync(abs) ? 'dir' : 'missing' });
      continue;
    }
    const cwd = path.dirname(abs);
    const tracked = git(cwd, ['ls-files', '--error-unmatch', abs]) !== null;
    const lines = () => {
      const txt = fs.readFileSync(abs, 'utf8');
      return txt ? txt.split('\n').length - (txt.endsWith('\n') ? 1 : 0) : 0;
    };
    if (!tracked) {
      stats.push({ path: a.ref, state: git(cwd, ['rev-parse', '--git-dir']) !== null ? 'new' : 'file', added: lines(), removed: 0 });
      continue;
    }
    const [add, del] = (git(cwd, ['diff', '--numstat', 'HEAD', '--', abs]) || '').trim().split(/\s+/);
    stats.push({ path: a.ref, state: add ? 'modified' : 'committed', added: Number(add) || 0, removed: Number(del) || 0 });
  }
  return stats;
}

function renderBrief(b) {
  const L = [];
  const ind = (s) => String(s ?? '').split('\n').map((x) => '  ' + x).join('\n');
  if (b.kind === 'plan') {
    L.push(`${bold('plan')} ${bold(b.title)}`);
    if (b.goal) L.push(dim('goal: ') + b.goal);
    if (b.docs.length) L.push(dim('documents: ') + b.docs.join(', '));
    if (b.finished) L.push('', magenta('finished') + ': all tasks are finished; the plan can be closed (tell the coordinator)');
    else if (!b.questions.length) L.push(dim('no open questions for the human'));
    for (const q of b.questions) L.push('', magenta('question for you') + dim(` (${q.actor ?? '?'}, ${ago(q.ts)})`), ind(q.message));
    return L.join('\n');
  }
  const t = b.task;
  const label = { question: 'question', review: 'review', 'your-review': 'review for you', failed: 'failed', 'plan-question': 'plan question', finished: 'finished', task: t.status }[b.kind] ?? b.kind;
  L.push(`${t.path.length ? dim(t.path.join(' › ') + ' › ') : ''}${bold(t.id)} ${bold(t.title)}  ${magenta(label)}${b.for ? dim(' for ' + b.for) : ''}`);
  if (b.question) {
    const q = b.question;
    L.push('', ind(q.message), dim(`  asked by ${q.asked_by ?? '?'}${q.ts ? ', ' + ago(q.ts) : ''}`));
    if (q.original) L.push(dim(`  originally asked by ${q.original.actor}: `) + q.original.message);
    if (q.recommend) L.push(green('  recommended: ') + q.recommend);
  }
  if (b.review) {
    const r = b.review;
    if (r.submitted) L.push('', dim(`  submitted by ${r.submitted.actor ?? '?'}${r.round > 1 ? ` (round ${r.round})` : ''}: `) + r.submitted.message);
    for (const n of r.notes) L.push(dim(`  ${n.kind}: `) + n.message);
    if (r.assessment) L.push(green('  coordinator: ') + r.assessment);
  }
  if (b.failure) L.push('', red('  failed: ') + (b.failure.message ?? ''));
  if (b.latest) L.push('', dim(`  latest${b.latest.percent != null ? ` (${b.latest.percent}%)` : ''}: `) + b.latest.message);
  if (b.checkpoint) L.push(dim('  checkpoint: ') + b.checkpoint.message);
  if (b.live?.length) L.push('', dim('  live:'), ...b.live);
  if (t.acceptance.length) L.push('', dim('  acceptance:'), ...t.acceptance.map((a) => `    - ${a}`));
  else if (t.description) L.push('', dim('  goal: ') + t.description);
  if (b.files?.length) L.push('', dim('  files: ') + b.files.map((f) => `${f.path}${f.added != null ? ` (+${f.added}${f.removed ? ` -${f.removed}` : ''}${f.state === 'new' ? ', new' : ''})` : ` (${f.state})`}`).join('  '));
  const other = b.artifacts.filter((a) => a.kind !== 'file' && !a.live && !a.cmd);
  if (other.length) L.push(dim('  artifacts: ') + other.map((a) => `${a.kind}: ${a.ref}`).join('  '));
  return L.join('\n');
}

// ---------- relayed decisions (§13.3) ----------
// `--relay "<the human's words>"`: the coordinator records what the human decided in its
// chat. The event stays the coordinator's; data.relayed marks it as the human's decision.
function relayed(actor) {
  if (FLAGS.relay === undefined) return null;
  const quote = String(FLAGS.relay).trim();
  if (!quote) die('--relay needs the human\'s words, verbatim');
  if (actor.role !== 'coordinator' && !FLAGS.force) die('only the coordinator relays the human\'s decisions (the human writes directly as `human`)');
  return { from: HUMAN, quote, via: FLAGS.via || 'chat' };
}
const quoteOf = (r) => (r ? `${magenta('human')} ${dim('(via coordinator)')}: “${r.quote}”` : '');

// ---------- status transitions ----------
function statusCmd(target, msgRequired) {
  return (pos) => {
    const { root, planId, actor } = ctx();
    const relay = relayed(actor);
    if (relay && !['done', 'cancelled', 'todo'].includes(target)) die('--relay applies to done, cancel and reopen (the human\'s decisions), and to note and changes');
    const msg = FLAGS.message || (relay ? relay.quote : undefined);
    if (msgRequired && !msg) die(`-m <message> is required for ${target}`);
    if (FLAGS.recommend !== undefined && target !== 'blocked') die('--recommend only applies to block');
    // a relayed decision is checked as the human's (e.g. approving a review that waits for the human)
    const decider = relay ? { ...actor, id: HUMAN, role: 'human' } : actor;
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      if (FLAGS.for !== undefined && target !== 'blocked') die('--for only applies to block');
      if (FLAGS.for !== undefined && !BLOCK_FOR.includes(FLAGS.for)) die(`--for must be one of ${BLOCK_FOR.join(', ')}`);
      if (FLAGS.for && FLAGS.on) die('--for is for questions; a block --on other tasks waits for them');
      // re-addressing a question or escalating a failure to the human: the coordinator
      // turns a task already blocked (or failed) into a question for the human
      // … or turns a question into a wait on other tasks (e.g. a task for the human: T4
      // asked "please tell the payments team", which is the human's T9 to do; T4 waits on it)
      const readdress = target === 'blocked' && ((FLAGS.for && ['blocked', 'failed'].includes(t.status)) || (FLAGS.on && t.status === 'blocked' && actor.role === 'coordinator'));
      if (!FLAGS.force) {
        if (!readdress && !canTransition(t.status, target)) die(`cannot move ${t.id} from ${t.status} to ${target} (use --force)`);
        if (FLAGS.for === 'human' && actor.role !== 'coordinator' && actor.role !== 'human')
          die('only the coordinator asks the human (block without --for: your question goes to the coordinator, who escalates if needed)');
        if (target === 'in_progress' && t.waiting_on.length && !FLAGS.early)
          die(`${t.id} waits on ${t.waiting_on.join(', ')} (--early starts it anyway, for work that does not need them yet)`);
        if (target === 'in_progress' && t.children.length) die(`${t.id} has subtasks; start those instead (use --force)`);
        // the coordinator does not work on tasks it delegated: this is usually a subagent that
        // shares the coordinator's shell (atf dispatch) and forgot to name itself
        if (['in_progress', 'review'].includes(target) && actor.role === 'coordinator' && t.owner && t.owner !== actor.id)
          die(`${t.id} is ${t.assignee ? 'assigned to' : 'in a work package owned by'} ${t.owner}: if you are ${t.owner}, add \`--as ${t.owner}\` to every atf command (use --force)`);
        // decisions on a task in review (approve = done, reopen) belong to its reviewer
        const reviewing = t.status === 'review' && ['done', 'todo'].includes(target);
        if (reviewing) {
          const why = reviewRefusal(t, decider);
          if (why) die(`${why}${target === 'done' && actor.id === t.owner ? ' (you submitted it; wait for the verdict)' : ''} (use --force)`);
        } else {
          const boss = actor.role === 'coordinator' || actor.role === 'human';
          if (t.owner && t.owner !== actor.id && !boss)
            die(`${t.id} is ${t.assignee ? 'assigned to' : 'in a work package owned by'} ${t.owner} (use --force)`);
          // a task marked for review is approved by its reviewer, not finished by its worker
          if (target === 'done' && needsReview(t) && reviewRefusal(t, decider))
            die(
              actor.id === t.owner || !boss
                ? `${t.id} needs review: finish it with \`atf review ${t.id} -m "what to check"\` instead of done`
                : `${reviewRefusal(t, decider)} (use --force)`,
            );
        }
        if (target === 'blocked' && FLAGS.on)
          for (const d of String(FLAGS.on).split(',').map((x) => x.trim()).filter(Boolean))
            if (st.tasks[d] && TERMINAL.has(st.tasks[d].rollup_status ?? st.tasks[d].status))
              die(`${d} is already ${st.tasks[d].rollup_status ?? st.tasks[d].status}: nothing to wait for (use --force)`);
      }
      const evs = [];
      if (target === 'in_progress' && t.assignee !== actor.id && (!t.assignee || FLAGS.force || t.owner === actor.id))
        evs.push({ type: 'task.assigned', task: t.id, data: { assignee: actor.id } });
      if (FLAGS.by !== undefined) {
        if (target !== 'review') die('--by only applies to review');
        evs.push({ type: 'task.updated', task: t.id, data: { reviewer: FLAGS.by === '-' ? null : FLAGS.by } });
      }
      const early = target === 'in_progress' && FLAGS.early && t.waiting_on.length;
      const data = { status: target, ...(msg || early ? { message: msg || `started early: ${t.waiting_on.join(', ')} not done yet` } : {}), ...(early ? { early: t.waiting_on } : {}) };
      if (FLAGS.for) data.for = FLAGS.for;
      if (FLAGS.recommend) data.recommend = String(FLAGS.recommend);
      if (relay) data.relayed = relay;
      if (FLAGS.on) {
        if (target !== 'blocked') die('--on only applies to block');
        data.on = FLAGS.on.split(',').map((x) => x.trim()).filter(Boolean);
        for (const d of data.on) if (!st.tasks[d]) die(`unknown task in --on: ${d}`);
      }
      evs.push({ type: 'task.status', task: t.id, data });
      return evs;
    });
    const t = requireTask(state, pos[0]);
    out({ ok: true, task: t }, `${t.id} ${badge(t.status)}${t.blocked_for === 'human' ? magenta(' for the human') : ''}${t.assignee ? ' ' + cyan('@' + t.assignee) : ''}${relay ? dim(' · decided by the human (relayed)') : ''}`);
  };
}

/** Steps are the owner's (or the coordinator's) to declare and check off. */
function stepGuard(t, actor) {
  if (FLAGS.force) return;
  const boss = actor.role === 'coordinator' || actor.role === 'human';
  if (t.owner && t.owner !== actor.id && !boss) die(`${t.id} is ${t.assignee ? 'assigned to' : 'in a work package owned by'} ${t.owner} (use --force)`);
}

const STEP_MARK = { todo: '○', in_progress: '◐', done: '✓', skipped: '–' };
/** A task's steps, one per line. */
function stepsText(t) {
  const fin = t.steps.filter((x) => x.status === 'done' || x.status === 'skipped').length;
  return [`${t.id} steps ${fin}/${t.steps.length}`, ...t.steps.map((x) => `  ${x.status === 'done' ? green(STEP_MARK.done) : x.status === 'in_progress' ? yellow(STEP_MARK.in_progress) : dim(STEP_MARK[x.status])} ${x.n}. ${x.status === 'done' || x.status === 'skipped' ? dim(x.title) : x.title}`)].join('\n');
}

// ---------- commands ----------
const commands = {
  config(pos) {
    // TOML config files (src/toml.mjs, src/config.mjs); config.json is still read where no .toml exists
    const sub = pos[0] || 'show';
    if (!['show', 'migrate', 'init'].includes(sub)) die('usage: atf config [migrate | init [user|plugin|project]]');
    const root = process.env.ATF_DIR || findRoot(process.cwd());
    const places = configPlaces(root);
    if (sub === 'init') {
      const what = pos[1] || 'user';
      const place = places.find((p) => p.what === what);
      if (!place) die(what === 'project' ? 'no ATF project here (atf init creates one, with its config)' : `atf config init [user|plugin|project], not ${what}`);
      const old = readConfigFile(place.dir);
      if (old.format === 'json') die(`${old.file} exists in the old format: atf config migrate converts it`);
      const r = initConfigFile(place);
      return out({ ok: true, what, ...r }, r.created ? `created ${r.file}: every option, commented out; uncomment what you want to change` : `${r.file} exists; left as it is`);
    }
    const res = places.map((p) => ({ ...p, ...readConfigFile(p.dir) }));
    const migrated = [];
    if (sub === 'migrate')
      for (const r of res)
        if (r.format === 'json' && !r.error) {
          const file = writeConfigFile(r.dir, r.data, 'config', r.header);
          migrated.push({ what: r.what, from: r.file, to: file });
          Object.assign(r, readConfigFile(r.dir));
        }
    const rows = res.map((r) => ({ what: r.what, file: r.file, format: r.format, error: r.error, keys: Object.keys(r.data) }));
    const line = (r) =>
      `${r.what.padEnd(8)} ${r.file ? r.file : dim(`none: atf config init ${r.what} (${path.join(r.dir, 'config.toml')})`)}` +
      (r.error ? red(`\n         error: ${r.error}`) : r.file ? dim(`  ${Object.keys(r.data).join(', ') || 'empty'}`) : '') +
      (r.format === 'json' && !r.error ? yellow('  (old format: atf config migrate)') : '');
    out(
      { files: rows, ...(sub === 'migrate' ? { migrated } : {}) },
      [...(sub === 'migrate' ? [migrated.length ? migrated.map((m) => green(`migrated ${m.from} → ${m.to}`)).join('\n') : 'nothing to migrate', ''] : []), ...res.map(line)].join('\n'),
    );
  },

  init() {
    // The project is the directory you coordinate from (it may hold several repos, or none).
    const here = path.join(process.cwd(), '.atf');
    if (fs.existsSync(path.join(here, 'plans'))) return out({ ok: true, root: here, existed: true }, `already initialized: ${here}`);
    const parent = findRoot(path.dirname(process.cwd()));
    const root = initRoot(process.cwd());
    const note = parent ? `\nnote: ${parent} is also an ATF project; this directory and everything below it now uses its own` : '';
    out({ ok: true, root, ...(parent ? { parent } : {}) }, `initialized ${root}${note}`);
  },

  plan(pos) {
    const sub = pos.shift() || 'show';
    if (sub === 'new' || sub === 'create') {
      const { root, actor: a0 } = ctx({ needPlan: false });
      // creating a plan makes you its coordinator, unless your role is set explicitly
      const actor = FLAGS.role || process.env.ATF_ROLE ? a0 : { ...a0, role: 'coordinator' };
      const title = pos.join(' ');
      if (!title) die('plan title required');
      const id = FLAGS.id || newPlanId(title);
      if (fs.existsSync(eventsPath(root, id))) die(`plan exists: ${id}`);
      const data = { title };
      if (FLAGS.goal) data.goal = FLAGS.goal;
      if (FLAGS.desc) data.description = FLAGS.desc;
      if (FLAGS.coordinator) data.coordinator = FLAGS.coordinator;
      if (FLAGS.doc) data.docs = FLAGS.doc;
      const harness = harnessFromFlags();
      if (harness?.kind) data.harness = harness;
      data.parent_review = true; // §5.2: parents with criteria of their own are reviewed against them
      // §5.3: a subtask's id is numbered under its parent (T6.2); --ids flat: T1, T2, … as before
      if (FLAGS.ids !== undefined && !['flat', 'outline'].includes(FLAGS.ids)) die('--ids must be flat or outline');
      data.outline_ids = FLAGS.ids !== 'flat';
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
      if (FLAGS.coordinator) data.coordinator = FLAGS.coordinator;
      if (FLAGS.doc) data.docs = FLAGS.doc[0] === '-' ? [] : FLAGS.doc; // replaces the list; --doc - clears it
      if (FLAGS.resume) {
        if (!RESUME_POLICIES.includes(FLAGS.resume)) die(`--resume must be one of ${RESUME_POLICIES.join(', ')}`);
        data.resume = FLAGS.resume;
      }
      if (FLAGS['parent-review'] !== undefined) {
        // §5.2: an older plan (its parents are containers) opts in to parent reviews
        if (!['on', 'off'].includes(FLAGS['parent-review'])) die('--parent-review must be on or off');
        data.parent_review = FLAGS['parent-review'] === 'on';
      }
      const hasHarness = ['harness', 'coordinator-model', 'coordinator-thinking', 'agent-model', 'agent-thinking'].some((k) => FLAGS[k] !== undefined);
      if (!Object.keys(data).length && !hasHarness) die('nothing to update');
      let before;
      const { state } = transact(root, planId, actor, (st) => {
        if (data.parent_review && st.status !== 'active' && !FLAGS.force) die(`the plan is ${st.status}: parent reviews are for a plan still running (use --force)`);
        before = st;
        if (hasHarness) data.harness = harnessFromFlags(st.harness); // onto what the plan has
        return [{ type: 'plan.updated', data }];
      });
      const toReview = state.order.filter((id) => state.tasks[id].children.length && state.tasks[id].status === 'review' && before.tasks[id].status !== 'review');
      return out({ ok: true, review: toReview, ...(data.harness ? { harness: state.harness } : {}) }, `plan updated${data.harness ? ` · harness: ${harnessText(state.harness) || 'none (the launcher’s default)'}` : ''}${toReview.length ? `; in review now (their subtasks are done): ${toReview.join(', ')}` : ''}`);
    }
    if (sub === 'note' || sub === 'ask' || sub === 'checkpoint') {
      // plan-level notes: `ask` = a question for the human about the whole plan;
      // `checkpoint` = where the plan stands (the coordinator's handoff to its next session)
      const { root, planId, actor } = ctx();
      const relay = sub === 'note' ? relayed(actor) : FLAGS.relay !== undefined ? die('--relay applies to plan note') : null;
      const message = pos.join(' ') || FLAGS.message || relay?.quote;
      if (!message) die(`usage: atf plan ${sub} "<text>"${sub === 'note' ? ' [--kind info|question|decision|warning|checkpoint] [--for human] [--relay "<the human\'s words>"]' : ''}`);
      const kind = sub === 'ask' ? 'question' : sub === 'checkpoint' ? 'checkpoint' : FLAGS.kind || (relay ? 'decision' : 'info');
      if (!NOTE_KINDS.includes(kind)) die(`--kind must be one of ${NOTE_KINDS.join(', ')}`);
      const forWho = sub === 'ask' ? 'human' : FLAGS.for;
      if (forWho && !BLOCK_FOR.includes(forWho)) die(`--for must be one of ${BLOCK_FOR.join(', ')}`);
      transact(root, planId, actor, () => [{ type: 'plan.note', data: { kind, message, ...(forWho ? { for: forWho } : {}), ...(relay ? { relayed: relay } : {}) } }]);
      return out({ ok: true }, sub === 'ask' ? `asked the human ${dim('(shown under "needs you"; their answer wakes the coordinator)')}` : dim('ok'));
    }
    if (sub === 'session') {
      // the coordinator's session, so the plan can be resumed with it (launchers record it)
      const { root, planId, actor } = ctx();
      if (!pos[0]) die('usage: atf plan session <ref> [--kind K] [--for ACTOR]');
      transact(root, planId, actor, () => [{ type: 'plan.session', data: { ref: pos[0], ...(FLAGS.kind ? { kind: FLAGS.kind } : {}), ...(FLAGS.for ? { actor: FLAGS.for } : {}) } }]);
      return out({ ok: true }, dim('ok'));
    }
    if (sub === 'status') {
      const { root, planId, actor } = ctx();
      if (!PLAN_STATUSES.includes(pos[0])) die(`plan status must be one of ${PLAN_STATUSES.join(', ')}`);
      // closing a plan is the human's decision: an agent (the coordinator) records theirs
      const relay = relayed(actor);
      const closing = !['active', 'paused'].includes(pos[0]);
      if (closing && !relay && actor.id !== HUMAN && actor.role !== 'human' && !FLAGS.force)
        die(`closing the plan is the human's decision: ask them (in your chat) whether to set it ${pos[0]}; when they agree, record it: atf plan status ${pos[0]} --relay "<their words>" -m "<summary>". They can also close it themselves (the board: c).`);
      transact(root, planId, actor, () => [{ type: 'plan.status', data: { status: pos[0], ...(FLAGS.message || relay ? { message: FLAGS.message || relay.quote } : {}), ...(relay ? { relayed: relay } : {}) } }]);
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
      const fields = taskFieldsFromFlags(FLAGS, st, FLAGS.id ?? null);
      id = FLAGS.id || nextTaskId(st, fields.parent ?? null);
      if (st.tasks[id]) die(`task exists: ${id}`);
      if (fields.deps?.includes(id)) die('task cannot depend on itself');
      const data = { title, ...fields };
      if (FLAGS.assign) data.assignee = FLAGS.assign;
      // agents add tasks inside their own work package (to split work), not elsewhere
      if (!FLAGS.force && actor.role !== 'coordinator' && actor.role !== 'human') {
        const parent = data.parent && st.tasks[data.parent];
        if (!parent || parent.owner !== actor.id)
          die(`as ${actor.role} you can add tasks only inside your own work package (--parent <a task you own>); ask the coordinator for others, e.g. with a note (use --force)`);
      }
      const evs = [{ type: 'task.created', task: id, data }];
      rejectCycles(st, evs);
      return evs;
    });
    out({ ok: true, task: state.tasks[id] }, renderTaskLine(state.tasks[id], state));
  },

  edit(pos) {
    const { root, planId, actor } = ctx();
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      const data = taskFieldsFromFlags(FLAGS, st, t.id);
      if (!Object.keys(data).length) die('nothing to update');
      // outline ids: a task's id says where it sits; moving it would make the id lie
      if (st.outline_ids && data.parent !== undefined && (data.parent ?? null) !== (t.parent ?? null) && !FLAGS.force)
        die(`${t.id}'s id says where it sits in the plan, so it cannot move${data.parent ? ` under ${data.parent}` : ' to the top level'}: cancel it and add it again there (atf cancel ${t.id} -m "moved"; atf add "${t.title}" ${data.parent ? `--parent ${data.parent}` : ''} …), or --force to move it and keep its id`);
      const evs = [{ type: 'task.updated', task: t.id, data }];
      rejectCycles(st, evs);
      return evs;
    });
    const t = requireTask(state, pos[0]);
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
      return out({ ok: true, task: null, remaining: active.length }, active.length ? 'no ready task for you right now' : 'all tasks finished');
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

  feedback(pos) {
    // Review drafts: collect approvals / change requests / notes, then submit them in one go.
    const { root, planId, actor } = ctx();
    const sub = pos[0] || 'list';
    let items = readDrafts(root, planId, actor.id);
    const state = loadPlan(root, planId);
    if (['approve', 'change', 'note'].includes(sub)) {
      const t = requireTask(state, pos[1]);
      const message = pos.slice(2).join(' ') || FLAGS.message || '';
      if (sub !== 'approve' && !message) die(`usage: atf feedback ${sub} <task> "<text>" [--file F --line N]`);
      items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), task: t.id, action: sub, message, ...(FLAGS.file ? { file: FLAGS.file } : {}), ...(FLAGS.line ? { line: Number(FLAGS.line) } : {}), ts: new Date().toISOString() });
      writeDrafts(root, planId, actor.id, items);
      return out({ ok: true, drafts: items }, `${dim('draft')} ${sub} ${t.id}${message ? ': ' + message : ''}  ${dim(`(${items.length} draft${items.length === 1 ? '' : 's'}; atf feedback submit sends them)`)}`);
    }
    if (sub === 'drop') {
      const keep = pos[1] ? items.filter((i) => i.task !== requireTask(state, pos[1]).id) : [];
      writeDrafts(root, planId, actor.id, keep);
      return out({ ok: true, dropped: items.length - keep.length }, `dropped ${items.length - keep.length} draft(s)`);
    }
    if (sub === 'submit') {
      if (!items.length) return out({ ok: true, submitted: 0 }, 'no drafts to submit');
      let summary = '';
      transact(root, planId, actor, (st) => {
        const r = reviewEvents(st, items, actor, { force: !!FLAGS.force });
        if (r.refused.length)
          die(`not submitted (drafts kept): ${r.refused.map((x) => `${x.action} ${x.task}: ${x.why}`).join('; ')}. Drop those drafts (atf feedback drop <task>) or use --force.`);
        summary = r.summary;
        return r.events;
      });
      writeDrafts(root, planId, actor.id, []);
      return out({ ok: true, submitted: items.length, summary }, summary);
    }
    if (sub !== 'list') die('usage: atf feedback [list|approve|change|note|drop|submit]');
    out(items, items.map((i) => `${dim(i.ts.slice(11, 16))} ${i.task.padEnd(4)} ${i.action === 'change' ? magenta('change ') : i.action === 'approve' ? green('approve') : 'note   '} ${i.message}${i.file ? dim(` ${i.file}${i.line ? ':' + i.line : ''}`) : ''}`).join('\n') || 'no drafts');
  },

  changes(pos) {
    // Request changes: send a task in review (or done) back to its owner with feedback.
    const { root, planId, actor } = ctx();
    const relay = relayed(actor);
    const msg = FLAGS.message;
    if (!msg) die(`-m "<what to change>" is required (be concrete; number the points)${relay ? ': your instructions to the next agent; the human\'s words go in --relay' : ''}`);
    if (actor.role === 'human' && !FLAGS.force) {
      // v2: the human's change request goes to the coordinator, which decides what happens
      transact(root, planId, actor, (st) => {
        const t = requireTask(st, pos[0]);
        const evs = [{ type: 'task.note', task: t.id, data: { kind: 'feedback', message: `change request: ${msg}` } }];
        if (st.status !== 'active') evs.push({ type: 'plan.status', data: { status: 'active', message: `reopened: changes requested on ${t.id}` } });
        return evs;
      });
      return out({ ok: true, for: 'coordinator' }, `${pos[0]} change request sent to the coordinator ${dim('(it decides: send it back, a follow-up task, or a plan change)')}`);
    }
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      // a new attempt with new instructions: after review, after done, and after an attempt
      // that failed or went the wrong way (blocked, or in progress with its agent gone)
      if (t.children.length && !FLAGS.force) die(`${t.id} is a parent task: send back the subtask that needs changes, or add one (\`atf add "…" --parent ${t.id}\`); either puts ${t.id} back to work (use --force)`);
      if (!['review', 'done', 'failed', 'blocked', 'in_progress'].includes(t.status) && !FLAGS.force) die(`${t.id} is ${t.status}; changes start a new attempt on a task in review, done, failed, blocked or in progress (use --force)`);
      if (t.status === 'in_progress' && actor.role !== 'coordinator' && !FLAGS.force) die(`${t.id} is in progress; only the coordinator stops an attempt that went the wrong way (use --force)`);
      // v2: the coordinator sends work back, also on behalf of another reviewer (the human
      // tells the coordinator what to change); approving stays the reviewer's
      const why = actor.role === 'coordinator' ? null : reviewRefusal(t, actor);
      if (why && !FLAGS.force) die(`${why} (use --force)`);
      // --fresh: the next attempt (only) starts from a clean agent
      const evs = [{ type: 'task.status', task: t.id, data: { status: 'todo', message: msg, changes: true, ...(FLAGS.fresh ? { fresh: true } : {}), ...(relay ? { relayed: relay } : {}) } }];
      if (st.status !== 'active') evs.push({ type: 'plan.status', data: { status: 'active', message: `reopened: changes requested on ${t.id}` } });
      return evs;
    });
    const t = requireTask(state, pos[0]);
    const prev = t.attempts[t.attempts.length - 2];
    out(
      { ok: true, task: t, attempt: t.attempts.length },
      `${t.id} ${magenta('↺ changes requested')}: attempt ${t.attempts.length}${prev?.ended ? dim(` (attempt ${prev.n} ${prev.ended.stopped ? `stopped while ${prev.ended.status}` : prev.ended.status})`) : ''}${t.owner ? ` → back to ${cyan(t.owner)}` : ''}${FLAGS.fresh ? dim(' · starts fresh') : ''}${t.status === 'todo' && prev?.ended?.stopped && prev.ended.status === 'in_progress' ? dim(' · its agent may still be running: stop it') : ''}`,
    );
  },

  release(pos) {
    const { root, planId, actor } = ctx();
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      if (!FLAGS.force && t.owner && t.owner !== actor.id && actor.role !== 'coordinator' && actor.role !== 'human')
        die(`${t.id} is ${t.assignee ? 'assigned to' : 'in a work package owned by'} ${t.owner}; only they or the coordinator can release it (use --force)`);
      const evs = [];
      if (t.status !== 'todo') evs.push({ type: 'task.status', task: t.id, data: { status: 'todo', ...(FLAGS.message ? { message: FLAGS.message } : {}) } });
      evs.push({ type: 'task.assigned', task: t.id, data: { assignee: null } });
      return evs;
    });
    out({ ok: true, task: requireTask(state, pos[0]) }, `${pos[0]} released`);
  },

  steps(pos) {
    // the parts of a task's work, declared when it starts (a new list replaces the old one;
    // steps with the same title keep their state)
    const { root, planId, actor } = ctx();
    const titles = pos.slice(1).map((x) => String(x).trim()).filter(Boolean);
    if (!pos[0] || !titles.length) die('usage: atf steps <task> "<step>" "<step>" …');
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      if (t.children.length) die(`${t.id} has subtasks: steps are the parts of one task's work`);
      stepGuard(t, actor);
      return [{ type: 'task.steps', task: t.id, data: { steps: titles } }];
    });
    const t = requireTask(state, pos[0]);
    out({ ok: true, steps: t.steps }, stepsText(t));
  },

  step(pos) {
    // check a step off: atf step T3 2 [done|start|skip|todo] [-m note]
    const { root, planId, actor } = ctx();
    const word = { done: 'done', start: 'in_progress', started: 'in_progress', skip: 'skipped', skipped: 'skipped', todo: 'todo' };
    const status = word[pos[2] ?? 'done'];
    if (!pos[0] || !pos[1] || !status) die('usage: atf step <task> <n|title> [done|start|skip|todo] [-m note]');
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      stepGuard(t, actor);
      if (!t.steps.length) die(`${t.id} has no steps: declare them with atf steps ${t.id} "<step>" …`);
      const n = /^\d+$/.test(pos[1]) ? Number(pos[1]) : t.steps.findIndex((x) => x.title.toLowerCase() === String(pos[1]).toLowerCase()) + 1;
      if (!t.steps[n - 1]) die(`${t.id} has ${t.steps.length} steps: ${t.steps.map((x) => `${x.n}. ${x.title}`).join(', ')}`);
      return [{ type: 'task.step', task: t.id, data: { n, status, ...(FLAGS.message ? { message: FLAGS.message } : {}) } }];
    });
    const t = requireTask(state, pos[0]);
    out({ ok: true, steps: t.steps }, stepsText(t));
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
    const relay = relayed(actor);
    const message = pos.slice(1).join(' ') || FLAGS.message || relay?.quote;
    if (!message) die('note message required');
    const kind = FLAGS.kind || (relay ? 'decision' : 'info');
    if (!NOTE_KINDS.includes(kind)) die(`--kind must be one of ${NOTE_KINDS.join(', ')}`);
    const { state } = transact(root, planId, actor, (st) => {
      const t = requireTask(st, pos[0]);
      // a checkpoint is the worker's: see statusCmd (a subagent in the coordinator's shell)
      if (kind === 'checkpoint' && actor.role === 'coordinator' && t.owner && t.owner !== actor.id && !FLAGS.force)
        die(`${t.id} is owned by ${t.owner}: if you are ${t.owner}, add \`--as ${t.owner}\` to every atf command (use --force)`);
      return [{ type: 'task.note', task: t.id, data: { message, kind, ...(relay ? { relayed: relay } : {}) } }];
    });
    const t = state.tasks[pos[0]];
    out({ ok: true, ...(relay ? { answered: !!t?.answered } : {}) }, relay ? `${pos[0]} ${dim('decision recorded as the human\'s (relayed)')}${t?.answered ? green(' · question answered') : ''}` : dim('ok'));
  },

  artifact(pos) {
    const { root, planId, actor } = ctx();
    if (!pos[1]) die('artifact ref required');
    const kind = FLAGS.kind || (fs.existsSync(pos[1]) ? 'file' : /^https?:/.test(pos[1]) ? 'url' : 'other');
    if (!ARTIFACT_KINDS.includes(kind) && !liveKind(kind)) die(`--kind must be one of ${ARTIFACT_KINDS.join(', ')}, or a live kind (atf live-kinds)`);
    // --live: a file the board watches while the task runs (§14); a relative path is
    // made absolute, so every frontend finds it whatever its own directory
    // a URL is not a file to watch (agents register pipeline pages so): an ordinary url artifact
    if (FLAGS.live && /^[a-z]+:\/\//.test(pos[1])) (FLAGS.live = false), (FLAGS.kind ||= 'url');
    const ref = FLAGS.live ? path.resolve(pos[1]) : pos[1];
    const data = { kind: FLAGS.live && !FLAGS.kind ? 'log' : kind, ref, ...(FLAGS.desc ? { description: FLAGS.desc } : {}), ...(FLAGS.live ? { live: true, since: new Date().toISOString() } : {}), ...(FLAGS.cwd ? { cwd: path.resolve(FLAGS.cwd) } : {}) };
    // a file: its repo and HEAD now, so its change can be read from here (§15, artifacts)
    if (data.kind === 'file' && !data.live) {
      const git = fileOrigin(pos[1]);
      if (git) data.git = git;
    }
    // a live file already registered on the task (e.g. by the harness hook): nothing to add
    transact(root, planId, actor, (st) => (data.live && requireTask(st, pos[0]).artifacts.some((a) => a.live && a.ref === ref) ? [] : [{ type: 'task.artifact', task: requireTask(st, pos[0]).id, data }]));
    out({ ok: true }, dim('ok'));
  },

  live(pos) {
    // §14: the live view of a task. Maven: test progress (modules, classes, failures)
    // against the previous run; other kinds: their output. --watch redraws every second
    // (q quits); --run <file> shows one recorded run.
    const { root, planId } = ctx();
    const STY = { bold, dim, red, green, yellow, cyan, magenta, gray: dim, 'bold red': (x) => bold(red(x)), 'bold green': (x) => bold(green(x)), 'bold yellow': (x) => bold(yellow(x)), 'bold cyan': (x) => bold(cyan(x)) };
    const seg = (l) => l.map(([x, st]) => (st && STY[st] ? STY[st](x) : x)).join('');
    const render = () => {
      const state = loadPlan(root, planId);
      const t = requireTask(state, pos[0]);
      const live = taskLive(t, activeRuns(root, planId));
      const W = process.stdout.columns || 100;
      const L = [`${bold(t.id)} ${t.title}  ${dim(t.status)}`];
      const pick = FLAGS.run ? live.all.find((a) => a.ref === path.resolve(FLAGS.run)) : null;
      const runs = pick ? [] : live.now;
      // every run is headed by its kind and whether it runs now or already ran: finished
      // runs stay in view, so it must be clear which is which
      const tag = (k, col) => col(inverse(` ${k} `.padEnd(Math.max(...[...live.now, ...live.recorded].map((a) => a.kind.length), 0) + 2)));
      const STATE = { ok: [green, '✓'], failed: [red, '✗'], waiting: [yellow, '⧖'], running: [cyan, '⚙'], gone: [dim, '–'], unknown: [String, '·'] };
      const ranHead = (a) => {
        const s = a.summary;
        const [col, g] = STATE[s.state] || STATE.unknown;
        const when = a.exit != null ? `finished ${ago(a.ts)} · took ${elapsed(0, a.duration_ms || 0)} · exit ${a.exit}` : a.live ? `live file${s.mtime ? `, written ${ago(new Date(s.mtime).toISOString())}` : ''}` : '';
        return `${col(g)} ${tag(a.kind, col)} ${dim(when)}\n  ${col(s.line)}`;
      };
      if (runs.length) L.push('', bold('now'));
      for (const r of runs) {
        const col = r.waiting ? yellow : cyan;
        L.push(`${col(r.waiting ? '⧖' : '⚙')} ${tag(r.kind, col)} ${dim(`${r.approval ? 'waiting for your approval' : r.waiting ? 'waiting' : 'running'} ${elapsed(r.since)}`)}`, `  ${r.summary.line}`, dim('  $ ' + String(r.cmd).split('\n')[0].slice(0, W - 6)));
        if (liveKind(r.kind)?.view) L.push(...liveView(r, r.summary, { width: W, full: true, active: true }).map(seg));
        else L.push(...(readTail(r.out, 16384) || '').split('\n').filter((x) => x.trim()).slice(-15).map((x) => dim('  │ ') + x.slice(0, W - 4)));
      }
      // nothing running: the chosen run, else the latest maven run, else the latest run
      const rec = pick || (!runs.length && (live.recorded.find((a) => a.kind !== 'log' && !a.live) || live.recorded[0])); // the newest build/tests/pipeline run (newest first), else the newest of all
      if (rec) {
        const s = rec.summary;
        L.push('', bold(rec.exit != null ? 'last run' : 'watched'), ranHead(rec));
        if (rec.cmd) L.push(dim('  $ ' + String(rec.cmd).split('\n')[0].slice(0, W - 6)));
        if (liveKind(rec.kind)?.view) L.push(...liveView(rec, s, { width: W, full: true }).map(seg));
        else L.push(...(readTail(rec.ref, 16384) || '').split('\n').filter((x) => x.trim()).slice(-15).map((x) => dim('  │ ') + x.slice(0, W - 4)));
        L.push('', dim(`output: ${rec.ref}`));
      }
      if (!runs.length && !rec) L.push('', dim('nothing live on this task yet: builds, tests and pipelines its agent runs show here'));
      // the other current runs, then (--all) the history: one line each
      const line = (a) => {
        const [col, g] = STATE[a.summary.state] || STATE.unknown;
        return `${col(g)} ${tag(a.kind, col)} ${a.summary.line}${a.exit != null ? dim(`  exit ${a.exit} · ${ago(a.ts)}`) : a.live ? dim('  live file') : ''}${dim('  --run ' + path.relative(process.cwd(), a.ref))}`;
      };
      const others = live.recorded.filter((a) => a !== rec);
      if (others.length) L.push('', bold('other runs and files'), ...others.map(line));
      if (FLAGS.all && live.earlier.length) L.push('', bold('earlier runs') + dim('  replaced by newer ones'), ...live.earlier.map(line));
      else if (live.earlier.length) L.push('', dim(`${earlierText(live)} (--all lists them)`));
      return L.join('\n');
    };
    // kinds that fetch data (refresh): fetch it before the one-shot view
    const first = taskLive(requireTask(loadPlan(root, planId), pos[0]), activeRuns(root, planId));
    return Promise.all([...first.now, ...first.all].map((x) => refreshLive(x).catch(() => null))).then(() => {
      if (!FLAGS.watch || FLAGS.json) return out(taskLive(requireTask(loadPlan(root, planId), pos[0]), activeRuns(root, planId)), render());
      enableAutoRefresh(); // redraws pick up new data as it arrives
      watchLive(render);
    });
  },

  'live-kinds'() {
    // the live kinds: built-in and from plugins (~/.config/atf/live, $ATF_LIVE_PLUGINS)
    const k = liveKinds();
    out(k, [
      ...k.kinds.map((d) => `${bold(d.kind.padEnd(10))} ${d.source === 'built-in' ? dim('built-in') : cyan(d.source)}${d.replaces ? yellow(` (replaces ${d.replaces === 'built-in' ? 'the built-in' : d.replaces})`) : ''}${d.waiting ? yellow('  waiting') : ''}${d.record ? dim(`  recorded as ${d.record}`) : ''}\n           ${dim(d.has.join(' · '))}${d.description ? '\n           ' + d.description : ''}`),
      ...(k.errors.length ? ['', red('plugins that failed to load:'), ...k.errors.map((e) => `  ${e.file}: ${e.error}`)] : []),
      '',
      dim(`plugins: $ATF_LIVE_PLUGINS, ~/.config/atf/live/*.mjs  ·  trying one: atf live-try <kind|file.mjs> <output>`),
      dim(`writing one (a guide for agents too): ${path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'docs', 'live-plugins.md')}`),
      dim(`examples: ${path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'examples', 'live-plugins')}`),
    ].join('\n'));
  },

  async 'live-try'(pos) {
    // try a kind (or a plugin file) on a saved output, without an agent: match, summarize,
    // refresh, view, open, as the board would. For writing plugins (docs/live-plugins.md).
    if (!pos[0] || !pos[1]) die('usage: atf live-try <kind|plugin.mjs> <output-file> [--cmd C] [--cwd D] [--exit N] [--active] [--no-refresh] [--width W]');
    let kind = pos[0];
    if (/\.(mjs|js)$/.test(kind)) {
      const before = new Set(liveKinds().kinds.map((d) => `${d.kind}|${d.source}`));
      const res = await loadLiveKinds({ files: [path.resolve(kind)] });
      const err = res.errors.find((e) => e.file === path.resolve(kind));
      if (err) die(`${kind}: ${err.error}`);
      kind = res.kinds.find((d) => d.source === path.resolve(kind) && !before.has(`${d.kind}|${d.source}`))?.kind ?? res.kinds.find((d) => d.source === path.resolve(kind))?.kind;
      if (!kind) die(`${pos[0]}: no kind registered`);
    } else await loadLiveKinds();
    if (!liveKind(kind)) die(`unknown kind ${kind} (atf live-kinds)`);
    const file = path.resolve(pos[1]);
    if (!fs.existsSync(file)) die(`no such file: ${pos[1]}`);
    const x = { kind, ref: file, cwd: FLAGS.cwd ? path.resolve(FLAGS.cwd) : process.cwd(), cmd: FLAGS.cmd ?? null, exit: FLAGS.exit != null ? Number(FLAGS.exit) : null, active: !!FLAGS.active, since: new Date(fs.statSync(file).mtimeMs - 3600_000).toISOString() };
    const W = Number(FLAGS.width) || process.stdout.columns || 100;
    const L = [];
    if (FLAGS.cmd) {
      const got = classify(FLAGS.cmd, x.cwd);
      L.push(`${bold('match')}    ${got === kind ? green('✓ ' + kind) : red(`✗ the command is classified as ${got ?? 'an ordinary command'}`)}  ${dim('$ ' + FLAGS.cmd)}`);
    }
    let fetched = null;
    if (liveKind(kind).refresh && !FLAGS['no-refresh']) {
      const t0 = Date.now();
      fetched = await refreshLive(x, { force: true });
      const err = refreshError(x);
      L.push(`${bold('refresh')}  ${err ? red('failed: ' + err) : fetched == null ? yellow('no data (refresh returned nothing)') : green('ok')} ${dim(`${Date.now() - t0} ms`)}${fetched != null ? dim('  ' + JSON.stringify(fetched).slice(0, W - 30)) : ''}`);
    }
    const sum = summarizeText(kind, readTail(file, liveKind(kind).tailBytes ?? 256 << 10) ?? '', { cwd: x.cwd, cmd: x.cmd, exit: x.exit, active: x.active, file, since: 0, until: Infinity, extra: {}, fetched });
    const STY = { bold, dim, red, green, yellow, cyan, magenta, gray: dim, 'bold red': (s) => bold(red(s)), 'bold green': (s) => bold(green(s)), 'bold yellow': (s) => bold(yellow(s)), 'bold cyan': (s) => bold(cyan(s)) };
    const seg = (l) => l.map(([t, st]) => (st && STY[st] ? STY[st](t) : t)).join('');
    L.push(`${bold('summary')}  ${sum.state.padEnd(8)} ${sum.line}`, dim(`         counts ${JSON.stringify(sum.counts).slice(0, W - 20)}`));
    for (const d of sum.details) L.push(dim('         · ') + d);
    const full = liveView(x, sum, { width: W, full: true, active: x.active });
    L.push('', bold('view') + dim(liveKind(kind).view ? '' : '  (no view: the board shows the details)'), ...full.map(seg));
    if (liveKind(kind).view) L.push('', bold('compact') + dim('  (the board\'s task details; aim for ≤ 8 lines)'), ...liveView(x, sum, { width: W, full: false, active: x.active }).map(seg));
    const items = full.filter((l) => l.item != null).map((l) => l.item);
    if (items.length) L.push('', bold('item') + dim(`  ${items[0]} (⏎ on it in the live view; ${items.length} item${items.length === 1 ? '' : 's'})`), ...(liveItem(x, sum, items[0], { width: W }) || [[['  (no item function)', 'dim']]]).map(seg));
    const op = liveKind(kind).open ? liveKind(kind).open(sum, { cwd: x.cwd, cmd: x.cmd, file, exit: x.exit, extra: {} }) : null;
    L.push('', `${bold('open')}     ${op?.url ? 'browser ' + op.url : op?.file ? 'file ' + op.file : dim(liveKind(kind).view ? 'o in the live view opens the viewer (atf live)' : 'o in the live view opens the output')}`);
    out({ kind, match: FLAGS.cmd ? classify(FLAGS.cmd, x.cwd) : null, fetched, summary: sum, open: op }, L.join('\n'));
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

  spawn() {
    return viaBackend('spawn');
  },
  coordinate() {
    return viaBackend('coordinate');
  },
  dispatch(pos) {
    // Delegate a task to a subagent of the coordinator's own harness (Copilot's or Claude
    // Code's background subagents): assign it and print the prompt to give that subagent.
    // The subagent shares the coordinator's environment, so the prompt has it name itself
    // (`--as`) on every atf command. In herdr use `atf-herdr spawn` instead.
    const { root, planId, actor } = ctx();
    if (actor.role !== 'coordinator' && !FLAGS.force) die('only the coordinator dispatches tasks (use --force)');
    const s = loadPlan(root, planId);
    const t = requireTask(s, pos[0]);
    const eff = t.rollup_status ?? t.status;
    if (['done', 'cancelled'].includes(eff)) die(`${t.id} is already ${eff}`);
    if (!t.children.length && t.status === 'todo' && !t.ready && !FLAGS.early)
      die(`${t.id} is not ready (waits on ${t.waiting_on.join(', ')}); --early starts it anyway for work that does not need them yet`);
    const name = String(FLAGS.name || t.assignee || `w-${t.id}`)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^[^a-z]+/, 'w-')
      .slice(0, 32);
    if (name === actor.id || name === HUMAN) die(`--name ${name}: pick a name for the subagent`);
    const isPackage = t.children.length > 0;
    if (t.assignee !== name && !(t.owner === name && !isPackage))
      transact(root, planId, actor, () => [{ type: 'task.assigned', task: t.id, data: { assignee: name } }]);
    const fresh = loadPlan(root, planId);
    const leaf = isPackage
      ? fresh.order.map((id) => fresh.tasks[id]).find((x) => !x.children.length && x.path.includes(t.id) && (x.ready || x.can_resume || x.answered)) || fresh.tasks[t.id]
      : fresh.tasks[t.id];
    const prompt = buildPrompt({ s: fresh, t: leaf, name, mode: 'fresh', pkg: isPackage ? fresh.tasks[t.id] : null, kindCfg: { nativeSkill: true }, early: !!FLAGS.early, inSession: true });
    out(
      { ok: true, task: t.id, name, prompt },
      `${dim(`${t.id} assigned to ${name}. Start a background subagent named ${name} with this prompt, unchanged:`)}\n\n${prompt}`,
    );
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
        // what needs someone now, then the human's own tasks (theirs to do, listed after)
        for (const it of [...driverInbox(st), ...humanTasks(st)]) if (!FLAGS.for || it.for === FLAGS.for) items.push({ project: projectName(root), root, plan: id, plan_title: st.title, title: it.task ? st.tasks[it.task].title : null, ...it });
      }
    items.sort((a, b) => (a.kind === 'your-task') - (b.kind === 'your-task') || (a.ts || '').localeCompare(b.ts || ''));
    const color = { review: magenta, 'your-review': magenta, question: red, 'plan-question': red, failed: red, finished: green, 'your-task': cyan };
    const line = (i) => `${(color[i.kind] || String)(i.kind.padEnd(13))} ${(i.for === 'coordinator' ? dim : magenta)(('for ' + i.for).padEnd(16))} ${dim(i.project + ' / ' + i.plan_title)}  ${i.task ? bold(i.task) + ' ' + i.title : ''}${i.kind === 'your-task' ? (i.waiting.length ? dim(` — ${i.waiting.join(', ')} wait${i.waiting.length === 1 ? 's' : ''} on it`) : '') : i.message ? dim(' — ' + i.message) : ''} ${dim(ago(i.ts))}`;
    out(items, items.map(line).join('\n') || 'inbox empty');
  },

  brief(pos) {
    // §13.5: what a human needs to act on one request (a task, or `plan` for the plan's
    // open questions): the same content for every frontend (pi peek, Copilot /atf, …)
    const { root, planId } = ctx();
    const state = loadPlan(root, planId);
    const which = pos[0] && pos[0] !== 'plan' ? requireTask(state, pos[0]).id : null;
    const b = brief(state, which);
    if (b.artifacts) b.files = fileStats(path.dirname(root), b.artifacts);
    if (which) b.live = liveLines(state.tasks[which], activeRuns(root, planId), '    ');
    out(b, renderBrief(b));
  },

  async diff(pos) {
    // §15: the changed files of a task, a work package or the plan, and their combined diff
    const { root, planId } = ctx();
    const state = loadPlan(root, planId);
    const id = pos[0] && pos[0] !== 'plan' ? requireTask(state, pos[0]).id : null;
    const proj = path.dirname(root);
    const mode = changeMode(readConfig(root));
    const changes = await planChanges(proj, state, { mode });
    let sets = levelSets(changes, id);
    if (FLAGS.file) sets = onlyFile(sets, proj, FLAGS.file);
    const what = id ? `${id} ${state.tasks[id].title}` : `plan ${state.title}`;
    if (FLAGS.open) {
      const cmd = viewerCommand(sets, FLAGS.tool || diffTool());
      if (!cmd) die(`no changes for ${what}`);
      if (FLAGS.json) return out({ ok: true, command: cmd, sets });
      const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit', cwd: proj });
      process.exit(r.status ?? 1);
    }
    if (FLAGS.patch) {
      const p = await patchText(sets, { color: tty });
      return out({ ok: true, patch: p }, p || `no changes for ${what}`);
    }
    const tot = totals(sets);
    const L = [`${bold(what)}  ${dim(`${tot.files} file${tot.files === 1 ? '' : 's'}`)} ${green('+' + tot.added)} ${red('-' + tot.removed)}  ${dim(`(${mode})`)}`];
    if (!sets.length) L.push(dim(mode === 'snapshots' ? '  no changes recorded (snapshots are taken when a task starts and when it is finished)' : '  no changes reported (file, commit and branch artifacts)'));
    for (const s of sets) {
      L.push(dim(`  ${s.rel === '.' ? path.basename(s.repo) : s.rel}: ${s.base.slice(0, 8)}..${s.target ? s.target.slice(0, 8) : 'working tree'}${s.branch ? ` (branch ${s.branch})` : ''}`));
      for (const f of s.files) L.push(`    ${f.status} ${projectPath(s, f)} ${f.binary ? dim('binary') : `${green('+' + f.added)} ${red('-' + f.removed)}`}${(!id || state.tasks[id].children.length) && f.tasks?.length ? dim('  ' + f.tasks.join(',')) : ''}`);
      if (s.overlap?.length) L.push(yellow(`    overlaps ${s.overlap.join(', ')} in time: ${s.narrowed ? 'narrowed to the files it reported' : 'may include their changes'}`));
    }
    out({ ok: true, mode, task: id, totals: tot, sets }, L.join('\n'));
  },

  whoami() {
    // who ATF thinks you are, and why: identity, role (and its source), plan, harness
    const { root, planId, actor, roleSource } = ctx({ needPlan: false });
    const st = planId && fs.existsSync(eventsPath(root, planId)) ? loadPlan(root, planId) : null;
    const info = { actor: actor.id, role: actor.role, role_source: roleSource, plan: planId ?? null, plan_title: st?.title ?? null, coordinator: st?.coordinator ?? null, root, harness: actor.harness, ctx: actor.ctx ?? {} };
    out(info, [
      `you are   ${bold(actor.id)} ${dim(process.env.ATF_ACTOR || FLAGS.as ? '' : '(default: $USER; set $ATF_ACTOR or --as to change)')}`,
      `role      ${actor.role === 'coordinator' ? green(actor.role) : bold(actor.role)} ${dim('(' + roleSource + ')')}`,
      `plan      ${planId ? `${planId}${st ? ` "${st.title}" · coordinator ${st.coordinator ?? '?'}` : ' (not found)'}` : dim('none (set $ATF_PLAN, --plan, or atf plan new)')}`,
      `harness   ${actor.harness}${Object.keys(actor.ctx || {}).length ? dim('  ' + Object.entries(actor.ctx).map(([k, v]) => `${k}=${v}`).join(' ')) : ''}`,
    ].join('\n'));
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
    state.runs = activeRuns(root, planId);
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
    // --new: a harness waits for the agent while it is idle and wakes it with the report;
    // only what the last report did not contain counts (no wake loop on an item left open)
    const onlyNew = !!FLAGS.new && !explicit;
    // $ATF_WAKE (set by such a harness, naming its arm file): the agent's own wait does not
    // block; it reports what is there and arms the harness, which wakes the agent later
    const wake = !onlyNew && !FLAGS.since && process.env.ATF_WAKE && actor.role === 'coordinator' ? process.env.ATF_WAKE : null;
    const armWake = () => {
      try {
        fs.writeFileSync(wake, JSON.stringify({ root, plan: planId, actor: actor.id, role: actor.role, at: new Date().toISOString() }));
      } catch {}
    };
    const seen = onlyNew ? readSeen(root, planId, actor.id) : null;
    if (onlyNew) registerWaiter(root, planId, actor.id);
    const now0 = loadPlan(root, planId);
    // Where to report from. Explicit --since wins. Otherwise (default mode) from this
    // actor's cursor, i.e. where its previous wait left off, so nothing that happened
    // between two waits is lost; first time: from the actor's own last action.
    // Where to report from: --since; else this actor's cursor (where its previous wait
    // left off); else its own last action; a brand-new actor (no cursor, no own events)
    // starts now: it has nothing to catch up on (attention is level-triggered anyway).
    const lastOwn = () => readEvents(root, planId).reduce((m, e) => (e.actor?.id === actor.id ? e.seq : m), 0);
    const startSeq = FLAGS.since !== undefined ? Number(FLAGS.since) : explicit ? now0.last_seq : (readCursor(root, planId, actor.id) ?? (lastOwn() || now0.last_seq));
    const leaves = (st) => st.order.map((id) => st.tasks[id]).filter((t) => !t.children.length);

    const keyOf = (a) => `${a.task ?? 'plan'}:${a.reason}`;
    const finish = (st, attention, events, note) => {
      fs.unwatchFile(p);
      if (!explicit) {
        writeCursor(root, planId, actor.id, st.last_seq); // seen up to here
        writeSeen(root, planId, actor.id, [...attention.map(keyOf), ...(note ? [`note:${note}`] : [])]);
      }
      if (wake && !explicit) armWake();
      const human = [
        note,
        ...attention.map((a) =>
          a.reason === 'human' && !a.task
            ? `${bold('plan')} ${magenta('human')}  ${st.human_input.map((n) => n.message).join(' | ')} ${dim('(the human wrote on the plan)')}`
            : `${bold(a.task)} ${['ready', 'unblocked', 'dispatch'].includes(a.reason) ? green(a.reason) : magenta(a.reason)}${a.reason === 'changes' ? dim(' (see atf show: feedback)') : ''}  ${st.tasks[a.task]?.title ?? ''}${a.reason === 'unblocked' ? dim(` (was blocked on ${st.tasks[a.task].blocked_on.join(',')}: start a new agent for it)`) : ''}${a.reason === 'human' ? dim(` (the human wrote: ${st.tasks[a.task].human_input.map((n) => n.message).join(' | ').slice(0, 200)}; decide and act, then reply or note on the task)`) : ''}`,
        ),
        ...events.map(renderEvent),
      ].filter(Boolean);
      out({ ok: true, attention, events, cursor: st.last_seq, ...(note ? { note } : {}) }, human.join('\n'));
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
      const isCoord = actor.role === 'coordinator';
      // v2: only the coordinator waits; a subagent finishes and exits, and the coordinator
      // starts a new instance when there is more for its task
      if (!isCoord)
        return finish(st, [], [], 'subagents do not wait: finish your task with `atf done`, `atf review` or `atf block` (write a checkpoint note first if work is left), then end. The coordinator starts a new agent when there is more to do.');
      const attention = attentionFor(st, actor.id, actor.role);
      // An event about a task counts as handled once this actor wrote anything about that
      // task afterwards (e.g. it was woken by a message and acted): do not repeat it.
      const ownLastOnTask = {};
      for (const e of readEvents(root, planId)) if (e.actor?.id === actor.id && e.task) ownLastOnTask[e.task] = e.seq;
      const hits = evs.filter((e) => !(e.task && (ownLastOnTask[e.task] ?? 0) > e.seq)).filter(
        (e) =>
          e.actor?.id !== actor.id &&
          // a dependency block (`block --on`) is the owner's business, not a decision for the coordinator
          ((isCoord && e.type === 'task.status' && ['done', 'failed'].includes(e.data?.status)) ||
            // reviews for someone else (e.g. the human) are not the coordinator's to handle
            (isCoord && e.type === 'task.status' && e.data?.status === 'review' && !reviewRefusal(st.tasks[e.task] ?? { id: e.task }, actor)) ||
            (isCoord && e.type === 'task.status' && e.data?.status === 'blocked' && !e.data?.on?.length && e.data?.for !== 'human') ||
            (isCoord && e.type === 'plan.review') ||
            // the human talks to the coordinator: answers, change requests, remarks (§12.5)
            (isCoord && e.actor?.id === HUMAN && ['task.note', 'plan.note'].includes(e.type)) ||
            // events on tasks this actor owns; an approval (done by someone else) leaves it
            // nothing to do, so it is not reported (cancel/fail by others are: stop working)
            (e.task && st.tasks[e.task]?.owner === actor.id && ['task.status', 'task.note', 'task.assigned', 'task.updated'].includes(e.type) && !(e.type === 'task.status' && e.data?.status === 'done'))),
      );
      // only the latest status change per task: "T8 review" then "T8 done" reports just done
      const lastStatus = {};
      for (const e of hits) if (e.type === 'task.status') lastStatus[e.task] = e.seq;
      const news = hits.filter((e) => e.type !== 'task.status' || lastStatus[e.task] === e.seq);
      const allDone = isCoord && leaves(st).length && leaves(st).every((t) => TERMINAL.has(t.status));
      if (onlyNew) {
        // wake for news, or for an attention item the last report did not have; the report
        // then lists everything that needs the actor, old and new
        const fresh = attention.filter((a) => !seen.has(keyOf(a)));
        if (news.length || fresh.length) return finish(st, attention, news);
        if (allDone && !seen.has('note:all tasks are finished: ask the human whether to close the plan (closing is their decision)')) return finish(st, attention, [], 'all tasks are finished: ask the human whether to close the plan (closing is their decision)');
        return;
      }
      if (attention.length || news.length) return finish(st, attention, news);
      if (allDone) return finish(st, [], [], 'all tasks are finished: ask the human whether to close the plan (closing is their decision)');
    };

    evaluate(); // return at once if something already needs you
    if (wake) {
      // nothing right now: do not block the agent (it stays promptable and shows as idle)
      armWake();
      out({ ok: true, armed: true, attention: [], events: [] }, 'nothing needs you right now. End your turn: you will be woken with the report when something does (the human can still prompt you meanwhile).');
      process.exit(0);
    }
    fs.watchFile(p, { interval: 300 }, evaluate);
    if (timeout)
      setTimeout(() => {
        fs.unwatchFile(p);
        const st = loadPlan(root, planId);
        if (!explicit) writeCursor(root, planId, actor.id, st.last_seq); // nothing relevant up to here
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
      if (t.status === 'done' && t.waiting_on.length) {
        // only a problem if the dep was unfinished when this task was done; a dep that was
        // finished then and sent back later (review) is normal
        const doneSeq = [...t.history].reverse().find((h) => h.type === 'status' && h.to === 'done')?.seq ?? Infinity;
        const finishedBefore = (d) => (state.tasks[d]?.children.length ? true : state.tasks[d]?.history.some((h) => h.type === 'status' && TERMINAL.has(h.to) && h.seq < doneSeq));
        const bad = t.waiting_on.filter((d) => !finishedBefore(d));
        if (bad.length) problems.push(`${t.id}: done while deps unfinished (${bad.join(',')})`);
      }
    }
    out({ ok: problems.length === 0, problems }, problems.length ? problems.map((x) => red('✗ ') + x).join('\n') : green('✓ valid'));
    if (problems.length) process.exitCode = 1;
  },
};

/**
 * `atf spawn` / `atf coordinate`: started by the backend that runs agents here (src/launch.mjs
 * backendName). herdr: its adapter's command, with every argument as given.
 */
function viaBackend(cmd) {
  const backend = backendName(process.env, sessionsDaemonUp);
  const bins = { herdr: '../adapters/herdr/atf-herdr.mjs', sessions: './atf-sessions.mjs' };
  if (bins[backend]) {
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), bins[backend]);
    try {
      execFileSync(process.execPath, [bin, cmd, ...process.argv.slice(3)], { stdio: 'inherit' });
      process.exit(0);
    } catch (e) {
      process.exit(e.status ?? 1);
    }
  }
  if (backend) die(`atf ${cmd}: unknown backend "${backend}" ($ATF_BACKEND)`);
  die(`atf ${cmd} needs a place to run agents in: herdr (run inside herdr) or ATF's session daemon (atf-sessions start). Without either, delegate to your harness's own subagents: atf dispatch <task> --name <agent>`);
}

// ---------- main ----------
try {
  // their arguments are the backend's (atf-herdr's flags): passed on as given, not parsed here
  if (['spawn', 'coordinate'].includes(process.argv[2]) && !['--help', '-h'].includes(process.argv[3])) viaBackend(process.argv[2]);
  const { pos, flags } = parseArgs(process.argv.slice(2));
  FLAGS = flags;
  const cmd = pos.shift();
  if (!cmd || flags.help || cmd === 'help') {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const handler = commands[cmd];
  if (!handler) die(`unknown command: ${cmd} (see atf help)`);
  // live kinds from plugins (docs/live-plugins.md) for the commands that show or record them
  if (['show', 'brief', 'live', 'live-kinds', 'artifact'].includes(cmd)) await loadLiveKinds();
  await handler(pos);
} catch (e) {
  report(e.message);
}
