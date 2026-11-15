# ATF × herdr

A herdr plugin (`atf.herdr`) plus a CLI (`atf-herdr`) that makes ATF plans visible and
actionable inside herdr. Optional: ATF itself does not depend on any of this.

| feature | what you get |
|---------|--------------|
| **Task board** | interactive TUI as a full-height side column (`prefix+t`, toggle) or popup (`prefix+alt+t`); one scope for all tabs (all projects › project › plan): Overview, Tasks (as a tree or grouped by agent), Plan, Log |
| **Agent pane labels** | each subagent's pane title becomes `T3 · Token endpoint`, with tokens `$atf_task`, `$atf_status` (`◐ in progress 40%`), `$atf_plan` |
| **Sidebar progress** | workspace tokens `$atf_plan`, `$atf_progress` (`3/5 ✓ 1 ◐ 1 ⊘`) for the Spaces sidebar |
| **Notifications** | herdr notification when a task becomes blocked, needs review, or fails, and when a plan finishes |
| **Stall detection** | board flags `stale?` when a task is in progress but its herdr agent has been idle > 90s (an agent that stopped without reporting) |
| **Overview** | tab `0`, where the board starts: what needs you (agents waiting for input, your reviews, finished plans), then per plan only the tasks being worked on with their latest progress; a context panel for the selected row; approve, request changes, reply, open the review artifact or jump to the agent's terminal with one key |
| **Spawn** | `s` on a ready task or package (or `atf-herdr spawn T3`) places a pane in a balanced grid, starts the agent (pi by default; the atf skill is discovered once installed with `atf skill install`), assigns the task and sends the kickoff prompt |
| **Reviews** | `a` / `x` / `n` on any task draft an approval, change request or note (`d` drops, `S` submits all at once: one write per plan, so the coordinator wakes once and each owner gets all its points). Tasks that ask you to test something show as `◎ for you` |
| **Agent lifecycle** | the coordinator starts every subagent (fresh by default); finished subagents are closed; an idle coordinator is nudged when something needs it; `atf-herdr coordinate` starts or resumes a plan's coordinator, or replaces it with a fresh session |

## Install

```sh
herdr plugin link /path/to/agent-task-framework/adapters/herdr
herdr plugin action list --plugin atf.herdr
```

Requires Node ≥ 18 on PATH (`run.sh` adds `/opt/homebrew/bin` and `/usr/local/bin`).
Install the agent skill too, so agents find it without `--skill`: `atf skill install`
(see the main README).

### Keybindings (`~/.config/herdr/config.toml`)

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "atf.herdr.board"
description = "ATF: task board (this project)"

[[keys.command]]
key = "prefix+alt+t"
type = "plugin_action"
command = "atf.herdr.board-popup"
description = "ATF: overview of all plans"
```

### Sidebar rows (optional, same file)

```toml
[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["branch", "git_status"], ["$atf_progress"]]

