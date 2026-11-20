---
name: atf
description: "Plan, delegate and track multi-agent work with the `atf` CLI (Agent Task Framework). Use when coordinating work that other agents should do (breaking it into tasks and delegating them: inside an ATF plan, delegate via ATF instead of other subagent tools), or when you are a subagent assigned an ATF task (your prompt mentions a task id like T3, or $ATF_PLAN is set)."
---

# ATF: shared task board for multi-agent work

`atf` is a CLI that records plans, tasks and progress into an append-only log under
`.atf/`. Humans and dashboards watch that log, so **your progress only exists if you
report it.** Every command accepts `--json` for machine-readable output.

**The model.** The **coordinator** is the brain of a plan: it plans, starts every
subagent, reviews, answers questions and makes every decision; it runs as long as the
plan is active. A **subagent** does one assignment (a task or a work package), reports,
finishes and ends; if its task comes back (changes, an answer, a dependency done), the
coordinator starts a new agent for it with fresh context and precise instructions. The
**human** supervises: their questions, answers and feedback go through the coordinator.

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

You are given **one task** (e.g. T3) or a **work package**: a parent task (e.g. T2) whose
whole subtree you own (`atf list --mine` shows it). Your prompt holds the coordinator's
instructions. **You do the work; you do not make decisions beyond your task, and you do
not wait.** Anything that needs a decision goes back to the coordinator as a `block`.
If your prompt says to add `--as <your name>` to your atf commands (you run inside the
coordinator's harness and share its environment), do so on **every** atf command.

For a work package, loop: `atf next --package` → do the task → finish it (step 6) → repeat.
Sending a task to `review` or blocking it does not end your work: continue with the next
ready task of your package. **When nothing is ready for you any more, end your turn.**
The coordinator starts a new agent when there is more (`atf wait` is the coordinator's;
if you call it, it only tells you to finish). If a task is too big, split it inside your
package: `atf add "<title>" --parent T4 --accept "..."` (only inside your own package).
Reviewing, reopening or releasing other agents' tasks is not yours to do.

**Starting on a task that was worked on before** (its `atf show` has a checkpoint, notes,
feedback or an earlier result): continue from that state, don't start over. The
coordinator's latest instructions (in your prompt, and under "changes requested" in
`atf show`) take precedence over earlier notes.

**Discovered a dependency on someone else's work** (e.g. your tests need a file another
package produces)? Don't wait inside an in-progress task and don't do their work. Write a
checkpoint, then `atf block T4 --on T8 -m "needs web/index.html from T8"`, and continue
with other ready tasks, or end. When T8 is done the coordinator starts an agent for T4.

**Checkpoint before you block or stop mid-task.** It is all the next agent on the task
knows, so make it concrete:
`atf note T4 --kind checkpoint "done: 8 tests in test_server.py, API ones pass. left: 2 page tests fail until web/index.html exists. verify: python3 -m unittest -v test_server"`

For each task:

1. Read your task: `atf show T3`. The acceptance criteria are your definition of done.
2. Claim it: `atf start T3` (or `atf next` to pick up the next ready task).
3. Report at real milestones, not on every step, roughly every few minutes of work:
   `atf progress T3 "migrations written, wiring handlers" --pct 40`
4. Record outputs as you produce them:
   `atf artifact T3 src/auth/callback.ts` · `atf artifact T3 abc1234 --kind commit` ·
   `atf artifact T3 feature/login --kind branch` (reviewers open these directly)
   Something running longer than your command (in the background, or output you check
   later, e.g. a server log)? Register what you watch: `atf artifact T3 <file> --live`.
   Run builds, tests and pipeline checks as you normally would: the board sees them.
   (Asked to make the board show a new kind of command, e.g. CI pipeline jobs? That is a
   live plugin: `atf live-kinds` names the guide.)
5. Record decisions others need to know: `atf note T3 "chose cookie sessions (no redis)" --kind decision`
6. Finish with exactly one of:
   - `atf done T3 -m "<what was done, where, how verified>"`: all acceptance criteria met
     **and you verified each one yourself** (tests run, output checked). This is the
     normal ending for a well-specified task.
   - `atf review T3 -m "<summary + what to check>"`: the work is finished, but someone
     else has to look before it counts as done. **Required** when `atf show T3` says
     `review: required` or names a reviewer (`atf done` refuses then). Otherwise use it
     only when one of these holds, and say which in the message:
     - a criterion is one you cannot verify yourself (needs judgement, another system,
       a person: say exactly what to test and how; the coordinator decides whether the
       human looks at it);
     - you deviated from the task or its criteria, or made a decision the coordinator should confirm;
     - the change is risky for others: shared interfaces, data migrations, deletions;
     - the result is a proposal or options for the coordinator to choose from.
     Not "to be safe": every review costs the coordinator a round, so when the criteria
     are met and checked, finish with done.
   - `atf block T3 -m "<precise question or missing input>"`: you cannot continue without
     a decision. Write a checkpoint first. The question goes to the coordinator (it
     answers or asks the human); you continue with other ready tasks or end. Questions
     belong in a block, not in a note: a note wakes nobody.
   - `atf fail T3 -m "<what was tried, why it failed>"`: cannot be done as specified.
   **Start every message with one short sentence** (the result, or the question itself),
   then the details: overviews show only that first sentence.
