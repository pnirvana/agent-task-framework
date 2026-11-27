#!/usr/bin/env node
// A demo of every built-in live view (SPEC §14): a project with one task per kind, and a
// team of simulated agents running builds, tests, a CI pipeline watch, a deployment, a
// health-check loop, a command waiting for approval and an app with a live log, over and
// over (some runs fail, the next ones pass).
//
//   node examples/live-views.mjs [dir]      (default: ~/Dev/atf-live-views; --once: one round)
//
// Nothing is really built or deployed. The agents' commands are reported through the same
// observer the harness hooks use (src/live-observer.mjs): classified by their command line,
// their output written as it would print, summarized, viewed and recorded as for a real
// agent. ctrl+c stops it (the runs in progress then end with the agents' process).
//
// Watch it in the web UI (atf-web: the project's plan, Tasks, ⏎ or L on a task) or on the
// herdr board (L on a task).
//
//   T1 backend    mvn -B verify                     maven: modules, test classes, a failing
//                                                   test with its stack trace (surefire reports)
//   T2 frontend   npm test                          tests: jest totals, the failing test
//   T3 release    glab ci status --live             pipeline: waits; jobs running → success
//   T4 ops        helm upgrade … && kubectl rollout status …   deploy: rolling out → deployed
//   T5 qa         until curl -sf …/health; do sleep 5; done    wait: a polling loop
//   T6 android    ./gradlew build                   build: a log, warnings counted
//   T7 dba        ./scripts/migrate.sh --env staging   waits for your approval, then runs
//   T8 app        ./run-app.sh > app.log 2>&1 &     a live log file: errors and warnings
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATF = path.join(REPO, 'bin', 'atf.mjs');
const args = process.argv.slice(2);
const once = args.includes('--once');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(os.homedir(), 'Dev', 'atf-live-views'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.7 + Math.random() * 0.6);
let stopping = false;

// ---------------------------------------------------------------- the project
const TEAM = [
  ['T1', 'backend', 'Backend: build and test', 'mvn -B verify passes'],
  ['T2', 'frontend', 'Frontend: unit tests', 'npm test passes'],
  ['T3', 'release', 'Watch the release pipeline', 'the pipeline is green'],
  ['T4', 'ops', 'Deploy to staging', 'shop runs in staging'],
  ['T5', 'qa', 'Wait until staging is healthy', '/health answers'],
  ['T6', 'android', 'Android app: build', './gradlew build passes'],
  ['T7', 'dba', 'Migrate the staging database', 'the migration ran (needs your approval)'],
  ['T8', 'app', 'Smoke-test the app', 'app.log has no errors after a while'],
];
fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env, ATF_DIR: '', ATF_PLAN: '', ATF_ACTOR: 'lead', ATF_ROLE: 'coordinator', ATF_BACKEND: '', HERDR_ENV: '' };
const atf = (a, extra = {}) => JSON.parse(execFileSync(process.execPath, [ATF, ...a, '--json'], { cwd: dir, env: { ...env, ...extra } }).toString());
if (!fs.existsSync(path.join(dir, '.git'))) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.atf/\napp.log\n*/target/\nbuild/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# ATF live views demo\n\nRun `node <atf>/examples/live-views.mjs` to play the agents.\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'live views demo'], { cwd: dir });
}
let root = path.join(dir, '.atf');
if (!fs.existsSync(path.join(root, 'plans'))) {
  root = atf(['init']).root;
  atf(['projects', 'add', dir]);
}
let plan = atf(['plan', 'list']).find((p) => p.title === 'Live views' && p.status === 'active')?.id;
if (!plan) {
  plan = atf(['plan', 'new', 'Live views', '--coordinator', 'lead', '--goal', 'Every live view at work: builds, tests, a pipeline, a deployment, a wait, an approval, a live log']).plan;
  for (const [, who, title, accept] of TEAM) atf(['add', title, '--assign', who, '--accept', accept], { ATF_PLAN: plan });
}
// every agent has its task in progress (the observer attributes commands to it)
for (const [id, who] of TEAM) {
  try {
    atf(['start', id], { ATF_PLAN: plan, ATF_ACTOR: who, ATF_ROLE: 'subagent' });
  } catch {} // already in progress
}

process.env.ATF_DIR = root;
process.env.ATF_PLAN = plan;
const { createObserver } = await import(path.join(REPO, 'src', 'live-observer.mjs'));
const observers = new Map(TEAM.map(([, who]) => [who, createObserver({ root, plan, actor: who })]));

