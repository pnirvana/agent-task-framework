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
| `plan.created` | `{title, goal?, description?, labels?, coordinator?, meta?}` (`coordinator` defaults to the creating actor) |
| `plan.updated` | any subset of the above (shallow replace) |
| `plan.status`  | `{status: active\|paused\|completed\|failed\|cancelled, message?}` |
| `plan.review`  | `{summary, items: [{task, action: approve\|change\|note, message, file?, line?}]}`: one submitted review batch |

### Task events
| type | data | notes |
|------|------|-------|
| `task.created`  | `{title, description?, acceptance?: string[], deps?: id[], parent?: id, labels?: string[], priority?: number, assignee?: string, agent?: string, origin?: id, meta?: object}` | `agent`: name of the agent definition to run the task with (opaque; resolved by the launcher, e.g. a pi agent named `reviewer`) |
| `task.updated`  | any subset of the definition fields | lists are replaced, not merged |
| `task.assigned` | `{assignee: string\|null}` | `null` = unassign |
| `task.status`   | `{status, message?, on?: id[], changes?: true}` | `message` on `done` is the task's **result summary**; `on` with `blocked`: tasks it is blocked on; `changes` with `todo`: **changes requested** from review (`message` is the feedback) |
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
- Dependency cycles and parent cycles are rejected or warned on write.

### 5.4 Derived fields (computed by fold, never written)
| field | meaning |
|-------|---------|
| `children` | ids whose `parent` is this task |
| `path`, `depth` | ancestor ids (root first) and their count |
| `owner` | `assignee`, else the nearest assigned ancestor (work package owner) |
| `waiting_on` | deps whose effective status is not `done` |
| `ready` | `status == todo && waiting_on == [] && children == []` |
| `rollup_status` | parents only, derived from children (see `rollupStatus()`) |
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
- **Resume policy** (`resume` on the plan or a task: `auto` | `resume` | `fresh`). Derived:
  `resume_policy`.

`launchPlan(plan, task, actor)` (CLI: `atf resume-info <task>`) answers "should the next
agent on this task resume or start fresh?". Rule for `auto`: **context belongs to the
task.** A task that was already worked on (blocked then unblocked, question answered,
reopened after review) resumes its session; a task never started gets a fresh agent.
Without a session reference the answer is `fresh`, and the checkpoint carries the state.

Attention reasons (§`attentionFor`) for an owner: `ready`, `unblocked` (all `blocked on`
tasks done), `answered` (someone else added a note after a question-block). For a
coordinator additionally: `dispatch` (a ready task nobody owns), `review`, `blocked`
(question-blocks).

**Review outcomes.** A task in `review` (or `done`) can be sent back with requested
changes: `task.status {status: todo, changes: true, message}`. Derived: `feedback` (all
change requests, numbered `round`s) and `changes_requested` (until the task is next
submitted, approved, failed or cancelled). The owner's attention reason is then
`changes` instead of `ready`. Work found in review beyond a task's acceptance criteria is
a new task with `origin` pointing at the reviewed one (derived reverse link: `followups`);
it defaults to the origin's parent (work package).

**Reviewers and batch reviews.** A task's `reviewer` (null = the coordinator) says who
must approve it; a subagent can set it when submitting (`atf review … --by human`).
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
Attention items are level-triggered and repeat until resolved.

**Launcher contract.** A launcher (e.g. the herdr adapter) that starts agents:
1. sets `ATF_DIR`, `ATF_PLAN`, `ATF_ACTOR`, `ATF_ROLE`, and `ATF_LIFECYCLE`
   (`ephemeral` if it closes idle agents and relaunches them, else `persistent`);
2. records a `task.session` for each task an agent worked on, if the harness exposes one;
3. when an agent's owner has attention but no live agent, starts one, resuming
   `launchPlan(...).session` when the mode is `resume` and the agent kind can resume,
   else fresh with a prompt pointing at the checkpoint and task history.

With `ATF_LIFECYCLE=ephemeral`, `atf wait` returns immediately when nothing needs the
agent, telling it to end its turn.

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

`driverInbox(plan)` lists what needs the *human* driving the agents (as opposed to
`attentionFor`, which is per agent): tasks in `review`, question-blocks (blocked without
`on` and not yet answered), `failed` tasks, and an active plan whose tasks are all
finished. Oldest first. Frontends may add harness signals (e.g. stalled agents).
`planSummary(plan)` gives the per-plan row for overviews. CLI: `atf plans [--all]`,
`atf inbox [--all]`, `atf projects`.

**Harness sessions.** Ids such as pane ids and agent names are only unique within one
harness server. Writers record a server identity in `actor.ctx` (herdr:
`herdr_socket`); a launcher must only control actors whose identity matches its own
(actors without one are treated as local), and show others read-only.

## 11. Versioning

`v` is bumped only for incompatible envelope or semantics changes. New event types,
new optional `data` fields and new `ctx` keys are minor, non-breaking additions.
