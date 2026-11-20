# Live plugins: teaching ATF a new kind of command

ATF shows what agents run and wait for (SPEC §14): while a Maven build runs, the board
shows its test progress; while the agent waits on a pipeline, it shows the pipeline. Each
of these is a **live kind**: a small module that recognizes a shell command, turns its
output into a summary, and shows it. ATF ships kinds for `pipeline`, `maven`, `tests`,
`wait`, `build` and `log`. A **plugin** adds a kind, or replaces a built-in one, without
changing ATF: one `.mjs` file in `~/.config/atf/live/`.

This guide is written so that an agent can build a plugin from it alone. If you are an
agent asked to write one, read it to the end. The checklist in
[Writing a plugin, step by step](#writing-a-plugin-step-by-step) is the procedure.

- Template: [`examples/live-plugins/template.mjs`](../examples/live-plugins/template.mjs)
- Full example (GitLab pipeline with jobs per stage, from the agent's output and the GitLab
  API): [`examples/live-plugins/gitlab.mjs`](../examples/live-plugins/gitlab.mjs)
- Built-in kinds (the same interface): `BUILTIN` in [`src/live.mjs`](../src/live.mjs)
- A sandbox where real agents build, test, wait for a pipeline and run an app, all with
  stand-ins (no Maven, no GitLab): [`examples/live-demo/`](../examples/live-demo/README.md)

## How it fits together

```
agent's harness (pi/Copilot/opencode)    .atf/plans/<plan>/live/            board / atf live / atf show
──────────────────────────────           ──────────────────────             ───────────────────────────
command starts ─ match(cmd) → kind ──▶   <actor>.json  (running now)  ──▶   summarize(output) every second
               ─ onStart() → extra                                          view()   details, `atf live`
output streams ────────────────────▶    runs/<task>-<t>-<kind>.log  ──▶    refresh() API data, throttled
command ends   ─ summarize() → line                                         open()   what L opens
               ─ onEnd()                 task.artifact {kind, cmd, cwd,
               ─ record ───────────▶      exit, duration_ms, extra,
                                          description: the line}
```

1. **Recognize.** For every shell command the agent runs, the hook (pi, Copilot or
   opencode; shared code in `src/live-observer.mjs`) asks the kinds in turn whether the command is theirs (`match`). The first match wins:
   plugins first (higher `priority` first), then the built-ins in the order pipeline,
   maven, tests, wait, build. No match: an ordinary command (shown only after it runs 4 s,
   recorded only after 30 s, as a `log`).
2. **While it runs**, the command is listed in `<plan>/live/<actor>.json` with its kind,
   directory and output file. Frontends call `summarize` on the output so far.
3. **When it ends**, the full output is kept under `<plan>/live/runs/`, and a
   `task.artifact` is recorded with the exit code, duration, your `extra` and your summary
   `line`. The coordinator sees that line in `atf show` / `atf brief` when it reviews.
4. **Showing it.** The board shows `line` in the task's row badge and in its details,
   followed by your compact `view` (or your `details`). `L` on the board opens the **live
   view** in the board: your full `view`, updated while the command runs, with its
   sections folded and unfolded (←→) and ⏎ on an item showing your `item`; `t` switches
   to the raw output. `o` there opens it outside the board: what `open` returns, else
   `atf live <task> --watch` (when there is a `view`), else the raw output in a herdr tab.
   A newer run of the same kind in the same directory replaces the older one on the board
   (`atf live <task> --all` keeps the history).

The model never sees any of this: its commands and their output are not changed.

## Where plugins live and how they load

- `~/.config/atf/live/*.mjs` (or `$XDG_CONFIG_HOME/atf/live/`), and the files or
  directories in `$ATF_LIVE_PLUGINS` (`:`-separated). Files load in name order.
- A file's **default export** is one kind definition or an array of them.
- A plugin kind with the **same name as a built-in replaces it**, e.g. your own `pipeline`.
- **Errors never break anything.** A file that fails to load is skipped and reported by
  `atf live-kinds` (and on the board, once). A function that throws gives a summary saying
  so; the other kinds keep working.
- Plugins load from your own config folder only, never from a project: a project's
  `.atf` directory can come from someone else's repository.
- **Every process that shows or records live data loads them:**
  - the agent's hook (`match`, `onStart`, `onEnd`, `summarize` at the end);
  - the board (`summarize`, `view`, `item`, `refresh`, `open`);
  - `atf show` / `atf brief` / `atf live` (`summarize`, `view`; `atf live` also `refresh`).

  These usually run on the same machine. If they don't, install the plugin on both.
- Changes take effect in **new processes**: restart the board (and agents started before
  the change keep the version they loaded).

## The interface

```js
export default {
  kind: 'gitlab',            // required. /^[a-z][a-z0-9-]{0,31}$/
  description: '…',          // shown by `atf live-kinds`
  waiting: true,             // the agent waits on something outside: ⧖ waiting (else ⚙ running)
  priority: 10,              // asked before kinds with lower priority (default 0; built-ins last)
  record: 'log',             // record finished runs under another kind (built-in wait/build: log)
  tailBytes: 262144,         // how much of the output summarize gets (from the end; default 256 KB)
  stale: 3000,               // ms: re-summarize at least this often even if the output did not
                             //   change (only if summarize reads more than the output, e.g. files)

  match(cmd, { unquoted, cwd }) { … },        // → boolean
  summarize(text, ctx) { … },                 // required → { state, line, counts, details }
  view(summary, opts, ctx) { … },             // → lines: [text, style] segments, sections, items
  item(summary, id, opts, ctx) { … },         // → lines: one item of the view in full
  open(summary, ctx) { … },                   // → { url } | { file } | null
  refreshEvery: 15000,                        // ms between refreshes while it runs
  refreshTimeout: 10000,                      // ms before a refresh is given up
  async refresh(ctx) { … },                   // → any JSON-able data, arrives as ctx.fetched
  onStart({ root, plan, task, cwd, cmd, runFile }) { … },   // → extra (kept with the run)
  onEnd({ root, plan, task, cwd, cmd, runFile, exit, since, until, extra }) { … },
};
```

### `match(cmd, { unquoted, cwd })` → boolean

Called by the agent's hook for **every** shell command, before it runs. Keep it to a
regular expression or two.

- `cmd`: the command as the agent wrote it, possibly a multi-line script
  (`atf progress … && ./mvnw verify`, loops, `$(…)`).
- `unquoted`: the same with quoted strings replaced by `""`. Match program names here, so
  `echo "mvn"` or `grep 'glab ci'` do not count.
- Things that are usually quoted, such as URLs (`curl -s "https://…/pipelines/$id"`), are
  only in `cmd`: check those there, together with a program check on `unquoted`.
- Anchor program names: `/(^|[\s;&|(/])glab\s+ci\b/`, not `/glab/`.
- `cwd`: the directory the command runs in (after a leading `cd dir &&`).

Optional: a kind without `match` is only used for files registered with
`atf artifact T3 <file> --live --kind <kind>`.

### `summarize(text, ctx)` → summary

The core of a plugin. It turns the output into what the board shows. It is called often:
every second for each visible running command, and once per finished run. **It must be
synchronous, fast (a few ms on 256 KB), never touch the network and never write
anything.** Data from elsewhere comes from `refresh`, as `ctx.fetched`.

`text`: the end of the output (`tailBytes`), ANSI colors stripped, `\r` progress lines
split into lines. For a long run, the beginning may be cut off: prefer the last
occurrence of a status over the first.

`ctx`:

| field | |
|---|---|
| `cmd` | the command (null for a registered file) |
| `cwd` | its directory (null if unknown) |
| `file` | the output file (read more of it with `helpers.readTail(file, bytes)`) |
| `exit` | exit code of a finished run, `null` while it runs |
| `active` | true while the command runs |
| `since`, `until` | ms timestamps of the run (until: `Infinity` while it runs). Use them to ignore files written by other runs, as maven does with its reports |
| `extra` | what your `onStart` returned (`{}` if nothing) |
| `fetched` | the latest `refresh` result, or `null` |
| `fetchError` | the latest refresh error message, or `null` |
| `now` | `Date.now()` |
| `kind` | the kind's name |
| `helpers` | `clip(s, n)`, `elapsed(since)`, `secs(seconds)`, `bar(frac, width)`, `readTail(file, bytes)`, `lastLine(lines)` |

Return:

| field | |
|---|---|
| `state` | `running` (works on it), `waiting` (waits on something outside), `ok`, `failed`, `unknown` (a plain log). For a finished run the exit code wins: exit ≠ 0 is `failed`, exit 0 turns `running`/`waiting`/`unknown` into `ok`. |
| `line` | **one short line, the most important first** (≤ 60 characters is best; clipped at 140). The board's row badge shows its start: `pipeline #4712 running · 3/5 jobs · test`. |
| `counts` | any data your `view` and `open` need (plain JSON: also returned by `--json`) |
| `details` | lines worth acting on: failures, the first error. Shown when there is no `view`, and in `atf show` / `atf brief`, where the coordinator reads them. Empty when all is well. |

### `view(summary, { width, full, active, helpers }, ctx)` → lines

The detailed view, in the task's details on the board (compact, `full: false`, aim for
≤ 8 lines) and in `atf live` (`full: true`: everything that helps, e.g. every job). A
line is an array of `[text, style]` segments; styles: `''`, `bold`, `dim`, `red`,
`green`, `yellow`, `cyan`, `magenta`, `gray`, `bold red`, `bold green`, `bold yellow`,
`bold cyan` (others are dropped). Keep lines within `width`. Without `view`, the board
shows `details`.

