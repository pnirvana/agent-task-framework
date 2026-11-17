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
  // blocked --on another task is waiting, not a question: the package is still in progress
  assert.equal(rollupStatus([{ status: 'blocked', waiting: true }, { status: 'in_progress', waiting: false }]), 'in_progress');
  assert.equal(rollupStatus([{ status: 'blocked', waiting: true }, { status: 'todo', waiting: false }]), 'in_progress');
  assert.equal(rollupStatus([{ status: 'blocked', waiting: true }, { status: 'done', waiting: false }]), 'blocked', 'all that is left waits');
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
  // v2: fe exited after submitting; T3 became ready in its package, so the coordinator is
  // told to start an agent for it (a subagent's wait just tells it to finish)
  assert.deepEqual(run(['wait', '--timeout', '3000']).attention, [{ task: 'T3', reason: 'start' }]);
  assert.match(run(['wait', '--timeout', '3000'], fe).note, /subagents do not wait/);
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
  // the coordinator starts a new instance for it (be exited when it blocked)
  assert.deepEqual(run(['wait', '--timeout', '3000']).attention, [{ task: 'T1', reason: 'unblocked' }]);
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
  assert.equal(run(['resume-info', 'T1']).mode, 'fresh', 'v2 default: a new instance starts fresh');
  run(['plan', 'update', '--resume', 'auto']);
  let lp = run(['resume-info', 'T1']);
  assert.equal(lp.mode, 'resume', 'auto: a task already worked on resumes');
  assert.equal(lp.session.ref, '/s/be.jsonl');
  assert.equal(lp.checkpoint.message, 'done: x; left: y');
  run(['edit', 'T1', '--resume', 'fresh']);
  assert.equal(run(['resume-info', 'T1']).mode, 'fresh', 'task policy overrides');
  run(['plan', 'update', '--resume', 'fresh']);
  run(['edit', 'T1', '--resume', 'auto']);
  assert.equal(run(['resume-info', 'T1']).mode, 'resume', 'task policy beats plan policy');
  // question-block answered by the coordinator -> it starts a new instance ('answered')
  run(['start', 'T3'], be);
  run(['block', 'T3', '-m', 'redis or cookies?'], be);
  const t3 = (r) => r.attention.filter((a) => a.task === 'T3'); // T2 is unowned: also 'dispatch'
  assert.deepEqual(t3(run(['wait', '--timeout', '2000'])), [{ task: 'T3', reason: 'blocked' }]);
  run(['note', 'T3', 'cookies', '--kind', 'decision']);
  assert.ok(run(['show', 'T3']).answered);
  assert.deepEqual(t3(run(['wait', '--timeout', '2000'])), [{ task: 'T3', reason: 'answered' }]);
});

