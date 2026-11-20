#!/usr/bin/env node
// A demo for the board's live view (L): a project whose agent "runs" a Maven build.
//
//   node examples/live-demo.mjs [dir]      (default: ~/atf-live-demo; --once: one build only)
//
// It creates the project (an ATF plan with a task in progress, owned by agent "backend"),
// then plays that agent: a simulated `mvn -B verify` over 8 modules, reported through the
// same observer the agents' harness hooks use (src/live-observer.mjs). Its log is written
// as it goes, with surefire reports per test class (some failures with stack traces). The
// build repeats every few seconds, so the second run counts against the first (~totals)
// and [ ] in the live view has several runs. ctrl+c stops it.
//
// Open the board on it: in herdr, a pane in that directory, then the board (or
// `node adapters/herdr/atf-herdr.mjs tui` there); ⏎ the plan, select T1, L.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATF = path.join(REPO, 'bin', 'atf.mjs');
const args = process.argv.slice(2);
const once = args.includes('--once');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(os.homedir(), 'atf-live-demo'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the project: plan, tasks, T1 in progress by "backend"
fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env, ATF_DIR: '', ATF_PLAN: '', ATF_ACTOR: 'lead', ATF_ROLE: 'coordinator' };
const atf = (a, extra = {}) => JSON.parse(execFileSync('node', [ATF, ...a, '--json'], { cwd: dir, env: { ...env, ...extra } }).toString());
let root = path.join(dir, '.atf');
let plan;
if (!fs.existsSync(path.join(root, 'plans'))) {
  root = atf(['init']).root;
  atf(['projects', 'add', dir]);
}
plan = atf(['plan', 'list']).find((p) => p.title === 'Live demo' && p.status === 'active')?.id;
if (!plan) {
  plan = atf(['plan', 'new', 'Live demo', '--goal', 'Try the board\'s live view (L)']).plan;
  atf(['add', 'Backend: build and test', '--assign', 'backend', '--accept', 'mvn verify passes'], { ATF_PLAN: plan });
  atf(['add', 'Frontend', '--accept', 'nothing, it only fills the tree'], { ATF_PLAN: plan });
  atf(['start', 'T1'], { ATF_PLAN: plan, ATF_ACTOR: 'backend', ATF_ROLE: 'subagent' });
}

