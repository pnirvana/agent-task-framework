// Interactive ATF board for a herdr pane (split or popup). Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { TERMINAL, driverInbox, planSummary, HUMAN } from '../../../src/core.mjs';
import { listPlanIds, loadPlan, readEvents, getCurrentPlan, eventsPath, transact, resolveActor, readConfig, findRoot, initRoot, knownRoots, projectName, reviewEvents, hasLiveWaiter } from '../../../src/store.mjs';
import { herdrAsync, herdrText, agentIndex, inHerdr, sameServer, discoverRoots, registerBoardProcess, claimNavKeys, inProject, pluginConfig, focusPane } from './herdr.mjs';
import { progressText } from './sync.mjs';
import { textField, keyField, fieldText, fieldRows, fieldMode } from './textfield.mjs';
import { activeRuns, taskLive, liveBadge, elapsed, readTail, earlierText, liveView, hasView, liveOpen, liveItem, loadLiveKinds, enableAutoRefresh, supersedeKey, artifactKind } from '../../../src/live.mjs';
import { fileURLToPath } from 'node:url';
import { planChanges, levelSets, totals, projectPath, changeMode, diffTool } from '../../../src/changes.mjs';
import { notifyTick } from './notify.mjs';
import { liveAgent as liveAgentOf, agentFor as agentForOf, coordinatorOf as coordinatorOfPlan, inboxOf as inboxOfPlan, attentionOf as attentionOfPlan, elsewhere } from './attention.mjs';
const ATF_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bin/atf.mjs');

const ESC = '\x1b[';
const STYLE = { reset: 0, bold: 1, dim: 2, inverse: 7, selected: '44;97', match: '22;30;43', matchcur: '22;30;46', red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };
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

// Display width of a character: wide ones (emoji such as ⧖, CJK) take two columns,
// combining marks and variation selectors none. A line wider than the pane wraps, scrolls
// the screen by a line, and every redraw puts it back: the top of the board flickers.
const WIDE = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd]];
export function charWidth(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x300) return c < 32 ? 0 : 1;
  if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x20d0 && c <= 0x20ff) || (c >= 0xfe00 && c <= 0xfe0f)) return 0;
  for (const [a, b] of WIDE) if (c >= a && c <= b) return 2;
  return 1;
}
/** Display width of a string (columns). */
export const strWidth = (s) => [...String(s)].reduce((n, ch) => n + charWidth(ch), 0);

/** A line is a list of [text, style] segments; fit() truncates to width (columns) before styling. */
export function fit(segs, width, fill = false) {
  let out = '';
  let used = 0;
  for (const [text, style] of segs) {
    if (used >= width) break;
    let take = '';
    for (const ch of String(text)) {
      const w = charWidth(ch);
      if (used + w > width) {
        used = width; // a wide character that does not fit: leave the column empty
        break;
      }
      take += ch;
      used += w;
    }
    out += style ? sty(style) + take + `${ESC}0m` : take;
  }
  if (fill && used < width) out += ' '.repeat(width - used);
  return out;
}
const wrap = (text, width) => {
  width = Math.max(8, width);
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length <= width) {
        line = (line + ' ' + word).trim();
        continue;
      }
      if (line) lines.push(line);
      // a word longer than the line (a path, a URL): split it, nothing is lost
      while (word.length > width) lines.push(word.slice(0, width)), (word = word.slice(width));
      line = word;
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
 * Entry point. Starts on the Overview of all known projects (ATF_BOARD_START=plan: the
 * plan of the given .atf root instead), offering `i` to create a project
 * in `initDir` when it has none.
 */
export function runBoard(opts) {
  // the Overview across all projects by default; ATF_BOARD_START=plan opens the project's plan
  const start = opts.start ?? process.env.ATF_BOARD_START ?? 'overview-all';
  return runMain({ ...opts, start, initDir: opts.initDir || process.cwd() });
}

// The board is the human's: it writes as the actor "human", never under the user's name,
// which a coordinator started by hand uses too (its waits would skip "its own" writes).
const humanActor = () => resolveActor({ id: HUMAN, role: 'human' });

