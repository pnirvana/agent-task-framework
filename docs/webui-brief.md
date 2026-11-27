# Web UI for ATF: brief for a new session

Goal: a browser UI for ATF, without herdr, for colleagues who do not live in a
terminal. They should be able to follow plans, answer questions, review and give
direction, as the herdr board lets a terminal user do.

Start with a design discussion with the user (see "Open questions"); write the
result into `docs/webui-design.md` before building.

## What to read first

- `README.md`, `SPEC.md`: the model (plans, tasks, events, roles) and the CLI.
- `skill/atf/SKILL.md`: how coordinators and subagents work; the human's part.
- `src/`: the herdr-free core.
  - `store.mjs`: the `.atf/` directory, the append-only event log, `loadPlan`, `transact`,
    `knownRoots` (projects ATF knows, in `~/.config/atf/roots.json`).
  - `core.mjs`: folding events into plan state (`fold`, `derive`), what needs whom
    (`attentionFor`, `driverInbox`, `humanTasks`, `brief`), transitions.
  - `changes.mjs`: a task's changed files (the board's Changes tab).
  - `live.mjs`: what running agents do (live view).
- The herdr board, as a model for the UI (not to reuse directly: it is a terminal UI):
  - `adapters/herdr/lib/tui.mjs`: Overview, plan view, task detail, the human's actions
    (answer, approve, request changes, YOUR TASKS, notes).
  - `adapters/herdr/lib/attention.mjs`: what needs the human, per plan and project.
  - `adapters/herdr/lib/notify.mjs`: notifications when the human is needed.
- `adapters/copilot/`: an integration that works without herdr (`atf dispatch`: the
  coordinator starts subagents with its harness's own subagent tool).

## Rules

- **Framework changes stay neutral.** The web UI may need changes in `src/` (e.g. an
  API for what waits for the human, or human identities). Put them in `src/` in a
  form the herdr board and the CLI can use too, not as web-only special cases, and
  move logic the web UI shares with the board out of `adapters/herdr` into `src/`.
- **Keep the tests green:** `node --test test/atf.test.mjs` (about 2 minutes, 77
  tests at the time of writing). Add tests for new core behavior.
- The event log is the source of truth: the UI reads it and writes through the same
  functions the CLI uses (`transact`), never by editing files.
- Commit or push only when the user asks.
- In shell commands, use `builtin cd` or absolute paths: `cd` is zoxide in the
  user's shell.

## Open questions (settle with the user first)

1. **Who starts the agents?** Without herdr, the coordinator runs somewhere: a
   terminal the colleagues do not want, the web server starting agents headless (an
   agent kind with a non-interactive mode), or a coordinator someone else runs. This
   decides most of the architecture.
2. **Where does the server run?** Locally per person (like the board), or one shared
   server for a team (then: which projects, whose machine, file access to the repos).
3. **Who is the human?** ATF has one human identity (`HUMAN = 'human'` in
   `src/core.mjs`). Several colleagues need their own identities: sign-in, and who
   answered or approved what. Likely a core change.
4. **Scope of the first version:** read-only (follow plans, see what waits), or
   answering and reviewing from day one? Creating plans and starting coordinators?
5. **Live updates:** how the browser learns about new events (watching the log files,
   server-sent events, polling).
6. **Diffs and reviews:** how a colleague looks at a task's changes in the browser.
7. **Notifications:** in the browser, mail, or the existing `[notify] command`.
8. **Stack:** the repo is plain Node ESM without dependencies so far; whether to keep
   it that way for the server and the front end.
