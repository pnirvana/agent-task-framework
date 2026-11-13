import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fold, rollupStatus, findCycles } from '../src/core.mjs';

const ATF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'atf.mjs');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-test-'));
  const env = { ...process.env, ATF_DIR: '', ATF_PLAN: '', ATF_ACTOR: 'lead', ATF_ROLE: 'coordinator', NO_COLOR: '1', ATF_REGISTRY: path.join(dir, 'registry.json') };
  delete env.HERDR_PANE_ID;
  const run = (args, extraEnv = {}) =>
    JSON.parse(execFileSync('node', [ATF, ...args, '--json'], { cwd: dir, env: { ...env, ...extraEnv } }).toString());
  const runFail = (args, extraEnv = {}) => {
    try {
      execFileSync('node', [ATF, ...args, '--json'], { cwd: dir, env: { ...env, ...extraEnv }, stdio: 'pipe' });
    } catch (e) {
      return JSON.parse(e.stdout.toString());
    }
    throw new Error('expected failure: ' + args.join(' '));
  };
  run(['init']);
  run(['plan', 'new', 'Test plan']);
  return { dir, env, run, runFail };
}

const ev = (seq, type, task, data, actor = 'a') => ({ v: 1, seq, ts: `2026-01-01T00:00:0${seq % 10}Z`, plan: 'p', type, task, actor: { id: actor }, data });

test('fold: lifecycle, readiness, rollup', () => {
  const s = fold([
    ev(1, 'plan.created', undefined, { title: 'P' }),
    ev(2, 'task.created', 'T1', { title: 'a' }),
    ev(3, 'task.created', 'T2', { title: 'parent' }),
    ev(4, 'task.created', 'T3', { title: 'c1', parent: 'T2', deps: ['T1'] }),
    ev(5, 'task.created', 'T4', { title: 'c2', parent: 'T2' }),
    ev(6, 'task.created', 'T5', { title: 'after parent', deps: ['T2'] }),
    ev(7, 'task.status', 'T1', { status: 'in_progress' }),
    ev(8, 'task.progress', 'T1', { percent: 50, message: 'half' }),
  ]);
  assert.equal(s.title, 'P');
  assert.equal(s.tasks.T1.percent, 50);
  assert.equal(s.tasks.T3.ready, false);
  assert.deepEqual(s.tasks.T3.waiting_on, ['T1']);
  assert.equal(s.tasks.T4.ready, true);
  assert.equal(s.tasks.T2.ready, false, 'parents are never ready');
  assert.equal(s.tasks.T2.rollup_status, 'todo');
  assert.equal(s.total, 5);
  assert.equal(s.counts.todo, 3, 'counts are over leaves');

  const s2 = fold([
    ev(1, 'plan.created', undefined, { title: 'P' }),
    ev(2, 'task.created', 'T1', { title: 'a' }),
    ev(3, 'task.created', 'T2', { title: 'parent' }),
    ev(4, 'task.created', 'T3', { title: 'c1', parent: 'T2' }),
    ev(5, 'task.created', 'T4', { title: 'c2', parent: 'T2' }),
    ev(6, 'task.created', 'T5', { title: 'after', deps: ['T2'] }),
    ev(7, 'task.status', 'T3', { status: 'done', message: 'ok' }),
    ev(8, 'task.status', 'T4', { status: 'cancelled' }),
  ]);
  assert.equal(s2.tasks.T2.rollup_status, 'done');
  assert.equal(s2.tasks.T5.ready, true, 'dep on a finished parent is satisfied');
  assert.equal(s2.tasks.T3.result, 'ok');
});

test('fold is lenient: unknown types and tasks', () => {
  const s = fold([
    ev(1, 'plan.created', undefined, { title: 'P' }),
    ev(2, 'x.vendor.thing', undefined, {}),
    ev(3, 'task.status', 'T9', { status: 'done' }),
    { garbage: true },
  ]);
  assert.equal(s.order.length, 0);
  assert.equal(s.warnings.length, 1);
});

test('rollupStatus', () => {
  assert.equal(rollupStatus(['done', 'todo']), 'in_progress');
  assert.equal(rollupStatus(['blocked', 'in_progress']), 'blocked');
  assert.equal(rollupStatus(['done', 'review']), 'review');
  assert.equal(rollupStatus(['todo', 'todo']), 'todo');
});

test('findCycles', () => {
  const s = fold([
    ev(1, 'task.created', 'A', { deps: ['B'] }),
    ev(2, 'task.created', 'B', { deps: [] }),
    ev(3, 'task.updated', 'B', { deps: ['A'] }),
  ]);
  assert.equal(findCycles(s).length, 1);
});

