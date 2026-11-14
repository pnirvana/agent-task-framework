# ATF Protocol — v1

The Agent Task Framework (ATF) defines how agents **describe** work (plans and tasks)
and **report progress** on it, in a form that is independent of any agent harness and
can be consumed by any frontend.

The protocol is the contract. `bin/atf.mjs` is a reference writer; `src/core.mjs` is a
reference reader. Anything that appends conforming events (a shell script, a pi
extension, an MCP server, a Python harness) is a valid participant.

## 1. Design principles

1. **Event-sourced.** Each plan is one append-only JSONL log. Current state is a pure
   fold over the log. Nobody edits state in place.
2. **Files, not services.** No daemon, no ports, no DB. Agents only need a shell and a
   shared filesystem. Frontends watch a file.
3. **Strict writers, lenient readers.** Writers validate transitions and ownership;
   readers apply whatever is in the log and never fail on unknown data.
4. **Harness-agnostic identity.** An actor is a string id plus optional opaque harness
   context (`ctx`) that frontends may use, e.g. to jump to a herdr pane.

## 2. Storage layout

```
<project>/.atf/
  config.json                 {"protocol": 1}
  current                     id of the default plan (optional convenience)
  plans/<plan-id>/
    events.jsonl              SOURCE OF TRUTH — append-only
    state.json                derived snapshot (cache; may be stale or absent)
    .lock/                    transient writer lock (directory)
```

**Root discovery** (first match wins):
1. `$ATF_DIR`
2. nearest ancestor directory containing `.atf/`
3. `.atf/` next to the main git worktree (so agents in `git worktree`s share one board)

**Plan selection:** explicit `--plan`, then `$ATF_PLAN`, then `.atf/current`.

## 3. Event envelope

One JSON object per line, UTF-8, `\n`-terminated.

```json
{
  "v": 1,
  "seq": 17,
  "id": "ev_3f9a1c2b7d10",
  "ts": "2026-11-13T09:16:29.412Z",
  "plan": "add-oauth-login-daf8",
  "type": "task.status",
  "task": "T3",
  "actor": {
    "id": "worker-1",
    "role": "subagent",
    "harness": "herdr",
    "ctx": { "herdr_pane": "w1:p3", "herdr_workspace": "w1" }
  },
  "data": { "status": "done", "message": "POST /auth/callback implemented + tests" }
}
```

| field   | req | meaning |
|---------|-----|---------|
| `v`     | ✓ | protocol version (`1`) |
| `seq`   | ✓ | per-plan, strictly increasing, gapless; assigned under the lock |
| `id`    | ✓ | globally unique event id (for dedup when merging logs) |
| `ts`    | ✓ | ISO-8601 UTC |
| `plan`  | ✓ | plan id (== directory name) |
| `type`  | ✓ | see §4 |
| `task`  | task.* | task id the event applies to |
| `actor` | ✓ | `{id, role?, harness?, ctx?}`. `role` is conventionally `coordinator` or `subagent`; `ctx` is opaque string map |
| `data`  | ✓ | type-specific payload (may be `{}`) |

JSON Schema: [`schema/event.schema.json`](schema/event.schema.json).

## 4. Event types

