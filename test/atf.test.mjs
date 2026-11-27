import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fold, rollupStatus, findCycles } from '../src/core.mjs';

const ATF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'atf.mjs');

function sandbox({ outline = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-test-'));
  const env = { ...process.env, ATF_DIR: '', ATF_PLAN: '', ATF_ACTOR: 'lead', ATF_ROLE: 'coordinator', NO_COLOR: '1', ATF_REGISTRY: path.join(dir, 'registry.json'), HERDR_PLUGIN_CONFIG_DIR: path.join(dir, 'herdr-config'), XDG_CONFIG_HOME: path.join(dir, 'xdg-config') };
  delete env.ATF_VI_MODE; // the user's own board settings stay out of the tests
  delete env.ATF_DIFF_TOOL; // and their diff viewer (~/.config/atf/config.json, via XDG_CONFIG_HOME above)
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
  run(['plan', 'new', 'Test plan', ...(outline ? [] : ['--ids', 'flat'])]); // most tests: flat ids (T1, T2, …), as older plans
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
  const cfgPath = path.join(dir, '.atf', 'config.toml');
  assert.match(fs.readFileSync(cfgPath, 'utf8'), /^protocol = 1$/m, 'atf init writes TOML');
  fs.appendFileSync(cfgPath, `\n[hooks]\npost_write = [\n  [${JSON.stringify(process.execPath)}, ${JSON.stringify(script)}],\n  ['/nonexistent/binary'], # a broken hook never fails a write\n]\n`);
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
  assert.match(runFail(['changes', 'T3', '-m', 'x']).error, /T3 is todo; changes start a new attempt/);
});

test('attempts: a retry with new instructions is a new attempt on the same task, not a new task', () => {
  const { run, runFail, dir, env } = sandbox();
  const w = { ATF_ACTOR: 'deployer', ATF_ROLE: 'subagent' };
  run(['add', 'Deploy the services', '--accept', 'all four deployed', '--assign', 'deployer']); // T1
  run(['add', 'Smoke test', '--dep', 'T1']); // T2
  run(['add', 'Parent']); // T3
  run(['add', 'child', '--parent', 'T3']); // T4
  let t = run(['show', 'T1']);
  assert.equal(t.attempts.length, 1);

  // attempt 1 fails; the coordinator retries it with new instructions
  run(['start', 'T1'], w);
  run(['fail', 'T1', '-m', 'kubectl apply: the charts need helm'], w);
  assert.match(runFail(['changes', 'T1', '-m', 'x'], w).error, /review/i, 'not the agent: it cannot review its own task');
  let c = run(['changes', 'T1', '-m', '1. deploy with helm upgrade --install, not kubectl apply', '--fresh']);
  assert.equal(c.attempt, 2);
  t = run(['show', 'T1']);
  assert.equal(t.status, 'todo');
  assert.equal(t.changes_requested, true);
  assert.deepEqual(t.attempts.map((a) => [a.n, a.ended?.status ?? null, a.instructions]), [
    [1, 'failed', null],
    [2, null, '1. deploy with helm upgrade --install, not kubectl apply'],
  ]);
  assert.deepEqual(t.attempts[0].actors, ['deployer']);
  assert.deepEqual(run(['show', 'T2']).deps, ['T1'], 'dependents still wait on the same task');
  assert.equal(run(['list']).length, 4, 'no new task');

  // the prompt of the next agent says why it is started again
  const d = run(['dispatch', 'T1', '--name', 'deployer2']);
  assert.match(d.prompt, /this is attempt 2: the previous attempt failed: "kubectl apply: the charts need helm"/);
  assert.match(d.prompt, /helm upgrade --install/);

  // attempt 2 goes the wrong way while in progress: the coordinator stops it, attempt 3
  const w2 = { ATF_ACTOR: 'deployer2', ATF_ROLE: 'subagent' };
  run(['start', 'T1'], w2);
  c = run(['changes', 'T1', '-m', '1. deploy to staging first']);
  assert.equal(c.attempt, 3);
  t = run(['show', 'T1']);
  assert.deepEqual(t.attempts[1].ended, { ...t.attempts[1].ended, status: 'in_progress', stopped: true });
  run(['start', 'T1'], w2);
  run(['done', 'T1', '-m', 'all four deployed'], w2);
  t = run(['show', 'T1']);
  assert.deepEqual(t.attempts.map((a) => a.ended?.status), ['failed', 'in_progress', 'done']);
  const text = execFileSync('node', [ATF, 'show', 'T1'], { cwd: dir, env }).toString();
  assert.match(text, /attempts \(3\):/);
  assert.match(text, /1\. deployer failed — kubectl apply: the charts need helm/);
  assert.match(text, /2\. instructions from .*: 1\. deploy with helm/);

  // a parent: send back the subtask instead
  assert.match(runFail(['changes', 'T3', '-m', 'x']).error, /T3 is a parent task/);
});

test('outline ids: a subtask is numbered under its parent; lists follow the outline; no moves', () => {
  const { run, runFail } = sandbox({ outline: true });
  assert.equal(run(['plan', 'show']).outline_ids, true, 'new plans have them');
  run(['add', 'Design']); // T1
  run(['add', 'Build']); // T2
  run(['add', 'api', '--parent', 'T2']); // T2.1
  run(['add', 'ui', '--parent', '2']); // T2.2 (the T is optional)
  run(['add', 'Deploy']); // T3
  run(['add', 'schema', '--parent', 'T2.1']); // T2.1.1
  const late = run(['add', 'docs', '--parent', 'T2', '--dep', '2.1']).task; // added after T3: still T2.3
  assert.equal(late.id, 'T2.3');
  assert.deepEqual(late.deps, ['T2.1']);
  assert.equal(run(['add', 'Release']).task.id, 'T4', 'top-level tasks count among themselves');
  // lists read as the outline does, whatever the order they were added in
  assert.deepEqual(run(['list']).map((t) => t.id), ['T1', 'T2', 'T2.1', 'T2.1.1', 'T2.2', 'T2.3', 'T3', 'T4']);
  assert.equal(run(['show', 't2.2']).title, 'ui');
  // a follow-up lands next to its origin, numbered there
  assert.equal(run(['add', 'more ui', '--from', 'T2.2']).task.id, 'T2.4');
  // the id says where a task sits: it does not move (unless forced)
  assert.match(runFail(['edit', 'T2.2', '--parent', 'T3']).error, /cannot move under T3: cancel it and add it again there/);
  assert.equal(run(['edit', 'T2.2', '--title', 'web ui']).task.title, 'web ui');
  run(['edit', 'T2.2', '--parent', 'T3', '--force']);
  assert.equal(run(['show', 'T2.2']).parent, 'T3');
  assert.match(runFail(['plan', 'new', 'x', '--ids', 'tree']).error, /flat or outline/);
});

test('tasks for the human: theirs to do, apart from what needs them now; a misfiled question is reorganized', () => {
  const { run, runFail } = sandbox({ outline: true });
  const w = { ATF_ACTOR: 'w', ATF_ROLE: 'subagent' };
  const me = { ATF_ACTOR: 'human', ATF_ROLE: '' };
  const wait = () => {
    try {
      return run(['wait', '--timeout', '500']);
    } catch {
      return runFail(['wait', '--timeout', '500']); // nothing for the coordinator
    }
  };
  run(['add', 'Fix the rounding bug', '--assign', 'w']); // T1
  run(['add', 'Release', '--dep', 'T1']); // T2
  // the old way: the agent's question for the human piles up under "needs you"
  run(['start', 'T1'], w);
  run(['block', 'T1', '-m', 'please tell the payments team about the rounding bug'], w);
  run(['block', 'T1', '--for', 'human', '-m', 'please tell the payments team about the rounding bug']);
  assert.ok(run(['inbox', '--for', 'human']).some((i) => i.task === 'T1' && i.kind === 'question'));

  // the coordinator reorganizes: a task for the human, the question becomes a wait on it
  const t3 = run(['add', 'Tell the payments team about the rounding bug', '--assign', 'human', '--desc', 'they own the ledger; ask them to check last week\'s refunds']).task;
  assert.equal(t3.id, 'T3');
  run(['block', 'T1', '--on', 'T3', '-m', 'waits for the human: T3']);
  run(['edit', 'T2', '--dep', 'T1,T3']);
  let inbox = run(['inbox', '--for', 'human']);
  assert.deepEqual(inbox.map((i) => [i.task, i.kind]), [['T3', 'your-task']], 'no question any more: a task for the human');
  assert.deepEqual(inbox[0].waiting, ['T1', 'T2']);
  // nobody starts an agent for it
  const w1 = wait();
  assert.ok(!(w1.attention ?? []).some((a) => a.task === 'T3'), JSON.stringify(w1.attention));

  // the human does it: what waited on it can go on
  run(['start', 'T3'], me);
  run(['done', 'T3', '-m', 'told them, ticket PAY-123'], me);
  assert.deepEqual(run(['inbox', '--for', 'human']), []);
  assert.equal(run(['show', 'T1']).can_resume, true);
  const w2 = wait();
  assert.ok(w2.attention.some((a) => a.task === 'T1' && a.reason === 'unblocked'), JSON.stringify(w2.attention));
});

