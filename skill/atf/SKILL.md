---
name: atf
description: "Plan, delegate and track multi-agent work with the `atf` CLI (Agent Task Framework). Use when coordinating work that other agents should do (breaking it into tasks and delegating them: inside an ATF plan, delegate via ATF instead of other subagent tools), or when you are a subagent assigned an ATF task (your prompt mentions a task id like T3, or $ATF_PLAN is set)."
---

# ATF: shared task board for multi-agent work

`atf` is a CLI that records plans, tasks and progress into an append-only log under
`.atf/`. Humans and dashboards watch that log, so **your progress only exists if you
report it.** Every command accepts `--json` for machine-readable output.

**Who you are matters** (what `atf wait` reports, who may change which task). Check it
first with `atf whoami`: it shows your identity, your role and why, and the plan.
- Identity: `$ATF_ACTOR` (or `--as NAME`), else your user name.
- Role: `$ATF_ROLE` (or `--role ROLE`); if neither is set, whoever **created the plan is its
  coordinator**, and others are plain agents. Subagents started by a launcher get
  `ATF_ACTOR`/`ATF_ROLE=subagent` from it.
- Plan: `$ATF_PLAN` (or `--plan ID`), else the project's most recently created plan.

`export` in one shell command does not carry over to your next command. Don't rely on
it: pass `--plan <id>` explicitly (or prefix `ATF_PLAN=<id> atf …`) on every command when
more than one plan may exist in the project.

## If you are a SUBAGENT (assigned a task)

You are either given **one task** (e.g. T3) or a **work package**: a parent task (e.g. T2)
whose whole subtree you own. `atf list --mine` shows everything you own.

For a work package, loop: `atf next --package` → do the task → finish it (step 6) → repeat.
Sending a task to `review` does not end your work: move on to the next ready task. If a
task is too big, split it inside your package: `atf add "<title>" --parent T4 --accept "..."`.

**When nothing is ready for you**, run `atf wait --timeout 600000`. It returns at once if
something already needs you, otherwise when something does (a dependency done, a review
answered, a task reopened). What to do next depends on `$ATF_LIFECYCLE`:
- `ephemeral` (agents launched by a harness that resumes them, e.g. herdr): `atf wait`
  tells you to **end your turn**. Do so. Your pane may be closed; when work appears you
  are resumed in this same session or a fresh agent continues from your checkpoint.
- otherwise: keep looping on `atf wait` (re-run on timeout) until it says you own no
  open tasks. Don't end your turn while you own open tasks.

**If you were resumed** (your prompt starts with `[ATF] You are resumed`): you have your
earlier context. Run `atf show <id>` for what changed, `atf start <id>`, continue.
**If you start fresh on a task that was worked on before** (its `atf show` has a
checkpoint, notes or an earlier result): continue from that state, don't start over.

**Discovered a dependency on someone else's work** (e.g. your tests need a file another
package produces)? Don't wait silently inside an in-progress task and don't do their work.
Write a checkpoint, then `atf block T4 --on T8 -m "needs web/index.html from T8"`, and
continue with other ready tasks. `atf wait` reports T4 as `unblocked` when T8 is done;
then `atf start T4`.

**Checkpoint before you block or stop mid-task.** It is what a fresh agent (or you, after
a restart) continues from, so make it concrete:
`atf note T4 --kind checkpoint "done: 8 tests in test_server.py, API ones pass. left: 2 page tests fail until web/index.html exists. verify: python3 -m unittest -v test_server"`

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
7. If blocked on a question (no `--on`): write a checkpoint first, then block, and stop
   working on that task. When the coordinator answers with a note, `atf wait` reports
   the task as `answered`. Meanwhile continue with other ready tasks.
8. **Needs the human?** If finishing your task requires the human to test or check
   something (try the UI, run it on their machine, judge a result), send it to review
   for them, with exact steps: `atf review T3 -m "please test: 1. … 2. … expected: …" --by human`.
   The coordinator will not approve it; the human's verdict comes back as approval or
   change requests.
9. **Changes requested**: when `atf wait` reports a task as `changes` (or your prompt says
   changes were requested), the coordinator sent it back from review. Run `atf show <id>`:
   the feedback is listed under "changes requested". `atf start <id>`, address **every**
   point, record how in a note (`atf note <id> "1. … 2. …"`), and send it to review again
   with a summary of what changed. If you disagree with a point, do not silently skip it:
   ask with `atf note <id> "…" --kind question` (or block on the question). Keep the change
   to what was asked; extra scope belongs in a follow-up task, not in this one.

Rules: stay within your task's scope; if you discover extra work, add a note with
`--kind warning` rather than silently expanding scope. Never mark `done` with failing
tests or unmet acceptance criteria. The `-m` summary is what the coordinator reads
instead of your transcript, so make it self-contained.

## If you are the COORDINATOR

0. Set up the project, once. Run `atf whoami`: if it fails with "no .atf directory found",
   this project has never used ATF. Run `atf init` in the directory you coordinate the
   work from; that directory is the project (it may contain several repositories, or
   none), and every agent working below it shares its plans. If you run inside herdr
   (`$HERDR_ENV` is `1`), also run `atf-herdr enable-sync` once: it hooks the project up
   to herdr's pane labels, notifications and the agent lifecycle (closing idle agents,
   resuming them when work appears). Both are safe to run again.
