# ATF × herdr

A herdr plugin (`atf.herdr`) plus a CLI (`atf-herdr`) that makes ATF plans visible and
actionable inside herdr. Optional: ATF itself does not depend on any of this.

| feature | what you get |
|---------|--------------|
| **Task board** | interactive TUI as a full-height side column (`prefix+t`, toggle) or popup (`prefix+alt+t`); one scope for all tabs (all projects › project › plan): Overview, Tasks, Agents, Plan, Log |
| **Agent pane labels** | each subagent's pane title becomes `T3 · Token endpoint`, with tokens `$atf_task`, `$atf_status` (`◐ in progress 40%`), `$atf_plan` |
| **Sidebar progress** | workspace tokens `$atf_plan`, `$atf_progress` (`3/5 ✓ 1 ◐ 1 ⊘`) for the Spaces sidebar |
| **Notifications** | herdr notification when a task becomes blocked, needs review, or fails, and when a plan finishes |
| **Stall detection** | board flags `stale?` when a task is in progress but its herdr agent has been idle > 90s (an agent that stopped without reporting) |
| **Overview** | tab `0`: every plan in scope unfolded to its live slice (in progress, review, blocked, failed), plus an inbox of everything that needs you, oldest first; ⏎ opens the plan/task, `g` jumps to the agent or plan, `c` closes a plan |
| **Spawn** | `s` on a ready task or package (or `atf-herdr spawn T3`) places a pane in a balanced grid, starts the agent (pi by default; the atf skill is discovered once installed with `atf skill install`), assigns the task and sends the kickoff prompt |
| **Reviews** | `a` / `x` / `n` on any task draft an approval, change request or note (`d` drops, `S` submits all at once: one write per plan, so the coordinator wakes once and each owner gets all its points). Tasks that ask you to test something show as `◎ for you` |
| **Agent lifecycle** | ATF-launched agents are closed when idle with nothing to do and relaunched when work appears for them, resuming their earlier session when they return to a task they worked on |

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
3. Spawn workers from the board (`s`) or the CLI:
   ```sh
   atf-herdr spawn T3 --name worker-1            # pi, placed in the tab's balanced grid
   atf-herdr spawn T2 --name backend             # a parent task: the whole work package
   atf-herdr spawn T4 --agent reviewer           # run it as a named agent definition
   atf-herdr spawn T7 --early                    # start before its dependencies are done
   atf-herdr spawn T6 --kind claude              # another agent kind
   atf-herdr spawn T5 --dry-run                  # show placement mode, args, resume decision
   ```

### Several workspaces, sessions and projects

- Agents can run in any herdr workspace: live state, labels, nudges and the lifecycle
  sweep work across all workspaces of the herdr server. Agents are found by name, so a
  pane moved to another workspace keeps working.
- Events record the herdr server (`herdr_socket`). Agents of *another* herdr session
  (or machine) are shown read-only (`↗` in the overview) and never prompted, closed or
  relaunched, because their pane ids and names may collide with local ones.
- `atf-herdr spawn T3 --workspace w4` places the agent in another workspace; relaunched
  agents go next to the plan's other agents (or its coordinator).
- Projects are discovered from the working directories of all herdr panes (when the
  overview opens with all projects, or `atf-herdr discover`) and from `atf init` /
  plan creation. Plans on another machine are only visible if the project directory is
  shared.

### Board views

The board has one **scope**, shown as a breadcrumb in its header:
`all projects › project › plan`. ⏎ on a plan narrows to it, Esc widens again
(plan → project → all projects → quit), `A` jumps to all projects. `prefix+t` starts at
the plan scope of the focused pane's project, `prefix+alt+t` at all projects.

Every tab shows its content for the scope (`Tab` / `0`–`4`):

- **Overview**: every plan in scope, unfolded by default to its *live slice*: tasks in
  progress (owner, live agent state, %), in review, blocked or failed, each with its
  parent path, plus a summary line of the rest (`✓ 5 done · ○ 3 todo (2 ready)`).
  ←/→/space fold a plan (▸ folded, ▾ live, ▿ full tree), `z` folds/unfolds all. Below:
  the inbox (reviews, questions, failures, stalled agents, finished plans), oldest first.
  `c` closes the selected plan (press twice), `f` shows/hides closed plans in all tabs.
- **Tasks**: at plan scope the task tree (with a needs-attention list and a preview of the
  selected task); at wider scopes one collapsible node per plan containing its tree
  (plans with open work start expanded). `▣ name` marks a work package, `↳name` an owner
  inherited from the package.
- **Agents**: per agent its packages and tasks with their path in the plan, live herdr
  state and progress; at wider scopes grouped by project and plan, headed by how many
  agents are live and working.
- **Plan**: one plan: goal, description, outcome, per-branch progress with owners,
  questions, decisions, warnings, blockers, artifacts. At wider scopes: one card per plan
  (goal, outcome, branch progress, counts); ←/→/space fold a card, `z` folds all, ⏎ opens
  the plan's full details.
- **Log**: events of all plans in scope, newest first, tagged with their plan.

Rows always know their project and plan, so `g`, `s`, `a` and ⏎ work at any scope.

### Board keys

| key | action |
|-----|--------|
| `Tab` / `0`–`4` | switch view (`0` Overview) |
| `⏎` / `Esc` / `A` | narrow scope to the selected plan / widen / all projects |
| `↑↓` / `jk`, PgUp/PgDn | select / scroll |
| `←→` / `hl`, `space` | collapse / expand subtrees (`←` on a leaf jumps to its parent) |
| `⏎` | full task details (scrollable) |
| `g` | focus the owning agent's pane (closes the popup) |
| `s` | spawn a subagent for the selected ready task **or work package** |
| `a` / `x` / `n` | review drafts: approve / request changes / note (text input) |
| `d` / `S` | drop the task's drafts / submit all drafts (press twice) |
| `p` / `P` | next / previous plan |
| `?` | help |
| `q` | close view / quit |

### Plugin config (optional)

`$(herdr plugin config-dir atf.herdr)/config.json`:

```json
{ "agent_kind": "pi", "board_placement": "auto" }
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

`prefix+t` toggles it per workspace either way; `prefix+alt+t` is the overview popup.

### Agent lifecycle and resuming

Default `"lifecycle": "ephemeral"`: an agent launched by ATF (via `spawn`, the board's `s`,
or a relaunch) is closed once it is idle with nothing to do (15 s grace). Its session
reference is saved on the tasks it worked on. When work appears for it again (a ready
task in its package, a `block --on` dependency done, a question answered, a task
reopened), the adapter relaunches it:

- **resume** the earlier session if the task was already worked on and the agent kind
  supports resuming (ATF's `launchPlan`, see `atf resume-info <task>`);
- otherwise **fresh**, with a prompt pointing at the task's checkpoint and history.

Agents you start yourself are never closed or relaunched. Sweeps run from the ATF hook
after writes, from a self-rescheduling delayed sweep, and every 20 s from an open board,
always in a separate `atf-herdr` process, so the board never blocks on herdr. Set
`ATF_HERDR_TRACE=<file>` to log which background runs a board triggers. `"lifecycle": "persistent"`
keeps launched agents alive (they are prompted instead). Every action is logged to
`~/.local/state/herdr/plugins/atf.herdr/lifecycle.log`.

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
for any agent kind herdr integrates. A kind without `resume` always starts fresh.
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
task's definition applies to its whole package; relaunches keep the definition. ATF
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