const TABS = [
  ['overview', 'Overview'],
  ['tasks', 'Tasks'],
  ['plan', 'Plan'],
  ['log', 'Log'],
  ['changes', 'Changes'],
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
    sel: { overview: 0, tasks: 0, plan: 0, changes: 0 },
    search: null, // {key (view), q, line, index}: / in a view
    drawn: {}, // view -> {texts, top, h, list}: what it drew last (for the search)
    changes: new Map(), // plan key -> {seq, at, data, pending}: changesets (§15)
    scrolls: {},
    open: new Map(), // plan key -> expanded? (multi-plan Tasks view)
    collapsed: new Set(), // task keys collapsed in the tree
    focus: null, // {root, plan}: plan for the Plan tab when the scope holds several
    cache: new Map(), // plan key -> {mtime, state}
    agents: new Map(),
    agentsSince: new Map(),
    flash: null,
    lastSeq: new Map(), // plan key -> last seq seen (board notifications)
    rows: { overview: [], tasks: [], plan: [], changes: [] }, // selectable rows of the current draw
    back: null, // {scope, sel}: where esc returns to after ⏎ on the Overview
    log: { plan: null, query: '' }, // Log tab filter: plan key, search words
    picker: null, // plan picker: {title, query, sel, items(), onPick(item)}
    byAgent: false, // Tasks: grouped by agent (v) instead of the task tree
    cardFolded: new Set(), // plan tab: plan keys whose card is folded to its title line
    showClosed: false, // wider scopes: also list completed / cancelled plans
    confirm: null, // {action, key, until}: second press confirms
    input: null, // one-line text input: {label, value, onSubmit}
    live: null, // the live view (L): {root, plan, task, ref, skey, raw, follow, folded, from, item, meta}
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
    Object.defineProperty(state, 'root', { value: r, enumerable: false }); // liveAgent checks the agent's directory
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
    ui.sel = { overview: 0, tasks: 0, plan: 0, changes: 0 };
    if (task) {
      const st = cachedPlan(scope.root, scope.plan);
      for (const pid of st.tasks[task]?.path || []) ui.collapsed.delete(`${keyOf(scope.root, scope.plan)}#${pid}`);
      buildTaskRows();
      ui.sel.tasks = Math.max(0, ui.rows.tasks.findIndex((r) => r.task === task));
    }
  }

  /** Return to the Overview a ⏎ there came from. */
  function back() {
    const b = ui.back;
    ui.back = null;
    setScope(b.scope, { tab: 'overview' });
    ui.sel.overview = b.sel;
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

  // liveness and "needs you" (attention.mjs, shared with the notifications)
  const LV = { agents: null, sinceOf: (pane) => ui.agentsSince.get(`pane:${pane}`)?.since };
  const lv = () => ((LV.agents = ui.agents), LV);
  const liveAgent = (st, actorId) => liveAgentOf(lv(), st, actorId);
  const agentFor = (st, t) => agentForOf(lv(), st, t);

  const effStatus = (t) => t.rollup_status ?? t.status;

  // ---------- inbox ----------
  const inboxOf = (p) => inboxOfPlan(lv(), p);

  // ---------- rendering helpers ----------
  function bar(frac, w) {
    const fill = Math.round(frac * w);
    return [
      ['█'.repeat(fill), 'green'],
      ['░'.repeat(w - fill), 'gray'],
    ];
  }
  // shorten to w columns (with …), or pad to w
  const clip = (s, w) => {
    if (strWidth(s) <= w) return s + ' '.repeat(w - strWidth(s));
    let out = '';
    let n = 0;
    for (const ch of String(s)) {
      if (n + charWidth(ch) > Math.max(1, w - 1)) break;
      out += ch;
      n += charWidth(ch);
    }
    return out + '…' + ' '.repeat(Math.max(0, w - n - 1));
  };

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
      crumbs.push([' › ', 'dim'], [st?.title ?? s.plan, 'bold cyan']);
      if (st && st.status !== 'active') crumbs.push([`  (${st.status})`, 'yellow']);
    }
    const leaves = plans.reduce((n, p) => n + planSummary(p.st).total - (p.st.counts.cancelled || 0), 0);
    const done = plans.reduce((n, p) => n + (p.st.counts.done || 0), 0);
    const frac = leaves ? done / leaves : 0;
    const inbox = plans.filter((p) => isOpenStatus(p.st)).reduce((n, p) => n + attentionOf(p).mine.length, 0);
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
    // a section header: the plan's title stands out, a rule runs to the edge, and its
    // tasks hang below it on a guide line (see taskRowLine)
    const segs = [
      mark(selected),
      [open ? '▾ ' : '▸ ', 'bold cyan'],
      [clip(p.st.title, Math.max(12, W - 56)).trimEnd(), selected ? 'inverse bold cyan' : 'bold cyan'],
      [ui.scope.level === 'all' ? `  ${projectName(p.root)}` : '', 'cyan'],
      ['  ', ''],
      ...bar(sum.progress, 8),
      [` ${String(pct).padStart(3)}% ${p.st.counts.done}/${sum.total} `, 'dim'],
      [inbox ? `⚑${inbox} ` : '', 'red bold'],
      [p.st.status === 'paused' ? 'paused ' : '', 'yellow'],
      [ago(p.st.updated_at) + ' ', 'dim'],
    ];
    const used = segs.reduce((n, [x]) => n + [...String(x)].length, 0);
    return [...segs, ['─'.repeat(Math.max(0, W - used - 1)), 'cyan dim']];
  }

  /** §14: commands agents of a plan run right now (re-read at most once a second). */
  const runsCache = new Map();
  function runsOf(root, planId) {
    const k = keyOf(root, planId);
    const hit = runsCache.get(k);
    if (hit && Date.now() - hit.at < 900) return hit.runs;
    const runs = activeRuns(root, planId);
    runsCache.set(k, { at: Date.now(), runs });
    return runs;
  }
  /** The live view of a task: only for tasks that can have something running or just ran. */
  const liveOf = (st, t) => (!st.root || t.children.length || ['todo', 'done', 'cancelled'].includes(t.status) ? null : taskLive(t, runsOf(st.root, st.id)));

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
      if (t.assignee && t.assignee !== row.under) right.push([`▣ ${t.assignee}`, 'cyan bold']);
    } else {
      if (t.status === 'todo' && t.waiting_on.length) right.push([`⧗ ${t.waiting_on.join(',')}`, 'dim']);
      if (t.status === 'blocked' && t.blocked_on.length) right.push([t.can_resume ? 'can resume' : `⧗ on ${t.blocked_on.join(',')}`, t.can_resume ? 'green' : 'dim']);
      if (t.human_input?.length) right.push(['✎ with coordinator', 'magenta']);
      if (t.status === 'blocked' && t.blocked_for === 'human' && !t.answered) right.push(['for you', 'red bold']);
      if (t.changes_requested) right.push([`↺ changes`, 'magenta']);
      else if (t.ready && !t.owner) right.push(['ready', 'green']);
      const live = liveOf(st, t);
      const badge = live && liveBadge(live);
      if (badge) right.push([`${badge.glyph} ${clip(badge.text, 26).trimEnd()}`, badge.color]);
      if (t.status === 'in_progress' && t.percent != null) right.push([`${t.percent}%`, 'yellow']);
      if (row.under && t.owner === row.under); // the agent heading above names it
      else if (t.assignee) right.push([t.assignee, 'cyan']);
      else if (t.owner) right.push([`↳${t.owner}`, 'cyan dim']);
      if (a && !(row.under && t.owner === row.under)) {
        const [ag, ac] = AGENT_GLYPH[a.agent_status] || AGENT_GLYPH.unknown;
        right.push([ag, ac]);
      } else if (a);
      else if (t.owner && elsewhere(st, t.owner)) right.push(['↗', 'gray']);
      if (a?.stale) right.push(['stale?', 'red bold']);
    }
    for (let i = right.length - 1; i > 0; i--) right.splice(i, 0, [' ', '']);
    const rightLen = right.reduce((n, [x]) => n + [...x].length, 0);
    const fold = row.flat ? (t.children.length ? '▣' : ' ') : t.children.length ? (ui.collapsed.has(row.k) ? '▸' : '▾') : ' ';
    const lead = `${selected ? ' › ' : '   '}${multi() ? '│ ' : ''}${row.prefix}`;
    const left = `${fold}${t.id} `;
    const crumb = row.crumb ? clip(row.crumb, Math.max(0, Math.floor((W - rightLen) / 3))).trimEnd() + ' ' : '';
    const titleW = Math.max(4, W - 1 - [...lead].length - [...left].length - 2 - [...crumb].length - rightLen - 2);
    const base = selected ? 'inverse ' : '';
    return [
      [lead, selected ? 'cyan bold' : 'gray'],
      [left, base + 'bold'],
      [g + ' ', (base + color).trim()],
      [crumb, 'gray'],
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
      if (ui.byAgent) {
        agentRows(p, rows);
        continue;
      }
      const visit = (id, prefix, isLast, depth) => {
        const k = `${p.key}#${id}`;
        rows.push({ type: 'task', root: p.root, plan: p.id, st: p.st, key: p.key, task: id, k, prefix: depth ? prefix + (isLast ? '└─' : '├─') : '' });
        if (ui.collapsed.has(k)) return;
        const kids = p.st.tasks[id].children;
        kids.forEach((c, i) => visit(c, depth ? prefix + (isLast ? '  ' : '│ ') : '', i === kids.length - 1, depth + 1));
      };
      const roots = p.st.order.filter((id) => !p.st.tasks[id].parent || !p.st.tasks[p.st.tasks[id].parent]);
      roots.forEach((id, i) => visit(id, '', i === roots.length - 1, 0));
      if (!roots.length && multi()) rows.push({ type: 'note', text: '   │ no tasks yet', key: p.key, k: p.key + '#empty' });
    }
    // keep the selection on the same row when rows change
    const prev = ui.rows.tasks[ui.sel.tasks]?.k;
    ui.rows.tasks = rows;
    const i = prev ? rows.findIndex((r) => r.k === prev) : -1;
    ui.sel.tasks = i >= 0 ? i : Math.min(ui.sel.tasks, Math.max(0, rows.length - 1));
    return rows;
  }

  /**
   * Tasks grouped by agent (v): per agent its live state and progress, then its work
   * packages and tasks (each with its place in the plan), then the tasks nobody owns.
   */
  function agentRows(p, rows) {
    const st = p.st;
    const base = { root: p.root, plan: p.id, st, key: p.key };
    const crumbOf = (t, from) => {
      const rel = from ? t.path.slice(t.path.indexOf(from) + 1) : t.path;
      return rel.length ? rel.map((x) => st.tasks[x].title).join(' › ') + ' › ' : '';
    };
    const actors = Object.values(st.actors)
      .filter((a) => a.owned.length || a.packages.length)
      .sort((a, b) => a.owned.every((id) => TERMINAL.has(st.tasks[id].status)) - b.owned.every((id) => TERMINAL.has(st.tasks[id].status)));
    for (const a of actors) {
      rows.push({ ...base, type: 'agent', actor: a.id, k: `${p.key}@${a.id}` });
      const pkgOf = (t) => [...t.path].reverse().find((id) => st.tasks[id].assignee === a.id) ?? null;
      const pkgs = a.packages.filter((id) => st.tasks[id]);
      for (const id of pkgs) {
        rows.push({ ...base, type: 'task', task: id, k: `${p.key}@${a.id}#${id}`, prefix: '  ', flat: true, under: a.id, crumb: crumbOf(st.tasks[id]) });
        for (const tid of a.owned.filter((x) => pkgOf(st.tasks[x]) === id)) rows.push({ ...base, type: 'task', task: tid, k: `${p.key}@${a.id}#${tid}`, prefix: '    ', flat: true, under: a.id, crumb: crumbOf(st.tasks[tid], id) });
      }
      for (const tid of a.owned.filter((x) => !pkgOf(st.tasks[x]))) rows.push({ ...base, type: 'task', task: tid, k: `${p.key}@${a.id}#${tid}`, prefix: '  ', flat: true, under: a.id, crumb: crumbOf(st.tasks[tid]) });
    }
    const unowned = st.order.filter((id) => !st.tasks[id].owner && !st.tasks[id].children.length && !TERMINAL.has(st.tasks[id].status));
    if (unowned.length) {
      rows.push({ ...base, type: 'agent', actor: null, unowned: unowned.length, ready: unowned.filter((id) => st.tasks[id].ready).length, k: `${p.key}@-` });
      for (const tid of unowned) rows.push({ ...base, type: 'task', task: tid, k: `${p.key}@-#${tid}`, prefix: '  ', flat: true, crumb: crumbOf(st.tasks[tid]) });
    }
    if (!actors.length && !unowned.length) rows.push({ type: 'note', text: multi() ? '   │ no tasks yet' : '   no tasks yet', key: p.key, k: p.key + '#empty' });
  }

  /** An agent's heading in the by-agent grouping: live state, progress, last seen. */
  function agentRowLine(r, W, selected) {
    const lead = [`${selected ? ' › ' : '   '}${multi() ? '│ ' : ''}`, selected ? 'cyan bold' : 'gray'];
    if (!r.actor) return [lead, ['unassigned', (selected ? 'inverse ' : '') + 'bold'], [`  ${r.unowned} open · `, 'dim'], [`${r.ready} ready`, 'green']];
    const st = r.st;
    const a = st.actors[r.actor];
    const owned = a.owned.map((id) => st.tasks[id]);
    const done = owned.filter((t) => t.status === 'done').length;
    const live = liveAgent(st, a.id);
    const away = elsewhere(st, a.id);
    const [ag, ac] = live ? AGENT_GLYPH[live.agent_status] || AGENT_GLYPH.unknown : away ? ['↗', 'gray'] : ['·', 'gray'];
    const state = live ? `${live.agent_status} in ${live.pane_id}` : away ? 'another herdr session' : owned.every((t) => TERMINAL.has(t.status)) ? 'finished' : inHerdr() ? 'no live pane' : '';
    return row(
      [lead, [a.id, (selected ? 'inverse ' : '') + 'bold cyan'], [a.role && !['subagent', 'agent'].includes(a.role) ? `  ${a.role}` : '', 'dim'], ['  ' + ag + ' ', ac], [state, 'dim']],
      [...bar(owned.length ? done / owned.length : 0, 8), [` ${done}/${owned.length}`, 'dim'], [a.last_seen ? `  seen ${ago(a.last_seen)}` : '', 'dim']],
      W,
    );
  }

  /**
   * §14: what the task's agent runs or waits for now (with the last lines of its output),
   * and the recorded runs and live files with their summaries. L opens the output.
   */
  function liveDetail(st, t, W, { recorded: maxRec = 5, tail = 4 } = {}) {
    const live = st.root ? taskLive(t, runsOf(st.root, st.id)) : null;
    if (!live || (!live.now.length && !live.recorded.length)) return [];
    const L = [[], [['live', 'bold'], ['  L live view', 'dim']]];
    const COL = { ok: 'green', failed: 'red', waiting: 'yellow', running: 'cyan', gone: 'gray', unknown: '' };
    const cmdLine = (c) => String(c || '').split('\n')[0];
    for (const r of live.now) {
      L.push([[r.waiting ? '  ⧖ waiting ' : '  ⚙ running ', r.waiting ? 'yellow bold' : 'cyan bold'], [elapsed(r.since) + '  ', 'dim'], [r.summary.line, COL[r.summary.state] || '']]);
      L.push([['    $ ' + cmdLine(r.cmd), 'dim']]);
      if (hasView(r.kind)) {
        // the kind's own view (maven: test progress, modules, the class running now)
        for (const l of liveView(r, r.summary, { width: W - 4, active: true })) L.push([['    ', ''], ...l]);
        continue;
      }
      const out = (readTail(r.out, 8192) || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').split('\n').filter((l) => l.trim()).slice(-tail);
      for (const l of tail ? out : []) L.push([['    │ ' + clip(l, W - 7).trimEnd(), 'gray']]);
      for (const d of r.summary.details.slice(0, 4)) L.push([['    ' + d, 'red']]);
    }
    for (const a of live.recorded.slice(0, maxRec)) {
      const s = a.summary;
      const when = a.exit != null ? `exit ${a.exit}${a.duration_ms ? ' · ' + elapsed(0, a.duration_ms) : ''} · ${ago(a.ts)} ago` : a.live ? (s.mtime ? `written ${ago(new Date(s.mtime).toISOString())} ago` : '') : '';
      L.push([[`  ${a.kind.padEnd(8)} `, COL[s.state] || ''], [s.line + '  ', COL[s.state] || ''], [when, 'dim']]);
      if (a.cmd || a.live) L.push([[`    ${a.cmd ? '$ ' + cmdLine(a.cmd) : path.basename(a.ref)}`, 'dim']]);
      for (const d of s.details.slice(0, 4)) L.push([['    ' + d, s.state === 'failed' ? 'red' : 'dim']]);
    }
    if (live.recorded.length > maxRec) L.push([[`  … ${live.recorded.length - maxRec} more (${maxRec < 5 ? '⏎ details' : 'atf live ' + t.id})`, 'dim']]);
    // runs a newer run of the same kind and directory replaced: history, one line
    if (live.earlier.length) L.push([[`  ${earlierText(live)} · atf live ${t.id} --all`, 'dim']]);
    return L;
  }

  function detailLines(st, id, W) {
    const t = st.tasks[id];
    if (!t) return [];
    const L = [];
    const sel = ui.rows.tasks[ui.sel.tasks];
    if (t.human_input?.length) {
      L.push([['✎ your input, waiting for the coordinator to act on it', 'magenta bold']]);
      for (const n of t.human_input) for (const l of wrap(n.message, W - 4)) L.push([['  ' + l, '']]);
      L.push([]);
    }
    // which plan this is, always: a header band like the plan rows in the Tasks list
    const proj = projectName(sel?.root ?? st.root ?? '');
    const band = [['▍', 'cyan'], ['plan ', 'cyan'], [st.title, 'bold cyan'], [proj ? `  ${proj}` : '', 'cyan'], [`  ${Math.round(st.progress * 100)}% · ${progressText(st)}`, 'dim']];
    L.push(band, []);
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
    if (t.reviewer) meta.push([`reviewer ${t.reviewer}  `, 'magenta']);
    else if (t.review) meta.push(['review required  ', 'magenta']);
    meta.push([`updated ${ago(t.updated_at)} ago`, 'dim']);
    L.push(meta);
    if (a?.stale) L.push([['⚠ agent is idle but the task is still in progress: it may have stopped without reporting', 'red']]);
    if (t.last_message && !TERMINAL.has(t.status)) for (const l of wrap('» ' + t.last_message, W - 2)) L.push([[l, t.status === 'blocked' ? 'red' : 'yellow']]);
    L.push(...liveDetail(st, t, W));
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
    if (t.feedback?.length) {
      const fb = t.feedback[t.feedback.length - 1];
      L.push([], [[t.changes_requested ? '↺ changes requested' : 'last review feedback', t.changes_requested ? 'bold magenta' : 'bold'], [`  round ${fb.round} · ${fb.actor ?? ''} ${ago(fb.ts)} ago`, 'dim']]);
      for (const l of wrap(fb.message, W - 2)) L.push([[l, t.changes_requested ? 'magenta' : '']]);
    }
    if (t.origin) L.push([], [['follow-up of ', 'dim'], [`${t.origin} ${st.tasks[t.origin]?.title ?? ''}`, '']]);
    if (t.followups?.length) L.push([[`follow-ups: ${t.followups.join(', ')}`, 'dim']]);
    if (t.checkpoint && !TERMINAL.has(t.status)) {
      L.push([], [['checkpoint', 'bold'], [`  ${t.checkpoint.actor ?? ''} ${ago(t.checkpoint.ts)} ago`, 'dim']]);
      for (const l of wrap(t.checkpoint.message, W - 2)) L.push([[l, '']]);
    }
    if (t.result) {
      L.push([], [['result', 'bold']]);
      for (const l of wrap(t.result, W - 2)) L.push([[l, 'green']]);
    }
    const outputs = t.artifacts.filter((x) => !x.live && !x.cmd); // live files and runs: under live
    if (outputs.length) {
      L.push([], [['artifacts', 'bold']]);
      for (const x of outputs) L.push([[`  ${x.kind} `, 'dim'], [x.ref, 'cyan'], [x.description ? ' — ' + x.description : '', 'dim']]);
    }
    // §15: the files it changed (its subtree's, for a parent); d opens their diff
    const ch = st.root ? changesOf({ root: st.root, id: st.id, st, key: keyOf(st.root, st.id) }) : null;
    const sets = ch ? levelSets(ch, id) : [];
    if (sets.length) {
      const tot = totals(sets);
      const overlap = [...new Set(sets.flatMap((x) => x.overlap || []))];
      L.push([], [['changes', 'bold'], [`  ${statStr(tot)} · d diff · 4 Changes`, 'dim'], [overlap.length ? `  ⚠ overlaps ${overlap.join(',')} in time` : '', 'yellow']]);
      const files = sets.flatMap((x) => x.files.map((f) => [x, f]));
      for (const [x, f] of files.slice(0, 12)) L.push([[`  ${f.status} `, FILE_STYLE[f.status] || ''], [projectPath(x, f), ''], [f.binary ? '  binary' : `  +${f.added} -${f.removed}`, 'dim']]);
      if (files.length > 12) L.push([[`  … ${files.length - 12} more`, 'dim']]);
    }
    if (t.notes.length) {
      L.push([], [['notes', 'bold']]);
      for (const n of t.notes.slice(-6)) {
        L.push([[`  ${n.actor || ''}`, 'cyan'], [`  ${n.kind !== 'info' ? n.kind + ' · ' : ''}${ago(n.ts)} ago`, 'dim']]);
        for (const l of wrap(n.message, W - 5)) L.push([['    ' + l, n.kind === 'question' || n.kind === 'warning' ? 'yellow' : '']]);
      }
    }
    const hist = t.history.slice(-8);
    if (hist.length) {
      L.push([], [['activity', 'bold']]);
      for (const h of hist) {
        const what = h.type === 'status' ? `${h.from} → ${h.to}` : h.type === 'assigned' ? `assigned ${h.assignee ?? '-'}` : `progress${h.percent != null ? ' ' + h.percent + '%' : ''}`;
        L.push([[`  ${ago(h.ts).padStart(4)} `, 'dim'], [(h.actor || '') + ' ', 'cyan'], [what, '']]);
        if (h.message) for (const l of wrap(h.message, W - 10)) L.push([['        ' + l, 'dim']]);
      }
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
      row.render = (sel) => {
        // the plan's title is the card's header: bold cyan, with a rule to the edge
        const segs = [
          mark(sel),
          [folded ? '▸ ' : '▾ ', 'bold cyan'],
          // closed plans: plain cyan instead of bold, still readable (they used to be dimmed)
          [clip(s.title, Math.max(14, W - 52)).trimEnd(), (sel ? 'inverse ' : '') + (isOpenStatus(s) ? 'bold cyan' : 'cyan')],
          [ui.scope.level === 'all' ? `  ${projectName(p.root)}` : '', 'cyan'],
          [`  ${s.status} · ${s.counts.done}/${planSummary(s).total} tasks · ${ago(s.updated_at)} ago `, s.status === 'completed' ? 'green' : s.status === 'active' ? 'blue' : 'yellow'],
        ];
        const used = segs.reduce((n, [x]) => n + [...String(x)].length, 0);
        return [...segs, ['─'.repeat(Math.max(0, W - used - 1)), 'cyan dim']];
      };
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
      // names as wide as the pane allows: lead, glyph, bar, percent and owners take the rest
      const ownersOf = (id) => [...new Set(s.order.filter((x) => (x === id || s.tasks[x].path.includes(id)) && s.tasks[x].owner).map((x) => s.tasks[x].owner))].join(', ');
      const ownW = Math.min(30, Math.max(0, ...roots.slice(0, 6).map((id) => strWidth(ownersOf(id)))));
      const nameW = Math.max(12, Math.min(Math.max(8, ...roots.map((id) => strWidth(`${id} ${s.tasks[id].title}`))), W - 8 - 1 - 8 - 7 - ownW - 2));
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
      const arts = s.order.reduce((a, id) => a + s.tasks[id].artifacts.filter((x) => !x.live && !x.cmd).length, 0);
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
    const head = [['▍', 'cyan'], [s.title, 'bold cyan'], [`  ${projectName(p.root)}`, 'cyan'], [`  ${s.status} `, s.status === 'completed' ? 'green' : s.status === 'active' ? 'blue' : 'yellow']];
    const used = head.reduce((n, [x]) => n + [...String(x)].length, 0);
    L.push([...head, ['─'.repeat(Math.max(0, W - used - 1)), 'cyan dim']]);
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
    if (s.docs?.length) L.push([], [[' documents', 'bold'], ['  o opens the first', 'dim']], ...s.docs.map((d) => [['  ' + d, 'cyan']]));
    if (s.questions?.length) {
      L.push([], [[' questions for you', 'bold red'], ['  r answers', 'dim']]);
      for (const q of s.questions) for (const l of wrap(q.message, W - 3)) L.push([['  ' + l, 'yellow']]);
    }
    if (s.checkpoint) {
      L.push([], [[' plan checkpoint', 'bold'], [`  ${s.checkpoint.actor ?? ''} ${ago(s.checkpoint.ts)} ago`, 'dim']]);
      for (const l of wrap(s.checkpoint.message, W - 3)) L.push([['  ' + l, '']]);
    }
    const coord = coordinatorOf(s);
    L.push([], [[' coordinator  ', 'bold'], [coord.id ?? '?', 'cyan'], [coord.live ? `  ${coord.live.agent_status} in ${coord.live.pane_id}` : coord.away ? '  in another herdr session' : '  not running', coord.live ? 'dim' : 'red'], [s.session ? `  · session ${path.basename(s.session.ref)}` : '', 'dim'], ['   s resume · S fresh', 'dim']]);
    const roots = s.order.filter((id) => !s.tasks[id].parent || !s.tasks[s.tasks[id].parent]);
    if (roots.length) {
      L.push([], [[' breakdown', 'bold'], ['  (top-level branches)', 'dim']]);
      const ownersOf = (id) => [...new Set(s.order.filter((x) => (x === id || s.tasks[x].path.includes(id)) && s.tasks[x].owner).map((x) => s.tasks[x].owner))].join(', ');
      const ownW = Math.min(30, Math.max(0, ...roots.map((id) => strWidth(ownersOf(id)))));
      const nameW = Math.max(12, Math.min(Math.max(...roots.map((id) => strWidth(`${id} ${s.tasks[id].title}`))), W - 4 - 1 - 10 - 7 - ownW - 2));
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
      // question-blocks need someone; blocks --on other tasks only wait for them
      for (const t of blocked)
        L.push(
          t.blocked_on.length
            ? [[`  ${t.id} `, 'bold'], [t.can_resume ? 'can resume ' : `⧗ on ${t.blocked_on.join(',')} `, t.can_resume ? 'green' : 'dim'], [t.last_message || t.title, 'dim']]
            : [[`  ${t.id} `, 'bold'], [t.last_message || t.title, 'red']],
        );
    }
    const arts = s.order.flatMap((id) => s.tasks[id].artifacts.filter((x) => !x.live && !x.cmd).map((x) => ({ ...x, task: id })));
    if (arts.length) {
      L.push([], [[' artifacts', 'bold']]);
      for (const x of arts) L.push([[`  ${x.task.padEnd(4)} ${x.kind.padEnd(7)}`, 'dim'], [x.ref, 'cyan'], [x.description ? ' — ' + x.description : '', 'dim']]);
    }
    return L;
  }

  /** Log tab: events of all plans in scope, newest first, tagged with their plan. */
  // ---------- plan picker ----------
  /**
   * A popup over the current view listing plans (p), grouped by project, each with its
   * goal, so a plan can be found by browsing as well as by name. Typing filters it: every
   * word must appear in the plan's title, project, goal or id. Within a project open
   * plans come first, then by last update; projects with recent open work come first.
   * `all` adds an "all plans" entry (picked as null).
   */
  function openPicker({ title, plans, all = false, current = null, onPick }) {
    const rank = (p) => (p.st.status === 'active' ? 0 : p.st.status === 'paused' ? 1 : 2);
    const byRecent = (a, b) => rank(a) - rank(b) || (b.st.updated_at || '').localeCompare(a.st.updated_at || '');
    // display order = selection order: projects by their best plan, plans inside them
    const groups = new Map();
    for (const p of [...plans].sort(byRecent)) {
      if (!groups.has(p.root)) groups.set(p.root, []);
      groups.get(p.root).push(p);
    }
    const list = [...groups.values()].flat();
    ui.picker = {
      title,
      query: '',
      sel: 0,
      scroll: 0,
      items() {
        const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
        const hit = list.filter((p) => words.every((w) => `${p.st.title} ${projectName(p.root)} ${p.st.goal ?? ''} ${p.id}`.toLowerCase().includes(w)));
        return all && !words.length ? [null, ...hit] : hit;
      },
      onPick,
    };
    const i = ui.picker.items().findIndex((p) => (p?.key ?? null) === current);
    ui.picker.sel = Math.max(0, i);
    claimNavKeys(true); // ctrl+j/ctrl+k: past pane-navigation plugins while the picker is open
  }
  function closePicker() {
    ui.picker = null;
    claimNavKeys(false);
  }

  /** Every plan the board knows: all projects, open and closed. */
  function allPlans() {
    const roots = knownRoots();
    if (initialRoot && !roots.includes(initialRoot)) roots.unshift(initialRoot);
    return roots.flatMap((r) => listPlanIds(r).map((id) => ({ root: r, id, st: cachedPlan(r, id), key: keyOf(r, id) })));
  }

  /** The picker box: exactly `bw` columns wide and at most `bh` lines. */
  function pickerBox(bw, bh) {
    const pk = ui.picker;
    const items = pk.items();
    pk.sel = Math.max(0, Math.min(pk.sel, items.length - 1));
    const iw = bw - 4; // inside the frame and its padding
    const words = pk.query.toLowerCase().split(/\s+/).filter(Boolean);
    // body rows: project headers (not selectable) and plan rows
    const body = [];
    let selRow = 0;
    let lastRoot;
    items.forEach((p, i) => {
      if (p && p.root !== lastRoot) {
        if (body.length) body.push([]);
        const name = projectName(p.root);
        const dir = path.dirname(p.root).replace(os.homedir(), '~');
        const room = iw - [...name].length - 2;
        body.push([[name, 'bold'], ['  ' + ([...dir].length > room ? '…' + [...dir].slice(-(room - 1)).join('') : dir), 'dim']]);
        lastRoot = p.root;
      }
      if (i === pk.sel) selRow = body.length;
      const sel = i === pk.sel;
      if (!p) return body.push([[sel ? '› ' : '  ', 'cyan bold'], ['all plans', (sel ? 'inverse ' : '') + 'bold cyan']]);
      const open = isOpenStatus(p.st);
      const sum = planSummary(p.st);
      const need = open ? attentionOf(p).mine.length : 0;
      const [g, gc] = { active: ['◐', 'blue'], paused: ['‖', 'yellow'], completed: ['●', 'green'], failed: ['✗', 'red'], cancelled: ['–', 'gray'] }[p.st.status] ?? ['?', 'gray'];
      body.push(
        row(
          [[sel ? '› ' : '  ', 'cyan bold'], [g + ' ', gc], ...highlight([[p.st.title, (sel ? 'inverse ' : '') + (open ? 'bold cyan' : 'cyan')], [p.st.goal ? '  ' + p.st.goal.replace(/\s+/g, ' ') : '', 'dim']], words)],
          [[need ? ` ⚑${need}` : '', 'red bold'], [`  ${p.st.counts.done ?? 0}/${sum.total}`, 'dim'], [` ${(open ? p.st.status : p.st.status).padEnd(9)}`, open ? 'blue' : p.st.status === 'completed' ? 'green' : 'yellow'], [ago(p.st.updated_at).padStart(4), 'dim']],
          iw,
        ),
      );
    });
    if (!items.length) body.push([['no plan matches the filter', 'dim']]);
    const n = items.filter(Boolean).length;
    const head = [
      [[pk.title, 'bold'], [`  ${n} plan${n === 1 ? '' : 's'}`, 'dim']],
      [['filter ', 'dim'], [pk.query + '█', pk.query ? 'bold yellow' : 'yellow'], [pk.query ? '' : '  type to narrow the list', 'dim']],
      [['─'.repeat(iw), 'gray']],
    ];
    const foot = [[['─'.repeat(iw), 'gray']], [['↑↓ / ctrl+j ctrl+k select  ⏎ pick  esc cancel  ⌫ edit filter', 'dim']]];
    const room = Math.max(3, Math.min(body.length, bh - 2 - head.length - foot.length));
    // keep the selected row (and its project header) in view
    if (selRow < pk.scroll + 1) pk.scroll = Math.max(0, selRow - 1);
    if (selRow >= pk.scroll + room) pk.scroll = selRow - room + 1;
    pk.scroll = Math.max(0, Math.min(pk.scroll, Math.max(0, body.length - room)));
    const shown = body.slice(pk.scroll, pk.scroll + room);
    while (shown.length < room) shown.push([]);
    if (pk.scroll > 0) shown[0] = [['  ▲ more', 'dim']];
    if (pk.scroll + room < body.length) shown[room - 1] = [['  ▼ more', 'dim']];
    const frame = (segs) => [['│ ', 'cyan'], ...padSegs(segs, iw), [' │', 'cyan']];
    return [[['┌' + '─'.repeat(bw - 2) + '┐', 'cyan']], ...[...head, ...shown, ...foot].map(frame), [['└' + '─'.repeat(bw - 2) + '┘', 'cyan']]];
  }

  /** Clip or pad segments to exactly w columns. */
  function padSegs(segs, w) {
    const outSegs = [];
    let used = 0;
    for (const [x, st] of segs) {
      const chars = [...String(x)];
      const take = chars.slice(0, w - used);
      if (take.length) outSegs.push([take.join(''), st]);
      used += take.length;
      if (used >= w) break;
    }
    if (used < w) outSegs.push([' '.repeat(w - used), '']);
    return outSegs;
  }

  /** Lay segments `over` onto a line at column x (the view stays visible around it). */
  function overlay(line, over, x, W) {
    const base = padSegs(line, W);
    const cut = (from, to) => {
      const res = [];
      let pos = 0;
      for (const [t, st] of base) {
        const chars = [...t];
        const a = Math.max(from, pos);
        const b = Math.min(to, pos + chars.length);
        if (b > a) res.push([chars.slice(a - pos, b - pos).join(''), st ? st + ' dim' : 'dim']);
        pos += chars.length;
      }
      return res;
    };
    const w = over.reduce((n, [t]) => n + [...String(t)].length, 0);
    return [...cut(0, x), ...over, ...cut(x + w, W)];
  }

  /** Keys while the picker is open: type to search, ↑↓ select, ⏎ pick, esc cancel. */
  function pickerKey(k) {
    const pk = ui.picker;
    const n = pk.items().length;
    if (k === '\x1b') closePicker();
    else if (k === '\r') {
      const item = pk.items()[pk.sel];
      closePicker();
      if (n) pk.onPick(item);
    } else if (k === '\x1b[A' || k === '\x10' || k === '\x0b') pk.sel = Math.max(0, pk.sel - 1); // ↑ ctrl+p ctrl+k
    else if (k === '\x1b[B' || k === '\x0e' || k === '\n') pk.sel = Math.min(n - 1, pk.sel + 1); // ↓ ctrl+n ctrl+j
    else if (k === '\x1b[5~') pk.sel = Math.max(0, pk.sel - 10);
    else if (k === '\x1b[6~') pk.sel = Math.min(n - 1, pk.sel + 10);
    else if (k === '\x7f' || k === '\b') (pk.query = [...pk.query].slice(0, -1).join('')), (pk.sel = 0);
    else if (k.length >= 1 && !k.startsWith('\x1b') && k >= ' ') (pk.query += k), (pk.sel = 0);
    draw();
  }

  /**
   * Log tab: events of all plans in scope, newest first, tagged with their plan.
   * `p`/`P` filter it to one plan of the scope (cycling back to all), `/` searches: every
   * word must appear in the line (actor, type, task, plan, message), matches highlighted.
   * Filtering reads each plan's whole history; unfiltered, its latest 200 events.
   */
  function logTabLines(W, plans) {
    const f = ui.log;
    if (f.plan && !plans.some((p) => p.key === f.plan)) f.plan = null; // scope changed
    const shown = f.plan ? plans.filter((p) => p.key === f.plan) : plans;
    const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
    const filtering = !!(f.plan || words.length);
    const evs = [];
    for (const p of shown) for (const e of filtering ? readEvents(p.root, p.id) : readEvents(p.root, p.id).slice(-200)) evs.push({ e, p });
    evs.sort((a, b) => (b.e.ts || '').localeCompare(a.e.ts || ''));
    const rowsOut = [];
    for (const { e, p } of evs) {
      const d = e.data || {};
      const bits = [d.status, d.percent != null ? d.percent + '%' : null, d.assignee !== undefined ? '→ ' + (d.assignee ?? '-') : null, d.title, d.ref, d.message].filter((x) => x != null && x !== '');
      const msg = bits.join(' · ').replace(/\s+/g, ' ');
      const planText = `${projectName(p.root)} ${p.st.title}`;
      if (words.length) {
        const hay = `${e.actor?.id ?? ''} ${e.type} ${e.task ?? ''} ${planText} ${msg}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      const tag = multi() && !f.plan ? clip(`${ui.scope.level === 'all' ? projectName(p.root) + '/' : ''}${p.st.title}`, 22) + ' ' : '';
      rowsOut.push(highlight([[`${ago(e.ts).padStart(4)} `, 'dim'], [tag, 'magenta'], [(e.actor?.id ?? '?').slice(0, 10).padEnd(11), 'cyan'], [e.type.replace(/^task\./, '').padEnd(9), 'bold'], [e.task ? e.task + ' ' : '', ''], [msg, 'dim']], words));
      if (rowsOut.length >= (filtering ? 2000 : 400)) break;
    }
    // the filter bar: always visible, so a filtered log never passes for the whole one
    const planName = f.plan ? shown[0]?.st.title ?? '' : multi() ? `all ${plans.length} plans` : plans[0]?.st.title ?? '';
    const bar = [
      [' plan ', 'dim'],
      [planName, f.plan ? 'bold cyan' : 'cyan'],
      [multi() ? ' (p)' : '', 'dim'],
      ['   search ', 'dim'],
      [f.query ? `"${f.query}"` : '—', f.query ? 'bold yellow' : 'dim'],
      [' (/' + (filtering ? ', esc clears' : '') + ')', 'dim'],
      [`   ${rowsOut.length}${rowsOut.length >= (filtering ? 2000 : 400) ? '+' : ''} event${rowsOut.length === 1 ? '' : 's'}`, 'dim'],
    ];
    if (!rowsOut.length) rowsOut.push([[words.length ? '   no events match' : '   no events yet', 'dim']]);
    return [bar, [['─'.repeat(W), 'gray']], ...rowsOut];
  }

  /** Mark every occurrence of the search words in a line's segments. */
  function highlight(segs, words) {
    if (!words.length) return segs;
    const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    // split() with a capturing group: odd parts are the matches
    return segs.flatMap(([text, style]) => String(text).split(re).map((part, i) => [part, i % 2 ? 'inverse yellow' : style]).filter(([part]) => part !== ''));
  }

  // ---------- overview: what needs you, what is being worked on ----------
  /**
   * The Overview answers two questions across all plans in scope, in this order:
   *   1. Needs you: what is blocked on the human (an agent at a terminal prompt, the
   *      coordinator waiting for input, reviews assigned to the human, a finished plan
   *      to close, and the plan's queue when no live coordinator handles it).
   *   2. In flight: per plan, the tasks being worked on now, with their latest
   *      progress message. The rest of the plan stays out of the way (⏎ opens it).
   * A context panel below shows what is needed to act on the selected row; the actions
   * (approve, request changes, reply, open the review artifact, jump to the agent)
   * work right there and take effect at once.
   */
  const NEED = {
    prompt: ['! prompt', 'red bold'],
    'no-coordinator': ['⚠ no coord', 'red bold'],
    coordinator: ['? input', 'yellow bold'],
    'your-review': ['◎ review', 'magenta bold'],
    question: ['⊘ question', 'red bold'],
    'plan-question': ['? plan', 'red bold'],
    failed: ['✗ failed', 'red'],
    review: ['◎ review', 'magenta'],
    stale: ['◌ stalled', 'red'],
    finished: ['● finished', 'green'],
  };
  const NEED_RANK = Object.fromEntries(Object.keys(NEED).map((k, i) => [k, i]));
  const coordinatorOf = (st) => coordinatorOfPlan(lv(), st);

  /** Tasks being worked on now: in progress, reworked after review, or answered; newest first. */
  function currentWork(st) {
    return st.order
      .map((id) => st.tasks[id])
      .filter((t) => !t.children.length && (t.status === 'in_progress' || (t.status === 'todo' && t.changes_requested && t.owner) || t.answered))
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  /**
   * A plan's attention items, split into what needs the human (`mine`) and what its live
   * coordinator handles (`queued`). Without herdr there is no liveness: all of it is mine.
   */
  function attentionOf(p) {
    return attentionOfPlan(lv(), p);
  }

  // narrow boards (the side column) drop the project name from row labels
  const planLabel = (p, W = 999) => (ui.scope.level === 'all' && W >= 100 ? `${p.st?.title ?? p.title} · ${projectName(p.root)}` : (p.st?.title ?? p.title));

  /** Last meaningful lines of an agent's terminal (cached, refreshed in the background). */
  const tails = new Map();
  function paneTail(pane, n = 10) {
    if (!pane || !inHerdr()) return null;
    const hit = tails.get(pane);
    if (!hit || (!hit.busy && Date.now() - hit.at > 3000)) {
      tails.set(pane, { at: Date.now(), lines: hit?.lines ?? null, busy: true });
      herdrText(['pane', 'read', pane, '--lines', '60', '--source', 'recent-unwrapped']).then((txt) => {
        tails.set(pane, { at: Date.now(), lines: txt == null ? null : cleanTail(txt), busy: false });
        draw();
      });
    }
    return hit?.lines ? hit.lines.slice(-n) : null;
  }
  /** Drop the agent's input box and status footer (below the last ruler lines) and blank runs. */
  function cleanTail(txt) {
    let lines = txt.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
    const ruler = (l) => /^\s*[─━═-]{20,}\s*$/.test(l);
    const firstRuler = lines.findIndex((l, i) => ruler(l) && i >= lines.length - 12);
    if (firstRuler > 0) lines = lines.slice(0, firstRuler);
    const outl = [];
    for (const l of lines) if (l.trim() || (outl.length && outl[outl.length - 1].trim())) outl.push(l);
    while (outl.length && !outl[outl.length - 1].trim()) outl.pop();
    return outl;
  }

  /** Lay out a row: left segments clipped with … to leave room for the right segments. */
  function row(left, right, W) {
    const len = (segs) => segs.reduce((n, [x]) => n + strWidth(x), 0); // columns, not characters
    const room = Math.max(10, W - 1 - len(right));
    const outSegs = [];
    let used = 0;
    for (const [x, s] of left) {
      const w = strWidth(x);
      if (used + w <= room) {
        outSegs.push([x, s]);
        used += w;
      } else {
        let cut = '';
        let cw = 0;
        for (const ch of String(x)) {
          if (used + cw + charWidth(ch) > room - 1) break;
          cut += ch;
          cw += charWidth(ch);
        }
        if (room - used > 1) outSegs.push([cut + '…', s]);
        used = room;
        break;
      }
    }
    return [...outSegs, [' '.repeat(Math.max(1, room - used)), ''], ...right];
  }

  /** One-line essence of an attention item (shown under it, and as the panel's lead). */
  function needMessage(it) {
    const t = it.task ? it.st.tasks[it.task] : null;
    if (it.kind === 'coordinator' || it.kind === 'prompt') {
      const tail = paneTail(it.pane, 6);
      const last = tail && [...tail].reverse().find((l) => l.trim());
      return last ? last.trim() : it.kind === 'prompt' ? 'waits at a prompt in its terminal' : 'finished its turn and waits for your input';
    }
    if (it.kind === 'finished') return it.st.status_message || 'all tasks are finished: close the plan (c)';
    if (it.kind === 'plan-question') return it.message;
    if (it.kind === 'no-coordinator') return `nothing gets decided or started: s resumes the coordinator${it.st.session ? ' (its last session)' : ''}, S starts a fresh one`;
    if (it.kind === 'stale') return it.message;
    return t?.last_message || it.message || '';
  }

  function needLine(it, W, sel, headed = false) {
    const [label, color] = NEED[it.kind] || [it.kind, ''];
    const t = it.task ? it.st.tasks[it.task] : null;
    const subject =
      it.kind === 'coordinator'
        ? `${it.actor} waits for your input`
        : it.kind === 'prompt'
          ? `${it.actor} waits at a prompt${t ? ` (${t.id} ${t.title})` : ''}`
          : it.kind === 'finished'
            ? 'all tasks finished'
            : it.kind === 'no-coordinator'
              ? 'no coordinator is running'
            : it.kind === 'plan-question'
              ? `${it.actor ?? 'the coordinator'} asks about the plan`
              : `${t.id} ${t.title}`;
    const who = it.kind === 'review' ? 'for the coordinator' : it.kind === 'your-review' || (it.kind === 'question' && it.for === HUMAN) ? 'for you' : it.actor && !['coordinator', 'prompt'].includes(it.kind) ? it.actor : '';
    return row(
      [mark(sel), [label.padEnd(11), sel ? `inverse ${color}` : color], [' ' + subject, sel ? 'bold' : 'bold']],
      [[multi() && !headed ? planLabel(it, W) + '  ' : '', 'dim'], [who ? who + '  ' : '', 'cyan'], [ago(it.ts).padStart(3), 'dim']],
      W,
    );
  }
  const needSub = (it, W) => {
    const msg = needMessage(it);
    return msg ? [[' '.repeat(15), ''], [clip(msg.replace(/\s+/g, ' '), Math.max(10, W - 17)).trimEnd(), it.kind === 'question' ? 'yellow' : 'dim']] : null;
  };

  function coordState(a) {
    const c = a.coord;
    if (!c.id) return ['no coordinator', 'dim'];
    if (c.away) return ['↗ coordinator elsewhere', 'gray'];
    if (!c.live) return [inHerdr() ? 'coordinator not running' : '', 'dim'];
    const s = c.live.agent_status;
    return s === 'working' ? ['⚙ coordinator', 'blue'] : s === 'blocked' ? ['! coordinator at a prompt', 'red'] : ['◌ coordinator idle', 'yellow'];
  }

  function planLine(p, a, W, sel) {
    const sum = planSummary(p.st);
    const q = a.queued.reduce((m, it) => m.set(it.kind, (m.get(it.kind) || 0) + 1), new Map());
    const qn = a.queued.length;
    // the human's input the coordinator has not acted on yet
    const inputs = p.st.order.filter((id) => p.st.tasks[id].human_input?.length).length + (p.st.human_input?.length ? 1 : 0);
    const qtext = W >= 100 ? [...q].map(([k, n]) => `${n} ${{ review: 'review', question: 'question', failed: 'failed', stale: 'stalled', 'your-review': 'review' }[k] ?? k}${n > 1 && k !== 'failed' ? 's' : ''}`).join(', ') : qn ? String(qn) : '';
    const finished = p.st.order.every((id) => p.st.tasks[id].children.length || TERMINAL.has(p.st.tasks[id].status));
    const [cs, cc] = finished ? ['', ''] : coordState(a);
    // the agents with open work (not the coordinator): working / idle / not running
    const ag = { working: 0, blocked: 0, idle: 0, off: 0 };
    for (const who of sum.agents) {
      if (who === a.coord.id) continue;
      const la = liveAgent(p.st, who);
      ag[!la ? 'off' : la.agent_status === 'working' ? 'working' : la.agent_status === 'blocked' ? 'blocked' : 'idle']++;
    }
    const nAg = ag.working + ag.blocked + ag.idle + ag.off;
    const agents = nAg
      ? [
          [W >= 110 ? `  ${nAg} agent${nAg === 1 ? '' : 's'}` : ' ', 'dim'],
          [ag.working ? ` ⚙${ag.working}` : '', 'blue'],
          [ag.blocked ? ` !${ag.blocked}` : '', 'red'],
          [ag.idle ? ` ◌${ag.idle}` : '', 'yellow'],
          [ag.off && inHerdr() ? ` ·${ag.off}` : '', 'gray'],
        ]
      : [];
    return row(
      [mark(sel), [planLabel(p, W) + '  ', sel ? 'inverse bold' : 'bold'], ...bar(sum.progress, 8), [` ${p.st.counts.done ?? 0}/${sum.total}`, 'dim'], ...agents, [p.st.status === 'paused' ? '  paused' : '', 'yellow']],
      [[cs, cc], [qtext ? `  · ${qtext} queued` : '', 'dim'], [inputs ? `  ✎${inputs}` : '', 'magenta'], [`  ${ago(p.st.updated_at).padStart(3)}`, 'dim']],
      W,
    );
  }

  function workLine(p, t, W, sel) {
    const st = p.st;
    const a = agentFor(st, t);
    const rework = t.status === 'todo' && t.changes_requested;
    const [g, gc] = rework ? ['↺', 'magenta'] : t.answered ? ['⊘', 'green'] : STATUS[t.status];
    const crumb = t.path.length ? st.tasks[t.path[t.path.length - 1]].title + ' › ' : '';
    const msg = rework ? `changes requested (round ${t.feedback.length}): ${t.feedback[t.feedback.length - 1]?.message ?? ''}` : t.answered ? 'question answered, resuming' : t.last_message || '';
    const live = liveOf(st, t);
    const badge = live && liveBadge(live);
    const right = [];
    if (t.owner) right.push([t.owner, 'cyan']);
    if (a) right.push([' ' + (AGENT_GLYPH[a.agent_status] || AGENT_GLYPH.unknown)[0], (AGENT_GLYPH[a.agent_status] || AGENT_GLYPH.unknown)[1]]);
    else if (t.owner && elsewhere(st, t.owner)) right.push([' ↗', 'gray']);
    else if (inHerdr() && t.owner) right.push([' ·', 'gray']);
    if (a?.stale) right.push([' stalled?', 'red bold']);
    right.push([`  ${ago(t.updated_at).padStart(3)}`, 'dim']);
    return row(
      [mark(sel), ['  ' + g + ' ', gc], [t.id + ' ', sel ? 'inverse bold' : 'bold'], [crumb, 'gray'], [t.title, ''], [t.percent != null && t.status === 'in_progress' ? `  ${t.percent}%` : '', 'yellow'], badge ? [`  ${badge.glyph} ${badge.text}`, badge.color] : ['', ''], [msg ? '  ' + msg.replace(/\s+/g, ' ') : '', 'dim']],
      right,
      W,
    );
  }

  /** Why a plan has nothing in flight, in a few words. */
  function idleReason(p, a) {
    const st = p.st;
    const leaves = st.order.map((id) => st.tasks[id]).filter((t) => !t.children.length);
    if (!leaves.length) return 'no tasks yet';
    if (leaves.every((t) => TERMINAL.has(t.status))) return 'all tasks finished';
    if (st.status === 'paused') return 'paused';
    const n = (f) => leaves.filter(f).length;
    const bits = [];
    if (n((t) => t.status === 'review')) bits.push(`${n((t) => t.status === 'review')} in review`);
    if (n((t) => t.status === 'blocked' && !t.blocked_on.length && !t.answered)) bits.push(`${n((t) => t.status === 'blocked' && !t.blocked_on.length && !t.answered)} blocked on a question`);
    if (n((t) => t.ready && !t.owner)) bits.push(`${n((t) => t.ready && !t.owner)} ready, not started`);
    if (n((t) => t.status === 'todo' && t.waiting_on.length)) bits.push(`${n((t) => t.status === 'todo' && t.waiting_on.length)} waiting on dependencies`);
    return 'nothing in progress' + (bits.length ? ': ' + bits.join(', ') : '');
  }

  /**
   * Overview rows: Needs you, then In flight. Returns {lines, selLine}; fills
   * ui.rows.overview (types: need, plan, task).
   */
  function overviewTabLines(W, plans) {
    const L = [];
    const rows = [];
    const add = (r, render) => rows.push({ ...r, line: L.push(null) - 1, render });
    if (ui.scope.level === 'all' && initDir && !findRoot(initDir))
      L.push([[' No ATF project in ', 'yellow'], [initDir, 'cyan'], ['  — press ', 'yellow'], ['i', 'bold green'], [' to create one there', 'yellow']], []);
    const open = plans.filter((p) => isOpenStatus(p.st));
    const att = open.map((p) => ({ p, ...attentionOf(p) }));
    const needs = att.flatMap((a) => a.mine).sort((x, y) => NEED_RANK[x.kind] - NEED_RANK[y.kind] || (x.ts || '').localeCompare(y.ts || ''));
    L.push(needs.length ? [[' NEEDS YOU ', 'bold red'], [String(needs.length), 'bold red']] : [[' NEEDS YOU ', 'bold'], ['nothing: every plan is moving on its own', 'dim']]);
    // grouped by plan, the plan with the most urgent item first (order kept within a plan);
    // a heading per plan unless the scope is one plan
    const groups = new Map();
    for (const it of needs) groups.set(it.key, [...(groups.get(it.key) || []), it]);
    const headed = multi() || groups.size > 1;
    for (const items of groups.values()) {
      if (headed) L.push([[' ' + planLabel({ ...items[0], st: items[0].st }, Infinity), 'bold magenta']]);
      for (const it of items) {
        add({ type: 'need', ...it, k: `need#${it.key}#${it.kind}#${it.task ?? it.actor ?? ''}` }, (sel) => needLine(it, W, sel, headed));
        const sub = needSub(it, W);
        if (sub) L.push(sub);
      }
    }
    L.push([], [[' IN FLIGHT', 'bold']]);
    if (!open.length) L.push([[ui.showClosed ? '   No plans in scope.' : '   No active plans. A coordinator starts one with `atf plan new <title>`.', 'dim']]);
    for (const a of att) {
      const p = a.p;
      add({ type: 'plan', root: p.root, plan: p.id, id: p.id, st: p.st, key: p.key, k: p.key }, (sel) => planLine(p, a, W, sel));
      const work = currentWork(p.st);
      for (const t of work.slice(0, 3)) add({ type: 'task', root: p.root, plan: p.id, st: p.st, key: p.key, task: t.id, k: `${p.key}#${t.id}` }, (sel) => workLine(p, t, W, sel));
      if (work.length > 3) L.push([['       ', ''], [`+ ${work.length - 3} more in progress  (⏎ on the plan opens it)`, 'dim']]);
      if (!work.length) L.push([['       ', ''], [idleReason(p, a), 'dim']]);
    }
    const prevK = ui.rows.overview[ui.sel.overview]?.k;
    const keep = prevK ? rows.findIndex((r) => r.k === prevK) : -1;
    ui.sel.overview = keep >= 0 ? keep : Math.min(ui.sel.overview, Math.max(0, rows.length - 1));
    ui.rows.overview = rows;
    rows.forEach((r, i) => (L[r.line] = r.render(i === ui.sel.overview)));
    return { lines: L, selLine: rows[ui.sel.overview]?.line ?? 0 };
  }

  /** Artifacts to review for a row: the task's (and its subtasks'), newest first, best kind first. */
  const ART_RANK = { pr: 0, branch: 1, commit: 2, url: 3, file: 4, other: 5 };
  function reviewArtifacts(r) {
    const st = r.st;
    const ids = r.task ? st.order.filter((id) => id === r.task || st.tasks[id].path.includes(r.task)) : st.order;
    const arts = ids.flatMap((id) => st.tasks[id].artifacts.map((x, i) => ({ ...x, task: id, i }))).filter((x) => !x.live && !x.cmd);
    return arts.sort((a, b) => (ART_RANK[a.kind] ?? 9) - (ART_RANK[b.kind] ?? 9) || (b.ts || '').localeCompare(a.ts || '') || b.i - a.i);
  }

  /** The context panel: what is needed to act on the selected Overview row. */
  function contextLines(r, W) {
    if (!r) return [];
    const L = [];
    const st = r.st;
    const para = (text, style = '', max = 6, ind = ' ') => {
      const ls = wrap(String(text), W - ind.length - 1);
      ls.slice(0, max).forEach((l, i) => L.push([[ind + (i === max - 1 && ls.length > max ? l.replace(/\s*\S*$/, ' …') : l), style]]));
      if (ls.length > max) L.push([[`${ind}(${ls.length - max + 1} more lines: ⏎ details)`, 'dim']]);
    };
    const label = (txt, extra = '') => L.push([[` ${txt}`, 'bold'], [extra ? '  ' + extra : '', 'dim']]);
    if (r.type === 'need' && (r.kind === 'coordinator' || r.kind === 'prompt')) {
      L.push([[` ${r.actor}`, 'bold cyan'], [r.kind === 'prompt' ? '  at a prompt in its terminal' : '  waits for your input', r.kind === 'prompt' ? 'red' : 'yellow'], [`  ·  ${planLabel(r)}`, 'dim']]);
      const tail = paneTail(r.pane, 14);
      if (tail) for (const l of tail) L.push([[' │ ', 'gray'], [clip(l, W - 4).trimEnd(), '']]);
      else L.push([[' (reading its terminal…)', 'dim']]);
      if (r.task) L.push([[' working on ', 'dim'], [`${r.task} ${st.tasks[r.task].title}`, '']]);
      // what waits on the coordinator meanwhile
      const queue = r.kind === 'coordinator' ? inboxOf({ root: r.root, id: r.plan, st }).filter((it) => it.task) : [];
      if (queue.length) {
        L.push([], [[' its queue', 'bold'], ['  (it handles these once it continues)', 'dim']]);
        for (const it of queue) {
          const [lab, col] = NEED[it.kind] || [it.kind, ''];
          L.push([['   ' + lab.padEnd(11), col], [`${it.task} ${st.tasks[it.task].title}`, 'bold'], [it.message ? '  ' + it.message.replace(/\s+/g, ' ') : '', 'dim']]);
        }
      }
      return L;
    }
    if (r.type === 'plan' || (r.type === 'need' && !r.task)) {
      L.push([[` ${st.title}`, 'bold'], [`  ${st.status}  ·  ${projectName(r.root)}  ·  ${progressText(st)}`, 'dim']]);
      if (st.goal) para(st.goal, '', 3);
      if (st.questions?.length) {
        L.push([]);
        label('question for you');
        for (const q of st.questions) para(q.message, 'yellow', 6, '   ');
      }
      if (st.docs?.length) L.push([[' documents  ', 'dim'], [st.docs.join('  '), 'cyan'], ['  (o opens the first)', 'dim']]);
      if (st.checkpoint) {
        L.push([]);
        label('plan checkpoint', `${st.checkpoint.actor ?? ''} ${ago(st.checkpoint.ts)} ago`);
        para(st.checkpoint.message, '', 4, '   ');
      }
      if (r.kind === 'finished' && st.status_message) para(st.status_message, 'green', 3);
      const roots = st.order.filter((id) => !st.tasks[id].parent || !st.tasks[st.tasks[id].parent]);
      if (roots.length) {
        L.push([]);
        for (const id of roots.slice(0, 8)) {
          const t = st.tasks[id];
          const es = effStatus(t);
          const owners = [...new Set(st.order.filter((x) => (x === id || st.tasks[x].path.includes(id)) && st.tasks[x].owner).map((x) => st.tasks[x].owner))];
          L.push([[`  ${STATUS[es][0]} `, STATUS[es][1]], [`${id} `, 'bold'], [t.title, TERMINAL.has(es) && es !== 'failed' ? 'dim' : ''], [owners.length ? '  ' + owners.join(', ') : '', 'cyan']]);
        }
        if (roots.length > 8) L.push([[`    … ${roots.length - 8} more`, 'dim']]);
      }
      return L;
    }
    const t = st.tasks[r.task];
    if (!t) return L;
    const s = effStatus(t);
    if (t.path.length) L.push([[' ' + t.path.map((x) => `${x} ${st.tasks[x].title}`).join(' › ') + ' ›', 'dim']]);
    L.push([[` ${t.id} `, 'bold'], [`${STATUS[s][0]} ${s.replace('_', ' ')}`, STATUS[s][1]], [`  ${t.title}`, 'bold'], [`  ·  ${planLabel(r)}`, 'dim']]);
    const meta = [];
    if (t.owner) meta.push(`@${t.owner}`);
    const a = agentFor(st, t);
    if (a) meta.push(`agent ${a.agent_status}${a.stale ? ' (stalled?)' : ''}`);
    if (t.status === 'in_progress' && t.percent != null) meta.push(`${t.percent}%`);
    if (t.reviewer || t.review) meta.push(`review by ${t.reviewer ?? 'coordinator'}`);
    if (t.feedback?.length) meta.push(`review round ${t.feedback.length + (t.status === 'review' ? 1 : 0)}`);
    meta.push(`updated ${ago(t.updated_at)} ago`);
    L.push([[' ' + meta.join('  ·  '), 'dim']]);
    // the lead: what this row asks of you, or where the work stands
    if (t.status === 'blocked' && !t.blocked_on.length) {
      L.push([]);
      const blocks = t.history.filter((h) => h.type === 'status' && h.to === 'blocked' && h.message);
      const last = blocks[blocks.length - 1];
      label(t.answered ? 'question (answered)' : t.blocked_for === HUMAN ? 'question for you' : 'question', last ? `${last.actor ?? ''} ${ago(last.ts)} ago` : '');
      para(t.last_message || '(no message)', t.answered ? '' : 'yellow', 8, '   ');
      // escalated by the coordinator: the subagent's own question, for context
      const orig = [...blocks].reverse().find((h) => h.actor && h.actor === t.owner);
      if (t.blocked_for === HUMAN && orig && orig !== last) {
        L.push([[`   originally asked by ${orig.actor}:`, 'dim']]);
        para(orig.message, 'dim', 4, '   ');
      }
    } else if (t.status === 'review' || t.status === 'failed') {
      L.push([]);
      label(t.status === 'review' ? 'submitted for review' : 'failed');
      para(t.last_message || '(no message)', t.status === 'failed' ? 'red' : '', 6, '   ');
    } else if (t.changes_requested) {
      const fb = t.feedback[t.feedback.length - 1];
      L.push([]);
      label('changes requested', `round ${fb.round} · ${fb.actor ?? ''} ${ago(fb.ts)} ago`);
      para(fb.message, 'magenta', 6, '   ');
    }
    // the trail: latest progress, then the checkpoint
    const trail = t.history.filter((h) => h.message && (h.type === 'progress' || h.type === 'status')).slice(-4);
    if (trail.length && !(t.status === 'blocked' || t.status === 'review' || t.status === 'failed') ) {
      L.push([]);
      label('latest');
      for (const h of trail)
        wrap(h.message.replace(/\s+/g, ' '), W - 9)
          .slice(0, 3)
          .forEach((l, i) => L.push([[i ? '        ' : `   ${ago(h.ts).padStart(3)} `, 'dim'], [l, h === trail[trail.length - 1] ? '' : 'dim']]));
    }
    L.push(...liveDetail(st, t, W, { recorded: 2, tail: 2 }));
    if (t.checkpoint && !TERMINAL.has(t.status)) {
      L.push([]);
      label('checkpoint', `${ago(t.checkpoint.ts)} ago`);
      para(t.checkpoint.message, '', 4, '   ');
    }
    if (t.status === 'review' && t.acceptance.length) {
      L.push([]);
      label('acceptance');
      for (const ac of t.acceptance) wrap(ac, W - 6).forEach((l, i) => L.push([[i ? '     ' : '   □ ', 'dim'], [l, '']]));
    }
    const arts = reviewArtifacts(r);
    if (arts.length) {
      L.push([]);
      label('artifacts', 'o opens the first');
      arts.slice(0, 5).forEach((x, i) => L.push([[`   ${i ? ' ' : '›'} ${x.kind.padEnd(7)}`, i ? 'dim' : 'cyan'], [x.ref, i ? '' : 'cyan'], [x.description ? '  ' + x.description : '', 'dim'], [x.task !== t.id ? `  (${x.task})` : '', 'dim']]));
    }
    const others = t.notes.filter((n) => n.actor && n.actor !== t.owner && n.kind !== 'checkpoint').slice(-2);
    if (others.length) {
      L.push([]);
      label('notes from others');
      for (const n of others) {
        L.push([[`   ${n.actor ?? ''}`, 'cyan'], [`  ${n.kind !== 'info' ? n.kind + ' · ' : ''}${ago(n.ts)} ago`, 'dim']]);
        para(n.message, n.kind === 'question' || n.kind === 'warning' ? 'yellow' : '', 10, '     ');
      }
    }
    if (t.description) {
      L.push([]);
      label('task');
      para(t.description, 'dim', 4, '   ');
    }
    return L;
  }

  /** Keys that apply to the selected Overview row (shown in the footer). */
  function overviewKeys(r) {
    if (!r) return '↑↓ select  ? help';
    const k = [];
    const t = r.task ? r.st.tasks[r.task] : null;
    if (r.type === 'need' && (r.kind === 'coordinator' || r.kind === 'prompt')) {
      k.push('g go to its terminal');
      if (r.kind === 'coordinator') k.push('r reply');
    } else if (r.type === 'plan' || !t) {
      if (r.kind === 'no-coordinator') k.push('s resume coordinator', 'S fresh coordinator', '⏎ open plan');
      else {
        k.push('⏎ open plan', 'g coordinator', r.kind === 'plan-question' ? 'r answer' : 'r note');
        if (r.st.docs?.length) k.push('o docs');
        k.push('s/S coordinator');
      }
      if (r.kind === 'finished' || r.type === 'plan') k.push('c close plan');
    } else {
      if (t.status === 'review') k.push('a approve', 'x changes');
      k.push(t.status === 'blocked' && !t.blocked_on.length ? 'r answer' : 'r message');
      if (reviewArtifacts(r).length) k.push('o open');
      if (t.owner) k.push('g agent');
      k.push('⏎ details');
    }
    if (r.type !== 'plan' && r.kind !== 'plan-question') k.push('N plan note');
    return k.join('  ') + '  ? help  esc ' + (ui.scope.level === 'all' ? 'quit' : 'back');
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
      transact(r.root, r.plan, humanActor(), () => [{ type: 'plan.status', data: { status: 'completed', message: 'closed via board' } }]);
      flash(`closed "${r.st.title}"${ui.showClosed ? '' : ' (f shows closed plans)'}`, 'green');
    } catch (e) {
      flash(e.message, 'red');
    }
  }

  function helpLines() {
    const H = (t) => [[' ' + t, 'bold']];
    const T = (t, st = '') => [['   ' + t, st]];
    const K = (k, d) => [['   ' + k.padEnd(16), 'bold'], [d, '']];
    const sym = (g, color, name, desc) => [['   ' + g + ' ', color], [name.padEnd(13), color], [desc, '']];
    const lab = (l, color, desc) => [['   ' + l.padEnd(15), color], [desc, '']];
    return [
      H('Scope: all projects › project › plan (shown in the header)'),
      T('Every tab shows its content for the current scope.'),
      K('⏎', 'on a plan: narrow the scope to it'),
      K('esc', 'widen: plan → project → all projects → quit (closes details/help first)'),
      K('A', 'jump to all projects'),
      K('p', 'plan picker: a popup of all plans by project (goal, state); type to filter,'),
      T('                ↑↓ or ctrl+j/ctrl+k select, ⏎ goes to the plan;'),
      T('                in the Log it filters the log to the picked plan (or all plans)'),
      K('Tab / 0-4', 'switch view: 0 Overview · 1 Tasks · 2 Plan · 3 Log · 4 Changes'),
      K('ctrl+d / ctrl+u', 'half a page down / up; ctrl+f / ctrl+b (PgDn / PgUp) a page'),
      K('G / gg', 'to the end / the top (also End / Home), in lists and in long views'),
      K('/', 'search the view (Tasks, Changes, plan, task details, help): matches light up,'),
      T('                lists select the row, long views scroll to it; smartcase. While a search is'),
      T('                on: n / N next / previous match, esc ends it (then n, N reply / note again)'),
      K('f', 'show / hide closed plans (all views)'),
      K('?  q  ctrl+c', 'this help · close details or quit · quit'),
      [],
      H('0 Overview: what needs you, and what is being worked on'),
      T('NEEDS YOU, most urgent first (under a heading per plan when the scope has several):'),
      lab('! prompt', 'red bold', 'an agent waits at a dialog in its terminal (g opens it)'),
      lab('⚠ no coord', 'red bold', 'no coordinator runs for an active plan (s resumes it, S fresh)'),
      lab('⊘ question', 'red bold', 'the coordinator asks you, on that task (r answers)'),
      lab('? plan', 'red bold', 'the coordinator asks you about the whole plan (r answers)'),
      lab('◎ review', 'magenta bold', 'a task asks you to review it (a approve, x change request)'),
      lab('? input', 'yellow bold', 'a coordinator waits in its prompt (not shown for one its harness wakes: pi, Copilot)'),
      lab('● finished', 'green', 'all tasks of a plan are finished (c closes the plan)'),
      T('Questions, failed or stalled tasks and the coordinator’s reviews are listed here only'),
      T('when no coordinator is running for the plan; otherwise the plan row says "N queued".'),
      T('IN FLIGHT: one row per plan (progress, coordinator state), then the tasks being worked'),
      T('on (in progress, being reworked after review, answered) with their latest progress.'),
      T('Below the list: the context of the selected row, enough to act on it.'),
      K('a  x  r  o  s  S', 'act on the selected row (see "Acting" and "The coordinator")'),
      K('o', 'open the task’s artifact: PR / URL in the browser; branch diff, commit or file'),
      T('                in a new herdr tab "review T<n>" in the project'),
      K('g', 'go to the terminal: the task’s agent, the waiting agent, the plan’s coordinator'),
      K('⏎', 'task: its full details; plan: the plan (esc comes back here)'),
      K('c', 'close the selected plan (press twice; warns about open tasks)'),
      K('i', 'no ATF project in this directory: create one'),
      [],
      H('1 Tasks: the task tree (at wider scopes: one collapsible node per plan)'),
      K('↑↓ j/k PgUp/Dn', 'move'),
      K('←→ h/l space', 'collapse / expand a parent or plan (← on a task: go to its parent)'),
      K('v', 'group by agent: per agent its live state (pane), tasks done / total and last'),
      T('                write, then its work packages ▣ and tasks; then the unassigned tasks.'),
      T('                v again: the task tree'),
      K('⏎', 'task details (breadcrumb, feedback, checkpoint, notes, activity)'),
      K('g', 'go to the owning agent’s herdr pane (on an agent heading: that agent)'),
      T('Agents are started by the coordinator, not from the board (see "The coordinator").'),
      [],
      H('2 Plan · 3 Log'),
      T('Plan: at plan scope the full plan (goal, outcome, branches, decisions, questions,'),
      T('artifacts); at wider scopes one card per plan: ←→/space fold a card, z all, ⏎ open,'),
      T('g jump, c close. Log: events of all plans in scope, newest first; / searches'),
      T('(every word must match; matches highlighted), p picks a plan to filter by, esc clears.'),
      [],
      H('4 Changes: the files the plan’s tasks changed'),
      T('Per plan the tasks that changed files (work packages hold their subtasks), each with'),
      T('its files and line counts. Where they come from: .atf/config.toml changes ='),
      T('"snapshots" (default: the working tree when a task starts and when it is finished;'),
      T('tasks running at the same time in one repo ⚠ overlap, narrowed to the files they'),
      T('reported) or "artifacts" (only the file, commit and branch artifacts agents record).'),
      K('⏎ / d', 'the combined diff of the row in your diff viewer, in a herdr tab: a file, a'),
      T('                task, a work package (its subtree) or the plan'),
      K('D', 'the diff of the whole plan'),
      K('←→ h/l space z', 'fold a task or plan / all tasks (← on a file: to its task)'),
      T('The viewer: [diff] tool = "git" | "diffview" | "difftool" | "<command with {repo}', 'dim'),
      T('{base} {target} {range} {files}>" in ~/.config/atf/config.toml, or $ATF_DIFF_TOOL.', 'dim'),
      [],
      H('Acting (Overview, Tasks, details): takes effect at once'),
      T('The coordinator makes the decisions: what you write goes to it, and it decides what'),
      T('happens (starts an agent with its instructions, a follow-up task, a plan change, …).'),
      K('a', 'approve a task in review (done at once; the coordinator sees it)'),
      K('x', 'change request on a task, for the coordinator'),
      K('r / n', 'answer a question, or a message on the task (on a plan: a plan note), for'),
      T('                the coordinator; to a coordinator waiting for input: into its prompt'),
      K('N', 'a note on a plan, for its coordinator, from every view: the plan in scope or of'),
      T('                the selected row (in Log: the plan filter); else you pick the plan'),
      [],
      H('The text field (r, n, x, log search)'),
      K('⏎ / esc', 'send / cancel'),
      K('alt+⏎ ctrl+j', 'new line (shift+⏎ where the terminal sends it); pasted text keeps its lines'),
      K('← → ↑ ↓', 'move (↑↓ follow wrapped lines); PgUp/PgDn by a screen'),
      K('alt+← →', 'a word back / forward (also ctrl+← →, alt+b / alt+f)'),
      K('Home End', 'start / end of the line (also ctrl+a / ctrl+e); alt+< alt+> whole text'),
      K('⌫ Del', 'delete before / at the cursor; ctrl+w or alt+⌫ the word before, alt+d the next'),
      K('ctrl+u ctrl+k', 'cut to the line’s start / end; ctrl+y pastes it back'),
      K('ctrl+z', 'undo; alt+z redo'),
      T(viMode() ? 'vi mode is on: insert mode first (⏎ new line); esc → normal mode: ⏎ sends, vi keys, esc cancels.' : 'vi keys: "vi_mode": true in the plugin config, or ATF_VI_MODE=1.', 'dim'),
      K('o', 'open the task’s artifact (PR/URL, branch diff, commit, file) or the plan’s documents'),
      K('d', 'the combined diff of the task (a parent: its subtree) or the plan (see 4 Changes)'),
      [],
      H('The coordinator (one per plan, always running)'),
      K('s', 'start the coordinator of the selected plan, resuming its last session (if one'),
      T('                runs already: go to it)'),
      K('S', 'start a fresh coordinator session (press twice): a running coordinator first'),
      T('                writes its plan checkpoint, then is replaced'),
      T('A plan without a running coordinator shows "⚠ no coord" under NEEDS YOU.', 'dim'),
      [],
      H('Task status: the symbol before a task'),
      sym(STATUS.todo[0], STATUS.todo[1], 'todo', 'not started'),
      sym(STATUS.in_progress[0], STATUS.in_progress[1], 'in progress', 'an agent is working on it'),
      sym(STATUS.review[0], STATUS.review[1], 'review', 'finished by its agent, waiting for approval or change requests'),
      sym(STATUS.done[0], STATUS.done[1], 'done', 'finished (approved if it went through review)'),
      sym(STATUS.blocked[0], STATUS.blocked[1], 'blocked', 'cannot continue: a question, or blocked on another task'),
      sym(STATUS.failed[0], STATUS.failed[1], 'failed', 'its agent gave up; the coordinator can reopen it'),
      sym(STATUS.cancelled[0], STATUS.cancelled[1], 'cancelled', 'dropped'),
      T('Parent tasks show the combined status of their subtasks.', 'dim'),
      [],
      H('Labels after a task'),
      lab('▣ backend', 'cyan bold', 'work package: this parent and its whole subtree belong to backend'),
      lab('↳backend', 'cyan dim', 'owner inherited from the work package'),
      lab('backend', 'cyan', 'assigned directly'),
      lab('ready', 'green', 'can start now and nobody owns it yet (the coordinator dispatches it)'),
      lab('⧗ T3', 'dim', 'waits on unfinished dependencies'),
      lab('⧗ on T8', 'dim', 'blocked on another task; "can resume" once that is done'),
      lab('answered', 'green', 'its question was answered; the agent can continue'),
      lab('↺ changes', 'magenta', 'sent back from review with requested changes (feedback in details)'),
      lab('✎ with coordinator', 'magenta', 'you wrote on it; the coordinator has not acted on it yet'),
      lab('for you', 'red bold', 'a question the coordinator escalated to you'),
      lab('40%', 'yellow', 'progress last reported by the agent'),
      lab('2/3', 'dim', 'finished / total subtasks of a parent'),
      lab('⚙ 2/5 core', 'cyan', 'the agent runs a build or tests now (live, see "Live" below)'),
      lab('⧖ pipeline #5', 'yellow', 'the agent waits on something: a pipeline, a polling loop'),
      lab('✗ BUILD FAILURE', 'red', 'its latest build, test run or pipeline failed'),
      T('Details also show its agent definition, reviewer, follow-up links and checkpoint.', 'dim'),
      [],
      H('Live: what agents run and wait for'),
      T('The agent’s harness observes its shell commands (pi: atf-live, loaded by atf-herdr);'),
      T('nothing changes for the agent. A task’s details list under "live":'),
      T('  ⚙ running / ⧖ waiting   the command now, its summary and last output lines'),
      T('  maven · tests · pipeline · log   finished runs (exit code, summary, failing tests)'),
      T('                and files the agent writes in the background or keeps reading'),
      T('Maven summaries add surefire/failsafe reports; pipelines link their URL.'),
      K('L', 'the live view, in the board, updated while it runs: the kind’s full view'),
      T('                (Maven: every module, failure and test class) or the raw output'),
      K('  ↑↓ G', 'move; G goes to the end and follows new output'),
      K('  ←→ z', 'fold a section (modules, failures, test classes) · z all'),
      K('  ⏎', 'on a failed test: its message and stack trace (the project’s frames stand out)'),
      K('  t', 'raw output ⇄ the view   [ ] other runs of the task   / search'),
      K('  o', 'open it outside the board: a pipeline in the browser, the viewer (atf live)'),
      T('                or the output in a herdr tab'),
      T('Agents add what the hook cannot see: atf artifact T3 <file> --live [--kind maven]', 'dim'),
      [],
      H('Agent state: the symbol after an agent name (live from herdr)'),
      sym(AGENT_GLYPH.working[0], AGENT_GLYPH.working[1], 'working', 'the agent is running'),
      sym(AGENT_GLYPH.idle[0], AGENT_GLYPH.idle[1], 'idle', 'the agent waits for input'),
      sym(AGENT_GLYPH.done[0], AGENT_GLYPH.done[1], 'done', 'the agent finished its turn'),
      sym(AGENT_GLYPH.blocked[0], AGENT_GLYPH.blocked[1], 'prompt', 'stuck at an approval/question prompt in its terminal'),
      sym('↗', 'gray', 'elsewhere', 'runs in another herdr session (read-only here)'),
      lab('stale?', 'red bold', 'task in progress but its agent idle > 90 s: probably stopped without reporting'),
      T('Agents end when their assignment is finished; ATF closes their panes. When there is', 'dim'),
      T('more for a task, the coordinator starts a new agent (fresh, with its instructions).', 'dim'),
      [],
      H('Overview rows'),
      lab('◌ coordinator idle', 'yellow', 'coordinator state: ⚙ working  ! at a prompt  ↗ in another herdr session'),
      lab('⚙1 !1 ◌1 ·1', 'dim', 'agents with open tasks: working, at a prompt, idle, not running'),
      lab('1 question queued', 'dim', 'items waiting for the running coordinator'),
      lab('↺ T4', 'magenta', 'being reworked after changes were requested'),
      lab('✎2', 'magenta', 'plan row: tasks with your input the coordinator has not acted on yet'),
      [],
      H('Without herdr (atf-herdr tui in any terminal)'),
      T('Reading, approving, change requests, answers and messages work the same. Not available:'),
      T('agent state and stale? flags, g, s / S; o opens PRs and URLs, for a branch, commit or'),
      T('file it shows the command to run. "All projects" are those in ~/.config/atf/roots.json.'),
    ];
  }

  function footer() {
    if (ui.picker) return [[]]; // its keys are in the box
    if (ui.input) {
      const W = out.columns || 80;
      const f = inputField();
      // vi mode: the mode, and what esc does in it
      const mode = fieldMode(f);
      const viMode = mode ? [[` -- ${mode} --`, mode.startsWith('INSERT') ? 'bold green' : mode.startsWith('VISUAL') ? 'bold magenta' : 'bold cyan']] : [];
      const esc = !mode ? 'esc cancel' : mode.startsWith('NORMAL') ? 'esc cancel · i insert' : 'esc normal';
      if (!ui.input.multiline) {
        const hint = `   ${ui.input.hint ?? '⏎ send'} · ${esc}`;
        const room = Math.max(10, W - strWidth(ui.input.label) - strWidth(hint) - strWidth(viMode[0]?.[0] ?? '') - 1);
        return [[[' ' + ui.input.label, 'bold yellow'], ...fieldRows(f, room, 1, charWidth).rows[0], ...viMode, [hint, 'dim']]];
      }
      // a text field: the label, then the text wrapped, growing up to 10 rows, scrolled to the cursor
      const max = Math.max(1, Math.min(10, (out.rows || 24) - 12));
      const { rows, above, below } = fieldRows(f, Math.max(10, W - 3), max, charWidth);
      const send = ui.input.hint ?? '⏎ send';
      const keys = !mode
        ? `${send} · alt+⏎ new line · ctrl+z undo · esc cancel`
        : mode.startsWith('INSERT')
          ? `⏎ new line · ${esc} (⏎ there sends)`
          : mode.startsWith('VISUAL')
            ? `${send} · d c y on the selection · ${esc}`
            : `${send} · u undo · ${esc}`;
      return [
        [[' ' + ui.input.label, 'bold yellow'], ...viMode, [`   ${keys}`, 'dim']],
        ...rows.map((segs, i) => [[(i === 0 && above) || (i === rows.length - 1 && below) ? ' ⋮ ' : ' │ ', 'gray'], ...segs]),
      ];
    }
    if (ui.flash && ui.flash.until > Date.now()) return [[[' ' + ui.flash.msg, ui.flash.style]]];
    if (ui.search?.q && ui.search.key === searchKey()) {
      const n = searchMatches(ui.search).length;
      return [[[` /${ui.search.q}`, 'bold'], [n ? `  ${ui.search.line != null ? (ui.search.index ?? 1) : '-'}/${n}` : '  no match', n ? '' : 'red'], ['   n / N next / previous   esc end search', 'dim']]];
    }
    const esc = ui.scope.level === 'all' ? 'esc quit' : 'esc widen';
    const keys = {
      overview: overviewKeys(ui.rows.overview[ui.sel.overview]),
      tasks: `↑↓ move  ←→ fold  v ${ui.byAgent ? 'tree' : 'by agent'}  ⏎ details  a approve  x changes  r message  N plan note  o open  d diff  L live  g agent  s/S coordinator  p plan  ${esc}`,
      plan: multi() ? `↑↓ select  ←→ fold  ⏎ open plan  o docs  r note  N plan note  s/S coordinator  g jump  c close  f ${ui.showClosed ? 'hide' : 'show'} closed  ${esc}` : `↑↓ scroll  o docs  r / N note  s/S coordinator  ${esc}  ? help`,
      changes: `↑↓ move  ←→ fold  z fold all  ⏎/d diff of the row (file, task, package, plan)  D plan diff  g agent  ${multi() ? `f ${ui.showClosed ? 'hide' : 'show'} closed  ` : ''}${esc}  ? help`,
      log: `↑↓ scroll  / search  N plan note  ${multi() ? 'p plan  ' : ''}${ui.log.plan || ui.log.query ? 'esc clear filter  ' : esc + '  '}tab views  ? help`,
      detail: '↑↓ ^d/^u G/gg scroll  ⏎/esc back  a approve  x changes  r message  N plan note  o open  d diff  L live  g agent  s/S coordinator',
      help: '↑↓ scroll  any other key: back',
      live: liveKeys(),
      liveitem: '↑↓ ^d/^u G/gg scroll  / search  esc/← back to the live view  o open outside',
    }[view()];
    return [[[' ' + keys, 'dim']]];
  }

  /** The text field of the open input (made from its starting value). */
  function inputField() {
    return (ui.input.field ??= textField(ui.input.value ?? '', { multiline: !!ui.input.multiline, vi: viMode() }));
  }
  /** vi keys in text fields: ATF_VI_MODE=1, or "vi_mode": true in the plugin config. */
  function viMode() {
    const env = process.env.ATF_VI_MODE;
    if (env !== undefined && env !== '') return !['0', 'false', 'no', 'off'].includes(env.toLowerCase());
    return pluginConfig().vi_mode === true;
  }

  function scrolled(lines, all, key, bodyH) {
    const max = Math.max(0, all.length - bodyH);
    ui.scrolls[key] = Math.max(0, Math.min(ui.scrolls[key] ?? 0, max));
    ui.drawn[key] = { texts: all.map(lineText), top: ui.scrolls[key], h: bodyH, list: false };
    lines.push(...all.slice(ui.scrolls[key], ui.scrolls[key] + bodyH).map((l, i) => highlight(l, key, ui.scrolls[key] + i)));
  }

  /** Keep a selected line visible in a list view. */
  function list(lines, all, selLine, key, bodyH) {
    let sc = ui.scrolls[key] ?? 0;
    if (selLine < sc + 1) sc = Math.max(0, selLine - 1);
    if (selLine >= sc + bodyH - 1) sc = selLine - bodyH + 2;
    sc = Math.max(0, Math.min(sc, all.length - bodyH)); // a list that fits does not scroll
    ui.scrolls[key] = sc;
    ui.drawn[key] = { texts: all.map(lineText), top: sc, h: bodyH, list: true };
    lines.push(...all.slice(sc, sc + bodyH).map((l, i) => highlight(l, key, sc + i)));
  }

  // ---------- search (/ in a view; n / N; esc ends it) ----------
  // Views whose lines can be searched: long views scroll to a match, lists select its row
  // (their lines are their rows). The Log has its own / (a filter).
  const SEARCHABLE = new Set(['detail', 'plan', 'help', 'tasks', 'changes', 'live', 'liveitem']);
  const searchKey = (v = view()) => (v === 'plan' && multi() ? null : SEARCHABLE.has(v) ? v : null);
  const lineText = (l) => (l || []).map((seg) => seg[0] ?? '').join('');
  function searchRe(q) {
    if (!q) return null;
    // smartcase: case-insensitive unless the query has a capital letter
    return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), /[A-Z]/.test(q) ? 'g' : 'gi');
  }
  /** Where the query occurs in one line's text: [[start, end], …]. */
  function occurrences(text, q) {
    const re = searchRe(q);
    if (!re) return [];
    return [...String(text).matchAll(re)].filter((m) => m[0].length).map((m) => [m.index, m.index + m[0].length]);
  }
  /**
   * A line with every match marked, the current one in another colour. Matching runs on
   * the whole line's text, so a match may span segments of different styles.
   */
  function highlight(l, key, idx) {
    const sr = ui.search;
    if (!sr?.q || sr.key !== key) return l;
    const occ = occurrences(lineText(l), sr.q);
    if (!occ.length) return l;
    const styleAt = (start) => (idx === sr.line && start === sr.start ? 'matchcur' : 'match');
    const out = [];
    let pos = 0;
    for (const [rawText, st] of l) {
      const text = String(rawText ?? '');
      let cut = 0;
      while (cut < text.length) {
        const abs = pos + cut;
        const hit = occ.find(([a, b]) => abs >= a && abs < b);
        if (hit) {
          const end = Math.min(text.length, hit[1] - pos);
          out.push([text.slice(cut, end), styleAt(hit[0])]);
          cut = end;
        } else {
          const next = occ.find(([a]) => a > abs);
          const end = next ? Math.min(text.length, next[0] - pos) : text.length;
          out.push([text.slice(cut, end), st]);
          cut = end;
        }
      }
      pos += text.length;
    }
    return out;
  }
  /** Every match in the view, in order: [{line, start}], from what it drew last. */
  function searchMatches(sr) {
    const d = ui.drawn[sr.key];
    if (!d || !sr.q) return [];
    return d.texts.flatMap((t, line) => occurrences(t, sr.q).map(([start]) => ({ line, start })));
  }
  /** Go to the next (dir 1) / previous (-1) match; dir 0: the first at or after where we are. */
  function searchGo(dir) {
    const sr = ui.search;
    const d = ui.drawn[sr?.key];
    if (!sr?.q || !d) return;
    const ms = searchMatches(sr);
    sr.count = ms.length;
    if (!ms.length) return void ((sr.line = null), (sr.start = null), (sr.index = 0));
    // where we are: the current match, else the selected row / the top of the view
    const from = sr.line != null ? { line: sr.line, start: sr.start } : { line: d.list ? (ui.sel[sr.key] ?? 0) : d.top, start: -1 };
    const cmp = (m) => m.line - from.line || m.start - from.start;
    let i;
    if (dir > 0) i = ms.findIndex((m) => cmp(m) > 0);
    else if (dir < 0) i = ms.findLastIndex((m) => cmp(m) < 0);
    else i = ms.findIndex((m) => cmp(m) >= 0);
    if (i < 0) i = dir < 0 ? ms.length - 1 : 0; // wrap around
    sr.line = ms[i].line;
    sr.start = ms[i].start;
    sr.index = i + 1;
    if (d.list) ui.sel[sr.key] = sr.line;
    else if (sr.line < d.top || sr.line >= d.top + d.h) ui.scrolls[sr.key] = Math.max(0, sr.line - Math.floor(d.h / 3));
  }
  /** Matches in the Tasks view's preview of the selected task (its details). */
  function previewMatches(q) {
    const p = ui.drawn.preview;
    if (!p || !q) return 0;
    return p.texts.reduce((n, t) => n + occurrences(t, q).length, 0);
  }
  /** What the search finds, for the field's hint. */
  function searchHint(key, q) {
    if (!q) return 'type to search · ⏎ keep · esc cancel';
    const n = searchMatches({ key, q }).length;
    const inPreview = key === 'tasks' && !n ? previewMatches(q) : 0;
    if (inPreview) return `no row matches; ${inPreview} in ${ui.drawn.preview.task}'s details: ⏎ opens them at the first`;
    return `${n ? `${n} match${n === 1 ? '' : 'es'}` : 'no match'} · ⏎ keep (n / N next / previous, esc ends) · esc cancel`;
  }
  /** Open the selected task's details with the search in them (from the Tasks preview). */
  function searchIntoDetails(q) {
    const p = ui.drawn.preview;
    ui.overlay = 'detail';
    ui.scrolls.detail = 0;
    ui.drawn.detail = { texts: p.texts, top: 0, h: Math.max(1, (out.rows || 24) - 8), list: false };
    ui.search = { key: 'detail', q, line: null, start: null };
    searchGo(0);
  }
  function startSearch() {
    const key = searchKey();
    if (!key) return flash('search (/) works in Tasks, Changes, the plan, task details, the live view and help; the Log filters with /', 'dim');
    const before = ui.search;
    const at = { sel: ui.sel[key], scroll: ui.scrolls[key] };
    ui.input = {
      label: '/',
      value: before?.key === key ? before.q : '',
      hint: searchHint(key, before?.key === key ? before.q : ''),
      onChange: (q) => {
        // from where the search started, to the first match
        ui.sel[key] = at.sel;
        ui.scrolls[key] = at.scroll;
        ui.search = { key, q, line: null, start: null };
        searchGo(0);
        if (ui.input) ui.input.hint = searchHint(key, q);
      },
      onSubmit: (q) => {
        if (!q.trim()) return void (ui.search = null);
        if (key === 'tasks' && !searchMatches({ key, q }).length && previewMatches(q)) return searchIntoDetails(q);
        ui.search = { ...(ui.search?.key === key ? ui.search : { key, line: null, start: null }), q };
        if (ui.search.line == null) searchGo(0);
      },
      onCancel: () => {
        ui.search = before;
        ui.sel[key] = at.sel;
        ui.scrolls[key] = at.scroll;
      },
    };
    draw();
  }

  function draw() {
    const W = out.columns || 80;
    const H = out.rows || 24;
    const plans = scopePlans();
    const lines = [...header(W, plans), [['─'.repeat(W), 'gray']]];
    const foot = footer();
    const bodyH = H - lines.length - foot.length;
    const v = view();

    if (v === 'help') scrolled(lines, helpLines(), 'help', bodyH);
    else if (v === 'live' || v === 'liveitem') drawLive(lines, W, bodyH, v);
    else if (v === 'overview') {
      // the list on top, the selected row's context below it
      const { lines: all, selLine } = overviewTabLines(W, plans);
      const ctx = contextLines(ui.rows.overview[ui.sel.overview], W);
      const panelMax = ctx.length ? Math.max(6, Math.floor(bodyH * 0.42)) : 0; // the list comes first
      const listH = Math.max(Math.min(all.length, bodyH - Math.min(panelMax, ctx.length + 1)), Math.min(all.length, bodyH - panelMax));
      list(lines, all, selLine, 'overview', listH);
      const room = bodyH - listH;
      if (ctx.length && room > 2) {
        lines.push([['─'.repeat(W), 'gray']]);
        lines.push(...ctx.slice(0, room - 1));
      }
    } else if (v === 'detail') {
      const r = ui.rows.tasks[ui.sel.tasks];
      if (r?.type === 'task') scrolled(lines, detailLines(r.st, r.task, W), 'detail', bodyH);
      else ui.overlay = null;
    } else if (v === 'plan' && multi()) {
      const { lines: all, selLine } = planCardsLines(W, plans);
      list(lines, all, selLine, 'plan', bodyH);
    } else if (v === 'plan') scrolled(lines, planTabLines(W, plans), 'plan', bodyH);
    else if (v === 'changes') {
      const rows = buildChangeRows();
      if (!rows.length) lines.push([[' No active plans in scope.', 'dim']]);
      list(lines, rows.map((r, i) => changeRowLine(r, W, i === ui.sel.changes)), ui.sel.changes, 'changes', bodyH);
    } else if (v === 'log') {
      const [bar, rule, ...rest] = logTabLines(W, plans);
      lines.push(bar, rule); // the filter bar stays put while the events scroll
      scrolled(lines, rest, 'log', bodyH - 2);
    }
    else {
      // tasks: rows on top; attention + preview of the selected task below (plan scope)
      const rows = buildTaskRows();
      if (!rows.length) lines.push([[multi() ? ' No active plans in scope.' : ' No tasks yet. Add with `atf add <title>`.', 'dim']]);
      const all = rows.map((r, i) => (r.type === 'plan' ? planHeaderRow(r, W, i === ui.sel.tasks, r) : r.type === 'note' ? [[r.text, 'dim']] : r.type === 'agent' ? agentRowLine(r, W, i === ui.sel.tasks) : taskRowLine(r, W, i === ui.sel.tasks)));
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
        ui.drawn.preview = null;
        if (room > 3 && r?.type === 'task') {
          const det = detailLines(r.st, r.task, W);
          // the search covers the preview too (⏎ on a match there opens the details)
          ui.drawn.preview = { texts: det.map(lineText), task: r.task };
          lines.push([['─'.repeat(W), 'gray']]);
          lines.push(...det.slice(0, room - 1).map((l) => highlight(l, 'tasks', -1)));
        }
      }
    }
    while (lines.length < H - foot.length) lines.push([]);
    lines.length = H - foot.length;
    if (ui.picker) {
      // the picker floats over the view, below the header
      const top = 4;
      const bw = Math.min(W - 2, Math.max(50, Math.min(110, Math.floor(W * 0.85))));
      const box = pickerBox(bw, H - top - 2);
      const x = Math.floor((W - bw) / 2);
      box.forEach((b, i) => (lines[top + i] = overlay(lines[top + i] || [], b, x, W)));
    }
    lines.push(...foot);
    out.write(`${ESC}H` + lines.map((l) => fit(l, W) + `${ESC}K`).join('\r\n'));
  }

  // ---------- actions ----------
  const selectedRow = () => {
    const v = view() === 'detail' ? 'tasks' : view();
    // one plan's Plan tab has no rows to select (it scrolls the plan): rows left from a wider
    // scope there belong to other plans
    if (v === 'plan' && !multi()) return null;
    return ui.rows[v]?.[ui.sel[v]];
  };

  async function focusAgent(st, who) {
    if (elsewhere(st, who)) return flash(`${who} runs in another herdr session`, 'red');
    // its workspace, its tab, then its pane (focusPane); by name only when its pane is unknown
    const pane = liveAgent(st, who)?.pane_id || ui.agents.get(`name:${who}`)?.pane_id;
    if (!(await focusPane(pane))) return flash(`no live herdr agent for ${who}`, 'red');
    if (popup) quit();
  }

  /** g on a plan: its coordinator, else one of its agents (working first), else a pane in the project. */
  async function focusPlan(r, st) {
    // this plan's agents (names repeat across projects: liveAgent checks the directory)
    const local = Object.values(st.actors).filter((a) => !elsewhere(st, a.id) && liveAgent(st, a.id));
    const order = [...local.filter((a) => a.role === 'coordinator'), ...local.filter((a) => a.role !== 'coordinator' && liveAgent(st, a.id)?.agent_status === 'working'), ...local.filter((a) => a.role !== 'coordinator')];
    for (const a of order) if (await focusPane(liveAgent(st, a.id)?.pane_id)) return popup ? quit() : draw();
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
    if (r.type === 'agent') return r.actor ? focusAgent(r.st, r.actor) : flash('nobody owns these tasks: s starts an agent for a ready one');
    if (r.type === 'need' && !r.task && !r.actor) return focusPlan(r.root, r.st);
    if (r.type === 'need' && r.actor) return focusAgent(r.st, r.actor);
    if (r.type === 'task' || r.type === 'need') {
      const t = r.st.tasks[r.task];
      if (!t.owner) return flash('task has no owner');
      return focusAgent(r.st, t.owner);
    }
  }

  // ---------- acting: sent at once; the human's words go to the coordinator ----------
  function writeAsHuman(r, events, ok) {
    try {
      transact(r.root, r.plan, me, () => events);
      flash(ok, 'green');
    } catch (e) {
      flash(e.message, 'red');
    }
  }

  /** a / x on a task in review: approve, or send it back with one change request. */
  function reviewNow(action, message = '') {
    const r = selectedTask();
    if (!r) return flash('select a task');
    const t = r.st.tasks[r.task];
    if (action === 'approve' && t.status !== 'review') return flash(`${t.id} is not in review`);
    try {
      let res;
      transact(r.root, r.plan, me, (st) => {
        res = reviewEvents(st, [{ task: r.task, action, message }], me);
        return res.events;
      });
      if (res.refused.length) return flash(`not sent: ${res.refused[0].why}`, 'red');
      flash(action === 'approve' ? `approved ${t.id}: done` : `change request for ${t.id} sent to the coordinator (it decides what happens)`, 'green');
    } catch (e) {
      flash(e.message, 'red');
    }
  }

  /**
   * The plan a plan note is for: the one in scope, else the selected row's (or the log's
   * plan filter), else the only plan in scope; null when that leaves a choice.
   */
  function planTarget() {
    const of = (root, plan) => {
      const st = cachedPlan(root, plan);
      return st ? { root, plan, st } : null;
    };
    if (ui.scope.level === 'plan') return of(ui.scope.root, ui.scope.plan);
    const v = view();
    if (v === 'log') {
      const p = ui.log.plan && scopePlans().find((x) => x.key === ui.log.plan);
      if (p) return of(p.root, p.id);
    } else if (v !== 'help') {
      const r = selectedRow();
      if (r?.root && r?.plan) return of(r.root, r.plan);
    }
    const ps = scopePlans();
    return ps.length === 1 ? of(ps[0].root, ps[0].id) : null;
  }

  /** The text field for a note on plan `pr` (an answer when the plan asks a question). */
  function askPlanNote(pr) {
    const q = pr.st.questions?.length;
    ui.input = {
      label: `${q ? 'answer' : 'note'} on plan "${pr.st.title}", for its coordinator: `,
      value: '',
      hint: '⏎ send',
      multiline: true,
      onSubmit: (text) => text.trim() && writeAsHuman(pr, [{ type: 'plan.note', data: { message: text.trim(), kind: 'info' } }], `sent to the coordinator of "${pr.st.title}"`),
    };
  }

  /** N, in every view: a note on a plan, for its coordinator (picked when it is not clear which). */
  function planNote() {
    const pr = planTarget();
    if (pr) return askPlanNote(pr);
    const plans = scopePlans();
    if (!plans.length) return flash('no plan in scope');
    openPicker({ title: 'note on plan', plans, onPick: (p) => p && askPlanNote({ root: p.root, plan: p.id, st: p.st }) });
  }

  /**
   * r: reply. To the coordinator waiting for input: typed into its prompt. On a task: a
   * note, which answers a question (its agent is woken) or reaches the owner's wait.
   */
  function reply() {
    const r = selectedRow();
    if (r?.type === 'need' && r.kind === 'coordinator') {
      return (ui.input = {
        label: `to ${r.actor}: `,
        value: '',
        hint: '⏎ send', multiline: true,
        onSubmit: async (text) => {
          if (!text.trim()) return;
          const res = await herdrAsync(['agent', 'prompt', r.pane, text.trim()]);
          flash(res ? `sent to ${r.actor}` : `could not send to ${r.actor} (g opens its terminal)`, res ? 'green' : 'red');
        },
      });
    }
    if (r?.type === 'need' && r.kind === 'prompt') return flash('it waits at a dialog in its terminal: g opens it');
    const tr = selectedTask();
    if (!tr) {
      // a plan row: a plan-level note (answers the plan's question), for the coordinator
      const pr = planTarget();
      return pr ? askPlanNote(pr) : flash('select a task or a plan (N: a note on a plan, from any view)');
    }
    const t = tr.st.tasks[tr.task];
    const question = t.status === 'blocked' && !t.blocked_on.length;
    ui.input = {
      label: `${question ? 'answer' : 'message'} on ${t.id}, for the coordinator: `,
      value: '',
      hint: '⏎ send', multiline: true,
      // v2: the coordinator reads it and decides (starts an agent with its instructions, …)
      onSubmit: (text) => text.trim() && writeAsHuman(tr, [{ type: 'task.note', task: t.id, data: { message: text.trim(), kind: 'info' } }], `${question ? 'answer' : 'message'} on ${t.id} sent to the coordinator`),
    };
  }

  /** x: a change request on a task, sent at once to the coordinator (it decides). */
  function changeNow() {
    const r = selectedTask();
    if (!r) return flash('select a task');
    ui.input = { label: `change request for ${r.task}, for the coordinator: `, value: '', hint: '⏎ send', multiline: true, onSubmit: (text) => text.trim() && reviewNow('change', text.trim()) };
  }

  // ---------- the live view (L): a run's full view in the board, updated while it runs ----------
  // The kind's full view (docs/live-plugins.md) with foldable sections and items (⏎: the
  // kind's `item`, e.g. a failed test's stack trace), or the raw output (t). o opens the
  // run outside the board as before (the kind's `open`, `atf live --watch`, the output).
  const runRef = (x) => x.out || x.ref;
  const runKey = (x) => supersedeKey({ ...x, kind: artifactKind(x.kind) });

  /** The task's runs, in the order [ and ] go through: waiting, running, then recorded. */
  function liveRuns(lv) {
    const st = cachedPlan(lv.root, lv.plan);
    const t = st.tasks[lv.task];
    if (!t) return { st, t: null, runs: [] };
    const live = taskLive(t, runsOf(lv.root, lv.plan));
    return { st, t, live, runs: [...live.now.filter((n) => n.waiting), ...live.now.filter((n) => !n.waiting), ...live.recorded] };
  }
  /** The run the view shows; a run that just ended is followed to its recorded output. */
  function liveRun(lv) {
    const r = liveRuns(lv);
    const x = r.runs.find((y) => runRef(y) === lv.ref) || r.runs.find((y) => lv.skey && runKey(y) === lv.skey) || r.runs[0] || null;
    if (x) (lv.ref = runRef(x)), (lv.skey = runKey(x));
    return { ...r, x };
  }

  /** L: open the live view of the selected task (from Tasks, the Overview or its details). */
  function openLiveView() {
    const r = selectedRow();
    const t = r?.task && r.st?.tasks[r.task];
    if (!t) return flash('select a task');
    const lv = { root: r.root, plan: r.plan, task: t.id, ref: null, skey: null, raw: false, follow: false, folded: new Map(), from: ui.overlay, item: null, meta: [] };
    const { x } = liveRun(lv);
    if (!x) return flash(`nothing live on ${t.id} (agents' builds, tests and pipelines show here)`);
    lv.raw = !hasView(x.kind); // a kind without a view: its output is the view
    lv.follow = lv.raw; // the output from its end (and following it while it is written)
    ui.live = lv;
    ui.sel.live = 0;
    ui.scrolls.live = 0;
    if (ui.search?.key === 'live' || ui.search?.key === 'liveitem') ui.search = null;
    ui.overlay = 'live';
    draw();
  }

  const RUN_STATE = { ok: ['✓', 'green'], failed: ['✗', 'red'], waiting: ['⧖', 'yellow'], running: ['⚙', 'cyan'], gone: ['–', 'gray'], unknown: ['·', ''] };
  /** The live view's fixed head: the task, the run (i of n), its summary and command. */
  function liveHead(r, W) {
    const { t, x, runs } = r;
    const s = x.summary;
    const [g, c] = x.active ? (x.waiting ? RUN_STATE.waiting : RUN_STATE.running) : RUN_STATE[s.state] || RUN_STATE.unknown;
    const when = x.active
      ? `${x.approval ? 'waiting for your approval' : x.waiting ? 'waiting' : 'running'} ${elapsed(x.since)}`
      : x.exit != null
        ? `exit ${x.exit}${x.duration_ms ? ' · took ' + elapsed(0, x.duration_ms) : ''} · ${ago(x.ts)} ago`
        : x.live
          ? `live file${s.mtime ? ` · written ${ago(new Date(s.mtime).toISOString())} ago` : ''}`
          : '';
    const i = runs.indexOf(x);
    return [
      [[` ${t.id} `, 'bold'], [clip(t.title, Math.max(10, W - 30)).trimEnd(), ''], [runs.length > 1 ? `   run ${i + 1}/${runs.length}  [ ] other runs` : '', 'dim']],
      [[` ${g} `, c], [`${x.kind} `, (c + ' bold').trim()], [when + '  ', 'dim'], [s.line || '', RUN_STATE[s.state]?.[1] || '']],
      [[`   ${x.cmd ? '$ ' + String(x.cmd).split('\n')[0] : runRef(x)}`, 'gray']],
      [['─'.repeat(W), 'gray']],
    ];
  }

  /**
   * The live view's lines: the kind's full view with folded sections, or the raw output.
   * lv.meta gets, per line, the section it heads or belongs to and its item.
   */
  function liveBody(lv, x, W) {
    const body = [];
    const meta = [];
    if (lv.raw) {
      const text = (readTail(runRef(x), 512 << 10) || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');
      const out = text.split('\n');
      if (out.length && out[out.length - 1] === '') out.pop();
      for (const l of out.slice(-3000)) body.push([[l.replace(/\t/g, '    '), /\b(ERROR|FAIL(ED|URE)?)\b/.test(l) ? 'red' : /\bWARN(ING)?\b/.test(l) ? 'yellow' : '']]), meta.push({});
      if (!body.length) body.push([[fs.existsSync(runRef(x)) ? '(no output yet)' : `${runRef(x)} is gone`, 'dim']]), meta.push({});
      return { body, meta };
    }
    const view = liveView(x, x.summary, { width: W - 4, full: true, active: !!x.active });
    let sec = null;
    let hidden = false;
    const counts = new Map(); // section -> lines under it
    for (const l of view) if (l.section) (sec = l.section), counts.set(sec, 0);
      else if (sec) counts.set(sec, counts.get(sec) + 1);
    sec = null;
    for (const l of view) {
      if (l.section) {
        sec = l.section;
        const folded = lv.folded.has(sec) ? lv.folded.get(sec) : l.folded;
        hidden = folded;
        if (body.length) body.push([]), meta.push({ section: null, blank: true });
        body.push([[folded ? '▸ ' : '▾ ', 'cyan bold'], ...l, [folded ? `  (${counts.get(sec)} line${counts.get(sec) === 1 ? '' : 's'})` : '', 'dim']]);
        meta.push({ section: sec, head: true });
        continue;
      }
      if (hidden) continue;
      body.push(l);
      meta.push({ section: sec, item: l.item ?? null, blank: !l.some(([tx]) => tx.trim()) });
    }
    if (!body.length) body.push([['(nothing to show yet)', 'dim']]), meta.push({});
    return { body, meta };
  }

  function drawLive(lines, W, bodyH, v) {
    const lv = ui.live;
    const r = lv && liveRun(lv);
    if (!r?.x) {
      lines.push([[` nothing live on ${lv?.task ?? 'this task'} any more`, 'dim']]);
      lv && (lv.meta = []);
      return;
    }
    const head = liveHead(r, W);
    lines.push(...head);
    const h = Math.max(1, bodyH - head.length);
    if (v === 'liveitem') {
      // one item in full (a failed test's stack trace); cached a few seconds (it reads reports)
      const it = lv.item;
      if (!it.lines || Date.now() - it.at > 3000) Object.assign(it, { lines: liveItem(r.x, r.x.summary, it.id, { width: W - 2 }) || [[['(no details for this item)', 'dim']]], at: Date.now() });
      return scrolled(lines, it.lines.map((l) => [['  ', ''], ...l]), 'liveitem', h);
    }
    const { body, meta } = liveBody(lv, r.x, W);
    lv.meta = meta;
    if (ui.search?.key === 'live' && ui.search.q) lv.follow = false;
    if (lv.follow) ui.sel.live = body.length - 1;
    ui.sel.live = Math.max(0, Math.min(ui.sel.live ?? 0, body.length - 1));
    const marked = body.map((l, i) => [[i === ui.sel.live ? '›' : ' ', 'cyan bold'], ...(i === ui.sel.live && meta[i].item ? l.map(([tx, st]) => [tx, st === 'dim' || st === 'gray' ? st : (st + ' bold').trim()]) : l)]);
    list(lines, marked, ui.sel.live, 'live', h);
  }

  function liveKeys() {
    const lv = ui.live;
    const m = lv?.meta?.[ui.sel.live];
    const enter = m?.item ? '⏎ in full  ' : '';
    const folds = lv && !lv.raw && lv.meta.some((x) => x.head) ? '←→ z fold  ' : '';
    return `↑↓ gg G ${lv?.follow ? 'following' : 'follow'}  ${enter}${folds}t ${lv?.raw ? 'view' : 'raw'}  [ ] runs  / search  o outside  esc back`;
  }

  /** Keys of the live view and of an item in it; true if handled. */
  function liveKey(k, v, page) {
    const lv = ui.live;
    if (!lv) return (ui.overlay = null), false;
    if (v === 'liveitem') {
      if (['\x1b', 'q', 'h', '\x1b[D', '\x7f'].includes(k)) return (ui.overlay = 'live'), (lv.item = null), true;
      if (k === 'o') return openLive(liveRun(lv)), true;
      return false; // scrolling: as in every scrolled view
    }
    const n = lv.meta.length;
    const at = ui.sel.live ?? 0;
    const m = lv.meta[at] || {};
    const headOf = (i) => {
      while (i >= 0 && !lv.meta[i]?.head) i--;
      return i;
    };
    const fold = (sec, on) => lv.folded.set(sec, on);
    const isFolded = (sec) => lv.folded.get(sec) ?? false;
    if (k === '\x1b' || k === 'q') {
      ui.overlay = lv.from === 'detail' ? 'detail' : null;
      ui.live = null;
      if (ui.search?.key === 'live' || ui.search?.key === 'liveitem') ui.search = null;
      return true;
    }
    // up / down skip the blank lines between sections
    const step = (d) => {
      let i = at + d;
      while (i > 0 && i < n - 1 && lv.meta[i]?.blank) i += d;
      return Math.max(0, Math.min(n - 1, i));
    };
    if (UP.includes(k)) return (lv.follow = false), (ui.sel.live = step(-1)), true;
    if (DOWN.includes(k)) return (ui.sel.live = step(1)), (lv.follow = false), true;
    if (k === '\x1b[5~') return (lv.follow = false), (ui.sel.live = Math.max(0, at - page)), true;
    if (k === '\x1b[6~') return (lv.follow = false), (ui.sel.live = Math.min(n - 1, at + page)), true;
    if (k === '\x1b[H') return (lv.follow = false), (ui.sel.live = 0), true;
    if (k === 'G') return (lv.follow = true), (ui.sel.live = n - 1), true;
    if (k === 't') {
      lv.raw = !lv.raw;
      const x = liveRun(lv).x;
      lv.follow = lv.raw;
      ui.sel.live = 0;
      ui.scrolls.live = 0;
      if (ui.search?.key === 'live') ui.search = null;
      if (!lv.raw && x && !hasView(x.kind)) flash(`${x.kind} has no view of its own: its details`, 'dim');
      return true;
    }
    if (k === '[' || k === ']') {
      const r = liveRun(lv);
      if (r.runs.length < 2) return flash('no other runs on this task', 'dim'), true;
      const x = r.runs[(r.runs.indexOf(r.x) + (k === ']' ? 1 : r.runs.length - 1)) % r.runs.length];
      Object.assign(lv, { ref: runRef(x), skey: runKey(x), raw: !hasView(x.kind), follow: !hasView(x.kind) });
      ui.sel.live = 0;
      ui.scrolls.live = 0;
      return true;
    }
    if (k === 'o') return openLive(liveRun(lv)), true;
    if (lv.raw) return false;
    if (k === '\r' && m.item) {
      lv.item = { id: m.item, lines: null, at: 0 };
      ui.scrolls.liveitem = 0;
      ui.overlay = 'liveitem';
      return true;
    }
    const h = m.head ? at : headOf(at);
    const sec = h >= 0 ? lv.meta[h].section : null;
    if (sec && (k === '\r' || k === ' ') && m.head) return fold(sec, !isFolded(sec)), true;
    if (sec && (k === '\x1b[D' || k === 'h')) {
      if (m.head && isFolded(sec)) return true;
      fold(sec, true);
      ui.sel.live = h; // the heading stays where the cursor was
      return true;
    }
    if (sec && (k === '\x1b[C' || k === 'l')) return fold(sec, false), true;
    if (k === 'z') {
      const secs = [...new Set(lv.meta.filter((x) => x.head).map((x) => x.section))];
      const anyOpen = secs.some((x) => !isFolded(x));
      secs.forEach((x) => fold(x, anyOpen));
      if (anyOpen) ui.sel.live = Math.max(0, headOf(at));
      return true;
    }
    return false;
  }

  /**
   * o in the live view: the run outside the board. The kind decides: a URL (a pipeline
   * page) in the browser, a file followed in a herdr tab; else its viewer (atf live) or the
   * output, in a herdr tab.
   */
  async function openLive({ st, t, x } = {}) {
    if (!t || !x) return flash('nothing live to open');
    const r = { root: ui.live.root, plan: ui.live.plan, st };
    // the kind decides: a URL (a pipeline page) or a file; else its viewer or the output
    const o = liveOpen(x, x.summary);
    const url = o?.url;
    const browser = process.platform === 'darwin' ? 'open' : 'xdg-open';
    if (url) {
      const c = spawn(browser, [url], { detached: true, stdio: 'ignore' });
      c.on('error', () => flash(`could not run ${browser}`, 'red'));
      c.unref();
      return flash(`opened ${url}`, 'green');
    }
    const file = o?.file || x.out || x.ref;
    if (!fs.existsSync(file)) return flash(`${file} is gone`, 'red');
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const following = x.active || (x.live && t.status === 'in_progress');
    // a kind with a view (maven: test progress): the viewer (atf live), else the raw output
    const cmd =
      hasView(x.kind) && !o?.file
        ? `ATF_DIR=${q(r.root)} node ${q(ATF_CLI)} live ${t.id} --plan ${q(r.plan)}${following ? ' --watch' : ''}${x.active ? '' : ' --run ' + q(x.ref)}`
        : following
          ? `tail -n 200 -F ${q(file)}`
          : `less -R +G ${q(file)}`;
    if (!inHerdr()) return flash(`run: ${cmd}`);
    const coord = coordinatorOf(r.st);
    const ws = (coord.id && !coord.away && r.st.actors[coord.id]?.ctx?.herdr_workspace) || process.env.HERDR_WORKSPACE_ID;
    const label = `${t.id} ${x.kind}`;
    const tab = await herdrAsync(['tab', 'create', ...(ws ? ['--workspace', ws] : []), '--cwd', x.cwd || path.dirname(r.root), '--label', label, '--focus']);
    const pane = tab?.root_pane?.pane_id;
    if (!pane) return flash('could not open a herdr tab', 'red');
    if (ws) await herdrAsync(['workspace', 'focus', ws]);
    if (tab.root_pane.tab_id) await herdrAsync(['tab', 'focus', tab.root_pane.tab_id]); // the workspace shows its last tab otherwise
    await herdrText(['pane', 'run', pane, cmd]);
    if (popup) quit();
    else flash(`opened ${path.basename(file)} in tab "${label}"`, 'green');
  }

  /** o: open the task's best review artifact: PR/URL in the browser, branch/commit diff or file in a herdr tab. */
  async function openArtifact() {
    const sel = selectedRow();
    const r = sel?.st ? sel : ui.scope.level === 'plan' ? { root: ui.scope.root, plan: ui.scope.plan, st: cachedPlan(ui.scope.root, ui.scope.plan) } : null;
    if (!r?.st) return;
    // a plan: its documents (design.md, plan.md, …)
    const docs = !r.task ? r.st.docs || [] : [];
    const arts = docs.length ? docs.map((d) => ({ kind: 'file', ref: d })) : reviewArtifacts(r);
    if (!arts.length) return flash(r.task ? `no artifacts on ${r.task} (agents add them with atf artifact)` : 'the plan has no documents (atf plan update --doc design.md)');
    const x = arts[0];
    const proj = path.dirname(r.root);
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const detached = (cmd, args) => {
      try {
        const c = spawn(cmd, args, { cwd: proj, detached: true, stdio: 'ignore' });
        c.on('error', () => flash(`could not run ${cmd}`, 'red'));
        c.unref();
        flash(`opened ${x.ref}`, 'green');
      } catch (e) {
        flash(e.message, 'red');
      }
    };
    const browser = process.platform === 'darwin' ? 'open' : 'xdg-open';
    if (/^https?:\/\//.test(x.ref)) return detached(browser, [x.ref]);
    if (x.kind === 'pr') return detached('gh', ['pr', 'view', x.ref.replace(/^#/, ''), '--web']);
    let cmd;
    if (x.kind === 'branch') {
      let base = 'main';
      try {
        base = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: proj, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || base;
      } catch {
        try {
          execFileSync('git', ['rev-parse', '--verify', '--quiet', 'main'], { cwd: proj, stdio: 'ignore' });
        } catch {
          base = 'master';
        }
      }
      cmd = `git diff --stat ${q(base)}...${q(x.ref)} && git diff ${q(base)}...${q(x.ref)}`;
    } else if (x.kind === 'commit') cmd = `git show --stat --patch ${q(x.ref)}`;
    else if (x.kind === 'file') cmd = `${process.env.EDITOR || 'less'} ${q(x.ref)}`;
    else return flash(`${x.kind}: ${x.ref}`);
    if (!inHerdr()) return flash(`run in ${proj}: ${cmd}`);
    const label = r.task ? `review ${r.task}` : path.basename(x.ref);
    if (await openInTab(r, label, cmd)) flash(`opened ${x.ref} in tab "${label}"${docs.length > 1 ? ` (also: ${docs.slice(1).join(', ')})` : ''}`, 'green');
  }

  /**
   * Run a command in a new herdr tab in the project, in the workspace of the plan's
   * coordinator (else the board's), and bring it to the front. The popup board closes.
   */
  async function openInTab(r, label, cmd) {
    const proj = path.dirname(r.root);
    const coord = coordinatorOf(r.st);
    const ws = (coord.id && !coord.away && r.st.actors[coord.id]?.ctx?.herdr_workspace) || process.env.HERDR_WORKSPACE_ID;
    const tab = await herdrAsync(['tab', 'create', ...(ws ? ['--workspace', ws] : []), '--cwd', proj, '--label', label, '--focus']);
    const pane = tab?.root_pane?.pane_id;
    if (!pane) return flash('could not open a herdr tab', 'red'), false;
    if (ws) await herdrAsync(['workspace', 'focus', ws]);
    if (tab.root_pane.tab_id) await herdrAsync(['tab', 'focus', tab.root_pane.tab_id]); // the workspace shows its last tab otherwise
    await herdrText(['pane', 'run', pane, cmd]);
    if (popup) quit();
    return true;
  }

  // ---------- changes (§15) ----------
  /**
   * The changes of a plan (src/changes.mjs), computed in the background: recomputed when
   * the plan changed, and every few seconds while a changeset runs to the working tree.
   * null until the first result is there (the view says "reading…").
   */
  function changesOf(p) {
    const hit = ui.changes.get(p.key);
    const live = hit?.data && Object.values(hit.data.tasks).flat().some((s) => !s.target);
    const stale = !hit || hit.seq !== p.st.last_seq || (live && Date.now() - hit.at > 5000);
    if (stale && !hit?.pending) {
      const entry = { ...(hit || {}), pending: true };
      ui.changes.set(p.key, entry);
      const seq = p.st.last_seq;
      planChanges(path.dirname(p.root), p.st, { mode: changeMode(readConfig(p.root)) })
        .then((data) => ui.changes.set(p.key, { seq, at: Date.now(), data, pending: false }))
        .catch((e) => ui.changes.set(p.key, { seq, at: Date.now(), data: hit?.data ?? null, error: e.message, pending: false }))
        .finally(draw);
    }
    return ui.changes.get(p.key)?.data ?? null;
  }

  const statStr = (t) => `${t.files} file${t.files === 1 ? '' : 's'} +${t.added} -${t.removed}`;
  const FILE_STYLE = { A: 'green', M: 'yellow', D: 'red', T: 'yellow' };

  /** Rows of the Changes tab: per plan, the tasks that changed files, and their files. */
  function buildChangeRows() {
    const rows = [];
    for (const p of scopePlans()) {
      const data = changesOf(p);
      const base = { root: p.root, plan: p.id, st: p.st, key: p.key };
      const open = !multi() || (ui.open.has('chg#' + p.key) ? ui.open.get('chg#' + p.key) : !data || data.plan.length > 0); // plans without changes start folded
      rows.push({ ...base, type: 'plan', k: 'chg#' + p.key, open, sets: data?.plan ?? [], mode: data?.mode });
      if (!open) continue;
      if (!data) {
        rows.push({ ...base, type: 'note', k: p.key + '#chg-wait', text: '   reading changes…' });
        continue;
      }
      const has = (id) => levelSets(data, id).length > 0;
      const visit = (id, prefix, isLast, depth) => {
        const k = `chg#${p.key}#${id}`;
        const sets = levelSets(data, id);
        rows.push({ ...base, type: 'task', task: id, k, sets, prefix: depth ? prefix + (isLast ? '└─' : '├─') : '' });
        if (ui.collapsed.has(k)) return;
        const t = p.st.tasks[id];
        const inner = depth ? prefix + (isLast ? '  ' : '│ ') : '';
        if (t.children.length) {
          const kids = t.children.filter(has);
          kids.forEach((c, i) => visit(c, inner, i === kids.length - 1, depth + 1));
        } else for (const s of sets) for (const f of s.files) rows.push({ ...base, type: 'file', task: id, set: s, file: f, k: `${k}#${s.repo}#${f.path}`, prefix: inner + (depth ? '  ' : '') });
      };
      const roots = p.st.order.filter((id) => (!p.st.tasks[id].parent || !p.st.tasks[p.st.tasks[id].parent]) && has(id));
      roots.forEach((id, i) => visit(id, '', i === roots.length - 1, 0));
      if (!roots.length)
        rows.push({ ...base, type: 'note', k: p.key + '#chg-none', text: data.mode === 'snapshots' ? '   no changes yet: taken when a task starts and when its agent finishes it' : '   no changes reported (file, commit and branch artifacts of the tasks)' });
    }
    // closed plans are hidden unless f: say so, they are where most finished work is
    if (multi() && !ui.showClosed) {
      const hidden = rootsInScope().reduce((n, r) => n + listPlanIds(r).filter((id) => !isOpenStatus(cachedPlan(r, id))).length, 0);
      if (hidden) rows.push({ type: 'note', k: 'chg#closed-hidden', text: `   ${hidden} closed plan${hidden === 1 ? '' : 's'} hidden: f shows them` });
    } else if (!rows.length) rows.push({ type: 'note', k: 'chg#empty', text: '   No plans in scope.' });
    const prev = ui.rows.changes[ui.sel.changes]?.k;
    ui.rows.changes = rows;
    const i = prev ? rows.findIndex((r) => r.k === prev) : -1;
    ui.sel.changes = i >= 0 ? i : Math.min(ui.sel.changes ?? 0, Math.max(0, rows.length - 1));
    return rows;
  }

  function changeRowLine(r, W, selected) {
    const lead = `${selected ? ' › ' : '   '}${multi() ? '│ ' : ''}`;
    const base = selected ? 'inverse ' : '';
    if (r.type === 'plan') {
      const t = totals(r.sets);
      return [mark(selected), [r.open ? '▾ ' : '▸ ', 'bold cyan'], [clip(r.st.title, Math.max(12, W - 50)).trimEnd(), (base + 'bold cyan').trim()], [ui.scope.level === 'all' ? `  ${projectName(r.root)}` : '', 'cyan'], [t.files ? `  ${statStr(t)}` : '  no changes', 'dim'], [r.mode ? `  (${r.mode})` : '', 'gray']];
    }
    if (r.type === 'note') return [[r.text, 'dim']];
    if (r.type === 'file') {
      const f = r.file;
      const where = projectPath(r.set, f);
      const stat = f.binary ? 'binary' : `+${f.added} -${f.removed}`;
      const pre = `${lead}${r.prefix}  `;
      return [[pre, selected ? 'cyan bold' : 'gray'], [`${f.status} `, FILE_STYLE[f.status] || ''], [clip(where, Math.max(8, W - strWidth(pre) - stat.length - 6)), (base.trim() || '')], ['  ' + stat, 'dim']];
    }
    const t = r.st.tasks[r.task];
    const s = effStatus(t);
    const [g, color] = STATUS[s];
    const overlap = [...new Set(r.sets.flatMap((x) => x.overlap || []))];
    const fold = ui.collapsed.has(r.k) ? '▸' : '▾';
    const right = `${statStr(totals(r.sets))}${overlap.length ? `  ⚠ overlaps ${overlap.join(',')}` : ''}`;
    const pre = `${lead}${r.prefix}`;
    const titleW = Math.max(4, W - strWidth(pre) - strWidth(`${fold}${t.id} `) - 2 - strWidth(right) - 3);
    return [[pre, selected ? 'cyan bold' : 'gray'], [`${fold}${t.id} `, base + 'bold'], [g + ' ', (base + color).trim()], [clip(t.title, titleW) + '  ', (base + (t.children.length ? 'bold' : '')).trim()], [statStr(totals(r.sets)), 'dim'], [overlap.length ? `  ⚠ overlaps ${overlap.join(',')}` : '', 'yellow']];
  }

  /**
   * d: the combined diff of a level in the user's diff viewer (atf diff --open, in a herdr
   * tab): a file, a task, a work package (its subtree) or a plan.
   */
  async function openDiff(r, { task = null, file = null } = {}) {
    if (!r?.root || !r?.plan) return flash('select a task or a plan');
    const data = changesOf({ root: r.root, id: r.plan, st: r.st, key: keyOf(r.root, r.plan) });
    if (data && !levelSets(data, task).length) return flash(`no changes ${task ? `on ${task}` : `in "${r.st.title}"`}${data.mode === 'snapshots' ? '' : ' (agents report them as file, commit and branch artifacts)'}`);
    const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const args = [process.execPath, ATF_CLI, 'diff', task || 'plan', '--plan', r.plan, '--open', ...(file ? ['--file', file] : [])];
    const cmd = `ATF_DIR=${q(r.root)} ${args.map(q).join(' ')}`;
    if (!inHerdr()) return flash(`run: ${cmd}`);
    const label = `diff ${file ? path.basename(file) : task || clip(r.st.title, 20).trimEnd()}`;
    if (await openInTab(r, label, cmd)) flash(`opened the diff of ${file || task || r.st.title} in tab "${label}" (${diffTool()})`, 'green');
  }

  /** d outside the Changes tab: the selected task, else the plan of the row or in scope. */
  function diffSelected() {
    const r = selectedRow();
    if (r?.st && r.task) return openDiff(r, { task: r.task });
    const target = r?.st ? r : ui.scope.level === 'plan' ? { root: ui.scope.root, plan: ui.scope.plan, st: cachedPlan(ui.scope.root, ui.scope.plan) } : null;
    if (!target) return flash('select a task or a plan');
    return openDiff(target);
  }

  /**
   * s / S: start the coordinator of the selected plan (any row of it, or the plan in
   * scope): `s` resumes its session (or reports the one running), `S` starts a fresh
   * session, replacing a running coordinator after it wrote its checkpoint (press twice).
   */
  function startCoordinator(fresh) {
    const r = selectedRow();
    const target = r?.root && r?.plan ? r : ui.scope.level === 'plan' ? { root: ui.scope.root, plan: ui.scope.plan, st: cachedPlan(ui.scope.root, ui.scope.plan) } : null;
    if (!target) return flash('select a plan (or a task of it)');
    if (!isOpenStatus(target.st)) return flash(`"${target.st.title}" is ${target.st.status}`);
    if (!spawnCmd || !inHerdr()) return flash('starting a coordinator needs herdr');
    const key = keyOf(target.root, target.plan);
    const running = !!coordinatorOf(target.st).live;
    if (fresh && !(ui.confirm?.action === 'fresh' && ui.confirm.key === key && ui.confirm.until > Date.now())) {
      ui.confirm = { action: 'fresh', key, until: Date.now() + 3000 };
      return flash(running ? `replace the running coordinator of "${target.st.title}" with a fresh session (it writes a checkpoint first)? press S again` : `start a fresh coordinator session for "${target.st.title}"? press S again`, 'yellow');
    }
    ui.confirm = null;
    flash(fresh ? (running ? 'asking the coordinator for a checkpoint, then starting a fresh one…' : 'starting a fresh coordinator…') : 'starting the coordinator…', 'blue');
    const args = [...spawnCmd, 'coordinate', '--plan', target.plan, '--root', target.root, ...(fresh ? ['--fresh'] : [])];
    const p = spawn(args[0], args.slice(1), { env: { ...process.env, ATF_DIR: target.root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stderr.on('data', (d) => (buf += d));
    p.on('error', (e) => flash(`could not start the coordinator: ${e.message}`, 'red'));
    p.on('close', (code) => {
      flash(buf.trim().split('\n').pop() || (code ? 'failed' : 'done'), code === 0 ? 'green' : 'red');
      if (code === 0 && popup) quit();
    });
  }

  const me = humanActor(); // the board writes as the human

  function selectedTask() {
    const r = selectedRow();
    return r && (r.type === 'task' || (r.type === 'need' && r.task)) ? r : null;
  }

  /** ⏎ */
  function open() {
    const r = selectedRow();
    if (!r) return;
    if (view() === 'overview') {
      if (r.type === 'need' && !r.task && r.actor) return goTo(); // coordinator / prompt: its terminal
      // esc on what opens here comes straight back to the Overview
      ui.back = { scope: ui.scope, sel: ui.sel.overview };
      if (r.type === 'plan' || !r.task) return setScope({ level: 'plan', root: r.root, plan: r.plan }, { tab: 'tasks' });
      setScope({ level: 'plan', root: r.root, plan: r.plan }, { tab: 'tasks', task: r.task });
      ui.overlay = 'detail';
      ui.scrolls.detail = 0;
      return;
    }
    if (r.type === 'plan') return setScope({ level: 'plan', root: r.root, plan: r.plan }, { tab: view() === 'plan' ? 'plan' : 'tasks' });
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
    out.write(`${ESC}?2004l${ESC}?25h${ESC}?1049l`);
    process.exit(0);
  }

  const UP = ['\x1b[A', 'k', '\x0b']; // ↑ k ctrl+k (ctrl+k/j arrive only where no herdr plugin takes them)
  const DOWN = ['\x1b[B', 'j', '\n']; // ↓ j ctrl+j
  // Neovim-style moves, outside text fields: mapped onto the keys every view handles
  const NAV = { '\x06': '\x1b[6~', '\x02': '\x1b[5~', '\x04': '\x1b[6~', '\x15': '\x1b[5~', '\x1b[4~': 'G', '\x1bOF': 'G', '\x1b[F': 'G', '\x1b[1~': '\x1b[H', '\x1bOH': '\x1b[H' };
  const HALF = new Set(['\x04', '\x15']); // ctrl+d / ctrl+u: half a page
  function onKey(k) {
    let page = Math.max(1, (out.rows || 24) - 8);
    const v = view();
    if (k === '\x03') return quit();
    if (ui.picker) return pickerKey(k);
    // bracketed paste: a pasted text arrives between these, its line breaks are text
    if (k === '\x1b[200~') return void (ui.pasting = true);
    if (k === '\x1b[201~') return ((ui.pasting = false), ui.input && draw());
    if (ui.pasting && !ui.input) return;
    if (ui.input) {
      // a text field (textfield.mjs): ⏎ sends, esc cancels, everything else edits
      const f = inputField();
      const res = keyField(f, k, { pasting: ui.pasting });
      const before = ui.input.value;
      ui.input.value = fieldText(f);
      if (res === 'submit') {
        const inp = ui.input;
        ui.input = null;
        inp.onSubmit(inp.value);
      } else if (res === 'cancel') {
        ui.input.onCancel?.();
        ui.input = null;
      } else if (ui.input.value !== before) ui.input.onChange?.(ui.input.value);
      return draw();
    }
    if (k in NAV) {
      if (HALF.has(k)) page = Math.max(1, Math.ceil(page / 2));
      k = NAV[k];
    }
    // gg: to the top. A single g keeps its meaning (to the agent) after a short wait for a second one
    if (k === 'g' && !onKey.gNow) {
      if (onKey.gTimer) {
        clearTimeout(onKey.gTimer);
        onKey.gTimer = null;
        k = '\x1b[H';
      } else {
        onKey.gTimer = setTimeout(() => {
          onKey.gTimer = null;
          onKey.gNow = true;
          try {
            onKey('g');
          } finally {
            onKey.gNow = false;
          }
        }, 300);
        return;
      }
    }
    // search: n / N move between matches and esc ends it, while one is active in this view
    // (they mean reply / plan note again afterwards); the Log keeps its own / filter
    if (ui.search?.q && ui.search.key === searchKey(v)) {
      if (k === 'n' || k === 'N') return searchGo(k === 'n' ? 1 : -1), draw();
      if (k === '\x1b') return (ui.search = null), draw();
    }
    if (k === '/' && v !== 'log') return startSearch();
    if ((v === 'live' || v === 'liveitem') && liveKey(k, v, page)) return draw();
    if (v === 'log') {
      if (k === '/') {
        const before = ui.log.query;
        ui.input = {
          label: 'search log: ',
          value: before,
          hint: 'filters as you type · ⏎ keep',
          onChange: (q) => ((ui.log.query = q), (ui.scrolls.log = 0)),
          onSubmit: (q) => (ui.log.query = q.trim()),
          onCancel: () => (ui.log.query = before),
        };
        return draw();
      }
      if (k === 'p' && multi()) {
        openPicker({
          title: 'log of plan',
          plans: scopePlans(),
          all: true,
          current: ui.log.plan,
          onPick: (p) => ((ui.log.plan = p?.key ?? null), (ui.scrolls.log = 0)),
        });
        return draw();
      }
      if (k === '\x1b' && !ui.overlay && (ui.log.plan || ui.log.query)) {
        ui.log = { plan: null, query: '' };
        ui.scrolls.log = 0;
        return draw();
      }
    }
    if (k === 'N' && v !== 'help') return planNote(), draw(); // a plan note, from every view
    // the Changes tab: its own moves and folds; tabs, esc, help, plan picker as everywhere
    if (v === 'changes' && !['\x1b', 'q', '\t', '\x1b[Z', '?', 'A', 'p', 'f'].includes(k) && !/^[0-9]$/.test(k)) {
      const r = selectedRow();
      const n = ui.rows.changes.length;
      if (k === '\r' || k === 'd') {
        if (r?.type === 'file') return openDiff(r, { task: r.task, file: projectPath(r.set, r.file) });
        if (r?.type === 'task') return openDiff(r, { task: r.task });
        if (r?.type === 'plan') return openDiff(r);
        return;
      }
      if (k === 'D' && r?.st) return openDiff(r);
      if (k === 'g') return goTo();
      const foldable = r && (r.type === 'plan' || r.type === 'task');
      const isOpen = (x) => (x.type === 'plan' ? x.open : !ui.collapsed.has(x.k));
      const setOpen = (x, o) => (x.type === 'plan' ? ui.open.set(x.k, o) : o ? ui.collapsed.delete(x.k) : ui.collapsed.add(x.k));
      if (UP.includes(k)) ui.sel.changes = Math.max(0, ui.sel.changes - 1);
      else if (DOWN.includes(k)) ui.sel.changes = Math.min(n - 1, ui.sel.changes + 1);
      else if (k === '\x1b[5~') ui.sel.changes = Math.max(0, ui.sel.changes - page);
      else if (k === '\x1b[6~') ui.sel.changes = Math.min(n - 1, ui.sel.changes + page);
      else if (k === '\x1b[H') ui.sel.changes = 0;
      else if (k === 'G') ui.sel.changes = n - 1;
      else if (k === ' ' && foldable) setOpen(r, !isOpen(r));
      else if ((k === '\x1b[C' || k === 'l') && foldable) setOpen(r, true);
      else if (k === '\x1b[D' || k === 'h') {
        if (foldable && isOpen(r) && (r.type === 'task' || multi())) setOpen(r, false);
        else {
          // up to the row this one hangs under: its task, the parent task, the plan
          const parent = r?.type === 'file' ? r.task : r?.type === 'task' ? r.st.tasks[r.task].parent : null;
          let j = ui.sel.changes - 1;
          while (j >= 0 && !(parent ? ui.rows.changes[j].type === 'task' && ui.rows.changes[j].task === parent && ui.rows.changes[j].key === r.key : ui.rows.changes[j].type === 'plan')) j--;
          if (j >= 0) ui.sel.changes = j;
        }
      } else if (k === 'z') {
        const tasks = ui.rows.changes.filter((x) => x.type === 'task');
        const anyOpen = tasks.some(isOpen);
        for (const x of tasks) setOpen(x, !anyOpen);
      }
      if (r?.root && r?.plan) ui.focus = { root: r.root, plan: r.plan };
      return draw();
    }
    if (k === 'd' && ['overview', 'tasks', 'detail', 'plan'].includes(v)) return diffSelected();
    if (['overview', 'tasks', 'detail', 'plan'].includes(v)) {
      // acting takes effect at once; the human's words go to the coordinator (§12.5)
      if (v !== 'plan' && k === 'a') return reviewNow('approve');
      if (v !== 'plan' && k === 'x') return changeNow(), draw();
      if (k === 'r' || k === 'n') return reply(), draw();
      if (k === 'o') return openArtifact();
      if (k === 'L') return openLiveView();
      if (k === 's') return startCoordinator(false);
      if (k === 'S') return startCoordinator(true);
    }
    if (k === 'q') {
      if (ui.back) back();
      else if (ui.overlay) ui.overlay = null;
      else return quit();
    } else if (v === 'help') {
      const sc = ui.scrolls.help ?? 0;
      if (UP.includes(k)) ui.scrolls.help = Math.max(0, sc - 1);
      else if (DOWN.includes(k)) ui.scrolls.help = sc + 1;
      else if (k === '\x1b[5~') ui.scrolls.help = Math.max(0, sc - page);
      else if (k === '\x1b[6~') ui.scrolls.help = sc + page;
      else if (k === '\x1b[H') ui.scrolls.help = 0;
      else if (k === 'G') ui.scrolls.help = Number.MAX_SAFE_INTEGER;
      else ui.overlay = null;
    } else if (k === '\x1b') {
      if (ui.back) back();
      else if (ui.overlay) ui.overlay = null;
      else widen();
    } else if (k === '\t' || k === '\x1b[Z') {
      ui.back = null;
      const i = TABS.findIndex(([id]) => id === ui.tab);
      ui.tab = TABS[(i + (k === '\t' ? 1 : TABS.length - 1)) % TABS.length][0];
      ui.overlay = null;
    } else if (new RegExp(`^[0-${TABS.length - 1}]$`).test(k)) {
      ui.back = null;
      ui.tab = TABS[Number(k)][0];
      ui.overlay = null;
    } else if (k === '?') ui.overlay = 'help';
    else if (k === 'A') (ui.back = null), setScope({ level: 'all' });
    else if (k === 'p') {
      // go to any plan, in any project; the current view stays (the Overview opens Tasks)
      const tab = ui.tab === 'overview' ? 'tasks' : ui.tab;
      openPicker({
        title: 'go to plan',
        plans: allPlans(),
        current: ui.scope.level === 'plan' ? keyOf(ui.scope.root, ui.scope.plan) : null,
        onPick: (p) => ((ui.back = null), setScope({ level: 'plan', root: p.root, plan: p.id }, { tab })),
      });
    } else if (k === 'f' && v !== 'detail') {
      // closed plans: shown or hidden in every view that lists plans
      ui.showClosed = !ui.showClosed;
      flash(ui.showClosed ? 'showing closed plans too' : 'showing active plans only', 'blue');
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
      else if (k === 'G') ui.sel[key] = n - 1;
      else if (k === '\r') open();
      else if (k === 'g') return goTo();
      else if (v === 'plan' && r?.type === 'plan' && ['\x1b[C', 'l', '\x1b[D', 'h', ' '].includes(k)) {
        const fold = k === ' ' ? !ui.cardFolded.has(r.key) : k === '\x1b[D' || k === 'h';
        if (fold) ui.cardFolded.add(r.key);
        else ui.cardFolded.delete(r.key);
      } else if (v === 'plan' && k === 'z') {
        const keys = ui.rows.plan.map((x) => x.key);
        const anyOpen = keys.some((key) => !ui.cardFolded.has(key));
        for (const key of keys) anyOpen ? ui.cardFolded.add(key) : ui.cardFolded.delete(key);
      } else if (k === 'c') return closePlan(r?.type === 'need' || r?.type === 'task' || r?.type === 'plan' ? r : null);
      else if (v === 'tasks' && k === 'v') {
        ui.byAgent = !ui.byAgent;
        flash(ui.byAgent ? 'tasks grouped by agent (v: task tree)' : 'task tree (v: group by agent)', 'blue');
      } else if (v === 'tasks' && ui.byAgent && (k === '\x1b[D' || k === 'h')) {
        if (!fold(r, false) && r?.type !== 'plan') {
          // to the agent heading, then the plan header
          let j = ui.sel.tasks - 1;
          const want = r?.type === 'agent' ? 'plan' : 'agent';
          while (j >= 0 && ui.rows.tasks[j].type !== want) j--;
          if (j >= 0) ui.sel.tasks = j;
        }
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
      else if (k === '\x1b[H') ui.scrolls[key] = 0;
      else if (k === 'G') ui.scrolls[key] = Number.MAX_SAFE_INTEGER; // the view clamps it to its end
      else if (k === '\r' && v === 'detail') ui.back ? back() : (ui.overlay = null);
      else if (v === 'detail' && k === 'g') return goTo();
      else if (k === 'A') setScope({ level: 'all' });
    }
    draw();
  }

  // ---------- start ----------
  if (initialRoot && start === 'plan') {
    const plan = pickPlan(initialRoot);
    // open the plan only if it is still open; a project with only closed plans starts at project scope
    if (plan && isOpenStatus(cachedPlan(initialRoot, plan))) setScope({ level: 'plan', root: initialRoot, plan }, { tab: 'tasks' });
    else setScope({ level: 'project', root: initialRoot }, { tab: 'overview' });
  } else setScope({ level: 'all' }, { tab: 'overview' });
  if (initialRoot) ui.focus = ui.focus || { root: initialRoot, plan: pickPlan(initialRoot) };

  registerBoardProcess(); // lets the toggle tell this board from a shell restored in its pane
  // live kinds from plugins (docs/live-plugins.md): built-ins until they are loaded; their
  // refresh (e.g. a CI API) runs in the background for what the board shows
  enableAutoRefresh();
  loadLiveKinds()
    .then(({ errors }) => (errors.length ? flash(`live plugin failed: ${errors[0].file}: ${errors[0].error}`, 'red') : draw()))
    .catch(() => {});
  out.write(`${ESC}?1049h${ESC}?25l${ESC}?2004h${ESC}2J`);
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit);
  out.on('resize', draw);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    const keys = d.replace(/\r\n/g, '\r').match(/\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|\x1b[\r\n\x7f\bbfdz<>]|\x1b|[\s\S]/g) || [];
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
  // notifications (notify.mjs): what newly needs the human, with the agents this board
  // already knows; a waiting coordinator or agent shows up here first (no event for it)
  setInterval(() => {
    if (inHerdr() && ui.agents) notifyTick({ agents: ui.agents, extraRoots: [...new Set(scopePlans().map((p) => p.root))] });
  }, 5000);
}