test('wait: subagents do not wait, they are told to finish and end', () => {
  const { run } = sandbox();
  run(['add', 'a']);
  run(['add', 'b']);
  const be = { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' };
  run(['start', 'T1'], be);
  run(['block', 'T1', '-m', 'needs b', '--on', 'T2'], be);
  const r = run(['wait', '--timeout', '3000'], be); // returns at once
  assert.match(r.note, /subagents do not wait: finish your task/);
  assert.deepEqual(r.attention, []);
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

test('task agent definition: stored, editable, clearable', () => {
  const { run } = sandbox();
  run(['add', 'review it', '--agent', 'reviewer']);
  assert.equal(run(['show', 'T1']).agent, 'reviewer');
  run(['edit', 'T1', '--agent', 'scout']);
  assert.equal(run(['show', 'T1']).agent, 'scout');
  run(['edit', 'T1', '--agent', '-']);
  assert.equal(run(['show', 'T1']).agent, null);
});

test('herdr agents: both definition formats, project overrides user, bash added for atf', async () => {
  const { discoverAgents, piArgsForAgent } = await import('../adapters/herdr/lib/agents.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-agents-'));
  const user = path.join(dir, 'user');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(user, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.pi', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(user, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: user reviewer\ntools: read, grep\n---\nUser prompt.\n');
  fs.writeFileSync(path.join(user, 'agents.json'), JSON.stringify({ agents: [{ id: 'explorer', description: 'json agent', tools: ['read'], model: 'p/m' }] }));
  fs.writeFileSync(path.join(proj, '.pi', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: project reviewer\ntools: [read, grep, ls]\nmodel: p/x\n---\nProject prompt.\n');
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = user;
  try {
    const defs = discoverAgents(proj);
    assert.equal(defs.get('reviewer').description, 'project reviewer');
    assert.deepEqual(defs.get('reviewer').tools, ['read', 'grep', 'ls']);
    assert.equal(defs.get('explorer').model, 'p/m');
    const { args, notes } = piArgsForAgent(defs.get('reviewer'), dir);
    assert.deepEqual(args.slice(0, 4), ['--model', 'p/x', '--tools', 'read,grep,ls,bash']);
    assert.equal(args[4], '--append-system-prompt');
    assert.equal(fs.readFileSync(args[5], 'utf8'), 'Project prompt.');
    assert.equal(notes.length, 1);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test('roles: plan creator is coordinator without ATF_ROLE; wait sees reviews', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-role-'));
  const env = { ...process.env, ATF_DIR: '', ATF_PLAN: '', NO_COLOR: '1', ATF_NO_REGISTRY: '1' };
  delete env.ATF_ACTOR;
  delete env.ATF_ROLE;
  const run = (args, extra = {}) => JSON.parse(execFileSync('node', [ATF, ...args, '--json'], { cwd: dir, env: { ...env, ...extra } }).toString());
  run(['init']);
  run(['plan', 'new', 'Roles']);
  run(['add', 'x']);
  assert.equal(run(['whoami']).role, 'coordinator');
  assert.equal(run(['whoami', '--as', 'someone']).role, 'agent');
  const w = { ATF_ACTOR: 'w1', ATF_ROLE: 'subagent' };
  run(['start', 'T1'], w);
  run(['review', 'T1', '-m', 'check'], w);
  assert.deepEqual(run(['wait', '--timeout', '3000']).attention, [{ task: 'T1', reason: 'review' }]);
  run(['plan', 'update', '--coordinator', 'lead']);
  assert.equal(run(['whoami'], { ATF_ACTOR: 'lead' }).role, 'coordinator');
});

test('wait: per-actor cursor; tasks finished before the wait are reported once; dispatch', () => {
  const { run } = sandbox();
  run(['add', 'a']); // T1
  run(['add', 'b']); // T2
  run(['add', 'c', '--dep', 'T1']); // T3
  run(['assign', 'T1', 'w1']);
  run(['assign', 'T2', 'w2']);
  const w1 = { ATF_ACTOR: 'w1', ATF_ROLE: 'subagent' };
  const w2 = { ATF_ACTOR: 'w2', ATF_ROLE: 'subagent' };
  run(['start', 'T1'], w1);
  run(['done', 'T1', '-m', 'finished early'], w1); // before the coordinator waits
  let r = run(['wait', '--timeout', '2000']);
  assert.deepEqual(r.events.map((e) => [e.task, e.data.status]), [['T1', 'done']]);
  // T2: assigned to w2 who has not started it (start an agent); T3: newly ready, unowned
  assert.deepEqual(r.attention, [{ task: 'T2', reason: 'start' }, { task: 'T3', reason: 'dispatch' }]);
  run(['assign', 'T3', 'w1']);
  run(['start', 'T2'], w2);
  run(['done', 'T2', '-m', 'between waits'], w2);
  r = run(['wait', '--timeout', '2000']);
  assert.deepEqual(r.events.map((e) => [e.task, e.data.status]), [['T2', 'done']], 'only what is new since the last wait');
  assert.deepEqual(r.attention, [{ task: 'T3', reason: 'start' }], 'assigned to w1, nobody started it yet');
});

test('wait: the coordinator is not woken by `block --on`, only by question-blocks', () => {
  const { run, runFail } = sandbox();
  run(['add', 'tests']); // T1
  run(['add', 'page']); // T2
  run(['assign', 'T1', 'be']);
  run(['assign', 'T2', 'fe']);
  const be = { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' };
  run(['start', 'T2'], { ATF_ACTOR: 'fe', ATF_ROLE: 'subagent' }); // fe is working on the page
  run(['start', 'T1'], be);
  runFail(['wait', '--timeout', '500']); // nothing for the coordinator; sets its cursor
  run(['block', 'T1', '-m', 'needs page', '--on', 'T2'], be);
  assert.equal(runFail(['wait', '--timeout', '800']).timeout, true, 'dependency block is not the coordinator\'s business');
  run(['start', 'T1'], be);
  run(['block', 'T1', '-m', 'which framework?'], be);
  const r = run(['wait', '--timeout', '2000']);
  assert.deepEqual(r.attention, [{ task: 'T1', reason: 'blocked' }]);
  assert.deepEqual(r.events.filter((e) => e.task === 'T1').map((e) => [e.task, e.data.status, e.data.on ?? null]), [['T1', 'blocked', null]]);
});

test('review: request changes, resubmit, approve; follow-up joins the package', () => {
  const { run, runFail } = sandbox();
  run(['add', 'API']); // T1 (package)
  run(['add', 'login', '--parent', 'T1', '--accept', 'returns token']); // T2
  run(['assign', 'T1', 'be']);
  const be = { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' };
  run(['next', '--package'], be);
  run(['review', 'T2', '-m', 'done'], be);
  assert.match(runFail(['changes', 'T2', '-m', 'x'], be).error, /only the coordinator/);
  run(['changes', 'T2', '-m', '1. return 401 on bad password']);
  let t = run(['show', 'T2']);
  assert.equal(t.status, 'todo');
  assert.equal(t.changes_requested, true);
  assert.equal(t.owner, 'be', 'stays with its owner');
  assert.deepEqual(t.feedback.map((f) => [f.round, f.message]), [[1, '1. return 401 on bad password']]);
  // the coordinator is reminded to start a new instance for it
  assert.deepEqual(run(['wait', '--timeout', '2000']).attention, [{ task: 'T2', reason: 'changes' }]);
  run(['start', 'T2'], be);
  run(['review', 'T2', '-m', 'fixed'], be);
  assert.equal(run(['show', 'T2']).changes_requested, false);
  run(['done', 'T2', '-m', 'approved']);
  run(['add', 'rate limit', '--from', 'T2']); // T3
  t = run(['show', 'T3']);
  assert.equal(t.origin, 'T2');
  assert.equal(t.parent, 'T1', 'follow-up joins the origin package');
  assert.equal(t.owner, 'be');
  assert.deepEqual(run(['show', 'T2']).followups, ['T3']);
  run(['changes', 'T2', '-m', 'wrong approach', '--fresh']);
  assert.equal(run(['resume-info', 'T2']).policy, 'fresh');
  assert.match(runFail(['changes', 'T3', '-m', 'x']).error, /in review or done/);
});

test('reviews: --by human tasks are not for the coordinator; feedback drafts submit in one write', () => {
  const { run, dir } = sandbox();
  run(['add', 'login']); // T1
  run(['add', 'docs']); // T2
  run(['assign', 'T1', 'w1']);
  run(['assign', 'T2', 'w2']);
  const w1 = { ATF_ACTOR: 'w1', ATF_ROLE: 'subagent' };
  const w2 = { ATF_ACTOR: 'w2', ATF_ROLE: 'subagent' };
  run(['start', 'T1'], w1);
  run(['review', 'T1', '-m', 'please test login', '--by', 'human'], w1);
  run(['start', 'T2'], w2);
  run(['review', 'T2', '-m', 'docs done'], w2);
  assert.deepEqual(run(['wait', '--timeout', '2000']).attention, [{ task: 'T2', reason: 'review' }], 'T1 waits for the human');
  const me = { ATF_ACTOR: 'human' }; // the human: a distinct actor (the board writes as it too)
  assert.equal(run(['whoami'], me).role, 'human', 'even with $ATF_ROLE=coordinator in the shell');
  run(['feedback', 'change', 'T1', 'error message unclear'], me);
  run(['feedback', 'change', 'T1', 'focus lost', '--file', 'a.tsx', '--line', '4'], me);
  run(['feedback', 'approve', 'T2'], me);
  assert.equal(run(['feedback'], me).length, 3);
  const before = fs.readFileSync(path.join(dir, '.atf', 'plans', run(['status']).id, 'events.jsonl'), 'utf8').trim().split('\n').length;
  run(['feedback', 'submit'], me);
  const lines = fs.readFileSync(path.join(dir, '.atf', 'plans', run(['status']).id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const batch = lines.slice(before);
  // v2: the human's change requests do not send T1 back; they are one note for the
  // coordinator, which decides. The approval of T2 takes effect directly.
  assert.deepEqual(batch.map((e) => e.type), ['task.note', 'task.status', 'plan.review']);
  assert.equal(new Set(batch.map((e) => e.seq)).size, 3);
  const t1 = run(['show', 'T1']);
  assert.equal(t1.status, 'review', 'stays in review until the coordinator acts');
  assert.equal(t1.changes_requested, false);
  assert.equal(t1.human_input[0].message, 'change request: 1. error message unclear\n2. focus lost (a.tsx:4)');
  assert.equal(run(['show', 'T2']).status, 'done');
  assert.equal(run(['feedback'], me).length, 0, 'drafts cleared');
  const r = run(['wait', '--timeout', '2000']);
  assert.ok(r.events.some((e) => e.type === 'plan.review'), 'coordinator hears about the review once');
  assert.deepEqual(r.attention, [{ task: 'T1', reason: 'human' }]);
  // the coordinator decides: it sends T1 back with its own instructions; handled
  run(['changes', 'T1', '-m', '1. clearer error text 2. keep focus in the form']);
  assert.deepEqual(run(['show', 'T1']).human_input, []);
  assert.equal(run(['show', 'T1']).feedback[0].actor, 'lead');
});

test('start --early: before dependencies, then block --on and resume', () => {
  const { run, runFail } = sandbox();
  run(['add', 'api']); // T1
  run(['add', 'client', '--dep', 'T1']); // T2
  const w = { ATF_ACTOR: 'w', ATF_ROLE: 'subagent' };
  assert.match(runFail(['start', 'T2'], w).error, /--early/);
  run(['start', 'T2', '--early'], w);
  const t = run(['show', 'T2']);
  assert.equal(t.status, 'in_progress');
  assert.match(t.last_message, /started early: T1/);
  run(['block', 'T2', '--on', 'T1', '-m', 'needs the api'], w);
  run(['start', 'T1']);
  run(['done', 'T1', '-m', 'ok']);
  assert.deepEqual(run(['wait', '--timeout', '2000']).attention, [{ task: 'T2', reason: 'unblocked' }]);
  run(['edit', 'T2', '--dep', '']);
  assert.deepEqual(run(['show', 'T2']).deps, [], "--dep '' removes all dependencies");
});

test('wait: no old events for a new agent; events already acted on are not repeated', () => {
  const { run } = sandbox();
  run(['add', 'a']); // T1
  run(['add', 'b']); // T2
  run(['note', 'T1', 'context for whoever does T1']);
  run(['assign', 'T1', 'fresh']);
  const fresh = { ATF_ACTOR: 'fresh', ATF_ROLE: 'subagent' };
  // T1 is assigned but nobody works on it yet: the coordinator is told to start an agent
  let r = run(['wait', '--timeout', '1500']);
  assert.deepEqual(r.attention, [{ task: 'T1', reason: 'start' }, { task: 'T2', reason: 'dispatch' }]);
  // coordinator: T1 goes to review, coordinator acts on it without waiting (woken by a message)
  run(['start', 'T1'], fresh);
  run(['review', 'T1', '-m', 'check'], fresh); // coordinator is NOT waiting now ...
  run(['assign', 'T2', 'other']);
  const other = { ATF_ACTOR: 'other', ATF_ROLE: 'subagent' };
  run(['start', 'T2'], other);
  run(['done', 'T2', '-m', 'finished while the coordinator was busy'], other);
  run(['note', 'T1', 'looked at it']); // ... it is woken by a message and acts on T1
  r = run(['wait', '--timeout', '1500']);
  assert.deepEqual(r.events.map((e) => [e.task, e.data.status]), [['T2', 'done']], 'T1 review event not repeated, T2 still reported');
  assert.deepEqual(r.attention, [{ task: 'T1', reason: 'review' }], 'T1 is still in review: level attention remains');
});

test('herdr sweep (v2): closes finished agents, never relaunches them, nudges the coordinator', async () => {
  const { dir, run } = sandbox(); // coordinator "lead"
  const sub = (who) => ({ ATF_ACTOR: who, ATF_ROLE: 'subagent' });
  run(['add', 'api', '--assign', 'be']); // T1: be finishes it
  run(['add', 'ui', '--assign', 'fe']); // T2: fe submits it, gets changes back, has exited
  run(['add', 'db', '--assign', 'st']); // T3: st stalls (idle, task in progress)
  run(['start', 'T1'], sub('be'));
  run(['done', 'T1', '-m', 'ok'], sub('be'));
  run(['start', 'T2'], sub('fe'));
  run(['review', 'T2', '-m', 'check'], sub('fe'));
  run(['changes', 'T2', '-m', '1. bigger buttons']);
  run(['start', 'T3'], sub('st'));
  const root = path.join(dir, '.atf');
  const { getCurrentPlan } = await import('../src/store.mjs');
  const planId = getCurrentPlan(root);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-state-'));
  const calls = path.join(state, 'calls.log');
  const fake = path.join(state, 'herdr');
  const agents = (coordinator) => [
    ...(coordinator ? [{ name: 'lead', pane_id: 'w1:p1', agent_status: 'idle', cwd: dir }] : []),
    { name: 'be', pane_id: 'w1:p2', agent_status: 'idle', cwd: dir },
    { name: 'st', pane_id: 'w1:p3', agent_status: 'idle', cwd: dir },
  ];
  const script = (list) => `#!/bin/sh\necho "$@" >> '${calls}'\ncase "$1 $2" in\n  "agent list") echo '${JSON.stringify({ result: { agents: list } })}';;\n  "agent prompt") echo '{"result":{}}';;\n  *) echo '{"result":{}}';;\nesac\n`;
  const long = Date.now() - 10 * 60_000; // idle for long: past the grace period and the stall time
  const rec = (name) => ({ name, kind: 'pi', root, plan: planId, launchedAt: long, idleSince: long });
  fs.writeFileSync(path.join(state, 'agents.json'), JSON.stringify({ [`${root}#be`]: rec('be'), [`${root}#fe`]: rec('fe'), [`${root}#st`]: rec('st') }));
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_BIN_PATH: fake, HERDR_PLUGIN_STATE_DIR: state, ATF_REGISTRY: path.join(dir, 'registry.json') });
  delete process.env.HERDR_SOCKET_PATH;
  try {
    const { lifecycleSweep, nudgeText } = await import('../adapters/herdr/lib/launch.mjs');
    fs.writeFileSync(fake, script(agents(true)), { mode: 0o755 });
    const r = lifecycleSweep(root);
    const log = fs.readFileSync(calls, 'utf8');
    assert.match(log, /pane close w1:p2/, 'be finished its assignment: closed');
    assert.doesNotMatch(log, /pane close w1:p3/, 'st has a task in progress: not closed');
    assert.doesNotMatch(log, /agent start/, 'fe has work (changes) but is never relaunched by the sweep');
    assert.match(log, /agent prompt w1:p1 \[ATF\][^\n]*T2 changes[^\n]*T3 stalled/, 'the coordinator is told: start an agent for T2; T3 stalled');
    assert.ok(r.actions.some((a) => /closed be/.test(a)));
    // no coordinator running: one notification, not repeated
    fs.writeFileSync(calls, '');
    fs.writeFileSync(fake, script(agents(false)), { mode: 0o755 });
    lifecycleSweep(root);
    lifecycleSweep(root);
    assert.equal((fs.readFileSync(calls, 'utf8').match(/notification show ATF: no coordinator/g) || []).length, 1);
    const st = { title: 'P', id: 'p1', tasks: { T2: { title: 'ui' } } };
    assert.match(nudgeText(st, { id: 'lead' }, [{ task: 'T2', reason: 'changes' }], [{ id: 'T3', owner: 'st' }]), /T2 changes \(ui\); T3 stalled .*atf-herdr spawn/);
  } finally {
    process.env = saved;
  }
});

test('--review: the owner must submit for review; the coordinator approves', () => {
  const { run, runFail } = sandbox();
  run(['add', 'migrate', '--review', '--assign', 'be']); // T1
  run(['add', 'docs', '--assign', 'be']); // T2
  const be = { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' };
  assert.equal(run(['show', 'T1']).review, true);
  run(['start', 'T1'], be);
  assert.match(runFail(['done', 'T1', '-m', 'ok'], be).error, /needs review.*atf review T1/);
  run(['review', 'T1', '-m', 'check the migration'], be);
  assert.match(runFail(['done', 'T1', '-m', 'self-approve'], be).error, /only the coordinator \(or the human\) reviews T1.*wait for the verdict/);
  run(['done', 'T1', '-m', 'approved']); // coordinator
  assert.equal(run(['show', 'T1']).status, 'done');
  run(['start', 'T2'], be);
  run(['done', 'T2', '-m', 'ok'], be); // no --review: done is fine
  run(['edit', 'T2', '--review=false']);
  run(['add', 'ui', '--reviewer', 'human', '--assign', 'be']); // T3: a reviewer implies review
  run(['start', 'T3'], be);
  assert.match(runFail(['done', 'T3', '-m', 'ok'], be).error, /needs review/);
  run(['edit', 'T3', '--review']);
  run(['edit', 'T3', '--review=false', '--reviewer', '-']);
  assert.equal(run(['show', 'T3']).review, false);
  run(['done', 'T3', '-m', 'ok'], be);
});

test('status: agents that have not started yet still show a role', () => {
  const { run } = sandbox();
  run(['add', 'a', '--assign', 'be']);
  const be = run(['status']).actors?.be ?? run(['plan', 'show']).actors?.be;
  assert.equal(be.role, 'subagent');
  assert.equal(be.role_inferred, true);
  assert.equal(run(['whoami'], { ATF_ACTOR: 'be', ATF_ROLE: '' }).role, 'agent', 'inferred display role is not a recorded one');
});

test('herdr board: a restored "ATF board" pane without a running board is not a board', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-board-'));
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_PLUGIN_STATE_DIR: dir, HERDR_SOCKET_PATH: '/tmp/test.sock', HERDR_PLUGIN_ID: 'atf.herdr' });
  try {
    const { isLiveBoard, registerBoardProcess } = await import('../adapters/herdr/lib/herdr.mjs');
    const pane = { pane_id: 'w1:p9', label: 'ATF board' };
    assert.equal(isLiveBoard(pane), false, 'no registration: a restored shell');
    // a running board (any process whose command mentions atf-herdr) registers itself
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', 'atf-herdr'], { stdio: 'ignore' });
    process.env.HERDR_PANE_ID = 'w1:p9';
    registerBoardProcess(); // writes this process's pid; point it at the child instead
    const reg = path.join(dir, 'boards', fs.readdirSync(path.join(dir, 'boards'))[0]);
    fs.writeFileSync(reg, JSON.stringify({ ...JSON.parse(fs.readFileSync(reg, 'utf8')), pid: child.pid }));
    assert.equal(isLiveBoard(pane), true);
    assert.equal(isLiveBoard({ ...pane, label: 'other' }), false);
    child.kill();
    await new Promise((r) => child.on('exit', r));
    assert.equal(isLiveBoard(pane), false, 'board process gone');
  } finally {
    process.env = saved;
  }
});

test('rollup: a package with one task in progress and one blocked --on it is in progress', () => {
  const { run } = sandbox();
  run(['add', 'pkg', '--assign', 'be']); // T1
  run(['add', 'api', '--parent', 'T1']); // T2
  run(['add', 'tests', '--parent', 'T1']); // T3
  const be = { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' };
  run(['start', 'T2'], be);
  run(['start', 'T3'], be);
  run(['block', 'T3', '-m', 'needs the api', '--on', 'T2'], be);
  assert.equal(run(['show', 'T1']).rollup_status, 'in_progress');
  run(['block', 'T2', '-m', 'which auth scheme?'], be); // a question: now it is blocked
  const t1 = run(['show', 'T1']);
  assert.equal(t1.rollup_status, 'blocked');
  assert.equal(t1.rollup_waiting, false);
});

test('wait: the coordinator is not reminded about work its agents are doing', () => {
  const { run, runFail } = sandbox();
  run(['add', 'a', '--assign', 'be']); // T1
  run(['add', 'b', '--assign', 'be']); // T2
  const be = { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' };
  run(['start', 'T1'], be);
  // be works on T1: its other ready task T2 is not the coordinator's business
  assert.equal(runFail(['wait', '--timeout', '800']).timeout, true, 'be is busy: nothing to start');
  run(['review', 'T1', '-m', 'check it'], be); // be finishes and exits
  const r = run(['wait', '--timeout', '2000']);
  assert.deepEqual(r.attention, [{ task: 'T1', reason: 'review' }, { task: 'T2', reason: 'start' }], 'review T1, start an agent for T2');
});

test('herdr sessions: filed on the tasks a launched agent works on, not on a guessed leaf', async () => {
  const { dir, run } = sandbox();
  run(['add', 'pkg', '--assign', 'be']); // T1
  run(['add', 'a', '--parent', 'T1']); // T2
  run(['add', 'b', '--parent', 'T1']); // T3
  const root = path.join(dir, '.atf');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-state-'));
  const fake = path.join(state, 'herdr');
  fs.writeFileSync(fake, '#!/bin/sh\necho \'{"result":{"agent":{"agent_session":{"value":"sess-1"}}}}\'\n', { mode: 0o755 });
  const { getCurrentPlan, readEvents } = await import('../src/store.mjs');
  const planId = getCurrentPlan(root);
  fs.writeFileSync(path.join(state, 'agents.json'), JSON.stringify({ [`${root}#be`]: { name: 'be', kind: 'pi', root, plan: planId } }));
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_BIN_PATH: fake, HERDR_PLUGIN_STATE_DIR: state, ATF_REGISTRY: path.join(dir, 'registry.json') });
  delete process.env.HERDR_SOCKET_PATH;
  try {
    const { recordSessionsForEvents } = await import('../adapters/herdr/lib/launch.mjs');
    run(['start', 'T3'], { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' }); // the agent picked T3
    recordSessionsForEvents(root, planId, readEvents(root, planId));
    assert.equal(run(['show', 'T3']).sessions.be?.ref, 'sess-1');
    assert.equal(run(['show', 'T2']).sessions.be, undefined, 'not on a task it did not touch');
  } finally {
    process.env = saved;
  }
});

test('e2e findings: review permissions, answered questions, fresh is one-shot, plan reopens, cycles', () => {
  const { run, runFail } = sandbox();
  const carol = { ATF_ACTOR: 'carol', ATF_ROLE: 'subagent' };
  const bob = { ATF_ACTOR: 'bob', ATF_ROLE: 'subagent' };
  const human = { ATF_ACTOR: 'human' };
  run(['add', 'ui', '--assign', 'carol', '--reviewer', 'human']); // T1
  run(['add', 'api', '--assign', 'bob']); // T2
  run(['start', 'T1'], carol);
  run(['review', 'T1', '-m', 'please test'], carol);
  // a subagent cannot approve its own task through feedback, nor send back someone else's
  run(['feedback', 'approve', 'T1'], carol);
  assert.match(runFail(['feedback', 'submit'], carol).error, /reviewed by human/);
  run(['feedback', 'drop'], carol);
  // the coordinator does not approve a task for the human either
  assert.match(runFail(['done', 'T1', '-m', 'ok']).error, /reviewed by human/);
  run(['feedback', 'approve', 'T1'], human);
  run(['feedback', 'submit'], human);
  assert.equal(run(['show', 'T1']).status, 'done');
  // others cannot reopen or release a task they don't own
  assert.match(runFail(['reopen', 'T1'], bob).error, /assigned to carol/);
  run(['start', 'T2'], bob);
  assert.match(runFail(['release', 'T2'], carol).error, /only they or the coordinator/);
  // agents add only inside their package
  assert.match(runFail(['add', 'stray'], bob).error, /inside your own work package/);
  // an answered question: the coordinator now starts a new instance with the answer
  run(['block', 'T2', '-m', 'which db?'], bob);
  assert.deepEqual(run(['wait', '--timeout', '1000']).attention, [{ task: 'T2', reason: 'blocked' }]);
  run(['note', 'T2', 'postgres']);
  assert.deepEqual(run(['wait', '--timeout', '1000']).attention, [{ task: 'T2', reason: 'answered' }]);
  run(['plan', 'update', '--resume', 'auto']);
  // --fresh applies to the next attempt only
  run(['start', 'T2'], bob);
  run(['review', 'T2', '-m', 'done'], bob);
  run(['changes', 'T2', '-m', '1. wrong approach', '--fresh']);
  assert.equal(run(['resume-info', 'T2']).mode, 'fresh');
  run(['start', 'T2'], bob);
  run(['review', 'T2', '-m', 'again'], bob);
  run(['changes', 'T2', '-m', '1. small fix']);
  assert.equal(run(['resume-info', 'T2', '--for', 'bob']).policy, 'auto', 'not sticky');
  // sending back a task in a completed plan reopens the plan
  run(['start', 'T2'], bob);
  run(['review', 'T2', '-m', 'ok'], bob);
  run(['done', 'T2', '-m', 'approved']);
  run(['plan', 'status', 'completed']);
  run(['changes', 'T2', '-m', '1. one more thing']);
  assert.equal(run(['status']).status, 'active');
  // dependency cycles are refused
  run(['add', 'x', '--dep', 'T2']); // T3
  assert.match(runFail(['edit', 'T2', '--dep', 'T3']).error, /dependency cycle/);
  // block --on a finished task is refused
  run(['start', 'T2'], bob);
  assert.match(runFail(['block', 'T2', '-m', 'w', '--on', 'T1'], bob).error, /already done/);
});

test('herdr board: the Overview lists what needs the human and acts on it directly', () => {
  const { dir, env, run } = sandbox();
  run(['add', 'Cart API', '--reviewer', 'human', '--assign', 'api', '--accept', 'tests pass']); // T1
  run(['add', 'Order model', '--assign', 'be']); // T2
  run(['add', 'Docs']); // T3
  run(['start', 'T1'], { ATF_ACTOR: 'api', ATF_ROLE: '' });
  run(['artifact', 'T1', 'feature/cart', '--kind', 'branch'], { ATF_ACTOR: 'api', ATF_ROLE: '' });
  run(['review', 'T1', '-m', 'cart endpoints with 14 tests', '--by', 'human'], { ATF_ACTOR: 'api', ATF_ROLE: '' });
  run(['start', 'T2'], { ATF_ACTOR: 'be', ATF_ROLE: '' });
  run(['progress', 'T2', 'migrations written, now the repository'], { ATF_ACTOR: 'be', ATF_ROLE: '' });
  const render = (keys) =>
    JSON.parse(
      execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '120', '40', JSON.stringify(keys)], {
        cwd: dir,
        env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
      }).toString(),
    );
  const [first, approved] = render(['a']);
  const needs = first.slice(first.indexOf('NEEDS YOU'), first.indexOf('IN FLIGHT'));
  assert.match(needs, /◎ review\s+T1 Cart API/);
  assert.match(needs, /cart endpoints with 14 tests/, 'its message is right under it');
  const flight = first.slice(first.indexOf('IN FLIGHT'));
  assert.match(flight, /T2 Order model\s+migrations written, now the repository/, 'current work with its latest progress');
  assert.doesNotMatch(flight.split('───')[0], /T3 Docs/, 'tasks nobody works on stay out of the overview');
  assert.match(first, /artifacts[\s\S]*branch\s+feature\/cart/, 'context panel shows what to review');
  assert.match(first, /a approve\s+x changes/);
  assert.match(approved, /approved T1: done/);
  assert.equal(run(['show', 'T1']).status, 'done', 'a approves at once, as the human');
  assert.equal(run(['show', 'T1']).history.at(-1).actor, 'human');
});

test('herdr board: the Log can be searched and filtered by plan', () => {
  const { dir, env, run } = sandbox();
  run(['add', 'Stripe adapter', '--assign', 'pay']); // T1
  run(['add', 'Docs']); // T2
  run(['start', 'T1'], { ATF_ACTOR: 'pay', ATF_ROLE: '' });
  run(['block', 'T1', '-m', 'which refund service?'], { ATF_ACTOR: 'pay', ATF_ROLE: '' });
  run(['plan', 'new', 'Other plan']);
  run(['add', 'Unrelated']);
  const frames = JSON.parse(
    execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '120', '30', JSON.stringify(['3', '/', ...'refund', '\r', '\x1b', 'p', ...'other', '\r'])], {
      cwd: dir,
      env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
    }).toString(),
  );
  const log = frames[1];
  assert.match(log, /plan all 2 plans/);
  assert.match(log, /Unrelated/);
  const searched = frames[9]; // start, 3 (Log), /, six letters, ⏎
  assert.match(searched, /search "refund"\s.*1 event/);
  assert.match(searched, /T1 blocked · which refund service\?/);
  assert.doesNotMatch(searched, /Unrelated|Docs/);
  const cleared = frames[10];
  assert.match(cleared, /search —/, 'esc clears the search');
  const picker = frames[11];
  assert.match(picker, /┌─+┐/, 'p opens the plan picker as a popup');
  assert.match(picker, /log of plan\s+2 plans/);
  assert.match(picker, /all plans[\s\S]*(Other plan[\s\S]*Test plan|Test plan[\s\S]*Other plan)/, 'every plan is listed without typing');
  assert.doesNotMatch(frames[16], /Test plan/, 'typing narrows the picker');
  const onePlan = frames[17];
  assert.match(onePlan, /plan Other plan \(p\)/, 'the picked plan filters the log');
  assert.match(onePlan, /Unrelated/);
  assert.doesNotMatch(onePlan, /Docs|refund/, 'only that plan’s events');
});

test('herdr board: the picker claims ctrl+h/j/k/l from pane-navigation plugins only while open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-nav-'));
  const saved = { ...process.env };
  Object.assign(process.env, { XDG_CACHE_HOME: dir, HERDR_PANE_ID: 'w1:p7' });
  try {
    const { claimNavKeys } = await import('../adapters/herdr/lib/herdr.mjs');
    const marker = path.join(dir, 'herdr', 'nvim-panes', 'w1:p7'); // herdr-nvim-nav's "this pane is Neovim" file
    claimNavKeys(true);
    assert.equal(fs.readFileSync(marker, 'utf8'), String(process.pid));
    claimNavKeys(false);
    assert.equal(fs.existsSync(marker), false);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '1'); // a real Neovim's marker is never removed
    claimNavKeys(false);
    assert.equal(fs.readFileSync(marker, 'utf8'), '1');
  } finally {
    process.env = saved;
  }
});