[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab"], ["agent", "$atf_task", "$atf_status"]]
```

Then `herdr server reload-config`.

## Usage

1. In a project with `.atf/` (`atf init`), run the plugin action **atf: enable live sync
   for this project** once (or `atf-herdr enable-sync`). This adds a post-write hook to
   `.atf/config.json`, so every `atf` write from any pane updates labels, sidebar, and
   notifications even while the board is closed.
2. `prefix+t` toggles the board for the focused pane's project (found from its cwd,
   walking up to parents and the main git worktree). In a pane without a project it
   opens the overview of all projects and offers `i` to create one there.
   `prefix+alt+t` is the quick look: a popup with the overview of all projects and the
   inbox; ⏎ drills into any plan or task. Inside either, ⏎ narrows the scope to a plan,
   Esc widens it again and `A` jumps to all projects.
3. Start the plan's **coordinator** (it plans, decides and starts every subagent; see
   SPEC §12): from the board (`s` on a plan resumes its coordinator session, `S` starts a
   fresh one) or `atf-herdr coordinate [--plan ID] [--fresh]`. The coordinator starts
   subagents with `spawn`:
   ```sh
   atf-herdr spawn T3 --name worker-1            # pi, placed in the tab's balanced grid
   atf-herdr spawn T2 --name backend             # a parent task: the whole work package
   atf-herdr spawn T4 --agent reviewer           # run it as a named agent definition
   atf-herdr spawn T7 --early                    # start before its dependencies are done
   atf-herdr spawn T6 --kind claude              # another agent kind
   atf-herdr spawn T5 --dry-run                  # show placement mode, args, resume decision
   atf-herdr spawn T4 --resume                   # resume the session that worked on T4 (default: fresh)
   ```

### Several workspaces, sessions and projects

- Agents can run in any herdr workspace: live state, labels, nudges and the lifecycle
  sweep work across all workspaces of the herdr server. Agents are found by name, so a
  pane moved to another workspace keeps working.
- Events record the herdr server (`herdr_socket`). Agents of *another* herdr session
  (or machine) are shown read-only (`↗` in the overview) and never prompted or closed,
  because their pane ids and names may collide with local ones. Agent names also repeat
  across projects: an agent counts for a plan only if it works in the plan's project.
- `atf-herdr spawn T3 --workspace w4` places the agent in another workspace.
- Projects are discovered from the working directories of all herdr panes (when the
  overview opens with all projects, or `atf-herdr discover`) and from `atf init` /
  plan creation. Plans on another machine are only visible if the project directory is
  shared.

### Board views

The board has one **scope**, shown as a breadcrumb in its header:
`all projects › project › plan`. ⏎ on a plan narrows to it, Esc widens again
(plan → project → all projects → quit), `A` jumps to all projects. Both `prefix+t` and
`prefix+alt+t` start on the Overview of all projects (`"board_start": "plan"` in the
plugin config makes `prefix+t` open the focused project's plan instead).

Every tab shows its content for the scope (`Tab` / `0`–`3`):

- **Overview**: built for supervising several plans at once. Two sections, then the
  context of the selected row:
  - **Needs you**, most urgent first: an agent waiting at a dialog in its terminal
    (`! prompt`), an active plan without a running coordinator (`⚠ no coord`: `s`
    resumes it, `S` starts it fresh), questions the coordinator escalated to you on a
    task (`⊘ question … for you`, with its question, your recommendation and the
    subagent's original question) or about the whole plan (`? plan`), tasks whose
    reviewer is the human (`◎ review`), a coordinator waiting in its prompt (`? input`,
    with the last lines of its terminal) and finished plans to close. The coordinator's
    own work (its reviews, subagents' questions, failures, stalled agents) appears here
    only when no coordinator runs for the plan; otherwise the plan row counts it as
    queued. Each item has its message on a second line.
  - **In flight**: one row per plan (progress, agents, coordinator state, queued items,
    `✎N` = tasks with your input the coordinator has not acted on yet), then
    only the tasks being worked on now (in progress, reworked after a review, answered)
    with their latest progress message, owner and agent state. A plan with nothing in
    flight says why (`nothing in progress: 1 in review, 2 ready, not started`).
  - **Context panel**: for a task the question, the review summary with acceptance
    criteria and artifacts, the change request, or the latest progress and checkpoint;
    for a waiting agent the tail of its terminal; for a plan its goal, open questions,
    documents, plan checkpoint and branches.

  Actions take effect at once, in the Overview, Tasks and details. **What you write goes
  to the coordinator**, which decides what happens (SPEC §12.5): `a` approves a task in
  review (done at once), `x` sends a change request, `r` answers a question or leaves a
  message on a task (on a plan: a plan note; to a coordinator waiting in its prompt:
  typed into it), `o` opens the task's artifact (PR/URL in the browser, a branch diff,
  commit or file in a new herdr tab "review T<n>") or the plan's documents, `g` goes to
  the agent's terminal, `s`/`S` start the plan's coordinator (resume / fresh), ⏎ opens
  the full task or plan (Esc comes back), `c` closes a plan.
- **Tasks**: at plan scope the task tree (with a needs-attention list and a preview of the
  selected task); at wider scopes one collapsible node per plan containing its tree
  (plans with open work start expanded). `▣ name` marks a work package, `↳name` an owner
  inherited from the package. `v` groups the tasks by agent instead: per agent a heading
  with its live herdr state and pane, tasks done / total and when it last wrote, then its
  work packages (▣) and tasks with their place in the plan; then the unassigned tasks
  and how many are ready. `g` on a heading goes to that agent. (This replaces the former
  Agents tab; the Overview's plan rows count the agents with open work: ⚙ working,
  ! at a prompt, ◌ idle, · not running.)
- **Plan**: one plan: goal, description, outcome, documents (`o` opens them), questions
  for you, the plan checkpoint, the coordinator (running or not, its session; `s`/`S`),
  per-branch progress with owners, questions, decisions, warnings, blockers, artifacts. At wider scopes: one card per plan
  (goal, outcome, branch progress, counts); ←/→/space fold a card, `z` folds all, ⏎ opens
  the plan's full details.
- **Log**: events of all plans in scope, newest first, tagged with their plan. `/` searches
  as you type (every word must match; matches highlighted), `p` picks one plan of the
  scope to filter by (the plan picker popup), Esc clears the filter. A filtered log searches each plan's whole history.

Rows always know their project and plan, so `g`, `a`, `x`, `r`, `o`, `s` and ⏎ work at any scope.

### Board keys

| key | action |
|-----|--------|
| `Tab` / `0`–`3` | switch view: `0` Overview · `1` Tasks · `2` Plan · `3` Log |
| `v` | Tasks: task tree ↔ grouped by agent |
| `⏎` / `Esc` / `A` | narrow scope to the selected plan / widen / all projects |
| `↑↓` / `jk`, PgUp/PgDn | select / scroll |
| `←→` / `hl`, `space` | collapse / expand subtrees (`←` on a leaf jumps to its parent) |
| `⏎` | full task details (scrollable) |
| `g` | focus the owning agent's pane (closes the popup) |
| `a` / `x` / `r` (`n`) | approve / change request / answer or message, at once; `x`, `r` go to the coordinator |
| `o` | open the task's artifact (PR, branch diff, commit, file, URL) or the plan's documents |
| `s` / `S` | start the plan's coordinator: resume its session / a fresh session (press twice; replaces a running one after its checkpoint) |
| `p` | plan picker: a popup listing every plan by project with its goal and state; typing filters it; ⏎ goes to the plan (in the Log: filters the log to it) |
| `/` | Log: search |
| `?` | help |
| `q` | close view / quit |

In the plan picker, `ctrl+j` / `ctrl+k` also move the selection. If a pane-navigation
plugin such as [herdr-nvim-nav](https://github.com/aimdevlee/herdr-nvim-nav) binds
ctrl+h/j/k/l in herdr, the board registers its pane with it the way Neovim does, but only
while the picker is open, so the keys still move between panes the rest of the time.
Elsewhere in the board use `j` / `k` or the arrow keys.

### Plugin config (optional)

`$(herdr plugin config-dir atf.herdr)/config.json`:

```json
{ "agent_kind": "pi", "board_placement": "auto", "board_start": "overview" }
```

`board_placement`:
- `auto` (default): a **full-height right-hand column** (about 38% of the tab, at least 50
  columns). herdr can only split panes, not a whole tab, so the adapter rearranges the
  tab around the board: it parks the other panes in a temporary tab, splits the remaining
  one, and moves the parked panes back in their original arrangement (the same technique
  as herdr-nvim's sidebar). Agents keep running; it takes a fraction of a second. If a
  rearrangement is interrupted, `atf-herdr recover` (or the next toggle) brings the
  parked panes back. Tabs narrower than 110 columns get the board as its own tab.
- `beside`: no rearranging; the board splits the tallest pane that has room.
- `tab`: always its own tab.

`board_start`: `overview` (default) opens the board on the Overview of all projects;
`plan` opens the focused project's plan in the Tasks view.

`prefix+t` toggles it per workspace either way; `prefix+alt+t` is the overview popup.

### Agent lifecycle (SPEC §12: the coordinator decides)

- **The coordinator** runs as long as its plan is active. `atf-herdr coordinate` (or `s`
  on the board) starts it in its own tab, labelled `plan: <title>`, with the plan's
  identity (the subagents it spawns open next to it there; every agent pane is labelled
  with the agent's name), resuming the plan's
  coordinator session if one is recorded; `--fresh` (`S`) starts a new session, and a
  running coordinator is first asked for a plan checkpoint (`atf plan checkpoint`), then
  replaced. Its session is recorded on the plan (`plan.session`) at start and on its
  first write. A pi coordinator gets the ATF pi extension (`adapters/pi/atf.ts`; also the
  widget, peek and peek-on-type of SPEC §13.6):
  between decisions it ends its turn instead of blocking in `atf wait`, so herdr shows it
  idle and you can prompt it; the extension wakes it when something new needs it.
- **Subagents** are started only by the coordinator (`atf-herdr spawn`), fresh by
  default (the task, its checkpoint and the coordinator's instructions), or resuming the
  task's earlier session with `--resume`. They do their assignment and end; once an agent
  ATF launched is idle with nothing in progress (15 s grace), its pane is closed and its
  session reference saved on the tasks it worked on. They are never relaunched or nudged:
  when there is more for a task (changes, an answer, a dependency done), the coordinator's
  `atf wait` says so and it starts a new agent. `spawn` refuses while an agent of that
  name is still running.
- **Sweeps** (after every ATF write via the hook, a self-rescheduling delayed sweep, and
  every 20 s from an open board; always in a separate `atf-herdr` process): close
  finished subagents; nudge an idle coordinator once per situation with what needs it
  (not one the wake extension waits for),
  including **stalled** subagents (idle > 90 s with a task in progress); notify once when
  an active plan has no coordinator running. When the coordinator is busy but wrote within
  the last minute (probably finishing its turn), or another sweep held the lock, the next
  sweep runs after 3 s.

Agents you start yourself are never closed. `"lifecycle": "persistent"` keeps launched
agents open after they finish. Set `ATF_HERDR_TRACE=<file>` to log which background runs a
board triggers. Every action is logged to `~/.local/state/herdr/plugins/atf.herdr/lifecycle.log`.

Agent kinds (override or add in the plugin config under `"agents"`). Arguments with
`{skill}` are dropped when the skill is installed (`atf skill install`), since the agent
then discovers it itself:

```json
{
  "agent_kind": "pi",
  "agents": {
    "pi":     { "start": ["--skill", "{skill}"], "resume": ["--session", "{session}", "--skill", "{skill}"], "nativeSkill": true },
    "claude": { "start": [], "resume": ["--resume", "{session}"] },
    "codex":  { "start": [], "resume": ["resume", "{session}"] }
  }
}
```

The session reference comes from herdr (`agent_session` of the agent's pane), so it works
for any agent kind herdr integrates. It is filed on the spawned task (a package or a single
task) at launch, on each task the agent starts, blocks or finishes (via the ATF hook), and
on all tasks it touched when its pane is closed; the coordinator's on the plan. A kind
without `resume` always starts fresh.
The pi entry is verified; the claude/codex resume arguments are untested defaults.

### Named agent definitions

Tasks can run as a named **agent definition** (role, model, tools, system prompt) instead
of a generic pi. Definitions are read from the places pi's agent tooling uses:

- pi's subagent extension: `~/.pi/agent/agents/*.md` and the nearest project
  `.pi/agents/*.md` (frontmatter `name`, `description`, `tools`, `model`; the body is the
  system prompt)
- the pi-agent-handoff extension: `~/.pi/agent/agents.json`, `<project>/agents.json`,
  `<project>/.pi/agents.json`

Project definitions override user ones with the same name. `atf-herdr agents` lists them.

```sh
atf add "Review the auth module" --agent reviewer   # record the definition on the task
atf-herdr spawn T7                                   # uses the task's definition
atf-herdr spawn T8 --agent scout                     # or choose one explicitly
```

The agent is started as pi with the definition's `--model`, `--tools` and system prompt
(`--append-system-prompt`), named `<definition>-<task>` (e.g. `reviewer-t7`). A parent
task's definition applies to its whole package. ATF
agents report through the `atf` CLI, so `bash` is added to a tool list that lacks it (a
note is printed); the definition's prompt still sets its boundaries. Definitions are
supported for pi agents.

### Pane layout for agents

`atf-herdr spawn` splits the **largest** pane in the tab, preferring its visually longer
side and trying the other side if that leaves a pane too small; it never splits the board.
Agents therefore form a balanced grid (side by side, then 2×2). When no split would leave
both halves at least 60×12, it reuses an `agents` tab with room, or opens a new one.
Placement is serialized, so agents spawned in parallel see each other's panes.
`--direction` forces a plain split of the current pane; `--workspace` places the agent in
another workspace.

## How it works

- **Pane identity.** `atf` records `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID` from the
  writer's env in `actor.ctx`. The spawn command names the herdr agent the same as the
  ATF actor, so `herdr agent focus <assignee>` works.
- **Sync is stateless.** `lib/sync.mjs` folds every active plan, picks the most urgent
  open task per pane (blocked > review > in progress), and sends
  `pane report-metadata` / `workspace report-metadata` with `--source atf`. Panes whose
  actors have nothing open get their atf title and tokens cleared.
- **Notifications** come from the hook when sync is enabled, otherwise from the open
  board, so you never get both.
- Files: `herdr-plugin.toml` (manifest), `run.sh` (PATH fix), `atf-herdr.mjs`
  (CLI + action dispatch), `lib/tui.mjs` (board), `lib/sync.mjs`, `lib/herdr.mjs`.

## Limitations

- herdr metadata tokens are not restored after a herdr server restart. Run the
  **atf: sync** action (or any `atf` write) to repopulate them.
- The plugin imports `../../src` from this repo, so install it with `plugin link` from a
  checkout. A GitHub `plugin install …/adapters/herdr` is untested.
- Agent kinds other than pi get the skill path in their prompt, not natively.
