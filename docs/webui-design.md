# ATF web UI: design

**Status: agreed direction; spike done (`spike/webterm`); phases 1 (core in `src/`), 2 (sessions backend), 3 (first usable web UI, `adapters/web/`) and 4 (live view, changes, file viewer, notifications) built.**
Brief: `docs/webui-brief.md`. This document records what was settled and how it will be
built; the build plan is at the end.

## 1. Goal

An agent task IDE in the browser for developers who do not live in a terminal: follow
plans, answer, review, give direction, start and replace coordinators, watch and talk to
every agent, with as few reasons as possible to open an SSH terminal. It does what the
herdr board and herdr do together today, without herdr.

## 2. Settled

| topic | decision |
|---|---|
| where it runs | on the developer's own Linux devpod (no X server), one server per user. The browser runs on another machine and reaches the devpod only through SSH: **one port**, tunnelled (`ssh -L 7420:localhost:7420 devpod`). |
| harnesses | Copilot CLI, pi, opencode. Tested mainly with Copilot. |
| agents | run in **our own session daemon** (`atf-sessiond`), not tmux, not herdr. Proven in the spike (§4.1). |
| subagents | **independent sessions**, like `atf-herdr spawn` today: each its own terminal, session, approvals and live view. Not Copilot's built-in subagents (`atf dispatch` stays available). |
| UI | close to the herdr board (same views, scopes, actions and keys) plus agent panes, as herdr shows them. Several plans in parallel. |
| theme | Catppuccin Macchiato, JetBrains Mono. Themes are swappable (one CSS file each). |
| stack | Node (no npm dependencies) for the servers; plain ES modules in the browser, no build step. Third-party files only where writing our own makes no sense, copied into `vendor/` with their licence (§11). |
| diffs | the Changes list as on the board; viewing diffs gets its own design later. |
| file browser | later (§9), but the server's file API is designed for it from the start. |
| stage two | a hosted server on Kubernetes, no devpod (§10). Nothing in v1 may assume more than it must about "one user, one machine". |
| branches | all web UI work in the worktree `agent-task-framework-webui`, so core fixes on `main` continue in parallel. |

## 3. Architecture

```
 browser ── one SSH tunnel ──► atf-web (127.0.0.1:7420)
   board views  ◄── SSE ─────── reads plans (store/core), watches .atf/ for changes
   actions      ── HTTP ──────► writes as the human through transact (same as the CLI)
   agent panes  ◄── WebSocket ─► relays to ───► atf-sessiond (Unix socket, owner only)
                                                  └─ one terminal per agent (script/pty)
                                                       coordinator, subagents, shells
 atf spawn / atf coordinate (the coordinator's commands, the UI's buttons)
   └─ src/launch.mjs ── placement backend: sessions (atf-sessiond) | herdr
```

Three processes with separate lifetimes:

- **atf-sessiond** holds the agents' terminals. It lives as long as the devpod session;
  restarting the web server, closing the browser or losing the tunnel does not touch
  agents.
- **atf-web** serves the UI, the API and the terminal relay, and runs the supervisor
  (§4.3). Restartable at any time (e.g. after a `git pull`).
- **the agents** (coordinator and subagents) use the `atf` CLI as today; nothing about
  the protocol changes for them.

## 4. Components

### 4.1 Session daemon (`atf-sessiond`)

What the spike proved (Linux in a container with util-linux 2.38, on the devpod with
2.37.2, and macOS):

- **A terminal per session without native modules:** util-linux `script -qfec <cmd>
  /dev/null` gives the agent a real pseudo-terminal while we talk to `script` through
  pipes. macOS (development only): python3's `pty` module, since macOS `script` needs a
  terminal on stdin.
- **Resize from outside:** the session first prints its tty and pid in a private OSC
  sequence (stripped); `stty -F <tty> cols C rows R` resizes it and the kernel sends
  SIGWINCH.
- **Stop:** SIGHUP to the agent's process group (util-linux `script` ignores SIGHUP
  itself), like closing a terminal window; SIGKILL after 5 s.
- **Reattach:** the last 2 MB of output per session are replayed to a new client (from
  the last switch to the alternate screen when on it). With Copilot the replayed screen
  was identical to the live one.
