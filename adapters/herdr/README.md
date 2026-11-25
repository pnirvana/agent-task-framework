# ATF × herdr

A herdr plugin (`atf.herdr`) plus a CLI (`atf-herdr`) that makes ATF plans visible and
actionable inside herdr. Optional: ATF itself does not depend on any of this.

| feature | what you get |
|---------|--------------|
| **Task board** | interactive TUI as a full-height side column (`prefix+t`, toggle) or popup (`prefix+alt+t`); one scope for all tabs (all projects › project › plan): Overview, Tasks (as a tree or grouped by agent), Plan, Log |
| **Agent pane labels** | each subagent's pane title becomes `T3 · Token endpoint`, with tokens `$atf_task`, `$atf_status` (`◐ in progress 40%`), `$atf_plan` |
| **Sidebar progress** | workspace tokens `$atf_plan`, `$atf_progress` (`3/5 ✓ 1 ◐ 1 ⊘`) for the Spaces sidebar |
| **Notifications** | when you are needed (what the board shows as ⚑ needs you), once per item: in herdr, and optionally in the terminal herdr runs in (also over SSH: Windows Terminal toasts, taskbar flash, a tab mark) or through your own command |
| **Stall detection** | board flags `stale?` when a task is in progress but its herdr agent has been idle > 90s (an agent that stopped without reporting) |
| **Overview** | tab `0`, where the board starts: what needs you (agents waiting for input, your reviews, finished plans; under a heading per plan when the scope holds several), then per plan only the tasks being worked on with their latest progress; `!` / `Y` / `F` go straight to NEEDS YOU / YOUR TASKS / IN FLIGHT, `{` / `}` step through the sections and `[` / `]` through the plans in them; a context panel for the selected row (a task: its steps first, then the latest progress, live runs, checkpoint, artifacts); approve, request changes, reply, open the review artifact or jump to the agent's terminal with one key |
| **Spawn** | `atf-herdr spawn T3` (the coordinator's) places a pane in the workspace's `agents` tab (your tab with the coordinator and the board keeps its layout), starts the agent (pi by default; the atf skill is discovered once installed with `atf skill install`), assigns the task and sends the kickoff prompt |
| **Reviews** | `a` / `x` / `n` on any task draft an approval, change request or note (`d` drops, `S` submits all at once: one write per plan, so the coordinator wakes once and each owner gets all its points). Tasks that ask you to test something show as `◎ for you` |
| **Agent lifecycle** | the coordinator starts every subagent (fresh by default); finished subagents are closed; an idle coordinator is nudged when something needs it; `atf-herdr coordinate` starts or resumes a plan's coordinator, or replaces it with a fresh session |

## Without herdr

`atf-herdr tui` runs the board in any terminal (no plugin needed), e.g. beside
`atf-copilot`. Reading, approving, requesting changes, replying and answering work as in
herdr; the scope "all projects" lists the projects in `~/.config/atf/roots.json`. What
needs herdr is unavailable: agent state and stall flags, `g` (go to the agent), `s`/`S`
(start a coordinator); `o` still opens PRs and URLs in the browser, but for a branch,
commit or file it prints the command instead of opening a herdr tab.

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
   `.atf/config.toml`, so every `atf` write from any pane updates labels, sidebar, and
   notifications even while the board is closed.
2. `prefix+t` toggles the board for the focused pane's project (found from its cwd,
   walking up to parents and the main git worktree). In a pane without a project it
   opens the overview of all projects and offers `i` to create one there.
   `prefix+alt+t` is the quick look: a popup with the overview of all projects and the
   inbox; ⏎ drills into any plan or task. Inside either, ⏎ narrows the scope to a plan,
   Esc widens it again and `A` jumps to all projects.
