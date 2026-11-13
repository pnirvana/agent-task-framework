---
name: atf
description: "Track plans and task progress with the `atf` CLI (Agent Task Framework). Use when you are a coordinator breaking work into subtasks for other agents, or a subagent assigned an ATF task (your prompt mentions a task id like T3, or $ATF_PLAN is set)."
---

# ATF: shared task board for multi-agent work

`atf` is a CLI that records plans, tasks and progress into an append-only log under
`.atf/`. Humans and dashboards watch that log, so **your progress only exists if you
report it.** Every command accepts `--json` for machine-readable output.

Your identity comes from `$ATF_ACTOR` / `$ATF_ROLE` (or `--as NAME --role ROLE`), the
plan from `$ATF_PLAN` (or `--plan ID`). Check with: `echo $ATF_ACTOR $ATF_PLAN`.

## If you are a SUBAGENT (assigned a task)

You are either given **one task** (e.g. T3) or a **work package**: a parent task (e.g. T2)
whose whole subtree you own. `atf list --mine` shows everything you own.

For a work package, loop until `atf wait` says **you own no open tasks**:

```
atf next --package        # start the next ready task in your package
  … do it, finish it (step 6) …
atf wait --timeout 600000 # when nothing is ready: returns as soon as something is
                          # (a review approved, a dependency done, a task reopened);
                          # on timeout just run it again
```

Sending a task to `review` does not end your work: move on to the next ready task. Do not
end your turn while you own open tasks; `atf wait` is how you idle. If a task is too big,
split it inside your package: `atf add "<title>" --parent T4 --accept "..."`.

**Discovered a dependency on someone else's work** (e.g. your tests need a file another
package produces)? Don't wait silently inside an in-progress task and don't do their work.
Run `atf block T4 --on T8 -m "needs web/index.html from T8"`, continue with other ready
tasks, and `atf wait` will report T4 as `unblocked` when T8 is done. Then `atf start T4`.

For each task:

1. Read your task: `atf show T3`. The acceptance criteria are your definition of done.
2. Claim it: `atf start T3` (or `atf next` to pick up the next ready task).
3. Report at real milestones, not on every step, roughly every few minutes of work:
   `atf progress T3 "migrations written, wiring handlers" --pct 40`
4. Record outputs as you produce them:
   `atf artifact T3 src/auth/callback.ts` · `atf artifact T3 abc1234 --kind commit`
5. Record decisions others need to know: `atf note T3 "chose cookie sessions (no redis)" --kind decision`
6. Finish with exactly one of:
   - `atf done T3 -m "<what was done, where, how verified>"`: all acceptance criteria met
   - `atf review T3 -m "<summary + what to check>"`: done, but needs coordinator sign-off
   - `atf block T3 -m "<precise question or missing input>"`: cannot continue without help
   - `atf fail T3 -m "<what was tried, why it failed>"`: cannot be done as specified
7. If blocked on a question (no `--on`), stop working on that task; the coordinator will
   answer. Continue with other ready tasks, or `atf wait` until something needs you.

Rules: stay within your task's scope; if you discover extra work, add a note with
`--kind warning` rather than silently expanding scope. Never mark `done` with failing
tests or unmet acceptance criteria. The `-m` summary is what the coordinator reads
instead of your transcript, so make it self-contained.

## If you are the COORDINATOR

1. Create the plan: `atf plan new "Add OAuth login" --goal "Users can sign in with GitHub"`.
   It prints the plan id. Export it: `export ATF_PLAN=<id>`.
2. Decompose into a hierarchy that mirrors the plan: top-level tasks are the plan's
   branches (e.g. Backend, Frontend), leaves are units one agent finishes in one session,
   with verifiable acceptance criteria and explicit dependencies:
   ```
   atf add "Design auth flow" --accept "sequence diagram in docs/auth.md" --priority 2
   atf add "Backend"                                     # parent/grouping task
   atf add "Token endpoint" --parent T2 --dep T1 --accept "POST /auth/callback returns session" --accept "tests pass"
   atf add "Login button" --dep T3 --label frontend
   ```
   Parents are containers; their status rolls up from subtasks. Only leaves get worked on.
   Declare every dependency that crosses packages (e.g. backend tests that check a page the
   frontend builds depend on that frontend task). Undeclared cross-package dependencies are
   the main cause of agents waiting on each other.
3. Dispatch. Delegate **work packages, not loose lists**: when one agent should do several
   related tasks, put them under a parent task and assign the parent
   (`atf assign T2 backend`). The subtree is then visibly that agent's package, other agents
   cannot start its tasks, and progress rolls up per package. Assign single leaves only for
   one-off tasks. `atf list --ready` shows what can start now.
   Launch subagents with `ATF_DIR`, `ATF_PLAN`, `ATF_ACTOR=<name>`, `ATF_ROLE=subagent` in
   their environment (in herdr: `atf-herdr spawn T2 --name backend` does all of it, for a
   package or a single task), and a prompt like
   *"You are backend. You own ATF work package T2. Follow the atf skill."*
4. Monitor without polling agents directly:
   - `atf wait --timeout 600000` returns as soon as something needs you: a task in review,
     a blocker without `--on`, a finished task, or your own ready work. It returns
     immediately if that is already the case, so nothing is missed between waits.
     Keep looping on it until the plan is done; don't end your turn while agents work.
   - `atf status` shows the tree with owners; `atf plan show` gives the plan overview
     (structure, ownership, decisions, open questions, artifacts)
   - `atf log -n 20` shows recent events
5. React: answer blockers (`atf note T4 "use cookies" --kind decision`, then tell the agent),
   approve reviews (`atf done T4 -m "approved"`), retry failures (`atf reopen T4`), add
   follow-up tasks as discovered.
6. Close: `atf plan status completed -m "<summary>"`.

## Status reference

`todo → in_progress → (review →) done`; also `blocked`, `failed`, `cancelled`.
`blocked` = needs a human/coordinator. Waiting on dependencies is NOT blocked: such
tasks stay `todo` and are just not `ready`. Use `--force` only when you are sure.
