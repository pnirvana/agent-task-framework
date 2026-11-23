// Live artifacts (SPEC §14): what the agents run and watch, made visible without asking
// them to report it. A harness hook observes the agent's shell commands (it never wraps
// or changes them) and records:
//   - while a command runs: an ephemeral run in `<plan>/live/<actor>.json` (not in the
//     log; it only matters while the agent's process lives);
//   - when an interesting command ends (a build, tests, a pipeline watch, or anything
//     that ran long): a `task.artifact` with the captured output, exit code and summary;
//   - a file the agent writes in the background (`… > build.log &`): a live `log` artifact.
// Agents can register what the hook cannot see themselves: `atf artifact T3 <file> --live`.
//
// Summarizers turn a file (and for maven its report directories) into one line plus
// counts; every frontend (board, `atf show`, pi, Copilot) uses the same ones.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planDir } from './store.mjs';

// ---------------------------------------------------------------- commands
/** Strip quoted strings so `echo "mvn"` or `grep 'sleep'` does not classify a command. */
export const unquote = (cmd) => String(cmd).replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""');

/**
 * What kind of work a shell command is: the first kind whose `match` accepts it (plugins
 * first, by priority, then the built-in pipeline, maven, tests, wait, build), or null (an
 * ordinary command). See docs/live-plugins.md.
 */
export function classify(cmd, cwd = process.cwd(), depth = 0) {
  const unquoted = unquote(cmd);
  for (const def of matchOrder()) {
    try {
      if (def.match(String(cmd), { unquoted, cwd })) return def.kind;
    } catch {} // a broken plugin never stops the others
  }
  // nothing matched the whole command: the script it hands to a shell
  // (`docker exec app bash -c './mvnw verify'`, `ssh host sh -c "…"`)
  if (depth < 2) for (const s of shellScripts(cmd)) {
    const k = classify(s, cwd, depth + 1);
    if (k) return k;
  }
  return null;
}

/** The scripts a command runs through `bash|sh|zsh|dash|ksh [-opts] -c '…'` (quoted). */
export function shellScripts(cmd) {
  const re = /(?:^|[\s;&|(])(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c\s+('([^']*)'|"((?:\\.|[^"\\])*)")/g;
  return [...String(cmd).matchAll(re)].map((m) => m[2] ?? m[3].replace(/\\(["\\$`])/g, '$1'));
}

/** The directory a command runs in: a leading `cd <dir> &&` changes it. */
export function cwdOf(cmd, base) {
  const m = String(cmd).match(/^\s*cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(&&|;)/);
  if (!m) return base;
  const dir = (m[2] ?? m[3] ?? m[4]).replace(/^~(?=\/|$)/, process.env.HOME || '~');
  return path.resolve(base, dir);
}

/**
 * Files a command writes in the background, or to watch later: `> f &`, `nohup … > f`,
 * `| tee f`, `>> f`. Returns [{file, background, seg}] (`seg`: the command writing it, to
 * classify on its own); /dev/* and redirects into `$VAR`s are ignored.
 */
export function outputFiles(cmd, base) {
  const c = String(cmd);
  const out = [];
  const re = /(?:\d?>>?|&>|\|\s*tee\s+(?:-a\s+)?)\s*("([^"]+)"|'([^']+)'|([^\s;&|<>()]+))/g;
  // per command of a script: only the backgrounded one's redirects (`x > f &`, `nohup x > f`),
  // not e.g. `echo $! > app.pid` on the next line
  for (const seg of c.split(/\n|;|&&|\|\|/)) {
    const bg = /(^|[^&>])&\s*$/.test(seg) || /\b(nohup|setsid)\b/.test(seg);
    for (let m; (m = re.exec(seg)); ) {
      const f = m[2] ?? m[3] ?? m[4];
      if (!f || f.startsWith('/dev/') || f.startsWith('&') || f.includes('$')) continue;
      const tee = m[0].includes('tee');
      if (!bg && !tee) continue; // a plain foreground `> f` is the command's own output, captured anyway
      out.push({ file: path.resolve(cwdOf(c, base), f.replace(/^~(?=\/|$)/, process.env.HOME || '~')), background: bg, seg: seg.trim() });
    }
  }
  return [...new Map(out.map((x) => [x.file, x])).values()];
}

/** The kind a recorded run gets: a kind's `record` (built-in wait and build: log), else itself. */
export const artifactKind = (k) => {
  const def = registry.get(k);
  return def ? def.record || def.kind : 'log';
};
/** A kind where the agent waits on something outside (shown as ⧖ waiting, not ⚙ running). */
export const isWaiting = (k) => !!registry.get(k)?.waiting;

// ---------------------------------------------------------------- reading files
/** The last `max` bytes of a file as text (whole lines), or null if it is gone. */
export function readTail(file, max = 256 << 10) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(max, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      let s = buf.toString('utf8');
      if (len < st.size) s = s.slice(s.indexOf('\n') + 1);
      return s;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');
const lastLine = (lines) => [...lines].reverse().find((l) => l.trim())?.trim() ?? '';
const clip = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------------------------------------------------------------- summarizers
// Each returns { state: running|ok|failed|waiting|unknown, line, counts?, details: string[] }.
// `details` are the lines a viewer shows below the summary (failing tests, first errors).

function summarizeLog(text) {
  const lines = text.split('\n');
  const errors = lines.filter((l) => /\b(ERROR|FATAL|Exception|FAILED|Error:)\b/.test(l));
  const warns = lines.filter((l) => /\bWARN(ING)?\b/.test(l));
  const counts = { errors: errors.length, warnings: warns.length, lines: lines.length };
  const tag = [errors.length && `${errors.length} error${errors.length === 1 ? '' : 's'}`, warns.length && `${warns.length} warn`].filter(Boolean).join(' · ');
  return { state: 'unknown', line: clip((tag ? tag + ' · ' : '') + lastLine(lines)), counts, details: errors.slice(0, 5).map((l) => clip(l.trim(), 160)) };
}

const TESTS_RE = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/;

// ---------------------------------------------------------------- maven test progress
// What ran: the surefire/failsafe XML reports (one per test class, written when the class
// finishes) and the log (`Running <class>` for the one in progress). What is still to
// come: Maven does not say, and the pom decides (includes, excludes, groups, -Dtest), so
// no guessing from sources: the baseline is what the previous run of the same directory
// ran (its reports, taken when a run starts, kept in .atf so a `mvn clean` loses nothing).

/** Report directories under `cwd`: the module itself and submodules two levels deep. */
function reportDirs(cwd) {
  const dirs = [];
  const visit = (d, depth) => {
    for (const r of ['surefire-reports', 'failsafe-reports']) dirs.push({ module: path.relative(cwd, d) || '.', dir: path.join(d, 'target', r) });
    if (depth >= 2) return;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !['target', 'node_modules', 'src'].includes(e.name)) visit(path.join(d, e.name), depth + 1);
  };
  visit(cwd, 0);
  return dirs;
}

const xmlAttr = (tag, k) => tag.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1];
const unXml = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * Test classes reported under `cwd`, written between `since` and `until` (ms):
 * [{module, cls, tests, failed, skipped, time, mtime, failures: [{name, message}]}].
 */
export function readReports(cwd, since = 0, until = Infinity) {
  const out = [];
  for (const { module, dir } of reportDirs(cwd)) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^TEST-.*\.xml$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const mtime = fs.statSync(p).mtimeMs;
        if (mtime < since || mtime > until) continue; // another run's report
        const x = fs.readFileSync(p, 'utf8');
        const head = x.match(/<testsuite\b[^>]*>/)?.[0] || '';
        const n = (k) => +(xmlAttr(head, k) || 0);
        const failures = [];
        for (const m of x.matchAll(/<testcase\b([^>]*)>\s*<(failure|error)\b([^>]*)/g))
          failures.push({ name: xmlAttr(m[1], 'name'), message: unXml(xmlAttr(m[3], 'message') || '').split('\n')[0] });
        out.push({ module, cls: xmlAttr(head, 'name') || f.slice(5, -4), tests: n('tests'), failed: n('failures') + n('errors'), skipped: n('skipped'), time: +(xmlAttr(head, 'time') || 0), mtime, failures });
      } catch {}
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

/** Aggregate of readReports (kept for callers that only need totals). Null without reports. */
export function surefire(cwd, since = 0, until = Infinity) {
  const rs = readReports(cwd, since, until);
  if (!rs.length) return null;
  return {
    run: rs.reduce((a, r) => a + r.tests, 0),
    failed: rs.reduce((a, r) => a + r.failed, 0),
    skipped: rs.reduce((a, r) => a + r.skipped, 0),
    failing: rs.flatMap((r) => r.failures.map((f) => `${r.cls.split('.').pop()}#${f.name}`)),
    files: rs.length,
  };
}

/** {cls: {module, tests}} of a list of reports. */
const baselineFrom = (reports) => Object.fromEntries(reports.map((r) => [r.cls, { module: r.module, tests: r.tests }]));

/** Where the last known test classes of a directory are kept (survives `mvn clean`). */
export const baselinePath = (root, planId, cwd) => path.join(liveDir(root, planId), 'baselines', `${crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16)}.json`);

/**
 * At the start of a Maven run in `cwd`: the test classes it will probably run, from the
 * reports still there (the previous run), else the saved baseline. Returns the path of the
 * file the run's baseline was written to, or null when nothing is known.
 */
export function captureBaseline(root, planId, cwd, runFile) {
  let classes = baselineFrom(readReports(cwd));
  if (!Object.keys(classes).length) {
    try {
      classes = JSON.parse(fs.readFileSync(baselinePath(root, planId, cwd), 'utf8')).classes || {};
    } catch {}
  }
  if (!Object.keys(classes).length) return null;
  const p = runFile.replace(/\.log$/, '') + '.baseline.json';
  try {
    fs.writeFileSync(p, JSON.stringify({ cwd, classes }));
    return p;
  } catch {
    return null;
  }
}

/** At the end of a Maven run: what it ran becomes the directory's baseline (merged, for -Dtest runs). */
export function saveBaseline(root, planId, cwd, since, until = Infinity) {
  const ran = baselineFrom(readReports(cwd, since, until));
  if (!Object.keys(ran).length) return;
  const p = baselinePath(root, planId, cwd);
  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(p, 'utf8')).classes || {};
  } catch {}
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ cwd, at: new Date().toISOString(), classes: { ...old, ...ran } }));
  } catch {}
}

