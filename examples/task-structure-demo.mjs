#!/usr/bin/env node
// A demo of planned tasks, attempts, steps and deploy runs (docs/task-structure-design.md).
//
//   node examples/task-structure-demo.mjs [dir]   (default: ~/atf-task-demo; --fresh: start over)
//
// One plan, "Idempotent refunds", in the middle of its work (ids follow the outline):
//   T1    Design                         done (a plain task)
//   T2    Implement idempotency          a planned task: parallel slices, all done; it went
//                                        to review by itself and the coordinator approved it
//     T2.4  contract test for the header   added late (after T6), still numbered under T2
//   T3    Deploy to staging              a planned task: a sequence of slices
//     T3.1  build images                   done
//     T3.2  deploy the four services       attempt 2 (attempt 1 failed: kubectl apply, no
//                                          helm), steps 2/4, deploy runs from the live hook
//     T3.3  smoke test staging             waits on T3.2
//   T4    Migrate the refund table       a planned task whose slices are done: in review, for you
//   T5    Update the API docs            a plain task, ready
//   T6    Observability                  a planned task: two parallel slices in progress
//
// Look at it on the board (atf-herdr board, or `atf board` / the herdr pane): 1 Tasks.
// Planned tasks start folded (→ / space unfolds them); ⏎ on T3.2 shows its attempts and
// steps, L its deploy runs. In the shell: atf show T3.2, atf show T4, atf status.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATF = path.join(REPO, 'bin', 'atf.mjs');
const args = process.argv.slice(2);
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(os.homedir(), 'atf-task-demo'));
if (args.includes('--fresh')) fs.rmSync(dir, { recursive: true, force: true });
if (fs.existsSync(path.join(dir, '.atf'))) {
  console.log(`${dir} exists already (--fresh starts over)`);
  process.exit(0);
}
fs.mkdirSync(dir, { recursive: true });

const env = { ...process.env, ATF_DIR: '', ATF_PLAN: '', ATF_ROLE: '' };
const atf = (actor, a, role = actor === 'lead' ? '' : 'subagent') =>
  JSON.parse(execFileSync('node', [ATF, ...a, '--json'], { cwd: dir, env: { ...env, ATF_ACTOR: actor, ATF_ROLE: role } }).toString() || 'null');
const work = (actor, id, result) => {
  atf(actor, ['start', id]);
  if (result) atf(actor, ['done', id, '-m', result]);
};

// ---- the plan
atf('lead', ['init']);
atf('lead', ['projects', 'add', dir]);
const plan = atf('lead', ['plan', 'new', 'Idempotent refunds', '--goal', 'A refund is charged once, however often it is sent']).plan;

atf('lead', ['add', 'Design', '--accept', 'docs/refunds.md: the key, where it is stored, for how long']); // T1
atf('lead', ['add', 'Implement idempotency', '--dep', 'T1', '--accept', 'a repeated refund with the same Idempotency-Key returns the first answer, end to end']); // T2
atf('lead', ['add', 'refund-service: idempotency store', '--parent', 'T2', '--assign', 'refunds']); // T2.1
atf('lead', ['add', 'gateway: forward Idempotency-Key', '--parent', 'T2', '--assign', 'gateway']); // T2.2
atf('lead', ['add', 'ledger: dedupe by key', '--parent', 'T2', '--assign', 'ledger']); // T2.3
atf('lead', ['add', 'Deploy to staging', '--dep', 'T2', '--accept', 'all four services run the new version on staging', '--accept', 'smoke test green']); // T3
atf('lead', ['add', 'build images', '--parent', 'T3', '--assign', 'builder']); // T3.1
atf('lead', ['add', 'deploy the four services', '--parent', 'T3', '--dep', 'T3.1', '--assign', 'deployer']); // T3.2
atf('lead', ['add', 'smoke test staging', '--parent', 'T3', '--dep', 'T3.2']); // T3.3
atf('lead', ['add', 'Migrate the refund table', '--reviewer', 'human', '--accept', 'the key column exists in every environment, old rows untouched']); // T4
atf('lead', ['add', 'write the migration', '--parent', 'T4', '--assign', 'db']); // T4.1
atf('lead', ['add', 'run it on staging', '--parent', 'T4', '--dep', 'T4.1', '--assign', 'db']); // T4.2
atf('lead', ['add', 'Update the API docs', '--dep', 'T2']); // T5
atf('lead', ['add', 'Observability', '--accept', 'a dashboard and alerts for repeated refunds']); // T6
atf('lead', ['add', 'refund dashboard', '--parent', 'T6', '--assign', 'obs-1']); // T6.1
atf('lead', ['add', 'alerts on duplicate keys', '--parent', 'T6', '--assign', 'obs-2']); // T6.2