The compact view really is compact: a build with 40 modules must not take 40 lines in the
task's details. Summarize there (`modules  38 ✓  1 ⚙  1 ✗`, the one building, the first
failures) and leave the lists to `full: true`.

Two optional kinds of lines, for the full view. Plain segment arrays still work everywhere,
and older ATF versions skip these lines:

- **A section heading** `{ section: 'jobs', note: '3/5 done', folded: false }`: the lines
  after it, up to the next heading, belong to it. In the board's live view the human folds
  and unfolds it (←→, z all); `folded: true` starts it folded (e.g. a long list of what
  succeeded). `atf live` shows it as a bold heading.
- **An item** `{ segments: [[text, style], …], item: 'job-123' }`: a line ⏎ opens in full
  in the live view, via your `item` (below). The id is yours: anything `item` can find the
  thing by. Only useful with an `item` function.

```js
view(s, { full }) {
  if (!full) return [[['  ' + s.counts.jobs + ' jobs', 'dim']]];
  return [
    { section: 'failed jobs', note: String(s.counts.failed.length) },
    ...s.counts.failed.map((j) => ({ segments: [['  ✗ ', 'red'], [j.name, 'red']], item: String(j.id) })),
    { section: 'passed jobs', folded: true },
    ...s.counts.passed.map((j) => [['  ✓ ', 'green'], [j.name, '']]),
  ];
}
```