test('steps: the parts of a task, checked off one by one; percent follows', () => {
  const { run, runFail } = sandbox();
  const w = { ATF_ACTOR: 'd', ATF_ROLE: 'subagent' };
  run(['add', 'Deploy the four services', '--assign', 'd']); // T1
  run(['add', 'other', '--assign', 'x']); // T2
  run(['start', 'T1'], w);
  run(['steps', 'T1', 'deploy gateway', 'deploy refund', 'deploy ledger', 'deploy fx'], w);
  run(['step', 'T1', '1'], w);
  run(['step', 'T1', 'deploy refund', 'start'], w);
  let t = run(['show', 'T1']);
  assert.deepEqual(t.steps.map((x) => x.status), ['done', 'in_progress', 'todo', 'todo']);
  assert.equal(t.percent, 25);
  assert.equal(t.last_message, 'step 2/4 started: deploy refund');
  run(['step', 'T1', '2', 'done', '-m', 'rev 14'], w);
  run(['step', 'T1', '4', 'skip'], w);
  t = run(['show', 'T1']);
  assert.equal(t.percent, 75);
  assert.equal(t.last_message, 'step 4/4 skipped: deploy fx');
  // a new list keeps the state of steps with the same title
  run(['steps', 'T1', 'deploy gateway', 'deploy refund', 'deploy ledger', 'smoke test'], w);
  assert.deepEqual(run(['show', 'T1']).steps.map((x) => x.status), ['done', 'done', 'todo', 'todo']);
  assert.match(runFail(['step', 'T1', '9'], w).error, /T1 has 4 steps/);
  assert.match(runFail(['steps', 'T2', 'a'], w).error, /assigned to x/);
  assert.match(runFail(['step', 'T2', '1'], { ATF_ACTOR: 'x', ATF_ROLE: 'subagent' }).error, /no steps/);
});

test('a parent with criteria of its own goes to review when its slices are done', () => {
  const { run, runFail } = sandbox();
  const w = { ATF_ACTOR: 'w', ATF_ROLE: 'subagent' };
  run(['add', 'Deploy refunds', '--accept', 'deployed, end-to-end test green']); // T1: planned, criteria
  run(['add', 'build', '--parent', 'T1', '--assign', 'w']); // T2
  run(['add', 'deploy', '--parent', 'T1', '--dep', 'T2', '--assign', 'w']); // T3: a sequence
  run(['add', 'Container']); // T4: no criteria: rolls up as before
  run(['add', 'part', '--parent', 'T4', '--assign', 'w']); // T5
  run(['add', 'Smoke test', '--dep', 'T1']); // T6
  for (const id of ['T2', 'T3', 'T5']) {
    run(['start', id], w);
    run(['done', id, '-m', 'ok'], w);
  }
  let t = run(['show', 'T1']);
  assert.equal(t.status, 'review', 'written in the same write as the last slice');
  assert.equal(t.rollup_status, 'review');
  assert.equal(run(['show', 'T4']).rollup_status, 'done', 'no criteria: done when its children are');
  assert.deepEqual(run(['show', 'T6']).waiting_on, ['T1'], 'dependents wait for the review');
  assert.ok(run(['wait', '--timeout', '1000']).attention.some((a) => a.task === 'T1' && a.reason === 'review'));
  assert.match(runFail(['done', 'T1', '-m', 'x'], w).error, /only the coordinator/);
  assert.match(runFail(['changes', 'T1', '-m', 'x']).error, /send back the subtask that needs changes, or add one/);

  // the review finds a gap: a new slice puts T1 back to work; done again: review again
  run(['add', 'migrate the schema', '--parent', 'T1', '--assign', 'w']); // T7
  assert.equal(run(['show', 'T1']).status, 'todo');
  run(['start', 'T7'], w);
  run(['done', 'T7', '-m', 'ok'], w);
  assert.equal(run(['show', 'T1']).status, 'review');
  run(['done', 'T1', '-m', 'approved: deployed, e2e green']);
  t = run(['show', 'T1']);
  assert.equal(t.rollup_status, 'done');
  assert.deepEqual(run(['show', 'T6']).waiting_on, []);

  // a reopened slice reopens the approved parent
  run(['changes', 'T3', '-m', '1. redeploy with the new config']);
  assert.equal(run(['show', 'T1']).status, 'todo');
  assert.notEqual(run(['show', 'T1']).rollup_status, 'done');
});

test('parent reviews are a property of the plan: older plans keep parents as containers', () => {
  // an older plan's log (no parent_review): a parent with criteria, done children, a dependent
  const old = fold([
    ev(1, 'plan.created', undefined, { title: 'old' }),
    ev(2, 'task.created', 'T1', { title: 'Backend', acceptance: ['API works'] }),
    ev(3, 'task.created', 'T2', { title: 'endpoint', parent: 'T1' }),
    ev(4, 'task.created', 'T3', { title: 'frontend', deps: ['T1'] }),
    ev(5, 'task.status', 'T2', { status: 'in_progress' }),
    ev(6, 'task.status', 'T2', { status: 'done', message: 'ok' }),
    ev(7, 'plan.status', undefined, { status: 'completed' }),
  ]);
  assert.equal(old.tasks.T1.rollup_status, 'done', 'unchanged: a container');
  assert.deepEqual(old.tasks.T3.waiting_on, []);

  const { run, runFail } = sandbox();
  const w = { ATF_ACTOR: 'w', ATF_ROLE: 'subagent' };
  assert.equal(run(['plan', 'show']).parent_review, true, 'a new plan has them');
  run(['plan', 'update', '--parent-review', 'off']); // as an older plan
  run(['add', 'Backend', '--accept', 'API works']); // T1
  run(['add', 'endpoint', '--parent', 'T1', '--assign', 'w']); // T2
  run(['start', 'T2'], w);
  run(['done', 'T2', '-m', 'ok'], w);
  let t = run(['show', 'T1']);
  assert.equal(t.status, 'todo', 'no review event written');
  assert.equal(t.rollup_status, 'done');
  // a running older plan opts in: its parents whose children are done go to review now
  const u = run(['plan', 'update', '--parent-review', 'on']);
  assert.deepEqual(u.review, ['T1']);
  t = run(['show', 'T1']);
  assert.equal(t.status, 'review');
  assert.match(runFail(['plan', 'update', '--parent-review', 'maybe']).error, /on or off/);
});

