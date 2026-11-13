// Interactive ATF board for a herdr pane (split or popup). Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TERMINAL, driverInbox, planSummary } from '../../../src/core.mjs';
import { listPlanIds, loadPlan, readEvents, getCurrentPlan, eventsPath, transact, resolveActor, readConfig, findRoot, initRoot, knownRoots, projectName } from '../../../src/store.mjs';
import { herdrAsync, agentIndex, inHerdr, sameServer, discoverRoots } from './herdr.mjs';
import { progressText } from './sync.mjs';

const ESC = '\x1b[';
const STYLE = { reset: 0, bold: 1, dim: 2, inverse: 7, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };
const sty = (names) => (names ? names.split(' ').map((n) => `${ESC}${STYLE[n]}m`).join('') : '');
const STATUS = {
  todo: ['○', 'gray'],
  in_progress: ['◐', 'blue'],
  blocked: ['⊘', 'red'],
  review: ['◎', 'magenta'],
  done: ['●', 'green'],
  failed: ['✗', 'red'],
  cancelled: ['–', 'gray'],
};
const AGENT_GLYPH = { working: ['⚙', 'blue'], idle: ['◌', 'yellow'], done: ['✓', 'green'], blocked: ['!', 'red'], unknown: ['?', 'gray'] };
const STALE_MS = 90_000; // task in_progress but its herdr agent idle for this long => flag

/** A line is a list of [text, style] segments; fit() truncates to width before styling. */
function fit(segs, width, fill = false) {
  let out = '';
  let used = 0;
  for (const [text, style] of segs) {
    if (used >= width) break;
    const chars = [...String(text)];
    const take = chars.slice(0, width - used).join('');
    used += Math.min(chars.length, width - used);
    out += style ? sty(style) + take + `${ESC}0m` : take;
  }
  if (fill && used < width) out += ' '.repeat(width - used);
  return out;
}
const wrap = (text, width) => {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width) {
        if (line) lines.push(line);
        line = word.length > width ? word.slice(0, width) : word;
      } else line = (line + ' ' + word).trim();
    }
    lines.push(line);
  }
  return lines;
};
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - Date.parse(ts)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

/**
 * Entry point. With an .atf root: that project's board. Without one (or when asked to
 * start there): the overview of all known projects, offering `i` to create a project
 * in `initDir`.
 */
export function runBoard(opts) {
  const start = opts.start ?? process.env.ATF_BOARD_START ?? (opts.root ? null : 'overview-all');
  return runMain({ ...opts, start, initDir: opts.initDir || process.cwd() });
}

const TABS = [
  ['overview', 'Overview'],
  ['tasks', 'Tasks'],
  ['agents', 'Agents'],
  ['plan', 'Plan'],
  ['log', 'Log'],
];

/**
 * The board. One *scope* applies to every tab:
 *   all projects  ›  project  ›  plan
 * Enter narrows it (on a plan or a project's plan), Esc widens it again, A jumps to all
 * projects. Every tab shows its content for the scope: at plan scope one plan; at the
 * wider scopes all active plans in it, grouped by project and plan. Every row knows its
 * project and plan, so actions (g, s, a, ⏎) work at any scope.
 */