Conventions the built-ins use: `✓` green done, `✗` red failed, `⚙` cyan running, `○` gray
pending, `–` gray skipped, `▸` the thing running now; counts dim; a progress bar with
`helpers.bar`.

### `item(summary, id, { width, helpers }, ctx)` → lines (optional)

One item of your full view in full, when the human presses ⏎ on its line in the board's
live view: a failed test's message and stack trace, a job's log, a step's error. `id` is
the `item` of that line. Return lines like `view` does (segments, headings); they scroll,
so they may be long (the board clips each line to the width: wrap long ones yourself).
It is called again every few seconds while it is shown, so it may read files (`ctx.cwd`,
`ctx.file`, `ctx.since`/`ctx.until` as in `summarize`), but must not fetch: put what needs
the network in `refresh` and read it from `summary.counts`.

The built-in `maven` kind's: the failure from the run's surefire/failsafe report (type,
message, stack trace, with the project's own frames standing out from the framework's),
else what the build output printed for the test.

### `open(summary, ctx)` → `{ url }` | `{ file }` | null

What `o` in the board's live view opens outside the board: a URL in the browser (a
pipeline page), or a file followed in a new herdr tab. `null` (or no `open`): the full
viewer `atf live --watch` if the kind has a `view`, else the raw output.

### `refresh(ctx)` → data (async, optional)

For data the output does not contain, typically an API: the jobs of a pipeline, a
deployment's status. It runs at most every `refreshEvery` ms while the command runs, and
for finished runs until the data says `final: true`.