### Plan events
| type | data |
|------|------|
| `plan.created` | `{title, goal?, description?, labels?, coordinator?, docs?, meta?}` (`coordinator` defaults to the creating actor; `docs`: the plan's documents, §12.7) |
| `plan.updated` | any subset of the above (shallow replace) |
| `plan.status`  | `{status: active\|paused\|completed\|failed\|cancelled, message?}` |
| `plan.review`  | `{summary, items: [{task, action: approve\|change\|note, message, file?, line?}]}`: one submitted review batch |
| `plan.note`    | `{kind: info\|question\|decision\|warning\|checkpoint, message, for?: human}`: plan-level note; `checkpoint` = the coordinator's handoff, `question` + `for: human` = a question for the human (§12) |
| `plan.session` | `{ref, kind?, actor?}`: the coordinator's session, for resuming the plan (§12.6) |

### Task events
| type | data | notes |
|------|------|-------|
| `task.created`  | `{title, description?, acceptance?: string[], deps?: id[], parent?: id, labels?: string[], priority?: number, assignee?: string, agent?: string, origin?: id, reviewer?: string, review?: boolean, meta?: object}` | `agent`: name of the agent definition to run the task with (opaque; resolved by the launcher, e.g. a pi agent named `reviewer`) |
| `task.updated`  | any subset of the definition fields | lists are replaced, not merged |
| `task.assigned` | `{assignee: string\|null}` | `null` = unassign |
| `task.status`   | `{status, message?, on?: id[], for?: coordinator\|human, changes?: true}` | `message` on `done` is the task's **result summary**; `on` with `blocked`: tasks it is blocked on; `for` with `blocked` (no `on`): who must answer the question (default the coordinator; `human`: escalated, §12.4); `changes` with `todo`: **changes requested** from review (`message` is the coordinator's instructions) |
| `task.progress` | `{message?, percent?: 0..100}` | heartbeat / milestone |
| `task.note`     | `{message, kind?: info\|question\|decision\|warning\|checkpoint}` | `checkpoint`: where the work stands (done / left / how to verify) |
| `task.artifact` | `{kind: file\|commit\|branch\|pr\|url\|other, ref, description?}` | pointer to an output |
| `task.session`  | `{ref, kind?, actor?}` | opaque reference to an agent session that worked on the task (§9) |

### Extension events
Types starting with `x.` (e.g. `x.herdr.focus`, `x.mycorp.cost`) are reserved for
vendor extensions. Readers MUST ignore types they don't understand.

## 5. Task model

### 5.1 Status state machine

```
             ┌──────────── reopen / retry ───────────────┐
             ▼                                            │
  todo ──► in_progress ──► review ──► done ───────────────┤
   │  ▲      │   ▲   │        │                           │
   │  │      ▼   │   └─────► failed ──────────────────────┤
   │  └──── blocked                                       │
   └──────────────────────────────► cancelled ────────────┘
```

| from | allowed to |
|------|-----------|
| `todo` | `in_progress`, `blocked`, `cancelled` |
| `in_progress` | `todo`, `blocked`, `review`, `done`, `failed`, `cancelled` |
| `blocked` | `todo`, `in_progress`, `failed`, `cancelled` |
| `review` | `in_progress`, `done`, `failed`, `cancelled` |
| `done` | `todo` |
| `failed` | `todo`, `cancelled` |
| `cancelled` | `todo` |

Terminal statuses: `done`, `failed`, `cancelled`.

Writers MUST enforce these transitions unless explicitly forced. Readers apply any
valid status regardless of transition.

**`blocked` vs. waiting:** `blocked` is an *explicit* signal that the agent needs
outside help (a question, a missing credential, a design decision). A task that
merely waits on unfinished dependencies stays `todo` and is reported as not `ready`.

### 5.2 Hierarchy and work packages

Tasks form a tree via `parent`. A parent task is a container: it is never worked on
directly, and its status and percent roll up from its children. Top-level tasks are the
plan's branches.

Assigning a parent task (`task.assigned` on a task with children) delegates a **work
package**: that actor owns the whole subtree. Every descendant without its own assignee
inherits the owner (derived field `owner`). A descendant may be assigned to someone else
explicitly, which carves it out of the package. The owning agent may add further
subtasks inside its package.

### 5.3 Writer rules (reference CLI behaviour)
- Moving to `in_progress` requires all deps done and no children (parents are containers).
- Starting an unassigned task assigns it to the actor (claim). Claiming is atomic under the lock.
- Only the task's effective owner (assignee, or package owner), or an actor with role
  `coordinator`, may change its status.
- `next` picks, in order: ready tasks assigned to the actor, then ready unassigned tasks in
  the actor's packages, then (unless `--package`) ready tasks with no owner at all.
- `block`, `review`, `done`, `fail` require a message.
- Task ids are `T<n>`, allocated sequentially under the lock. Other ids are allowed.
- Dependency cycles and parent cycles are rejected on write.

