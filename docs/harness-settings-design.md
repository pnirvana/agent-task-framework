# Harness, models and agent definitions

Decided 2026-11-28. Which harness (agent kind: pi, copilot, claude, codex, opencode) runs a
plan's coordinator and agents, with which model and thinking level, and with which agent
definitions.

## Settings per harness

Model ids are a harness's own (`claude-sonnet-5.5` in Copilot, `anthropic/claude-sonnet-5.5`
in pi, `sonnet` in Claude Code): every model setting belongs to one harness.

- **Config** of the launcher, per harness: the session daemon's in `~/.config/atf/config.toml`
  (`[sessions.<kind>]`), herdr's in its plugin config (`[<kind>]`):

  ```toml
  [sessions.copilot]
  coordinator = { model = "claude-sonnet-5.5", thinking = "high" }
  agent       = { model = "gpt-5-mini", thinking = "low" }
  ```

- **Per plan** (`plan.updated` `harness`, so every launcher sees it): the plan's harness and
  its settings, `{kind, coordinator: {model, thinking}, agent: {model, thinking}}`
  (`atf plan update --harness copilot --coordinator-model … --agent-thinking low`). The kind
  decides what starts the plan's coordinator and agents, whichever launcher starts them;
  its settings apply only when that kind runs (a Copilot id never reaches pi).

- **Which wins**, coordinator: the plan's, the config's, the harness's default. Task agent:
  the coordinator's choice for the task (step 3), the agent definition's `model`, the
  plan's, the config's, the harness's.

- **Flags** per harness (`AGENT_KINDS`, overridable in config like the rest): model
  `--model` (codex `-m`); thinking pi `--thinking`, Copilot `--reasoning-effort`, Claude
  Code `--effort`, codex `-c model_reasoning_effort=…`; opencode has none (ignored, with a
  note). Levels are checked against the harness's list. Applied on fresh starts and resumes.

- A recorded session of another harness is not resumed: the agent starts fresh (from the
  checkpoint), as for a harness that cannot resume.

## Agent definitions (step 2)

The standard `NAME.agent.md` files, resolved by the harness itself: ATF passes
`--agent NAME` (Copilot, Claude Code, opencode). pi keeps its own folders and ATF's
conversion (`src/agents.mjs`). `atf agents` lists what the plan's harness offers (name,
description, model) from the harness's usual places, for the coordinator to choose.

## The coordinator's model menu (step 3)

The coordinator chooses a model per task from a menu the human defines per harness
(`[sessions.<kind>.models]`: name -> model, thinking, a note on when to use it):
`atf models`, `atf add|spawn --model NAME [--thinking L]`; outside the menu is refused.
The choice is recorded on the task. Its own model is the human's (plan, else config).

## Then

4. The cockpit: model and thinking when starting a coordinator; the task's model shown.
5. herdr: the cockpit reads herdr's state; herdr in a browser terminal.