// ---- T1 done; T2's slices done, plus one the coordinator added late (T2.4, not T17):
// T2 goes to review by itself when the last one is done, and the coordinator approves
work('designer', 'T1', 'docs/refunds.md: key from the Idempotency-Key header, kept 24 h in Redis');
work('refunds', 'T2.1', 'store with a 24 h TTL, tests green');
work('gateway', 'T2.2', 'header forwarded to refund-service and ledger');
work('ledger', 'T2.3', 'dedupe by key, consumer wired');
atf('lead', ['add', 'contract test for the header', '--parent', 'T2', '--assign', 'gateway']); // T2.4
work('gateway', 'T2.4', 'consumer-driven contract test: gateway → refund-service, header required');
atf('lead', ['done', 'T2', '-m', 'approved: e2e test, a repeated refund returns the first answer']);

// ---- T6: two slices in progress at the same time
atf('obs-1', ['start', 'T6.1']);
atf('obs-1', ['progress', 'T6.1', 'panels for refunds per key, p95 latency', '--pct', '50']);
atf('obs-2', ['start', 'T6.2']);

// ---- T4: both slices done, so the planned task is in review, for the human
work('db', 'T4.1', 'V42__refund_key.sql, tested against a copy of prod');
work('db', 'T4.2', 'applied on staging, 1.2 M rows, 40 s');

// ---- T3: images built; T3.2 attempt 1 fails, attempt 2 deploys with steps
work('builder', 'T3.1', 'images 1.4.0 pushed for gateway, refund-service, ledger, fx');

const { createObserver } = await import(path.join(REPO, 'src', 'live-observer.mjs'));
const root = path.join(dir, '.atf');
let n = 0;
async function run(actor, cmd, output, exit) {
  const obs = createObserver({ root, plan, actor });
  const id = `demo-${++n}`;
  await obs.start({ id, cmd, cwd: dir });
  obs.output({ id, text: output });
  obs.end({ id, exit, durationMs: 40_000 + n * 7_000 });
}

atf('deployer', ['start', 'T3.2']);
await run('deployer', 'kubectl apply -f k8s/', 'error: unable to recognize "k8s/Chart.yaml": no matches for kind "" in version ""\n', 1);
atf('deployer', ['note', 'T3.2', '--kind', 'checkpoint', 'nothing deployed: k8s/ holds helm charts, not manifests. Left: nothing to clean up.']);
atf('deployer', ['fail', 'T3.2', '-m', 'kubectl apply cannot deploy the charts in k8s/: they are helm charts']);
atf('lead', ['changes', 'T3.2', '-m', '1. deploy each service with helm upgrade --install <svc> charts/<svc> -n staging --wait 2. one at a time: gateway, refund-service, ledger, fx', '--fresh']);
atf('lead', ['assign', 'T3.2', 'deployer-2']);

atf('deployer-2', ['start', 'T3.2']);
atf('deployer-2', ['steps', 'T3.2', 'deploy gateway', 'deploy refund-service', 'deploy ledger', 'deploy fx']);
await run('deployer-2', 'helm upgrade --install gateway charts/gateway -n staging --wait', 'Release "gateway" has been upgraded. Happy Helming!\nNAME: gateway\nSTATUS: deployed\nREVISION: 14\n', 0);
atf('deployer-2', ['step', 'T3.2', '1']);
await run('deployer-2', 'helm upgrade --install refund-service charts/refund-service -n staging --wait', 'Release "refund-service" has been upgraded. Happy Helming!\nSTATUS: deployed\n', 0);
atf('deployer-2', ['step', 'T3.2', '2']);
await run('deployer-2', 'kubectl rollout status deployment/ledger -n staging --timeout=120s', 'Waiting for deployment "ledger" rollout to finish: 1 of 2 updated replicas are available...\nerror: deployment "ledger" exceeded its progress deadline\n', 1);
atf('deployer-2', ['step', 'T3.2', '3', 'start', '-m', 'first rollout timed out: a readiness probe on /health/ready, retrying with more time']);

console.log(`task-structure demo in ${dir}: plan "Idempotent refunds", mid-way`);
console.log(`look at it: the board (1 Tasks), or cd ${dir} && atf status / atf show T3.2 / atf show T4`);