7. **Started early?** If your task depends on unfinished tasks and you were told to start
   early (`atf start <id> --early`), do only what does not need them. Then write a
   checkpoint and `atf block <id> --on <deps> -m "<what you need>"`.
8. **Changes requested**: your prompt (and `atf show <id>`, under "changes requested")
   holds the coordinator's instructions. `atf start <id>`, address **every** point,
   record how in a note (`atf note <id> "1. … 2. …"`), and send it to review again with a
   summary of what changed. If you disagree with a point or it needs more than the task
   allows, do not silently skip or stretch it: block with the question.

Rules: stay within your task's scope; if you discover extra work, add a note with
`--kind warning` (the coordinator reads it at review) rather than expanding scope. Never
mark `done` with failing tests or unmet acceptance criteria. The `-m` summary is what the
coordinator reads instead of your transcript, so make it self-contained.

## If you are the COORDINATOR

You are the only decision maker of the plan and the only one who starts subagents. Stay
on the plan while it is active: wait with `atf wait`; never end your turn to ask the
human something (ask through ATF, step 6, and keep waiting). **If `atf wait` says "End
your turn: you will be woken"**, your harness waits for you (e.g. the pi extension): end
your turn right away; you are woken with the report when something needs you, and the
human can prompt you meanwhile. Otherwise `atf wait` blocks: run it in a loop.

**Your chat is where the human works with you.** They answer your questions, review and
give directions here, and see what waits for them next to the chat (their harness may
show it, or they ask you). Two rules make that work:

- **Record what they decide, as theirs.** When the human answers, approves, rejects or
  decides something in your chat, record it on the task (or the plan) with their words,
  verbatim, in `--relay`: `atf note T5 --relay "yes, go with SQLite"` (an answer: it
  resolves the question), `atf done T1 --relay "looks good, approve"` (an approval, also
  of a review that waits for the human), `atf changes T1 --relay "<their words>" -m "1.
  <your instructions>"`, `atf plan note --relay "<their words>"`. Then act on it as on any
  input (step 7). Relay only what the human actually said; your own decisions are plain
  notes. Input they write elsewhere (board, editor) reaches you as `human` in `atf wait`.
