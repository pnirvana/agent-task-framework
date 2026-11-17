# ATF for opencode

`atf.mjs` is an opencode plugin: it shows on the ATF board what an opencode agent runs
and waits for (SPEC §14): builds, tests, pipeline watches, with progress, exit code and
output. It only observes; commands and their output are not changed.

## As a subagent in herdr

```sh
atf-herdr spawn T3 --kind opencode        # or "agent_kind": "opencode" in the plugin config
```

`spawn` starts opencode with the ATF environment and loads the plugin through
`OPENCODE_CONFIG_CONTENT` (merged with yours, if set); nothing to install. opencode finds
the atf skill once it is installed (`atf skill install`). Each agent starts fresh from
the task's checkpoint (opencode's session ids are not known at start, so ATF does not
resume them).

## Elsewhere

Add the plugin to your opencode config (`~/.config/opencode/opencode.json`):

```json
{ "plugin": ["file:///<path to the repo>/adapters/opencode/atf.mjs"] }
```

It does nothing outside an ATF plan (`ATF_DIR`, `ATF_PLAN` in the environment). In a
coordinator session, the commands of opencode subagents (child sessions) count for the
ATF name they use in `atf … --as NAME`; the coordinator's own commands have no task.

## Not yet

opencode as the coordinator (waking it when something needs it, a peek at what waits for
you) has no adapter yet: use pi or Copilot for the coordinator.