- **Copilot, pi, opencode and a shell** run in it, through the tunnel, with colours,
  keys and resizing; Copilot's folder-trust prompt answered from the browser.

Protocol (newline-delimited JSON over `$XDG_RUNTIME_DIR/atf-<uid>/sessiond.sock`, mode
0600): `list`, `create {name, cmd, cwd, env, cols, rows, meta}`, `attach`, `detach`,
`input`, `resize`, `kill`, `remove`; events `sessions`, `replay`, `out`, `exit`. Sessions
carry `meta` (root, plan, actor, task, role, kind, harness session id) so the launcher
and the UI find the agent of a task without a separate registry.

Built (phase 2): `src/sessiond.mjs` (the daemon; requests carry a `rid` and get an `ok` or
`error` reply; `shutdown`; `argv` as well as `cmd`; it tracks whether the program in a
session has bracketed paste on), `src/sessions.mjs` (a synchronous client for the
launcher, an asynchronous `connect()` for terminals, and the backend), and
`bin/atf-sessions` (`start`, `stop`, `list`, `attach`, `spawn`, `coordinate`, `supervise`,
`shell`, `kill`, `rm`). Its settings are `[sessions]` in `~/.config/atf/config.toml`
(`agent_kind`, `lifecycle`, `agents`).

- **First prompt:** the backend opens an agent without starting it and starts it in
  `begin(handle, prompt)` with the prompt on its command line (the kind's `prompt`
  arguments; `bin` names the command, default the kind's name). A kind without
  `prompt` gets it typed in once its screen has been quiet. Later prompts (nudges,
  handoffs) are pasted: bracketed when the program takes it, else on one line, then Enter.
- **Agents' context:** `ATF_CTX_SESSIOND` and `ATF_CTX_ATF_SESSION` put the daemon and
  the session in the actor's `ctx`, so a coordinator started by hand is found by the
  session its writes came from.
- **Paths:** project roots are compared by their real path (macOS `/var` is
  `/private/var`). Unix socket paths are limited to about 104 bytes; the daemon says so
  instead of failing silently (`ATF_SESSIOND_SOCKET` sets another).

To do beyond the spike:

- **Replay after a size change:** a client reattaching at another size than the output
  was written at may see a garbled screen. Fallback if that shows in practice: keep a
  screen copy per session in the daemon with `@xterm/headless` (MIT) and send its
  serialized state instead of raw output.
- **Daemon restart ends all sessions** (as a tmux server's does). Agents are resumable
  (harness session ids are recorded on tasks and the plan), so the supervisor offers to
  resume the coordinator; subagents start fresh from their checkpoint, the default anyway.
  The daemon is small and changes rarely, so it should almost never need a restart.
- **Agent state** (working, idle, waiting for approval): see §4.3.
- opencode `--prompt` not tried yet through the backend (pi and Copilot were, §4.3).
- Scrollback search and copy are xterm.js features in the browser.

### 4.2 Launcher in `src/` (`src/launch.mjs`)

Today starting agents lives in `adapters/herdr/lib/launch.mjs`: agent kinds, prompts,
session ids, resume, assignment, the registry, the lifecycle sweep. Most of it is not
herdr-specific. It moves to `src/` behind a small **placement backend** interface:

```js
// backend: where an agent's terminal lives
{ name: 'sessions' | 'herdr',
  start({ cwd, env, cmd, args, label, workspace, placement }) -> handle,   // starts the agent
  find(root, actor) -> handle | null,                                      // a running agent
  state(handle) -> { status: 'working'|'idle'|'blocked'|'done', since },   // liveness (§4.3)
  close(handle), focus?(handle) }
```

- `src/launch.mjs`: `launchAgent`, `launchCoordinator` (resume / fresh / replace with a
  checkpoint handoff, §12.6 of the SPEC), session ids, prompts (`src/prompts.mjs`
  already), agent kinds (with a new `prompt` field: how the kind takes its first prompt,
  e.g. Copilot `-i {prompt}`, pi `{prompt}` as the message, opencode `--prompt {prompt}`;
  herdr keeps typing it in for kinds without one).
- `adapters/herdr/` becomes the herdr backend plus the board and herdr-only extras
  (workspaces, layout, restore). Its behaviour does not change.
- **Neutral commands:** `atf spawn <task>` and `atf coordinate [plan]`, with the backend
  from the environment the launcher set (`ATF_BACKEND=sessions|herdr`), else herdr when
  inside herdr, else sessions when a daemon runs. `atf-herdr spawn` / `coordinate` stay
  as aliases. The skill says `atf spawn` everywhere; outside both, `atf dispatch` as today.

### 4.3 What needs the human, without herdr

`adapters/herdr/lib/attention.mjs` decides "needs you" from the plan plus herdr's agent
states (`lv`). It moves to `src/attention.mjs` with liveness as a parameter, so the board
passes herdr's and the web UI the session backend's.

Agent state without herdr's screen heuristics, best source first:

1. **The harness extension reports it.** The ATF extensions already observe the agent
   (Copilot: `session.idle`, tool approvals; pi: its events; opencode: its plugin) and
   write live state for the board's live view. They add `status` (working, idle,
   waiting for approval) to it. That covers "coordinator waits for you", "agent waits
   for your approval" and stalled tasks.
2. **The session itself:** exited (with exit code), and no output for a while, as a
   fallback for kinds without an extension.

Built (phase 2): the extensions write `<plan>/live/status/<actor>.json` ({status, pid,
since}; `writeAgentStatus` / `readAgentStatus` in `src/live.mjs`): Copilot from
`assistant.turn_start`, `session.idle` and permission requests; pi from `agent_start` /
`agent_settled` (the coordinator through `atf.ts`, subagents through `atf-live.ts`);
opencode from `session.status`, `session.idle` and permissions. Copilot also writes its
state to the terminal itself (`OSC 7501;state=idle|blocked[:app=copilot][:kind=permission]`,
seen in a real run): the daemon keeps the last one per session (`appState`), so "waits
for your approval" is known even before the ATF extension is loaded (Copilot asks
whether to launch it, once per repository). The backend takes the latest of the
extension's report and the terminal's state; a status whose writer has ended is
ignored, and without either the session's output decides (output in the last 8 s:
working).