test('herdr board: Tasks groups by agent with v (the former Agents tab)', () => {
  const { dir, env, run } = sandbox();
  run(['add', 'API', '--assign', 'api']); // T1
  run(['add', 'Payments', '--assign', 'pay']); // T2: a package
  run(['add', 'Stripe', '--parent', 'T2']); // T3
  run(['add', 'Docs']); // T4
  run(['start', 'T1'], { ATF_ACTOR: 'api', ATF_ROLE: '' });
  run(['done', 'T1', '-m', 'ok'], { ATF_ACTOR: 'api', ATF_ROLE: '' });
  const [, , tree, byAgent] = JSON.parse(
    execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '110', '30', JSON.stringify(['1', 'l', 'v'])], {
      cwd: dir,
      env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
    }).toString(),
  );
  assert.match(tree, /0 Overview\s+1 Tasks\s+2 Plan\s+3 Log/, 'no Agents tab');
  assert.match(tree, /▾T2 ◐? ?\S* ?Payments/);
  assert.match(byAgent, /api\s.*1\/1/, 'agent heading with tasks done / total');
  assert.match(byAgent, /api[^\n]*\n[^\n]*T1 ● API/);
  assert.match(byAgent, /pay[^\n]*\n[^\n]*▣T2 [^\n]*Payments[^\n]*\n[^\n]*T3 ○ Stripe/, 'the package, then its tasks under it');
  assert.doesNotMatch(byAgent, /▣ pay/, 'the heading names the agent once');
  assert.match(byAgent, /unassigned\s+1 open · 1 ready\n[^\n]*T4 [^\n]*Docs/);
});

