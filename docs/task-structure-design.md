# Planned tasks, attempts, slices and steps: design notes

This note keeps what was decided, and why, from a discussion on 2026-11-21. The four
steps of the implementation order are built (branch `task-structure`); the protocol is in
SPEC §4 (`task.steps`, `task.step`), §5.2 (parents that keep their criteria), §5.3 and
§5.4 (attempts) and §14 (the `deploy` kind).

## The problem

In a larger plan the board gets messy. The tasks created with the plan usually still hold
true. But during execution the coordinator adds many more tasks, and they drown the
plan's outline. Most of them are not new scope. They are **the work of a planned task**:

- **Retries.** A deployment task took the wrong approach and ended; the coordinator
  created a new task for the next try.
- **Slices.** The coordinator split a planned task into parts that run in parallel, or
  in sequence, or both.
- Explorations happen too, but they are the smaller share.

A second, related problem: inside a task, an agent does not report its mini steps. For
example, in "deploy the four services" the board does not show which deployments are
done.

## The current state and its impact

- **No way to retry a task with new instructions.**
  - `atf changes` works only from `review` or `done`.
  - `atf reopen` carries no instructions, and the skill does not offer it for retries.
  - The skill says "cannot be done as specified: cancel and re-plan".
  - So the coordinator creates a new task. That splits the task's changes (§15) in two,
    makes it rewire dependencies, and leaves a cancelled sibling on the board. This is a
    gap in what the coordinator was told, not a wrong judgement.
- **A parent is a passive container** (§5.2).
  - Once a planned task has subtasks, its status rolls up from them, and **its own
    acceptance criteria are never checked**.
  - The slices can each be fine while the whole does not work. Slices that run in
    parallel make that more likely.
  - This also discourages putting work under a planned task at all.
- **Follow-ups land next to the task, not under it:** `--from T4` places them under
  T4's parent.
- **Progress goes backwards:** it counts done leaves out of all leaves, so every task
  added during execution lowers it although nothing went wrong.
- **The tree no longer mirrors the plan.** It mirrors the order in which work was
  discovered, and the coordinator's own context carries every helper task at the
  planned level.
- **Progress within a task depends on the agent remembering.**
  - `atf progress` is self-reported, and the skill says "at real milestones, not on
    every step".
  - Live runs (§14) observe commands, but deployments are not a kind of their own. Only
    a command that runs 30 s or more is recorded, and even then only as "a command that
    ran", not as "service B deployed, 2 of 4".

## Decisions

- **A retry is a new attempt on the same task, not a new task.**
  - `atf changes T4 -m "1. …"` also works on a task that failed or ended in the wrong
    state. `--fresh` already exists for a new approach.
  - The task counts its attempts. `atf show` and the board show the attempt number and,
    per attempt, what it tried and how it ended.
  - The changes, dependencies and history stay on one task.
  - The checkpoint of a failed attempt says what it left behind (half-deployed
    resources, a broken branch). The next attempt's instructions say whether to clean it
    up first.
- **Slices are children of the planned task.**
  - They may be parallel, sequential (dependencies between children, as today) or both.
    No new concept is needed.
  - **A parent with acceptance criteria of its own keeps its promise.** When its
    children are done, it goes to `review` against its own criteria (often an
    integration check: deployed, end-to-end test green), not straight to done.
  - A parent without criteria rolls up as it does today.
- **Review rules stay as they are.** The coordinator reviews, except where a task names
  the human as its reviewer. That now includes planned tasks with slices. The human
  reviews the whole once, not every slice. The agents who did the work never approve.
- **No planned/discovered marker.**
  - Once retries are attempts and slices are children, the planned level stays clean by
    itself.
  - Genuinely new scope (follow-ups, re-plans) is rare and should be visible at the
    planned level.
- **No slicing rules in the skill.** The coordinator judges when to slice and how.
  The skill describes what ATF offers and what each option means for history, changes,
  progress and review: attempts, slices with or without dependencies, and a parent
  that keeps its criteria.
- **The board shows the planned tasks.** One row each, for example `T4 · attempt 2 ·
  2/5 done · deploy running · 2 waiting`, with live activity rolled up from the slice
  being worked on. Slices are folded by default, and unfolded they appear in dependency
  order, so a sequence reads top to bottom.
- **Progress within a task:**
  1. **A `deploy` live kind** (§14), so nothing depends on the agent remembering. It
     classifies `helm upgrade|install`, `kubectl apply|rollout status`,
     `argocd app sync|wait` and similar commands, and records each with its target and
     result: "refund-service deployed ✓", "ledger ✗ rollout timed out". It can be a
     plugin or built in.
  2. **Steps on a task**, for multi-step work that is not a command ("migrate the four
     schemas", "update the three clients"):
     - the agent declares them up front: `atf steps T3 "deploy gateway" "deploy refund" …`;
     - it checks each off: `atf step T3 2 done`;
     - the board shows `2/4 · deploy ledger`.

     A step never checked off is visible, and the task's percent follows from its steps.
     The skill mentions it in one line.

## Open

- **Progress:** counted over planned tasks (top level, or parents with criteria), with
  leaves as detail? What does "5 of 8 planned tasks" mean when the planned tasks are
  nested?
- **Steps from the harness's own todo list:** many harnesses give the agent a todo tool.
  If the hook observed that list (as §14 observes commands), steps would appear with no
  extra effort. Check pi, Copilot and opencode.
- **Explorations:** their own kind (attached to the task that needs the answer, left out
  of progress, the result recorded as a decision), or ordinary children?

## Decided while building

- **Any parent with `--accept` keeps its criteria**, with no separate marker, **in plans
  created from now on**. It is a property of the plan (`parent_review`, written by `atf
  plan new`), not of the code version: applied to an existing plan it would change its
  past, so a completed plan's approved parents would show as in review again and their
  dependents as waiting. Older plans keep parents as containers; a running one can opt
  in with `atf plan update --parent-review on`.
- **The parent's review is written, not only derived.** The write that finishes the last
  child also writes the parent's `task.status` `review` (`data.auto`), and a child open
  again puts it back to `todo`. So every frontend, inbox and `atf wait` sees an ordinary
  task in review, without special cases.
- **Attempts are derived in fold** from the `task.status` events with `changes: true`.
  There is no new event type. `atf changes` refuses a parent: send back the subtask that
  needs changes, or add one.
- **The `deploy` kind is built in**, not a plugin. When one command deploys several
  services (a loop), it collects every release the output reports.
- **On the board,** a planned task (a parent with criteria) starts folded. Its row shows
  the running slice with its live badge, how many slices wait, and `n/m` done. A leaf
  with steps shows `2/4 · <the current step>`.

## Implementation order (built)

1. **Attempts:** `changes` from failed and ended tasks, the attempt count in fold,
   `atf show` and the board, and the skill (retry with an attempt; new work as a task).
2. **Parents that keep their criteria:** a parent with criteria goes to `review` when its
   children are done, then through the usual review; the board row of a planned task.
3. **The `deploy` live kind.**
4. **Steps:** `atf steps` / `atf step`, the board, and the skill line.