### 5.4 Derived fields (computed by fold, never written)
| field | meaning |
|-------|---------|
| `children` | ids whose `parent` is this task |
| `path`, `depth` | ancestor ids (root first) and their count |
| `owner` | `assignee`, else the nearest assigned ancestor (work package owner) |
| `waiting_on` | deps whose effective status is not `done` |
| `ready` | `status == todo && waiting_on == [] && children == []` |
| `rollup_status` | parents only, derived from children (see `rollupStatus()`): `failed` if any child failed; `blocked` if a child is question-blocked, or if everything still open is blocked `--on` other tasks; a child blocked `--on` next to other open work counts as in progress |
| `rollup_waiting` | parents only: `blocked` only because of `--on` waits, no question |
| `rollup_percent` | parents only, mean of leaf percents (cancelled excluded) |
| `percent` | last reported percent; `100` on done; reset on `todo` |
| `last_message` | last status/progress message |
| `result` | message of the latest transition to `done` |
| `started_at`, `finished_at`, `updated_at` | timestamps |
| `history` | status / assignment / progress entries |

Plan-level: `counts` (per status, leaves only), `total`, `progress` (done leaves ÷
non-cancelled leaves), `actors` (`{id, role, harness, ctx, first_seen, last_seen, tasks,
packages, owned}`, where `tasks` = open leaves assigned directly, `packages` = assigned
parent tasks, `owned` = all leaves owned directly or via a package),
`last_seq`, `warnings`.

The effective status of a task is `rollup_status ?? status`. A dependency on a parent task
is satisfied once all of its children are done or cancelled.

## 6. Concurrency

Writers MUST:
1. acquire the plan lock: `mkdir plans/<id>/.lock` (atomic on POSIX and NFSv3+). A lock
   older than 30 s may be broken.
2. read and fold the log, validate, assign `seq = last_seq + 1 …`
3. append all lines of the transaction in one `write` (O_APPEND)
4. optionally rewrite `state.json` via tmp+rename
5. remove the lock

Readers need no lock. A torn trailing line (crashed writer) MUST be skipped.

## 7. Consuming the protocol (frontends)

- **Simplest:** read `state.json`, re-read when its mtime changes.
- **Robust:** tail `events.jsonl`, keep the last `seq`, fold with `src/core.mjs`
  (pure ESM, no Node APIs, so it runs in a browser).
- **Live stream:** `atf log --follow --json` emits one event per line.
- Multiple plans: enumerate `.atf/plans/*/events.jsonl`.
- Staleness: an `in_progress` task whose `updated_at` is old and whose assignee's
  `last_seen` is old is probably stalled. The threshold is a frontend decision.
- Harness jump-links: `actor.ctx` carries e.g. `herdr_pane`, `tmux_pane`. Any
  `ATF_CTX_<KEY>=value` env var on the writer is recorded as `ctx.<key>`.

## 8. Hooks

`config.json` may declare post-write hooks, which are argv arrays run after every committed
transaction:

```json
{ "protocol": 1, "hooks": { "post_write": [["/usr/bin/node", "/path/to/sync.mjs", "hook"]] } }
```

Hooks are fire-and-forget: spawned detached after the lock is released, with output
ignored. A slow or failing hook can never block or fail a writer. Environment:
`ATF_DIR`, `ATF_PLAN`, `ATF_HOOK_FROM_SEQ`, `ATF_HOOK_TO_SEQ`, `ATF_HOOK_TYPES`
(comma-separated), plus the writer's own environment (so a hook can see e.g. which
harness pane it was written from). `ATF_NO_HOOKS=1` disables them. Hooks are how
harness adapters project ATF state outward (the herdr adapter uses one to label panes).

## 9. Agent context: checkpoints, sessions, resume policy

ATF is not tied to any agent or harness, but agents come and go: a launcher may close an
idle agent and start another later. Three harness-independent pieces make that safe:

- **Checkpoint notes** (`task.note` with `kind: checkpoint`): plain-text state of an
  unfinished task. Agents write one before blocking or stopping mid-task. Any agent can
  continue from it. Derived field: `checkpoint` (the latest one).
- **Session references** (`task.session`): an opaque `{kind, ref}` naming the agent
  session that worked on the task (a session file, a session id). ATF stores and returns
  it but never interprets it. Derived: `sessions` (per actor), `session` (latest).
- **Resume policy** (`resume` on the plan or a task: `fresh` (default since v2, §12) |
  `auto` | `resume`). Derived: `resume_policy`.