test('herdr sweep: never nudges a same-named agent of another project', async () => {
  const { dir, run } = sandbox(); // the plan's coordinator is "lead"
  run(['add', 'api', '--assign', 'be']); // T1
  run(['start', 'T1'], { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' });
  run(['block', 'T1', '-m', 'which db?'], { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' }); // the coordinator has work
  const root = path.join(dir, '.atf');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-state-'));
  const calls = path.join(state, 'calls.log');
  const fake = path.join(state, 'herdr');
  // herdr knows an idle agent named "lead", but it works in another project's directory
  const list = (cwd) => JSON.stringify({ result: { agents: [{ name: 'lead', pane_id: 'w9:p1', agent_status: 'idle', cwd }] } });
  const script = (cwd) => `#!/bin/sh\necho "$@" >> '${calls}'\ncase "$1 $2" in\n  "agent list") echo '${list(cwd)}';;\n  *) echo '{"result":{}}';;\nesac\n`;
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_BIN_PATH: fake, HERDR_PLUGIN_STATE_DIR: state, ATF_REGISTRY: path.join(dir, 'registry.json') });
  delete process.env.HERDR_SOCKET_PATH;
  try {
    const { lifecycleSweep } = await import('../adapters/herdr/lib/launch.mjs');
    fs.writeFileSync(fake, script('/somewhere/else'), { mode: 0o755 });
    lifecycleSweep(root);
    assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /agent prompt/, 'the other project’s "lead" is left alone');
    // the same agent working in this project is the coordinator and is nudged, by pane
    fs.writeFileSync(fake, script(dir), { mode: 0o755 });
    lifecycleSweep(root);
    assert.match(fs.readFileSync(calls, 'utf8'), /agent prompt w9:p1 \[ATF\][^\n]*T1 blocked/);
  } finally {
    process.env = saved;
  }
});

test('v2: questions are scoped and escalated; the human talks to the coordinator', () => {
  const { run, runFail } = sandbox(); // coordinator "lead"
  const pay = { ATF_ACTOR: 'pay', ATF_ROLE: 'subagent' };
  const human = { ATF_ACTOR: 'human' };
  run(['add', 'Stripe adapter', '--assign', 'pay']); // T1
  run(['start', 'T1'], pay);
  run(['note', 'T1', 'done: client; left: refunds', '--kind', 'checkpoint'], pay);
  // a subagent's question goes to the coordinator; it cannot address the human itself
  assert.match(runFail(['block', 'T1', '--for', 'human', '-m', 'which?'], pay).error, /only the coordinator asks the human/);
  run(['block', 'T1', '-m', 'refunds via the adapter or a separate service?'], pay);
  let t = run(['show', 'T1']);
  assert.equal(t.blocked_for, 'coordinator');
  assert.deepEqual(run(['wait', '--timeout', '1500']).attention, [{ task: 'T1', reason: 'blocked' }]);
  // the coordinator escalates the same task to the human: still blocked, now for the human
  run(['block', 'T1', '--for', 'human', '-m', 'Refunds: adapter or separate service? I would use the adapter.']);
  t = run(['show', 'T1']);
  assert.equal(t.status, 'blocked');
  assert.equal(t.blocked_for, 'human');
  const inbox = run(['inbox']);
  assert.deepEqual(inbox.filter((i) => i.task === 'T1').map((i) => [i.kind, i.for]), [['question', 'human']]);
  runFail(['wait', '--timeout', '700']); // waiting for the human is not the coordinator's to act on
  // a note by an agent does not answer a question for the human; the human's does
  run(['note', 'T1', 'any news?'], pay);
  assert.equal(run(['show', 'T1']).answered, false);
  run(['note', 'T1', 'use the adapter'], human);
  t = run(['show', 'T1']);
  assert.equal(t.answered, true);
  assert.deepEqual(t.human_input.map((n) => n.message), ['use the adapter']);
  // the answer wakes the coordinator, not the subagent
  const r = run(['wait', '--timeout', '1500']);
  assert.ok(r.events.some((e) => e.type === 'task.note' && e.actor.id === 'human'));
  assert.deepEqual(r.attention, [{ task: 'T1', reason: 'human' }]);
  assert.match(run(['wait', '--timeout', '1500'], pay).note, /subagents do not wait/);
  // the coordinator acts (here: a decision note): the human's input counts as handled
  run(['note', 'T1', 'decision: use the adapter for refunds', '--kind', 'decision']);
  assert.deepEqual(run(['show', 'T1']).human_input, []);
  assert.deepEqual(run(['wait', '--timeout', '1500']).attention, [{ task: 'T1', reason: 'answered' }], 'now start a new instance');
});

test('v2: plan questions, checkpoint, documents and the coordinator session', () => {
  const { run, runFail } = sandbox();
  const human = { ATF_ACTOR: 'human' };
  run(['plan', 'update', '--doc', 'design.md', '--doc', 'plan.md']);
  run(['plan', 'checkpoint', 'T1 dispatched; waiting for the API; next: the UI']);
  run(['plan', 'ask', 'Ship behind a feature flag?']);
  run(['plan', 'session', '/s/coord.jsonl', '--kind', 'pi']);
  let p = run(['plan', 'show']);
  assert.deepEqual(p.docs, ['design.md', 'plan.md']);
  assert.equal(p.checkpoint.message, 'T1 dispatched; waiting for the API; next: the UI');
  assert.deepEqual(p.questions.map((q) => q.message), ['Ship behind a feature flag?']);
  assert.deepEqual([p.session.ref, p.session.actor], ['/s/coord.jsonl', 'lead']);
  assert.deepEqual(run(['inbox']).map((i) => [i.kind, i.for]), [['plan-question', 'human']]);
  runFail(['wait', '--timeout', '600']); // set the cursor
  run(['plan', 'note', 'yes, behind a flag'], human);
  p = run(['plan', 'show']);
  assert.deepEqual(p.questions, [], 'answered by the human');
  const r = run(['wait', '--timeout', '1500']);
  assert.deepEqual(r.attention, [{ task: null, reason: 'human' }]);
  assert.ok(r.events.some((e) => e.type === 'plan.note' && e.actor.id === 'human'));
  run(['plan', 'note', 'ok: flag ATF_NEW_CHECKOUT', '--kind', 'decision']);
  assert.deepEqual(run(['plan', 'show']).human_input, []);
  run(['plan', 'update', '--doc', '-']);
  assert.deepEqual(run(['plan', 'show']).docs, []);
  // the human's `atf changes` is input for the coordinator, not a send-back
  run(['add', 'x', '--assign', 'w']); // T1
  run(['start', 'T1'], { ATF_ACTOR: 'w', ATF_ROLE: 'subagent' });
  run(['review', 'T1', '-m', 'done'], { ATF_ACTOR: 'w', ATF_ROLE: 'subagent' });
  assert.equal(run(['changes', 'T1', '-m', 'also PATCH'], human).for, 'coordinator');
  const t = run(['show', 'T1']);
  assert.equal(t.status, 'review');
  assert.deepEqual(t.human_input.map((n) => n.message), ['change request: also PATCH']);
});

test('herdr board (v2): an escalated question is for the human; the answer goes to the coordinator', () => {
  const { dir, env, run } = sandbox();
  const pay = { ATF_ACTOR: 'pay', ATF_ROLE: 'subagent' };
  run(['add', 'Stripe adapter', '--assign', 'pay']); // T1
  run(['start', 'T1'], pay);
  run(['block', 'T1', '-m', 'adapter or separate service?'], pay);
  run(['block', 'T1', '--for', 'human', '-m', 'Refunds: adapter or a separate service? I would use the adapter.']);
  const frames = JSON.parse(
    execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '120', '40', JSON.stringify(['r', ...'use the adapter', '\r'])], {
      cwd: dir,
      env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
    }).toString(),
  );
  const first = frames[0];
  assert.match(first, /⊘ question\s+T1 Stripe adapter[^\n]*for you/);
  assert.match(first, /question for you[\s\S]*I would use the adapter[\s\S]*originally asked by pay:[\s\S]*adapter or separate service\?/);
  assert.match(frames[1], /answer on T1, for the coordinator:/);
  assert.match(frames.at(-1), /answer on T1 sent to the coordinator/);
  const t = run(['show', 'T1']);
  assert.deepEqual(t.human_input.map((n) => [n.actor, n.message]), [['human', 'use the adapter']]);
  assert.deepEqual(run(['wait', '--timeout', '1500']).attention, [{ task: 'T1', reason: 'human' }]);
});