- Who calls it: the board (in the background, for what it shows) and `atf live` /
  `atf live-try` (they wait for it). The agent's hook, `atf show` and `atf brief` don't:
  they show what the output gives.
- `ctx`: as for summarize (without `fetched`), plus `text` (the output's end) and
  `previous` (your last result). Derive what to ask from `text` and `cmd`: the URLs and
  ids the agent's own command printed.
- Return any JSON-able value; it arrives in `summarize` as `ctx.fetched`. Return
  `{ …, final: true }` when it can no longer change (a finished pipeline): no more
  requests for that run.
- Throwing (or exceeding `refreshTimeout`) keeps the previous data; `ctx.fetchError` and
  `atf live-try` show the message.
- Use the global `fetch` with `signal: AbortSignal.timeout(…)`.
- **No token at all** is best: if the service has a CLI with its own login (`glab api
  <path>`, `gh api <path>`), call it (`child_process.execFile`, with a timeout) and use
  its JSON. Nothing to store, and its login is already where the human works.
- **Secrets**: read tokens from the environment or a file under `~/.config/atf/live/`
  (only `.mjs`/`.js` files there are loaded as plugins). Never put a token into the
  summary, an error message or a log. The board may not run with your shell's
  environment (it is started by herdr), so offer a file as well.
- Corporate CA: start the board with `NODE_EXTRA_CA_CERTS=/path/ca.pem` rather than
  turning off TLS checks.

### `onStart(...)` / `onEnd(...)` (optional, in the agent's hook)

Called when a matching command starts and ends, in the agent's harness, synchronously:
keep them quick. `onStart`'s return value is stored with the run (and the recorded
artifact) and passed to every function as `ctx.extra`. Maven uses this to save the
previous run's test classes before `mvn clean` deletes them (the expected total for
progress). Most plugins don't need either.

A command that writes to a file in the background (`nohup ./mvnw verify > build.log &`,
`docker exec … ansible-playbook … > deploy.log &`) becomes a live file of the kind that
matches that command, yours included, and your `onStart` runs for it too (`file`: the
agent's file; `runFile`: a path under the plan's runs to write next to). There is no
`onEnd` for it: the hook does not see a background command end.

Commands handed to a shell (`docker exec app bash -c './mvnw verify'`, `sh -c "…"`) are
matched as a whole first, then by the script inside the quotes.

## Testing a plugin

You do not need an agent, a plan or the board:

```sh
atf live-kinds                                   # is it loaded? errors?
atf live-try ./gitlab.mjs output.txt \
  --cmd 'glab ci status --live'                  # match, refresh, summary, view, open
atf live-try gitlab output.txt --exit 1          # as a finished, failed run
atf live-try gitlab output.txt --active          # as a running one
atf live-try gitlab output.txt --no-refresh      # only what the output gives
atf live-try gitlab output.txt --json            # everything as JSON
```

- `live-try` takes the kind's name (an installed plugin or a built-in) or a plugin file
  (loaded just for this call).
- Get real outputs from runs that happened: every recorded run is kept under
  `<project>/.atf/plans/<plan>/live/runs/` (`atf show <task> --json` lists them as
  artifacts with their `cmd`). Or run the command yourself and save its output:
  `glab ci status > out.txt 2>&1`.
- To see it end to end with real agents, without your real tools: the sandbox in
  [`examples/live-demo/`](../examples/live-demo/README.md) (`setup.sh` creates a project
  with a plan; change its stand-ins to print what your tools print).
- Test with several outputs: running, finished ok, failed, cut off (a long run whose
  beginning is past `tailBytes`), empty.
- A plugin is a plain ES module: unit-test it with `node --test` by importing it and
  calling `summarize` with sample text.

## Writing a plugin, step by step

For an agent asked to "show X on the board" (e.g. "our GitLab pipeline jobs"):

1. **Collect real outputs** of the commands agents run for X: the exact commands (from the
   runs directory above, or ask the human), and their output while running, when done, and
   when failed. Save them as files. Without real outputs you are guessing the format.
2. **Decide the source of each piece of information**: the output (preferred: works
   everywhere, no credentials) or an API (`refresh`: needs access from the board's
   machine, and a token). Use the API only for what the output lacks.