/** One command of an agent: started, printed line by line, ended with `exit`. */
async function command(who, cmd, play) {
  const obs = observers.get(who);
  const id = `${who}-${Date.now()}`;
  await obs.start({ id, cmd, cwd: dir });
  const t0 = Date.now();
  const out = (line) => obs.output({ id, text: line + '\n', append: true });
  let exit = 0;
  try {
    exit = (await play(out, { id, obs })) ?? 0;
  } finally {
    obs.end({ id, exit, durationMs: Date.now() - t0 });
  }
  return exit;
}

// ---------------------------------------------------------------- T1 maven
const MODULES = {
  core: ['MoneyTest', 'RoundingTest', 'CurrencyTest'],
  model: ['OrderTest', 'CustomerTest'],
  persistence: ['OrderRepositoryIT', 'MigrationIT'],
  api: ['OrderControllerTest', 'PaymentControllerTest', 'RefundTest'],
  web: ['CheckoutPageTest'],
  app: ['ApplicationIT'],
};
const MAVEN_FAILS = [
  { 'api.RefundTest': ['refundTwice', 'expected: <409> but was: <500>'], 'persistence.MigrationIT': ['v42AddsIndex', 'Index idx_order_customer not found'] },
  { 'api.RefundTest': ['refundTwice', 'expected: <409> but was: <500>'] },
  {},
];
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const maven = (n) =>
  command('backend', 'mvn -B verify', async (out) => {
    const fails = MAVEN_FAILS[n % MAVEN_FAILS.length];
    const t0 = Date.now();
    const mods = Object.keys(MODULES);
    out('[INFO] Scanning for projects...');
    out('[INFO] Reactor Build Order:');
    out('[INFO] ');
    for (const m of mods) out(`[INFO] shop-${m}                                                       [jar]`);
    out('[INFO] ');
    const results = [];
    for (const [i, m] of mods.entries()) {
      out(`[INFO] --------------------------< com.shop:${m} >--------------------------`);
      out(`[INFO] Building shop-${m} 1.0-SNAPSHOT [${i + 1}/${mods.length}]`);
      out('[INFO] --- maven-compiler-plugin:3.13.0:compile (default-compile) ---');
      await sleep(jitter(800));
      out('[INFO] --- maven-surefire-plugin:3.2.5:test (default-test) ---');
      out('[INFO]  T E S T S');
      let modFailed = false;
      for (const cls of MODULES[m]) {
        const fq = `com.shop.${m}.${cls}`;
        out(`[INFO] Running ${fq}`);
        await sleep(jitter(1500 + (cls.length % 5) * 500));
        const fail = fails[`${m}.${cls}`];
        const count = 3 + (cls.length % 9);
        const secs = (0.4 + (cls.length % 7) * 0.3).toFixed(3);
        const reports = path.join(dir, m, 'target', 'surefire-reports');
        fs.mkdirSync(reports, { recursive: true });
        const cases = Array.from({ length: count }, (_, k) => (fail && k === 0 ? fail[0] : `case${k + 1}`));
        const stack = fail && [
          `org.opentest4j.AssertionFailedError: ${fail[1]}`,
          '\tat org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)',
          '\tat org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:150)',
          `\tat ${fq}.${fail[0]}(${cls}.java:${40 + cls.length})`,
          `\tat com.shop.${m}.support.Fixtures.run(Fixtures.java:23)`,
          '\tat java.base/java.lang.reflect.Method.invoke(Method.java:580)',
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
    out('[INFO] Reactor Summary for shop 1.0-SNAPSHOT:');
    for (const [m, r] of results) out(`[INFO] shop-${m} ${'.'.repeat(Math.max(3, 40 - m.length))} ${r}`);
    out(failed.length ? '[INFO] BUILD FAILURE' : '[INFO] BUILD SUCCESS');
    out(`[INFO] Total time:  ${Math.round((Date.now() - t0) / 1000)} s`);
    return failed.length ? 1 : 0;
  });

// ---------------------------------------------------------------- T2 tests (jest)
const SUITES = ['cart', 'checkout', 'coupon', 'price', 'search', 'account', 'address', 'payment'];
const npmTest = (n) =>
  command('frontend', 'npm test', async (out) => {
    const failing = n % 2 === 0 ? 'coupon' : null;
    out('> shop-web@2.4.0 test');
    out('> jest --ci');
    out('');
    let total = 0;
    for (const s of SUITES) {
      await sleep(jitter(1800));
      const k = 4 + (s.length % 5);
      total += k;
      if (s === failing) {
        out(`FAIL src/${s}/${s}.test.ts`);
        out(`  ● ${s} › applies a 10% coupon to the cart total`);
        out('');
        out('    expect(received).toBe(expected) // Object.is equality');
        out('    Expected: 8910');
        out('    Received: 9900');
        out('');
        out(`  ✕ applies a 10% coupon to the cart total (14 ms)`);
      } else out(`PASS src/${s}/${s}.test.ts (${(0.8 + s.length / 10).toFixed(2)} s)`);
    }
    out('');
    out(`Test Suites: ${failing ? '1 failed, ' : ''}${SUITES.length - (failing ? 1 : 0)} passed, ${SUITES.length} total`);
    out(`Tests:       ${failing ? '1 failed, ' : ''}${total - (failing ? 1 : 0)} passed, ${total} total`);
    out('Time:        14.2 s');
    return failing ? 1 : 0;
  });

// ---------------------------------------------------------------- T3 pipeline watch
const JOBS = [
  ['build', 'compile'],
  ['build', 'lint'],
  ['test', 'unit'],
  ['test', 'integration'],
  ['deploy', 'staging'],
];
const pipeline = (n) => {
  const id = 48210 + n;
  return command('release', 'glab ci status --live --branch main', async (out) => {
    const url = `https://gitlab.example.com/shop/shop/-/pipelines/${id}`;
    const state = Object.fromEntries(JOBS.map(([, j]) => [j, 'created']));
    const failJob = n % 3 === 1 ? 'integration' : null;
    // as glab ci status prints it: the jobs, then the pipeline and its state
    const show = (status) => {
      for (const [stage, j] of JOBS) out(`(${state[j]}) • ${stage.padEnd(7)} ${j}`);
      out('');
      out(url);
      out(`SHA: 3f9c2e1 · Pipeline #${id}`);
      out(`Pipeline State: ${status}`);
      out('');
    };
    show('pending');
    for (const [, j] of JOBS) {
      state[j] = 'running';
      await sleep(jitter(6000));
      show('running');
      await sleep(jitter(6000));
      if (j === failJob) {
        state[j] = 'failed';
        for (const [, k] of JOBS) if (state[k] === 'created') state[k] = 'skipped';
        show('failed');
        return 1;
      }
      state[j] = 'success';
    }
    show('success');
    return 0;
  });
};

// ---------------------------------------------------------------- T4 deploy
const deploy = (n) =>
  command('ops', 'helm upgrade --install shop ./chart -n staging --wait && kubectl rollout status deployment/shop -n staging', async (out) => {
    out('Release "shop" has been upgraded. Happy Helming!');
    out('NAME: shop');
    out('LAST DEPLOYED: ' + new Date().toUTCString());
    out('NAMESPACE: staging');
    out(`REVISION: ${17 + n}`);
    await sleep(jitter(4000));
    const broken = n % 3 === 2;
    for (let i = 0; i < 3; i++) {
      out(`Waiting for deployment "shop" rollout to finish: ${i} of 3 updated replicas are available...`);
      await sleep(jitter(5000));
      if (broken && i === 1) {
        out('error: deployment "shop" exceeded its progress deadline');
        return 1;
      }
    }
    out('STATUS: deployed');
    out('deployment "shop" successfully rolled out');
    return 0;
  });

// ---------------------------------------------------------------- T5 wait loop
const waitHealthy = () =>
  command('qa', 'until curl -sf https://staging.shop.example/health; do echo "not up yet"; sleep 5; done; echo healthy', async (out) => {
    const tries = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < tries; i++) {
      out('curl: (7) Failed to connect to staging.shop.example port 443: Connection refused');
      out('not up yet');
      await sleep(5000);
    }
    out('{"status":"UP","checks":{"db":"UP","payments":"UP"}}');
    out('healthy');
    return 0;
  });

// ---------------------------------------------------------------- T6 gradle build
const TASKS = ['preBuild', 'compileDebugKotlin', 'compileDebugJavaWithJavac', 'mergeDebugResources', 'processDebugManifest', 'lintDebug', 'testDebugUnitTest', 'assembleDebug'];
const gradle = (n) =>
  command('android', './gradlew build', async (out) => {
    out('Starting a Gradle Daemon (subsequent builds will be faster)');
    for (const t of TASKS) {
      out(`> Task :app:${t}`);
      if (t === 'compileDebugKotlin') out("w: file:///app/src/main/kotlin/shop/Cart.kt:42:13 'formatPrice(Double): String' is deprecated. Use Money.format()");
      if (t === 'lintDebug') out('WARNING: Lint found 3 warnings (see build/reports/lint-results-debug.html)');
      await sleep(jitter(2500));
    }
    if (n % 4 === 3) {
      out('');
      out('FAILURE: Build failed with an exception.');
      out("* What went wrong: Execution failed for task ':app:testDebugUnitTest'.");
      out('> There were failing tests. See the report at: file:///app/build/reports/tests/testDebugUnitTest/index.html');
      out('BUILD FAILED in 24s');
      return 1;
    }
    out('');
    out(`BUILD SUCCESSFUL in ${20 + (n % 7)}s`);
    out('42 actionable tasks: 42 executed');
    return 0;
  });

// ---------------------------------------------------------------- T7 approval
const migrate = () =>
  command('dba', './scripts/migrate.sh --env staging', async (out, { id, obs }) => {
    // the harness asks the human first (Copilot, opencode): the board says it waits for you
    obs.approval({ id, waiting: true });
    await sleep(45_000);
    obs.approval({ id, waiting: false });
    out('Connecting to staging-db.internal:5432 …');
    for (const v of ['V41__orders_currency', 'V42__order_customer_index', 'V43__refunds']) {
      await sleep(jitter(3000));
      out(`Migrating schema "shop" to version ${v.replace('__', ' - ').replace(/_/g, ' ')}`);
    }
    out('Successfully applied 3 migrations to schema "shop" (execution time 00:07.412s)');
    return 0;
  });

// ---------------------------------------------------------------- T8 live log
const appLog = async () => {
  const log = path.join(dir, 'app.log');
  fs.writeFileSync(log, '');
  // the hook registers what a command writes in the background as a live log
  await command('app', './run-app.sh > app.log 2>&1 &', async (out) => {
    out('[1] 4242');
    return 0;
  });
  const t = () => new Date().toISOString();
  const LINES = [
    () => `${t()} INFO  shop.Application  Started Application in 3.4 seconds`,
    () => `${t()} INFO  shop.web.Health   GET /health 200 2ms`,
    () => `${t()} INFO  shop.web.Orders   POST /api/v1/orders 201 41ms`,
    () => `${t()} WARN  shop.db.Pool      slow query (812 ms): SELECT * FROM orders WHERE customer_id = ?`,
    () => `${t()} INFO  shop.web.Health   GET /health 200 1ms`,
    () => `${t()} ERROR shop.pay.Stripe   payment failed: card_declined (order 1187)`,
    () => `${t()} INFO  shop.web.Orders   GET /api/v1/orders/1187 200 9ms`,
  ];
  for (let i = 0; !stopping; i++) {
    fs.appendFileSync(log, LINES[i % LINES.length]() + '\n');
    await sleep(jitter(2500));
    if (i > 2000) i = 0;
  }
};

// ---------------------------------------------------------------- the team at work
/** An agent repeating its command: one run, a pause, the next run (n counts them). */
async function agent(name, run, pause) {
  for (let n = 0; !stopping; n++) {
    const exit = await run(n);
    console.log(`${new Date().toLocaleTimeString()} ${name.padEnd(9)} run ${n + 1}: ${exit ? 'failed' : 'ok'}`);
    if (once) return;
    await sleep(jitter(pause));
  }
}
console.log(`project ${dir}\nplan ${plan} "Live views": T1-T8, one agent each · ctrl+c stops`);
console.log('web UI: the plan, Tasks, ⏎ (or L) on a task · herdr board: L on a task');
process.on('SIGINT', () => {
  stopping = true;
  for (const o of observers.values()) o.shutdown();
  process.exit(0);
});
const staggered = (ms, f) => sleep(ms).then(f);
await Promise.all([
  agent('backend', maven, 15_000),
  staggered(2000, () => agent('frontend', npmTest, 12_000)),
  staggered(4000, () => agent('release', pipeline, 20_000)),
  staggered(6000, () => agent('ops', deploy, 25_000)),
  staggered(8000, () => agent('qa', waitHealthy, 30_000)),
  staggered(10_000, () => agent('android', gradle, 15_000)),
  staggered(3000, () => agent('dba', migrate, 40_000)),
  once ? staggered(1000, async () => {
    const p = appLog();
    await sleep(30_000);
    stopping = true;
    await p;
  }) : staggered(1000, appLog),
]);
for (const o of observers.values()) o.shutdown();
process.exit(0);
