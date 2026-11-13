// ATF file store: locate the .atf root, append events under a lock, read + fold.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fold, PROTOCOL_VERSION } from './core.mjs';

export const ROOT_NAME = '.atf';

/**
 * Resolve the ATF root directory:
 *  1. $ATF_DIR
 *  2. nearest ancestor containing .atf/
 *  3. main git worktree's .atf/ (so agents in `git worktree`s share the board)
 */
export function findRoot(cwd = process.cwd()) {
  if (process.env.ATF_DIR) return path.resolve(process.env.ATF_DIR);
  let dir = path.resolve(cwd);
  for (;;) {
    const cand = path.join(dir, ROOT_NAME);
    if (fs.existsSync(cand)) return cand;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const cand = path.join(path.dirname(common), ROOT_NAME);
    if (fs.existsSync(cand)) return cand;
  } catch {}
  return null;
}

export function initRoot(dir = process.cwd()) {
  const root = path.join(path.resolve(dir), ROOT_NAME);
  fs.mkdirSync(path.join(root, 'plans'), { recursive: true });
  const cfg = path.join(root, 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ protocol: PROTOCOL_VERSION }, null, 2) + '\n');
  return root;
}

export const planDir = (root, planId) => path.join(root, 'plans', planId);
export const eventsPath = (root, planId) => path.join(planDir(root, planId), 'events.jsonl');

export function listPlanIds(root) {
  const dir = path.join(root, 'plans');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((p) => fs.existsSync(eventsPath(root, p)));
}

export function getCurrentPlan(root) {
  if (process.env.ATF_PLAN) return process.env.ATF_PLAN;
  const f = path.join(root, 'current');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() || null : null;
}

export function setCurrentPlan(root, planId) {
  fs.writeFileSync(path.join(root, 'current'), planId + '\n');
}

export function readEvents(root, planId) {
  const p = eventsPath(root, planId);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn trailing line from a crashed writer: skip
    }
  }
  return out;
}

export function loadPlan(root, planId) {
  return fold(readEvents(root, planId));
}

// ---------- locking ----------
const LOCK_STALE_MS = 30_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock(root, planId, fn, timeoutMs = 10_000) {
  const lock = path.join(planDir(root, planId), '.lock');
  fs.mkdirSync(planDir(root, planId), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}@${os.hostname()} ${Date.now()}`);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error(`timeout acquiring lock ${lock}`);
      sleepSync(15 + Math.random() * 35);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Transaction: under the plan lock, fold current state, let `fn(state)` validate
 * and return event drafts ({type, task?, data}), then append them with seq numbers.
 * Also refreshes state.json (a convenience snapshot for frontends).
 */
export function transact(root, planId, actor, fn) {
  const res = withLock(root, planId, () => {
    const events = readEvents(root, planId);
    const state = fold(events);
    const drafts = fn(state) || [];
    let seq = state.last_seq;
    const written = drafts.map((d) => {
      const ev = {
        v: PROTOCOL_VERSION,
        seq: ++seq,
        id: 'ev_' + crypto.randomBytes(6).toString('hex'),
        ts: new Date().toISOString(),
        plan: planId,
        type: d.type,
        ...(d.task ? { task: d.task } : {}),
        actor,
        data: d.data || {},
      };
      return ev;
    });
    if (written.length) {
      fs.mkdirSync(planDir(root, planId), { recursive: true });
      fs.appendFileSync(eventsPath(root, planId), written.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const next = fold(events.concat(written));
      const snap = path.join(planDir(root, planId), 'state.json');
      fs.writeFileSync(snap + '.tmp', JSON.stringify(next, null, 2));
      fs.renameSync(snap + '.tmp', snap);
      return { events: written, state: next };
    }
    return { events: [], state };
  });
  if (res.events.length) runHooks(root, planId, res.events);
  return res;
}

// ---------- hooks ----------
export function readConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(root, cfg) {
  const p = path.join(root, 'config.json');
  fs.writeFileSync(p + '.tmp', JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(p + '.tmp', p);
}

/**
 * Post-write hooks: config.json `hooks.post_write` is a list of argv arrays.
 * Each runs detached and fire-and-forget after a transaction commits, so a slow
 * or broken hook can never block or fail an agent's `atf` call.
 * Env: ATF_DIR, ATF_PLAN, ATF_HOOK_FROM_SEQ, ATF_HOOK_TO_SEQ, ATF_HOOK_TYPES.
 * Set ATF_NO_HOOKS=1 to disable.
 */
export function runHooks(root, planId, events) {
  if (process.env.ATF_NO_HOOKS === '1') return;
  const hooks = readConfig(root).hooks?.post_write;
  if (!Array.isArray(hooks)) return;
  const env = {
    ...process.env,
    ATF_DIR: root,
    ATF_PLAN: planId,
    ATF_HOOK_FROM_SEQ: String(events[0].seq),
    ATF_HOOK_TO_SEQ: String(events[events.length - 1].seq),
    ATF_HOOK_TYPES: [...new Set(events.map((e) => e.type))].join(','),
  };
  for (const argv of hooks) {
    if (!Array.isArray(argv) || !argv.length) continue;
    try {
      const child = spawn(argv[0], argv.slice(1), { env, cwd: path.dirname(root), detached: true, stdio: 'ignore' });
      child.on('error', () => {}); // e.g. ENOENT: never crash the writer
      child.unref();
    } catch {}
  }
}

// ---------- actor identity ----------
/**
 * Build the actor block. Generic env first; harness context is optional
 * enrichment picked up from well-known env vars (herdr, tmux) or ATF_CTX_*.
 */
export function resolveActor(overrides = {}) {
  const env = process.env;
  const ctx = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('ATF_CTX_') && v) ctx[k.slice(8).toLowerCase()] = v;
  }
  if (env.HERDR_PANE_ID) ctx.herdr_pane ??= env.HERDR_PANE_ID;
  if (env.HERDR_WORKSPACE_ID) ctx.herdr_workspace ??= env.HERDR_WORKSPACE_ID;
  if (env.TMUX_PANE) ctx.tmux_pane ??= env.TMUX_PANE;
  const harness =
    overrides.harness || env.ATF_HARNESS || (env.HERDR_ENV === '1' ? 'herdr' : env.TMUX ? 'tmux' : 'shell');
  const actor = {
    id: overrides.id || env.ATF_ACTOR || `${os.userInfo().username}`,
    role: overrides.role || env.ATF_ROLE || 'agent',
    harness,
  };
  if (Object.keys(ctx).length) actor.ctx = ctx;
  return actor;
}

export function newPlanId(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return `${slug || 'plan'}-${crypto.randomBytes(2).toString('hex')}`;
}
