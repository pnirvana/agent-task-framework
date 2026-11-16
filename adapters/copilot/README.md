# ATF for GitHub Copilot CLI

Run an ATF plan's coordinator in [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli),
in a plain terminal or in herdr. Protocol details: SPEC §13.7.

## Setup

```sh
atf-copilot install     # writes ~/.copilot/extensions/atf/extension.mjs (or $COPILOT_HOME/…)
```

`bin/` of this repo on your PATH (or `npm link`) gives you `atf` and `atf-copilot`.
The ATF skill must be discoverable by Copilot (`atf skill install`). Copilot loads
extensions only in experimental mode: `atf-copilot` passes `--experimental` (once is enough,
Copilot saves the setting). Approve the `atf` extension when Copilot asks, once.

## Use

```sh
cd my-project
atf-copilot                    # coordinator of the current plan; resumes its Copilot session
atf-copilot --plan P           # another plan
atf-copilot --fresh            # a new Copilot session (the plan checkpoint carries the state)
atf-copilot -- --model gpt-6   # anything after -- goes to copilot
atf-copilot                    # no plan yet: tell Copilot what to plan, it creates it with atf
```

In the coordinator's chat:

- after each turn a transient line says what waits for you: `for you: T5 question · T1 review`;
- `/peek` lists those requests, `/peek T5` shows one in full (question, recommendation,
  who asked originally; for reviews the submission, acceptance criteria and changed files);
- answer in the chat: `T5: yes, SQLite`, `T1: looks good` — the coordinator records it as
  your decision (`--relay`). For a question with clear options it may also ask with
  Copilot's question form; your choice is recorded the same way;
- the coordinator idles between decisions (you can always prompt it) and is woken by the
  extension when something needs it.

## Board

The ATF board runs in any terminal, also without herdr: `atf-herdr tui` (in a second
terminal beside Copilot). It shows what needs you across plans and lets you approve,
request changes and answer; starting agents and jumping to their panes need herdr.

## Subagents

Outside herdr the coordinator uses **Copilot's own background subagents**, through ATF:

```sh
atf dispatch T2 --name backend   # assigns T2 to backend, prints the subagent prompt
```

The coordinator starts a background subagent with that prompt. The subagent runs in the
coordinator's session and shell, so it records its work with `--as backend` on every atf
command (the prompt says so; the coordinator's identity is refused on tasks it delegated).
Its tool approvals are asked in the coordinator's chat. It has no session of its own: a
task that comes back gets a fresh subagent, which continues from the task's checkpoint
and notes.

## In herdr

The agent kind `copilot` works for the coordinator and for subagents:

```sh
atf-herdr coordinate --kind copilot
```

or `"agent_kind": "copilot"` in the herdr plugin config (subagents in their own panes,
via `atf-herdr spawn`). ATF picks the session ids (`--session-id`) and resumes them
(`--resume`). The extension must be installed (`atf-copilot install`).

## Debugging

`ATF_COPILOT_LOG=/tmp/atf-copilot.log atf-copilot` logs what the extension does (armed
plan, waiter, wakes).