test('a parent reviewed by the human waits for the human', () => {
  const { run, runFail } = sandbox();
  const w = { ATF_ACTOR: 'w', ATF_ROLE: 'subagent' };
  run(['add', 'Checkout', '--accept', 'a customer can pay', '--reviewer', 'human']); // T1
  run(['add', 'api', '--parent', 'T1', '--assign', 'w']); // T2
  run(['start', 'T2'], w);
  run(['done', 'T2', '-m', 'ok'], w);
  assert.equal(run(['show', 'T1']).status, 'review');
  assert.ok(!(run(['wait', '--timeout', '500']).attention ?? []).some((a) => a.task === 'T1'), 'not the coordinator\'s to approve');
  assert.ok(run(['inbox', '--for', 'human']).some((i) => i.task === 'T1' && i.kind === 'your-review'));
  assert.match(runFail(['done', 'T1', '-m', 'x']).error, /reviewed by human/);
  run(['done', 'T1', '-m', 'works'], { ATF_ACTOR: 'human' });
  assert.equal(run(['show', 'T1']).rollup_status, 'done');
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
    // no coordinator running: the sweep only logs it; the human is notified by notify.mjs
    fs.writeFileSync(calls, '');
    fs.writeFileSync(fake, script(agents(false)), { mode: 0o755 });
    assert.ok(lifecycleSweep(root).actions.some((a) => /no coordinator running/.test(a)));
    assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /notification show/);
    const st = { title: 'P', id: 'p1', tasks: { T2: { title: 'ui' } } };
    assert.match(nudgeText(st, { id: 'lead' }, [{ task: 'T2', reason: 'changes' }], [{ id: 'T3', owner: 'st' }]), /T2 changes \(ui\); T3 stalled .*atf-herdr spawn/);
  } finally {
    process.env = saved;
  }
});
test('herdr restore: after a restart the coordinator is relaunched in place, stale agents closed, the board reopened', async () => {
  const { dir, run } = sandbox(); // coordinator "lead"
  run(['add', 'api', '--assign', 'be']); // T1: in progress when herdr went down
  run(['add', 'docs']); // T2
  run(['start', 'T1'], { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' });
  const root = path.join(dir, '.atf');
  const { getCurrentPlan, transact } = await import('../src/store.mjs');
  const planId = getCurrentPlan(root);
  transact(root, planId, { id: 'atf-herdr', role: 'launcher' }, () => [{ type: 'plan.session', data: { ref: '/s/lead.jsonl', kind: 'pi', actor: 'lead' } }]);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-state-'));
  const calls = path.join(state, 'calls.log');
  const fake = path.join(state, 'herdr');
  // what herdr restored: the panes with their names, pi resumed in them (under their old
  // agent names), a shell where the board was, and a pane of the user's own
  const panes = [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', label: 'lead', agent: 'pi', cwd: dir },
    { pane_id: 'w1:p4', tab_id: 'w1:t1', workspace_id: 'w1', label: 'ATF board', cwd: dir },
    { pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', label: 'be', agent: 'pi', cwd: dir },
    { pane_id: 'w1:p7', tab_id: 'w1:t3', workspace_id: 'w1', agent: 'pi', cwd: dir },
  ];
  const agents = [
    { name: 'lead', pane_id: 'w1:p1', agent_status: 'idle', cwd: dir, agent_session: { value: '/s/lead.jsonl' } },
    { name: 'be', pane_id: 'w1:p2', agent_status: 'idle', cwd: dir, agent_session: { value: '/s/be.jsonl' } },
    { name: 'mine', pane_id: 'w1:p7', agent_status: 'idle', cwd: dir, agent_session: { value: '/s/mine.jsonl' } },
  ];
  const j = (x) => JSON.stringify({ result: x });
  fs.writeFileSync(
    fake,
    `#!/bin/sh\necho "$@" >> '${calls}'\ncase "$1 $2" in\n  "pane list") echo '${j({ panes })}';;\n  "agent list") echo '${j({ agents })}';;\n  "pane split") echo '${j({ pane: { pane_id: 'w1:p9' } })}';;\n  "agent get") echo '{"result":{}}';;\n  *) echo '{"result":{}}';;\nesac\n`,
    { mode: 0o755 },
  );
  const rec = { launchedAt: Date.now() - 3_600_000, root, plan: planId, kind: 'pi' };
  fs.writeFileSync(
    path.join(state, 'agents.json'),
    JSON.stringify({ [`${root}#lead`]: { ...rec, name: 'lead', actor: 'lead', role: 'coordinator', pane: 'w1:p1' }, [`${root}#be`]: { ...rec, name: 'be', task: 'T1', pane: 'w1:p2' } }),
  );
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_BIN_PATH: fake, HERDR_PLUGIN_STATE_DIR: state, ATF_REGISTRY: path.join(dir, 'registry.json'), HERDR_PLUGIN_CONFIG_DIR: path.join(state, 'cfg') });
  delete process.env.HERDR_SOCKET_PATH;
  try {
    const { restore, restoreSummary } = await import('../adapters/herdr/lib/restore.mjs');
    const boards = [];
    const r = await restore({ settleMs: 0, openBoard: (at) => (boards.push(at), null) });
    const log = fs.readFileSync(calls, 'utf8');
    assert.match(log, /pane close w1:p2/, "the subagent's stale pane is closed");
    assert.match(log, /pane split --pane w1:p1 .*--env ATF_PLAN=[^ ]+ .*--env ATF_ROLE=coordinator/, 'the coordinator gets its environment back, in the spot of its old pane');
    assert.match(log, /pane close w1:p1/);
    assert.match(log, /agent start lead --kind pi --pane w1:p9 -- --session \/s\/lead\.jsonl/, 'resuming its session');
    assert.match(log, /agent prompt w1:p9 \[ATF\] You were restarted[^\n]*T1 \(be\)/, 'told to reassess, with the task that lost its agent');
    assert.doesNotMatch(log, /pane close w1:p7/, "the user's own pi is left alone");
    assert.deepEqual(boards, [{ root, target: 'w1:p1', workspace: 'w1', tab: 'w1:t1' }], 'the board comes back beside the coordinator');
    assert.equal(restoreSummary(r), 'coordinator of Test plan restarted; 1 task in progress handed to it; 1 stale agent pane closed; 1 board reopened');
    const reg = JSON.parse(fs.readFileSync(path.join(state, 'agents.json'), 'utf8'));
    assert.equal(reg[`${root}#lead`].pane, 'w1:p9');
    assert.equal(reg[`${root}#be`].pane, null);
  } finally {
    process.env = saved;
  }
});
test('herdr coordinate: in the plan workspace while it exists, else a new one for the project', async () => {
  const { dir } = sandbox(); // coordinator "lead"
  const root = path.join(dir, '.atf');
  const { getCurrentPlan } = await import('../src/store.mjs');
  const planId = getCurrentPlan(root);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-state-'));
  const calls = path.join(state, 'calls.log');
  const fake = path.join(state, 'herdr');
  const j = (x) => JSON.stringify({ result: x });
  const script = (panes) =>
    `#!/bin/sh\necho "$@" >> '${calls}'\ncase "$1 $2" in\n  "pane list") echo '${j({ panes })}';;\n  "workspace list") echo '${j({ workspaces: [{ workspace_id: 'w3', label: path.basename(dir) }] })}';;\n  "workspace create") echo '${j({ workspace: { workspace_id: 'w8' }, tab: { tab_id: 'w8:t1' }, root_pane: { pane_id: 'w8:p1' } })}';;\n  "tab create") echo '${j({ tab: { tab_id: 'w3:t2' }, root_pane: { pane_id: 'w3:p5' } })}';;\n  "pane split") echo '${j({ pane: { pane_id: 'w8:p2' } })}';;\n  "agent get") echo '{"result":{}}';;\n  *) echo '{"result":{}}';;\nesac\n`;
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_BIN_PATH: fake, HERDR_PLUGIN_STATE_DIR: state, ATF_REGISTRY: path.join(dir, 'registry.json'), HERDR_PLUGIN_CONFIG_DIR: path.join(state, 'cfg') });
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_WORKSPACE_ID;
  try {
    const { launchCoordinator } = await import('../adapters/herdr/lib/launch.mjs');
    // the project's workspace (named after its folder, a pane working in it): a tab there
    fs.writeFileSync(fake, script([{ pane_id: 'w3:p1', workspace_id: 'w3', cwd: dir }]), { mode: 0o755 });
    assert.equal(launchCoordinator({ root, planId }).created, null);
    assert.match(fs.readFileSync(calls, 'utf8'), /tab create --workspace w3 /);
    // closed: a workspace of its own again, named after the folder
    fs.writeFileSync(calls, '');
    fs.writeFileSync(fake, script([{ pane_id: 'w1:p1', workspace_id: 'w1', cwd: os.tmpdir() }]), { mode: 0o755 });
    const r = launchCoordinator({ root, planId });
    const log = fs.readFileSync(calls, 'utf8');
    assert.match(log, new RegExp(`workspace create --cwd ${dir} --label ${path.basename(dir)} --focus`));
    assert.match(log, /tab rename w8:t1 plan: Test plan/);
    assert.deepEqual([r.pane, r.created?.tab], ['w8:p1', 'w8:t1']);
    // the human quit it, its shell stayed: closed only when asked to (the board asks first)
    fs.writeFileSync(fake, script([{ pane_id: 'w8:p1', workspace_id: 'w8', cwd: dir, label: 'lead' }]), { mode: 0o755 });
    fs.writeFileSync(calls, '');
    const kept = launchCoordinator({ root, planId });
    assert.equal(kept.leftover, 'w8:p1');
    assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /pane close w8:p1/);
    fs.writeFileSync(fake, script([{ pane_id: 'w8:p1', workspace_id: 'w8', cwd: dir, label: 'lead' }]), { mode: 0o755 });
    const reg = JSON.parse(fs.readFileSync(path.join(state, 'agents.json'), 'utf8'));
    for (const v of Object.values(reg)) if (v.actor === 'lead') v.pane = 'w8:p1'; // as before the second start
    fs.writeFileSync(path.join(state, 'agents.json'), JSON.stringify(reg));
    fs.writeFileSync(calls, '');
    const reused = launchCoordinator({ root, planId, reusePane: true });
    const log2 = fs.readFileSync(calls, 'utf8');
    assert.match(log2, /pane split --pane w8:p1 /);
    assert.match(log2, /pane close w8:p1/);
    assert.deepEqual([reused.pane, reused.leftover], ['w8:p2', null]);
  } finally {
    process.env = saved;
  }
});
test('herdr notifications: once per item that needs the human; terminal toast, bell and progress mark', async () => {
  const { dir, run } = sandbox(); // coordinator "lead"
  const sub = { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' };
  run(['add', 'api', '--assign', 'be', '--reviewer', 'human']); // T1: the human reviews it
  run(['add', 'db', '--assign', 'be']); // T2
  run(['start', 'T1'], sub);
  const root = path.join(dir, '.atf');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-state-'));
  const calls = path.join(state, 'calls.log');
  const fake = path.join(state, 'herdr');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${calls}'\necho '{"result":{}}'\n`, { mode: 0o755 });
  const tty = path.join(state, 'tty'); // stands in for the herdr client's terminal
  fs.writeFileSync(tty, '');
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_BIN_PATH: fake, HERDR_PLUGIN_STATE_DIR: state, HERDR_ENV: '1', ATF_REGISTRY: path.join(dir, 'registry.json') });
  delete process.env.HERDR_SOCKET_PATH;
  try {
    const { notifyTick, notifyConfig } = await import('../adapters/herdr/lib/notify.mjs');
    // a live coordinator, busy: nothing needs the human yet
    const lead = { name: 'lead', pane_id: 'w1:p1', agent_status: 'working', cwd: dir };
    const idx = (...list) => new Map(list.flatMap((a) => [[`pane:${a.pane_id}`, a], [`name:${a.name}`, a], [`names:${a.name}`, [a]]]));
    const cfg = notifyConfig({ terminal: ['toast', 'bell', 'progress'], settle_seconds: 0 });
    const tick = (agents = idx(lead)) => notifyTick({ agents, roots: [root], ttys: [tty], cfg });
    let r = tick();
    assert.deepEqual([r.count, r.sent], [0, 0]);
    assert.equal(fs.readFileSync(tty, 'utf8'), '', 'nothing waits: no mark either');
    // T1 goes to the human's review: one notification, through herdr and the terminal
    run(['review', 'T1', '-m', 'check the API'], sub);
    r = tick();
    assert.deepEqual([r.count, r.sent], [1, 1]);
    assert.match(fs.readFileSync(calls, 'utf8'), /notification show ATF · Test plan --body T1 waits for your review \(api\) --sound request/);
    assert.equal(fs.readFileSync(tty, 'utf8'), '\x1b]777;notify;ATF · Test plan;T1 waits for your review (api)\x1b\\\x07\x1b]9;4;4;100\x1b\\');
    // ... and only once
    fs.writeFileSync(calls, '');
    fs.writeFileSync(tty, '');
    assert.equal(tick().sent, 0);
    assert.equal(fs.readFileSync(calls, 'utf8') + fs.readFileSync(tty, 'utf8'), '');
    // a T2 review for the coordinator is not the human's, while the coordinator runs
    run(['start', 'T2'], sub);
    run(['review', 'T2', '-m', 'done'], sub);
    assert.deepEqual([tick().count, fs.readFileSync(calls, 'utf8')], [1, '']);
    // the coordinator stops: its items and "no coordinator" become the human's
    r = tick(idx());
    assert.equal(r.count, 3);
    const said = fs.readFileSync(calls, 'utf8');
    assert.match(said, /notification show ATF · 2 things need you · Test plan --body /);
    assert.ok(said.includes('T2 in review (db)') && said.includes('no coordinator running'));
    // the human approves T1, a coordinator is back and approves T2: the mark goes off
    run(['done', 'T1', '-m', 'approved'], { ATF_ACTOR: 'human', ATF_ROLE: 'human' });
    run(['done', 'T2', '-m', 'ok']);
    fs.writeFileSync(tty, '');
    r = tick();
    assert.deepEqual(r.items.map((i) => i.text), ['all tasks finished: close the plan']);
    assert.match(fs.readFileSync(tty, 'utf8'), /777;notify;ATF · Test plan;all tasks finished/);
    run(['plan', 'status', 'completed', '-m', 'done', '--relay', 'close it']);
    fs.writeFileSync(tty, '');
    assert.equal(tick().count, 0);
    assert.equal(fs.readFileSync(tty, 'utf8'), '\x1b]9;4;0;0\x1b\\', 'nothing waits any more: the mark is cleared');
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
  // closing the plan is the human's decision: the coordinator asks, then records their words
  const w = run(['wait', '--timeout', '200']);
  assert.match(w.note, /all tasks are finished: ask the human whether to close the plan/);
  assert.match(runFail(['plan', 'status', 'completed']).error, /closing the plan is the human's decision: ask them/);
  assert.equal(run(['status']).status, 'active');
  run(['plan', 'status', 'completed', '--relay', 'yes, close it']);
  assert.deepEqual([run(['status']).status, run(['status']).status_message], ['completed', 'yes, close it']);
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

test('herdr board: a plan note goes to the plan in scope; N writes one from every view', () => {
  const { dir, env, run } = sandbox();
  const a = run(['plan', 'new', 'Alpha']).plan;
  const b = run(['plan', 'new', 'Beta']).plan;
  const board = (keys) =>
    JSON.parse(
      execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '120', '40', JSON.stringify(keys)], {
        cwd: dir,
        env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
      }).toString(),
    );
  const notes = (id) => run(['plan', 'show', '--plan', id]).notes.filter((n) => n.actor === 'human').map((n) => n.message);
  // the Plan tab of all plans selects "Beta" (the newest); then "Alpha" alone, on its Plan tab:
  // r there was sent to the plan selected before (rows of the wider scope)
  const f = board(['2', 'p', ...'Alpha', '\r', 'r', ...'for alpha', '\r']);
  assert.match(f.at(-2), /note on plan "Alpha", for its coordinator:/);
  assert.deepEqual([notes(a), notes(b)], [['for alpha'], []]);
  // N in the Log view, at all-projects scope with two plans: you pick the plan
  const g = board(['3', 'N', ...'Beta', '\r', ...'from the log', '\r']);
  assert.match(g[2], /note on plan/); // the picker
  assert.deepEqual(notes(b), ['from the log']);
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
  // deployments: what was deployed and how it ended
  assert.equal(L.classify('helm upgrade --install refund ./charts/refund -n payments --wait'), 'deploy');
  assert.equal(L.classify('kubectl rollout status deployment/ledger -n payments'), 'deploy');
  assert.equal(L.classify('ssh ops sh -c "argocd app sync refund-svc"'), 'deploy');
  assert.equal(L.classify('mvn deploy'), 'maven');
  assert.equal(L.classify('kubectl get pods'), null);
  assert.equal(L.summarizeText('deploy', 'Release "refund" has been upgraded. Happy Helming!\nSTATUS: deployed\n', { cmd: 'helm upgrade --install refund charts/refund -n payments', exit: 0 }).line, 'deployed refund (payments)');
  const rollout = L.summarizeText('deploy', 'error: deployment "ledger" exceeded its progress deadline\n', { cmd: 'kubectl rollout status deploy/ledger', exit: 1 });
  assert.equal(rollout.state, 'failed');
  assert.equal(rollout.line, 'ledger failed: deployment "ledger" exceeded its progress deadline');
  const loop = L.summarizeText('deploy', 'Release "gateway" has been upgraded.\nRelease "refund" has been upgraded.\nRelease "ledger" does not exist. Installing it now.\nRelease "fx" has been upgraded.\n', { cmd: 'for s in gateway refund ledger fx; do helm upgrade --install $s charts/$s; done', exit: 0 });
  assert.equal(loop.line, 'deployed gateway, refund, ledger +1');
  // each target is its own result; a retry of the same one replaces it
  assert.notEqual(L.supersedeKey({ kind: 'deploy', cmd: 'helm upgrade gateway charts/gateway -n s' }), L.supersedeKey({ kind: 'deploy', cmd: 'helm upgrade refund charts/refund -n s' }));
  assert.equal(L.supersedeKey({ kind: 'deploy', cmd: 'kubectl rollout status deploy/ledger -n s' }), L.supersedeKey({ kind: 'deploy', cmd: 'helm upgrade --install ledger charts/ledger -n s' }));
  assert.deepEqual(loop.counts.deployed, ['gateway', 'refund', 'ledger', 'fx']);
  assert.equal(L.summarizeText('deploy', 'Release "gateway" has been upgraded.\n', { cmd: 'helm upgrade gw charts/gw' }).state, 'running');
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
  assert.deepEqual(failed.progress.failures, [{ test: 'RoundingTest#halfUp', id: 'RoundingTest.halfUp', message: 'expected: <3> but was: <2>' }]);
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

test('board text field: cursor moves, edits, wrapped rows, undo, paste', async () => {
  const { textField, keyField, fieldText, fieldRows } = await import('../adapters/herdr/lib/textfield.mjs');
  const f = textField();
  const type = (s) => [...s].forEach((ch) => keyField(f, ch));
  type('hello world');
  keyField(f, '\x1b\r'); // alt+⏎: a new line
  type('second');
  assert.equal(fieldText(f), 'hello world\nsecond');
  keyField(f, '\x1b[A'); // up: same column on the line above
  assert.equal(f.pos, 6);
  type('!');
  assert.equal(fieldText(f), 'hello !world\nsecond');
  keyField(f, '\x1bb'); // alt+b: a word back
  assert.equal(f.pos, 0);
  keyField(f, '\x05'); // ctrl+e: end of the line
  assert.equal(f.pos, 12);
  keyField(f, '\x1b[D');
  keyField(f, '\x7f'); // backspace in the middle
  assert.equal(fieldText(f), 'hello !word\nsecond');
  keyField(f, '\x1b[3~'); // delete forward
  assert.equal(fieldText(f), 'hello !wor\nsecond');
  keyField(f, '\x17'); // ctrl+w: the word before
  assert.equal(fieldText(f), 'hello !\nsecond');
  keyField(f, '\x1a'); // ctrl+z undoes it
  assert.equal(fieldText(f), 'hello !wor\nsecond');
  keyField(f, '\x1b[B'); // down to the second line
  keyField(f, '\x01'); // ctrl+a: its start
  keyField(f, '\x0b'); // ctrl+k: kill to its end, ctrl+y yanks it back
  assert.equal(fieldText(f), 'hello !wor\n');
  keyField(f, '\x19');
  assert.equal(fieldText(f), 'hello !wor\nsecond');
  // a paste keeps its line breaks; ⏎ outside a paste submits, esc cancels
  for (const ch of 'a\rb') keyField(f, ch, { pasting: true });
  assert.equal(fieldText(f), 'hello !wor\nseconda\nb');
  assert.equal(keyField(f, '\r'), 'submit');
  assert.equal(keyField(f, '\x1b'), 'cancel');
  // wrapped rows: the cursor's row stays visible, up/down follow the wrapped rows
  const g = textField('abcdefghij'.repeat(3));
  const { rows, above } = fieldRows(g, 11, 2); // 10 characters a row (one column for the cursor)
  assert.equal(rows.length, 2);
  assert.ok(above);
  assert.deepEqual(rows[1].at(-1), [' ', 'inverse']); // the cursor at the end
  keyField(g, '\x1b[A');
  assert.equal(g.pos, 19); // the row above ends one short: its end is the next row's start
  // single-line fields turn pasted line breaks into spaces and ignore alt+⏎
  const s = textField('x', { multiline: false });
  keyField(s, '\x1b\r');
  keyField(s, '\r', { pasting: true });
  assert.equal(fieldText(s), 'x ');
});

test('board text field, vi mode: motions, operators, text objects, visual, undo, repeat', async () => {
  const { textField, keyField, fieldText, fieldMode, fieldRows } = await import('../adapters/herdr/lib/textfield.mjs');
  const vi = (start, keys) => {
    const f = textField(start, { vi: true });
    assert.equal(fieldMode(f), 'INSERT'); // starts in insert mode: typing works at once
    keyField(f, '\x1b');
    for (const k of keys.match(/<esc>|<cr>|<c-r>|[\s\S]/g)) keyField(f, { '<esc>': '\x1b', '<cr>': '\r', '<c-r>': '\x12' }[k] ?? k);
    return f;
  };
  const cases = [
    ['hello world foo', '0dw', 'world foo'],
    ['hello world foo', '0cwXY<esc>', 'XY world foo'],
    ['hello world foo', '02dw', 'foo'],
    ['hello world foo', '0wde', 'hello  foo'],
    ['a\nb\nc', 'ggdd', 'b\nc'],
    ['a\nb\nc', 'gg2dd', 'c'],
    ['a\nb\nc', 'ggdj', 'c'],
    ['a\nb\nc', 'ggyyp', 'a\na\nb\nc'],
    ['foo(bar, baz)', '0fbci(x<esc>', 'foo(x)'],
    ['say "hi there" ok', '0fhda"', 'say ok'],
    ['one two three', '0wdaw', 'one three'],
    ['one two three', '0wved', 'one  three'],
    ['a\nb\nc', 'ggVjd', 'c'],
    ['abc', '0x.', 'c'],
    ['abc', '0xu<c-r>', 'bc'],
    ['abc', '0ixy<esc>u', 'abc'], // an insert is one undo step
    ['abc def', '0cwX<esc>w.', 'X X'],
    ['a b', 'onew<esc>', 'a b\nnew'],
    ['a\nb', 'ggJ', 'a b'],
    ['abc def', '0dtf', 'f'],
    ['hello world', '0viwU', 'HELLO world'],
    ['abc', '0rZl~', 'ZBc'],
  ];
  for (const [start, keys, want] of cases) assert.equal(fieldText(vi(start, keys)), want, `${JSON.stringify(start)} ${keys}`);
  // ⏎ in insert mode is a new line; it sends from normal and visual mode (a one-line field: always)
  const ins = textField('a', { vi: true });
  assert.equal(keyField(ins, '\r'), null);
  assert.equal(fieldText(ins), 'a\n');
  assert.equal(keyField(textField('a', { vi: true, multiline: false }), '\r'), 'submit');
  assert.equal(keyField(vi('x', '0'), '\r'), 'submit');
  // esc: insert → normal → cancel
  const f = textField('x', { vi: true });
  assert.equal(keyField(f, '\x1b'), null);
  assert.equal(fieldMode(f), 'NORMAL');
  keyField(f, 'd');
  assert.equal(fieldMode(f), 'NORMAL d'); // a pending operator shows
  assert.equal(keyField(f, '\x1b'), null); // esc drops it first
  assert.equal(keyField(f, '\x1b'), 'cancel');
  assert.equal(keyField(vi('x', 'v'), '\r'), 'submit');
  // visual mode highlights the selection
  const g = vi('hello world', '0vl');
  assert.deepEqual(fieldRows(g, 40, 1).rows[0].slice(0, 2), [['h', 'selected'], ['e', 'inverse']]);
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

test('§15 changes: snapshots per task, work package and plan; overlaps; the repo stays untouched', () => {
  const { dir, env, run } = sandbox();
  const app = path.join(dir, 'app');
  const git = (...a) => execFileSync('git', ['-C', app, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  fs.mkdirSync(app);
  git('init', '-q');
  fs.writeFileSync(path.join(app, 'a.txt'), 'one\ntwo\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  run(['add', 'Backend']); // T1
  run(['add', 'Parse', '--parent', 'T1']); // T2
  run(['add', 'Write', '--parent', 'T1']); // T3
  run(['add', 'Docs']); // T4
  run(['start', 'T2']);
  fs.writeFileSync(path.join(app, 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(app, 'n.txt'), 'new\n');
  // while it runs: against the working tree (new untracked files included)
  let d = run(['diff', 'T2']);
  assert.equal(d.mode, 'snapshots');
  assert.deepEqual(d.sets[0].files.map((f) => [f.status, f.path, f.added, f.removed]), [['M', 'a.txt', 2, 1], ['A', 'n.txt', 1, 0]]);
  assert.equal(d.sets[0].target, null);
  run(['done', 'T2', '-m', 'ok']);
  // T3 and T4 at the same time: T4 reported its file, T3 did not
  run(['start', 'T3']);
  run(['start', 'T4']);
  fs.writeFileSync(path.join(app, 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(app, 'README.md'), '# docs\n');
  run(['artifact', 'T4', 'app/README.md']);
  run(['done', 'T3', '-m', 'ok']);
  run(['done', 'T4', '-m', 'ok']);
  const files = (r) => r.sets.flatMap((s) => s.files.map((f) => f.path));
  d = run(['diff', 'T4']);
  assert.deepEqual(files(d), ['README.md']);
  assert.deepEqual([d.sets[0].overlap, d.sets[0].narrowed], [['T3'], true]);
  d = run(['diff', 'T3']);
  assert.deepEqual(files(d), ['b.txt', 'README.md'], 'no files reported: the whole window, flagged');
  assert.deepEqual(d.sets[0].overlap, ['T4']);
  // the work package: its subtasks combined, from the first start to the last end
  d = run(['diff', 'T1']);
  assert.deepEqual(files(d), ['a.txt', 'b.txt', 'n.txt', 'README.md']);
  assert.deepEqual(d.sets[0].files.find((f) => f.path === 'a.txt').tasks, ['T2']);
  d = run(['diff']);
  assert.deepEqual(d.totals, { files: 4, added: 5, removed: 1 });
  // --file, --patch, and the viewer commands
  assert.deepEqual(files(run(['diff', 'T1', '--file', 'app/n.txt'])), ['n.txt']);
  assert.match(run(['diff', 'T2', '--patch']).patch, /^\+TWO$/m);
  const cmd = (tool, extra = {}) => run(['diff', 'T1', '--open', ...(tool ? ['--tool', tool] : [])], extra).command;
  assert.match(cmd('diffview'), /^nvim -c 'DiffviewOpen -C\S+app [0-9a-f]{40}\.\.[0-9a-f]{40} -- a\.txt b\.txt n\.txt README\.md'/);
  assert.match(cmd(null), /git -C '\S+app' --no-pager diff --stat [0-9a-f]{40} [0-9a-f]{40} -- 'a\.txt'.*\| less -R$/);
  assert.match(cmd(null, { ATF_DIFF_TOOL: 'mytool {repo} {range}' }), /^mytool '\S+app' [0-9a-f]{40}\.\.[0-9a-f]{40}$/);
  // nothing in the repo changed: no staged files, untracked stay untracked, refs only under refs/atf
  assert.equal(git('status', '--porcelain'), ' M a.txt\n?? README.md\n?? b.txt\n?? n.txt\n');
  assert.deepEqual(git('for-each-ref', '--format=%(refname)').trim().split('\n').filter((r) => !r.startsWith('refs/atf/')), ['refs/heads/' + git('branch', '--show-current').trim()]);
  // a second repo: T6 works in web while T5 works in app; T6 reported its file, so the app
  // change T5 made at the same time is not T6's
  const web = path.join(dir, 'web');
  fs.mkdirSync(web);
  execFileSync('git', ['-C', web, 'init', '-q']);
  run(['add', 'App fix']); // T5
  run(['add', 'Web page']); // T6
  run(['start', 'T5']);
  run(['start', 'T6']);
  fs.writeFileSync(path.join(app, 'fix.txt'), 'fix\n');
  fs.writeFileSync(path.join(web, 'index.html'), '<p>hi</p>\n');
  run(['artifact', 'T6', 'web/index.html']);
  run(['done', 'T6', '-m', 'ok']);
  run(['done', 'T5', '-m', 'ok']);
  const t6 = run(['diff', 'T6']);
  assert.deepEqual(t6.sets.map((s) => [s.rel, s.files.map((f) => f.path)]), [['web', ['index.html']]]);
  assert.ok(run(['diff', 'T5']).sets.some((s) => s.rel === 'app' && s.files.some((f) => f.path === 'fix.txt')));
  // the board: 4 Changes, files under their tasks; d on a file opens its diff (outside herdr: the command)
  const frames = JSON.parse(
    execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '400', '40', JSON.stringify(['4', 'x', 'x', 'x', '\x1b[B', '\x1b[B', '\x1b[B', 'd'])], {
      cwd: dir,
      env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
    }).toString(),
  );
  const view = frames.at(-2);
  assert.match(view, /▾ Test plan .*6 files \+7 -1 {2}\(snapshots\)/);
  assert.match(view, /T1 ● Backend +4 files \+5 -1  ⚠ overlaps T4/);
  assert.match(view, /M app\/a\.txt +\+2 -1/);
  assert.match(view, /T3 ● Write .*⚠ overlaps T4/);
  assert.match(frames.at(-1), /run: ATF_DIR=.* 'diff' 'T2' .*'--open' '--file' 'app\/a\.txt'/);
  // a closed plan: the board starts wider than the plan, where it is hidden with a note;
  // f shows it (its changes stay readable)
  run(['plan', 'status', 'completed', '-m', 'finished', '--relay', 'close it']);
  const closed = JSON.parse(
    execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '400', '40', JSON.stringify(['4', 'f', 'x', 'x', 'x'])], {
      cwd: dir,
      env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
    }).toString(),
  );
  assert.match(closed[1], /1 closed plan hidden: f shows them/);
  assert.doesNotMatch(closed[1], /Test plan/);
  assert.match(closed.at(-1), /Test plan .*6 files \+7 -1/);
});

test('§15 changes: "artifacts" takes only what agents report (files, commits)', () => {
  const { dir, env, run } = sandbox();
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  git('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.atf/\nregistry.json\nherdr-config/\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.appendFileSync(path.join(dir, '.atf', 'config.toml'), 'changes = "artifacts"\n');
  run(['add', 'Work']);
  run(['start', 'T1']);
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  git('add', 'c.txt');
  git('commit', '-qm', 'c');
  run(['artifact', 'T1', git('rev-parse', 'HEAD').trim(), '--kind', 'commit']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nmore\n');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'not reported\n');
  run(['artifact', 'T1', 'a.txt']);
  run(['done', 'T1', '-m', 'ok']);
  const plan = fs.readdirSync(path.join(dir, '.atf', 'plans'))[0];
  assert.ok(!fs.readFileSync(path.join(dir, '.atf', 'plans', plan, 'events.jsonl'), 'utf8').includes('task.snapshot'));
  const d = run(['diff', 'T1']);
  assert.equal(d.mode, 'artifacts');
  assert.deepEqual(d.sets[0].files.map((f) => [f.status, f.path]), [['M', 'a.txt'], ['A', 'c.txt']]);
  // a file reported, then committed: read from HEAD at the report, so it stays in the diff;
  // reported from a subdirectory, it is still found
  run(['add', 'More']);
  run(['start', 'T2']);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'd.txt'), 'd\n');
  execFileSync('node', [ATF, 'artifact', 'T2', 'd.txt'], { cwd: path.join(dir, 'sub'), env: { ...env, ATF_DIR: path.join(dir, '.atf') } });
  git('add', '.');
  git('commit', '-qm', 'everything');
  run(['done', 'T2', '-m', 'ok']);
  assert.deepEqual(run(['diff', 'T2']).sets[0].files.map((f) => [f.status, f.path]), [['A', 'sub/d.txt']]);
});

test('config: TOML files, old config.json still read, atf config [migrate]', async () => {
  const { parseToml, stringifyToml } = await import('../src/toml.mjs');
  const text = `# comment
protocol = 1
changes = "snapshots" # trailing comment
hex = 0x1f
big = 1_000
lit = 'C:\\dir'
multi = '''
two
lines'''
nested = [[1, 2], ["a"]]
inline = { a = 1, "b c" = true }
dotted.key = "v"

[agents.pi]
start = ["--skill", "{skill}"]

[[list]]
n = 1
[[list]]
n = 2
`;
  const data = parseToml(text);
  assert.deepEqual(data, {
    protocol: 1, changes: 'snapshots', hex: 31, big: 1000, lit: 'C:\\dir', multi: 'two\nlines',
    nested: [[1, 2], ['a']], inline: { a: 1, 'b c': true }, dotted: { key: 'v' },
    agents: { pi: { start: ['--skill', '{skill}'] } }, list: [{ n: 1 }, { n: 2 }],
  });
  assert.deepEqual(parseToml(stringifyToml(data)), data, 'what ATF writes reads back the same');
  assert.throws(() => parseToml('tool = diffview'), /line 1: expected a value \(strings need quotes: "diffview"\)/);
  assert.throws(() => parseToml('a = 1\n[x]\nb = 2\n[x]'), /line 4: \[x\] is defined twice/);

  // the files: project (.atf), user (XDG_CONFIG_HOME/atf), herdr plugin; JSON before TOML
  const { dir, env, run } = sandbox();
  const user = path.join(env.XDG_CONFIG_HOME, 'atf');
  const plugin = env.HERDR_PLUGIN_CONFIG_DIR;
  fs.mkdirSync(user, { recursive: true });
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(user, 'config.json'), JSON.stringify({ diff: { tool: 'difftool' } }));
  fs.writeFileSync(path.join(plugin, 'config.toml'), 'vi_mode = yes\n'); // a mistake
  let c = run(['config']);
  const by = (w) => c.files.find((f) => f.what === w);
  assert.equal(by('project').format, 'toml');
  assert.deepEqual([by('user').format, by('user').keys], ['json', ['diff']]);
  assert.match(by('plugin').error, /line 1: expected a value/);
  // the old user file is still used (here: the diff viewer)
  const { diffTool } = await import('../src/changes.mjs');
  const xdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  delete process.env.ATF_DIFF_TOOL;
  try {
    assert.equal(diffTool(), 'difftool');
  } finally {
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdg;
  }
  c = run(['config', 'migrate']);
  assert.deepEqual(c.migrated.map((m) => m.what), ['user']);
  assert.ok(!fs.existsSync(path.join(user, 'config.json')));
  assert.equal(fs.readFileSync(path.join(user, 'config.toml'), 'utf8'), '# ATF: your own settings (atf config shows the files in use).\n\n[diff]\ntool = "difftool"\n');
  // init: a template with every option commented out; never over an existing file
  assert.equal(run(['config', 'init']).created, false, 'the user file exists now');
  fs.rmSync(path.join(user, 'config.toml'));
  const made = run(['config', 'init']);
  assert.equal(made.created, true);
  const tpl = fs.readFileSync(made.file, 'utf8');
  assert.match(tpl, /^# tool = "git"$/m);
  assert.match(tpl, /^# terminal = \["toast", "bell", "progress"\]/m);
  assert.deepEqual(parseToml(tpl), { diff: {}, notify: {} }, 'all defaults: nothing set');
  fs.rmSync(path.join(plugin, 'config.toml'));
  assert.deepEqual(parseToml(fs.readFileSync(run(['config', 'init', 'plugin']).file, 'utf8')), {});
  // the project's: written by atf init, commented; ATF's own changes keep the comments
  const projCfg = path.join(dir, '.atf', 'config.toml');
  let ptext = fs.readFileSync(projCfg, 'utf8');
  assert.match(ptext, /^protocol = 1$/m);
  assert.match(ptext, /^# changes = "snapshots"$/m);
  fs.writeFileSync(projCfg, ptext.replace('# changes = "snapshots"', 'changes = "artifacts" # mine'));
  const { readConfig, writeConfig } = await import('../src/store.mjs');
  const root = path.join(dir, '.atf');
  writeConfig(root, { ...readConfig(root), hooks: { post_write: [['/bin/hook', 'x']] } }); // as enable-sync does
  ptext = fs.readFileSync(projCfg, 'utf8');
  assert.match(ptext, /^changes = "artifacts" # mine$/m, 'comments and layout stay');
  assert.match(ptext, /^# Where a task's changed files come from/m);
  assert.match(ptext, /\n\[hooks\]\npost_write = \[\["\/bin\/hook", "x"\]\]\n$/);
  writeConfig(root, { ...readConfig(root), hooks: { post_write: [] } });
  assert.deepEqual(readConfig(root), { protocol: 1, changes: 'artifacts', hooks: { post_write: [] } });
  assert.equal((fs.readFileSync(projCfg, 'utf8').match(/^\[hooks\]/gm) || []).length, 1, 'the section is replaced, not added again');
  assert.equal(by('plugin').format, 'toml', 'a file with errors is left alone');
  // an old project config.json (no config.toml) is still read
  fs.rmSync(path.join(dir, '.atf', 'config.toml'));
  fs.writeFileSync(path.join(dir, '.atf', 'config.json'), JSON.stringify({ protocol: 1, changes: 'artifacts' }));
  assert.equal(readConfig(path.join(dir, '.atf')).changes, 'artifacts');
});

test('board: notes wrap to the pane width, long words included, nothing cut off', () => {
  const { dir, env, run } = sandbox(); // coordinator "lead"
  run(['add', 'Cart API', '--assign', 'be']);
  run(['start', 'T1'], { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' });
  const long = 'Please keep the session handling: /very/long/path/to/src/services/checkout/session-handling-implementation.ts depends on it. Also cover the empty cart case.';
  run(['note', 'T1', long]);
  const frames = JSON.parse(
    execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '60', '50', JSON.stringify(['\x1b[B', '\r'])], {
      cwd: dir,
      env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
    }).toString(),
  );
  const text = (f) => f.split('\n').map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');
  for (const f of [frames[1], frames[2]]) {
    // the overview's "notes from others", then the task details
    assert.ok(f.split('\n').every((l) => [...l].length <= 60), 'no line wider than the pane');
    assert.match(text(f), /Please keep the session handling:/);
    assert.match(text(f), /Also cover the empty cart case\./, 'the end of the note is there');
    assert.match(f.replace(/\n\s*/g, ''), /session-handling-implementation\.ts/, 'a long path is split, not cut');
  }
  assert.match(frames[1], /notes from others\n\s+lead\s+\d+s ago/);
});

test('board: Neovim-style scrolling in long views (G, gg, ctrl+d / ctrl+u)', () => {
  const { dir, env, run } = sandbox();
  run(['add', 'Cart API', '--assign', 'be']);
  run(['start', 'T1'], { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' });
  for (let i = 1; i <= 6; i++) run(['note', 'T1', `note ${i}: ${'a long remark that wraps over several lines of the narrow board '.repeat(2)}`]);
  // the Overview, T1, ⏏ details; then G, gg, ctrl+d, ctrl+u
  const frames = JSON.parse(
    execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '60', '22', JSON.stringify(['\x1b[B', '\r', 'G', 'g', 'g', '\x04', '\x15'])], {
      cwd: dir,
      env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
    }).toString(),
  );
  const [, , top, end, , gg, half, back] = frames.map((f) => f.replace(/\d+s ago/g, 'Ns ago'));
  assert.match(top, /T1 ◐ in_progress {2}Cart API/);
  assert.doesNotMatch(top, /activity/, 'the details are longer than the pane');
  assert.match(end, /activity\n.*todo → in_progress/, 'G: the end');
  assert.doesNotMatch(end, /T1 ◐ in_progress/);
  assert.equal(gg, top, 'gg: back to the top');
  assert.notEqual(half, top, 'ctrl+d: down');
  assert.doesNotMatch(half, /todo → in_progress/, 'half a page, not to the end');
  assert.equal(back, top, 'ctrl+u: up again');
});

test('§14 live: views in sections with items (plugin contract), compact maven view, a failure in full', async () => {
  const L = await import('../src/live.mjs');
  // a plugin's view: plain segment lines (as before), section headings and items
  L.registerLiveKind({
    kind: 'secttest',
    summarize: () => ({ state: 'ok', line: 'x', counts: {}, details: [] }),
    view: (s, { full }) => (full ? [{ section: 'jobs', note: '2', folded: true }, { segments: [['✗ build', 'red']], item: 'j1' }, [['✓ lint', 'green']], 'not a line'] : [[['2 jobs', 'dim']]]),
    item: (s, id) => [[[`job ${id}`, 'bold']]],
  }, 'test');
  const x = { kind: 'secttest', ref: '/dev/null' };
  const v = L.liveView(x, {}, { full: true });
  assert.equal(v.length, 3, 'what is not a line is dropped');
  assert.deepEqual([v[0].section, v[0].folded, v[0].map((s) => s[0]).join('')], ['jobs', true, 'jobs  2']);
  assert.deepEqual([v[1].item, v[1][0]], ['j1', ['✗ build', 'red']]);
  assert.deepEqual(v[2], [['✓ lint', 'green']], 'plain lines unchanged');
  assert.deepEqual(L.liveItem(x, {}, 'j1'), [[['job j1', 'bold']]]);
  assert.equal(L.liveItem({ kind: 'log', ref: '/dev/null' }, {}, 'a'), null, 'no item function: null');
  assert.match(L.checkKind({ kind: 'bad', summarize() {}, item: 3 }), /item must be a function/);

  // maven: compact however many modules (≤ 8 lines); full: sections, failures as items
  const mods = ['core', 'api', 'web', 'cli', 'db', 'auth'];
  const log = ['[INFO] Reactor Build Order:', ...mods.map((m) => `[INFO]   demo-${m} [jar]`), '[INFO] ',
    ...mods.slice(0, 4).flatMap((m, i) => [`[INFO] --------------------------< com.demo:${m} >---------------------------`, `[INFO] Building ${m} 1.0 [${i + 1}/6]`, `[INFO] Running com.demo.${m}.ATest`, `[INFO] Tests run: 3, Failures: ${m === 'api' ? 1 : 0}, Errors: 0, Skipped: 0, Time elapsed: 1.2 s - in com.demo.${m}.ATest`]),
    '[ERROR] com.demo.api.ATest.refund  Time elapsed: 0.3 s  <<< FAILURE!', 'org.opentest4j.AssertionFailedError: expected: <200> but was: <500>', '\tat com.demo.api.ATest.refund(ATest.java:42)', '',
    '[INFO] Running com.demo.cli.BTest'].join('\n');
  const s = L.summarizeText('maven', log);
  const text = (ls) => ls.map((l) => l.map(([t]) => t).join('')).join('\n');
  const compact = L.liveView({ kind: 'maven', ref: '/dev/null', active: true }, s, { width: 90, active: true });
  assert.ok(compact.length <= 8, `compact: ${compact.length} lines`);
  assert.match(text(compact), /modules {2}3 ✓ {2}1 ⚙ {2}2 ○/);
  assert.doesNotMatch(text(compact), /demo-db/, 'pending modules are counted, not listed');
  const full = L.liveView({ kind: 'maven', ref: '/dev/null' }, s, { width: 90, full: true });
  assert.deepEqual(full.filter((l) => l.section).map((l) => l.section), ['modules', 'failures', 'test classes']);
  assert.deepEqual(full.filter((l) => l.item).map((l) => l.item), ['com.demo.api.ATest.refund']);
  // the failure in full: from the build output without a report …
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-item-'));
  fs.writeFileSync(path.join(dir, 'out.log'), log);
  const fromLog = text(L.mavenFailure('com.demo.api.ATest.refund', { cwd: dir, file: path.join(dir, 'out.log') }));
  assert.match(fromLog, /from the build output/);
  assert.match(fromLog, /at com\.demo\.api\.ATest\.refund\(ATest\.java:42\)/);
  // … and from the run's report, with its stack trace
  const rd = path.join(dir, 'api', 'target', 'surefire-reports');
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'TEST-com.demo.api.ATest.xml'), '<testsuite name="com.demo.api.ATest" tests="1" failures="1"><testcase name="refund" classname="com.demo.api.ATest" time="0.3"><failure message="expected: &lt;200&gt; but was: &lt;500&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <200> but was: <500>\n\tat org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:55)\n\tat com.demo.api.ATest.refund(ATest.java:42)\n]]></failure></testcase></testsuite>');
  const item = L.mavenFailure('com.demo.api.ATest#refund', { cwd: dir });
  assert.match(text(item), /failure · org\.opentest4j\.AssertionFailedError/);
  assert.match(text(item), /expected: <200> but was: <500>/);
  const frame = (re) => item.find((l) => re.test(l.map(([t]) => t).join('')))?.[0][1];
  assert.equal(frame(/AssertionUtils\.fail/), 'gray', "the framework's frames are dim");
  assert.equal(frame(/ATest\.refund\(ATest/), '', "the project's own frames stand out");
  assert.match(text(item), /api\/target\/surefire-reports\/TEST-com\.demo\.api\.ATest\.xml/);
});

test('board: L opens the live view in the board (sections fold, ⏎ a failure in full, t raw output)', () => {
  const { dir, env, run } = sandbox();
  run(['add', 'Build it']);
  const mods = ['core', 'api', 'web', 'cli', 'db', 'auth'];
  const log = ['[INFO] Reactor Build Order:', ...mods.map((m) => `[INFO]   demo-${m} [jar]`), '[INFO] ',
    ...mods.slice(0, 4).flatMap((m, i) => [`[INFO] --------------------------< com.demo:${m} >---------------------------`, `[INFO] Building ${m} 1.0 [${i + 1}/6]`, `[INFO] Running com.demo.${m}.ATest`, `[INFO] Tests run: 3, Failures: ${m === 'api' ? 1 : 0}, Errors: 0, Skipped: 0, Time elapsed: 1.2 s - in com.demo.${m}.ATest`]),
    '[INFO] Running com.demo.cli.BTest'].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'build.log'), log);
  run(['artifact', 'T1', 'build.log', '--live', '--kind', 'maven', '--cwd', dir]);
  const rd = path.join(dir, 'api', 'target', 'surefire-reports');
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'TEST-com.demo.api.ATest.xml'), '<testsuite name="com.demo.api.ATest" tests="3" failures="1"><testcase name="refund" classname="com.demo.api.ATest" time="0.3"><failure message="expected: &lt;200&gt; but was: &lt;500&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <200> but was: <500>\n\tat com.demo.api.ATest.refund(ATest.java:42)\n]]></failure></testcase></testsuite>');
  const render = (keys) =>
    JSON.parse(
      execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '90', '34', JSON.stringify(keys)], {
        cwd: dir,
        env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
      }).toString(),
    );
  const open = ['\r', '1', '\r', 'L']; // plan scope, Tasks, the task's details, L
  const f = render([...open, '/', ...'refund', '\r', '\r', '\x1b', '\x1b', 'z', 't', '\x1b']);
  const at = (i) => f[open.length + i];
  const lv = at(0);
  assert.match(lv, /T1 Build it/);
  assert.match(lv, /▾ modules {2}3\/6 done/);
  assert.match(lv, /○ demo-auth/, 'every module, not a compact summary');
  assert.match(lv, /▾ failures {2}1/);
  assert.match(lv, /▾ test classes {2}4/);
  assert.match(lv, /G follow/);
  const item = f.at(-6); // ⏎ on the failure the search selected
  assert.match(item, /ATest#refund/);
  assert.match(item, /at com\.demo\.api\.ATest\.refund\(ATest\.java:42\)/);
  assert.match(item, /esc\/← back to the live view/);
  assert.match(f.at(-5), /▾ failures/, 'esc: back in the live view');
  assert.doesNotMatch(f.at(-5), /stack trace\n.*AssertionUtils/);
  const folded = f.at(-3);
  assert.match(folded, /▸ modules {2}3\/6 done {2}\(6 lines\)/, 'z folds every section');
  assert.match(folded, /▸ failures .*\(1 line\)/);
  assert.doesNotMatch(folded, /demo-auth/);
  const raw = f.at(-2);
  assert.match(raw, /\[INFO\] Running com\.demo\.cli\.BTest/, 't: the raw output, from its end');
  assert.match(raw, /t view/);
  assert.match(f.at(-1), /live {2}L live view/, 'esc: back in the task details');
});

test('board: / searches the view; n / N between matches, esc ends it', () => {
  const { dir, env, run } = sandbox();
  run(['add', 'Alpha']);
  run(['add', 'Beta', '--assign', 'be']);
  run(['add', 'Gamma']);
  run(['start', 'T2'], { ATF_ACTOR: 'be', ATF_ROLE: 'subagent' });
  for (let i = 1; i <= 6; i++) run(['note', 'T2', `note ${i}: ${'a remark long enough to wrap over the narrow board '.repeat(2)}`]);
  const render = (keys) =>
    JSON.parse(
      execFileSync('node', [path.join(path.dirname(ATF), '..', 'test', 'render-board.mjs'), '60', '22', JSON.stringify(keys)], {
        cwd: dir,
        env: { ...env, HERDR_ENV: '0', HERDR_PLUGIN_ID: '' },
      }).toString(),
    ).map((f) => f.replace(/\d+[smh] ago/g, 'N ago'));
  // Tasks: the match's row is selected (⏎ then opens it); smartcase: "Gam" is case-sensitive
  let f = render(['1', '/', 'G', 'a', 'm', '\r', '\r']);
  assert.match(f.at(-2), /\/Gam {2}1\/1 {3}n \/ N next \/ previous {3}esc end search/);
  assert.match(f.at(-1), /T3 ○ todo {2}Gamma/);
  // the task details: scrolled to the match; n wraps around; esc ends the search, not the view
  f = render(['1', '/', 'B', 'e', 't', 'a', '\r', '\r', '/', 'n', 'o', 't', 'e', ' ', '6', '\r', 'n', '\x1b', '\x1b']);
  const [found, again, ended, back] = f.slice(-4);
  assert.match(found, /note 6: a remark/);
  assert.doesNotMatch(found, /T2 ◐ in_progress/, 'scrolled down to it');
  assert.match(found, /\/note 6 {2}1\/1/);
  assert.equal(again, found, 'n: the only match again');
  assert.doesNotMatch(ended, /\/note 6/);
  assert.match(ended, /note 6: a remark/, 'esc ends the search where it is');
  assert.doesNotMatch(back, /note 6: a remark/, 'a second esc leaves the details');
  // text only in the selected task's preview (below the rows): ⏎ opens its details at the match
  // (at plan scope, where Tasks shows the selected task's preview: ⏎ on the plan first)
  const toBeta = ['\r', '1', '/', 'B', 'e', 't', 'a', '\r', '\x1b'];
  f = render([...toBeta, '/', 'r', 'e', 'm', 'a', 'r', 'k']);
  assert.match(f.at(-1), /no row matches; 12 in T2's details: ⏎ opens them/);
  f = render([...toBeta, '/', 'r', 'e', 'm', 'a', 'r', 'k', '\r', 'n']);
  assert.match(f.at(-2), /\/remark {2}1\/12/, 'in the details now');
  assert.match(f.at(-1), /\/remark {2}2\/12/, 'n: on to the next match there');
  // two matches on one line are two matches: n / N step between them
  run(['note', 'T3', 'foo and foo again']);
  f = render(['\r', '1', '/', 'G', 'a', 'm', '\r', '\x1b', '\r', '/', 'f', 'o', 'o', '\r', 'n', 'n', 'N']);
  assert.deepEqual(f.slice(-4).map((x) => x.match(/\/foo {2}(\d+\/\d+)/)?.[1]), ['1/2', '2/2', '1/2', '2/2']);
});