`launchPlan(plan, task, actor)` (CLI: `atf resume-info <task>`) answers "should the next
agent on this task resume or start fresh?". By default (`fresh`) a new agent starts with a
focused prompt; the checkpoint, feedback and history carry the state. Rule for `auto`:
**context belongs to the task.** A task that was already worked on (blocked then unblocked, question answered,
reopened after review) resumes its session; a task never started gets a fresh agent.
Without a session reference the answer is `fresh`, and the checkpoint carries the state.

Attention reasons (§`attentionFor`) for an owner: `ready`, `unblocked` (all `blocked on`
tasks done), `answered` (someone else added a note after a question-block). For a
coordinator additionally: `dispatch` (a ready task nobody owns), `review`, `blocked`
(question-blocks for the coordinator), `start` / `changes` / `unblocked` / `answered`
(work waiting for an owner that has nothing in progress: start a new agent; reported
after any `human` input on the task is handled), and `human` (the human's input on a task,
or on the plan with task null). Since v2 only the coordinator waits (§12.3).

**Review outcomes.** A task in `review` (or `done`) can be sent back with requested
changes: `task.status {status: todo, changes: true, message}`. Derived: `feedback` (all
change requests, numbered `round`s) and `changes_requested` (until the task is next
submitted, approved, failed or cancelled). The owner's attention reason is then
`changes` instead of `ready`. Work found in review beyond a task's acceptance criteria is
a new task with `origin` pointing at the reviewed one (derived reverse link: `followups`);
it defaults to the origin's parent, so it inherits an owner only through an assigned work
package. Nothing else is copied from the origin: not its `assignee`, `agent`, `reviewer`,
`review`, labels, priority or deps. Launchers that fall back to a work package's `agent`
apply that to a follow-up in the package like to any task in it.

**The human.** The person driving the agents writes as the actor `human` (role `human`):
frontends do so, and on the command line `--as human`. Not as their user name, which
is the default identity of an agent started by hand without `ATF_ACTOR` (e.g. the
coordinator), so their writes are not taken for that agent's own.

**Reviewers and batch reviews.** A task's `reviewer` (null = the coordinator) says who
must approve it; a subagent can set it when submitting (`atf review … --by human`).
A task with `review: true`, or with a reviewer other than the coordinator, *needs
review*: the owner finishes with `review` and cannot approve its own work. Review
decisions (approve = done from review, request changes, reopen from review, and
approvals/change requests in a feedback batch) belong to the reviewer: a named reviewer
alone (`human` = the actor `human`, or role `human`), otherwise the coordinator or the human
(`reviewRefusal`). Writers refuse other actors unless forced. Agents (role other than
coordinator/human) may only change, release or split (`add --parent`) tasks they own.
Requesting changes in a plan that is not active reactivates it. `changes --fresh` marks
only the next attempt as fresh (derived `fresh_next`, cleared when the task is started).
Writers refuse dependency cycles and `block --on` a task that is already finished.
Coordinators get attention reason `review` only for tasks they review; tasks for other
reviewers appear in the driver inbox as `your-review`. Review feedback is collected as
drafts (`plans/<id>/drafts/<actor>.json`, not events) and submitted in one transaction
(`reviewEvents`): per task, change requests (plus notes) on a task in review/done send
it back with all points numbered; elsewhere they become `feedback` notes; approvals mark
a task in review done; one `plan.review` event summarizes the batch, which a
coordinator's wait reports once.