- **Your last message of a turn is for the human**, who reads your chat when they come
  by: what you decided or did (one or two lines), then what waits for them, each item
  with its task id and the question in a few words ("T5: approve the SQLite order
  schema?"), or "nothing needs you". Run `atf wait` *before* writing it. Do not end with
  ATF mechanics (checkpoints written, "waiting", "ATF will wake me"): that is noise to
  them. `atf inbox --for human` lists what waits for them; `atf brief T5` shows one
  request in full (also useful when they ask "what was T5 again?").

0. **Set up the project, once.** Run `atf whoami`: if it fails with "no .atf directory
   found", run `atf init` in the directory you coordinate the work from; that directory
   is the project (it may contain several repositories, or none). If you run inside herdr
   (`$HERDR_ENV` is `1`), also run `atf-herdr enable-sync` once (pane labels,
   notifications, closing finished agents). Both are safe to run again.
1. **Documents first.** Larger work starts with a design discussion with the human (a
   "grill me" phase: ask until requirements, constraints and the approach are settled).
   Write the result into human-readable files in the project, typically `design.md` (the
   why: requirements, decisions and rejected alternatives, architecture, constraints) and
   `plan.md` (approach and phases, and why; **no status or checkboxes**: ATF holds the
   status). They outlive the plan and carry the knowledge across coordinator sessions.
2. **Create the plan** and link the documents:
   `atf plan new "Add OAuth login" --goal "Users can sign in with GitHub" --doc design.md --doc plan.md`.
   It prints the plan id, and **you become its coordinator** (recorded on the plan). Use
   `--plan <id>` on your following commands and confirm with `atf whoami --plan <id>` that
   your role is `coordinator`. If the plan was created by someone else, ask for it to be
   handed to you (`atf plan update --coordinator <your name>`).
3. **Decompose** into a hierarchy that mirrors the plan: top-level tasks are the plan's
   branches (e.g. Backend, Frontend), leaves are units one agent finishes in one session,
   with verifiable acceptance criteria and explicit dependencies:
   ```
   atf add "Design auth flow" --accept "sequence diagram in docs/auth.md" --priority 2
   atf add "Backend"                                     # parent/grouping task
   atf add "Token endpoint" --parent T2 --dep T1 --accept "POST /auth/callback returns session" --accept "tests pass"
   atf add "Login button" --dep T3 --label frontend
   atf add "Migrate user table" --accept "…" --review    # must come back to you for review
   atf add "Checkout flow" --accept "…" --reviewer human # the human tests it
   ```
   Use `--review` for tasks you want to check before they count as done (the subagent
   must finish with `atf review`). Parents are containers; their status rolls up from
   subtasks. Declare every dependency that crosses packages: undeclared cross-package
   dependencies are the main cause of agents waiting on each other.
4. **Dispatch: you start every subagent.** **Every task of a plan is delegated through
   ATF**: in herdr with `atf-herdr spawn`, elsewhere with `atf dispatch` (below), never
   by handing a task to another subagent mechanism directly: work started that way is
   invisible to ATF. In herdr: `atf-herdr spawn <task>`; it assigns
   the task, starts a fresh agent and gives it the task. `atf-herdr agents` lists named
   agent definitions (e.g. `reviewer`, `worker`); `atf-herdr spawn T7 --agent reviewer`
   (or `atf add … --agent reviewer`) runs a task with one, e.g. a cheaper model for a
   mechanical task. Delegate **work packages, not loose lists**: put related tasks under
   a parent and spawn the parent (`atf-herdr spawn T2 --name backend`); the agent works
   through it. `atf list --ready` shows what can start now.
   **Starting a dependent task early**: if a meaningful part of a waiting task can be done
   already (tests against an agreed interface), `atf-herdr spawn T5 --early`; the agent
   does what it can and blocks `--on` the dependency. If the dependency is not real,
   remove it: `atf edit T5 --dep T2` keeps only T2, `--dep ''` removes all.
   **Outside herdr** (e.g. GitHub Copilot CLI, `$ATF_HARNESS` is not `herdr`): use your
   harness's own subagents, through ATF: `atf dispatch T2 --name backend` assigns the task
   and prints a prompt; start a **background** subagent (Copilot: the task tool,
   general-purpose agent, background mode) with that prompt, unchanged, and end your turn
   or keep working. The subagent shares your shell, so the prompt has it add
   `--as backend` to its atf commands. You are woken when it finishes or asks something
   (`atf wait`, as always); its reply to you is only a summary: the plan has the details.
   Other ways to start subagents: with `ATF_DIR`, `ATF_PLAN`, `ATF_ACTOR=<name>`,
   `ATF_ROLE=subagent` in their environment and a prompt like *"You are backend. You own
   ATF work package T2. Follow the atf skill."*
   Delegating plan work **without ATF** (a subagent tool given the task directly) is
   invisible to the plan: subagent tools without `atf dispatch` are fine only for quick
   work **outside** the plan (a one-off exploration question whose answer you need now).
5. **Monitor**: `atf wait --timeout 600000` in a loop (or once, then end your turn, when
   it says you will be woken). It returns as soon as something
   needs you, with the reason per task, plus every task that finished or failed since
   your previous wait (nothing is lost between waits):
   - `dispatch`: ready, nobody owns it → spawn an agent.
   - `start`, `changes`, `unblocked`, `answered`: work for an owner that is not working
     (it was assigned, sent back, its dependency is done, its question answered) → spawn a
     new agent for it (`atf-herdr spawn <task>`); it starts fresh with the task, its
     checkpoint and your instructions.
   - `review`: review it (step 6).
   - `blocked`: a subagent's question → answer or escalate (step 6).
   - `human`: the human wrote on a task (or on the plan, task `null`) → step 7.
   `atf status` shows the tree with owners; `atf plan show` the plan overview; `atf log -n 20`
   recent events.
6. **Decide.**
   - **Questions from subagents.** Answer them when you can: record the answer on the
     task (`atf note T4 "use cookies" --kind decision`), then spawn a new agent for it,
     with the answer in its instructions. When the human must decide, **escalate it on
     the task**, never only in your chat: `atf block T4 --for human -m "<the question in
     one sentence, then the context needed to answer it>" --recommend "<your view>"`. The
     human sees it on that task with its context. **Also ask it in your chat** (in your
     message for the human), so they can answer you right there; record that answer with
     `--relay`. An answer they give elsewhere comes back to you as `human`.
     A question about the whole plan (`atf plan ask "<question + context + your view>"`)
     only for a decision that belongs to no task, e.g. the scope or direction of the
     plan. One question, short, with your recommendation. Never use it to list or repeat
     task questions, or to report status: the human already sees every task question
     on its task, and status on the board.
     A failure you cannot resolve: escalate it the same way (`atf block T4 --for human`).
   - **Review** every task in `review` against its acceptance criteria (read the change,
     run its checks), then decide exactly one of:
     - **Meets the criteria** → approve: `atf done T4 -m "approved: <what you checked>"`.
     - **Does not meet them** → `atf changes T4 -m "1. <concrete change> 2. <…>"`, then
       spawn a new agent for it. Be specific and number the points: they are the new
       agent's instructions. If the *approach* is wrong, say so and describe the right
       one (`--fresh` additionally makes sure no earlier session is resumed).
     - **Meets them, but the review found more work** → approve it, then add follow-ups:
       `atf add "<follow-up>" --from T4 --accept "…"`. A follow-up is placed under T4's
       parent (so inside an assigned package it belongs to that package's owner); nothing
       else is copied from T4 (not its assignee, `--agent`, reviewer, labels,
       dependencies): pass what it needs. Do not stretch a task beyond its criteria.
     - **The criteria themselves were wrong** → `atf edit T4 --accept "…"` (replaces the
       list), then request changes.
     - **Cannot be done as specified** → `atf cancel T4 -m why` and re-plan.
     If a subagent says the human must test something, decide whether that is needed;
     if so, hand the review to them: `atf edit T4 --reviewer human`.
   - **Reviews by the human.** Tasks whose reviewer is the human are not yours to approve
     (`atf done` refuses; `atf wait` does not report them). Mention them in your message
     for the human. If they approve in your chat, record it: `atf done T4 --relay "<their
     words>"`; an approval elsewhere marks the task done by itself; anything else they
     write comes to you (in your chat, or as `human`, step 7).
7. **The human's input** (`human` in `atf wait`; `atf show <task>` lists it under "human
   input", `atf plan show` for the plan). It is addressed to you, not to the subagent:
   **interpret it and decide**. You may combine, correct, extend or narrow it, and turn it
   into whatever the plan needs: send the task back with your own instructions (`atf
   changes`, then spawn), a follow-up task, changed criteria, a re-plan, or an answer or
   question back (`atf note <task> "…"`). Whatever you do on the task marks the input as
   handled; if nothing else is needed, acknowledge it with a note. The human's own words
   stay in the task history; the next agent sees your instructions.
   **Review comments sent to you directly** (e.g. from the human's editor): map each to
   the task whose change it concerns (file, line, the tasks' results and artifacts); ask
   the human if you cannot tell; comments that fit no task become follow-ups.
8. **Hand over.** Keep a plan-level checkpoint current, after important decisions and
   before you stop: `atf plan checkpoint "<where the plan stands, what you are waiting
   for, what comes next, decisions not yet in the documents>"`. A new coordinator
   session (after a restart, or a deliberate fresh start when your context grew large)
   starts from it: read the documents (`atf plan show` lists them), the checkpoint, `atf
   status`, then handle `atf wait`.
9. **Close: the human decides.** When all tasks are finished (`atf wait` says so), do not
   close the plan yourself. Fold the decisions made during execution (`atf plan show`
   lists them) into `design.md` where they matter beyond this plan, write a plan
   checkpoint, then ask the human in your chat whether to close it (they also see the plan
   as finished). If they agree, record it with their words: `atf plan status completed
   --relay "<their words>" -m "<summary>"` (`atf` refuses to close a plan without them).
   They may also close it themselves, or give more work: then add tasks and go on.

**Agent context.** Every agent you spawn starts **fresh**: a focused prompt, the task, its
checkpoint, feedback and history. That keeps subagent contexts small. Resuming the
session that worked on a task before is possible when it is worth it:
`atf-herdr spawn T4 --resume`, or as a policy `atf edit T4 --resume auto` (resume tasks
already worked on). `atf resume-info T4` shows what will happen.

## Status reference

`todo → in_progress → (review →) done`; also `blocked`, `failed`, `cancelled`.
`blocked` = needs a decision (by the coordinator, or `--for human`) or waits on other
tasks (`--on`). Waiting on dependencies declared up front is NOT blocked: such tasks stay
`todo` and are just not `ready`. Use `--force` only when you are sure.