test('wait with a waking harness: does not block, arms it; --new wakes once per new item', () => {
  const { dir, run, runFail } = sandbox();
  const arm = path.join(dir, 'arm.json');
  const wake = { ATF_WAKE: arm };
  // nothing needs the coordinator: it is told to end its turn, the harness is armed
  let r = run(['wait', '--timeout', '600000'], wake);
  assert.equal(r.armed, true);
  const a = JSON.parse(fs.readFileSync(arm, 'utf8'));
  assert.equal(a.actor, 'lead');
  assert.ok(a.plan && a.root);
  // something needs it: reported at once (and armed again)
  run(['add', 'a']); // T1 dispatch
  fs.rmSync(arm);
  r = run(['wait'], wake);
  assert.deepEqual(r.attention, [{ task: 'T1', reason: 'dispatch' }]);
  assert.ok(fs.existsSync(arm));
  // the harness waits with --new: T1 was reported and left open -> no wake loop
  const t = runFail(['wait', '--new', '--timeout', '1200']);
  assert.equal(t.timeout, true);
  // a new item wakes it, with everything that needs it
  run(['add', 'b']); // T2
  r = run(['wait', '--new', '--timeout', '3000']);
  assert.deepEqual(r.attention.map((x) => x.task), ['T1', 'T2']);
  // the waiter registration is gone when the wait ends
  const cursors = fs.readdirSync(path.join(dir, '.atf', 'plans', a.plan, 'cursors'));
  assert.ok(!cursors.some((f) => f.endsWith('.waiter')), cursors.join(','));
});

test('§13: relayed human decisions, --recommend, brief, inbox --for', () => {
  const { dir, run, runFail } = sandbox();
  const w1 = { ATF_ACTOR: 'w1', ATF_ROLE: 'subagent' };
  run(['add', 'Order storage', '--accept', 'schema documented']); // T1
  run(['assign', 'T1', 'w1']);
  run(['start', 'T1'], w1);
  run(['block', 'T1', '-m', 'SQLite or Postgres?'], w1);
  // the coordinator escalates with its view
  run(['block', 'T1', '--for', 'human', '-m', 'Approve SQLite for orders?', '--recommend', 'yes: local demo, no server needed']);
  let b = run(['brief', 'T1']);
  assert.equal(b.kind, 'question');
  assert.equal(b.for, 'human');
  assert.equal(b.question.message, 'Approve SQLite for orders?');
  assert.equal(b.question.recommend, 'yes: local demo, no server needed');
  assert.deepEqual([b.question.original.actor, b.question.original.message], ['w1', 'SQLite or Postgres?']);
  assert.deepEqual(b.task.acceptance, ['schema documented']);
  assert.deepEqual(run(['inbox', '--for', 'human']).map((i) => i.task), ['T1']);
  assert.deepEqual(run(['inbox', '--for', 'coordinator']), []);
  // only the coordinator relays
  assert.match(runFail(['note', 'T1', '--relay', 'yes'], w1).error, /only the coordinator relays/);
  // the human answered in the coordinator's chat: recorded as the human's decision
  const r = run(['note', 'T1', '--relay', 'yes, go with SQLite']);
  assert.equal(r.answered, true);
  const t1 = run(['show', 'T1']);
  assert.equal(t1.answered, true);
  const n = t1.notes.at(-1);
  assert.deepEqual([n.actor, n.kind, n.relayed.from, n.relayed.quote, n.relayed.via], ['lead', 'decision', 'human', 'yes, go with SQLite', 'chat']);
  assert.deepEqual(run(['inbox', '--for', 'human']), [], 'answered: no longer waits for the human');
  assert.equal(t1.human_input.length, 0, 'relayed input does not wake the coordinator');

  // a review that waits for the human: the coordinator may approve it only as relayed
  run(['add', 'Cart API']); // T2
  run(['assign', 'T2', 'w1']);
  run(['start', 'T2'], w1);
  fs.writeFileSync(path.join(dir, 'cart.py'), 'a\nb\nc\n');
  run(['artifact', 'T2', 'cart.py'], w1);
  run(['review', 'T2', '--by', 'human', '-m', 'PATCH sets quantity; 18 tests'], w1);
  b = run(['brief', 'T2']);
  assert.equal(b.kind, 'your-review');
  assert.equal(b.review.submitted.message, 'PATCH sets quantity; 18 tests');
  assert.deepEqual(b.files.map((f) => [f.path, f.added]), [['cart.py', 3]]);
  assert.match(runFail(['done', 'T2', '-m', 'ok']).error, /reviewed by human/);
  run(['done', 'T2', '--relay', 'looks good, approve']);
  const t2 = run(['show', 'T2']);
  assert.equal(t2.status, 'done');
  const h = t2.history.at(-1);
  assert.deepEqual([h.to, h.actor, h.relayed.quote], ['done', 'lead', 'looks good, approve']);
  assert.match(runFail(['start', 'T1', '--relay', 'x']).error, /--relay applies to done/);

  // a relayed change request: the human's words plus the coordinator's instructions
  run(['add', 'Docs']); // T3
  run(['assign', 'T3', 'w1']);
  run(['start', 'T3'], w1);
  run(['review', 'T3', '-m', 'written'], w1);
  run(['changes', 'T3', '--relay', 'too long, cut it down', '-m', '1. keep it under one page']);
  const t3 = run(['show', 'T3']);
  assert.equal(t3.changes_requested, true);
  assert.equal(t3.history.at(-1).relayed.quote, 'too long, cut it down');
  assert.equal(t3.feedback.at(-1).message, '1. keep it under one page');

  // a plan question answered in the chat
  run(['plan', 'ask', 'Local demo or production?']);
  assert.equal(run(['brief', 'plan']).questions.length, 1);
  run(['plan', 'note', '--relay', 'local demo for now']);
  assert.equal(run(['brief', 'plan']).questions.length, 0);
  assert.deepEqual(run(['inbox', '--for', 'human']).filter((i) => i.kind === 'plan-question'), []);

  // a task that asks nothing (opened from a frontend's task list): where it stands
  run(['add', 'Search']); // T4
  run(['assign', 'T4', 'w1']);
  run(['start', 'T4'], w1);
  run(['progress', 'T4', 'index built', '--pct', '40'], w1);
  b = run(['brief', 'T4']);
  assert.equal(b.kind, 'task');
  assert.deepEqual(b.latest, { message: 'index built', percent: 40 });
  assert.equal(run(['brief', 'T1']).latest, undefined, 'a request shows the request, not the progress');
  // a finished plan: its brief says so
  assert.equal(run(['brief', 'plan']).finished, false);
  run(['done', 'T4', '-m', 'search works'], w1);
  run(['cancel', 'T1', '-m', 'dropped']);
  run(['cancel', 'T3', '-m', 'dropped']);
  assert.equal(run(['brief', 'plan']).finished, true);
});