test('cli: transitions, ownership, required messages', () => {
  const { run, runFail } = sandbox();
  run(['add', 'one']);
  run(['add', 'two', '--dep', 'T1']);
  assert.match(runFail(['start', 'T2']).error, /waits on T1/);
  run(['start', 'T1'], { ATF_ACTOR: 'w1', ATF_ROLE: 'subagent' });
  assert.match(runFail(['start', 'T3']).error, /unknown task/);
  assert.match(runFail(['done', 'T1'], { ATF_ACTOR: 'w1' }).error, /-m/);
  assert.match(runFail(['done', 'T1', '-m', 'x'], { ATF_ACTOR: 'w2', ATF_ROLE: 'subagent' }).error, /assigned to w1/);
  run(['done', 'T1', '-m', 'finished'], { ATF_ACTOR: 'w1', ATF_ROLE: 'subagent' });
  assert.match(runFail(['done', 'T1', '-m', 'again']).error, /cannot move/);
  const t2 = run(['next'], { ATF_ACTOR: 'w2', ATF_ROLE: 'subagent' }).task;
  assert.equal(t2.id, 'T2');
  assert.equal(t2.assignee, 'w2');
  assert.equal(run(['validate']).ok, true);
});

test('cli: concurrent `next` never double-claims', async () => {
  const { dir, env, run } = sandbox();
  for (let i = 0; i < 8; i++) run(['add', `task ${i}`]);
  const workers = Array.from({ length: 12 }, (_, i) =>
    new Promise((resolve, reject) => {
      const p = spawn('node', [ATF, 'next', '--json'], { cwd: dir, env: { ...env, ATF_ACTOR: `w${i}`, ATF_ROLE: 'subagent' } });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(out))));
    }),
  );
  const results = await Promise.all(workers);
  const claimed = results.map((r) => r.task?.id).filter(Boolean);
  assert.equal(claimed.length, 8);
  assert.equal(new Set(claimed).size, 8, 'each task claimed once');
  const state = run(['status']);
  assert.equal(state.counts.in_progress, 8);
  const seqs = fs.readFileSync(path.join(dir, '.atf', 'plans', state.id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq is gapless and ordered');
});