// ---- a Maven project: 8 modules, test classes with their tests
const MODULES = {
  core: ['MoneyTest', 'RoundingTest', 'CurrencyTest'],
  model: ['OrderTest', 'CustomerTest'],
  persistence: ['OrderRepositoryIT', 'MigrationIT'],
  api: ['OrderControllerTest', 'PaymentControllerTest', 'RefundTest'],
  auth: ['TokenTest', 'SessionTest'],
  web: ['CheckoutPageTest'],
  cli: ['CommandsTest'],
  app: ['ApplicationIT'],
};
const tests = (cls) => 3 + (cls.length % 9);
// what fails, per run: the first run has two failures, then one, then none (and again)
const FAILS = [
  { 'api.RefundTest': ['refundTwice', 'expected: <409> but was: <500>'], 'persistence.MigrationIT': ['v42AddsIndex', 'Index idx_order_customer not found'] },
  { 'api.RefundTest': ['refundTwice', 'expected: <409> but was: <500>'] },
  {},
];
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function build(n, observer) {
  const fails = FAILS[n % FAILS.length];
  const id = `demo-${Date.now()}`;
  await observer.start({ id, cmd: 'mvn -B verify', cwd: dir });
  const t0 = Date.now();
  const out = (line) => observer.output({ id, text: line + '\n', append: true });
  const mods = Object.keys(MODULES);
  out('[INFO] Scanning for projects...');
  out('[INFO] ------------------------------------------------------------------------');
  out('[INFO] Reactor Build Order:');
  out('[INFO] ');
  for (const m of mods) out(`[INFO] demo-${m}                                                       [jar]`);
  out('[INFO] ');
  const results = [];
  for (const [i, m] of mods.entries()) {
    out(`[INFO] --------------------------< com.demo:${m} >--------------------------`);
    out(`[INFO] Building demo-${m} 1.0-SNAPSHOT [${i + 1}/${mods.length}]`);
    out('[INFO] --- maven-compiler-plugin:3.13.0:compile (default-compile) ---');
    await sleep(700);
    out('[INFO] --- maven-surefire-plugin:3.2.5:test (default-test) ---');
    out('[INFO] ');
    out('[INFO] -------------------------------------------------------');
    out('[INFO]  T E S T S');
    out('[INFO] -------------------------------------------------------');
    let modFailed = false;
    for (const cls of MODULES[m]) {
      const fq = `com.demo.${m}.${cls}`;
      out(`[INFO] Running ${fq}`);
      await sleep(900 + (cls.length % 5) * 400);
      const fail = fails[`${m}.${cls}`];
      const count = tests(cls);
      const secs = (0.4 + (cls.length % 7) * 0.3).toFixed(3);
      const reports = path.join(dir, m, 'target', 'surefire-reports');
      fs.mkdirSync(reports, { recursive: true });
      const cases = Array.from({ length: count }, (_, k) => (fail && k === 0 ? fail[0] : `case${k + 1}`));
      const stack = fail && [
        `org.opentest4j.AssertionFailedError: ${fail[1]}`,
        '\tat org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)',
        '\tat org.junit.jupiter.api.AssertEquals.failNotEqual(AssertEquals.java:197)',
        '\tat org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:150)',
        `\tat ${fq}.${fail[0]}(${cls}.java:${40 + cls.length})`,
        `\tat com.demo.${m}.support.Fixtures.run(Fixtures.java:23)`,
        '\tat java.base/java.lang.reflect.Method.invoke(Method.java:580)',
        '\tat org.junit.platform.engine.support.hierarchical.ThrowableCollector.execute(ThrowableCollector.java:73)',
        '\tat org.apache.maven.surefire.booter.ForkedBooter.main(ForkedBooter.java:495)',
      ];
      fs.writeFileSync(
        path.join(reports, `TEST-${fq}.xml`),
        `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${fq}" time="${secs}" tests="${count}" errors="0" skipped="0" failures="${fail ? 1 : 0}">\n` +
          cases.map((c) => `  <testcase name="${c}" classname="${fq}" time="0.05"${fail && c === fail[0] ? `>\n    <failure message="${xml(fail[1])}" type="org.opentest4j.AssertionFailedError"><![CDATA[${stack.join('\n')}\n]]></failure>\n  </testcase>` : '/>'}`).join('\n') +
          '\n</testsuite>\n',
      );
      out(`[${fail ? 'ERROR' : 'INFO'}] Tests run: ${count}, Failures: ${fail ? 1 : 0}, Errors: 0, Skipped: 0, Time elapsed: ${secs} s${fail ? ' <<< FAILURE!' : ''} - in ${fq}`);
      if (fail) {
        out(`[ERROR] ${fq}.${fail[0]}  Time elapsed: 0.05 s  <<< FAILURE!`);
        for (const l of stack) out(l);
        out('');
        modFailed = true;
      }
    }
    results.push([m, modFailed ? 'FAILURE' : 'SUCCESS']);
  }
  const failed = Object.entries(fails);
  if (failed.length) {
    out('[INFO] Results:');
    out('[ERROR] Failures: ');
    for (const [k, [name, msg]] of failed) out(`[ERROR]   ${k.split('.')[1]}.${name}:${40 + k.split('.')[1].length} ${msg}`);
  }
  out('[INFO] ------------------------------------------------------------------------');
  out('[INFO] Reactor Summary for demo 1.0-SNAPSHOT:');
  for (const [m, r] of results) out(`[INFO] demo-${m} ${'.'.repeat(Math.max(3, 40 - m.length))} ${r}`);
  out('[INFO] ------------------------------------------------------------------------');
  out(failed.length ? '[INFO] BUILD FAILURE' : '[INFO] BUILD SUCCESS');
  out(`[INFO] Total time:  ${Math.round((Date.now() - t0) / 1000)} s`);
  observer.end({ id, exit: failed.length ? 1 : 0, durationMs: Date.now() - t0 });
  return !failed.length;
}

// ---- play the agent
process.env.ATF_DIR = root;
process.env.ATF_PLAN = plan;
process.env.ATF_ACTOR = 'backend';
const { createObserver } = await import(path.join(REPO, 'src', 'live-observer.mjs'));
const observer = createObserver({ root, plan, actor: 'backend' });
console.log(`project ${dir} · plan ${plan} · task T1 (agent "backend")`);
console.log('board: ⏎ on the plan, T1 selected, L for the live view · ctrl+c stops');
for (let n = 0; ; n++) {
  console.log(`build ${n + 1}: running …`);
  const ok = await build(n, observer);
  console.log(`build ${n + 1}: ${ok ? 'BUILD SUCCESS' : 'BUILD FAILURE'}`);
  if (once) break;
  await sleep(8000);
}
process.exit(0);