3. **Copy the template** (`examples/live-plugins/template.mjs`) to
   `~/.config/atf/live/<kind>.mjs`. Choose the kind's name. To replace a built-in, use its
   name.
4. **Write `match`** against the collected commands, with a program check on `unquoted`.
   Check that ordinary commands don't match (`echo`, `grep`, `cat` of a file named like
   the program).
5. **Write `summarize`**: parse defensively (missing fields, partial lines, the latest
   status wins), pick the `state`, write a `line` with the most important thing first,
   put failures in `details`. No network, no writes.
6. **Add `view`** if more than one line helps: per stage, per module, per step. Compact
   for `full: false` (≤ 8 lines, however big the run), everything for `full: true`, in
   sections when there are several lists.
   **Add `item`** if a line of the full view has more behind it (a failure's trace, a
   job's log), and mark those lines as items.
7. **Add `open`** if there is a page for it (a pipeline URL from the output).
8. **Add `refresh`** only if needed: timeouts, token from env or file, `final: true`
   when done, nothing secret in errors.
9. **Try it** with `atf live-try` on every saved output (`--active`, `--exit 0`,
   `--exit 1`), and `atf live-kinds` for load errors. Fix until each looks right.
10. **Tell the human** where the plugin is, what it shows, what it needs (token file, env),
    and that the board must be restarted to load it.

## Example: GitLab pipeline jobs

[`examples/live-plugins/gitlab.mjs`](../examples/live-plugins/gitlab.mjs) shows a GitLab
pipeline the agent waits for, with its jobs per stage:

```
⧖ waiting 1m12s  pipeline #4712 running · 2/5 jobs · test
  ✓ build   ✓ compile 12s  ✓ lint 7s
  ⚙ test    ⚙ unit 10s  ⚙ integration 10s
  ○ deploy  ○ staging
```

- `match`: `glab ci …` / `glab pipeline …`, or `curl`/`wget` on `…/api/v4/projects/…/pipelines…`.
- `summarize`: the pipeline id, status and URL from the output (the pipeline JSON, its
  `web_url`, `Pipeline state: …`), jobs from the output when the command printed them
  (jobs API JSON, or `glab ci status`-like lines `(status) … stage name`), else from
  `ctx.fetched`.
- `refresh`: `GET <api>/projects/<project>/pipelines/<id>` and `…/jobs?per_page=100`,
  where `<api>` and `<project>` come from the `web_url` or API URL in the output (or
  `GITLAB_API_URL`, `GITLAB_PROJECT`): with `PRIVATE-TOKEN` from `GITLAB_TOKEN` or
  `~/.config/atf/live/gitlab.token` if there is one, else through `glab api` (glab's own
  login), else a plain request. Jobs are sorted by id (pipeline order: the API lists
  newest first). `final: true` once the pipeline is finished.
- `view`: one line per stage (compact) or one per job with status, duration and failure
  reason (`full`).
- `open`: the pipeline page.

**Adapting it at work**: save the output of the commands your agents use (`glab ci
status`, `glab ci view`, your `curl` calls) and run `atf live-try gitlab.mjs <file>
--cmd '<command>'`. Adjust `parse()` where your glab version prints jobs differently.
For the API, `glab auth login` on the machine the board runs on is enough; otherwise put
a token with `read_api` into `~/.config/atf/live/gitlab.token` (`chmod 600`).
`atf live-try … ` then shows `refresh ok` with the jobs.

The built-in `pipeline` kind (no plugin) reads `glab ci get` output too: the pipeline's
`status:` (not the last job's), its jobs with failed ones in the details.

Without GitLab at hand: [`examples/live-plugins/fake-gitlab.mjs`](../examples/live-plugins/fake-gitlab.mjs)
serves the two endpoints on `localhost:8765` (a pipeline takes about 70 s):

```sh
node examples/live-plugins/fake-gitlab.mjs &
curl -s -X POST localhost:8765/api/v4/projects/demo/pipeline > out.txt     # pipeline 4711
sleep 30; curl -s localhost:8765/api/v4/projects/demo/pipelines/4711 >> out.txt
atf live-try examples/live-plugins/gitlab.mjs out.txt --active
```
