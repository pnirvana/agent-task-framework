# ATF × herdr

A herdr plugin (`atf.herdr`) plus a CLI (`atf-herdr`) that makes ATF plans visible and
actionable inside herdr. Optional: ATF itself does not depend on any of this.

| feature | what you get |
|---------|--------------|
| **Task board** | interactive TUI as a split pane (toggle) or popup: task tree, progress, details, event log, "needs attention" |
| **Agent pane labels** | each subagent's pane title becomes `T3 · Token endpoint`, with tokens `$atf_task`, `$atf_status` (`◐ in progress 40%`), `$atf_plan` |
| **Sidebar progress** | workspace tokens `$atf_plan`, `$atf_progress` (`3/5 ✓ 1 ◐ 1 ⊘`) for the Spaces sidebar |
| **Notifications** | herdr notification when a task becomes blocked, needs review, or fails, and when a plan finishes |
| **Stall detection** | board flags `stale?` when a task is in progress but its herdr agent has been idle > 90s (an agent that stopped without reporting) |
| **Spawn** | `s` on a ready task (or `atf-herdr spawn T3`) opens a pane, starts pi with the atf skill, assigns the task, and sends the kickoff prompt |

## Install

```sh
herdr plugin link /path/to/agent-task-framework/adapters/herdr
herdr plugin action list --plugin atf.herdr
```

Requires Node ≥ 18 on PATH (`run.sh` adds `/opt/homebrew/bin` and `/usr/local/bin`).

### Keybindings (`~/.config/herdr/config.toml`)

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "atf.herdr.board"
description = "ATF task board"

[[keys.command]]
key = "prefix+T"
type = "plugin_action"
command = "atf.herdr.board-popup"
description = "ATF quick board"
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
2. Open the board with `prefix+t`. The project is found from the focused pane's cwd
   (walking up to parents and the main git worktree). If there is no `.atf/` yet, the
   board offers to create one (`i`) and picks it up live if `atf init` runs elsewhere.
3. Spawn workers from the board (`s`) or the CLI:
   ```sh
   atf-herdr spawn T3 --name worker-1            # pi + atf skill, split right
   atf-herdr spawn T4 --kind claude --direction down
   atf-herdr spawn T5 --dry-run                  # print the herdr commands only
   ```

### Board views

`Tab` / `1`–`4` switch between:

- **Tasks**: the plan's task tree with connectors. `▣ name` marks a work package (a parent
  task owned by one agent); `↳name` is ownership inherited from the package. Below the tree:
  needs-attention list and a preview of the selected task (with its breadcrumb).
- **Agents**: per agent, its packages and tasks grouped by package, each with its path in
  the plan, plus live herdr state and progress. Unassigned tasks are listed at the end.
- **Plan**: goal, description, outcome, progress per top-level branch with owners,
  open questions, decisions, warnings, blockers, and all artifacts.
- **Log**: the event stream.

### Board keys

| key | action |
|-----|--------|
| `Tab` / `1`–`4` | switch view |
| `↑↓` / `jk`, PgUp/PgDn | select / scroll |
| `←→` / `hl`, `space` | collapse / expand subtrees (`←` on a leaf jumps to its parent) |
| `⏎` | full task details (scrollable) |
| `g` | focus the owning agent's pane (closes the popup) |
| `s` | spawn a subagent for the selected ready task **or work package** |
| `a` | approve a task in `review` (→ `done`) |
| `p` / `P` | next / previous plan |
| `?` | help |
| `q` / `esc` | close view / quit |

### Plugin config (optional)

`$(herdr plugin config-dir atf.herdr)/config.json`:

```json
{ "agent_kind": "pi", "board_placement": "auto" }
```

`board_placement`: `auto` (default) opens the board as a full-height right column when
the tab has a pane at least 110 columns wide and three-quarters of the tab's height,
otherwise as its own tab. `tab` always opens it as a tab. `prefix+t` toggles it per
workspace either way; `prefix+alt+t` is the popup.

### Pane layout for agents

`atf-herdr spawn` splits the **largest** pane in the tab along its visually longer side,
never the board, so agents form a balanced grid (side by side, then 2×2). When no split
would leave both halves at least 70×14, it opens an `agents` tab instead. `--direction`
restores the old behaviour (split the current pane in that direction).

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