3. Start the plan's **coordinator** (it plans, decides and starts every subagent; see
   SPEC §12): from the board (`s` in any view goes to the coordinator of the plan under the
   cursor, resuming its session when none runs; `S` starts a fresh one) or `atf-herdr coordinate [--plan ID] [--fresh]`. The coordinator starts
   subagents with `spawn`:
   ```sh
   atf-herdr spawn T3 --name worker-1            # pi, placed in the workspace's agents tab
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

Every tab shows its content for the scope (`Tab` / `0`–`4`):

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
- **Changes**: the files the plan's tasks changed (SPEC §15), per plan: the tasks with
  changes in the task tree (a work package holds its subtasks' changes combined), each
  with its files and line counts. ⏎ or `d` opens the combined diff of the row in your
  diff viewer, in a new herdr tab: one file, a task, a work package or the whole plan
  (`D`: the plan from any row). `⚠ overlaps T4`: another task worked in the same repo at
  the same time, so its changes may be in this window too (a task that reported its
  files is narrowed to them). `d` in the other views opens the selected task's or the
  plan's diff; task details list the task's files.

Rows always know their project and plan, so `g`, `a`, `x`, `r`, `o`, `s` and ⏎ work at any scope.

### Board keys

| key | action |
|-----|--------|
| `Tab` / `0`–`4` | switch view: `0` Overview · `1` Tasks · `2` Plan · `3` Log · `4` Changes |
| `v` | Tasks: task tree ↔ grouped by agent |
| `⏎` / `Esc` / `A` | narrow scope to the selected plan / widen / all projects |
| `↑↓` / `jk`, PgUp/PgDn | select / scroll |
| `ctrl+d` / `ctrl+u`, `ctrl+f` / `ctrl+b` | half a page / a page down and up |
| `G` / `gg` (End / Home) | to the end / the top (a single `g` still goes to the agent, after 0.3 s) |
| `/` | search the view (Tasks, Changes, plan, task details, help): matches are highlighted, a list selects the matching row, a long view scrolls to it; case-insensitive unless the query has a capital. While a search is on, `n` / `N` go to the next / previous match and `esc` ends it (the Log keeps its own `/` filter) |
| `←→` / `hl`, `space` | collapse / expand subtrees (`←` on a leaf jumps to its parent) |
| `⏎` | full task details (scrollable) |
| `g` | focus the owning agent's pane (closes the popup) |
| `a` / `x` / `r` (`n`) | approve / change request / answer or message, at once; `x`, `r` go to the coordinator |
| `o` | open the task's artifact (PR, branch diff, commit, file, URL) or the plan's documents |
| `d` | the combined diff of the selected file, task, work package or plan in your diff viewer (`D` in Changes: the whole plan) |
| `L` | the live view of what the task's agent runs or watches, in the board (below) |
| `s` / `S` | in every view: `s` goes to the coordinator of the plan under the cursor (or in scope; a picker of the active plans, with their coordinator's state, when that leaves a choice) and starts it, resuming its session, when none runs. `S`: a fresh session (press twice; replaces a running one after its checkpoint) |
| `p` | plan picker: a popup listing every plan by project with its goal and state; typing filters it; ⏎ goes to the plan (in the Log: filters the log to it) |
| `/` | Log: search |
| `?` | help |
| `q` | close view / quit |

In the plan picker, `ctrl+j` / `ctrl+k` also move the selection. If a pane-navigation
plugin such as [herdr-nvim-nav](https://github.com/aimdevlee/herdr-nvim-nav) binds
ctrl+h/j/k/l in herdr, the board registers its pane with it the way Neovim does, but only
while the picker is open, so the keys still move between panes the rest of the time.
Elsewhere in the board use `j` / `k` or the arrow keys.

### Live: builds, tests, pipelines (SPEC §14)

Agents `spawn` starts observe their own shell commands for the board: pi through
`adapters/pi/atf-live.ts`, opencode through the plugin `adapters/opencode/atf.mjs` (both
loaded by `spawn`), Copilot through the ATF extension (`atf-copilot install`). The hook
never wraps or changes a command; it records what the commands are about:

- **While a command runs**, the task row shows a badge: `⚙ 2/5 core · 40 tests` for a
  Maven build, `⧖ pipeline #555 running` while the agent waits on `glab ci status`,
  `gh run watch` or a polling loop. Task details (and the Overview's context panel) list
  it under **live** with the elapsed time, the command and its last output lines.
- **When it ends**, builds, test runs, pipeline watches and anything that ran 30 s or
  more are recorded on the task: exit code, duration, a summary (Maven: module, tests,
  BUILD SUCCESS/FAILURE, failing tests from the surefire/failsafe reports) and the full
  output. A failed latest run shows as `✗ BUILD FAILURE …` on the row.
- **Background files** (`… > build.log &`, `| tee x.log`) and log files the agent keeps
  reading are registered as live logs.

`L` opens the selected task's **live view** in the board, updated while the command runs:
the kind's full view (Maven: every module, failure and test class), in sections.

| key | in the live view |
|---|---|
| `↑↓` `^d`/`^u` `gg` | move |
| `G` | to the end, and follow new output |
| `←→` / `hl`, `z` | fold / unfold the section (modules, failures, test classes); `z` all |
| `⏎` | on a failed test: its message and stack trace from the surefire/failsafe report (the project's own frames stand out), else what the build printed for it |
| `t` | raw output ⇄ the view (kinds without a view open on the output) |
| `[` / `]` | the task's other runs and live files |
| `/` | search, `n`/`N` |
| `o` | open it outside the board: a pipeline in the browser, `atf live --watch` or the output in a new herdr tab |
| `esc` | back |
Agents can add what the hook cannot see with `atf artifact T3 <file> --live`. claude and
codex have no hook yet: only registered files show.

A newer run of the same kind in the same directory replaces the older one on the board
(the green build after a fix hides the failed one; `atf live T3 --all` keeps the history).
Maven progress counts against what the previous run in that directory ran (`81/~99
tests`); the first run has no total.

**Plugins** add kinds of commands, or replace built-in ones: e.g. your GitLab pipeline
with its jobs per stage, from the agent's output or the GitLab API. One `.mjs` file in
`~/.config/atf/live/`; restart the board to load it. `atf live-kinds` lists the kinds,
`atf live-try` tries one on a saved output. Guide:
[docs/live-plugins.md](../../docs/live-plugins.md). To see all of it at work without Maven or
GitLab: `sh examples/live-demo/setup.sh <dir>` ([examples/live-demo](../../examples/live-demo/README.md)).

### Changes and diffs (SPEC §15)

Where a task's changes come from is set per project in `.atf/config.toml`:

```toml
changes = "snapshots"
```

- `"snapshots"` (default): when a task starts, and when its agent finishes, blocks or
  fails it, ATF records the working tree of every git repository in the project (the
  project's own and those below it) as a commit kept by a hidden ref
  (`refs/atf/<plan>/<task>/start|end`). Your index, `HEAD` and branches stay untouched.
  A task's diff runs from its start snapshot to its end snapshot (to the working tree
  while it runs); a work package's and a plan's from the first start to the last end, over
  the files of their tasks. Exact when tasks working in one repo don't overlap in time.
  When they do, the task is marked `⚠ overlaps`, and narrowed to the files it reported
  (`atf artifact T3 <file>`), if it reported any. `git for-each-ref refs/atf` lists the
  refs; `git update-ref -d` removes one.
- `"artifacts"`: only what agents record, meaning file, commit and branch artifacts. Files are
  diffed against `HEAD` (or the commit before the task's first commit) to the working tree,
  and branches against their merge base with the default branch. This needs no
  snapshots, but it misses files an agent did not report.

The viewer is yours, in `~/.config/atf/config.toml` (or `$ATF_DIFF_TOOL`):

```toml
[diff]
tool = "diffview"
```

| tool | opens |
|------|-------|
| `git` (default) | `git diff --stat` and the patch in `less -R` |
| `diffview` | Neovim with [diffview.nvim](https://github.com/sindrets/diffview.nvim), one tab per repository (`:DiffviewOpen -C<repo> <base>..<end> -- <files>`; against the working tree while a task runs, so you can edit; if the task created files git does not track yet, against a snapshot of the working tree instead, since diffview leaves untracked files out of a comparison with a commit) |
| `difftool` | `git difftool --dir-diff` (your configured difftool) |
| a template | any command, run once per repository: `{repo}`, `{base}`, `{target}` (empty: working tree), `{range}` (`base..target` or `base`), `{files}` |

From a shell: `atf diff [T3] [--file F]` lists the changed files, `--patch` prints the
combined diff and `--open` opens it in the viewer.

### Notifications

You are notified when you are needed, with exactly what the board shows as **⚑ needs
you**: a question escalated to you, a review that is yours, a plan question, a finished
plan to close, a plan without a coordinator, a coordinator waiting for you, an agent
waiting for input. Each item is notified once, when it appears, and again only if it went
away and came back. Status changes the coordinator handles (a review for it, a question
it answers) do not notify you while it runs.

Channels, per user in `~/.config/atf/config.toml`:

```toml
[notify]
herdr = true                                # herdr's own notification
terminal = ["toast", "bell", "progress"]    # default: none
# command = 'curl -d "$ATF_NOTIFY_BODY" ntfy.sh/<topic>'
settle_seconds = 5
```

| Channel | What you get |
|---|---|
| `herdr` (on by default) | `herdr notification show`; how it shows is herdr's `[ui.toast] delivery` |
| `terminal: "toast"` | OSC 777 to the terminal the herdr client runs in: a desktop notification in Windows Terminal 1.26+ (profile setting `compatibility.allowOSC777: true`; not while the window has focus), foot, WezTerm, Ghostty |
| `terminal: "bell"` | BEL: Windows Terminal flashes the taskbar / marks the tab, with `"bellStyle": ["window", "taskbar"]` in its profile |
| `terminal: "progress"` | OSC 9;4: a yellow mark on the tab and the taskbar icon while anything waits for you, cleared when nothing does (Windows Terminal, Ghostty). Not for iTerm2, which shows OSC 9 as a notification |
| `command` | any shell command, with `$ATF_NOTIFY_TITLE`, `$ATF_NOTIFY_BODY`, `$ATF_NOTIFY_COUNT` (e.g. `curl -d "$ATF_NOTIFY_BODY" ntfy.sh/<topic>`) |

The `terminal` channel writes to the terminal of the herdr client process (the one you
attached from), so it reaches your own machine over SSH, which herdr's own `terminal`
delivery does not do for Windows Terminal. `$ATF_NOTIFY_TERMINAL` (e.g. `toast,bell`) and
`$ATF_NOTIFY_COMMAND` override the file. Live states (an agent waiting, no coordinator)
must hold `settle_seconds` before they notify.

`atf-herdr notify` shows the channels, the client terminals found and what waits for you
now; `atf-herdr notify --test` sends a test notification through every channel.

### Plugin config (optional)

`$(herdr plugin config-dir atf.herdr)/config.toml`:

```toml
agent_kind = "pi"
agent_placement = "tab"
board_placement = "auto"
board_start = "overview"
```

`atf config` lists the config files in use (project, yours, the plugin's) and reports
syntax errors in them. `atf config init [user|plugin]` creates one with every option at its
default, commented out (`atf init` does that for the project's). `atf config migrate`
converts `config.json` files from before TOML (they are still read while no `config.toml`
exists). When ATF changes a config itself (enable-sync's `[hooks]`), your comments stay.

`agent_placement`: `tab` (default) opens subagents in the workspace's `agents` tab, `split`
beside the coordinator (see "Pane layout for agents").

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

`vi_mode`: `true` gives the board's text fields (replies, change requests, notes, the log
search) vi keys (or `ATF_VI_MODE=1` in the board's environment, which wins over the file).
The field starts in insert mode, where ⏎ starts a new line; esc goes to normal mode, where
⏎ sends and esc cancels (in visual mode ⏎ sends too; in the one-line log search ⏎ sends in
every mode). Normal mode: motions `h j k l w W b B e E ge 0 ^ $ gg G f F t T ; , %`
(arrows move by screen rows, `gj gk` too), counts, operators `d c y` with motions or text
objects (`iw aw iW aW i" a" i' a' i( a( i[ a[ i{ a{ i< a<`, also `ib iB`), `dd cc yy`,
`x X D C s S Y r ~ J p P`, `i a I A o O`, `u` / ctrl+r, `.`; visual `v` / `V` with `o`,
`d c y ~ u U J p` and text objects. Pasted text goes in at the cursor in any mode.

`prefix+t` toggles it per workspace either way; `prefix+alt+t` is the overview popup.

### Agent lifecycle (SPEC §12: the coordinator decides)

- **The coordinator** runs as long as its plan is active. `atf-herdr coordinate` (or `s`
  on the board) starts it in its own tab, labelled `plan: <title>`, with the plan's
  identity (the subagents it spawns open in the workspace's `agents` tab, or next to it
  with `"agent_placement": "split"`; every agent pane is labelled with the agent's name),
  resuming the plan's
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
  including **stalled** subagents (idle > 90 s with a task in progress); check what needs
  the human (notifications, below). When the coordinator is busy but wrote within
  the last minute (probably finishing its turn), or another sweep held the lock, the next
  sweep runs after 3 s.

Agents you start yourself are never closed. `lifecycle = "persistent"` keeps launched
agents open after they finish. Set `ATF_HERDR_TRACE=<file>` to log which background runs a
board triggers. Every action is logged to `~/.local/state/herdr/plugins/atf.herdr/lifecycle.log`.

Agent kinds (override or add in the plugin config under `[agents]`). Arguments with
`{skill}` are dropped when the skill is installed (`atf skill install`), since the agent
then discovers it itself:

```toml
agent_kind = "pi"

[agents]
pi     = { start = ["--skill", "{skill}"], resume = ["--session", "{session}", "--skill", "{skill}"], nativeSkill = true }
claude = { start = [], resume = ["--resume", "{session}"] }
codex  = { start = [], resume = ["resume", "{session}"] }
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

By default (`"agent_placement": "tab"`) agents open in the workspace's **`agents` tab**,
not in the tab you work in: the coordinator and the board stay where they are while
agents come and go. The tab is created without focus when the first agent starts, and
herdr removes it when the last agent pane closes. Inside it, `atf-herdr spawn` splits the
**largest** pane, preferring its visually longer side and trying the other side if that
leaves a pane too small, so agents form a balanced grid (side by side, then 2×2). When no
split would leave both halves at least 60×12, it opens `agents-2`, and so on.

`"agent_placement": "split"` (or `spawn --placement split`) places agents beside the
coordinator instead, in its tab's grid (never splitting the board), overflowing into an
`agents` tab. Placement is serialized, so agents spawned in parallel see each other's
panes. `--direction` or `--target-pane` place the agent at that pane; `--workspace` in
another workspace.

## How it works

- **Pane identity.** `atf` records `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID` from the
  writer's env in `actor.ctx`. The spawn command names the herdr agent the same as the
  ATF actor, so `herdr agent focus <assignee>` works.
- **Sync is stateless.** `lib/sync.mjs` folds every active plan, picks the most urgent
  open task per pane (blocked > review > in progress), and sends
  `pane report-metadata` / `workspace report-metadata` with `--source atf`. Panes whose
  actors have nothing open get their atf title and tokens cleared.
- **Notifications** are checked by the hook, the sweeps and an open board (every 5 s);
  `lib/notify.mjs` keeps one record of what was notified, so each item is notified once
  whoever looks first.
- Files: `herdr-plugin.toml` (manifest), `run.sh` (PATH fix), `atf-herdr.mjs`
  (CLI + action dispatch), `lib/tui.mjs` (board), `lib/attention.mjs` (what needs the human), `lib/notify.mjs` (notifications), `lib/sync.mjs`, `lib/herdr.mjs`.

## Limitations

- herdr metadata tokens are not restored after a herdr server restart. Run the
  **atf: sync** action (or any `atf` write) to repopulate them.
- The plugin imports `../../src` from this repo, so install it with `plugin link` from a
  checkout. A GitHub `plugin install …/adapters/herdr` is untested.
- Agent kinds other than pi get the skill path in their prompt, not natively.