test('cli: wait returns on matching status change', async () => {
  const { dir, env, run } = sandbox();
  run(['add', 'one']);
  run(['start', 'T1']);
  const waiter = new Promise((resolve) => {
    const p = spawn('node', [ATF, 'wait', '--task', 'T1', '--timeout', '5000', '--json'], { cwd: dir, env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
  await new Promise((r) => setTimeout(r, 400));
  run(['block', 'T1', '-m', 'need input']);
  const { code, out } = await waiter;
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).events[0].data.status, 'blocked');
});

test('hooks: post_write hook runs detached with seq range env', async () => {
  const { dir, run } = sandbox();
  const outFile = path.join(dir, 'hook.out');
  const script = path.join(dir, 'hook.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(outFile)}, [process.env.ATF_PLAN, process.env.ATF_HOOK_FROM_SEQ, process.env.ATF_HOOK_TO_SEQ, process.env.ATF_HOOK_TYPES].join(' ') + '\\n');`);
  const cfgPath = path.join(dir, '.atf', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.hooks = { post_write: [[process.execPath, script], ['/nonexistent/binary']] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  run(['add', 'one']); // seq 2
  run(['start', 'T1']); // seq 3 (assigned) + 4 (status)
  // hooks run detached: poll (up to 5 s) instead of a fixed sleep, so a busy machine can't flake this
  let lines = [];
  for (let i = 0; i < 50 && lines.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 100));
    lines = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).sort() : [];
  }
  const plan = run(['status']).id;
  assert.deepEqual(lines, [`${plan} 2 2 task.created`, `${plan} 3 4 task.assigned,task.status`]);
});

test('fold: work package ownership is inherited down the subtree', () => {
  const s = fold([
    ev(1, 'task.created', 'T1', { title: 'Backend' }),
    ev(2, 'task.created', 'T2', { title: 'API', parent: 'T1' }),
    ev(3, 'task.created', 'T3', { title: 'Endpoint', parent: 'T2' }),
    ev(4, 'task.created', 'T4', { title: 'Carved out', parent: 'T1' }),
    ev(5, 'task.assigned', 'T1', { assignee: 'backend' }),
    ev(6, 'task.assigned', 'T4', { assignee: 'helper' }),
  ]);
  assert.equal(s.tasks.T3.owner, 'backend');
  assert.deepEqual(s.tasks.T3.path, ['T1', 'T2']);
  assert.equal(s.tasks.T4.owner, 'helper', 'explicit assignee overrides the package');
  assert.deepEqual(s.actors.backend.packages, ['T1']);
  assert.deepEqual(s.actors.backend.owned, ['T3']);
  assert.ok(s.actors.backend.inferred, 'assignee without own events is still listed');
});

test('cli: next stays inside work packages; others cannot take package tasks', () => {
  const { run, runFail } = sandbox();
  run(['add', 'Backend']); // T1
  run(['add', 'a', '--parent', 'T1']); // T2
  run(['add', 'b', '--parent', 'T1']); // T3
  run(['add', 'loose task']); // T4 (unowned)
  run(['assign', 'T1', 'backend']);
  const sub = (who) => ({ ATF_ACTOR: who, ATF_ROLE: 'subagent' });
  assert.match(runFail(['start', 'T2'], sub('frontend')).error, /work package owned by backend/);
  assert.equal(run(['next'], sub('frontend')).task.id, 'T4', 'others only get unowned work');
  assert.equal(run(['next', '--package'], sub('backend')).task.id, 'T2');
  run(['done', 'T2', '-m', 'ok'], sub('backend'));
  assert.equal(run(['next', '--package'], sub('backend')).task.id, 'T3');
  run(['done', 'T3', '-m', 'ok'], sub('backend'));
  assert.equal(run(['next', '--package'], sub('backend')).task, null, '--package never leaves the package');
  assert.equal(run(['show', 'T1']).rollup_status, 'done');
});

test('wait: level-triggered, so a review that happened before waiting is not missed', () => {
  const { run } = sandbox();
  run(['add', 'pkg']);
  run(['add', 'a', '--parent', 'T1']);
  run(['add', 'b', '--parent', 'T1', '--dep', 'T2']);
  run(['assign', 'T1', 'fe']);
  const fe = { ATF_ACTOR: 'fe', ATF_ROLE: 'subagent' };
  run(['next', '--package'], fe);
  run(['review', 'T2', '-m', 'ready'], fe);
  // coordinator starts waiting only now: must return immediately with the review
  const r = run(['wait', '--timeout', '3000']);
  assert.deepEqual(r.attention, [{ task: 'T2', reason: 'review' }]);
  run(['done', 'T2', '-m', 'approved']);
  // the subagent's wait returns at once: T3 became ready
  assert.deepEqual(run(['wait', '--timeout', '3000'], fe).attention, [{ task: 'T3', reason: 'ready' }]);
});

test('block --on: dependency blocks resume when the other task is done', () => {
  const { run } = sandbox();
  run(['add', 'tests']); // T1
  run(['add', 'page']); // T2
  const be = { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' };
  run(['start', 'T1'], be);
  run(['block', 'T1', '-m', 'needs page', '--on', 'T2'], be);
  let t1 = run(['show', 'T1']);
  assert.deepEqual(t1.blocked_on, ['T2']);
  assert.equal(t1.can_resume, false);
  run(['start', 'T2']);
  run(['done', 'T2', '-m', 'ok']);
  t1 = run(['show', 'T1']);
  assert.equal(t1.can_resume, true);
  assert.deepEqual(run(['wait', '--timeout', '3000'], be).attention, [{ task: 'T1', reason: 'unblocked' }]);
  run(['start', 'T1'], be);
  assert.deepEqual(run(['show', 'T1']).blocked_on, []);
});

test('agent context: checkpoint, session refs, launchPlan, answered', () => {
  const { run } = sandbox();
  run(['add', 'tests']); // T1
  run(['add', 'page']); // T2
  run(['add', 'question']); // T3
  const be = { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' };
  assert.equal(run(['resume-info', 'T1']).mode, 'fresh', 'never started -> fresh');
  run(['start', 'T1'], be);
  run(['note', 'T1', 'done: x; left: y', '--kind', 'checkpoint'], be);
  run(['block', 'T1', '-m', 'needs page', '--on', 'T2'], be);
  assert.equal(run(['resume-info', 'T1']).mode, 'fresh', 'worked on but no session -> fresh (checkpoint)');
  run(['session', 'T1', '/s/be.jsonl', '--kind', 'pi', '--for', 'be']);
  let lp = run(['resume-info', 'T1']);
  assert.equal(lp.mode, 'resume');
  assert.equal(lp.session.ref, '/s/be.jsonl');
  assert.equal(lp.checkpoint.message, 'done: x; left: y');
  run(['edit', 'T1', '--resume', 'fresh']);
  assert.equal(run(['resume-info', 'T1']).mode, 'fresh', 'task policy overrides');
  run(['plan', 'update', '--resume', 'fresh']);
  run(['edit', 'T1', '--resume', 'auto']);
  assert.equal(run(['resume-info', 'T1']).mode, 'resume', 'task policy beats plan policy');
  // question-block answered by someone else -> attention 'answered'
  run(['start', 'T3'], be);
  run(['block', 'T3', '-m', 'redis or cookies?'], be);
  run(['note', 'T3', 'cookies', '--kind', 'decision']);
  assert.deepEqual(run(['wait', '--timeout', '2000'], be).attention, [{ task: 'T3', reason: 'answered' }]);
});

test('wait: ephemeral lifecycle tells an idle agent to end its turn', () => {
  const { run } = sandbox();
  run(['add', 'a']);
  run(['add', 'b']);
  const be = { ATF_ACTOR: 'be', ATF_ROLE: 'subagent', ATF_LIFECYCLE: 'ephemeral' };
  run(['start', 'T1'], be);
  run(['block', 'T1', '-m', 'needs b', '--on', 'T2'], be);
  const r = run(['wait', '--timeout', '3000'], be);
  assert.match(r.note, /end your turn/);
});

test('registry + plans/inbox across projects', () => {
  const a = sandbox();
  const b = sandbox();
  const reg = path.join(a.dir, 'registry.json');
  const inA = (args) => a.run(args, { ATF_REGISTRY: reg });
  const inB = (args, env = {}) => b.run(args, { ATF_REGISTRY: reg, ...env });
  inA(['projects', 'add']); // a was created before it shared the registry
  inB(['plan', 'new', 'Second plan']); // plan creation registers b
  inB(['add', 'x']);
  inB(['start', 'T1'], { ATF_ACTOR: 'w', ATF_ROLE: 'subagent' });
  inB(['review', 'T1', '-m', 'please check'], { ATF_ACTOR: 'w', ATF_ROLE: 'subagent' });
  inA(['add', 'y']);
  assert.equal(inA(['projects']).length, 2);
  const plans = inA(['plans', '--all']);
  assert.equal(plans.length, 3, 'two plans in b (Test plan + Second plan), one in a');
  const inbox = inA(['inbox', '--all']);
  assert.deepEqual(inbox.map((i) => [i.kind, i.task]), [['review', 'T1']]);
  fs.rmSync(b.dir, { recursive: true, force: true });
  assert.equal(inA(['projects']).length, 1, 'missing projects are pruned');
});

test('herdr layout: planRebuild recovers the split tree from pane rectangles', async () => {
  const { planRebuild } = await import('../adapters/herdr/lib/layout.mjs');
  const P = (id, x, y, w, h) => ({ pane_id: id, rect: { x, y, width: w, height: h } });
  // replay the steps on rectangles and check we get the original layout back
  const replay = (plan, area) => {
    const r = { [plan.anchor]: { ...area } };
    for (const s of plan.steps) {
      const t = r[s.target];
      if (s.dir === 'right') {
        const w = Math.round(t.w * s.ratio);
        r[s.pane] = { x: t.x + w, y: t.y, w: t.w - w, h: t.h };
        t.w = w;
      } else {
        const h = Math.round(t.h * s.ratio);
        r[s.pane] = { x: t.x, y: t.y + h, w: t.w, h: t.h - h };
        t.h = h;
      }
    }
    return r;
  };
  const layouts = [
    [P('c', 0, 0, 320, 41), P('a', 0, 41, 320, 40)],
    [P('1', 0, 0, 80, 41), P('4', 80, 0, 80, 41), P('3', 0, 41, 160, 40), P('2', 160, 0, 160, 81)],
    [P('1', 0, 0, 65, 19), P('2', 0, 19, 65, 19), P('3', 65, 0, 65, 19), P('4', 65, 19, 65, 19), P('5', 130, 0, 50, 38)],
  ];
  for (const panes of layouts) {
    const W = Math.max(...panes.map((p) => p.rect.x + p.rect.width));
    const H = Math.max(...panes.map((p) => p.rect.y + p.rect.height));
    const got = replay(planRebuild(panes), { x: 0, y: 0, w: W, h: H });
    for (const p of panes) assert.deepEqual(got[p.pane_id], { x: p.rect.x, y: p.rect.y, w: p.rect.width, h: p.rect.height }, `pane ${p.pane_id}`);
  }
  assert.throws(() => planRebuild([P('a', 0, 0, 10, 10), P('b', 5, 5, 10, 10)]), /clean split tree/);
});