const firstSeen = new Map(); // log file|class -> when a viewer first saw it running

/**
 * The structured progress of a Maven build: modules (reactor order and state), test classes
 * done (from reports in the run's window), the class running now, failures, and totals
 * against the baseline when there is one.
 */
export function mavenProgress(text, { cwd, since = 0, until = Infinity, baseline = null, file = '' } = {}) {
  const lines = text.split('\n');
  const modules = [];
  const mod = (name) => modules.find((m) => m.name === name) || (modules.push({ name, state: 'pending', id: null }), modules[modules.length - 1]);
  let inOrder = false,
    current = null,
    running = null,
    result = null,
    total = null,
    pos = null;
  const logClasses = new Map(); // class -> {tests, failed, skipped, time} from the log
  const logFailing = [];
  const errors = [];
  for (const l of lines) {
    let m;
    if (/Reactor Build Order:/.test(l)) inOrder = true;
    // Maven 3 prints "[INFO] name    [jar]", older ones indent the name
    else if (inOrder && ((m = l.match(/^\[INFO\]\s+(\S.*?)\s+\[[\w-]+\]\s*$/)) || (m = l.match(/^\[INFO\]\s{2,}(.+?)\s*$/)))) mod(m[1].trim());
    else if (inOrder && !/^\[INFO\]\s*$/.test(l)) inOrder = false;
    if ((m = l.match(/-+< ([\w.-]+):([\w.-]+) >-+/))) current = { id: m[2] };
    if ((m = l.match(/Building (.+?)\s+\S+\s+\[(\d+)\/(\d+)\]/)) || (m = l.match(/Building (.+?) \[(\d+)\/(\d+)\]/))) {
      const name = m[1].replace(/^-+\s*/, '').trim();
      for (const x of modules) if (x.state === 'building') x.state = 'done';
      const x = modules.find((y) => y.name === name || y.name === current?.id || y.name.endsWith(name)) || mod(name);
      x.state = 'building';
      x.id = current?.id ?? null;
      x.label = name;
      pos = `${m[2]}/${m[3]}`;
      running = null;
    }
    if ((m = l.match(/^\[INFO\] Running ([\w.$]+)\s*$/))) running = m[1];
    if ((m = l.match(TESTS_RE)) && (m.input.match(/ in ([\w.$]+)\s*$/) || []).length) {
      const cls = m.input.match(/ in ([\w.$]+)\s*$/)[1];
      logClasses.set(cls, { mod: modules.find((x) => x.state === 'building')?.id ?? current?.id ?? null, tests: +m[1], failed: +m[2] + +m[3], skipped: +m[4], time: +(l.match(/Time elapsed:\s*([\d.]+)/)?.[1] || 0) });
      if (running === cls) running = null;
    }
    if ((m = l.match(/^\[ERROR\]\s+(\S+(?:\.|#)\S+?)(?::\d+)?\s+(.*)$/)) && /Test|test/.test(m[1])) logFailing.push({ name: m[1], message: /Time elapsed|<<</.test(m[2]) ? '' : m[2].trim() });
    if ((m = l.match(/^\[INFO\] (.+?) \.{2,}\s*(SUCCESS|FAILURE|SKIPPED)\b/))) {
      const x = modules.find((y) => y.name === m[1].trim() || y.label === m[1].trim()) || mod(m[1].trim());
      x.state = m[2] === 'SUCCESS' ? 'done' : m[2] === 'FAILURE' ? 'failed' : 'skipped';
    }
    if (/BUILD SUCCESS/.test(l)) result = 'ok';
    if (/BUILD FAILURE/.test(l)) result = 'failed';
    if ((m = l.match(/Total time:\s*(.+)$/))) total = m[1].trim();
    if (/^\[ERROR\]/.test(l) && errors.length < 6 && l.replace(/^\[ERROR\]\s*/, '').trim()) errors.push(clip(l.trim(), 160));
  }
  if (result) for (const x of modules) if (x.state === 'building') x.state = result === 'ok' ? 'done' : 'failed';

  // classes done: reports win (complete, with failure messages); the log fills in
  const reports = cwd ? readReports(cwd, since, until) : [];
  const done = new Map(reports.map((r) => [r.cls, r.time || !logClasses.get(r.cls)?.time ? r : { ...r, time: logClasses.get(r.cls).time }]));
  const base = baseline?.classes || {};
  const dirOf = (mod) => Object.values(base).find((b) => path.basename(b.module) === mod)?.module ?? mod;
  for (const [cls, { mod, ...r }] of logClasses) if (!done.has(cls)) done.set(cls, { module: base[cls]?.module ?? (mod ? dirOf(mod) : null), cls, ...r, failures: [] });
  const order = [...logClasses.keys()];
  const classes = [...done.values()].sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls) || (a.mtime || 0) - (b.mtime || 0));
  // modules of the report directories (a directory name per module) for the per-module view
  const dirs = [...new Set([...classes.map((c) => c.module), ...Object.values(base).map((b) => b.module)].filter(Boolean))];
  // a reactor module and a report directory: by artifactId, name, or a name like demo-<dir>
  const sameMod = (m, base) => [m.id, m.name, m.label].some((n) => n && (n === base || n.endsWith('-' + base)));
  const perDir = dirs.map((d) => {
    const cs = classes.filter((c) => c.module === d);
    const bs = Object.entries(base).filter(([, b]) => b.module === d);
    const expected = bs.length ? new Set([...bs.map(([c]) => c), ...cs.map((c) => c.cls)]) : null;
    const m = modules.find((x) => sameMod(x, path.basename(d)));
    return {
      dir: d,
      module: m?.label || (d === '.' ? m?.name || path.basename(cwd || '.') : path.basename(d)), // the name Maven builds it under, else its directory
      state: m?.state ?? (cs.length ? 'done' : 'pending'),
      classesDone: cs.length,
      classesTotal: expected ? expected.size : null,
      testsDone: cs.reduce((a, c) => a + c.tests, 0),
      testsTotal: expected ? [...expected].reduce((a, c) => a + (done.get(c)?.tests ?? base[c]?.tests ?? 0), 0) : null,
      failed: cs.reduce((a, c) => a + c.failed, 0),
      time: cs.reduce((a, c) => a + c.time, 0),
    };
  });
  for (const m of modules) if (!perDir.some((d) => d.dir && sameMod(m, path.basename(d.dir)))) perDir.push({ dir: null, module: m.label || m.id || m.name, state: m.state, classesDone: 0, classesTotal: null, testsDone: 0, testsTotal: null, failed: 0, time: 0 });
  const testsDone = classes.reduce((a, c) => a + c.tests, 0);
  const known = Object.keys(base).length;
  const allExpected = known ? new Set([...Object.keys(base), ...classes.map((c) => c.cls)]) : null;
  const testsTotal = allExpected ? [...allExpected].reduce((a, c) => a + (done.get(c)?.tests ?? base[c]?.tests ?? 0), 0) : null;
  if (running && file) {
    const k = `${file}|${running}`;
    if (!firstSeen.has(k)) firstSeen.set(k, Date.now());
    if (firstSeen.size > 500) firstSeen.delete(firstSeen.keys().next().value);
  }
  const failures = [
    ...classes.flatMap((c) => c.failures.map((f) => ({ test: `${c.cls.split('.').pop()}#${f.name}`, id: `${c.cls}#${f.name}`, message: f.message }))),
  ];
  // the log's failing names, for failures whose report is not there (yet)
  const norm = (f) => f.replace(/:\d+$/, '').replace('#', '.').split('.').slice(-2).join('#');
  for (const f of logFailing) {
    const test = norm(f.name);
    const have = failures.find((x) => x.test === test);
    if (!have) failures.push({ test, id: f.name.replace(/:\d+$/, ''), message: f.message });
    else if (!have.message && f.message) have.message = f.message;
  }
  return {
    result,
    total,
    position: pos,
    module: modules.find((m) => m.state === 'building')?.label ?? modules.find((m) => m.state === 'failed')?.label ?? modules.find((m) => m.state === 'failed')?.name ?? null,
    modules,
    dirs: perDir,
    classes,
    running: running ? { cls: running, since: firstSeen.get(`${file}|${running}`) ?? null } : null,
    tests: { done: testsDone, total: testsTotal, failed: classes.reduce((a, c) => a + c.failed, 0), skipped: classes.reduce((a, c) => a + c.skipped, 0) },
    classCount: { done: classes.length, total: allExpected ? allExpected.size : null },
    failures,
    errors,
  };
}

function summarizeMaven(text, ctx = {}) {
  let baseline = null;
  if (ctx.extra?.baseline) {
    try {
      baseline = JSON.parse(fs.readFileSync(ctx.extra.baseline, 'utf8'));
    } catch {}
  }
  const p = mavenProgress(text, { ...ctx, baseline });
  const t = p.tests;
  const finished = !!p.result;
  // while it runs: done of the expected (~: the previous run's count); finished: what ran
  const tests = t.done || (!finished && t.total) ? `${t.done}${!finished && t.total ? `/~${t.total}` : ''} tests${t.failed ? ` · ${t.failed} ✗` : ''}${t.skipped ? ` · ${t.skipped} skipped` : ''}` : '';
  const head = p.result === 'ok' ? 'BUILD SUCCESS' : p.result === 'failed' ? `BUILD FAILURE${p.module ? ' in ' + p.module : ''}` : p.module ? `${p.position ? p.position + ' ' : ''}${p.module}` : 'starting';
  const line = [head, tests, p.total].filter(Boolean).join(' · ');
  const details = p.failures.slice(0, 8).map((f) => `✗ ${f.test}${f.message ? ': ' + clip(f.message, 100) : ''}`);
  if (p.result === 'failed' && !details.length) details.push(...p.errors.slice(0, 5));
  const percent = !finished && t.total ? Math.min(99, Math.round((t.done / Math.max(t.total, t.done || 1)) * 100)) : null;
  return { state: p.result || 'running', line: clip(line), counts: { tests: t.done, failed: t.failed, skipped: t.skipped, total: t.total, percent, module: p.module, position: p.position }, details, progress: p };
}

function summarizeTests(text) {
  const lines = text.split('\n');
  let m,
    run = 0,
    failed = 0,
    skipped = 0,
    found = false;
  const s = text;
  if ((m = [...s.matchAll(/Tests:\s+(.+?)\s(\d+) total/g)].pop())) {
    // jest / vitest: "Tests:  2 failed, 410 passed, 412 total"
    found = true;
    run = +m[2];
    failed = +(m[1].match(/(\d+) failed/)?.[1] || 0);
    skipped = +(m[1].match(/(\d+) skipped/)?.[1] || 0);
  } else if ((m = [...s.matchAll(/^=+ (.+?) in [\d.]+s/gm)].pop())) {
    // pytest: "==== 2 failed, 410 passed, 3 skipped in 4.2s ===="
    found = true;
    const n = (k) => +(m[1].match(new RegExp(`(\\d+) ${k}`))?.[1] || 0);
    failed = n('failed') + n('error');
    skipped = n('skipped');
    run = n('passed') + failed + skipped;
  } else if ((m = s.match(/^# tests (\d+)/m))) {
    // node --test (TAP)
    found = true;
    run = +m[1];
    failed = +(s.match(/^# fail (\d+)/m)?.[1] || 0);
    skipped = +(s.match(/^# skipped (\d+)/m)?.[1] || 0);
  } else if ((m = s.match(/Ran (\d+) tests? in/))) {
    // unittest
    found = true;
    run = +m[1];
    failed = +(s.match(/FAILED \((?:failures=(\d+))?(?:, )?(?:errors=(\d+))?/)?.slice(1).reduce((a, x) => a + +(x || 0), 0) || 0);
  } else {
    // go test / cargo: count FAIL / ok lines
    const fails = lines.filter((l) => /^(--- FAIL|FAIL\s|test .* FAILED)/.test(l)).length;
    const oks = lines.filter((l) => /^(ok\s|--- PASS|test .* ok$)/.test(l)).length;
    if (fails || oks) (found = true), (failed = fails), (run = fails + oks);
  }
  const failing = lines
    .filter((l) => /^\s*(✕|×|✗|FAIL\b|--- FAIL|not ok\b|FAILED\b)/.test(l))
    .map((l) => clip(l.trim(), 140))
    .slice(0, 8);
  const done = found && /\b(total|passed|failed|Ran \d+)\b|^# tests|^ok\s/m.test(s);
  const line = found ? `${run} tests${failed ? ` · ${failed} ✗` : ' · all pass'}${skipped ? ` · ${skipped} skipped` : ''}` : clip(lastLine(lines) || 'running');
  return { state: !found ? 'running' : failed ? 'failed' : done ? 'ok' : 'running', line, counts: { tests: run, failed, skipped }, details: failing };
}

const PIPE_URL = /https?:\/\/[^\s'"<>)]+\/(?:-\/pipelines|actions\/runs|pipelines)\/\d+/g;

/**
 * `glab ci get` (text): a "# Pipeline:" block of `key: value` lines (id, status, …), then
 * "# Jobs:" with `name: status` lines. The latest block of a polling loop counts.
 */
function glabGet(text) {
  const at = text.lastIndexOf('# Pipeline:');
  if (at < 0) return null;
  const block = text.slice(at);
  const status = block.match(/^status:\s*(\w+)/m)?.[1]?.toLowerCase();
  if (!status) return null;
  const jobsAt = block.indexOf('# Jobs:');
  const jobs = jobsAt < 0 ? [] : [...block.slice(jobsAt + 7).matchAll(/^\s*([^:\n#][^:\n]*?):\s+([a-z_]+)\s*$/gm)].map((m) => ({ name: m[1].trim(), status: m[2] }));
  const web = block.match(PIPE_URL)?.[0] ?? null;
  return { id: block.match(/^id:\s*(\d+)/m)?.[1] ?? null, status, jobs, url: web };
}

function summarizePipeline(text) {
  const g = glabGet(text);
  if (g) {
    const st = /^(success|passed)$/.test(g.status) ? 'ok' : /^(failed|canceled|cancelled)$/.test(g.status) ? 'failed' : 'waiting';
    const done = g.jobs.filter((j) => /^(success|failed|canceled|skipped|manual)$/.test(j.status)).length;
    const failed = g.jobs.filter((j) => j.status === 'failed');
    const line = [`pipeline${g.id ? ' #' + g.id : ''} ${g.status}`, g.jobs.length ? `${done}/${g.jobs.length} jobs` : '', failed.length ? `${failed.length} ✗` : ''].filter(Boolean).join(' · ');
    return { state: st, line: clip(line), counts: { id: g.id, status: g.status, url: g.url, jobs: g.jobs }, details: failed.map((j) => `✗ ${j.name}`) };
  }
  const lines = text.split('\n');
  const urls = [...new Set(text.match(PIPE_URL) || [])];
  const id = urls.length ? urls[urls.length - 1].match(/(\d+)$/)[1] : text.match(/[Pp]ipeline\s*#?(\d{3,})/)?.[1] ?? null;
  // the latest status word decides; jobs listed by glab/gh carry their own
  const statusRe = /\b(success|passed|succeeded|completed|failed|failure|canceled|cancelled|running|pending|created|queued|in_progress|manual|skipped)\b/gi;
  let status = null;
  for (const l of lines.slice(-40)) for (const m of l.matchAll(statusRe)) status = m[1].toLowerCase();
  const failedJobs = lines.filter((l) => /\b(failed|failure)\b/i.test(l) && !/pipeline/i.test(l)).map((l) => clip(l.trim(), 120)).slice(0, 6);
  const st = !status ? 'waiting' : /^(success|passed|succeeded|completed)$/.test(status) ? 'ok' : /^(failed|failure|canceled|cancelled)$/.test(status) ? 'failed' : 'waiting';
  return { state: st, line: clip(`pipeline${id ? ' #' + id : ''}${status ? ' ' + status : ''}`), counts: { id, status, url: urls[urls.length - 1] ?? null }, details: failedJobs };
}

/** Make whatever a summarize returned safe to render. */
function normalize(r, kind) {
  const x = r && typeof r === 'object' ? r : {};
  return {
    ...x,
    state: ['running', 'waiting', 'ok', 'failed', 'unknown', 'gone'].includes(x.state) ? x.state : 'unknown',
    line: clip(String(x.line ?? ''), 140) || kind,
    counts: x.counts && typeof x.counts === 'object' ? x.counts : {},
    details: Array.isArray(x.details) ? x.details.map((d) => String(d)) : [],
  };
}

/**
 * Summarize text as a kind (unknown kinds as a log). `ctx`: {cwd, since, until, exit, cmd,
 * file, extra, fetched, now}. A plugin that throws gives a summary saying so.
 */
export function summarizeText(kind, text, ctx = {}) {
  const def = registry.get(kind) || registry.get('log');
  try {
    return normalize(def.summarize(stripAnsi(String(text ?? '')), { now: Date.now(), extra: {}, ...ctx, kind: def.kind, helpers: HELPERS }), def.kind);
  } catch (e) {
    return { state: 'unknown', line: `${def.kind}: summarize failed: ${String(e?.message ?? e).slice(0, 80)}`, counts: {}, details: [] };
  }
}

// ---- refresh: data a kind fetches itself (an API), at most every `refreshEvery` ms
const fetched = new Map(); // ref -> {at, data, error, inflight, version, final}
let fetchVersion = 0;
let autoRefresh = false;
/**
 * Let summarize start due refreshes in the background (the board). Off by default: a
 * one-shot command (atf show) must not wait for a fetch; `atf live` awaits refreshLive.
 */
export const enableAutoRefresh = () => (autoRefresh = true);
/** Context of a run or artifact for a kind's functions. */
function ctxOf(x) {
  const since = x.since ? Date.parse(x.since) || 0 : 0;
  return {
    cwd: x.cwd ?? null,
    cmd: x.cmd ?? null,
    file: x.out || x.ref,
    exit: x.exit ?? null,
    active: !!x.active,
    since: since && since - 1000,
    // a finished run: only what was written while it ran (a later build overwrites reports)
    until: since && x.duration_ms != null ? since + x.duration_ms + 5000 : Infinity,
    extra: x.extra || (x.baseline ? { baseline: x.baseline } : {}),
  };
}
/**
 * Run a kind's `refresh` for a run or artifact now (awaitable; the CLI waits for it, the
 * board does not). Results are kept per output file and passed to summarize as `fetched`.
 */
export async function refreshLive(x, { force = false } = {}) {
  const def = registry.get(x.kind);
  if (!def?.refresh) return null;
  const ref = x.out || x.ref;
  const f = fetched.get(ref) || {};
  const every = def.refreshEvery ?? 15_000;
  if (f.inflight) return f.inflight;
  // finished runs are fetched until the kind says final (or once more after an error)
  if (!force && f.at && (f.final || Date.now() - f.at < every)) return f.data;
  const text = readTail(ref, def.tailBytes ?? 256 << 10) ?? '';
  const p = (async () => {
    try {
      const data = await Promise.race([def.refresh({ ...ctxOf(x), kind: def.kind, text: stripAnsi(text), previous: f.data ?? null, helpers: HELPERS }), new Promise((_, rej) => setTimeout(() => rej(new Error('refresh timed out')), def.refreshTimeout ?? 10_000))]);
      fetched.set(ref, { at: Date.now(), data, version: ++fetchVersion, final: x.exit != null && !!data?.final });
      return data;
    } catch (e) {
      fetched.set(ref, { ...f, at: Date.now(), error: String(e?.message ?? e), inflight: null, version: ++fetchVersion });
      return f.data ?? null;
    }
  })();
  fetched.set(ref, { ...f, inflight: p });
  return p;
}

// file|kind -> {mtime, size, at, version, result}, least recently used first. The board
// summarizes every recorded run of every active task on each draw (the rows' live badges):
// the cache has to hold all of them, or every cursor move parses their logs again.
const cache = new Map();
const CACHE_MAX = 5000; // a summary is small (under 1 KB)
/**
 * Summarize a live artifact or run ({kind, ref|out, cwd?, since?, exit?, extra?}). Reads
 * the file's tail; cached by mtime and size (and the kind's `stale` ms, for kinds that
 * read more than the file). A missing file: state `gone`. Kicks off a due `refresh`.
 */
export function summarize(x) {
  const file = x.out || x.ref;
  const def = registry.get(x.kind) || registry.get('log');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    // registered when its command started: the file may not be written yet
    const age = x.since ? Date.now() - Date.parse(x.since) : Infinity;
    if (age < 120_000) return { state: 'unknown', line: `waiting for ${path.basename(file)}`, counts: {}, details: [], mtime: null };
    return { state: 'gone', line: 'file is gone', counts: {}, details: [], mtime: null };
  }
  if (def.refresh && autoRefresh) refreshLive(x).catch(() => {});
  const f = fetched.get(file);
  const key = `${file}|${def.kind}`;
  const c = cache.get(key);
  if (c && c.mtime === st.mtimeMs && c.size === st.size && c.version === (f?.version ?? 0) && (!def.stale || Date.now() - c.at < def.stale)) {
    cache.delete(key); // most recently used: to the end
    cache.set(key, c);
    return c.result;
  }
  const ctx = { ...ctxOf(x), fetched: f?.data ?? null, fetchError: f?.error ?? null };
  const result = { ...summarizeText(def.kind, readTail(file, def.tailBytes ?? 256 << 10) ?? '', ctx), mtime: st.mtimeMs, size: st.size };
  // the exit code beats the text: a run that ended 0 is not still running
  if (x.exit != null && result.state !== 'failed') result.state = x.exit === 0 ? (['running', 'unknown', 'waiting'].includes(result.state) ? 'ok' : result.state) : 'failed';
  cache.delete(key);
  cache.set(key, { mtime: st.mtimeMs, size: st.size, at: Date.now(), version: f?.version ?? 0, result });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return result;
}

/**
 * A view's line, checked: an array of [text, style] segments; or a section heading
 * `{section, note?, folded?}` (the board folds the lines up to the next heading); or an
 * item `{segments, item}` (⏎ on it on the board shows the kind's `item(summary, id)`).
 * Returned as segment arrays; a heading's has `.section` (and `.folded`), an item's `.item`.
 */
function viewLine(l) {
  const segs = (a) => a.map((seg) => (Array.isArray(seg) ? [String(seg[0] ?? ''), STYLES.has(seg[1]) ? seg[1] : ''] : [String(seg), '']));
  if (Array.isArray(l)) return segs(l);
  if (!l || typeof l !== 'object') return null;
  if (l.section != null) {
    const out = [[String(l.section), 'bold'], ...(l.note != null && l.note !== '' ? [[`  ${l.note}`, 'dim']] : [])];
    return Object.assign(out, { section: String(l.section), folded: !!l.folded });
  }
  if (Array.isArray(l.segments)) {
    const out = segs(l.segments);
    return l.item != null ? Object.assign(out, { item: String(l.item) }) : out;
  }
  return null;
}
const viewLines = (lines) => (Array.isArray(lines) ? lines.map(viewLine).filter(Boolean) : null);

/**
 * The detailed view of a run or artifact: the kind's `view` (lines, see viewLine), else
 * its details. `opts`: {width, full, active}.
 */
export function liveView(x, summary, opts = {}) {
  const def = registry.get(x.kind) || registry.get('log');
  if (def.view) {
    try {
      const lines = viewLines(def.view(summary, { width: 100, full: false, active: !!x.active, ...opts, helpers: HELPERS }, ctxOf(x)));
      if (lines) return lines;
    } catch (e) {
      return [[[`${def.kind}: view failed: ${String(e?.message ?? e).slice(0, 80)}`, 'red']]];
    }
  }
  return summary.details.slice(0, opts.full ? 50 : 4).map((d) => [['  ' + d, summary.state === 'failed' ? 'red' : 'dim']]);
}

/** Whether a kind shows items in full (`item`: ⏎ on an item line of its view). */
export const hasItem = (k) => !!registry.get(k)?.item;

/** One item of a run's view in full (the kind's `item`), as lines; null if it has none. */
export function liveItem(x, summary, id, opts = {}) {
  const def = registry.get(x.kind);
  if (!def?.item) return null;
  try {
    return viewLines(def.item(summary, String(id), { width: 100, ...opts, helpers: HELPERS }, ctxOf(x))) || [];
  } catch (e) {
    return [[[`${def.kind}: item failed: ${String(e?.message ?? e).slice(0, 80)}`, 'red']]];
  }
}

/** The last refresh error for a run or artifact (or null). */
export const refreshError = (x) => fetched.get(x.out || x.ref)?.error ?? null;

/** Whether a kind has its own detailed view (the board's L opens `atf live` for it). */
export const hasView = (k) => !!registry.get(k)?.view;

/** What L opens for a run or artifact, from the kind's `open`: {url} | {file} | null. */
export function liveOpen(x, summary) {
  const def = registry.get(x.kind);
  try {
    const o = def?.open?.(summary, ctxOf(x));
    return o && (typeof o.url === 'string' || typeof o.file === 'string') ? o : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- ephemeral runs
export const liveDir = (root, planId) => path.join(planDir(root, planId), 'live');
const safeName = (s) => String(s).replace(/[^\w.@-]+/g, '_');
export const liveStatePath = (root, planId, actor) => path.join(liveDir(root, planId), `${safeName(actor)}.json`);

/** Write an agent's current runs ({actor, pid, runs: [...]}): atomic, removed when empty. */
export function writeLiveState(root, planId, actor, state) {
  const p = liveStatePath(root, planId, actor);
  try {
    if (!state.runs?.length) return void fs.rmSync(p, { force: true });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + '.tmp', JSON.stringify({ ...state, actor, updated_at: new Date().toISOString() }));
    fs.renameSync(p + '.tmp', p);
  } catch {}
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * The commands agents of the plan are running right now: [{actor, task, kind, cmd, cwd,
 * since, out, waiting}]. Runs of agents whose process is gone are ignored.
 */
export function activeRuns(root, planId) {
  const dir = liveDir(root, planId);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!s.pid || !alive(s.pid)) continue;
      for (const r of s.runs || []) out.push({ ...r, actor: s.actor, waiting: isWaiting(r.kind) || !!r.approval });
    } catch {}
  }
  return out;
}

/** Captured output of finished runs is kept here (one file per run). */
export const runsDir = (root, planId) => path.join(liveDir(root, planId), 'runs');

/** "4m12s" */
export function elapsed(since, now = Date.now()) {
  const s = Math.max(0, Math.round((now - (typeof since === 'number' ? since : Date.parse(since))) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * What a recorded run is a newer version of: the same kind in the same directory (a later
 * `mvn verify` after a fix replaces the failed one); generic logs only for the same command;
 * live files by path.
 */
export function supersedeKey(a) {
  if (a.live) return `file|${a.ref}`;
  const first = String(a.cmd || '').split('\n').find((l) => l.trim() && !/^\s*atf\s/.test(l)) || '';
  if (a.kind === 'deploy') {
    // each service is its own result: a deploy replaces only an earlier one of the same target
    const t = deployTarget(first);
    return t?.target ? `deploy|${t.target}|${t.namespace ?? ''}` : `deploy|${first.trim()}`;
  }
  return a.kind === 'log' ? `log|${a.cwd || ''}|${first.trim()}` : `${a.kind}|${a.cwd || ''}`;
}

/**
 * Live view of a task: `now` the commands running for it, `recorded` the current run per
 * kind and directory and its live files (newest first), `earlier` the runs a later one
 * replaced (history: `atf live --all`), `all` both. `runs` from activeRuns().
 */
export function taskLive(task, runs = []) {
  // a command the harness holds until the human allows it: waits for them, does not run yet
  const asking = { state: 'waiting', line: 'waiting for your approval', counts: {}, details: [], mtime: null };
  const now = runs.filter((r) => r.task === task.id).map((r) => ({ ...r, active: true, summary: r.approval ? asking : summarize(r) }));
  const all = (task.artifacts || [])
    .map((a, i) => ({ ...a, i }))
    .filter((a) => !(a.live && /^[a-z]+:\/\//.test(a.ref))) // a URL registered as live: not a file
    .filter((a) => a.live || a.cmd || (registry.has(a.kind) && a.kind !== 'log'))
    .reverse()
    .filter((a, i, list) => !a.live || list.findIndex((b) => b.live && b.ref === a.ref) === i); // a file registered twice: once
  const seen = new Set();
  const recorded = [];
  const earlier = [];
  // runs of an earlier attempt (before the task was sent back) are history too
  const att = task.attempts?.length > 1 ? task.attempts[task.attempts.length - 1].ts : null;
  for (const a of all) {
    const k = supersedeKey(a);
    (seen.has(k) || (att && a.cmd && a.since && a.since < att) ? earlier : recorded).push(a);
    seen.add(k);
  }
  const withSummary = (list, extra = {}) => list.map((a) => ({ ...a, active: false, ...extra, summary: summarize(a) }));
  const cur = withSummary(recorded);
  // a run in progress replaces the recorded one it repeats
  const nowKeys = new Set(now.map((r) => supersedeKey({ ...r, kind: artifactKind(r.kind) })));
  const shown = cur.filter((a) => !nowKeys.has(supersedeKey(a)));
  const old = [...withSummary(earlier, { superseded: true }), ...cur.filter((a) => nowKeys.has(supersedeKey(a))).map((a) => ({ ...a, superseded: true }))];
  return { now, recorded: shown, earlier: old, all: [...cur, ...old.filter((a) => !cur.includes(a))] };
}

/** "2 earlier runs (1 failed)" for a collapsed history line, or ''. */
export function earlierText(live) {
  const n = live.earlier.length;
  if (!n) return '';
  const failed = live.earlier.filter((a) => a.exit != null && a.exit !== 0).length;
  return `${n} earlier run${n === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}, replaced by newer ones`;
}

/** One short glyph + text for a task's list row: what runs / waits now, else the latest run. */
export function liveBadge(live) {
  const r = live.now.find((x) => x.waiting) || live.now[0];
  if (r) return { glyph: r.waiting ? '⧖' : '⚙', text: r.summary.state !== 'gone' && r.summary.line ? r.summary.line : (r.cmd || '').slice(0, 30), color: r.waiting ? 'yellow' : 'cyan' };
  // a current run (not replaced by a newer one) that failed
  const failed = live.recorded.find((a) => a.exit != null && a.summary.state === 'failed');
  return failed ? { glyph: '✗', text: failed.summary.line, color: 'red' } : null;
}

// ---------------------------------------------------------------- views
// Lines of [text, style] segments (styles: bold dim red green yellow cyan gray), so the
// board and the CLI render the same view.

const bar = (frac, w) => {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * w);
  return '█'.repeat(n) + '░'.repeat(w - n);
};
const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`);
const MOD_GLYPH = { done: ['✓', 'green'], failed: ['✗', 'red'], building: ['⚙', 'cyan'], skipped: ['–', 'gray'], pending: ['○', 'gray'] };

/**
 * A Maven run's test progress: overall bar, modules, the class running now, finished
 * classes and failures. `full: false` (the board's details): at most 8 lines, modules
 * folded to one line when there are many; `full: true` (the live view, atf live): every
 * module, failure and class, in sections, each failure an item (⏎: its stack trace).
 */
export function mavenView(s, { width = 100, full = false, active = false } = {}) {
  const p = s.progress;
  if (!p) return [];
  const L = [];
  const t = p.tests;
  const W = Math.max(10, Math.min(30, width - 50));
  const frac = t.total ? t.done / Math.max(t.total, t.done) : p.result ? 1 : 0;
  const ofTotal = t.total && !p.result ? `/~${t.total}` : '';
  const cls = p.classCount.total && !p.result ? `${p.classCount.done}/${p.classCount.total} classes` : `${p.classCount.done} classes`;
  L.push([[bar(frac, W) + ' ', p.result === 'failed' || t.failed ? 'red' : p.result === 'ok' ? 'green' : 'cyan'], [`${t.done}${ofTotal} tests`, 'bold'], [`  ${cls}`, 'dim'], [t.failed ? `  ${t.failed} ✗` : '', 'red'], [t.skipped ? `  ${t.skipped} skipped` : '', 'yellow'], [!t.total && !p.result && active ? '  (total known after the first run)' : '', 'dim']]);
  if (p.running && !p.result) L.push([['  ▸ running ', 'cyan'], [p.running.cls.split('.').pop(), 'bold'], [`  ${p.running.cls.split('.').slice(0, -1).join('.')}`, 'dim'], [p.running.since ? `  ${elapsed(p.running.since)}` : '', 'dim']]);

  const rows = p.dirs.length ? p.dirs : p.modules.map((m) => ({ module: m.label || m.name, state: m.state, classesDone: 0, classesTotal: null, testsDone: 0, testsTotal: null, failed: 0, time: 0 }));
  const nameW = Math.min(24, Math.max(6, ...rows.map((r) => r.module.length)));
  const modRow = (r) => {
    const [g, c] = MOD_GLYPH[r.state] || MOD_GLYPH.pending;
    const counts = r.classesTotal != null && r.state !== 'done' && r.state !== 'failed' ? `${r.testsDone}/~${r.testsTotal} tests  ${r.classesDone}/${r.classesTotal} classes` : r.testsDone || r.classesDone ? `${r.testsDone} tests  ${r.classesDone} classes` : r.testsTotal ? `~${r.testsTotal} tests` : '';
    return [[`  ${g} `, c], [r.module.padEnd(nameW) + '  ', r.state === 'building' ? 'bold' : r.state === 'pending' ? 'dim' : ''], [counts, 'dim'], [r.failed ? `  ${r.failed} ✗` : '', 'red'], [r.time ? `  ${secs(r.time)}` : '', 'dim']];
  };
  const finished = [...p.classes].reverse(); // newest first
  const cw = (list) => Math.min(40, Math.max(8, ...list.map((c) => c.cls.split('.').pop().length)));
  const classRow = (c, w) => [[`    ${c.failed ? '✗' : '✓'} `, c.failed ? 'red' : 'green'], [c.cls.split('.').pop().padEnd(w), c.failed ? 'red' : ''], [`  ${`${c.tests - c.failed - c.skipped}/${c.tests}`.padStart(7)}${c.skipped ? ` (${c.skipped} skipped)` : ''}`, 'dim'], [c.time ? `  ${secs(c.time)}` : '', 'dim'], [full && c.module && c.module !== '.' ? `  ${c.module}` : '', 'gray']];
  const failRow = (f, indent) => [[`${indent}✗ `, 'red'], [f.test, 'red'], [f.message ? '  ' + clip(f.message, Math.max(20, width - f.test.length - indent.length - 4)) : '', 'dim']];

  if (!full) {
    // modules: listed when few; else one line of counts, plus the one building and the one failed
    if (rows.length <= 3) L.push(...rows.map(modRow));
    else {
      const n = (st) => rows.filter((r) => r.state === st).length;
      const counts = [['done', '✓', 'green'], ['failed', '✗', 'red'], ['building', '⚙', 'cyan'], ['skipped', '–', 'gray'], ['pending', '○', 'gray']].filter(([st]) => n(st));
      L.push([['  modules  ', 'dim'], ...counts.flatMap(([st, g, c]) => [[`${n(st)} ${g}`, c], ['  ', '']])]);
      L.push(...[rows.find((r) => r.state === 'building'), rows.find((r) => r.state === 'failed')].filter(Boolean).map(modRow));
    }
    if (p.failures.length) {
      L.push(...p.failures.slice(0, 2).map((f) => failRow(f, '  ')));
      if (p.failures.length > 2) L.push([[`    … ${p.failures.length - 2} more failures`, 'dim']]);
    } else if (finished.length) {
      const show = finished.slice(0, 2);
      L.push(...show.map((c) => classRow(c, cw(show))));
      if (finished.length > 2) L.push([[`    … ${finished.length - 2} more finished`, 'dim']]);
    }
    return L;
  }

  // full: in sections (the board folds them); failures first, they are what to act on
  const done = rows.filter((r) => r.state === 'done').length;
  L.push({ section: 'modules', note: `${done}/${rows.length} done` }, ...rows.map(modRow));
  if (p.failures.length) {
    L.push({ section: 'failures', note: `${p.failures.length} · ⏎ on one: its stack trace` });
    for (const f of p.failures) L.push({ segments: failRow(f, '  '), item: f.id || f.test });
  } else if (p.result === 'failed' && p.errors.length) L.push({ section: 'errors' }, ...p.errors.map((e) => [['  ' + clip(e, width - 2), 'red']]));
  if (finished.length) {
    const w = cw(finished);
    L.push({ section: 'test classes', note: `${finished.length} · newest first` }, ...finished.map((c) => classRow(c, w)));
  }
  return L;
}

/**
 * One failed test in full (the maven kind's `item`): the report's failure message and
 * stack trace (surefire/failsafe XML of this run), else what the build log printed for it.
 * `id`: "com.acme.FooTest#bar" (or "FooTest#bar", "com.acme.FooTest.bar").
 */
export function mavenFailure(id, ctx = {}, { width = 100 } = {}) {
  const raw = String(id);
  const [clsPart, name] = raw.includes('#') ? raw.split('#') : [raw.slice(0, raw.lastIndexOf('.')), raw.slice(raw.lastIndexOf('.') + 1)];
  const short = clsPart.split('.').pop();
  let found = null;
  if (ctx.cwd)
    for (const { dir } of reportDirs(ctx.cwd)) {
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.xml') && (f === `TEST-${clsPart}.xml` || f.endsWith(`.${short}.xml`) || f === `TEST-${short}.xml`));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const file = path.join(dir, f);
          const mtime = fs.statSync(file).mtimeMs;
          if (mtime < (ctx.since || 0) || mtime > (ctx.until ?? Infinity)) continue;
          const x = fs.readFileSync(file, 'utf8');
          for (const m of x.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
            if (xmlAttr(m[1], 'name') !== name || !m[3]) continue;
            const fm = m[3].match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
            if (!fm) continue;
            const body = unXml((fm[3] || '').replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, ''));
            found = { file, kind: fm[1], type: unXml(xmlAttr(fm[2], 'type') || ''), message: unXml(xmlAttr(fm[2], 'message') || ''), stack: body, time: xmlAttr(m[1], 'time') };
            break;
          }
        } catch {}
        if (found) break;
      }
      if (found) break;
    }
  const wrapTo = (text, w) => String(text).split('\n').flatMap((l) => (l.length <= w ? [l] : l.match(new RegExp(`.{1,${w}}`, 'g'))));
  const L = [[[`${short}#${name}`, 'bold red'], [found?.time ? `  ${secs(+found.time)}` : '', 'dim']]];
  // a frame of the test framework or the JDK: dim; the project's own frames stand out
  const lib = /^\s*at (java\.|javax\.|jdk\.|sun\.|org\.junit|junit\.|org\.apache\.maven|org\.testng|org\.opentest4j|org\.assertj|org\.hamcrest|org\.mockito|org\.springframework\.test)/;
  const stackLines = (lines) => lines.flatMap((l) => wrapTo(l.replace(/\t/g, '    '), width - 4).map((w) => [['  ' + w, /^\s*at /.test(l) ? (lib.test(l) ? 'gray' : '') : /^\s*(Caused by|\.\.\. \d+ more)/.test(l) ? 'yellow' : 'red']]));
  if (found) {
    L.push([[`  ${found.kind}${found.type ? ' · ' + found.type : ''}`, 'dim']], []);
    const msgInStack = found.message && found.stack.includes(found.message.split('\n')[0]);
    if (found.message && !msgInStack) L.push(...wrapTo(found.message, width - 4).map((l) => [['  ' + l, 'red']]), []);
    if (found.stack.trim()) L.push(...stackLines(found.stack.trimEnd().split('\n')));
    L.push([], [[`  ${ctx.cwd ? path.relative(ctx.cwd, found.file) : found.file}`, 'gray']]);
    return L;
  }
  // no report (not written yet, or another run's): what the log says about the test
  const text = ctx.file ? stripAnsi(readTail(ctx.file, 1 << 20) || '') : '';
  const lines = text.split('\n');
  const about = (l) => /^\[ERROR\]/.test(l) && (l.includes(`${short}.${name}`) || l.includes(`${short}#${name}`)) && !/Tests run:/.test(l);
  // the block surefire prints with the stack trace ("<<< FAILURE!"), else the Results line
  const at = [lines.findIndex((l) => about(l) && /<<< (FAILURE|ERROR)!/.test(l)), lines.findIndex(about)].find((i) => i >= 0) ?? -1;
  if (at < 0) return [...L, [], [['  no report and nothing in the output for this test (yet)', 'dim']]];
  const out = [lines[at].replace(/^\[ERROR\]\s*/, '')];
  for (let i = at + 1; i < lines.length && out.length < 200; i++) {
    if (/^\[(INFO|ERROR|WARNING)\]/.test(lines[i]) || !lines[i].trim()) break;
    out.push(lines[i]);
  }
  return [...L, [['  from the build output (no report for it)', 'dim']], [], ...stackLines(out)];
}

// ---------------------------------------------------------------- kinds and plugins
// A kind knows how to recognize a command, summarize its output and show it. The built-in
// kinds below use the same interface as plugins; a plugin with the same name replaces one.
// The interface and how to write a plugin: docs/live-plugins.md.

/** Styles a view may use for its segments. */
export const STYLES = new Set(['', 'bold', 'dim', 'red', 'green', 'yellow', 'cyan', 'magenta', 'gray', 'bold red', 'bold green', 'bold yellow', 'bold cyan']);

/** Helpers passed to a kind's functions (ctx.helpers / opts.helpers). */
export const HELPERS = {
  clip, // clip(text, n): shorten to n characters with …
  elapsed, // elapsed(sinceIsoOrMs, now?): "4m12s"
  secs: (s) => secs(s), // secs(seconds): "1m02s" / "3.4s"
  bar: (frac, w) => bar(frac, w), // bar(0..1, width): "████░░░░"
  readTail, // readTail(file, maxBytes?): the end of a file as text, or null
  lastLine,
};

const pipelineMatch = (cmd, { unquoted }) =>
  /(^|[\s;&|(/])(glab\s+(ci|pipeline|pipe)\b|gh\s+(run\s+(watch|view)|pr\s+checks)\b)/.test(unquoted) ||
  // URLs are often quoted (`curl -s "…/pipelines/$id"`): the raw command for those
  (/\b(curl|wget|http)\b/.test(unquoted) && /\/(pipelines|jobs|actions\/runs)\b/.test(cmd));

// ---------------------------------------------------------------- deployments
// helm, kubectl, argocd, helmfile, skaffold, flux, ansible-playbook: what was deployed (from
// the command, or from the output when one command deploys several, e.g. a loop) and how it
// ended (exit code, then the tools' own success and failure lines).

const DEPLOY_RE =
  /(^|[\s;&|(/])(helm\s+(upgrade|install|rollback|uninstall)\b|(kubectl|oc)\s+(apply|replace|rollout\s+(status|restart|undo)|set\s+image)\b|argocd\s+app\s+(sync|wait|rollback)\b|helmfile\b[^;&|]*\b(apply|sync|deploy)\b|skaffold\s+(run|deploy)\b|flux\s+reconcile\b|ansible-playbook\b)/;
const VALUE_FLAGS = new Set(['-n', '--namespace', '-f', '--values', '--set', '--set-string', '--set-file', '--version', '--timeout', '--kube-context', '--kubeconfig', '-o', '--output', '-l', '--selector', '--context', '-i', '--inventory', '-e', '--extra-vars', '--limit', '--tags', '-t']);

/** The first deploy command of a command line: {tool, action, target, namespace}. */
export function deployTarget(cmd) {
  const m = String(cmd ?? '').match(DEPLOY_RE);
  if (!m) return null;
  const rest = String(cmd).slice(m.index + m[0].length).split(/[;&|]|\bdo\b|\bdone\b/)[0];
  const words = m[0].trim().replace(/^[;&|(/]/, '').split(/\s+/);
  const tool = words[0];
  const action = words.slice(1).join(' ') || null;
  const args = [];
  let namespace = null;
  const toks = rest.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok === '-n' || tok === '--namespace') namespace = toks[++i] ?? null;
    else if (tok.startsWith('--namespace=')) namespace = tok.slice(12);
    else if (tok === '-f' || tok === '--filename') args.push(path.basename(toks[++i] ?? '')); // kubectl apply -f k8s/ledger.yaml
    else if (VALUE_FLAGS.has(tok)) i++;
    else if (!tok.startsWith('-')) args.push(tok);
  }
  let target = args[0] ?? null;
  if (tool === 'ansible-playbook') target = args.find((a) => /\.ya?ml$/.test(a)) ?? target;
  if (target) target = target.replace(/^(deployment|deploy|statefulset|sts|daemonset|ds)\//, '');
  if (target && /[$`]/.test(target)) target = null; // a loop variable: the output says which
  return { tool, action, target, namespace };
}

function summarizeDeploy(text, ctx = {}) {
  const lines = text.split('\n');
  const t = deployTarget(ctx.cmd) ?? {};
  // what the output reports as deployed (several when one command deploys several)
  const done = new Set();
  for (const l of lines) {
    const r = l.match(/Release "([^"]+)" (has been upgraded|does not exist\. Installing it now)/) || l.match(/^NAME:\s+(\S+)/) || l.match(/(?:deployment|statefulset|daemonset)(?:\.apps)? "([^"]+)" successfully rolled out/) || l.match(/^(?:deployment|statefulset|daemonset)\.apps\/(\S+) (?:configured|created|unchanged|image updated|restarted)/);
    if (r) done.add(r[1]);
  }
  const fail = lines.filter((l) => /\b(Error|error|FAILED|failed=[1-9]|unreachable=[1-9]|exceeded its progress deadline|timed out waiting|ImagePullBackOff|CrashLoopBackOff|Degraded)\b/.test(l));
  const ansibleOk = lines.some((l) => /PLAY RECAP/.test(l)) && !lines.some((l) => /\b(failed|unreachable)=[1-9]/.test(l));
  const okLine = lines.some((l) => /STATUS: deployed|successfully rolled out|Health Status:\s+Healthy|Sync Status:\s+Synced|Happy Helming/.test(l)) || ansibleOk;
  const state = ctx.exit === undefined || ctx.exit === null ? (fail.length ? 'failed' : 'running') : ctx.exit === 0 && !(fail.length && !okLine) ? 'ok' : 'failed';
  const names = [...done];
  const what = t.target ? [t.target, ...names.filter((n) => n !== t.target)] : names;
  const who = what.length > 3 ? `${what.slice(0, 3).join(', ')} +${what.length - 3}` : what.join(', ') || t.target || t.tool || 'deploy';
  const ns = t.namespace ? ` (${t.namespace})` : '';
  const why = fail.length ? ': ' + clip(fail[fail.length - 1].trim().replace(/^error:\s*/i, ''), 60) : '';
  const line = state === 'ok' ? `deployed ${who}${ns}` : state === 'failed' ? `${who}${ns} failed${why}` : `deploying ${who}${ns}…`;
  return { state, line: clip(line), counts: { tool: t.tool ?? null, action: t.action ?? null, target: t.target ?? null, namespace: t.namespace ?? null, deployed: names }, details: fail.slice(-5).map((l) => clip(l.trim(), 160)) };
}

const BUILTIN = [
  {
    kind: 'pipeline',
    description: 'CI pipeline watch (glab ci, gh run watch, curl …/pipelines): id, URL, latest status',
    waiting: true,
    match: pipelineMatch,
    summarize: summarizePipeline,
    open: (s) => (s.counts.url ? { url: s.counts.url } : null),
  },
  {
    kind: 'maven',
    description: 'Maven build: reactor modules, test classes from surefire/failsafe reports, progress against the previous run',
    match: (cmd, { unquoted }) => /(^|[\s;&|(/])(mvn|mvnw|mvnd)(\s|$)/.test(unquoted),
    summarize: summarizeMaven,
    view: (s, opts) => mavenView(s, opts),
    item: (s, id, opts, ctx) => mavenFailure(id, ctx, opts),
    tailBytes: 1 << 20,
    stale: 3000, // reads report directories too
    // the previous run's test classes are this run's expected total (before a `clean`)
    onStart: ({ root, plan, cwd, runFile }) => {
      const b = captureBaseline(root, plan, cwd, runFile);
      return b ? { baseline: b } : null;
    },
    onEnd: ({ root, plan, cwd, since, until }) => saveBaseline(root, plan, cwd, since, until),
  },
  {
    kind: 'tests',
    description: 'test runners (npm/jest/vitest/pytest/go/cargo/node --test/unittest): totals, failing tests',
    match: (cmd, { unquoted }) => /(^|[\s;&|(/])(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|(^|[\s;&|(/])(npx\s+)?(jest|vitest|pytest|mocha)\b|\bgo\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\bpython3?\s+-m\s+(pytest|unittest)\b/.test(unquoted),
    summarize: summarizeTests,
  },
  {
    kind: 'deploy',
    description: 'deployments (helm, kubectl apply/rollout/set image, argocd, helmfile, skaffold, flux, ansible-playbook): what was deployed, and how it ended',
    match: (cmd, { unquoted }) => DEPLOY_RE.test(unquoted),
    summarize: summarizeDeploy,
  },
  {
    kind: 'wait',
    description: 'polling loops (while/until/for … sleep, watch -n): shown as waiting, recorded as a log',
    waiting: true,
    record: 'log',
    match: (cmd, { unquoted }) => /\b(while|until|for)\b[\s\S]*\bsleep\b|\bwatch\s+-n\b/.test(unquoted),
    summarize: summarizeLog,
  },
  {
    kind: 'build',
    description: 'other builds (gradle, make, cargo build, npm run build, docker build): recorded as a log',
    record: 'log',
    match: (cmd, { unquoted }) => /(^|[\s;&|(/])(gradlew?|make|cargo\s+build|npm\s+run\s+build|docker\s+(build|compose\s+up))\b/.test(unquoted),
    summarize: summarizeLog,
  },
  { kind: 'log', description: 'any text file: error and warning counts, last line', summarize: summarizeLog },
];

const registry = new Map(); // kind -> def (with .source)
const loadErrors = [];
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Check a kind definition; returns an error message or null. */
export function checkKind(def) {
  if (!def || typeof def !== 'object') return 'not an object';
  if (!KIND_RE.test(def.kind ?? '')) return `kind must match ${KIND_RE} (got ${JSON.stringify(def.kind)})`;
  if (typeof def.summarize !== 'function') return `${def.kind}: summarize(text, ctx) is required`;
  for (const f of ['match', 'view', 'item', 'refresh', 'open', 'onStart', 'onEnd']) if (def[f] != null && typeof def[f] !== 'function') return `${def.kind}: ${f} must be a function`;
  if (def.record != null && !KIND_RE.test(def.record)) return `${def.kind}: record must be a kind name`;
  return null;
}

/** Register a kind (a plugin's replaces a built-in of the same name). */
export function registerLiveKind(def, source = 'built-in') {
  const err = checkKind(def);
  if (err) throw new Error(err);
  registry.set(def.kind, { priority: 0, ...def, source, replaces: registry.get(def.kind)?.source ?? null });
}
for (const d of BUILTIN) registerLiveKind(d);

/** Kinds that recognize commands, in the order they are asked: plugins (priority), then built-ins. */
function matchOrder() {
  const all = [...registry.values()].filter((d) => d.match);
  const builtin = BUILTIN.map((b) => b.kind);
  return all.sort((a, b) => (a.source === 'built-in') - (b.source === 'built-in') || (b.priority ?? 0) - (a.priority ?? 0) || builtin.indexOf(a.kind) - builtin.indexOf(b.kind));
}

/** Where plugins are loaded from: $ATF_LIVE_PLUGINS (files or directories, `:`-separated), then ~/.config/atf/live/. */
export function pluginPaths() {
  const base = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  return [...String(process.env.ATF_LIVE_PLUGINS || '').split(path.delimiter).filter(Boolean), path.join(base, 'atf', 'live')];
}

let loading = null;
/**
 * Load the plugins (once per process; `files` adds more, e.g. for `atf live-try`). Each
 * file's default export is a kind definition or an array of them. Errors are collected,
 * never thrown: a broken plugin leaves the others and the built-ins working.
 */
export function loadLiveKinds({ files = [] } = {}) {
  if (loading && !files.length) return loading;
  const run = async () => {
    const list = [];
    for (const p of [...pluginPaths(), ...files]) {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) /\.(mjs|js)$/.test(f) && list.push(path.join(p, f));
      else list.push(p);
    }
    for (const file of [...new Set(list.map((f) => path.resolve(f)))]) {
      try {
        const mod = await import(new URL(`file://${file}`).href);
        const defs = [mod.default ?? mod.kind].flat().filter(Boolean);
        if (!defs.length) throw new Error('no default export');
        for (const d of defs) registerLiveKind(d, file);
      } catch (e) {
        loadErrors.push({ file, error: String(e?.message ?? e) });
      }
    }
    return liveKinds();
  };
  const p = run();
  if (!files.length) loading = p;
  return p;
}

/** The registered kinds (for `atf live-kinds`) and plugin load errors. */
export function liveKinds() {
  return {
    kinds: [...registry.values()].map((d) => ({ kind: d.kind, source: d.source, replaces: d.replaces, description: d.description ?? '', waiting: !!d.waiting, record: d.record ?? null, priority: d.priority ?? 0, has: ['match', 'summarize', 'view', 'item', 'refresh', 'open', 'onStart', 'onEnd'].filter((f) => typeof d[f] === 'function') })),
    errors: [...loadErrors],
  };
}

/** A kind's definition (or undefined). */
export const liveKind = (k) => registry.get(k);
