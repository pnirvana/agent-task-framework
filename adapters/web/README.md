# ATF web UI

ATF in the browser, laid out like an IDE: follow plans, answer, review, give direction,
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

## The layout

```
┌ Explorer ──┐┌ Needs you ─────────┐┌ editor: [Plan] [T2 ×] [T1 live ×] … ┐┌ In flight ───────┐
│ projects   ││ what needs you,    ││                                     ││ per plan: progress│
│  plans     ││ your tasks         ││  the task, plan, live view, file,   ││ coordinator, what │
│   agents   │├ Tasks Log Changes ─┤│  diff or terminal you opened        ││ runs now          │
│            ││ ▾ all / one plan   ││                                     ││                   │
└────────────┘└────────────────────┘└─────────────────────────────────────┘└───────────────────┘
 Terminals: [lead ●] [be T1 ●] …
```

- **Explorer:** projects, their plans and each plan's agents (green working, grey idle,
  red pulsing waits for you). A plan opens its page and filters the work panel to it; an
  agent opens its terminal. Hidden with ☰ (narrow windows start without it).
- **Needs you** (always, for every plan): questions, reviews, a coordinator waiting, a
  plan without one, then your own tasks. Hovering a row shows its quick action (Approve,
  Answer, Done, Start, Terminal).
- **Work panel:** Tasks, Log and Changes, for all open plans or the one chosen in the
  filter (the Explorer sets it too).
- **Editor:** what you open is a tab. A single click opens a preview (the next one
  replaces it, its title in italics); a double-click, or writing in it, keeps it.
  Right-click a tab or a row for more: open to the side (two groups), close others, …
  - **a task:** the question or the submission at the top with the actions (Approve,
    Request changes, Answer, Message, Mark done), then acceptance, live runs, changed
    files, artifacts, notes, history;
  - **a plan:** where it stands, the coordinator (start, replace, its terminal),
    documents, tasks, notes, closing it;
  - **a live view:** a task's builds, tests, pipelines, deployments: the kind's view
    (Maven: modules, failures with their stack traces, test classes) or the raw output,
    following it while it runs; other runs from the list or with `[` `]`;
  - **files** (Markdown rendered, code highlighted), **diffs**, and **terminals** (from
    the terminal panel's ⧉ or a right-click on an agent).
- **In flight** (always, for every plan): progress, the coordinator and what it does,
  and per task in progress its agent and what runs or waits now; a click on that opens
  the live view, the task id its page, the agent its terminal.
- **Terminals:** the agents of the plans the work panel shows, the coordinator first.
  `ctrl+]` leaves a terminal; `ctrl+\`` hides and shows the panel.

Panel sizes are dragged on the lines between them and remembered, as are the open tabs.

## Keys

| key | |
|---|---|
| `⌘K` / `ctrl+K` | search: plans, tasks, documents, agents, commands |
| `ctrl+\`` | show or hide the terminals |
| `ctrl+]` | leave a terminal |
| `?` | the keys |
| on a task tab | `a` approve / mark done · `x` request changes · `r` answer · `n` message · `L` live · `d` changes · `g` its agent's terminal |
| on a plan tab | `s` / `S` start / replace the coordinator · `N` note · `c` close · `g` the coordinator's terminal |
| in a live view | `[` `]` other runs · `o` raw output / view |
| writing | `⌘/ctrl+⏎` sends · `esc` cancels |

Everything you do is written as the human (`human`) through the same functions as the
board and the CLI (`src/actions.mjs`); the coordinator decides what follows, as with the
board. Notifications: the bell in the top bar turns on the browser's notifications for
what needs you while the page is in the background; the tab title counts it.

## Not yet

Starting a new plan from the browser, project setup, shell tabs, settings and themes
(docs/webui-design.md §12, phase 5); the file browser, reviews on diffs, several users.