function runMain({ root: initialRoot, popup = false, targetPane = null, spawnCmd, start, initDir }) {
  const out = process.stdout;
  const ui = {
    scope: null, // {level: 'all'|'project'|'plan', root?, plan?}
    tab: 'overview',
    overlay: null, // detail | help
    sel: { overview: 0, tasks: 0, plan: 0 },
    scrolls: {},
    open: new Map(), // plan key -> expanded? (multi-plan Tasks view)
    collapsed: new Set(), // task keys collapsed in the tree
    focus: null, // {root, plan}: plan for the Plan tab when the scope holds several
    cache: new Map(), // plan key -> {mtime, state}
    agents: new Map(),
    agentsSince: new Map(),
    flash: null,
    lastSeq: new Map(), // plan key -> last seq seen (board notifications)
    rows: { overview: [], tasks: [], plan: [] }, // selectable rows of the current draw
    fold: new Map(), // overview: plan key -> 'folded' | 'live' | 'full' (default live; closed plans folded)
    cardFolded: new Set(), // plan tab: plan keys whose card is folded to its title line
    showClosed: false, // wider scopes: also list completed / cancelled plans
    confirm: null, // {action, key, until}: second press confirms
  };
  const keyOf = (root, plan) => `${root}#${plan}`;
  const hookCache = new Map();
  const hasHook = (r) => {
    if (!hookCache.has(r)) hookCache.set(r, (readConfig(r).hooks?.post_write || []).some((h) => h.join(' ').includes('atf-herdr')));
    return hookCache.get(r);
  };
  const view = () => ui.overlay || ui.tab;
  const multi = () => ui.scope.level !== 'plan';

  function flash(msg, style = 'yellow') {
    ui.flash = { msg, style, until: Date.now() + 4000 };
    draw();
  }

  // ---------- data ----------
  function cachedPlan(r, id) {
    const key = keyOf(r, id);
    let mtime = 0;
    try {
      mtime = fs.statSync(eventsPath(r, id)).mtimeMs;
    } catch {}
    const hit = ui.cache.get(key);
    if (hit && hit.mtime === mtime) return hit.state;
    const state = loadPlan(r, id);
    ui.cache.set(key, { mtime, state });
    return state;
  }

  const isOpenStatus = (st) => st.status === 'active' || st.status === 'paused';

  function rootsInScope() {
    const s = ui.scope;
    if (s.level !== 'all') return [s.root];
    const roots = knownRoots();
    for (const r of [initialRoot]) if (r && !roots.includes(r)) roots.unshift(r);
    return roots;
  }

  /** Plans in scope: [{root, id, st, key}], active first, then most recently updated. */
  function scopePlans() {
    const s = ui.scope;
    if (s.level === 'plan') {
      if (!fs.existsSync(eventsPath(s.root, s.plan))) return [];
      try {
        return [{ root: s.root, id: s.plan, st: cachedPlan(s.root, s.plan), key: keyOf(s.root, s.plan) }];
      } catch {
        return [];
      }
    }
    const res = [];
    for (const r of rootsInScope())
      for (const id of listPlanIds(r)) {
        const st = cachedPlan(r, id);
        if (isOpenStatus(st) || ui.showClosed) res.push({ root: r, id, st, key: keyOf(r, id) });
      }
    const rank = (p) => (p.st.status === 'active' ? 0 : p.st.status === 'paused' ? 1 : 2);
    return res.sort((a, b) => rank(a) - rank(b) || (b.st.updated_at || '').localeCompare(a.st.updated_at || ''));
  }

  /** Best plan to open in a project: $ATF_PLAN / current, else the most recent active one. */
  function pickPlan(r) {
    const ids = listPlanIds(r);
    if (!ids.length) return null;
    const pref = [process.env.ATF_PLAN, getCurrentPlan(r)].find((id) => id && ids.includes(id) && isOpenStatus(cachedPlan(r, id)));
    if (pref) return pref;
    const states = ids.map((id) => cachedPlan(r, id));
    const open = states.filter(isOpenStatus).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    return (open[0] || states.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0])?.id ?? null;
  }

  function setScope(scope, { tab, task } = {}) {
    ui.scope = scope;
    if (scope.level === 'plan') ui.focus = { root: scope.root, plan: scope.plan };
    if (tab) ui.tab = tab;
    ui.overlay = null;
    ui.scrolls = {};
    ui.sel = { overview: 0, tasks: 0, plan: 0 };
    if (task) {
      const st = cachedPlan(scope.root, scope.plan);
      for (const pid of st.tasks[task]?.path || []) ui.collapsed.delete(`${keyOf(scope.root, scope.plan)}#${pid}`);
      buildTaskRows();
      ui.sel.tasks = Math.max(0, ui.rows.tasks.findIndex((r) => r.task === task));
    }
  }

  /** Esc: plan -> project -> all projects -> (quit) */
  function widen() {
    const s = ui.scope;
    if (s.level === 'plan') return setScope({ level: 'project', root: s.root });
    if (s.level === 'project') return setScope({ level: 'all' });
    return quit();
  }

  // ---------- herdr liveness ----------
  async function refreshAgents() {
    if (!inHerdr()) return;
    ui.agents = await agentIndex();
    const now = Date.now();
    for (const [k, a] of ui.agents) {
      if (!k.startsWith('pane:')) continue;
      const prev = ui.agentsSince.get(k);
      if (!prev || prev.status !== a.agent_status) ui.agentsSince.set(k, { status: a.agent_status, since: now });
    }
    draw();
  }

  /** Live herdr agent of an actor in plan `st` (only for actors of this herdr server). */
  function liveAgent(st, actorId) {
    if (!actorId) return null;
    const actor = st.actors[actorId];
    if (actor && !sameServer(actor)) return null;
    const a = ui.agents.get(`name:${actorId}`) || (actor?.ctx?.herdr_pane && ui.agents.get(`pane:${actor.ctx.herdr_pane}`));
    if (!a) return null;
    return { ...a, since: ui.agentsSince.get(`pane:${a.pane_id}`)?.since ?? Date.now() };
  }
  function agentFor(st, t) {
    const a = liveAgent(st, t?.owner);
    if (!a) return null;
    const stale = t.status === 'in_progress' && ['idle', 'done'].includes(a.agent_status) && Date.now() - a.since > STALE_MS;
    return { ...a, stale };
  }
  const elsewhere = (st, who) => !!st.actors[who] && !sameServer(st.actors[who]);

  const effStatus = (t) => t.rollup_status ?? t.status;

  // ---------- inbox ----------
  /** driverInbox plus stalled agents (needs live herdr state). */
  function inboxOf(p) {
    const items = driverInbox(p.st).map((it) => ({ ...it, root: p.root, plan: p.id, st: p.st }));
    for (const tid of p.st.order) {
      const t = p.st.tasks[tid];
      if (t.status !== 'in_progress' || t.children.length || !t.owner) continue;
      const a = agentFor(p.st, t);
      if (a?.stale) items.push({ kind: 'stale', task: tid, ts: new Date(a.since).toISOString(), actor: t.owner, message: `${t.owner} idle, task still in progress`, root: p.root, plan: p.id, st: p.st });
    }
    return items;
  }

  // ---------- rendering helpers ----------
  function bar(frac, w) {
    const fill = Math.round(frac * w);
    return [
      ['█'.repeat(fill), 'green'],
      ['░'.repeat(w - fill), 'gray'],
    ];
  }
  const clip = (s, w) => ([...s].length > w ? [...s].slice(0, Math.max(1, w - 1)).join('') + '…' : s.padEnd(w));

  function tabBar() {
    const tabs = [[' ', '']];
    TABS.forEach(([id, label], i) => tabs.push([` ${i} ${label} `, ui.tab === id ? 'inverse bold' : 'dim'], [' ', '']));
    return tabs;
  }

  function header(W, plans) {
    const s = ui.scope;
    const crumbs = [['all projects', s.level === 'all' ? 'bold' : 'dim']];
    if (s.level !== 'all') crumbs.push([' › ', 'dim'], [projectName(s.root), s.level === 'project' ? 'bold' : 'dim']);
    if (s.level === 'plan') {
      const st = plans[0]?.st;
      crumbs.push([' › ', 'dim'], [st?.title ?? s.plan, 'bold']);
      if (st && st.status !== 'active') crumbs.push([`  (${st.status})`, 'yellow']);
    }
    const leaves = plans.reduce((n, p) => n + planSummary(p.st).total - (p.st.counts.cancelled || 0), 0);
    const done = plans.reduce((n, p) => n + (p.st.counts.done || 0), 0);
    const frac = leaves ? done / leaves : 0;
    const inbox = plans.reduce((n, p) => n + inboxOf(p).length, 0);
    const line2 =
      s.level === 'plan' && plans[0]
        ? [[' ', ''], ...bar(plans[0].st.progress, Math.max(8, Math.min(30, W - 40))), [` ${Math.round(plans[0].st.progress * 100)}%  `, 'bold'], [progressText(plans[0].st), 'dim'], [inbox ? `   ⚑ ${inbox} need${inbox === 1 ? 's' : ''} you` : '', 'red bold']]
        : (() => {
            const open = plans.filter((p) => isOpenStatus(p.st)).length;
            const closed = plans.length - open;
            return [[' ', ''], ...bar(frac, Math.max(8, Math.min(30, W - 50))), [` ${Math.round(frac * 100)}%  `, 'bold'], [`${open} active plan${open === 1 ? '' : 's'}${closed ? ` + ${closed} closed` : ''} · ${done}/${leaves} tasks done`, 'dim'], [inbox ? `   ⚑ ${inbox} need${inbox === 1 ? 's' : ''} you` : '', 'red bold']];
          })();
    const nav = s.level === 'plan' ? '   esc: project' : s.level === 'project' ? '   esc: all projects' : '';
    // no "ATF" badge: herdr already titles both the pane and the popup "ATF board"
    return [[[' ', ''], ...crumbs, [nav, 'dim']], line2, tabBar()];
  }

  /** A selected-row aware line: highlight marker + base style. */
  const mark = (selected) => [selected ? ' › ' : '   ', selected ? 'cyan bold' : ''];

  function planHeaderRow(p, W, selected, { open }) {
    const sum = planSummary(p.st);
    const inbox = inboxOf(p).length;
    const pct = Math.round(sum.progress * 100);
    const label = `${ui.scope.level === 'all' ? projectName(p.root) + ' / ' : ''}${p.st.title}`;
    return [
      mark(selected),
      [open ? '▾ ' : '▸ ', 'bold'],
      [clip(label, Math.max(12, Math.min(48, W - 50))) + ' ', (selected ? 'inverse bold' : 'bold')],
      ...bar(sum.progress, 8),
      [` ${String(pct).padStart(3)}% ${p.st.counts.done}/${sum.total} `, 'dim'],
      [inbox ? `⚑${inbox} ` : '', 'red bold'],
      [p.st.status === 'paused' ? 'paused ' : '', 'yellow'],
      [ago(p.st.updated_at), 'dim'],
    ];
  }

  function taskRowLine(row, W, selected) {
    const { st, task: id } = row;
    const t = st.tasks[id];
    const s = effStatus(t);
    const [g, color] = STATUS[s];
    const a = agentFor(st, t);
    const right = [];
    if (t.children.length) {
      const done = t.children.filter((c) => effStatus(st.tasks[c]) === 'done').length;
      right.push([`${done}/${t.children.length}`, 'dim']);
      if (t.assignee) right.push([`▣ ${t.assignee}`, 'cyan bold']);
    } else {
      if (t.status === 'todo' && t.waiting_on.length) right.push([`⧗ ${t.waiting_on.join(',')}`, 'dim']);
      if (t.status === 'blocked' && t.blocked_on.length) right.push([t.can_resume ? 'can resume' : `⧗ on ${t.blocked_on.join(',')}`, t.can_resume ? 'green' : 'dim']);
      if (t.ready && !t.owner) right.push(['ready', 'green']);
      if (t.status === 'in_progress' && t.percent != null) right.push([`${t.percent}%`, 'yellow']);
      if (t.assignee) right.push([t.assignee, 'cyan']);
      else if (t.owner) right.push([`↳${t.owner}`, 'cyan dim']);
      if (a) {
        const [ag, ac] = AGENT_GLYPH[a.agent_status] || AGENT_GLYPH.unknown;
        right.push([ag, ac]);
      } else if (t.owner && elsewhere(st, t.owner)) right.push(['↗', 'gray']);
      if (a?.stale) right.push(['stale?', 'red bold']);
    }
    for (let i = right.length - 1; i > 0; i--) right.splice(i, 0, [' ', '']);
    const rightLen = right.reduce((n, [x]) => n + [...x].length, 0);
    const fold = t.children.length ? (ui.collapsed.has(row.k) ? '▸' : '▾') : ' ';
    const lead = `${selected ? ' › ' : '   '}${multi() ? '  ' : ''}${row.prefix}`;
    const left = `${fold}${t.id} `;
    const titleW = Math.max(4, W - 1 - [...lead].length - [...left].length - 2 - rightLen - 2);
    const base = selected ? 'inverse ' : '';
    return [
      [lead, selected ? 'cyan bold' : 'gray'],
      [left, base + 'bold'],
      [g + ' ', (base + color).trim()],
      [clip(t.title, titleW) + '  ', (base + (t.children.length ? 'bold' : TERMINAL.has(t.status) && t.status !== 'failed' ? 'dim' : '')).trim()],
      ...right,
    ];
  }

  /** Selectable rows of the Tasks tab: plan headers (multi-plan scopes) and task rows. */
  function buildTaskRows() {
    const rows = [];
    for (const p of scopePlans()) {
      const open = !multi() || (ui.open.has(p.key) ? ui.open.get(p.key) : inboxOf(p).length > 0 || p.st.counts.in_progress > 0 || p.st.counts.blocked > 0 || p.st.counts.review > 0);
      if (multi()) rows.push({ type: 'plan', root: p.root, plan: p.id, id: p.id, st: p.st, key: p.key, open, k: p.key });
      if (!open) continue;
      const visit = (id, prefix, isLast, depth) => {
        const k = `${p.key}#${id}`;
        rows.push({ type: 'task', root: p.root, plan: p.id, st: p.st, key: p.key, task: id, k, prefix: depth ? prefix + (isLast ? '└─' : '├─') : '' });
        if (ui.collapsed.has(k)) return;
        const kids = p.st.tasks[id].children;
        kids.forEach((c, i) => visit(c, depth ? prefix + (isLast ? '  ' : '│ ') : '', i === kids.length - 1, depth + 1));
      };
      const roots = p.st.order.filter((id) => !p.st.tasks[id].parent || !p.st.tasks[p.st.tasks[id].parent]);
      roots.forEach((id, i) => visit(id, '', i === roots.length - 1, 0));
      if (!roots.length && multi()) rows.push({ type: 'note', text: '     no tasks yet', key: p.key, k: p.key + '#empty' });
    }
    // keep the selection on the same row when rows change
    const prev = ui.rows.tasks[ui.sel.tasks]?.k;
    ui.rows.tasks = rows;
    const i = prev ? rows.findIndex((r) => r.k === prev) : -1;
    ui.sel.tasks = i >= 0 ? i : Math.min(ui.sel.tasks, Math.max(0, rows.length - 1));
    return rows;
  }

  function detailLines(st, id, W) {
    const t = st.tasks[id];
    if (!t) return [];
    const L = [];
    if (multi()) L.push([[`${projectName(ui.rows.tasks[ui.sel.tasks]?.root ?? '')} / ${st.title}`, 'dim']]);
    if (t.path.length) L.push([[t.path.map((p) => `${p} ${st.tasks[p].title}`).join(' › ') + ' ›', 'dim']]);
    const s = effStatus(t);
    L.push([[`${t.id} `, 'bold'], [`${STATUS[s][0]} ${s}`, STATUS[s][1]], ['  ' + t.title, 'bold']]);
    const meta = [];
    if (t.assignee) meta.push([(t.children.length ? '▣ package owner @' : '@') + t.assignee + '  ', 'cyan']);
    else if (t.owner) meta.push([`↳ @${t.owner} (package)  `, 'cyan']);
    const a = agentFor(st, t);
    if (a) meta.push([`herdr ${a.pane_id} ${a.agent_status}  `, a.stale ? 'red' : 'dim']);
    else if (t.owner && elsewhere(st, t.owner)) meta.push(['in another herdr session  ', 'gray']);
    if (t.deps.length) meta.push([`deps ${t.deps.map((d) => `${d}${effStatus(st.tasks[d] || {}) === 'done' ? '✓' : ''}`).join(' ')}  `, 'dim']);
    if (t.blocked_on.length) meta.push([`blocked on ${t.blocked_on.join(',')}${t.can_resume ? ' (done: can resume)' : ''}  `, t.can_resume ? 'green' : 'dim']);
    if (t.labels.length) meta.push([`#${t.labels.join(' #')}  `, 'magenta']);
    if (t.agent) meta.push([`agent ${t.agent}  `, 'magenta']);
    meta.push([`updated ${ago(t.updated_at)} ago`, 'dim']);
    L.push(meta);
    if (a?.stale) L.push([['⚠ agent is idle but the task is still in progress: it may have stopped without reporting', 'red']]);
    if (t.last_message && !TERMINAL.has(t.status)) for (const l of wrap('» ' + t.last_message, W - 2)) L.push([[l, t.status === 'blocked' ? 'red' : 'yellow']]);
    if (t.description) {
      L.push([]);
      for (const l of wrap(t.description, W - 2)) L.push([[l, '']]);
    }
    if (t.children.length) {
      L.push([], [['subtasks', 'bold'], t.rollup_percent != null ? [`  ${t.rollup_percent}%`, 'dim'] : ['', '']]);
      for (const c of t.children) {
        const ct = st.tasks[c];
        const cs = effStatus(ct);
        L.push([[`  ${STATUS[cs][0]} `, STATUS[cs][1]], [`${c} `, 'bold'], [ct.title + ' ', ''], [ct.owner && ct.owner !== t.owner ? '@' + ct.owner : '', 'cyan'], [ct.children.length ? `  (${ct.children.length} subtasks)` : '', 'dim']]);
      }
    }
    if (t.acceptance.length) {
      L.push([], [['acceptance', 'bold']]);
      for (const ac of t.acceptance) for (const [i, l] of wrap(ac, W - 6).entries()) L.push([[i ? '      ' : `  [${t.status === 'done' ? 'x' : ' '}] `, 'dim'], [l, '']]);
    }
    if (t.checkpoint && !TERMINAL.has(t.status)) {
      L.push([], [['checkpoint', 'bold'], [`  ${t.checkpoint.actor ?? ''} ${ago(t.checkpoint.ts)} ago`, 'dim']]);
      for (const l of wrap(t.checkpoint.message, W - 2)) L.push([[l, '']]);
    }
    if (t.result) {
      L.push([], [['result', 'bold']]);
      for (const l of wrap(t.result, W - 2)) L.push([[l, 'green']]);
    }
    if (t.artifacts.length) {
      L.push([], [['artifacts', 'bold']]);
      for (const x of t.artifacts) L.push([[`  ${x.kind} `, 'dim'], [x.ref, 'cyan'], [x.description ? ' — ' + x.description : '', 'dim']]);
    }
    if (t.notes.length) {
      L.push([], [['notes', 'bold']]);
      for (const n of t.notes.slice(-6))
        for (const [i, l] of wrap(`${n.kind !== 'info' ? `[${n.kind}] ` : ''}${n.message}`, W - 12).entries())
          L.push([[i ? ' '.repeat(10) : `  ${(n.actor || '').slice(0, 7).padEnd(8)}`, 'cyan'], [l, n.kind === 'question' || n.kind === 'warning' ? 'yellow' : '']]);
    }
    const hist = t.history.slice(-8);
    if (hist.length) {
      L.push([], [['activity', 'bold']]);
      for (const h of hist) {
        const what = h.type === 'status' ? `${h.from} → ${h.to}` : h.type === 'assigned' ? `assigned ${h.assignee ?? '-'}` : `progress${h.percent != null ? ' ' + h.percent + '%' : ''}`;
        L.push([[`  ${ago(h.ts).padStart(4)} `, 'dim'], [(h.actor || '') + ' ', 'cyan'], [what, ''], [h.message ? ' — ' + h.message : '', 'dim']]);
      }
    }
    return L;
  }

  /** Agents of one plan, grouped by work package. `ind` indents for multi-plan scopes. */
  function planAgentLines(st, W, ind = '') {
    const L = [];
    const actors = Object.values(st.actors).filter((a) => a.owned.length || a.packages.length || a.tasks.length);
    const unowned = st.order.filter((id) => !st.tasks[id].owner && !st.tasks[id].children.length && !TERMINAL.has(st.tasks[id].status));
    const pkgOf = (t, who) => [...t.path].reverse().find((id) => st.tasks[id].assignee === who) ?? null;
    if (!actors.length && !unowned.length) L.push([[ind + ' No assignments yet.', 'dim']]);
    for (const a of actors) {
      const owned = a.owned.map((id) => st.tasks[id]);
      const done = owned.filter((t) => t.status === 'done').length;
      const live = liveAgent(st, a.id);
      const away = elsewhere(st, a.id);
      const [ag, ac] = live ? AGENT_GLYPH[live.agent_status] || AGENT_GLYPH.unknown : away ? ['↗', 'gray'] : [' ', ''];
      const state = live ? `${live.agent_status} in ${live.pane_id}` : away ? 'another herdr session' : a.inferred ? 'not started' : 'no live pane';
      L.push([[ind + ' ' + a.id + ' ', 'bold cyan'], [`${a.role ?? ''} `, 'dim'], [ag + ' ', ac], [state + '  ', 'dim'], ...bar(owned.length ? done / owned.length : 0, 10), [` ${done}/${owned.length}`, 'dim'], [a.last_seen ? `  seen ${ago(a.last_seen)}` : '', 'dim']]);
      const groups = new Map();
      for (const t of owned) {
        const pkg = pkgOf(t, a.id) ?? '';
        if (!groups.has(pkg)) groups.set(pkg, []);
        groups.get(pkg).push(t);
      }
      for (const [pkg, ts] of groups) {
        if (pkg) {
          const p = st.tasks[pkg];
          const crumb = p.path.length ? p.path.map((x) => `${x} ${st.tasks[x].title}`).join(' › ') + ' › ' : '';
          L.push([[ind + '   ▣ ', 'cyan'], [crumb, 'dim'], [`${pkg} ${p.title}`, 'bold'], [`  ${STATUS[effStatus(p)][0]} ${p.rollup_percent ?? 0}%`, STATUS[effStatus(p)][1]]]);
        }
        for (const t of ts) {
          const rel = pkg ? t.path.slice(t.path.indexOf(pkg) + 1) : t.path;
          const crumb = rel.length ? rel.map((x) => st.tasks[x].title).join(' › ') + ' › ' : '';
          L.push([[ind + `     ${STATUS[t.status][0]} `, STATUS[t.status][1]], [`${t.id} `, 'bold'], [crumb, 'dim'], [t.title, TERMINAL.has(t.status) && t.status !== 'failed' ? 'dim' : ''], [t.status === 'in_progress' && t.percent != null ? `  ${t.percent}%` : '', 'yellow'], [t.status === 'todo' && t.waiting_on.length ? `  ⧗ ${t.waiting_on.join(',')}` : '', 'dim']]);
        }
      }
    }
    if (unowned.length) {
      L.push([[ind + ' unassigned', 'bold'], [`  ${unowned.filter((id) => st.tasks[id].ready).length} ready`, 'green']]);
      for (const id of unowned) {
        const t = st.tasks[id];
        const crumb = t.path.length ? t.path.map((x) => st.tasks[x].title).join(' › ') + ' › ' : '';
        L.push([[ind + `     ${STATUS[t.status][0]} `, STATUS[t.status][1]], [`${t.id} `, 'bold'], [crumb, 'dim'], [t.title, ''], [t.ready ? '  ready' : '', 'green']]);
      }
    }
    return L;
  }

  function agentsTabLines(W, plans) {
    if (!multi()) return plans[0] ? planAgentLines(plans[0].st, W) : [];
    const L = [];
    // who is working right now, across everything in scope
    const live = [];
    for (const p of plans)
      for (const a of Object.values(p.st.actors)) {
        const la = liveAgent(p.st, a.id);
        if (la && (a.owned.length || a.packages.length)) live.push({ p, a, la });
      }
    const working = live.filter((x) => x.la.agent_status === 'working').length;
    L.push([[` ${live.length} live agent${live.length === 1 ? '' : 's'}`, 'bold'], [`  ${working} working · ${live.length - working} idle`, 'dim']]);
    for (const p of plans) {
      L.push([], [[` ${ui.scope.level === 'all' ? projectName(p.root) + ' / ' : ''}${p.st.title}`, 'bold'], [`  ${Math.round(p.st.progress * 100)}%`, 'dim']]);
      L.push(...planAgentLines(p.st, W, '  '));
    }
    return L;
  }

  /**
   * Plan tab at wider scopes: every plan in scope as a compact card (what and why:
   * goal, outcome, branch progress, decision/question/artifact counts). ⏎ opens the
   * plan's full details. Returns {lines, selLine}; fills ui.rows.plan.
   */
  function planCardsLines(W, plans) {
    const L = [];
    const rows = [];
    if (!plans.length) L.push([[ui.showClosed ? ' No plans in scope.' : ' No active plans in scope (f: include closed).', 'dim']]);
    for (const p of plans) {
      const s = p.st;
      const row = { type: 'plan', root: p.root, plan: p.id, id: p.id, st: s, key: p.key, k: p.key, line: L.push(null) - 1 };
      rows.push(row);
      const folded = ui.cardFolded.has(p.key);
      row.render = (sel) => [
        mark(sel),
        [folded ? '▸ ' : '▾ ', 'bold'],
        [clip(`${ui.scope.level === 'all' ? projectName(p.root) + ' / ' : ''}${s.title}`, Math.max(14, Math.min(50, W - 47))) + ' ', sel ? 'inverse bold' : isOpenStatus(s) ? 'bold' : 'dim'],
        [`${s.status} · ${s.counts.done}/${planSummary(s).total} tasks · ${ago(s.updated_at)} ago`, s.status === 'completed' ? 'green' : s.status === 'active' ? 'blue' : 'yellow'],
      ];
      if (folded) continue;
      const sum = planSummary(s);
      const field = (label, text, color = '') => {
        if (!text) return;
        const ls = wrap(text, Math.max(20, W - 18));
        if (ls.length > 2) ls[1] = ls[1].replace(/\s*\S*$/, '') + ' …'; // cut: full text in the plan's details
        ls.slice(0, 2).forEach((l, i) => L.push([[i ? '               ' : `      ${label.padEnd(9)}`, 'dim'], [l, color]]));
      };
      field('goal', s.goal);
      if (!isOpenStatus(s)) field('outcome', s.status_message, s.status === 'completed' ? 'green' : 'yellow');
      const roots = s.order.filter((id) => !s.tasks[id].parent || !s.tasks[s.tasks[id].parent]);
      const nameW = Math.min(30, Math.max(8, ...roots.map((id) => [...`${id} ${s.tasks[id].title}`].length)));
      for (const id of roots.slice(0, 6)) {
        const t = s.tasks[id];
        const es = effStatus(t);
        const pct = t.children.length ? (t.rollup_percent ?? 0) : es === 'done' ? 100 : (t.percent ?? 0);
        const owners = [...new Set(s.order.filter((x) => (x === id || s.tasks[x].path.includes(id)) && s.tasks[x].owner).map((x) => s.tasks[x].owner))];
        L.push([[`      ${STATUS[es][0]} `, STATUS[es][1]], [clip(`${id} ${t.title}`, nameW) + ' ', t.children.length ? 'bold' : ''], ...bar(pct / 100, 8), [` ${String(pct).padStart(3)}%  `, 'dim'], [owners.join(', '), 'cyan']]);
      }
      if (roots.length > 6) L.push([[`        … ${roots.length - 6} more branches`, 'dim']]);
      const notes = s.order.flatMap((id) => s.tasks[id].notes);
      const n = (k) => notes.filter((x) => x.kind === k).length;
      const arts = s.order.reduce((a, id) => a + s.tasks[id].artifacts.length, 0);
      const counts = [n('decision') && `${n('decision')} decision${n('decision') === 1 ? '' : 's'}`, n('question') && `${n('question')} question${n('question') === 1 ? '' : 's'}`, n('warning') && `${n('warning')} warning${n('warning') === 1 ? '' : 's'}`, arts && `${arts} artifact${arts === 1 ? '' : 's'}`].filter(Boolean);
      if (counts.length) L.push([[`      ${counts.join(' · ')}`, 'dim']]);
      L.push([]);
    }
    const prevK = ui.rows.plan[ui.sel.plan]?.k;
    const keep = prevK ? rows.findIndex((r) => r.k === prevK) : -1;
    ui.sel.plan = keep >= 0 ? keep : Math.min(ui.sel.plan, Math.max(0, rows.length - 1));
    ui.rows.plan = rows;
    rows.forEach((r, i) => (L[r.line] = r.render(i === ui.sel.plan)));
    return { lines: L, selLine: rows[ui.sel.plan]?.line ?? 0 };
  }

  /** Plan tab at plan scope: the plan's full details. */
  function planTabLines(W, plans) {
    const p = plans[0];
    if (!p) return [[[' No plan in scope.', 'dim']]];
    const s = p.st;
    const L = [];
    L.push([[' ' + s.title, 'bold'], [`  ${s.status}`, s.status === 'completed' ? 'green' : s.status === 'active' ? 'blue' : 'yellow']]);
    L.push([[` ${s.id} · created ${s.created_at?.slice(0, 16).replace('T', ' ') ?? '?'} by ${s.created_by ?? '?'} · updated ${ago(s.updated_at)} ago`, 'dim']]);
    for (const [label, text, color] of [
      ['goal', s.goal, ''],
      ['description', s.description, ''],
      ['outcome', s.status_message, 'green'],
    ]) {
      if (!text) continue;
      L.push([], [[` ${label}`, 'bold']]);
      for (const l of wrap(text, W - 3)) L.push([['  ' + l, color]]);
    }
    const roots = s.order.filter((id) => !s.tasks[id].parent || !s.tasks[s.tasks[id].parent]);
    if (roots.length) {
      L.push([], [[' breakdown', 'bold'], ['  (top-level branches)', 'dim']]);
      const nameW = Math.min(36, Math.max(...roots.map((id) => [...`${id} ${s.tasks[id].title}`].length)));
      for (const id of roots) {
        const t = s.tasks[id];
        const es = effStatus(t);
        const pct = t.children.length ? (t.rollup_percent ?? 0) : es === 'done' ? 100 : (t.percent ?? 0);
        const owners = [...new Set(s.order.filter((x) => (x === id || s.tasks[x].path.includes(id)) && s.tasks[x].owner).map((x) => s.tasks[x].owner))];
        L.push([[`  ${STATUS[es][0]} `, STATUS[es][1]], [clip(`${id} ${t.title}`, nameW) + ' ', t.children.length ? 'bold' : ''], ...bar(pct / 100, 10), [` ${String(pct).padStart(3)}%  `, 'dim'], [owners.join(', '), 'cyan']]);
      }
    }
    const notes = s.order.flatMap((id) => s.tasks[id].notes.map((n) => ({ ...n, task: id })));
    for (const [kind, title, color] of [
      ['question', 'open questions', 'yellow'],
      ['decision', 'decisions', ''],
      ['warning', 'warnings', 'yellow'],
    ]) {
      const ns = notes.filter((n) => n.kind === kind);
      if (!ns.length) continue;
      L.push([], [[` ${title}`, 'bold']]);
      for (const n of ns) for (const [i, l] of wrap(n.message, W - 18).entries()) L.push([[i ? ' '.repeat(16) : `  ${n.task.padEnd(4)} ${(n.actor ?? '').slice(0, 9).padEnd(10)}`, 'cyan'], [l, color]]);
    }
    const blocked = s.order.map((id) => s.tasks[id]).filter((t) => t.status === 'blocked');
    if (blocked.length) {
      L.push([], [[' blocked', 'bold red']]);
      for (const t of blocked) L.push([[`  ${t.id} `, 'bold'], [t.last_message || t.title, 'red']]);
    }
    const arts = s.order.flatMap((id) => s.tasks[id].artifacts.map((x) => ({ ...x, task: id })));
    if (arts.length) {
      L.push([], [[' artifacts', 'bold']]);
      for (const x of arts) L.push([[`  ${x.task.padEnd(4)} ${x.kind.padEnd(7)}`, 'dim'], [x.ref, 'cyan'], [x.description ? ' — ' + x.description : '', 'dim']]);
    }
    return L;
  }

  /** Log tab: events of all plans in scope, newest first, tagged with their plan. */
  function logTabLines(plans) {
    const evs = [];
    for (const p of plans) for (const e of readEvents(p.root, p.id).slice(-200)) evs.push({ e, p });
    evs.sort((a, b) => (b.e.ts || '').localeCompare(a.e.ts || ''));
    return evs.slice(0, 400).map(({ e, p }) => {
      const d = e.data || {};
      const bits = [d.status, d.percent != null ? d.percent + '%' : null, d.assignee !== undefined ? '→ ' + (d.assignee ?? '-') : null, d.title, d.ref, d.message].filter((x) => x != null && x !== '');
      const tag = multi() ? clip(`${ui.scope.level === 'all' ? projectName(p.root) + '/' : ''}${p.st.title}`, 22) + ' ' : '';
      return [[`${ago(e.ts).padStart(4)} `, 'dim'], [tag, 'magenta'], [(e.actor?.id ?? '?').slice(0, 10).padEnd(11), 'cyan'], [e.type.replace(/^task\./, '').padEnd(9), 'bold'], [e.task ? e.task + ' ' : '', ''], [bits.join(' · '), 'dim']];
    });
  }

  const KIND_STYLE = { review: ['◎ review', 'magenta'], question: ['⊘ question', 'red'], failed: ['✗ failed', 'red'], stale: ['stale?', 'red bold'], finished: ['● finished', 'green'] };

  const foldOf = (p) => ui.fold.get(p.key) ?? (isOpenStatus(p.st) ? 'live' : 'folded');

  /** The "live" slice of a plan: tasks that are moving or need someone, most urgent first. */
  function liveTasks(p) {
    const res = [];
    for (const id of p.st.order) {
      const t = p.st.tasks[id];
      if (t.children.length) continue;
      const a = agentFor(p.st, t);
      const rank =
        t.status === 'review' ? 0 : t.status === 'blocked' && !t.blocked_on.length ? 1 : t.status === 'failed' ? 2 : a?.stale ? 3 : t.status === 'in_progress' ? 4 : t.status === 'blocked' ? 5 : null;
      if (rank !== null) res.push({ t, a, rank });
    }
    return res.sort((x, y) => x.rank - y.rank);
  }

  /** Compact line for a live task: status, parent path, id, title, owner + agent, detail. */
  function liveTaskLine(p, t, a, W, selected) {
    const st = p.st;
    const s = effStatus(t);
    const [g, color] = STATUS[s];
    const crumb = t.path.length ? t.path.map((x) => st.tasks[x].title).join(' › ') + ' › ' : '';
    const right = [];
    if (t.owner) right.push([t.owner, t.assignee ? 'cyan' : 'cyan dim']);
    if (a) right.push([' ' + (AGENT_GLYPH[a.agent_status] || AGENT_GLYPH.unknown)[0], (AGENT_GLYPH[a.agent_status] || AGENT_GLYPH.unknown)[1]]);
    else if (t.owner && elsewhere(st, t.owner)) right.push([' ↗', 'gray']);
    if (a?.stale) right.push([' stale?', 'red bold']);
    if (t.status === 'in_progress' && t.percent != null) right.push([` ${t.percent}%`, 'yellow']);
    if (t.status === 'blocked' && t.blocked_on.length) right.push([t.can_resume ? '  can resume' : `  ⧗ on ${t.blocked_on.join(',')}`, t.can_resume ? 'green' : 'dim']);
    if (t.answered) right.push(['  answered', 'green']);
    const msg = ['review', 'blocked', 'failed'].includes(t.status) && !t.blocked_on.length && t.last_message ? `  — ${t.last_message}` : '';
    const fixed = 7 + [...crumb].length + t.id.length + 1 + right.reduce((n, [x]) => n + [...x].length, 0) + 2;
    const titleW = Math.max(8, Math.min([...t.title].length, W - fixed - 10));
    return [
      mark(selected),
      ['    ', ''],
      [g + ' ', color],
      [crumb, 'gray'],
      [t.id + ' ', selected ? 'inverse bold' : 'bold'],
      [clip(t.title, titleW) + '  ', TERMINAL.has(t.status) && t.status !== 'failed' ? 'dim' : ''],
      ...right,
      [msg, 'dim'],
    ];
  }

  /** Summary of a plan's remaining tasks (those not shown in the live slice). */
  function planRest(p, shown) {
    const leaves = p.st.order.map((id) => p.st.tasks[id]).filter((t) => !t.children.length && !shown.has(t.id));
    const n = (f) => leaves.filter(f).length;
    const done = n((t) => t.status === 'done');
    const todo = n((t) => t.status === 'todo');
    const ready = n((t) => t.ready);
    const cancelled = n((t) => t.status === 'cancelled');
    const parts = [];
    if (done) parts.push([`✓ ${done} done`, 'green']);
    if (todo) parts.push([`○ ${todo} todo${ready ? ` (${ready} ready)` : ''}`, 'gray']);
    if (cancelled) parts.push([`– ${cancelled} cancelled`, 'gray']);
    if (!parts.length) return null;
    const segs = [['       ', '']];
    parts.forEach((x, i) => segs.push(...(i ? [[' · ', 'dim']] : []), x));
    return segs;
  }

  /**
   * Overview tab: each plan in scope (unfolded by default to its live slice: what is
   * moving or needs someone), then the cross-plan inbox. Fold per plan: ←/→/space,
   * all: z. Returns {lines, selLine}; fills ui.rows.overview with selectable rows.
   */
  function overviewTabLines(W, plans) {
    const L = [];
    const rows = [];
    const s = ui.scope;
    const add = (row, render) => rows.push({ ...row, line: L.push(null) - 1, render });
    if (s.level === 'all' && initDir && !findRoot(initDir))
      L.push([[' No ATF project in ', 'yellow'], [initDir, 'cyan'], ['  — press ', 'yellow'], ['i', 'bold green'], [' to create one there', 'yellow']], []);
    if (!plans.length) L.push([[ui.showClosed ? ' No plans in scope.' : ' No active plans in scope (f: include closed). A coordinator starts one with `atf plan new <title>`.', 'dim']]);
    for (const p of plans) {
      const level = foldOf(p);
      const closed = !isOpenStatus(p.st);
      add({ type: 'plan', root: p.root, plan: p.id, id: p.id, st: p.st, key: p.key, k: p.key }, (sel) => {
        const sum = planSummary(p.st);
        let working = 0;
        let idle = 0;
        let away = 0;
        for (const who of sum.agents) {
          if (elsewhere(p.st, who)) away++;
          else {
            const a = liveAgent(p.st, who);
            if (a?.agent_status === 'working') working++;
            else if (a) idle++;
          }
        }
        const inbox = inboxOf(p).length;
        const label = `${s.level === 'all' ? projectName(p.root) + ' / ' : ''}${p.st.title}`;
        const titleW = Math.max(14, Math.min(46, W - 60));
        return [
          mark(sel),
          [level === 'folded' ? '▸ ' : level === 'live' ? '▾ ' : '▿ ', 'bold'],
          [clip(label, titleW) + ' ', sel ? 'inverse bold' : closed ? 'dim' : 'bold'],
          ...bar(sum.progress, 10),
          [` ${String(Math.round(sum.progress * 100)).padStart(3)}% ${p.st.counts.done}/${sum.total} `, 'dim'],
          [working ? `⚙${working} ` : '', 'blue'],
          [idle ? `◌${idle} ` : '', 'yellow'],
          [away ? `↗${away} ` : '', 'gray'],
          [sum.ready_unowned ? `${sum.ready_unowned} ready ` : '', 'green'],
          [inbox ? `⚑${inbox} ` : '', 'red bold'],
          [p.st.status !== 'active' ? `${p.st.status} ` : '', p.st.status === 'paused' ? 'yellow' : 'dim'],
          [ago(p.st.updated_at), 'dim'],
        ];
      });
      if (level === 'live') {
        const live = liveTasks(p);
        for (const { t, a } of live) add({ type: 'task', root: p.root, plan: p.id, st: p.st, key: p.key, task: t.id, k: `${p.key}#${t.id}` }, (sel) => liveTaskLine(p, t, a, W, sel));
        const rest = planRest(p, new Set(live.map((x) => x.t.id)));
        if (rest) L.push(rest);
        else if (!live.length) L.push([['       no tasks yet', 'dim']]);
      } else if (level === 'full') {
        const visit = (id, prefix, isLast, depth) => {
          const k = `${p.key}#${id}`;
          const row = { type: 'task', root: p.root, plan: p.id, st: p.st, key: p.key, task: id, k, prefix: depth ? prefix + (isLast ? '└─' : '├─') : '' };
          add(row, (sel) => taskRowLine(row, W, sel));
          const kids = p.st.tasks[id].children;
          kids.forEach((c, i) => visit(c, depth ? prefix + (isLast ? '  ' : '│ ') : '', i === kids.length - 1, depth + 1));
        };
        const roots = p.st.order.filter((id) => !p.st.tasks[id].parent || !p.st.tasks[p.st.tasks[id].parent]);
        roots.forEach((id, i) => visit(id, '', i === roots.length - 1, 0));
      }
    }
    // cross-plan inbox: the same attention items, oldest first
    const items = plans.flatMap(inboxOf).sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    L.push([], [[' inbox', 'bold'], [items.length ? `  ${items.length} item${items.length === 1 ? ' needs' : 's need'} you, oldest first` : '  nothing needs you', 'dim']]);
    for (const it of items)
      add({ type: 'item', ...it, k: `item#${it.root}#${it.plan}#${it.task}#${it.kind}` }, (sel) => {
        const [label, color] = KIND_STYLE[it.kind] || [it.kind, ''];
        const t = it.task ? it.st.tasks[it.task] : null;
        const where = multi() ? `${s.level === 'all' ? projectName(it.root) + ' / ' : ''}${it.st.title}  ` : '';
        return [mark(sel), [label.padEnd(11), sel ? `inverse ${color}`.trim() : color], [' ' + where, 'dim'], [t ? `${t.id} ${t.title} ` : '', 'bold'], [it.actor ? `@${it.actor} ` : '', 'cyan'], [it.message ? `— ${it.message} ` : '', 'dim'], [ago(it.ts), 'dim']];
      });
    // keep the selection on the same row across redraws
    const prevK = ui.rows.overview[ui.sel.overview]?.k;
    const keep = prevK ? rows.findIndex((r) => r.k === prevK) : -1;
    ui.sel.overview = keep >= 0 ? keep : Math.min(ui.sel.overview, Math.max(0, rows.length - 1));
    ui.rows.overview = rows;
    rows.forEach((r, i) => (L[r.line] = r.render(i === ui.sel.overview)));
    return { lines: L, selLine: rows[ui.sel.overview]?.line ?? 0 };
  }

  /** Overview folding: plan rows cycle folded -> live -> full; task rows fold their plan. */
  function foldPlan(r, dir) {
    if (!r?.key) return;
    const p = { key: r.key, st: r.st, root: r.root, id: r.plan };
    // a plan with nothing live (closed or idle) has no useful middle level: folded <-> full
    const order = liveTasks(p).length ? ['folded', 'live', 'full'] : ['folded', 'full'];
    let cur = order.indexOf(foldOf(p));
    if (cur < 0) cur = 0; // was 'live' but nothing is live any more
    const next = dir === 'cycle' ? order[(cur + 1) % order.length] : order[Math.max(0, Math.min(order.length - 1, cur + (dir === 'open' ? 1 : -1)))];
    ui.fold.set(r.key, next);
  }

  /** c: close a plan (completed). Second press within 3 s confirms. */
  function closePlan(r) {
    if (!r?.root || !r?.plan) return flash('select a plan');
    if (!isOpenStatus(r.st)) return flash(`${r.st.title} is already ${r.st.status}`);
    const key = keyOf(r.root, r.plan);
    if (!(ui.confirm?.action === 'close' && ui.confirm.key === key && ui.confirm.until > Date.now())) {
      ui.confirm = { action: 'close', key, until: Date.now() + 3000 };
      const open = r.st.order.filter((id) => !r.st.tasks[id].children.length && !TERMINAL.has(r.st.tasks[id].status)).length;
      return flash(`close plan "${r.st.title}"${open ? ` (${open} task${open === 1 ? '' : 's'} still open!)` : ''}? press c again`, open ? 'red' : 'yellow');
    }
    ui.confirm = null;
    try {
      transact(r.root, r.plan, resolveActor({ role: 'coordinator' }), () => [{ type: 'plan.status', data: { status: 'completed', message: 'closed via board' } }]);
      flash(`closed "${r.st.title}"${ui.showClosed ? '' : ' (f shows closed plans)'}`, 'green');
    } catch (e) {
      flash(e.message, 'red');
    }
  }

  function helpLines() {
    const H = (t) => [[' ' + t, 'bold']];
    const T = (t, st = '') => [['   ' + t, st]];
    const sym = (g, color, name, desc) => [['   ' + g + ' ', color], [name.padEnd(13), color], [desc, '']];
    return [
      H('Scope (header): all projects › project › plan'),
      T('Every tab shows its content for the scope. ⏎ on a plan narrows to it; esc widens'),
      T('(plan -> project -> all projects -> quit); A jumps straight to all projects.'),
      T('At wider scopes Tasks and Agents group by project and plan, Plan shows one card per'),
      T('plan (goal, outcome, branches; ←→/space fold a card, z all; ⏎ for full details),'),
      T('Log merges the events of all plans in scope.'),
      [],
      H('Views'),
      T('Tab / 0-4    Overview · Tasks · Agents · Plan · Log    p / P  next / previous plan'),
      [],
      H('Overview (0)'),
      T('every plan in scope, unfolded to its live slice: tasks in progress, in review,'),
      T('blocked or failed (with their parent path), plus a summary of the rest. Below,'),
      T('the inbox: everything that needs you across plans, oldest first.'),
      T('←/→/space  fold a plan: ▸ folded  ▾ live  ▿ full tree      z  fold/unfold all'),
      T('c  close the selected plan (press twice)     f  show/hide closed plans (all tabs)'),
      T('⏎ open plan / task   g jump in herdr: item -> its agent; plan -> its coordinator,'),
      T('else an agent of the plan, else a pane in the project directory'),
      [['   ◎ review  ', 'magenta'], ['agent finished, approve or reopen', '']],
      [['   ⊘ question', 'red'], [' agent blocked on a question (not on another task)', '']],
      [['   ✗ failed  ', 'red'], ['agent gave up', '']],
      [['   stale?    ', 'red bold'], ['task in progress, its agent idle > 90s', '']],
      [['   ● finished', 'green'], [' all tasks done, plan still open', '']],
      [['   ⚙2 ◌1 ↗1  ', ''], ['agents working / idle / in another herdr session; ⚑ inbox items', '']],
      [],
      H('Tasks (1)'),
      T('↑↓ j/k  move        ←→ h/l  collapse / expand (tasks and plans)   space  toggle'),
      T('⏎  task details / open plan      g  go to the owning agent’s pane'),
      T('s  spawn a subagent for the selected task or work package     a  approve a review'),
      [],
      H('Task status: the symbol before a task'),
      sym(STATUS.todo[0], STATUS.todo[1], 'todo', 'not started (⧗ T3 = waits on dependencies)'),
      sym(STATUS.in_progress[0], STATUS.in_progress[1], 'in progress', 'an agent is working on it'),
      sym(STATUS.review[0], STATUS.review[1], 'review', 'agent finished, waiting for the coordinator to approve'),
      sym(STATUS.done[0], STATUS.done[1], 'done', 'finished (approved if it went through review)'),
      sym(STATUS.blocked[0], STATUS.blocked[1], 'blocked', 'agent cannot continue: a question, or "⧗ on T8"'),
      sym(STATUS.failed[0], STATUS.failed[1], 'failed', 'agent gave up; coordinator can reopen it'),
      sym(STATUS.cancelled[0], STATUS.cancelled[1], 'cancelled', 'dropped'),
      T('Parent tasks show the combined status of their subtasks.', 'dim'),
      [],
      H('Agent state: the symbol after an agent name (live from herdr)'),
      sym(AGENT_GLYPH.working[0], AGENT_GLYPH.working[1], 'working', 'the agent is running'),
      sym(AGENT_GLYPH.idle[0], AGENT_GLYPH.idle[1], 'idle', 'the agent waits for input'),
      sym(AGENT_GLYPH.done[0], AGENT_GLYPH.done[1], 'done', 'the agent finished its turn'),
      sym(AGENT_GLYPH.blocked[0], AGENT_GLYPH.blocked[1], 'prompt', 'stuck at an approval/question prompt in its terminal'),
      sym('↗', 'gray', 'elsewhere', 'runs in another herdr session (read-only here)'),
      [['   stale?         ', 'red bold'], ['task in progress but its agent idle > 90s: probably stopped without reporting', '']],
      [],
      H('Ownership and labels'),
      [['   ▣ backend      ', 'cyan bold'], ['work package: this parent task and its whole subtree belong to backend', '']],
      [['   ↳backend       ', 'cyan dim'], ['owner inherited from the package', '']],
      [['   backend        ', 'cyan'], ['assigned directly', '']],
      [['   ready          ', 'green'], ['can start now and nobody owns it yet', '']],
      [['   40%            ', 'yellow'], ['progress last reported by the agent', '']],
      [['   2/3            ', 'dim'], ['finished / total subtasks of a parent', '']],
    ];
  }

  function footer() {
    if (ui.flash && ui.flash.until > Date.now()) return [[' ' + ui.flash.msg, ui.flash.style]];
    const esc = ui.scope.level === 'all' ? 'esc quit' : 'esc widen';
    const keys = {
      overview: `↑↓ select  ←→ fold  z all  ⏎ open  g jump  a approve  c close plan  f ${ui.showClosed ? 'hide' : 'show'} closed  ${esc}  ? help`,
      tasks: `↑↓ move  ←→ fold  ⏎ details/open  g agent  s spawn  a approve  ${esc}  ? help`,
      agents: `↑↓ scroll  ${esc}  A all projects  tab views  ? help  q quit`,
      plan: multi() ? `↑↓ select  ←→ fold  z all  ⏎ open plan  g jump  c close plan  f ${ui.showClosed ? 'hide' : 'show'} closed  ${esc}  ? help` : `↑↓ scroll  ${esc}  tab views  ? help  q quit`,
      log: `↑↓ scroll  ${esc}  tab views  ? help  q quit`,
      detail: '↑↓ scroll  ⏎/esc back  g agent  s spawn  a approve',
      help: '↑↓ scroll  any other key: back',
    }[view()];
    return [[' ' + keys, 'dim']];
  }

  function scrolled(lines, all, key, bodyH) {
    const max = Math.max(0, all.length - bodyH);
    ui.scrolls[key] = Math.max(0, Math.min(ui.scrolls[key] ?? 0, max));
    lines.push(...all.slice(ui.scrolls[key], ui.scrolls[key] + bodyH));
  }

  /** Keep a selected line visible in a list view. */
  function list(lines, all, selLine, key, bodyH) {
    let sc = ui.scrolls[key] ?? 0;
    if (selLine < sc + 1) sc = Math.max(0, selLine - 1);
    if (selLine >= sc + bodyH - 1) sc = selLine - bodyH + 2;
    ui.scrolls[key] = sc;
    lines.push(...all.slice(sc, sc + bodyH));
  }

  function draw() {
    const W = out.columns || 80;
    const H = out.rows || 24;
    const plans = scopePlans();
    const lines = [...header(W, plans), [['─'.repeat(W), 'gray']]];
    const bodyH = H - lines.length - 1;
    const v = view();

    if (v === 'help') scrolled(lines, helpLines(), 'help', bodyH);
    else if (v === 'overview') {
      const { lines: all, selLine } = overviewTabLines(W, plans);
      list(lines, all, selLine, 'overview', bodyH);
    } else if (v === 'detail') {
      const r = ui.rows.tasks[ui.sel.tasks];
      if (r?.type === 'task') scrolled(lines, detailLines(r.st, r.task, W), 'detail', bodyH);
      else ui.overlay = null;
    } else if (v === 'agents') scrolled(lines, agentsTabLines(W, plans), 'agents', bodyH);
    else if (v === 'plan' && multi()) {
      const { lines: all, selLine } = planCardsLines(W, plans);
      list(lines, all, selLine, 'plan', bodyH);
    } else if (v === 'plan') scrolled(lines, planTabLines(W, plans), 'plan', bodyH);
    else if (v === 'log') scrolled(lines, logTabLines(plans), 'log', bodyH);
    else {
      // tasks: rows on top; attention + preview of the selected task below (plan scope)
      const rows = buildTaskRows();
      if (!rows.length) lines.push([[multi() ? ' No active plans in scope.' : ' No tasks yet. Add with `atf add <title>`.', 'dim']]);
      const all = rows.map((r, i) => (r.type === 'plan' ? planHeaderRow(r, W, i === ui.sel.tasks, r) : r.type === 'note' ? [[r.text, 'dim']] : taskRowLine(r, W, i === ui.sel.tasks)));
      const listH = multi() ? bodyH : Math.min(rows.length, Math.max(3, Math.floor(bodyH * 0.6)));
      list(lines, all, ui.sel.tasks, 'tasks', listH);
      if (!multi() && plans[0]) {
        const st = plans[0].st;
        let room = bodyH - Math.min(rows.length, listH);
        const attention = st.order.map((id) => st.tasks[id]).filter((t) => (t.status === 'blocked' && !t.blocked_on.length) || t.status === 'review' || agentFor(st, t)?.stale);
        if (attention.length && room > 2) {
          const att = [[['─ needs attention ', 'red bold'], ['─'.repeat(Math.max(0, W - 18)), 'gray']], ...attention.map((t) => [[` ${t.id} `, 'bold'], [`${agentFor(st, t)?.stale ? 'stale?' : t.status} `, t.status === 'review' ? 'magenta' : 'red'], [t.last_message || t.title, 'dim']])];
          lines.push(...att.slice(0, room));
          room -= att.length;
        }
        const r = rows[ui.sel.tasks];
        if (room > 3 && r?.type === 'task') {
          lines.push([['─'.repeat(W), 'gray']]);
          lines.push(...detailLines(r.st, r.task, W).slice(0, room - 1));
        }
      }
    }
    while (lines.length < H - 1) lines.push([]);
    lines.length = H - 1;
    lines.push(footer());
    out.write(`${ESC}H` + lines.map((l) => fit(l, W) + `${ESC}K`).join('\r\n'));
  }

  // ---------- actions ----------
  const selectedRow = () => {
    const v = view() === 'detail' ? 'tasks' : view();
    return ui.rows[v]?.[ui.sel[v]];
  };

  async function focusAgent(st, who) {
    if (elsewhere(st, who)) return flash(`${who} runs in another herdr session`, 'red');
    if (!(await herdrAsync(['agent', 'focus', who]))) return flash(`no live herdr agent for ${who}`, 'red');
    if (popup) quit();
  }

  /** g on a plan: its coordinator, else one of its agents (working first), else a pane in the project. */
  async function focusPlan(r, st) {
    const local = Object.values(st.actors).filter((a) => !elsewhere(st, a.id) && ui.agents.get(`name:${a.id}`));
    const order = [...local.filter((a) => a.role === 'coordinator'), ...local.filter((a) => a.role !== 'coordinator' && ui.agents.get(`name:${a.id}`)?.agent_status === 'working'), ...local.filter((a) => a.role !== 'coordinator')];
    for (const a of order) if (await herdrAsync(['agent', 'focus', a.id])) return popup ? quit() : draw();
    const projDir = path.dirname(r);
    const inside = (d) => d && (d === projDir || d.startsWith(projDir + path.sep));
    const pane = ((await herdrAsync(['pane', 'list']))?.panes || []).find((p) => !p.label && (inside(p.foreground_cwd) || inside(p.cwd)));
    if (pane && (await herdrAsync(['workspace', 'focus', pane.workspace_id])) && (await herdrAsync(['tab', 'focus', pane.tab_id]))) return popup ? quit() : draw();
    flash(`no herdr pane is open in ${projectName(r)}`);
  }

  async function goTo() {
    const r = selectedRow();
    if (!r) return;
    if (r.type === 'plan') return focusPlan(r.root, r.st);
    if (r.type === 'item') return r.actor ? focusAgent(r.st, r.actor) : focusPlan(r.root, r.st);
    if (r.type === 'task') {
      const t = r.st.tasks[r.task];
      if (!t.owner) return flash('task has no owner');
      return focusAgent(r.st, t.owner);
    }
  }

  function spawnAgent() {
    const r = selectedRow();
    if (r?.type !== 'task') return flash('select a task');
    const t = r.st.tasks[r.task];
    const isPackage = t.children.length > 0;
    if (isPackage && TERMINAL.has(effStatus(t))) return flash(`${t.id} is already ${effStatus(t)}`);
    if (!isPackage && !t.ready) return flash(`${t.id} is not ready (${t.status}${t.waiting_on.length ? ', waits on ' + t.waiting_on.join(',') : ''})`);
    if (!spawnCmd) return flash('spawn unavailable');
    flash(`spawning agent for ${isPackage ? 'package ' : ''}${t.id}…`, 'blue');
    const args = [...spawnCmd, 'spawn', t.id, '--plan', r.plan];
    if (targetPane) args.push('--target-pane', targetPane);
    const p = spawn(args[0], args.slice(1), { env: { ...process.env, ATF_DIR: r.root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stderr.on('data', (d) => (buf += d));
    p.on('error', (e) => flash(`spawn failed: ${e.message}`, 'red'));
    p.on('close', (code) => flash(code === 0 ? buf.trim().split('\n').pop() : `spawn failed: ${buf.trim().split('\n').pop()}`, code === 0 ? 'green' : 'red'));
  }

  function approve() {
    const r = selectedRow();
    const t = r?.type === 'task' || r?.type === 'item' ? r.st.tasks[r.task] : null;
    if (!t || t.status !== 'review') return flash('only tasks in review can be approved');
    try {
      transact(r.root, r.plan, resolveActor({ role: 'coordinator' }), (st) =>
        st.tasks[t.id].status === 'review' ? [{ type: 'task.status', task: t.id, data: { status: 'done', message: `approved via board: ${t.last_message ?? ''}`.trim() } }] : [],
      );
      flash(`${t.id} approved`, 'green');
    } catch (e) {
      flash(e.message, 'red');
    }
  }

  /** ⏎ */
  function open() {
    const r = selectedRow();
    if (!r) return;
    if (r.type === 'plan') return setScope({ level: 'plan', root: r.root, plan: r.plan }, { tab: view() === 'plan' ? 'plan' : 'tasks' });
    if (r.type === 'item' || (r.type === 'task' && view() === 'overview')) {
      setScope({ level: 'plan', root: r.root, plan: r.plan }, { tab: 'tasks', task: r.task });
      if (r.task) (ui.overlay = 'detail'), (ui.scrolls.detail = 0);
      return;
    }
    if (r.type === 'task') (ui.overlay = 'detail'), (ui.scrolls.detail = 0);
  }

  function fold(r, wantOpen) {
    if (!r) return false;
    if (r.type === 'plan') {
      ui.open.set(r.key, wantOpen ?? !r.open);
      return true;
    }
    if (r.type !== 'task' || !r.st.tasks[r.task].children.length) return false;
    const isOpen = !ui.collapsed.has(r.k);
    const target = wantOpen ?? !isOpen;
    if (target === isOpen) return false;
    if (target) ui.collapsed.delete(r.k);
    else ui.collapsed.add(r.k);
    return true;
  }

  // ---------- lifecycle ----------
  /**
   * Run herdr-side work (label sync, lifecycle sweep) in a detached `atf-herdr`
   * process. The board never calls herdr synchronously for it, so it can't freeze while
   * a sweep closes or relaunches agents. Overlapping runs are prevented by the sweep
   * lock and the delayed-sweep marker in atf-herdr.
   */
  const lastBg = new Map();
  function background(cmd, root, minGapMs = 0) {
    if (!inHerdr() || !spawnCmd) return;
    const key = `${cmd}#${root}`;
    if (minGapMs && Date.now() - (lastBg.get(key) || 0) < minGapMs) return;
    lastBg.set(key, Date.now());
    if (process.env.ATF_HERDR_TRACE) fs.appendFileSync(process.env.ATF_HERDR_TRACE, `${new Date().toISOString()} board -> atf-herdr ${cmd} --root ${root}\n`);
    try {
      const child = spawn(spawnCmd[0], [...spawnCmd.slice(1), cmd, '--root', root], { env: { ...process.env, ATF_DIR: root }, detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    } catch {}
  }

  /** Poll: plans in scope changed on disk? -> notify (if no hook), sync, redraw. */
  function poll() {
    try {
      pollOnce();
    } catch (e) {
      flash(`refresh error: ${e.message}`, 'red'); // never let one bad read stop the refresh loop
    }
  }

  function pollOnce() {
    const s = ui.scope;
    if (s.level === 'plan' && !fs.existsSync(eventsPath(s.root, s.plan))) {
      const title = ui.cache.get(keyOf(s.root, s.plan))?.state?.title || s.plan;
      ui.cache.delete(keyOf(s.root, s.plan));
      setScope({ level: 'project', root: s.root });
      flash(`plan "${title}" was deleted`);
    }
    if (ui.scope.level === 'project' && !fs.existsSync(path.join(ui.scope.root, 'plans'))) {
      const name = projectName(ui.scope.root);
      setScope({ level: 'all' });
      flash(`project ${name} no longer has an .atf directory`);
    }
    const plans = scopePlans();
    let changed = false;
    for (const p of plans) {
      const seen = ui.lastSeq.get(p.key);
      ui.lastSeq.set(p.key, p.st.last_seq);
      if (seen === undefined || p.st.last_seq === seen) continue;
      changed = true;
      if (inHerdr() && !hasHook(p.root)) {
        for (const e of readEvents(p.root, p.id).filter((e) => e.seq > seen))
          if (e.type === 'task.status' && ['blocked', 'review', 'failed'].includes(e.data?.status))
            herdrAsync(['notification', 'show', `ATF ${e.task} ${e.data.status}: ${p.st.tasks[e.task]?.title ?? ''}`.slice(0, 80), '--body', `${e.actor?.id ?? '?'}: ${e.data.message ?? ''}`.slice(0, 200), '--sound', 'request']);
      }
    }
    if (changed) for (const r of new Set(plans.map((p) => p.root))) if (!hasHook(r)) background('sync', r, 2000);
    draw();
  }

  function quit() {
    out.write(`${ESC}?25h${ESC}?1049l`);
    process.exit(0);
  }

  const UP = ['\x1b[A', 'k'];
  const DOWN = ['\x1b[B', 'j'];
  function onKey(k) {
    const page = Math.max(1, (out.rows || 24) - 8);
    const v = view();
    if (k === '\x03') return quit();
    if (k === 'q') {
      if (ui.overlay) ui.overlay = null;
      else return quit();
    } else if (v === 'help') {
      if (UP.includes(k)) ui.scrolls.help = Math.max(0, (ui.scrolls.help ?? 0) - 1);
      else if (DOWN.includes(k)) ui.scrolls.help = (ui.scrolls.help ?? 0) + 1;
      else ui.overlay = null;
    } else if (k === '\x1b') {
      if (ui.overlay) ui.overlay = null;
      else widen();
    } else if (k === '\t' || k === '\x1b[Z') {
      const i = TABS.findIndex(([id]) => id === ui.tab);
      ui.tab = TABS[(i + (k === '\t' ? 1 : TABS.length - 1)) % TABS.length][0];
      ui.overlay = null;
    } else if (/^[0-4]$/.test(k)) {
      ui.tab = TABS[Number(k)][0];
      ui.overlay = null;
    } else if (k === '?') ui.overlay = 'help';
    else if (k === 'A') setScope({ level: 'all' });
    else if ((k === 'p' || k === 'P') && ui.scope.level === 'plan') {
      const sibs = listPlanIds(ui.scope.root).map((id) => cachedPlan(ui.scope.root, id)).filter((st) => isOpenStatus(st) || st.id === ui.scope.plan);
      if (sibs.length > 1) {
        const i = sibs.findIndex((st) => st.id === ui.scope.plan);
        const next = sibs[(i + (k === 'p' ? 1 : sibs.length - 1)) % sibs.length];
        setScope({ level: 'plan', root: ui.scope.root, plan: next.id });
      }
    } else if (k === 'i' && ui.scope.level === 'all' && initDir && !findRoot(initDir)) {
      const r = initRoot(initDir);
      setScope({ level: 'project', root: r }, { tab: 'overview' });
      flash(`created ${initDir}/.atf — a coordinator can now start a plan (atf plan new …)`, 'green');
    } else if (v === 'overview' || v === 'tasks' || (v === 'plan' && multi())) {
      const key = v;
      const n = ui.rows[v].length;
      const r = selectedRow();
      if (UP.includes(k)) ui.sel[key] = Math.max(0, ui.sel[key] - 1);
      else if (DOWN.includes(k)) ui.sel[key] = Math.min(n - 1, ui.sel[key] + 1);
      else if (k === '\x1b[5~') ui.sel[key] = Math.max(0, ui.sel[key] - page);
      else if (k === '\x1b[6~') ui.sel[key] = Math.min(n - 1, ui.sel[key] + page);
      else if (k === '\x1b[H') ui.sel[key] = 0;
      else if (k === 'G' || k === '\x1b[F') ui.sel[key] = n - 1;
      else if (k === '\r') open();
      else if (k === 'g') return goTo();
      else if (k === 's') return spawnAgent();
      else if (k === 'a') return approve();
      else if (v === 'overview' && (k === '\x1b[C' || k === 'l')) r?.type === 'plan' && foldPlan(r, 'open');
      else if (v === 'overview' && (k === '\x1b[D' || k === 'h')) {
        if (r?.type === 'plan') foldPlan(r, 'close');
        else if (r?.type === 'task') ui.sel.overview = Math.max(0, ui.rows.overview.findIndex((x) => x.type === 'plan' && x.key === r.key));
      } else if (v === 'overview' && k === ' ') r?.type === 'plan' && foldPlan(r, 'cycle');
      else if (v === 'plan' && r?.type === 'plan' && ['\x1b[C', 'l', '\x1b[D', 'h', ' '].includes(k)) {
        const fold = k === ' ' ? !ui.cardFolded.has(r.key) : k === '\x1b[D' || k === 'h';
        if (fold) ui.cardFolded.add(r.key);
        else ui.cardFolded.delete(r.key);
      } else if (v === 'plan' && k === 'z') {
        const keys = ui.rows.plan.map((x) => x.key);
        const anyOpen = keys.some((key) => !ui.cardFolded.has(key));
        for (const key of keys) anyOpen ? ui.cardFolded.add(key) : ui.cardFolded.delete(key);
      } else if (v === 'overview' && k === 'z') {
        const plans = scopePlans();
        const anyOpen = plans.some((p) => foldOf(p) !== 'folded');
        for (const p of plans) ui.fold.set(p.key, anyOpen ? 'folded' : 'live');
      } else if (k === 'c') return closePlan(r?.type === 'item' || r?.type === 'task' || r?.type === 'plan' ? r : null);
      else if (k === 'f') {
        ui.showClosed = !ui.showClosed;
        flash(ui.showClosed ? 'showing closed plans too' : 'showing active plans only', 'blue');
      } else if (v === 'tasks' && (k === '\x1b[D' || k === 'h')) {
        if (!fold(r, false) && r?.type === 'task') {
          // jump to the parent task, or the plan header
          const parent = r.st.tasks[r.task].parent;
          const idx = ui.rows.tasks.findIndex((x) => (parent ? x.k === `${r.key}#${parent}` : x.type === 'plan' && x.key === r.key));
          if (idx >= 0) ui.sel.tasks = idx;
        }
      } else if (v === 'tasks' && (k === '\x1b[C' || k === 'l')) fold(r, true);
      else if (v === 'tasks' && k === ' ') fold(r);
      if (r?.root && r?.plan) ui.focus = { root: r.root, plan: r.plan };
    } else {
      const key = v;
      if (UP.includes(k)) ui.scrolls[key] = Math.max(0, (ui.scrolls[key] ?? 0) - 1);
      else if (DOWN.includes(k)) ui.scrolls[key] = (ui.scrolls[key] ?? 0) + 1;
      else if (k === '\x1b[5~') ui.scrolls[key] = Math.max(0, (ui.scrolls[key] ?? 0) - page);
      else if (k === '\x1b[6~') ui.scrolls[key] = (ui.scrolls[key] ?? 0) + page;
      else if (k === '\r' && v === 'detail') ui.overlay = null;
      else if (v === 'detail' && k === 'g') return goTo();
      else if (v === 'detail' && k === 's') return spawnAgent();
      else if (v === 'detail' && k === 'a') return approve();
      else if (k === 'A') setScope({ level: 'all' });
    }
    draw();
  }

  // ---------- start ----------
  if (initialRoot && start !== 'overview-all') {
    const plan = pickPlan(initialRoot);
    // open the plan only if it is still open; a project with only closed plans starts at project scope
    if (plan && isOpenStatus(cachedPlan(initialRoot, plan))) setScope({ level: 'plan', root: initialRoot, plan }, { tab: 'tasks' });
    else setScope({ level: 'project', root: initialRoot }, { tab: 'overview' });
  } else setScope({ level: 'all' }, { tab: 'overview' });
  if (initialRoot) ui.focus = ui.focus || { root: initialRoot, plan: pickPlan(initialRoot) };

  out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit);
  out.on('resize', draw);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    const keys = d.match(/\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|\x1b|[\s\S]/g) || [];
    for (const k of keys) onKey(k);
  });

  if (ui.scope.level === 'all' && inHerdr()) discoverRoots();
  for (const p of scopePlans()) ui.lastSeq.set(p.key, p.st.last_seq);
  for (const r of new Set(scopePlans().map((p) => p.root))) if (!hasHook(r)) background('sync', r);
  draw();
  refreshAgents();
  setInterval(refreshAgents, 3000);
  setInterval(poll, 1000);
  // agents go idle after their last write (no hook fires then): sweep projects in scope
  // (in the background, see background()); hooks cover writes, this covers idle agents
  setInterval(() => new Set(scopePlans().map((p) => p.root)).forEach((r) => background('sweep', r)), 20_000);
}
