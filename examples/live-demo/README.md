# Live demo: a sandbox for ATF's live view

A small project in which real agents build, test, wait for a CI pipeline and run an app.
Every tool there is a stand-in, so it runs anywhere with Node and a shell, without Maven
or GitLab. Use it to see the live view (SPEC §14) work, or to develop and try
[live plugins](../../docs/live-plugins.md) end to end.

```sh
sh examples/live-demo/setup.sh ~/atf-live-demo     # a new project with a plan, 3 tasks
node examples/live-plugins/fake-gitlab.mjs         # the CI server (keep it running)
```

Then follow what `setup.sh` prints: open the board, start a coordinator or spawn the
agents, and watch.

## What is in it

| | |
|---|---|
| `mvnw` | prints Maven output for a 3-module reactor (`core`, `api`, `web`, 8 test classes, 99 tests, ~50 s) and writes surefire reports. `PriceTest.totalIncludesVat` fails while `api/src/test/resources/expected-total.txt` is wrong (1199; the right value is 1299). A full Maven log, failing test, reports: what the `maven` kind reads |
| `run-app.sh` | a service that logs health checks and slow-query warnings until stopped: a background log |
| [`../live-plugins/fake-gitlab.mjs`](../live-plugins/fake-gitlab.mjs) | the two GitLab API endpoints for pipelines and jobs, on `localhost:8765`: a pipeline runs ~70 s through `build` (compile, lint), `test` (unit, integration) and `deploy` (staging) |

The plan: **T1** make the build green (the agent has to find the failing test in the
report and fix the test data), then **T2** run the release pipeline and **T3** smoke-test
the app, in parallel.

## What you see

- T1: `⚙ 2/3 api · 74/~99 tests` (the total once a build ran before), modules and test
  classes in the details, `✗ PriceTest#totalIncludesVat: expected: <1199> but was: <1299>`,
  then the green build replacing the failed one.
- T2: `⧖ pipeline #4711 running`; with the GitLab sample plugin installed
  (`~/.config/atf/live/gitlab.mjs`), its jobs per stage, refreshed from the fake API.
  `L` opens the pipeline page.
- T3: `app.log` as a live log (warnings counted), registered by the hook from the
  agent's `./run-app.sh > app.log 2>&1 &`.

## Developing a plugin with it

Recorded runs keep their full output: `<project>/.atf/plans/<plan>/live/runs/*.log`. Feed
them to `atf live-try <your-plugin.mjs> <run.log> --cmd '<the command>'` while you write
the plugin, then let an agent run the task again to see it on the board. To make the
sandbox fit your case, change the stand-ins: e.g. have `mvnw` print your build's real
output, or `fake-gitlab.mjs` the JSON your GitLab returns.

To run the scenario again, add a new task (`atf add …`, e.g. after setting
`expected-total.txt` back to 1199) or create a fresh project with `setup.sh`.
