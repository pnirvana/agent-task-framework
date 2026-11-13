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
| `plan.created` | `{title, goal?, description?, labels?, meta?}` |
| `plan.updated` | any subset of the above (shallow replace) |
| `plan.status`  | `{status: active\|paused\|completed\|failed\|cancelled, message?}` |

### Task events
| type | data | notes |
|------|------|-------|
| `task.created`  | `{title, description?, acceptance?: string[], deps?: id[], parent?: id, labels?: string[], priority?: number, assignee?: string, meta?: object}` | |
| `task.updated`  | any subset of the definition fields | lists are replaced, not merged |
| `task.assigned` | `{assignee: string\|null}` | `null` = unassign |
| `task.status`   | `{status, message?}` | `message` on `done` is the task's **result summary** |
| `task.progress` | `{message?, percent?: 0..100}` | heartbeat / milestone |
| `task.note`     | `{message, kind?: info\|question\|decision\|warning}` | |
| `task.artifact` | `{kind: file\|commit\|branch\|pr\|url\|other, ref, description?}` | pointer to an output |

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

## 9. Versioning

`v` is bumped only for incompatible envelope or semantics changes. New event types,
new optional `data` fields and new `ctx` keys are minor, non-breaking additions.