Tried with real agents through the backend (macOS): pi took its prompt as the
message argument, did its task and reported idle; Copilot took `-i`, after its folder
trust and extension questions (answered in the session), then asked to run its first
command, as it does in herdr. A daemon keeps running the code it started with: after
an update its sessions must end (`atf-sessions stop`) before new code applies.

**Supervisor** (in atf-web, running whether or not a browser is open): the lifecycle
sweep (close sessions of subagents that finished, report a missing coordinator, nudge
an idle coordinator), and notifications (§7). It is the sessions-backend counterpart of
what `atf-herdr` runs inside herdr.

Built (phase 2): `src/supervisor.mjs`, `startSupervisor(backend)` / `superviseOnce`. Every
5 s, for each project with sessions or registry entries: new events file the agents'
harness sessions on their tasks and tie a new plan to the coordinator that created it
(what herdr's post-write hook does), then the lifecycle sweep. Subagent sessions that
exited by themselves are dropped after 5 minutes. `atf-sessions supervise` runs it
until atf-web does (phase 3).

### 4.4 Web server (`atf-web`)

- Listens on `127.0.0.1` only. A random token (kept in `~/.config/atf/web-token`, 0600)
  in the first URL sets an HttpOnly, SameSite=Strict cookie; the WebSocket also checks
  the Origin. All of it on one port.
- **Read API:** projects (`knownRoots`), plans and their folded state (`loadPlan`,
  `derive`), attention per plan (§4.3), briefs (`brief`), changes (`planChanges`),
  live runs, plan documents. JSON over HTTP.
- **Live updates:** one server-sent events stream per browser tab with the scopes it
  shows. The server watches `.atf/plans/*/events.jsonl` and `live/` (`fs.watch`, with
  polling as fallback where the filesystem does not report changes) and sends what
  changed; the browser refetches that plan.
- **Actions:** the human's actions go through the same functions as the CLI and the
  board: approve, request changes, answer, note on a task or plan, mark a task of yours
  done, close a plan, start / resume / replace a coordinator. The CLI's command bodies
  for these move into `src/actions.mjs` (actor `human`), shared by CLI, board and web.
- **Terminals:** a WebSocket relaying to atf-sessiond (spike: `web.mjs`).
- **Files (later, §9):** the same server, its own API.

Built (phase 3): `adapters/web/server.mjs` (`atf-web`) and `ws.mjs`. As designed, with
these choices:

- **Liveness** comes from one connection to the daemon, its session list refreshed every
  second (`sessionsLiveness` in `src/sessions.mjs`): "needs you" is computed per request
  without calling the daemon. An actor whose writes came from herdr counts as running
  elsewhere, so a plan driven from herdr does not show "no coordinator".
- **Plans** are folded once per change of their log (size and mtime).
- **Live updates** poll once a second (event logs, live files, the sessions and their
  agents' states) instead of `fs.watch`: it works on every filesystem and costs little for
  a few dozen plans. The stream says which plans changed; the page loads the Overview
  again (it carries the folded state of every open plan).
- **API additions:** `/api/log` (a plan's last events) and `/api/doc` (only documents the
  plan lists, inside its project).
- **Starting a coordinator** runs `atf-sessions coordinate` as a child process: a handoff
  waits up to minutes for the checkpoint and must not block the server.
- **The browser may only watch and type** (`list`, `attach`, `detach`, `input`, `resize`):
  starting commands goes through the API (coordinators) or later shell tabs (phase 5).
- **Writes** need the cookie, JSON and the same origin (with SameSite=Strict, no other
  site can post as the human).

### 4.5 Front end

Layout (herdr's workspaces plus the board):

```
┌ workspaces ──────────┐┌ 0 Overview · 1 Tasks · 2 Plan · 3 Log · 4 Changes ─────────┐
│ ▾ my-app             ││ NEEDS YOU                                                  │
│   ▾ P1 checkout  2 ⚑ ││   T5 question  approve the SQLite order schema?            │
│       ● coordinator  ││ YOUR TASKS · IN FLIGHT                                     │
│       ● backend   T2 ││ ┌ details of the selected row: brief, actions ──────────┐  │
│       ○ tests     T4 ││ │ [Approve] [Request changes] [Answer]                  │  │
│   ▸ P2 auth          │├┴───────────────────────────────────────────────────────┴──┤
│ ▸ other-repo         ││ coordinator │ backend │ shell                    (panes)   │
└──────────────────────┘│ copilot …                                                  │
                        └────────────────────────────────────────────────────────────┘
```

- **Sidebar:** projects, their plans (a plan is a workspace, as in herdr), each plan's
  agents with their state and task; needs-you counts per plan. Several plans active at
  once is the normal case.
- **Board:** the board's views with its scopes (all projects → project → plan), sections
  (NEEDS YOU, YOUR TASKS, IN FLIGHT), task details and actions. The keys of the board
  work the same (`a x r n N s S g o c`, `0-4`, `/`, `j k`, `esc`), with mouse and buttons
  on top; text entry is a normal text area.
- **Agent panes:** below or beside the board (adjustable, or full screen), tabs per
  agent of the plan in scope; `g` on a task opens its agent's pane. The coordinator's
  pane is always there for an active plan. A shell tab in the project on demand.
- **Theme:** CSS variables in one file per theme (`themes/macchiato.css`), terminal
  colours included; a setting picks the theme.
- **Code:** ES modules, no framework, no build. Small helpers for rendering lists and
  keyboard handling written here. xterm.js and its fit and WebGL addons are the only
  third-party code (§11).

Built (phase 3): `adapters/web/public/` (`app.js`, `terms.js`, `app.css`,
`themes/macchiato.css`); how to use it: `adapters/web/README.md`. Tried in headless
Chrome against a project with a review, a question, a task of the human's and a
coordinator in the daemon: approving, answering and finishing from the keyboard, the
supervisor nudging the coordinator with the answer (seen live in its pane), and starting
a coordinator from the page after its session ended. Choices on the way:

- ⏎ on a waiting coordinator or agent opens its pane and gives it the keys; `ctrl+]`
  gives them back to the board (as `atf-sessions attach` detaches), and the top bar says
  which agent is typed into meanwhile.
- When the selected row goes away (approved, answered), the row now at its place is
  selected, so working down NEEDS YOU is `a`, `a`, `r`, …
- The Log leaves out change snapshots and session ids.

## 5. Several plans, projects and worktrees

- Plans live in different project directories, each with its own `.atf/`
  (`knownRoots`). The UI groups them by project.
- A repository's worktrees are separate project directories (`.atf/` is not shared
  between them); the UI groups worktrees of the same repository (`git rev-parse
  --git-common-dir`) under it, so a parent with several worktrees reads as one item.
- Each plan's agents run in their project directory (or the worktree its tasks name),
  so agents of different plans never share a working tree unless the plans do.
- Live updates, attention and the supervisor work across all known projects, not only
  the one in view.

## 6. The human's identity

v1 keeps the one human of the protocol (`HUMAN = 'human'`): the server belongs to one
developer. For stage two, the planned additive change (SPEC §11): human events carry
`ctx.user` (who, from the sign-in), the actor stays `human` (so permissions and folding
are unchanged), and frontends show the name. Nothing in v1 stops that change.

## 7. Notifications

Without X on the devpod, notifications are the browser's: the Notification API (after
the user allows it once) and a count in the tab title, for what appears under NEEDS YOU
and YOUR TASKS (the same rules as `notify.mjs`, whose descriptions move to `src/`). The
`[notify] command` keeps working, run by the supervisor.

## 8. Changes and diffs

v1 shows the Changes view as the board does (per plan, tasks and their files with line
counts, `planChanges`). How to look at a diff in the browser (unified/side by side, a
task's or a package's changes, review comments) is designed separately.

## 9. File browser (later)

Essential, built after the first version: navigate the devpod's filesystem and work with
files the way yazi does, adjusted for mouse users: list, preview (text, images, Markdown),
open in a viewer or as a terminal command, create, rename, move, copy, delete (to a trash
first), upload and download. Kept in mind now:

- The server's file API is general: `stat`, `list`, `read` (ranges), `write`, `move`,
  `copy`, `trash`, `mkdir`, with paths checked against allowed roots (home and project
  directories in v1).
- In stage two the same API is how the browser reaches the repositories, so it must not
  rely on the browser and the files being on one machine.
- Plan documents, artifacts and changed files open through it.

## 10. Stage two: hosted on Kubernetes

Not built now; v1 should not get in the way of it:

- The browser only talks HTTP, SSE and WebSocket to `atf-web`; nothing assumes the
  files or agents are on the browser's machine.
- Per user a pod (or workspace) with atf-sessiond, the agents and the repositories;
  atf-web routes to it. Sign-in (OIDC) instead of the token, `ctx.user` (§6).
- Tunnel-free: the same single port behind an ingress.

## 11. Dependencies and licences

Node built-ins only on the server side. System tools: util-linux `script` and `stty`
(present on every Linux), `git`; python3 only on macOS for development.

Third-party files in the browser, each copied into `vendor/` with its licence file:

| what | version | licence | why |
|---|---|---|---|
| xterm.js | 6.0.0 | MIT | the terminal emulator (not worth writing ourselves) |
| @xterm/addon-fit | 0.11.0 | MIT | fit the terminal to its pane |
| @xterm/addon-webgl | 0.19.0 | MIT | renderer; draws box-drawing characters itself (lines without gaps), faster |
| JetBrains Mono | 2.304 | SIL OFL 1.1 | font, full character set (from JetBrains' release; a Latin-only subset lacks box drawing) |
| marked | 18.3.0 | MIT | Markdown to HTML (plan documents, the file viewer); its output goes through our allowlist sanitizer |
| highlight.js | 11.12.0 | BSD-3-Clause | syntax highlighting: the ES "common" bundle plus Dockerfile, Gradle, Groovy, Scala, protobuf, PowerShell, nginx grammars |
| Catppuccin palette | — | MIT | colours (values only) |

Possibly later: `@xterm/headless` (MIT) for the replay fallback (§4.1). Before adding
anything else: check its licence permits copying it with attribution, and note it here.

## 12. Build plan

Each phase ends with the tests green (`node --test test/atf.test.mjs`) and is usable on
its own. Core changes land in `src/` in a form the CLI and the board use too.

0. **Spike** (done, `spike/webterm`): agents in our own sessions, in the browser,
   through the tunnel.
1. **Core: launcher and attention in `src/`.** `src/launch.mjs` with the backend
   interface, the herdr backend (the board behaves as before), `atf spawn` / `atf
   coordinate`, kind `prompt` arguments; `src/attention.mjs` with liveness as a
   parameter; `src/actions.mjs` for the human's actions. Tests for each.
2. **Sessions backend** (built; the CLI is `bin/atf-sessions`). `bin/atf-sessiond` from the spike, with session `meta`; the
   sessions backend; agent status in the extensions' live state (Copilot first, then pi,
   opencode); the supervisor (sweep). Tests run the daemon (Linux `script`, macOS
   python).
3. **First usable web UI** (built; still to try on the devpod with Copilot on a real plan). `bin/atf-web`: read API, SSE, actions, terminal relay,
   token. Front end: sidebar, Overview with NEEDS YOU / YOUR TASKS / IN FLIGHT, Tasks,
   Plan, Log, task details and actions, agent panes, starting / resuming / replacing a
   coordinator. Tried on the devpod with Copilot on a real plan.
4. **Rest of the board.** Changes list, live view (builds, tests, pipelines), plan
   documents, browser notifications, approvals waiting in an agent under NEEDS YOU.
5. **Without a terminal at all.** New plan from the browser (a coordinator without a
   plan, told what to plan), project setup (`atf init`, skill and extension install
   checks), settings and themes, shell tabs.
6. **Later, each with its own design:** file browser (§9), diffs and reviews (§8),
   identities (§6), stage two (§10).

## 12a. Phase 4 as built

- **Live view** (`L` on a task, ⏎ in Tasks, the Live list in a task's details): the
  task's runs in the board's order (waiting, running, recorded), `[` `]` between them; a
  kind with a view (Maven, plugins) shows it with foldable sections and items (a failed
  test: its stack trace), `o` switches to the raw output; a kind without one shows its
  output, following the end while it runs. The page asks again every 1.5 s while a run is
  active. Server: `/api/live`, `/api/live/run`, the same `taskLive` / `liveView` /
  `liveItem` as the board (live plugins load at start). Only files of the task's runs are
  read. Task rows carry the board's live badge (`liveBadge`).
- **Changes** (tab `4`, plan scope): per task its files with line counts, files another
  task also changed marked; ⏎ / `d` a file's or a task's diff, `o` the file. Server:
  `planChanges`, cached per plan for 10 s (the working tree changes without events).
  Core change: ATF's own files (`.atf/`) are never a task's changes (`diffFiles` excludes
  them), for projects that keep `.atf/` in git; the board and `atf diff` profit too.
- **File viewer** (in place of the board): Markdown rendered (marked) or as source (`m`),
  code highlighted with line numbers (highlight.js, by extension or file name), diffs
  coloured per file. `/api/file` reads files inside the project only (real paths, so no
  symlink leads out), at most 2 MB, binaries are not shown. Plan documents open in it,
  and their relative links open the linked file; file and log artifacts too.
  **Rendered Markdown is sanitized:** raw HTML in a document is shown as text, the
  rendered HTML is parsed inert and only an allowlist of elements and attributes is
  kept; links only to http(s), mailto, anchors and relative paths; images are not loaded
  (their text instead). A repository's document must not run script in a page that can
  act as the human.
- **Notifications:** the texts and identities moved from the herdr adapter to
  `src/notify.mjs` (`describe`, `keyOf`), so herdr and the web say the same. The page
  notifies each new item once (live items after 5 s), through the browser's
  notifications when the page is in the background (the bell in the sidebar asks for
  permission), else as a toast; the tab title counts what needs you. What was there
  when the page first opened counts as seen.
- **Approvals:** an agent waiting for a tool approval (Copilot's terminal state or an
  extension's report) is `! prompt` under NEEDS YOU, ⏎ opens its pane; a command waiting
  for approval shows on its task's live badge.

## 12b. The IDE layout (replaced by 12c)

The first pages followed the herdr board too closely: one view at a time, switched with
keys. The page is now laid out like an IDE, so what matters most stays visible:

- **Explorer** (left, can be hidden): projects › plans › agents. A plan opens its page
  and sets the work panel's filter; an agent opens its terminal.
- **Needs you** (always, all plans): what needs the human, then their own tasks; a
  hover shows each row's quick action (Approve, Answer, Done, Start, Terminal).
- **Work panel** (under it): Tasks, Log and Changes, for all open plans or one (the
  filter; with all, grouped per plan).
- **Editor** (centre): everything opened is a tab, as files in an IDE. A task page
  replaces the detail pane (the question or submission at the top with the actions and an
  inline composer; acceptance, live runs, changed files, artifacts, notes, history); the
  plan is a page too (where it stands, the coordinator, documents, tasks, notes), so the
  board's Plan tab is gone. Live views, files, diffs and terminals are tabs as well.
  Single click: a preview tab, replaced by the next; double-click or writing in it: kept.
  Two groups side by side (open to the side). Open tabs are remembered.
- **In flight** (right, always, all plans): per plan its progress and coordinator, per
  task in progress its agent and what runs or waits now (the live badge). It belongs to
  the live view: a run line opens it.
- **Terminals** (bottom): the agents of the plans the work panel shows; one can move into
  an editor tab and back.
- A command palette (⌘K / ctrl+K) over plans, tasks, documents, agents and commands;
  right-click menus; the keys work on the active tab (a task: `a x r n L d g`; a plan:
  `s S N c g`). Panel sizes are dragged and remembered.

Code: `public/app.js` (state, panels, palette, keys), `editor.js` (tab groups),
`pages.js` (the documents), `terms.js` (terminals that move between the panel and tabs),
`viewer.js` (Markdown, code, diffs), `util.js`.

Found on the way: two starters of the session daemon at the same moment (atf-web and
`atf-sessions start`) could start two daemons, the second taking the socket over and the
first one's sessions becoming unreachable. A daemon now takes a lock next to its socket
(`<socket>.lock`, its pid) and leaves when another one holds it.

## 12c. The cockpit (replaces the IDE layout)

The editor approach was wrong for this: nothing is edited, and managing tabs is work the
human should not have. What they look at most of the time is what needs them and what is
in flight, for every plan at once (as herdr's overview, rarely filtered by plan); the plan
itself mainly to recall where it stands, its details a click away. Next most: the
coordinators, often in a conversation while agents work. And whether everything actually
runs: no task in progress that nobody works on.

- **Structure first:** every view is grouped per plan, in a box under the plan's name
  (task ids are per plan); a marker in the plan's colour (muted, a few in rotation) is a
  second hint. Plans that need the human come first, then those at work, then the quiet.
- **The rail** (leftmost): an icon per panel that can be hidden (Plans, Needs you, Your
  tasks, Terminal; In flight is the centre and stays), lit when shown, with a badge that
  keeps a hidden panel's news visible (needs-you count, your tasks, a waiting coordinator).
  Panels hide from their header (`–`), the rail or `alt+shift+1…4`; remembered.
- **Plans** (can be hidden): every open plan with its task tree, closed plans
  below; a task opens its details. A task in progress carries a dot saying whether it is
  worked on right now (its agent working or a command running, a command waiting for
  approval, its agent idle, nothing running, no agent); a parent the count of its tasks in
  progress with the most urgent dot.
- **Needs you** (left, top): what needs the human now, per plan, each with its action
  at hand; answers, change requests and closing notes are written right there. An item
  opens in the details as itself (not its task): what it is in full, its context, its
  actions, then tabs to the task, Live, Changes; once handled it stays, greyed, saying so. Besides the
  plan's attention: commands held for the human's approval (from the live glance) and
  orphaned tasks (below). **Your tasks** below it, a panel of its own: what the human
  will have to do eventually, not now.
- **Subtasks** are numbered under their parent (T4.2): the id says little. Wherever one
  appears its parents come with it: in In flight the cards sit under their parents, nested as
  the plan's tree is at any depth (id, title, parts done; a parent's own cards, then its
  parts with work; siblings side by side, no order implied), in Needs you and the details' path their titles precede it.
- **In flight** (centre): only what is being worked on. Per plan its progress, coordinator,
  how many items wait for the coordinator, last change, its parts (the top-level tasks
  with parts, each with its own state: how many in progress, done, or `after T2` when it
  waits on a dependency; not a sequence with one current stage, since tasks run side by
  side unless they depend on each other), where it stands (the checkpoint); a card per task in progress, in the plan's
  order. Cards have one fixed size (title, one line of steps: a track with a segment per step, then
  the current step first, so it is never what gets cut, and the next one, a live box of fixed height),
  so nothing moves while the content changes: its agent and state, its steps, its run at a
  glance (the kind's compact view, as below a task on the board: the server sends it with
  the overview, `glance`).
- **Health:** the server marks a task in progress whose agent has no session here
  (`health`): `elsewhere` when its writes came from herdr or another daemon, `orphan` when
  in addition nothing happened on it for 10 minutes (no command running, no update): an
  agent ATF did not start (a subagent of the human's own harness) is not flagged while it
  works. Orphans are in Needs you, with "Tell the coordinator".
- **The terminals' relay** runs in a process of its own (`adapters/web/relay.mjs`, forked by
  atf-web, restarted if it ends): atf-web checks a WebSocket (cookie, origin) and hands the
  connection over; keystrokes and output then go browser ↔ relay ↔ atf-sessiond and never
  wait for atf-web's event loop (a slow refresh of the board). Frozen atf-web (SIGSTOP): a
  shell still echoes in milliseconds. Without the relay, atf-web relays itself.
- **Refreshing**: the stream says which plans changed; the page asks for those only
  (`/api/overview?only=`), the rest come as `{key, same}` and it keeps its own. Everything
  again when sessions change, and every 30 s (what depends on time). Of a changed plan, only
  its tasks that changed: the page names the version it has (`last_seq`), the server keeps
  each plan's last 30 versions as sent (a JSON string per task) and sends the tasks that
  differ (`delta`, `removed`; side effects such as a parent's rollup or a task turning ready
  included, since whole tasks are compared), else the whole plan. A plan of 160 tasks with
  an agent at work: 6 KB per refresh instead of 150 KB. The overview carries
  per task what the panels show; a task's history, notes, artifacts and whole description
  come with its page (`/api/task`). A big, quiet plan costs almost nothing per refresh.
- **Shells** (the terminal panel's third kind, after coordinators and agents): the user's
  login shell on the server's machine, run by the session daemon (`meta.role: 'shell'`:
  never taken for an agent, left alone by the supervisor). Opened in a plan's project folder
  (listed under that plan) or in home (the "Shells" group); `POST /api/shell`,
  `/api/shell/close` (only shells). Its state is whether a command runs: the terminal's
  foreground process group (`ps -o tpgid`) is not the shell's (`working`, with the command's
  name) or is (`idle`): not its output, which typing and prompts produce too. The browser still cannot start commands over the
  WebSocket: a shell is started by the server, in a known project or home.
- **Details** slide in over In flight (one at a time, tabs per kind, `‹` / the browser's
  back / `esc`). A task's state sits on the tabs' row: the Plans view's dot, in words. Files and diffs open there too.
- **Terminal** across the bottom: the one shown, titled plan › Coordinator (or plan ›
  task · agent), and the list of all terminals beside it, per plan, coordinator first.
  40% of the height so a conversation can be followed and answered without enlarging;
  `alt+1…9` the coordinators.

Code: `public/app.js` (state, panels, terminal, palette, keys), `drawer.js` (the
details), `pages.js` (their views), `terms.js`, `viewer.js`, `util.js`. The demo
(`examples/live-views.mjs`) has its agents work through steps.

## 13. Open

- Whether replaying raw output holds up across size changes, or the headless screen
  copy is needed (decide in phase 2 with real use).
- How each harness reports "waiting for approval" (Copilot's extension sees tool
  permission requests; pi and opencode to check).
- Supervisor in atf-web vs. its own small process: in atf-web unless restarts of the web
  server turn out to disturb it.
- Starting atf-web and atf-sessiond when the devpod starts (a login script, systemd
  user unit if available), so the developer never has to open a terminal for it.