1. Create the plan: `atf plan new "Add OAuth login" --goal "Users can sign in with GitHub"`.
   It prints the plan id, and **you become its coordinator** (recorded on the plan, so it
   holds without any environment variables). Use `--plan <id>` on your following commands
   and confirm with `atf whoami --plan <id>` that your role is `coordinator`. If the plan
   was created by someone else (e.g. the human), ask for it to be handed to you
   (`atf plan update --coordinator <your name>`) or pass `--role coordinator`.
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
3. Dispatch. **Every task of a plan is delegated through ATF**, never through another
   subagent mechanism (e.g. pi's `subagent` tool or agent handoffs): work started that way
   is invisible to ATF (no status, no board, no review flow, no lifecycle). In herdr the
   launcher is `atf-herdr spawn <task>`; it can run a task as a **named agent
   definition**: `atf-herdr agents` lists them (pi agent definitions such as `reviewer`,
   `scout`, `worker`), and `atf-herdr spawn T7 --agent reviewer` runs T7 with that
   definition's model, tools and prompt. Record the choice on the task when you create it
   (`atf add "Review auth" --agent reviewer`): spawning, the board and relaunches then use
   it automatically. Other subagent tools are fine only for quick work **outside** the
   plan, such as a one-off exploration question whose answer you need right now and
   that is not a task.
   Delegate **work packages, not loose lists**: when one agent should do several
   related tasks, put them under a parent task and assign the parent
   (`atf assign T2 backend`). The subtree is then visibly that agent's package, other agents
   cannot start its tasks, and progress rolls up per package. Assign single leaves only for
   one-off tasks. `atf list --ready` shows what can start now.
   Outside herdr, launch subagents with `ATF_DIR`, `ATF_PLAN`, `ATF_ACTOR=<name>`,
   `ATF_ROLE=subagent` in their environment and a prompt like *"You are backend. You own
   ATF work package T2. Follow the atf skill."* (in herdr, `atf-herdr spawn T2 --name
   backend` does all of it, for a package or a single task).
4. Monitor without polling agents directly:
   - `atf wait --timeout 600000` returns as soon as something needs you: a task to
     **dispatch** (ready, nobody owns it, e.g. its dependency just finished), a task in
     review, a blocker without `--on`, or your own ready work; plus every task that
     finished or failed **since your previous wait** (ATF keeps a per-agent cursor). So
     nothing is lost if a task finishes before you call wait again.
     Keep looping on it until the plan is done; don't end your turn while agents work.
   - `atf status` shows the tree with owners; `atf plan show` gives the plan overview
     (structure, ownership, decisions, open questions, artifacts)
   - `atf log -n 20` shows recent events
5. React: answer blockers with a note on the task (`atf note T4 "use cookies" --kind decision`);
   the owner sees it as `answered` (and in herdr is resumed automatically); dispatch
   newly ready tasks; retry failures (`atf reopen T4`).
   **Review** every task in `review` against its acceptance criteria (read the change, run
   its checks), then decide exactly one of:
   - **Meets the criteria** → approve: `atf done T4 -m "approved: <what you checked>"`.
   - **Does not meet them** (bug, missing case, criteria not satisfied) → request changes:
     `atf changes T4 -m "1. <concrete change> 2. <…>"`. Be specific and number the points;
     the owner gets it back with your feedback and continues with its own context. If
     the *approach* is wrong rather than the details, add `--fresh` so the next attempt
     starts from a clean agent (it still sees the feedback and history).
   - **Meets them, but the review found more work** (extra edge cases, a refactor, a
     related feature) → approve it, then add the extra work as follow-up tasks:
     `atf add "<follow-up>" --from T4 --accept "…"`. A follow-up joins T4's work package
     (same owner) unless you pass `--parent`/`--assign`. Do not reopen or stretch a task
     beyond its acceptance criteria.
   - **The criteria themselves were wrong** → fix them first
     (`atf edit T4 --accept "…"`, which replaces the list), then request changes.
   - **Cannot be done as specified** → `atf cancel T4 -m why` and re-plan.

   **Reviews by the human.** Tasks with a reviewer other than you (`--reviewer human` at
   creation, or a subagent's `atf review … --by human`) are not yours to approve: they
   show up in the human's inbox, and you wait for their verdict. Mark tasks that need
   manual testing up front: `atf add "…" --reviewer human`. When the human submits a
   review (on the board or with `atf feedback submit`), your `atf wait` reports
   `review submitted by …`: approved tasks are done, tasks with change requests went
   back to their owners with all points. Treat the human's points as binding: when such
   a task is resubmitted, check every point before you approve it.

   **Review comments sent to you directly** (e.g. from the human's editor): map each
   comment to the task whose change it concerns, using the file, line and context of the
   comment and the tasks' descriptions, results and artifacts (`atf show`). Several tasks
   may have changed the same file, so judge by what the comment is about. If you cannot
   tell which task a comment belongs to, ask the human instead of guessing. Comments
   that fit no task become follow-ups. Then apply them in **one batch**, not one by one:
   draft them with `atf feedback change <task> "<point>" [--file F --line N]` /
   `atf feedback note <task> "…"` and send everything with `atf feedback submit`; each
   owner gets one message with all of its points. Do not fix things yourself, and tell
   the human which comment went to which task.
6. Close: `atf plan status completed -m "<summary>"`.

**Agent context.** Context belongs to the task: an agent that comes back to a task it
already worked on (unblocked, answered, reopened) resumes its earlier session if the
harness supports it; a new task gets a fresh agent. Override per plan or task with
`--resume fresh` (e.g. the earlier attempt went wrong and you want clean eyes) or
`--resume resume`: `atf plan update --resume fresh`, `atf edit T4 --resume fresh`.
`atf resume-info T4` shows what will happen.

## Status reference

`todo → in_progress → (review →) done`; also `blocked`, `failed`, `cancelled`.
`blocked` = needs a human/coordinator. Waiting on dependencies is NOT blocked: such
tasks stay `todo` and are just not `ready`. Use `--force` only when you are sure.