test('§13.7: atf dispatch for subagents in the coordinator\'s harness (--as)', () => {
  const { run, runFail } = sandbox();
  run(['add', 'Cart API', '--accept', 'tests pass', '--review']);
  run(['add', 'Docs', '--dep', 'T1']);
  assert.match(runFail(['dispatch', 'T2']).error, /not ready/);
  assert.match(runFail(['dispatch', 'T1'], { ATF_ACTOR: 'w1', ATF_ROLE: 'subagent' }).error, /only the coordinator/);
  const d = run(['dispatch', 'T1', '--name', 'Backend']);
  assert.equal(d.name, 'backend');
  assert.equal(run(['show', 'T1']).assignee, 'backend');
  assert.match(d.prompt, /`atf start T1 --as backend`/);
  assert.match(d.prompt, /`atf review T1 -m "[^`]*" --as backend`/);
  assert.match(d.prompt, /add `--as backend` to every atf command/);
  // the coordinator's identity does not start or submit a delegated task (a subagent that forgot --as)
  assert.match(runFail(['start', 'T1']).error, /if you are backend, add `--as backend`/);
  assert.match(runFail(['note', 'T1', 'half done', '--kind', 'checkpoint']).error, /--as backend/);
  // --as in the coordinator's shell: $ATF_ROLE (the coordinator's) does not apply
  assert.equal(run(['whoami', '--as', 'backend']).role, 'agent');
  run(['start', 'T1', '--as', 'backend']);
  run(['review', 'T1', '-m', 'done, check the tests', '--as', 'backend']);
  const t = run(['show', 'T1']);
  assert.equal(t.status, 'review');
  assert.equal(t.owner, 'backend');
  // dispatching again keeps the assignment; a package names its next leaf
  run(['add', 'Pkg']);
  run(['add', 'Leaf', '--parent', 'T3']);
  const p = run(['dispatch', 'T3', '--name', 'docs']);
  assert.match(p.prompt, /work package T3/);
  assert.match(p.prompt, /next task is T4/);
});

test('--as in another actor\'s shell does not take over its herdr pane', () => {
  const { run, dir, env } = sandbox();
  run(['add', 'A']);
  run(['dispatch', 'T1', '--name', 'w1'], { HERDR_PANE_ID: 'w1:p9' });
  run(['start', 'T1', '--as', 'w1'], { HERDR_PANE_ID: 'w1:p9' });
  const raw = execFileSync('node', [ATF, 'log', '-n', '5', '--json'], { cwd: dir, env }).toString();
  const log = raw.trim().split('\n').map((l) => JSON.parse(l));
  const byW1 = log.filter((e) => e.actor.id === 'w1');
  assert.ok(byW1.length && byW1.every((e) => !e.actor.ctx?.herdr_pane));
  assert.equal(log.find((e) => e.type === 'task.assigned' && e.actor.id === 'lead').actor.ctx.herdr_pane, 'w1:p9');
});

