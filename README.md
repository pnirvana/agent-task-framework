# ATF — Agent Task Framework

A harness-independent way for a **coordinator agent** and its **subagents** to describe
plans, break them into tasks, and report progress, in a format any frontend can visualize.

```
 coordinator ──atf add/assign──┐                     ┌── atf status --watch (TUI)
                               ▼                     │
 subagent ──atf start/progress/done──►  .atf/plans/<id>/events.jsonl  ──► web dashboard
                                        (append-only, source of truth)   └─► herdr plugin, …
```

- **Protocol first** ([SPEC.md](SPEC.md)): an append-only JSONL event log per plan,
  folded into state. Strict writers, lenient readers. JSON Schema in `schema/`.
- **Any agent with a shell can participate** through the `atf` CLI: pi, Claude Code,
  codex, a bash script. No server, no MCP, no dependencies (Node ≥ 18).
- **Frontends are add-ons.** Each one reads `state.json`, tails `events.jsonl`, or
  imports `src/core.mjs` (a pure fold that also runs in the browser).
- **Harness integrations are adapters.** herdr support lives in `adapters/herdr/` and
  is entirely optional.

## Layout

| path | what |
|------|------|
| `SPEC.md` | the protocol: storage, event types, state machine, concurrency, frontend contract |
| `schema/event.schema.json` | JSON Schema for one event line |
| `src/core.mjs` | pure fold: events → plan state (shared by CLI and frontends) |
| `src/store.mjs` | file store: root discovery, locking, transactions, actor identity |
| `bin/atf.mjs` | reference CLI (`bin/atf` is a PATH shim) |
| `skill/atf/SKILL.md` | agent instructions for coordinator and subagent roles (Agent Skills format; `atf skill install`) |
| `adapters/herdr/` | herdr plugin: board TUI, pane labels, sidebar progress, notifications, spawn, agent lifecycle |
| `test/` | `npm test` (fold semantics, transitions, a 12-way concurrent-claim race, wait) |

## Install

No build step and no npm dependencies; Node.js ≥ 18 and `git` are enough for the core.
herdr and pi are only needed for the herdr plugin and agents.

```sh
# 1. clone
cd ~/Dev
git clone https://github.com/pnirvana/agent-task-framework.git
cd agent-task-framework
npm test                       # optional sanity check

# 2. put `atf` and `atf-herdr` on PATH (pick one)
npm link
# or in ~/.zshrc:  export PATH="$HOME/Dev/agent-task-framework/bin:$PATH"

# 3. herdr plugin (board, pane labels, notifications, agent lifecycle)
herdr plugin link ~/Dev/agent-task-framework/adapters/herdr
```

4. Keybindings in `~/.config/herdr/config.toml`, then `herdr server reload-config`:

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

5. Install the agent skill, so agents discover it on their own (no `--skill` needed):

```sh
atf skill install    # symlinks skill/atf into ~/.agents/skills (pi and other Agent Skills
                     # agents) and ~/.claude/skills (Claude Code, if ~/.claude exists)
atf skill            # status;  atf skill uninstall  removes the links
```

   The links point into the checkout, so `git pull` keeps the skill current. Without it,
   start the coordinator with `pi --skill ~/Dev/agent-task-framework/skill/atf`
   (`atf-herdr spawn` then passes `--skill` to subagents itself).

6. Once per project:

```sh
cd ~/Dev/myproject
atf init                       # creates .atf/ and registers the project
atf-herdr enable-sync          # pane labels, notifications, agent lifecycle
```

(or press `prefix+t` in a pane without a project and `i` to create one).

Machine-local state starts empty on a new machine and fills itself: the project registry
(`~/.config/atf/roots.json`), plugin state (`~/.local/state/herdr/plugins/atf.herdr/`)
and optional plugin config (`$(herdr plugin config-dir atf.herdr)/config.json`; defaults:
pi agents, ephemeral lifecycle, full-height board). Plans live in each project's `.atf/`
and move with the project only if you copy or commit that directory.

## Quick start

```sh
cd ~/code/myproject
atf init
atf plan new "Add OAuth login" --goal "Users can sign in with GitHub"
atf add "Design auth flow" --accept "sequence diagram in docs/auth.md"
atf add "Token endpoint" --dep T1 --accept "POST /auth/callback returns a session"
atf status
```

A subagent (with `ATF_ACTOR=worker-1 ATF_ROLE=subagent ATF_PLAN=<id>` in its env):

```sh
atf next                                   # claims + starts the next ready task
atf progress T1 "draft done" --pct 60
atf artifact T1 docs/auth.md
atf done T1 -m "Flow documented in docs/auth.md; reviewed against RFC 6749"
```

The coordinator waits for anything that needs attention:

```sh
atf wait --timeout 600000     # returns when something needs you (review, blocker, task to dispatch, ...)
atf status                    # board + "needs attention" + active agents
```

