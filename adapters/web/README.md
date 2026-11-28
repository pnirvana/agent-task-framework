# ATF web UI

ATF in the browser, as a cockpit: follow plans, answer, review, give direction,
start and replace coordinators, watch every build and test, and type into every agent,
without herdr or a terminal. Design: [docs/webui-design.md](../../docs/webui-design.md).

## Start

```sh
atf-web                     # prints http://localhost:7420/?token=…
```

Open the printed URL once: the token sets a cookie, after which `http://localhost:7420`
is enough. `atf-web url` prints it again. The server listens on 127.0.0.1 only.

On a remote machine (a devpod), tunnel the one port and open the URL locally:

```sh
ssh -L 7420:localhost:7420 <devpod>
```

`atf-web` starts ATF's session daemon (`atf-sessiond`) if it is not running, and runs the
supervisor: finished agents are closed, an idle coordinator is nudged when something
needs it. Agents run in the daemon, so they keep running when you close the page or
restart `atf-web`. Pick the agent kind in `~/.config/atf/config.toml`:

```toml
[sessions]
agent_kind = "copilot"   # pi | copilot | opencode | claude | codex
```

## The layout: a cockpit

```
┌ Needs you ─────────────────┐┌ In flight ────────────────────────────────────────────────┐
│┌ Checkout service  demo  2┐││┌ Checkout service  demo                      ▰▰▱▱ 2/4 done┐│
││ ? T4 which token TTL?     ││││ ● coordinator lead working 12s           changed 3m ago  ││
││   [Answer] [Open]         ││││ ┌ T3 Backend API    ● be working ┐ ┌ T5 Frontend ──────┐ ││
││ ⚠ T6 no agent runs it     ││││ │ step 2/4 ✓ schema ▶ endpoints  │ │ step 1/3 ▶ coupon │ ││
││   [Tell the coordinator]  ││││ │ ⚙ maven 4/6 shop-api 40/~71 … │ │ ⚙ tests 212 ✓     │ ││
│└───────────────────────────┘│││ └────────────────────────────────┘ └───────────────────┘ ││
│ YOUR TASKS …                │└───────────────────────────────────────────────────────────┘│
└─────────────────────────────┘└────────────────────────────────────────────────────────────┘
┌ Checkout service › Coordinator   lead · copilot · ● working ────┐┌ Checkout service ──┐
│ (the terminal)                                                  ││ ● Coordinator  lead│
│                                                                 ││ ● T3 Backend API be│
│                                                                 ││ Shop release       │
└─────────────────────────────────────────────────────────────────┘│ ○ Coordinator  not…│
```

Every open plan at once, each in a box under its name: task ids are per plan, so nothing
appears without its plan. A small marker in the plan's colour is only a second hint.
Plans that need you come first, then those at work, then the quiet ones.

- **The rail** (the narrow strip on the far left): an icon per panel (Plans, Needs you,
  Your tasks, Terminal), lit when it shows; a click (or `alt+shift+1` … `4`) shows or
  hides it, and `–` in a panel's header hides it too. A hidden panel's icon keeps a badge:
  how many need you, your tasks, a dot when a coordinator waits. In flight always stays.
- **Plans** (left; shown on wide windows): every open plan with
  its task tree (subtasks under their parents, the done ones dimmed); closed plans below.
  A dot by the owner says whether a task in progress is being worked on right now: green
  (its agent works or a command of it runs), yellow (a command waits for your approval),
  grey (its agent waits), hollow (nothing running), red (no agent runs it); a parent shows
  how many of its tasks are in progress, with the most urgent dot.