test('§14 live: classify commands, output files, summarizers', async () => {
  const L = await import('../src/live.mjs');
  assert.equal(L.classify('mvn -B test'), 'maven');
  assert.equal(L.classify('cd api && ./mvnw verify'), 'maven');
  assert.equal(L.classify('glab ci status --live'), 'pipeline');
  assert.equal(L.classify('gh run watch 42'), 'pipeline');
  assert.equal(L.classify('until curl -sf localhost:8080/health; do sleep 2; done'), 'wait');
  assert.equal(L.classify('for i in $(seq 1 30); do\n  r=$(curl -fsS "localhost:8765/api/v4/projects/demo/pipelines/$id")\n  sleep 10\ndone'), 'pipeline');
  assert.equal(L.classify('for i in 1 2 3; do\n  test -f done.txt && break\n  sleep 5\ndone'), 'wait');
  assert.equal(L.classify('npm test'), 'tests');
  assert.equal(L.classify('echo "mvn test"'), null);
  assert.equal(L.classify('ls -la'), null);
  assert.equal(L.cwdOf('cd api && mvn test', '/w'), '/w/api');
  assert.deepEqual(L.outputFiles('nohup mvn test > /tmp/b.log 2>&1 &', '/w').map((f) => f.file), ['/tmp/b.log']);
  assert.deepEqual(L.outputFiles('mvn test | tee build.log', '/w').map((f) => f.file), ['/w/build.log']);
  assert.deepEqual(L.outputFiles('mvn test > out.txt', '/w'), []); // foreground: captured anyway
  assert.deepEqual(L.outputFiles('x > /dev/null &', '/w'), []);
  assert.deepEqual(L.outputFiles('./run-app.sh > app.log 2>&1 &\npid=$!\nprintf "%s" "$pid" > /tmp/app.pid', '/w').map((f) => f.file), ['/w/app.log']);

  const mvn = '[INFO] Building core 1.0 [2/5]\n[INFO] Tests run: 10, Failures: 1, Errors: 0, Skipped: 2, Time elapsed: 0.5 s - in com.x.FooTest\n[ERROR] com.x.FooTest.testBar:42 expected\n[INFO] Tests run: 10, Failures: 1, Errors: 0, Skipped: 2\n';
  const running = L.summarizeText('maven', mvn);
  assert.equal(running.state, 'running');
  assert.equal(running.counts.tests, 10); // the Results: total is not counted twice
  assert.match(running.line, /2\/5 core · 10 tests · 1 ✗/);
  const failed = L.summarizeText('maven', mvn + '[INFO] BUILD FAILURE\n');
  assert.equal(failed.state, 'failed');
  assert.match(failed.line, /^BUILD FAILURE in core/);
  assert.equal(L.summarizeText('tests', 'Tests:       2 failed, 410 passed, 412 total\n').counts.failed, 2);
  assert.equal(L.summarizeText('tests', '# tests 45\n# pass 45\n# fail 0\n').state, 'ok');
  const pipe = L.summarizeText('pipeline', 'https://gitlab.example.com/g/p/-/pipelines/98765\n(running) build\n');
  assert.equal(pipe.state, 'waiting');
  assert.equal(pipe.counts.url, 'https://gitlab.example.com/g/p/-/pipelines/98765');
  assert.equal(L.summarizeText('pipeline', 'Pipeline state: success').state, 'ok');

  // surefire reports beat the log
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-live-'));
  fs.mkdirSync(path.join(dir, 'core', 'target', 'surefire-reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'core', 'target', 'surefire-reports', 'TEST-com.x.FooTest.xml'), '<testsuite name="com.x.FooTest" tests="12" failures="1" errors="0" skipped="0"><testcase name="testBar" classname="com.x.FooTest"><failure/></testcase></testsuite>');
  const rep = L.surefire(dir);
  assert.equal(rep.run, 12);
  assert.deepEqual(rep.failing, ['FooTest#testBar']);
  assert.deepEqual(L.summarizeText('maven', '[INFO] Building core 1.0 [1/1]\n[ERROR] com.x.FooTest.testBar  Time elapsed: 0.04 s  <<< FAILURE!\n', { cwd: dir }).details, ['✗ FooTest#testBar']);
});

// the pi extension is TypeScript: node runs it directly from 23.6 (type stripping)
const nodeStripsTypes = +process.versions.node.split('.')[0] > 23 || (+process.versions.node.split('.')[0] === 23 && +process.versions.node.split('.')[1] >= 6);
test('§14 live: artifact --live, the pi hook records runs, show/brief summarize them', { skip: !nodeStripsTypes && 'needs node >= 23.6 to load the .ts extension' }, async () => {
  const { run, dir, env } = sandbox();
  run(['add', 'Build']);
  run(['dispatch', 'T1', '--name', 'w1']);
  run(['start', 'T1', '--as', 'w1']);
  fs.writeFileSync(path.join(dir, 'server.log'), 'started\nERROR boom\n');
  run(['artifact', 'T1', 'server.log', '--live', '--as', 'w1']);
  let t = run(['show', 'T1']);
  run(['artifact', 'T1', 'https://ci.example.com/g/p/-/pipelines/7', '--live', '--as', 'w1']); // a URL: not a live file
  assert.equal(run(['show', 'T1']).artifacts.find((a) => a.ref.startsWith('https:')).kind, 'url');
  run(['artifact', 'T1', 'server.log', '--live', '--as', 'w1']); // again: no second entry
  t = run(['show', 'T1']);
  assert.equal(t.artifacts.filter((a) => a.live).length, 1);
  const live = t.artifacts.find((a) => a.live);
  assert.equal(live.kind, 'log');
  assert.equal(live.ref, fs.realpathSync(path.join(dir, 'server.log')));

  // the pi extension, driven like pi does: start, streamed output, end
  const root = path.join(dir, '.atf');
  const plan = fs.readdirSync(path.join(root, 'plans'))[0];
  const saved = { ...process.env };
  Object.assign(process.env, { ATF_DIR: root, ATF_PLAN: plan, ATF_ACTOR: 'w1', ATF_ROLE: 'subagent', ATF_REGISTRY: env.ATF_REGISTRY });
  delete globalThis.__atfLiveLoaded;
  try {
    const h = {};
    (await import('../adapters/pi/atf-live.ts')).default({ on: (e, f) => (h[e] = f) });
    const L = await import('../src/live.mjs');
    await h.tool_execution_start({ toolName: 'bash', toolCallId: 'c1', args: { command: 'mvn -B test' } }, { cwd: dir });
    await h.tool_execution_update({ toolCallId: 'c1', partialResult: { content: [{ type: 'text', text: '[INFO] Building core 1.0 [1/2]\n' }] } });
    const now = L.activeRuns(root, plan);
    assert.equal(now.length, 1);
    assert.equal(now[0].task, 'T1');
    assert.equal(L.summarize(now[0]).line, '1/2 core');
    await h.tool_execution_start({ toolName: 'bash', toolCallId: 'c2', args: { command: 'ls' } }, { cwd: dir });
    await h.tool_execution_end({ toolCallId: 'c2', durationMs: 10, isError: false, result: { content: [{ type: 'text', text: 'x' }] } });
    await h.tool_execution_end({ toolCallId: 'c1', durationMs: 4000, isError: true, result: { content: [{ type: 'text', text: '[INFO] BUILD FAILURE\n\nCommand exited with code 1' }] } });
    assert.equal(L.activeRuns(root, plan).length, 0);
    await h.session_shutdown({});
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  t = run(['show', 'T1']);
  const runs = t.artifacts.filter((a) => a.cmd && !a.live);
  assert.equal(runs.length, 1); // the quick `ls` is not recorded
  assert.equal(runs[0].kind, 'maven');
  assert.equal(runs[0].exit, 1);
  assert.match(runs[0].description, /BUILD FAILURE/);
  const text = execFileSync('node', [ATF, 'brief', 'T1'], { cwd: dir, env }).toString();
  assert.match(text, /live:/);
  assert.match(text, /maven BUILD FAILURE .*exit 1/);
  assert.match(text, /log 1 error/);
});

test('§14 live: maven test progress against the previous run (baseline)', async () => {
  const L = await import('../src/live.mjs');
  const log = [
    '[INFO] Reactor Build Order:',
    '[INFO]   demo-core [jar]',
    '[INFO]   demo-api [jar]',
    '[INFO] ',
    '[INFO] --------------------------< com.demo:core >---------------------------',
    '[INFO] Building core 1.0-SNAPSHOT [1/2]',
    '[INFO] Running com.demo.core.MoneyTest',
    '[INFO] Tests run: 14, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 4.1 s - in com.demo.core.MoneyTest',
    '[INFO] Running com.demo.core.RoundingTest',
  ].join('\n');
  const baseline = { classes: { 'com.demo.core.MoneyTest': { module: 'core', tests: 14 }, 'com.demo.core.RoundingTest': { module: 'core', tests: 22 }, 'com.demo.api.PriceTest': { module: 'api', tests: 7 } } };
  const bfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atf-base-')), 'b.json');
  fs.writeFileSync(bfile, JSON.stringify(baseline));
  const s = L.summarizeText('maven', log, { extra: { baseline: bfile }, file: 'x' }); // as the hook's onStart recorded it
  assert.equal(s.line, '1/2 core · 14/~43 tests');
  assert.equal(s.counts.percent, 33);
  const p = s.progress;
  assert.equal(p.running.cls, 'com.demo.core.RoundingTest');
  assert.deepEqual(p.dirs.map((d) => [d.module, d.state, d.classesDone, d.classesTotal, d.testsDone, d.testsTotal]), [
    ['core', 'building', 1, 2, 14, 36],
    ['api', 'pending', 0, 1, 0, 7],
  ]);
  // no previous run: what is done, without a total
  assert.equal(L.summarizeText('maven', log).line, '1/2 core · 14 tests');
  // the Results section names the failure and its message
  const failed = L.summarizeText('maven', log + '\n[ERROR] Failures: \n[ERROR]   RoundingTest.halfUp:12 expected: <3> but was: <2>\n[INFO] BUILD FAILURE\n');
  assert.deepEqual(failed.progress.failures, [{ test: 'RoundingTest#halfUp', message: 'expected: <3> but was: <2>' }]);
  // the view renders modules and the running class
  const text = L.mavenView(s, { width: 100, active: true }).map((l) => l.map(([x]) => x).join('')).join('\n');
  assert.match(text, /14\/~43 tests/);
  assert.match(text, /▸ running RoundingTest/);
});

test('§14 live: a newer run of the same kind and directory replaces the older one', async () => {
  const L = await import('../src/live.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-sup-'));
  const f = (name, text) => (fs.writeFileSync(path.join(dir, name), text), path.join(dir, name));
  const failed = { kind: 'maven', ref: f('a.log', '[INFO] BUILD FAILURE\n'), cmd: 'mvn verify', cwd: '/w', exit: 1, ts: '2026-01-01T00:00:01Z' };
  const fixed = { kind: 'maven', ref: f('b.log', '[INFO] BUILD SUCCESS\n'), cmd: 'atf progress T1 "x" && mvn verify', cwd: '/w', exit: 0, ts: '2026-01-01T00:00:02Z' };
  const other = { kind: 'maven', ref: f('c.log', '[INFO] BUILD FAILURE\n'), cmd: 'mvn verify', cwd: '/w/other', exit: 1, ts: '2026-01-01T00:00:03Z' };
  let live = L.taskLive({ id: 'T1', artifacts: [failed, fixed] });
  assert.deepEqual(live.recorded.map((a) => a.ref), [fixed.ref]);
  assert.deepEqual(live.earlier.map((a) => a.ref), [failed.ref]);
  assert.equal(L.liveBadge(live), null); // the failure was fixed: no ✗ on the row
  assert.match(L.earlierText(live), /1 earlier run \(1 failed\)/);
  // another directory is another build: its failure stays current
  live = L.taskLive({ id: 'T1', artifacts: [failed, fixed, other] });
  assert.deepEqual(live.recorded.map((a) => a.ref), [other.ref, fixed.ref]);
  assert.equal(L.liveBadge(live).glyph, '✗');
  // generic logs replace each other only for the same command
  const l1 = { kind: 'log', ref: f('d.log', 'x'), cmd: './a.sh', cwd: '/w', exit: 0 };
  const l2 = { kind: 'log', ref: f('e.log', 'y'), cmd: './b.sh', cwd: '/w', exit: 0 };
  assert.equal(L.taskLive({ id: 'T1', artifacts: [l1, l2] }).recorded.length, 2);
});

test('§14 live plugins: load, replace a built-in, broken plugins, live-try', () => {
  const { dir, env } = sandbox();
  const plug = path.join(dir, 'plugins');
  fs.mkdirSync(plug);
  fs.writeFileSync(path.join(plug, 'deploy.mjs'), `export default {
    kind: 'deploy', waiting: true, priority: 5,
    match: (cmd, { unquoted }) => /\\.\\/deploy\\.sh\\b/.test(unquoted),
    summarize: (text) => ({ state: /DONE/.test(text) ? 'ok' : 'waiting', line: 'deploy ' + (text.match(/step (\\d+)/g) || []).length + ' steps', counts: {}, details: [] }),
    view: (s) => [[['  ' + s.line, 'cyan']]],
    open: () => ({ url: 'https://deploy.example.com' }),
  };`);
  fs.writeFileSync(path.join(plug, 'tests.mjs'), `export default { kind: 'tests', summarize: () => ({ state: 'ok', line: 'mine', counts: {}, details: [] }) };`);
  fs.writeFileSync(path.join(plug, 'broken.mjs'), `export default { kind: 'Bad Name', summarize: 1 };`);
  const e = { ...env, ATF_LIVE_PLUGINS: plug, XDG_CONFIG_HOME: path.join(dir, 'cfg') };
  const k = JSON.parse(execFileSync('node', [ATF, 'live-kinds', '--json'], { cwd: dir, env: e }).toString());
  const by = Object.fromEntries(k.kinds.map((x) => [x.kind, x]));
  assert.ok(by.deploy && by.deploy.waiting && by.deploy.has.includes('view'));
  assert.equal(by.tests.source, path.join(plug, 'tests.mjs'));
  assert.equal(by.tests.replaces, 'built-in');
  assert.equal(k.errors.length, 1);
  assert.match(k.errors[0].error, /kind must match/);
  fs.writeFileSync(path.join(dir, 'out.txt'), 'step 1\nstep 2\nDONE\n');
  const t = JSON.parse(execFileSync('node', [ATF, 'live-try', 'deploy', 'out.txt', '--cmd', './deploy.sh prod', '--json'], { cwd: dir, env: e }).toString());
  assert.equal(t.match, 'deploy');
  assert.equal(t.summary.state, 'ok');
  assert.equal(t.summary.line, 'deploy 2 steps');
  assert.equal(t.open.url, 'https://deploy.example.com');
  // a plugin file given directly, without installing it
  const t2 = JSON.parse(execFileSync('node', [ATF, 'live-try', path.join(plug, 'deploy.mjs'), 'out.txt', '--json'], { cwd: dir, env: { ...env, XDG_CONFIG_HOME: path.join(dir, 'cfg') } }).toString());
  assert.equal(t2.kind, 'deploy');
});

test('board: no line wider than the pane (wide characters would wrap and make it flicker)', async () => {
  const { fit, strWidth } = await import('../adapters/herdr/lib/tui.mjs');
  const visible = (s) => strWidth(s.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.equal(strWidth('⏳ 日本 ok'), 10);
  assert.equal(strWidth('é'), 1); // combining accent
  for (const segs of [[['x'.repeat(39) + '⏳', '']], [['⏳'.repeat(30), 'red']], [['ab', ''], ['日本語テキスト', 'cyan'], ['🚀 done', '']]]) assert.ok(visible(fit(segs, 40)) <= 40, JSON.stringify(segs));
  assert.equal(visible(fit([['x'.repeat(39) + '⏳', '']], 40)), 39); // the wide char does not fit: the column stays empty
});

/** Run `fn` with ATF env vars set for the in-process adapters, restoring the env after. */
async function withEnv(vars, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('§14 live: Copilot adapter (background subagent, command moved to the background)', async () => {
  const { run, dir, env } = sandbox();
  run(['add', 'Build']);
  run(['dispatch', 'T1', '--name', 'backend']);
  run(['start', 'T1', '--as', 'backend']);
  const root = path.join(dir, '.atf');
  const plan = fs.readdirSync(path.join(root, 'plans'))[0];
  const L = await import('../src/live.mjs');
  await withEnv({ ATF_DIR: root, ATF_PLAN: plan, ATF_ACTOR: 'lead', ATF_ROLE: 'coordinator', ATF_REGISTRY: env.ATF_REGISTRY }, async () => {
    const { attachLive } = await import('../adapters/copilot/live.mjs');
    const h = {};
    const session = { on: (t, f) => (h[t] = f) };
    const obs = attachLive(session);
    await obs.ready;
    const tick = () => new Promise((r) => setTimeout(r, 30));
    h['subagent.started']({ agentId: 'a1', data: { agentDisplayName: 'backend' } });
    h['tool.execution_start']({ agentId: 'a1', data: { toolCallId: 'c1', toolName: 'bash', arguments: { command: 'mvn -B test', mode: 'sync' } } });
    h['tool.execution_start']({ data: { toolCallId: 'c0', toolName: 'bash', arguments: { command: 'mvn -B test' } } }); // the coordinator's own: no task
    h['tool.execution_start']({ agentId: 'zz', data: { toolCallId: 'c9', toolName: 'bash', arguments: { command: 'mvn -B test' } } }); // unknown subagent
    await tick();
    h['tool.shell_output']({ agentId: 'a1', data: { toolCallId: 'c1', text: '[INFO] Building core 1.0 [1/2]\n' } });
    let now = L.activeRuns(root, plan);
    assert.equal(now.length, 1);
    assert.deepEqual([now[0].actor, now[0].task, now[0].kind], ['backend', 'T1', 'maven']);
    // moved to the background: still running
    h['tool.execution_complete']({ agentId: 'a1', data: { toolCallId: 'c1', success: true, result: { content: '<command with shellId: 7 moved to background>', structuredContent: { shellId: '7' } } } });
    assert.equal(L.activeRuns(root, plan).length, 1);
    // the agent reads it; the result says it completed
    h['tool.execution_start']({ agentId: 'a1', data: { toolCallId: 'r1', toolName: 'read_bash', arguments: { shellId: '7' } } });
    h['tool.execution_complete']({ agentId: 'a1', data: { toolCallId: 'r1', success: true, result: { content: '[INFO] BUILD FAILURE\n<shellId: 7 completed with exit code 1>' } } });
    assert.equal(L.activeRuns(root, plan).length, 0);
    // a command Copilot refuses ends before its start is registered: not left running
    h['tool.execution_start']({ agentId: 'a1', data: { toolCallId: 'x1', toolName: 'bash', arguments: { command: 'sleep 20; kill "$pid"' } } });
    h['tool.execution_complete']({ agentId: 'a1', data: { toolCallId: 'x1', success: false, error: { message: 'Command not executed.' } } });
    await new Promise((r) => setTimeout(r, 4500)); // past the delay after which ordinary commands show
    assert.equal(L.activeRuns(root, plan).length, 0);
    // a command waiting for the human's approval: shown as waiting for them, at once
    h['tool.execution_start']({ agentId: 'a1', data: { toolCallId: 'p1', toolName: 'bash', arguments: { command: './run-app.sh > app.log 2>&1 &' } } });
    h['permission.requested']({ data: { requestId: 'q1', permissionRequest: { kind: 'shell', toolCallId: 'p1' } } });
    await tick();
    now = L.activeRuns(root, plan);
    assert.deepEqual([now.length, now[0]?.approval, now[0]?.waiting], [1, true, true]);
    const badge = L.liveBadge(L.taskLive({ id: 'T1', artifacts: [] }, now));
    assert.deepEqual([badge.glyph, badge.text], ['⧖', 'waiting for your approval']);
    h['permission.completed']({ data: { requestId: 'q1', toolCallId: 'p1', result: { kind: 'approved' } } });
    await tick();
    assert.equal(L.activeRuns(root, plan)[0]?.approval, undefined);
    h['tool.execution_complete']({ agentId: 'a1', data: { toolCallId: 'p1', success: true, shellExecution: { exitCode: 0 }, result: { content: '' } } });
    await tick();
    h['session.shutdown']({});
  });
  const t = run(['show', 'T1']);
  const runs = t.artifacts.filter((a) => a.cmd && !a.live);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].kind, runs[0].exit, runs[0].actor], ['maven', 1, 'backend']);
  assert.match(fs.readFileSync(runs[0].ref, 'utf8'), /Building core[\s\S]*BUILD FAILURE/);
});

test('§14 live: opencode plugin (bash parts, exit code, child sessions)', async () => {
  const { run, dir, env } = sandbox();
  run(['add', 'Tests']);
  run(['dispatch', 'T1', '--name', 'oc1']);
  run(['start', 'T1', '--as', 'oc1']);
  const root = path.join(dir, '.atf');
  const plan = fs.readdirSync(path.join(root, 'plans'))[0];
  const L = await import('../src/live.mjs');
  await withEnv({ ATF_DIR: root, ATF_PLAN: plan, ATF_ACTOR: 'oc1', ATF_ROLE: 'subagent', ATF_REGISTRY: env.ATF_REGISTRY }, async () => {
    const { AtfLivePlugin } = await import('../adapters/opencode/atf.mjs');
    const hooks = await AtfLivePlugin({ directory: dir });
    const part = (status, extra = {}) => ({ type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', callID: 'k1', sessionID: 's-root', state: { status, input: { command: 'npm test' }, time: { start: 1000, end: 4000 }, ...extra } } } });
    await hooks.event({ event: part('pending') });
    await hooks.event({ event: part('running', { metadata: { output: '# tests 3\n' } }) });
    const now = L.activeRuns(root, plan);
    assert.deepEqual([now.length, now[0]?.kind, now[0]?.actor], [1, 'tests', 'oc1']);
    // opencode asks the human first: waiting for them until the reply
    await hooks.event({ event: { type: 'permission.asked', properties: { id: 'per1', sessionID: 's-root', permission: 'bash', patterns: ['npm test'], metadata: {}, always: [], tool: { messageID: 'm1', callID: 'k1' } } } });
    assert.deepEqual(L.activeRuns(root, plan).map((r) => [r.approval, r.waiting]), [[true, true]]);
    await hooks.event({ event: { type: 'permission.replied', properties: { sessionID: 's-root', requestID: 'per1', reply: 'once' } } });
    assert.deepEqual(L.activeRuns(root, plan).map((r) => [r.approval, r.waiting]), [[undefined, false]]);
    await hooks.event({ event: part('completed', { output: '# tests 3\n# fail 1\n', metadata: { output: '# tests 3\n# fail 1\n', exit: 1 } }) });
    assert.equal(L.activeRuns(root, plan).length, 0);
    // a child session (subagent) that never says who it is: ignored
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 's-child', parentID: 's-root' } } } });
    await hooks.event({ event: { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', callID: 'k2', sessionID: 's-child', state: { status: 'running', input: { command: 'npm test' } } } } } });
    assert.equal(L.activeRuns(root, plan).length, 0);
  });
  const runs = run(['show', 'T1']).artifacts.filter((a) => a.cmd);
  // duration: the observer's clock (opencode's state.time does not span the command)
  assert.deepEqual(runs.map((a) => [a.kind, a.exit, typeof a.duration_ms]), [['tests', 1, 'number']]);
});

test('§14 live: background files get their command\'s kind (plugins too), shell -c scripts, glab ci get', async () => {
  const L = await import('../src/live.mjs');
  // a plugin kind for ansible (as a work plugin would add)
  L.registerLiveKind({ kind: 'ansible', match: (c, { unquoted }) => /\bansible-playbook\b/.test(unquoted), summarize: (t) => ({ state: 'running', line: `ansible ${t.split('\n').length}` }) }, 'test');
  // scripts handed to a shell
  assert.equal(L.classify("docker exec app bash -c './mvnw -B verify'"), 'maven');
  assert.equal(L.classify('ssh ci sh -lc "cd api && npm test"'), 'tests');
  assert.equal(L.classify("bash -c 'echo hi'"), null);
  assert.equal(L.classify("echo 'bash -c ./mvnw verify'"), null);

  const { run, dir, env } = sandbox();
  run(['add', 'Deploy']);
  run(['dispatch', 'T1', '--name', 'w1']);
  run(['start', 'T1', '--as', 'w1']);
  const root = path.join(dir, '.atf');
  const plan = fs.readdirSync(path.join(root, 'plans'))[0];
  // reports of a previous Maven run: the baseline a background run gets its total from
  fs.mkdirSync(path.join(dir, 'target', 'surefire-reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'target', 'surefire-reports', 'TEST-a.FooTest.xml'), '<testsuite name="a.FooTest" tests="7" failures="0" errors="0" skipped="0" time="1"></testsuite>');
  await withEnv({ ATF_DIR: root, ATF_PLAN: plan, ATF_ACTOR: 'w1', ATF_ROLE: 'subagent', ATF_REGISTRY: env.ATF_REGISTRY }, async () => {
    const { createObserver } = await import('../src/live-observer.mjs');
    const obs = createObserver();
    await obs.start({ id: 'b1', cmd: 'docker exec ops ansible-playbook site.yml > deploy.log 2>&1 &', cwd: dir });
    await obs.start({ id: 'b2', cmd: 'nohup ./mvnw -B verify > build.log 2>&1 &', cwd: dir });
    obs.shutdown();
  });
  const live = run(['show', 'T1']).artifacts.filter((a) => a.live);
  const by = Object.fromEntries(live.map((a) => [path.basename(a.ref), a]));
  assert.equal(by['deploy.log']?.kind, 'ansible');
  assert.equal(by['build.log']?.kind, 'maven');
  assert.ok(by['build.log'].extra?.baseline, 'the maven onStart ran for the background run');
  assert.ok(by['build.log'].extra.baseline.startsWith(path.join(root, 'plans', plan, 'live')), 'its baseline is kept in the plan, not beside the agent\'s file');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'registry.json'), []);

  // `glab ci get`: the pipeline's status, not the last job's
  const out = '# Pipeline:\nid:\t4711\nstatus:\trunning\nref:\tmain\n\n# Jobs:\ncompile:\tsuccess\nunit:\tfailed\nstaging:\tcreated\n';
  const s = L.summarizeText('pipeline', out);
  assert.deepEqual([s.state, s.line, s.details], ['waiting', 'pipeline #4711 running · 2/3 jobs · 1 ✗', ['✗ unit']]);
  assert.equal(L.summarizeText('pipeline', out + out.replace('running', 'failed')).state, 'failed');

  // live-try: --active and --no-refresh are switches
  fs.writeFileSync(path.join(dir, 'out.txt'), '[INFO] Building core 1.0 [1/1]\n');
  const t = JSON.parse(execFileSync('node', [ATF, 'live-try', 'maven', '--active', '--no-refresh', 'out.txt', '--json'], { cwd: dir, env }).toString());
  assert.equal(t.kind ?? t.summary?.kind ?? 'maven', 'maven');
});

test('live plugin example: GitLab jobs in pipeline order', async () => {
  const g = (await import('../examples/live-plugins/gitlab.mjs')).default;
  // the jobs API lists newest first
  const jobs = [
    { id: 13, name: 'staging', stage: 'deploy', status: 'created' },
    { id: 12, name: 'unit', stage: 'test', status: 'running' },
    { id: 11, name: 'lint', stage: 'build', status: 'success' },
    { id: 10, name: 'compile', stage: 'build', status: 'success' },
  ];
  const s = g.summarize('', { cmd: 'glab ci status', fetched: { pipeline: { status: 'running' }, jobs } });
  assert.deepEqual(s.counts.stages, ['build', 'test', 'deploy']);
  assert.deepEqual(s.counts.jobs.map((j) => j.name), ['compile', 'lint', 'unit', 'staging']);
});

test('herdr spawn: why an agent did not start, from its pane', async () => {
  const { startFailure } = await import('../adapters/herdr/lib/herdr.mjs');
  assert.match(startFailure('copilot', '│ Confirm folder trust │\n│ Do you trust the files in this folder? │\n', '/p'), /copilot asks whether to trust \/p/);
  assert.match(startFailure('opencode', 'line 1\nError: no credits\n', '/p'), /its pane showed:\n {2}line 1\n {2}Error: no credits/);
  assert.equal(startFailure('pi', '', '/p'), '');
});