**Wait cursors.** `atf wait` keeps, per actor and plan, the seq up to which it has reported
(`plans/<id>/cursors/<actor>.seq`). The next wait reports relevant events after it, so
events between two waits (e.g. a task finishing before the coordinator waits again) are
never lost. Without a cursor the wait starts from the actor's own last event, or, for a
brand-new actor with no events, from now (it has no history to catch up on). An event
about a task is not reported if the actor wrote anything about that task after it (it
was handled, e.g. after being woken by a message). `--since SEQ` overrides the start.
Relevant events, by others: for a coordinator, `task.status` to done, failed or review,
to blocked only without `on` (a dependency block is the owner's business), and
`plan.review`; for any actor, status, note, assignment and update events on tasks it owns,
except a status change to done (an approval leaves the owner nothing to act on).
Attention items are level-triggered and repeat until resolved.
Since v2 also, for a coordinator: `task.note` and `plan.note` by the human; blocks `for: human` are not reported (the coordinator wrote them).

**Launcher contract.** A launcher (e.g. the herdr adapter) that starts agents:
1. sets `ATF_DIR`, `ATF_PLAN`, `ATF_ACTOR`, `ATF_ROLE`;
2. records a `task.session` for each task an agent worked on, and a `plan.session` for
   the coordinator, if the harness exposes one;
3. starts subagents only when the coordinator asks (§12): fresh by default, resuming
   `launchPlan(...).session` when asked and the agent kind can resume; it may close
   subagents that finished, nudge an idle coordinator, and start or resume the
   coordinator (§12.6).

A subagent's `atf wait` returns at once, telling it to finish and end (§12.2).

### Roles without configuration

A writer that is given no role (no `--role`, no `$ATF_ROLE`) infers it from the plan
(`inferRole`): the plan's recorded `coordinator` is `coordinator`; otherwise the role the
actor used in earlier events of the plan; otherwise `agent`. So an agent started by hand
that creates a plan is its coordinator without any environment setup. `atf whoami`
shows identity, role and its source.

## 10. Multiple plans and projects

A project (one `.atf` root) holds any number of plans; agents of different plans never
interfere. To see plans across projects, a **user-level registry** lists known roots:
`$ATF_REGISTRY`, else `$XDG_CONFIG_HOME/atf/roots.json` (default `~/.config/atf/roots.json`),
`{"roots": [{"path", "added", "seen"}]}`. Writers add their root on `atf init` and on
`plan.created`; harness adapters may add roots they discover (e.g. from pane working
directories). Readers prune roots that no longer exist. The registry is a convenience:
failing to update it never fails a write.

`driverInbox(plan)` lists what needs a decision (as opposed to `attentionFor`, which is per
agent): tasks in `review`, question-blocks (blocked without `on` and not yet answered),
`failed` tasks, open plan questions for the human (`plan-question`), and an active plan
whose tasks are all finished. Each item says `for` whom (`human`, `coordinator`, or a
named reviewer); frontends show the human's, and the coordinator's too while no
coordinator runs. Oldest first. Frontends may add harness signals (e.g. stalled agents).
`planSummary(plan)` gives the per-plan row for overviews. CLI: `atf plans [--all]`,
`atf inbox [--all]`, `atf projects`.

**Harness sessions.** Ids such as pane ids and agent names are only unique within one
harness server. Writers record a server identity in `actor.ctx` (herdr:
`herdr_socket`); a launcher must only control actors whose identity matches its own
(actors without one are treated as local), and show others read-only.

## 11. Versioning

`v` is bumped only for incompatible envelope or semantics changes. New event types,
new optional `data` fields and new `ctx` keys are minor, non-breaking additions.

## 12. Interaction model v2: the coordinator decides

**Status: implemented** (reference CLI, skill, herdr adapter and board). It replaces the
parts of §9 that let subagents wait, get relaunched with their old session, or receive
review feedback directly; where §9/§10 and this section differ, this section applies.

### 12.1 Why

In v1, decisions are spread out: subagents wait for feedback, receive change requests
from the human directly, may ask questions in notes that wake nobody, and the herdr
launcher relaunches and resumes them on its own. That makes the model hard to follow
(who reacts to what?) and asks decision-making of subagents, which may run cheaper models
chosen for one kind of work. v2 makes the coordinator the only decision maker and keeps
every other role simple.

### 12.2 Roles

- **Coordinator: the brain of the plan.** Always running while its plan is active. It
  plans, dispatches, reviews, answers, re-plans, and is the only one who starts
  subagents. It works from the plan's documents (§12.7) and ATF; it can be closed and
  restarted with a fresh context at any time and continues from them.
- **Subagent: one assignment, then exit.** Started by the coordinator for a task or a
  work package, with a focused prompt. It works, writes a checkpoint, finishes with
  `done`, `review` or `block`, and exits. It never waits and never decides beyond its
  task: anything that needs a decision is a `block` with a precise question. If the task
  comes back, the coordinator starts a **new instance** (fresh context) with the task,
  its checkpoint and the coordinator's instructions. Resuming the earlier session is an
  explicit choice of the coordinator, not the default.
- **Human: supervises through the coordinator.** Sees every request for attention
  scoped to the task (or plan) it is about, with its context, and answers there. The
  answer goes to the coordinator, never to a subagent. Exception: approving a task that
  waits for the human's review takes effect directly (it decides nothing new; the
  coordinator sees the `done` event).