- **Needs you:** what needs you now, per plan, with its action at hand:
  questions, reviews, a coordinator waiting, a command waiting for your approval, a plan
  without a coordinator, a task in progress that no agent runs any more (no session and
  nothing happening for 10 minutes), an idle agent, failures. Answers, change requests
  and closing notes are written right there (`⌘/ctrl+⏎` sends). Clicking an item shows
  it in the details: the question, review, failure or command in full, its context (the
  task's steps, its last run, its agent; who waits on a task of yours) and its actions;
  tabs lead on to the task, its live runs and changes. A coordinator waiting at its prompt
  opens its terminal.
- **Your tasks**, below it: what you will have to do eventually, per plan.
- **In flight:** what is being worked on and how it goes. Per plan: progress, its
  coordinator, how many things wait for the coordinator, when it last changed, its
  parts (its top-level tasks that have parts, each with its state: in progress, done, or what it waits
  on; they run side by side unless one depends on another) and where it stands; a card per task in progress, all of one size and in the
  plan's order (only their content changes), subtasks nested under their parent tasks as in the
  plan's tree, any depth (a subtask's own id says little): its agent, its steps (a track, a segment per step, then the current step and the next one), its run at a glance
  (the kind's compact view: modules, tests, failures, a pipeline's jobs, a deployment).
- **Details** slide in over In flight (a task, a plan, a run, a file, a diff), with
  tabs: a task's Overview, Live, Changes; a plan's Overview, Log, Changes, Diff. A task's
  state is beside its tabs: the dot of the Plans view with its status in words ("in
  progress · no agent runs it", "todo · waits on T13.1.1", "2 working · 0/2 parts done"). `esc`
  closes them, `‹` and the browser's back go to what they showed before.
- **Terminal**, across the bottom: the terminal shown, under a title saying whose it is
  (plan › Coordinator, or plan › task · agent); beside it the list of all terminals, per
  plan, its coordinator first (or "not running"). Big enough to follow a conversation and
  answer (40% of the window; dragged smaller it keeps about ten rows). `⤢` taller,
  `–` (or `ctrl+\``) hides it; its icon on the rail brings it back.
- **Shells**: your own terminals on the machine `atf-web` runs on (the devpod), beside the
  coordinators and agents: `+` on a plan in the terminal list opens your login shell in
  its project's folder, listed under the plan; `+` on "Shells" (or `ctrl+shift+\``) one
  in your home folder. They run in the session daemon too, so they outlive the page and
  `atf-web`; `×` ends one. Its dot is green while a command runs in it (its name beside
  it: `vim`, `mvn`, `ssh`), grey while it waits at its prompt. Prompt icons (Nerd Font symbols) are drawn. The terminals are
  relayed by a process of their own, so typing stays quick when the board is busy.

Panel sizes are dragged on the lines between them and remembered, as are the details
shown and the terminal.

## Keys

| key | |
|---|---|
| `⌘K` / `ctrl+K` | search: plans, tasks, documents, agents, commands |
| `alt+1` … `alt+9` | the coordinators' terminals, in the order of the plans |
| `ctrl+\`` | hide / show the terminal |
| `ctrl+shift+\`` | a new shell (in the shown plan's project, else your home folder) |
| `alt+shift+1` … `4` | show / hide Plans, Needs you, Your tasks, the terminal |
| `ctrl+]` | leave a terminal |
| `esc` | close the details · cancel what you write |
| `?` | the keys |
| details of a task | `a` approve / mark done · `x` request changes · `r` answer · `n` message · `L` live · `d` changes · `g` its agent's terminal |
| details of a plan | `s` / `S` start / replace the coordinator · `N` note · `c` close · `g` the coordinator's terminal |
| a live view | `[` `]` other runs · `o` raw output / view |
| writing | `⌘/ctrl+⏎` sends · `esc` cancels |

Everything you do is written as the human (`human`) through the same functions as the
board and the CLI (`src/actions.mjs`); the coordinator decides what follows, as with the
board. Notifications: the bell in the top bar turns on the browser's notifications for
what needs you while the page is in the background; the tab title counts it.

## Not yet

Starting a new plan from the browser, project setup, settings and themes
(docs/webui-design.md §12, phase 5); the file browser, reviews on diffs, several users.