Reviewing a task in `review`:

```sh
atf done T2 -m "approved: tests pass, edge cases covered"       # meets its criteria
atf changes T2 -m "1. return 401 on bad password 2. add a test"  # send back with feedback
atf changes T2 -m "use the existing auth service" --fresh        # wrong approach: clean restart
atf add "Rate-limit /login" --from T2 --accept "5/min per IP"    # extra scope found in review
```

Reviewing several tasks at once (e.g. as the human, or comments forwarded from an editor):

```sh
atf feedback approve T2 "works on mobile"
atf feedback change T1 "error says 'undefined'" --file src/login.tsx --line 42
atf feedback note T3 "nice docs"
atf feedback submit      # one write: T2 done, T1 back with all points, note on T3
```

Tasks that need the human to test something: `atf add … --reviewer human`, or a subagent's
`atf review T3 -m "please test …" --by human`. The coordinator leaves those to you.

## Using it with pi + herdr

```sh
# inside herdr, in your coordinator's pane / project dir
pi                                           # coordinator (skill installed: `atf skill install`)
atf-herdr spawn T1 --name worker-1           # pane + pi + kickoff prompt for task T1
atf-herdr spawn T2 --name backend            # T2 is a parent task: a whole work package
atf-herdr spawn T3 --agent reviewer           # run it as a named pi agent definition
atf-herdr spawn T4 --name worker-2 --kind claude
```

`spawn` places a pane next to the others (balanced grid, overflow into an `agents` tab),
starts the agent with `ATF_DIR/ATF_PLAN/ATF_ACTOR/ATF_ROLE` and `atf` on PATH, assigns the
task or package and sends the kickoff prompt. With `atf skill install` agents discover the
skill themselves; otherwise pi gets `--skill` and other kinds are told to read
`skill/atf/SKILL.md`. `--agent NAME` (or `atf add … --agent NAME` on the task) runs it as one
of your pi agent definitions (`~/.pi/agent/agents/*.md`, `.pi/agents/*.md`, `agents.json`;
list them with `atf-herdr agents`). Agents launched this way are ephemeral by default: closed when idle
with nothing to do, and relaunched (resuming their session when they come back to a task
they already worked on) when work appears. Details: [adapters/herdr/README.md](adapters/herdr/README.md).

**herdr plugin** (`herdr plugin link <repo>/adapters/herdr`): a task board (`prefix+t`, a
full-height side column; `prefix+alt+t`, a popup) with one scope for all tabs
(all projects › project › plan), an Overview of what is moving and what needs you,
agent panes labelled with their task, plan progress in the sidebar, notifications, stalled-agent
detection and the agent lifecycle. See [adapters/herdr/README.md](adapters/herdr/README.md).

Events written from herdr panes automatically carry `actor.ctx.herdr_pane`, which is how
the plugin maps tasks to panes. Any `ATF_CTX_<KEY>` env var gets recorded the same way
in other harnesses.

## Building a frontend

See [SPEC.md §7](SPEC.md#7-consuming-the-protocol-frontends). Minimal browser example:

```js
import { fold } from 'agent-task-framework';           // src/core.mjs
const events = text.trim().split('\n').map(JSON.parse); // events.jsonl
const plan = fold(events);
// plan.tasks[id].{status, rollup_status, ready, waiting_on, percent, assignee, notes, artifacts, history}
// plan.{progress, counts, actors, order}
```

## Many plans, many projects

```sh
atf plans --all      # active plans across all known projects (progress, agents, inbox count)
atf inbox --all      # what needs you: reviews, questions, failed tasks, finished plans
atf projects         # known projects (registered automatically on init / plan creation)
```

In herdr, the board's **Overview** tab (`0`) shows the same across projects, including
stalled agents, and jumps into any plan, task or agent (see `adapters/herdr/README.md`).

## Configuration (env)

| var | meaning |
|-----|---------|
| `ATF_DIR` | `.atf` root (else found upward from cwd, or next to the main git worktree) |
| `ATF_PLAN` | plan id (else `.atf/current`) |
| `ATF_ACTOR` | actor id (else `$USER`) |
| `ATF_ROLE` | `coordinator` \| `subagent` \| … (coordinators may change any task). Unset: the plan's creator is its coordinator, others are agents; `atf whoami` shows the result |
| `ATF_HARNESS` | harness label (auto: `herdr` / `tmux` / `shell`) |
| `ATF_CTX_*` | extra harness context recorded on every event |
| `ATF_REGISTRY` | project registry file (default `~/.config/atf/roots.json`); `ATF_NO_REGISTRY=1` disables updates |
| `ATF_LIFECYCLE` | set by launchers: `ephemeral` makes `atf wait` tell idle agents to end their turn |

## License

MIT, see [LICENSE](LICENSE).