### 12.3 Who is woken by what

Only the coordinator is woken; subagents are started, never woken.

| event | wakes | the coordinator then |
|---|---|---|
| subagent `done` | coordinator | checks progress, dispatches what became ready |
| subagent `review` | coordinator | reviews, or (task's reviewer is `human`) leaves it to the human |
| subagent `block` (question) | coordinator | answers it and starts a new instance, or escalates to the human (§12.4) |
| subagent `fail` | coordinator | re-plans, retries, or escalates |
| human approves | coordinator (as `done`) | as for `done` |
| human input on a task or plan (§12.5) | coordinator | interprets it and acts |

`block --on <tasks>` (waiting on dependencies) wakes nobody when it is set; when the
dependencies are done the coordinator gets `unblocked` and starts a new instance.

### 12.4 Requests to the human are scoped

The human must see *which task* needs them and why without reading an agent's terminal.
So every request for the human's attention is an ATF record on a task, or on the plan
when it concerns the whole plan:

- **Task in review for the human:** the task's `reviewer` is `human` (as in v1).
- **Question for the human:** the coordinator escalates a task: `atf block T3 --for human
  -m "<question, with its own summary and recommendation>"`. The task stays blocked;
  its block now names the human as recipient. A subagent's own question is a block
  for the coordinator (the default `--for coordinator`).
- **Question about the whole plan:** `atf plan ask -m "…"` (a plan-level note of kind
  `question` for the human).
- **Failed task the coordinator cannot resolve:** escalated like a question.

Frontends list these under "needs you" with the task's context (the question or review
summary, the checkpoint, artifacts, the subagent's original question if the coordinator
escalated one). The skill tells the coordinator never to ask the human only in its
prompt. A frontend may still show "coordinator waits for input" (from harness state)
as a fallback for coordinators that do.

### 12.5 Human input goes to the coordinator, who interprets it

Whatever the human writes on a task (an answer, a change request, a remark) is
recorded on that task as a note by `human` addressed to the coordinator, and wakes it
(attention reason `human`, with the task). The task's status does not change by itself:
a task in review stays in review until the coordinator acts.

The coordinator is free to interpret, combine, correct or extend the input. It decides
what happens: send the task back to a new subagent instance with its own instructions
(`atf changes T1 -m "…"`), create follow-up tasks (`atf add … --from T1`), change
acceptance criteria, re-plan, or answer the human back with a question. The human's
original words stay in the task's history, so the human can see what became of them
and a restarted coordinator can find them; the subagent sees only the coordinator's
instructions (and the human's words only if the coordinator passes them on).

### 12.6 Coordinator lifecycle

- **Start:** a launcher command (herdr: `atf-herdr coordinate [plan]`) starts the
  coordinator agent in the project with the right identity (`ATF_ACTOR` = the plan's
  coordinator, `ATF_ROLE=coordinator`, `ATF_PLAN`) and a kickoff prompt: read the plan's
  documents and the plan-level checkpoint, run `atf status`, handle what needs
  attention, then `atf wait`.
- **Resume the plan:** the coordinator's session is recorded on the plan (plan-level
  session reference). If the coordinator disappeared (closed pane, crash, restart), the
  same command **resumes** that session by default, with a prompt to catch up on what
  happened since (`atf wait` reports it from its cursor). `--fresh` starts a new session
  instead, from the checkpoint and documents: for a context that grew too large or went
  wrong.
- **Fresh coordinator on demand:** the human can replace the coordinator with a new
  session at any time, also while it runs (its context grew too large or went wrong).
  If one is running, it is first asked to write the plan-level checkpoint and stop;
  once it has (or after a timeout, with a warning that the newest state may be missing),
  its pane is closed and a new coordinator starts fresh from the checkpoint, the
  documents and ATF. The new session becomes the plan's session (`plan.session`).
