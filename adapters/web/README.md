# ATF web UI

ATF in the browser: what the herdr board and herdr do together, without herdr or a
terminal. Follow plans, answer, review, give direction, start and replace coordinators,
and watch and type into every agent. Design: [docs/webui-design.md](../../docs/webui-design.md).

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

## The page

- **Sidebar:** projects, their plans, each plan's agents with their state (green
  working, grey idle, red pulsing waits for you). The red counts are what needs you.
- **Views** (`0`-`3`): Overview (NEEDS YOU, YOUR TASKS, IN FLIGHT), Tasks, Plan (notes,
  documents), Log. The scope is all projects, one project or one plan: the sidebar, the
  crumbs and `esc` change it, and `⏎` on a plan opens it.
- **Detail** (right): what you need to act on the selected row (the question and the
  recommendation, the submission and the acceptance criteria, …) and the actions.
- **Agent panes** (below): the agents of the plans in scope. A plan's coordinator is
  always there, with a start button when it is not running. Drag the line above to
  resize, double-click it for full-screen terminals.

## Keys

| key | |
|---|---|
| `0` `1` `2` `3` | Overview · Tasks · Plan · Log |
| `j` `k` `↑` `↓` | move |
| `⏎` | open: a plan, a task in its plan, a waiting agent's pane |
| `esc` | up a level (plan › project › all), or cancel |
| `a` | approve a review · mark your task done |
| `x` | request changes |
| `r` | answer a question |
| `n` / `N` | a message on the task / a note on the plan |
| `s` / `S` | start / replace the coordinator |
| `c` | close the plan |
| `g` | go to the agent (its terminal gets the keys) |
| `ctrl+]` | leave a terminal: the board has the keys again |
| `t` / `f` | hide the terminals / terminals full screen |
| `ctrl+⏎` | send what you wrote |
| `?` | the keys |

Everything you do is written as the human (`human`) through the same functions as the
board and the CLI (`src/actions.mjs`); the coordinator decides what follows, as with the
board.

## Not yet

Changes and diffs, the live view of builds and tests, notifications, starting a new plan
from the browser, shell tabs and settings (docs/webui-design.md §12, phases 4 and 5).
