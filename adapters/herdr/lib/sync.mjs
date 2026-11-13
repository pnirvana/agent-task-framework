// Project ATF state onto herdr: task labels on agent panes, plan progress as
// workspace sidebar tokens, and notifications for statuses that need a human.
// Stateless: every run recomputes the full desired state from the event logs.
import { TERMINAL } from '../../../src/core.mjs';
import { listPlanIds, loadPlan, readEvents, getCurrentPlan } from '../../../src/store.mjs';
import { herdr, notify } from './herdr.mjs';

const SOURCE = 'atf';
const GLYPH = { todo: '○', in_progress: '◐', blocked: '⊘', review: '◎', done: '●', failed: '✗', cancelled: '–' };
const RANK = { blocked: 0, review: 1, in_progress: 2, todo: 3 }; // which task a pane shows first

export function progressText(s) {
  const c = s.counts;
  const leaves = Object.values(c).reduce((a, b) => a + b, 0) - (c.cancelled || 0);
  const parts = [`${c.done}/${leaves} ✓`];
  if (c.in_progress) parts.push(`${c.in_progress} ◐`);
  if (c.review) parts.push(`${c.review} ◎`);
  if (c.blocked) parts.push(`${c.blocked} ⊘`);
  if (c.failed) parts.push(`${c.failed} ✗`);
  return parts.join(' ');
}

function activePlans(root) {
  return listPlanIds(root)
    .map((id) => loadPlan(root, id))
    .filter((s) => s.status === 'active' || s.status === 'paused');
}

/**
 * Compute desired metadata:
 *  panes:      paneId -> { title, tokens } | null (clear)
 *  workspaces: wsId   -> tokens
 */
export function desiredState(root, extraWorkspace) {
  const plans = activePlans(root);
  const current = getCurrentPlan(root);
  const panes = new Map();
  const wsPlan = new Map(); // workspace -> plan state shown in sidebar

  for (const s of plans) {
    for (const actor of Object.values(s.actors)) {
      const pane = actor.ctx?.herdr_pane;
      if (!pane) continue;
      const tasks = actor.tasks.map((id) => s.tasks[id]).sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
      const t = tasks[0];
      const prev = panes.get(pane);
      if (t) {
        const rank = RANK[t.status] ?? 9;
        if (!prev || prev.rank > rank)
          panes.set(pane, {
            rank,
            title: `${t.id} · ${t.title}`,
            tokens: {
              atf_task: t.id,
              atf_status: `${GLYPH[t.status]} ${t.status.replace('_', ' ')}${t.status === 'in_progress' && t.percent != null ? ` ${t.percent}%` : ''}`,
              atf_plan: s.title,
            },
          });
      } else {
        // between tasks: show the work package the agent owns, if any is still open
        const pk = actor.packages.map((id) => s.tasks[id]).find((p) => !TERMINAL.has(p.rollup_status ?? p.status));
        if (pk && (!prev || prev.rank > 5))
          panes.set(pane, {
            rank: 5,
            title: `▣ ${pk.id} · ${pk.title}`,
            tokens: { atf_task: pk.id, atf_status: `▣ ${pk.rollup_percent ?? 0}%`, atf_plan: s.title },
          });
        else if (!prev) panes.set(pane, null);
      }
      const ws = actor.ctx?.herdr_workspace;
      if (ws) consider(wsPlan, ws, s, current);
    }
  }
  if (extraWorkspace && plans.length) {
    const pick = plans.find((p) => p.id === current) || plans.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
    consider(wsPlan, extraWorkspace, pick, current);
  }
  const workspaces = new Map();
  for (const [ws, s] of wsPlan) workspaces.set(ws, { atf_plan: s.title, atf_progress: progressText(s) });
  return { panes, workspaces };
}

function consider(map, ws, s, current) {
  const prev = map.get(ws);
  if (!prev || (s.id === current && prev.id !== current) || (prev.id !== current && (s.updated_at || '') > (prev.updated_at || ''))) map.set(ws, s);
}

export function applyState({ panes, workspaces }) {
  const seq = String(Date.now());
  for (const [pane, m] of panes) {
    const args = ['pane', 'report-metadata', pane, '--source', SOURCE, '--seq', seq];
    if (m) {
      args.push('--title', m.title);
      for (const [k, v] of Object.entries(m.tokens)) args.push('--token', `${k}=${v}`);
    } else {
      args.push('--clear-title', '--clear-token', 'atf_task', '--clear-token', 'atf_status', '--clear-token', 'atf_plan');
    }
    herdr(args); // stale pane ids just fail silently
  }
  for (const [ws, tokens] of workspaces) {
    const args = ['workspace', 'report-metadata', ws, '--source', SOURCE, '--seq', seq];
    for (const [k, v] of Object.entries(tokens)) args.push('--token', `${k}=${v}`);
    herdr(args);
  }
}

export function sync(root, extraWorkspace = process.env.HERDR_WORKSPACE_ID) {
  const desired = desiredState(root, extraWorkspace);
  applyState(desired);
  return desired;
}

/** Notifications for events in [from, to] that need a human. */
export function notifyForEvents(root, planId, from, to) {
  const evs = readEvents(root, planId).filter((e) => e.seq >= from && e.seq <= to);
  const statusEvs = evs.filter((e) => e.type === 'task.status' && ['blocked', 'review', 'failed'].includes(e.data?.status));
  if (!statusEvs.length && !evs.some((e) => e.type === 'task.status' && e.data?.status === 'done')) return;
  const s = loadPlan(root, planId);
  for (const e of statusEvs) {
    const t = s.tasks[e.task];
    notify(`ATF ${e.task} ${e.data.status}: ${t?.title ?? ''}`, `${e.actor?.id ?? '?'}: ${e.data.message ?? ''}`);
  }
  const leaves = s.order.filter((id) => !s.tasks[id].children.length);
  if (leaves.length && leaves.every((id) => TERMINAL.has(s.tasks[id].status)) && evs.some((e) => e.type === 'task.status' && TERMINAL.has(e.data?.status)))
    notify(`ATF plan finished: ${s.title}`, progressText(s), 'done');
}