- **Presence:** while a plan is active and no coordinator runs for it, frontends show
  that under "needs you" (it blocks the whole plan) with one key to resume it and one to
  start it fresh. Launchers may also relaunch it.
- **Handoff:** before stopping (or when its context grows large), the coordinator
  writes a **plan-level checkpoint**: where the plan stands, what it is waiting for,
  what it intends next. A new coordinator starts from that, the documents and ATF.

### 12.7 Plan documents

Design and plan files are not replaced by ATF; they hold what ATF does not: the
reasoning. Division of labour:

- **`design.md`** (or decision records): the why: requirements settled in the
  pre-planning ("grill me") phase, alternatives rejected, architecture, constraints.
  Human-curated, versioned with the code, outlives the plan.
- **`plan.md`**: approach and phases and the reasons for them. No status or checkboxes:
  ATF holds status (a readable status file can be generated from ATF, e.g. a Markdown
  export of `atf plan show`).
- **ATF**: execution: tasks, owners, status, progress, checkpoints, feedback, and the
  decisions made during execution.

ATF links a plan to its documents (`docs`: a list of paths relative to the project,
set with `atf plan new|update --doc <path>`), shows them in frontends and points every
new coordinator at them. Closing a plan includes a write-back step: the coordinator
collects the decisions recorded during execution (`atf plan show` lists them) and folds
the lasting ones into `design.md`.

Typical flow: grill-me phase → `design.md`, `plan.md` → `atf plan new --doc design.md
--doc plan.md` and tasks from `plan.md` → execution → write-back → close.

### 12.8 Protocol changes

All additive (§11): new optional fields and one new attention reason; no version bump.

- `task.status` to `blocked`: optional `data.for` = `coordinator` (default) | `human`.
  Derived: `blocked_for`. `driverInbox` lists blocks for the human (and, as a
  fallback, any block while no coordinator runs); `attentionFor(coordinator)` lists
  blocks for the coordinator.
- `task.note` by the human: derived `human_input` (unhandled notes by `human` since the
  coordinator last wrote on the task). Coordinator attention reason `human`. Wait
  reports them to the coordinator, not to the task's owner.
- Plan-level notes: `plan.note {kind, message, for?}` (kinds `checkpoint`, `question`,
  `decision`, `info`). Derived: `plan.checkpoint`, `plan.questions`.
- Plan field `docs` (list of paths).
- `plan.session {kind, ref, actor}`: the coordinator's session, for resuming the plan.
  Derived: `plan.session`.
- Resume policy default becomes `fresh`; `resume` stays available per task/plan and per
  launch.

### 12.9 What changes in the reference implementation

- **CLI:** `block --for`, `plan ask`, `plan note`, `plan new|update --doc`; human input
  on a task becomes a note for the coordinator; `atf wait` is the coordinator's (a
  subagent calling it is told to finish instead); subagents' `note --kind question`
  is discouraged in favour of `block`.
- **Skill:** subagent part reduced to: do the task, checkpoint, finish with
  done/review/block, exit. Coordinator part: the only decision maker; escalate scoped
  (§12.4); interpret human input (§12.5); plan documents and handoff (§12.6–12.7).
- **herdr adapter:** the sweep no longer relaunches or resumes subagents and no longer
  nudges them; it closes subagents that finished, nudges the coordinator, and reports a
  missing coordinator. New: `atf-herdr coordinate`. `spawn` stays (the coordinator's tool),
  defaulting to a fresh instance.
- **Board:** "needs you" adds blocks for the human, plan questions and "no coordinator
  running" (with a key to start one). `x` and `r` record the human's input for the
  coordinator; `a` approves directly. Review drafts and batch submit are removed. `s`
  no longer starts subagents (dispatching is the coordinator's). On a plan, or on the
  "no coordinator running" item: `s` resumes the plan's coordinator, `S` starts a new
  coordinator with a fresh session (press twice; a running coordinator first writes its
  checkpoint and is replaced, §12.6). The Plan tab shows and opens the plan's documents.

### 12.10 Implementation order

1. Protocol and CLI (§12.8, §12.9 CLI), with tests.
2. Skill (both roles), including the document and handoff rules.
3. herdr adapter: simplified sweep, `atf-herdr coordinate`, fresh-by-default spawn.
4. Board: needs-you items, input routing, documents, removals.
