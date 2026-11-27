// ATF web UI (docs/webui-design.md §4.5): the herdr board's views, scopes, actions and keys,
// with agent panes below. Plain ES modules, no framework, no build step.
// Data: /api/overview (projects, open plans with their folded state, what needs you),
// refreshed when /api/stream says something changed. Writes: /api/action as the human.
import { createTerms } from './terms.js';

// ---------------------------------------------------------------- small helpers
const $ = (s) => document.querySelector(s);
/** An element: h('div', {class: 'x', onclick}, child, 'text', [more]) (text is never parsed as HTML). */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const first = (s, max = 160) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};
const store = {
  get: (k, d) => {
    try {
      return JSON.parse(localStorage.getItem(`atf.${k}`)) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => localStorage.setItem(`atf.${k}`, JSON.stringify(v)),
};
let toastTimer = null;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `on${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 6000 : 3500);
}
async function api(path, body) {
  const r = await fetch(`/api/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) location.reload();
  if (!r.ok && !('ok' in j)) throw new Error(j.error || `${r.status}`);
  return j;
}
const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();

// ---------------------------------------------------------------- what the board says
// as the herdr board labels them (adapters/herdr/lib/tui.mjs NEED), most urgent first
const NEED = {
  prompt: ['! prompt', 'at a prompt in its terminal'],
  'no-coordinator': ['⚠ no coord', 'nobody runs this plan: start a coordinator'],
  coordinator: ['? input', 'the coordinator waits for your input'],
  'your-review': ['◎ review', 'for you to review'],
  question: ['⊘ question', 'a question'],
  'plan-question': ['? plan', 'a question about the plan'],
  failed: ['✗ failed', 'failed'],
  review: ['◎ review', 'for the coordinator to review'],
  stale: ['◌ stalled', 'its agent is idle, the task still in progress'],
  finished: ['● finished', 'all tasks finished: close the plan'],
  'your-task': ['☐ to do', 'your task'],
};
const RANK = Object.fromEntries(Object.keys(NEED).map((k, i) => [k, i]));
const STATUS_ICON = { todo: '○', in_progress: '◐', blocked: '⊘', review: '◎', done: '●', failed: '✗', cancelled: '–' };
const TABS = [
  ['overview', 'Overview'],
  ['tasks', 'Tasks'],
  ['plan', 'Plan'],
  ['log', 'Log'],
];

// ---------------------------------------------------------------- state
const S = {
  ov: null, // /api/overview
  scope: store.get('scope', { level: 'all' }), // {level: all|project|plan, root, plan}
  tab: store.get('tab', 'overview'),
  sel: {}, // view -> selected row key
  rows: [],
  closed: new Map(), // key -> planView of a closed plan (fetched on demand)
  briefs: new Map(), // `${key}#${task}#${seq}` -> brief | 'loading'
  logs: new Map(), // `${key}#${seq}` -> events
  docs: new Map(), // `${key}#${doc}` -> text
  compose: null, // {action, p, task, label, status}
  pane: store.get('pane', null), // the session shown in the panes
  showClosed: new Set(), // project roots whose closed plans are listed
  busy: false,
};
const viewKey = () => `${S.tab}#${S.scope.level}#${S.scope.root ?? ''}#${S.scope.plan ?? ''}`;

const projects = () => S.ov?.projects ?? [];
const allPlans = () => projects().flatMap((pr) => pr.plans.map((p) => ({ ...p, project: pr })));
const planByKey = (key) => {
  const p = allPlans().find((x) => x.key === key);
  if (p && !p.open && S.closed.has(key)) return { ...S.closed.get(key), project: p.project };
  return p;
};
const projectOf = (root) => projects().find((pr) => pr.root === root);
const title = (p) => p.st?.title ?? p.summary?.title ?? p.id;
const planLabel = (p) => `${p.project?.name ?? ''} · ${title(p)}`;

/** Plans in scope with their state (closed ones only when the scope is that plan). */
function scopePlans() {
  const sc = S.scope;
  if (sc.level === 'plan') {
    const p = planByKey(`${sc.root}#${sc.plan}`);
    return p?.st ? [p] : [];
  }
  return allPlans().filter((p) => p.open && (sc.level === 'all' || p.root === sc.root));
}
const scopePlan = () => (S.scope.level === 'plan' ? scopePlans()[0] ?? null : null);

function setScope(scope, tab) {
  S.scope = scope;
  if (tab) S.tab = tab;
  store.set('scope', S.scope);
  store.set('tab', S.tab);
  S.compose = null;
  if (scope.level === 'plan') {
    const key = `${scope.root}#${scope.plan}`;
    const p = allPlans().find((x) => x.key === key);
    if (p && !p.open && !S.closed.has(key)) loadClosed(p);
  }
  render();
}
async function loadClosed(p) {
  try {
    S.closed.set(p.key, await api(`plan?${q({ root: p.root, plan: p.id })}`));
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------- loading, live updates
let loading = null;
async function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      S.ov = await api('overview');
      // closed plans in view: fetch again (cheap) so the plan view stays current
      const sp = S.scope.level === 'plan' ? allPlans().find((x) => x.key === `${S.scope.root}#${S.scope.plan}`) : null;
      if (sp && !sp.open) S.closed.set(sp.key, await api(`plan?${q({ root: sp.root, plan: sp.id })}`));
      render();
    } catch (e) {
      toast(`could not load: ${e.message}`, true);
    } finally {
      loading = null;
    }
  })();
  return loading;
}
function stream() {
  const es = new EventSource('/api/stream');
  let t = null;
  es.onmessage = () => {
    clearTimeout(t);
    t = setTimeout(load, 120);
  };
  es.onopen = () => (conn(true), load());
  es.onerror = () => conn(false);
}
const conn = (up) => $('#conn').classList.toggle('up', up);

// ---------------------------------------------------------------- rows
/** Tasks being worked on now: in progress, reworked after review, or answered; newest first. */
const currentWork = (st) =>
  st.order
    .map((id) => st.tasks[id])
    .filter((t) => !t.children.length && (t.status === 'in_progress' || (t.status === 'todo' && t.changes_requested && t.owner) || t.answered))
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
function idleReason(st) {
  const leaves = st.order.map((id) => st.tasks[id]).filter((t) => !t.children.length);
  if (!leaves.length) return 'no tasks yet';
  if (leaves.every((t) => ['done', 'failed', 'cancelled'].includes(t.status))) return 'all tasks finished';
  if (st.status === 'paused') return 'paused';
  const n = (f) => leaves.filter(f).length;
  const bits = [];
  if (n((t) => t.status === 'review')) bits.push(`${n((t) => t.status === 'review')} in review`);
  if (n((t) => t.status === 'blocked' && !t.blocked_on.length && !t.answered)) bits.push(`${n((t) => t.status === 'blocked' && !t.blocked_on.length && !t.answered)} blocked on a question`);
  if (n((t) => t.ready && !t.owner)) bits.push(`${n((t) => t.ready && !t.owner)} ready, not started`);
  if (n((t) => t.status === 'todo' && t.waiting_on.length)) bits.push(`${n((t) => t.status === 'todo' && t.waiting_on.length)} waiting on dependencies`);
  return 'nothing in progress' + (bits.length ? ': ' + bits.join(', ') : '');
}
function coordState(p) {
  const c = p.coordinator;
  if (!c?.id) return 'no coordinator';
  if (c.away) return `${c.id} runs elsewhere`;
  if (!c.live) return `${c.id} not running`;
  return `${c.id} ${c.live.status}`;
}
const bar = (frac) => h('span', { class: 'bar' }, h('i', { style: `width:${Math.round((frac || 0) * 100)}%` }));

function needRow(it, p, k) {
  const t = it.task ? p.st.tasks[it.task] : null;
  const [label] = NEED[it.kind] ?? [it.kind];
  const who = it.kind === 'review' ? 'for the coordinator' : ['your-review', 'your-task'].includes(it.kind) || (it.kind === 'question' && it.for === S.ov.human) ? 'for you' : it.actor && !['coordinator', 'prompt'].includes(it.kind) ? it.actor : '';
  const text = t ? `${t.id} ${t.title}` : it.kind === 'coordinator' || it.kind === 'prompt' ? `${it.actor}${it.task ? ` (${it.task})` : ''}` : it.kind === 'no-coordinator' ? title(p) : first(it.message, 120);
  return { k, type: 'need', it, p, task: it.task, cells: [h('span', { class: `k-${it.kind}` }, label), text, `${who}${who ? ' · ' : ''}${ago(it.ts)}`] };
}

function overviewRows() {
  const out = []; // {k?, type, cells} or {sec} / {grp} / {sub} / {empty}
  const plans = scopePlans();
  const needs = plans.flatMap((p) => p.attention.mine.map((it) => ({ it, p }))).sort((a, b) => RANK[a.it.kind] - RANK[b.it.kind] || (a.it.ts || '').localeCompare(b.it.ts || ''));
  out.push({ sec: 'needs', title: 'NEEDS YOU', n: needs.length, hint: needs.length ? '' : 'nothing: every plan is moving on its own' });
  const groups = new Map();
  for (const x of needs) groups.set(x.p.key, [...(groups.get(x.p.key) || []), x]);
  const headed = S.scope.level !== 'plan' && groups.size > 0;
  for (const items of groups.values()) {
    if (headed) out.push({ grp: planLabel(items[0].p) });
    for (const { it, p } of items) {
      out.push(needRow(it, p, `need#${p.key}#${it.kind}#${it.task ?? it.actor ?? ''}`));
      const t = it.task ? p.st.tasks[it.task] : null;
      const msg = it.kind === 'your-review' || it.kind === 'question' || it.kind === 'failed' || it.kind === 'review' ? it.message : t ? '' : it.kind === 'no-coordinator' || it.kind === 'finished' ? NEED[it.kind][1] : '';
      if (msg) out.push({ sub: first(msg, 220) });
    }
  }
  const todos = plans.flatMap((p) => p.attention.todos.map((it) => ({ it, p })));
  if (todos.length) {
    out.push({ sec: 'todos', title: 'YOUR TASKS', n: todos.length });
    for (const { it, p } of todos) {
      out.push(needRow(it, p, `todo#${p.key}#${it.task}`));
      const waits = it.waiting?.length ? `${it.waiting.join(', ')} wait${it.waiting.length === 1 ? 's' : ''} on it` : '';
      const t = p.st.tasks[it.task];
      const msg = [waits, t.description && t.description !== t.title ? t.description : ''].filter(Boolean).join(' · ');
      if (msg) out.push({ sub: first(msg, 220) });
    }
  }
  out.push({ sec: 'flight', title: 'IN FLIGHT' });
  if (!plans.length) out.push({ empty: 'No active plans here. A coordinator starts one with `atf plan new <title>`.' });
  for (const p of plans) {
    const st = p.st;
    const done = st.counts?.done ?? 0;
    out.push({ k: `plan#${p.key}`, type: 'plan', p, cells: [h('span', { class: 's-in_progress' }, `${Math.round((st.progress || 0) * 100)}%`), h('span', {}, h('b', {}, title(p)), S.scope.level === 'all' ? h('span', { class: 'dim' }, `  ${p.project.name}`) : ''), h('span', {}, bar(st.progress), `  ${done}/${st.total ?? 0} · ${coordState(p)}`)] });
    const work = currentWork(st);
    for (const t of work.slice(0, 3)) out.push(taskRow(p, t, `work#${p.key}#${t.id}`, true));
    if (work.length > 3) out.push({ sub: `+ ${work.length - 3} more in progress (⏎ on the plan opens it)` });
    if (!work.length) out.push({ sub: idleReason(st) });
  }
  return out;
}

function taskRow(p, t, k, brief = false, depth = 0) {
  const st = p.st;
  const side = [t.owner ? (t.owner === S.ov.human ? 'you' : t.owner) : t.ready ? 'ready' : t.waiting_on?.length ? `waits on ${t.waiting_on.join(', ')}` : '', t.status === 'in_progress' && t.percent != null ? `${t.percent}%` : ''].filter(Boolean).join(' · ');
  const main = h('span', {}, depth ? h('span', { class: 'tree-i' }, '  '.repeat(depth) + '└ ') : '', h('b', {}, t.id), ' ', t.title, brief && t.last_message ? h('span', { class: 'dim' }, `  ${first(t.last_message, 140)}`) : '');
  return { k, type: 'task', p, task: t.id, cells: [h('span', { class: `s-${t.rollup_status ?? t.status}` }, `${STATUS_ICON[t.rollup_status ?? t.status] ?? ''} ${(t.rollup_status ?? t.status).replace('_', ' ')}`), main, side] };
}

function tasksRows() {
  const out = [];
  const plans = scopePlans();
  if (!plans.length) out.push({ empty: 'No plan in scope.' });
  for (const p of plans) {
    if (S.scope.level !== 'plan') out.push({ grp: planLabel(p) });
    for (const id of p.st.order) out.push(taskRow(p, p.st.tasks[id], `task#${p.key}#${id}`, false, p.st.tasks[id].depth ?? 0));
  }
  return out;
}

function planRows() {
  const out = [];
  const p = scopePlan();
  if (!p) {
    // all projects / a project: its plans, closed ones too
    const list = allPlans().filter((x) => S.scope.level === 'all' || x.root === S.scope.root);
    out.push({ sec: 'flight', title: 'PLANS', n: list.length });
    for (const x of list) {
      const sm = x.st ?? x.summary;
      out.push({ k: `plan#${x.key}`, type: 'plan', p: x, cells: [h('span', { class: x.open ? 's-in_progress' : 's-done' }, sm.status), h('span', {}, h('b', {}, title(x)), h('span', { class: 'dim' }, `  ${x.project.name}`)), h('span', {}, bar(sm.progress), `  ${ago(sm.updated_at)}`)] });
    }
    return out;
  }
  const st = p.st;
  out.push({ k: `plan#${p.key}`, type: 'plan', p, cells: [h('span', { class: p.open ? 's-in_progress' : 's-done' }, st.status), h('b', {}, st.title), h('span', {}, bar(st.progress), `  ${Math.round((st.progress || 0) * 100)}%`)] });
  if (st.docs?.length) {
    out.push({ sec: 'flight', title: 'DOCUMENTS', n: st.docs.length });
    for (const d of st.docs) out.push({ k: `doc#${p.key}#${d}`, type: 'doc', p, doc: d, cells: ['  doc', d, ''] });
  }
  const notes = [...st.notes].reverse().slice(0, 30);
  out.push({ sec: 'flight', title: 'PLAN NOTES', n: st.notes.length });
  if (!notes.length) out.push({ empty: 'none' });
  for (const n of notes) out.push({ k: `pnote#${p.key}#${n.seq}`, type: 'pnote', p, note: n, cells: [h('span', { class: n.kind === 'question' || n.kind === 'warning' ? 'k-coordinator' : 'dim' }, n.kind), first(n.message, 200), `${n.actor} · ${ago(n.ts)}`] });
  return out;
}

function logRows() {
  const p = scopePlan();
  if (!p) return [{ empty: 'The log is per plan: pick a plan (sidebar, or ⏎ on a plan).' }];
  const key = `${p.key}#${p.st.last_seq}`;
  const evs = S.logs.get(key);
  if (!evs) {
    if (!S.logs.has(`loading#${key}`)) {
      S.logs.set(`loading#${key}`, true);
      api(`log?${q({ root: p.root, plan: p.id })}`)
        .then((r) => {
          S.logs.set(key, r.events);
          render();
        })
        .catch((e) => toast(e.message, true));
    }
    return [{ empty: 'loading…' }];
  }
  const out = [{ log: true, events: [...evs].reverse() }];
  return out;
}

const ROWS = { overview: overviewRows, tasks: tasksRows, plan: planRows, log: logRows };

// ---------------------------------------------------------------- rendering
function render() {
  if (!S.ov) return;
  renderTree();
  renderList();
  renderBar();
  renderDetail();
  renderPanes();
  const n = allPlans().reduce((a, p) => a + (p.attention?.mine.length ?? 0), 0);
  document.title = n ? `(${n}) ATF` : 'ATF';
}

function renderTree() {
  const tree = $('#tree');
  const kids = [];
  // a repository's worktrees next to each other
  const sorted = [...projects()].sort((a, b) => (a.repo || a.dir).localeCompare(b.repo || b.dir) || a.dir.localeCompare(b.dir));
  for (const pr of sorted) {
    const open = pr.plans.filter((p) => p.open);
    const closed = pr.plans.filter((p) => !p.open);
    const n = open.reduce((a, p) => a + p.attention.mine.length, 0);
    const worktree = pr.repo && pr.repo !== pr.dir ? ` ⑂ ${pr.repo.split('/').pop()}` : '';
    const on = S.scope.level === 'project' && S.scope.root === pr.root;
    kids.push(h('div', { class: `proj${on ? ' on' : ''}`, title: pr.dir, onclick: () => setScope({ level: 'project', root: pr.root }) }, h('span', { class: 'name' }, pr.name, h('span', { class: 'dim' }, worktree)), n ? h('span', { class: 'count' }, n) : ''));
    for (const p of [...open, ...(S.showClosed.has(pr.root) ? closed : [])]) {
      const pn = p.open ? p.attention.mine.length : 0;
      const pOn = S.scope.level === 'plan' && S.scope.root === p.root && S.scope.plan === p.id;
      kids.push(h('div', { class: `plan${pOn ? ' on' : ''}${p.open ? '' : ' closed'}`, title: p.id, onclick: () => setScope({ level: 'plan', root: p.root, plan: p.id }) }, h('span', { class: 'name' }, title(p)), pn ? h('span', { class: 'count' }, pn) : ''));
      for (const a of (p.agents || []).filter((a) => !a.exited)) kids.push(h('div', { class: 'agent', title: `${a.kind ?? ''} · ${a.status}`, onclick: () => showPane(a.handle, true, p) }, h('span', { class: `dot ${a.status}` }), h('span', { class: 'name' }, a.name), h('span', { class: 'dim' }, a.task ?? (a.role === 'coordinator' ? 'coord' : ''))));
    }
    if (closed.length) kids.push(h('div', { class: 'more', onclick: () => (S.showClosed.has(pr.root) ? S.showClosed.delete(pr.root) : S.showClosed.add(pr.root), render()) }, S.showClosed.has(pr.root) ? '− hide closed' : `+ ${closed.length} closed`));
  }
  if (!kids.length) kids.push(h('div', { class: 'empty' }, 'No ATF projects yet (atf init in a project).'));
  tree.replaceChildren(...kids);
}

function renderBar() {
  const sc = S.scope;
  const crumbs = [h('button', { onclick: () => setScope({ level: 'all' }) }, 'all projects')];
  if (sc.level !== 'all') {
    const pr = projectOf(sc.root);
    crumbs.push(h('span', { class: 'sep' }, '›'), h('button', { onclick: () => setScope({ level: 'project', root: sc.root }) }, pr?.name ?? sc.root));
  }
  if (sc.level === 'plan') {
    const p = planByKey(`${sc.root}#${sc.plan}`);
    crumbs.push(h('span', { class: 'sep' }, '›'), h('button', {}, p ? title(p) : sc.plan));
  }
  $('#crumbs').replaceChildren(...crumbs);
  $('#tabs').replaceChildren(...TABS.map(([id, label], i) => h('button', { role: 'tab', 'aria-selected': String(S.tab === id), onclick: () => setTab(id) }, h('kbd', {}, i), label)));
  $('#hint').textContent = hintFor(selRow());
}
const setTab = (id) => {
  S.tab = id;
  store.set('tab', id);
  S.compose = null;
  render();
};

function renderList() {
  const list = $('#list');
  const rows = ROWS[S.tab]();
  const prev = S.rows;
  S.rows = rows.filter((r) => r.k);
  const vk = viewKey();
  if (!S.rows.some((r) => r.k === S.sel[vk])) {
    // the selected row is gone (approved, answered): the one now at its place
    const at = prev.findIndex((r) => r.k === S.sel[vk]);
    S.sel[vk] = S.rows[Math.min(Math.max(at, 0), S.rows.length - 1)]?.k ?? null;
  }
  const kids = [];
  for (const r of rows) {
    if (r.sec) kids.push(h('div', { class: `sec ${r.sec}` }, r.title, r.n != null ? h('span', { class: 'n' }, r.n) : '', r.hint ? h('span', { class: 'dim' }, r.hint) : ''));
    else if (r.grp) kids.push(h('div', { class: 'grp' }, r.grp));
    else if (r.sub) kids.push(h('div', { class: 'row sub' }, h('span'), h('span', { class: 'main' }, r.sub), h('span')));
    else if (r.empty) kids.push(h('div', { class: 'empty' }, r.empty));
    else if (r.log) kids.push(logView(r.events));
    else {
      const sel = r.k === S.sel[vk];
      kids.push(h('div', { class: `row${sel ? ' sel' : ''}`, 'data-k': r.k, onclick: () => select(r.k), ondblclick: () => (select(r.k), enter()) }, h('span', {}, r.cells[0]), h('span', { class: 'main' }, r.cells[1]), h('span', { class: 'side' }, r.cells[2])));
    }
  }
  const top = list.scrollTop;
  list.replaceChildren(...kids);
  list.scrollTop = top;
}

// bookkeeping the human does not need to read (change snapshots, session ids)
const LOG_HIDDEN = new Set(['task.snapshot', 'task.session', 'plan.session']);
function logView(events) {
  const cells = [];
  for (const e of events) {
    if (LOG_HIDDEN.has(e.type)) continue;
    const d = e.data || {};
    const type = e.type.replace(/^(task|plan)\./, '');
    let what = e.type === 'task.status' || e.type === 'plan.status' ? `→ ${String(d.status).replace('_', ' ')}${d.message ? `  ${d.message}` : ''}` : d.message ?? d.title ?? d.assignee ?? d.ref ?? d.summary ?? (d.percent != null ? `${d.percent}%` : '');
    if (typeof what !== 'string') what = JSON.stringify(what);
    const cls = e.type.endsWith('.status') ? `s-${d.status}` : '';
    cells.push(h('div', { class: 'dim', title: e.ts }, new Date(e.ts).toLocaleTimeString()), h('div', {}, e.actor?.id ?? ''), h('div', { class: 'dim' }, type), h('div', {}, e.task ?? ''), h('div', { class: cls, title: what }, first(what, 300)));
  }
  return h('div', { class: 'log' }, cells);
}

const selRow = () => S.rows.find((r) => r.k === S.sel[viewKey()]) ?? null;
function select(k, scroll = false) {
  if (S.sel[viewKey()] !== k) S.compose = null;
  S.sel[viewKey()] = k;
  for (const el of $('#list').querySelectorAll('.row.sel')) el.classList.remove('sel');
  const el = $('#list').querySelector(`.row[data-k="${CSS.escape(k)}"]`);
  el?.classList.add('sel');
  if (scroll) el?.scrollIntoView({ block: 'nearest' });
  renderDetail();
  $('#hint').textContent = hintFor(selRow());
}
function move(d) {
  const i = S.rows.findIndex((r) => r.k === S.sel[viewKey()]);
  const n = S.rows[Math.max(0, Math.min(S.rows.length - 1, (i < 0 ? 0 : i) + d))];
  if (n) select(n.k, true);
}
/** ⏎: a plan opens it; a task in the Overview opens it in its plan's Tasks view. */
function enter() {
  const r = selRow();
  if (!r) return;
  if (r.type === 'plan' && S.scope.level !== 'plan') return setScope({ level: 'plan', root: r.p.root, plan: r.p.id }, S.tab === 'plan' ? 'plan' : 'overview');
  if ((r.type === 'task' || r.type === 'need') && r.task && (S.tab !== 'tasks' || S.scope.level !== 'plan')) {
    setScope({ level: 'plan', root: r.p.root, plan: r.p.id }, 'tasks');
    S.sel[viewKey()] = `task#${r.p.key}#${r.task}`;
    return render();
  }
  if (r.type === 'need' && ['coordinator', 'prompt'].includes(r.it.kind)) return goAgent();
}

// ---------------------------------------------------------------- the detail panel
function briefOf(p, task) {
  const key = `${p.key}#${task ?? ''}#${p.st.last_seq}`;
  const b = S.briefs.get(key);
  if (b === undefined) {
    S.briefs.set(key, 'loading');
    api(`brief?${q({ root: p.root, plan: p.id, task })}`)
      .then((r) => {
        S.briefs.set(key, r);
        renderDetail();
      })
      .catch(() => S.briefs.delete(key));
    return null;
  }
  return b === 'loading' ? null : b;
}

const section = (name, ...kids) => [h('h3', {}, name), ...kids];
const notesList = (notes, max = 8) =>
  [...notes]
    .reverse()
    .slice(0, max)
    .map((n) => h('div', { class: 'note' }, h('span', { class: 'who' }, `${n.actor} · ${n.kind} · ${ago(n.ts)}  `), h('span', { class: `kind-${n.kind}` }, n.message)));

function renderDetail() {
  const d = $('#detail');
  const r = selRow();
  if (!r) return d.replaceChildren(h('p', { class: 'meta' }, S.ov && !allPlans().length ? 'No plans yet.' : S.tab === 'log' ? "The plan's events, newest first (change snapshots and session ids left out)." : 'Nothing selected.'));
  const kids = [];
  const p = r.p;
  if (r.type === 'plan') kids.push(...planDetail(p));
  else if (r.type === 'doc') kids.push(...docDetail(p, r.doc));
  else if (r.type === 'pnote') kids.push(h('h2', {}, `${r.note.kind} by ${r.note.actor}`), h('p', { class: 'meta' }, new Date(r.note.ts).toLocaleString()), h('pre', {}, r.note.message), actionsBar(r));
  else if (r.type === 'need' && !r.task) kids.push(...planNeedDetail(r));
  else if (r.task) kids.push(...taskDetail(r));
  if (S.compose) kids.push(composeBox());
  d.replaceChildren(...kids);
  if (S.compose) d.querySelector('textarea')?.focus();
}

function planDetail(p) {
  const st = p.st;
  if (!st) {
    if (!S.closed.has(p.key)) loadClosed(p);
    return [h('h2', {}, title(p)), h('p', { class: 'meta' }, 'loading…')];
  }
  const out = [h('h2', {}, st.title), h('p', { class: 'meta' }, `${p.project?.name ?? ''} · ${st.id} · ${st.status} · ${Math.round((st.progress || 0) * 100)}% · updated ${ago(st.updated_at)} ago`)];
  if (st.goal) out.push(...section('Goal', h('p', {}, st.goal)));
  if (st.description) out.push(...section('Description', h('pre', {}, st.description)));
  if (p.open) out.push(...section('Coordinator', h('p', {}, coordState(p)), p.attention.queued.length ? h('p', { class: 'meta' }, `waiting on it: ${p.attention.queued.map((i) => `${i.task ?? 'plan'} ${i.kind}`).join(', ')}`) : ''));
  if (st.checkpoint) out.push(...section('Where it stands', h('pre', {}, st.checkpoint.message), h('p', { class: 'meta' }, `${st.checkpoint.actor} · ${ago(st.checkpoint.ts)} ago`)));
  if (st.questions?.length) out.push(...section('Questions for you', ...st.questions.map((x) => h('p', { class: 'q' }, x.message))));
  const c = st.counts || {};
  out.push(...section('Tasks', h('p', {}, Object.entries(c).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(' · ') || 'none')));
  out.push(actionsBar({ type: 'plan', p }));
  return out;
}

function planNeedDetail(r) {
  const { it, p } = r;
  const out = [h('h2', {}, h('span', { class: `k-${it.kind}` }, NEED[it.kind]?.[0] ?? it.kind), '  ', title(p)), h('p', { class: 'meta' }, `${NEED[it.kind]?.[1] ?? ''} · ${ago(it.ts)} ago`)];
  if (it.kind === 'plan-question') out.push(h('pre', { class: 'q' }, it.message), h('p', { class: 'meta' }, `asked by ${it.actor}`));
  if (it.kind === 'coordinator' || it.kind === 'prompt') out.push(h('p', {}, `${it.actor} ${it.kind === 'prompt' ? 'is at a prompt in its terminal (an approval, a question)' : 'waits for your input'}. `, h('a', { href: '#', onclick: (e) => (e.preventDefault(), goAgent()) }, 'Open its pane (g)')));
  if (it.kind === 'no-coordinator') out.push(h('p', {}, 'Nobody decides or starts anything for this plan. Start its coordinator (it resumes its last session, or starts fresh from the plan checkpoint).'));
  if (it.kind === 'finished') out.push(h('p', {}, 'Every task is done, failed or cancelled. Close the plan when you are satisfied.'));
  out.push(actionsBar(r));
  return out;
}

function taskDetail(r) {
  const p = r.p;
  const t = p.st.tasks[r.task];
  if (!t) return [h('p', { class: 'meta' }, `${r.task} is gone`)];
  const b = briefOf(p, t.id);
  const out = [h('h2', {}, `${t.id} ${t.title}`), h('p', { class: 'meta' }, [`${planLabel(p)}`, `${STATUS_ICON[t.status]} ${t.status.replace('_', ' ')}`, t.owner ? `owner ${t.owner}` : '', t.reviewer ? `reviewer ${t.reviewer}` : '', t.percent != null && t.status === 'in_progress' ? `${t.percent}%` : '', `updated ${ago(t.updated_at)} ago`].filter(Boolean).join(' · '))];
  if (t.path.length > 1) out.push(h('p', { class: 'meta' }, t.path.map((id) => p.st.tasks[id]?.title ?? id).join(' › ')));
  if (b?.question) out.push(...section(b.question.for === S.ov.human ? 'Question for you' : 'Question', h('pre', { class: 'q' }, b.question.message ?? ''), h('p', { class: 'meta' }, `asked by ${b.question.asked_by ?? '?'} · ${ago(b.question.ts)} ago`), b.question.recommend ? h('p', {}, h('b', {}, 'Recommended: '), b.question.recommend) : '', b.question.original ? h('p', { class: 'meta' }, `originally from ${b.question.original.actor}: ${b.question.original.message}`) : ''));
  if (b?.review) out.push(...section(`Review${b.review.round > 1 ? ` (round ${b.review.round})` : ''}`, h('pre', {}, b.review.submitted?.message ?? ''), h('p', { class: 'meta' }, b.review.submitted ? `submitted by ${b.review.submitted.actor} · ${ago(b.review.submitted.ts)} ago` : ''), ...b.review.notes.map((n) => h('p', {}, h('span', { class: 'dim' }, `${n.kind}: `), n.message)), b.review.assessment ? h('p', {}, h('b', {}, 'Coordinator: '), b.review.assessment) : ''));
  if (b?.failure) out.push(...section('Failed', h('pre', {}, b.failure.message ?? '')));
  if (t.description && t.description !== t.title) out.push(...section('Description', h('pre', {}, t.description)));
  if (t.acceptance?.length) out.push(...section('Acceptance', h('ul', {}, t.acceptance.map((a) => h('li', {}, a)))));
  if (b?.latest) out.push(...section('Latest', h('pre', {}, b.latest.message)));
  if (b?.checkpoint) out.push(...section('Checkpoint', h('pre', {}, b.checkpoint.message)));
  if (t.steps?.length) out.push(...section('Steps', h('ul', {}, t.steps.map((s) => h('li', { class: `s-${s.status}` }, `${STATUS_ICON[s.status] ?? ''} ${s.title}`)))));
  if (t.waiting_on?.length) out.push(...section('Waits on', h('p', {}, t.waiting_on.map((id) => `${id} ${p.st.tasks[id]?.title ?? ''}`).join(' · '))));
  const arts = t.artifacts.filter((a) => !a.live);
  if (arts.length) out.push(...section('Artifacts', h('ul', {}, [...arts].reverse().slice(0, 10).map((a) => h('li', {}, h('span', { class: 'dim' }, `${a.kind} `), a.kind === 'url' || a.kind === 'pr' ? h('a', { href: a.ref, target: '_blank', rel: 'noopener' }, a.ref) : a.cmd ? `${first(a.cmd, 80)} → exit ${a.exit}` : a.ref, a.description ? h('span', { class: 'dim' }, ` — ${first(a.description, 100)}`) : '')))));
  if (t.notes.length) out.push(...section('Notes', ...notesList(t.notes)));
  out.push(actionsBar(r));
  return out;
}

function docDetail(p, doc) {
  const key = `${p.key}#${doc}`;
  if (!S.docs.has(key)) {
    S.docs.set(key, null);
    api(`doc?${q({ root: p.root, plan: p.id, doc })}`)
      .then((r) => {
        S.docs.set(key, r.text);
        renderDetail();
      })
      .catch((e) => S.docs.set(key, `could not read it: ${e.message}`));
  }
  return [h('h2', {}, doc), h('pre', { class: 'doc' }, S.docs.get(key) ?? 'loading…')];
}

// ---------------------------------------------------------------- actions
/** What can be done on a row: [{key, label, run, primary?, danger?}]. */
function actionsFor(r) {
  if (!r?.p) return [];
  const p = r.p;
  const st = p.st;
  const out = [];
  const t = r.task && st?.tasks[r.task];
  const human = S.ov.human;
  if (t) {
    if (t.status === 'review' && t.reviewer && t.reviewer !== 'coordinator') {
      out.push({ key: 'a', label: 'Approve', primary: true, run: () => act('approve', p, t.id) });
      out.push({ key: 'x', label: 'Request changes', run: () => compose('changes', p, t.id, `What should change in ${t.id}?`) });
    } else if (t.status === 'review') out.push({ key: 'x', label: 'Comment for the coordinator', run: () => compose('changes', p, t.id, `Your view on ${t.id}, for the coordinator`) });
    if (t.owner === human && !['done', 'failed', 'cancelled', 'review'].includes(t.status)) out.push({ key: 'a', label: 'Mark done', primary: true, run: () => compose('finish', p, t.id, `${t.id} done: anything to say (optional)?`) });
    const question = t.status === 'blocked' && !t.blocked_on.length;
    out.push({ key: question ? 'r' : 'n', label: question ? 'Answer' : 'Message', primary: question, run: () => compose('note', p, t.id, question ? `Your answer on ${t.id}` : `A message on ${t.id}, for the coordinator`) });
    const agent = agentOf(p, t.owner);
    if (agent) out.push({ key: 'g', label: `Go to ${agent.name}`, run: () => showPane(agent.handle, true, p) });
  }
  if (r.type === 'need' && (r.it.kind === 'coordinator' || r.it.kind === 'prompt')) out.push({ key: 'g', label: `Go to ${r.it.actor}`, primary: true, run: goAgent });
  if (r.type === 'need' && r.it.kind === 'plan-question') out.push({ key: 'r', label: 'Answer', primary: true, run: () => compose('plan-note', p, null, 'Your answer, for the coordinator') });
  if (p.open) {
    const c = p.coordinator;
    const running = !!c?.live;
    if (!c?.away) {
      if (!running) out.push({ key: 's', label: 'Start coordinator', primary: r.it?.kind === 'no-coordinator', run: () => coordinator(p, false) });
      else out.push({ key: 'S', label: 'Replace coordinator', run: () => coordinator(p, true) });
    }
    out.push({ key: 'N', label: 'Plan note', run: () => compose('plan-note', p, null, `A note on "${title(p)}", for the coordinator`) });
    out.push({ key: 'c', label: 'Close plan', danger: r.it?.kind !== 'finished', primary: r.it?.kind === 'finished', run: () => compose('close-plan', p, null, `Close "${title(p)}": a closing note (optional)`) });
  }
  // one action per key: the first wins
  const seen = new Set();
  return out.filter((a) => !seen.has(a.key) && seen.add(a.key));
}
function actionsBar(r) {
  const acts = actionsFor(r);
  return acts.length ? h('div', { class: 'actions' }, acts.map((a) => h('button', { class: a.primary ? 'primary' : a.danger ? 'danger' : '', onclick: a.run }, h('kbd', {}, a.key), a.label))) : '';
}
function hintFor(r) {
  const acts = actionsFor(r).map((a) => `${a.key} ${a.label.toLowerCase()}`);
  return [...acts, 'j/k move', '⏎ open', '? help'].join(' · ');
}

function compose(action, p, task, label, status) {
  S.compose = { action, p, task, label, status };
  renderDetail();
}
function composeBox() {
  const c = S.compose;
  const optional = ['finish', 'close-plan', 'approve'].includes(c.action);
  const send = () => {
    const text = $('#detail textarea').value;
    if (!optional && !text.trim()) return toast('nothing to send', true);
    act(c.action, c.p, c.task, text, c.status);
  };
  return h(
    'div',
    { class: 'compose' },
    h('label', {}, c.label),
    h('textarea', { onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), send());
      if (e.key === 'Escape') (e.preventDefault(), (S.compose = null), renderDetail(), $('#list').focus());
    } }),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: send }, h('kbd', {}, '⌃⏎'), c.action === 'close-plan' ? 'Close plan' : c.action === 'finish' ? 'Mark done' : 'Send'), h('button', { onclick: () => ((S.compose = null), renderDetail()) }, h('kbd', {}, 'esc'), 'Cancel')),
  );
}
async function act(action, p, task, message, status) {
  if (S.busy) return;
  S.busy = true;
  try {
    const r = await api('action', { root: p.root, plan: p.id, action, task, message, status });
    toast(r.message, !r.ok);
    if (r.ok) S.compose = null;
    await load();
    $('#list').focus();
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.busy = false;
  }
}
async function coordinator(p, fresh) {
  if (fresh && !confirm(`Replace the coordinator of "${title(p)}"? It writes a checkpoint first; a new session takes over.`)) return;
  toast(fresh ? 'asking the coordinator for a checkpoint, then starting a new one… (up to a few minutes)' : 'starting the coordinator…');
  try {
    const r = await api('coordinator', { root: p.root, plan: p.id, fresh });
    toast(r.ok ? (/running/.test(r.message) ? 'the coordinator is already running' : `coordinator ${fresh ? 'replaced' : 'started'}`) : r.message.split('\n').pop(), !r.ok);
    await load();
    const fresh2 = planByKey(p.key);
    const c = fresh2?.agents.find((a) => a.role === 'coordinator' && !a.exited);
    if (c) showPane(c.handle, false, fresh2);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------------- agent panes
const terms = createTerms({ host: $('#terms'), onLeave: () => $('#list').focus(), onState: () => {} });
const agentOf = (p, actor) => (actor ? (p.agents || []).find((a) => !a.exited && (a.actor === actor || a.name === actor)) : null);

/** The panes in scope: the agents of the plans in scope (a plan's coordinator always). */
function paneList() {
  const plans = scopePlans();
  const out = [];
  for (const p of plans) {
    const agents = (p.agents || []).filter((a) => !a.exited || a.role === 'coordinator');
    const coord = agents.filter((a) => a.role === 'coordinator').sort((a, b) => a.exited - b.exited)[0];
    if (S.scope.level === 'plan' && p.open) out.push(coord ? { p, a: coord } : { p, a: null, placeholder: true });
    else if (coord && !coord.exited) out.push({ p, a: coord });
    for (const a of agents.filter((a) => a.role !== 'coordinator' && !a.exited)) out.push({ p, a });
  }
  return out;
}
function renderPanes() {
  const list = paneList();
  const ids = new Set(list.filter((x) => x.a).map((x) => x.a.handle));
  if (S.pane && !ids.has(S.pane) && !(S.pane === 'placeholder' && list.some((x) => x.placeholder))) S.pane = list[0]?.a?.handle ?? (list[0]?.placeholder ? 'placeholder' : null);
  if (!S.pane && list.length) S.pane = list[0].a?.handle ?? 'placeholder';
  terms.keep(ids);
  const multi = S.scope.level !== 'plan';
  const tabs = list.map((x) =>
    x.a
      ? h('div', { class: `tab${S.pane === x.a.handle ? ' on' : ''}`, title: `${x.a.kind ?? ''} · ${x.a.status}${multi ? ` · ${planLabel(x.p)}` : ''}`, onclick: () => showPane(x.a.handle, true, x.p) }, h('span', { class: `dot ${x.a.exited ? 'exited' : x.a.status}` }), x.a.name, h('span', { class: 'task' }, x.a.task ?? (x.a.role === 'coordinator' ? (x.a.exited ? 'ended' : 'coordinator') : '')))
      : h('div', { class: `tab${S.pane === 'placeholder' ? ' on' : ''}`, onclick: () => showPane('placeholder') }, h('span', { class: 'dot' }), 'coordinator', h('span', { class: 'task' }, 'not running')),
  );
  tabs.push(h('span', { class: 'gap' }), h('button', { class: 'ctl', title: 'terminals full screen (f)', onclick: () => togglePanes('full') }, '⤢'), h('button', { class: 'ctl', title: 'hide terminals (t)', onclick: () => togglePanes('hide') }, '▁'));
  $('#ptabs').replaceChildren(...tabs);
  const ph = $('#terms .placeholder');
  const sp = scopePlan();
  const placeholder = S.pane === 'placeholder' || !list.length;
  if (placeholder) {
    const el = ph || h('div', { class: 'placeholder' });
    const exitedCoord = sp?.agents.find((a) => a.role === 'coordinator' && a.exited);
    el.replaceChildren(
      ...(sp?.open
        ? [h('div', {}, sp.coordinator?.away ? `${sp.coordinator.id} runs elsewhere (herdr, another machine).` : exitedCoord ? `The coordinator's session ended (exit ${exitedCoord.code}).` : 'No coordinator runs for this plan.'), sp.coordinator?.away ? '' : h('div', {}, h('button', { class: 'btn', onclick: () => coordinator(sp, false) }, 'Start coordinator (s)'))]
        : [h('div', {}, list.length ? '' : S.scope.level === 'plan' ? 'This plan is closed.' : 'No agents run in this scope. Open a plan to start its coordinator.')]),
    );
    if (!ph) $('#terms').append(el);
    el.style.display = '';
    terms.show(null);
  } else {
    if (ph) ph.style.display = 'none';
    terms.show(S.pane);
  }
}
function showPane(handle, focus = false, p = null) {
  if ($('#main').classList.contains('no-panes')) togglePanes('hide');
  if (p && S.scope.level === 'plan' && p.key !== `${S.scope.root}#${S.scope.plan}`) setScope({ level: 'plan', root: p.root, plan: p.id });
  else if (p && S.scope.level === 'project' && p.root !== S.scope.root) setScope({ level: 'plan', root: p.root, plan: p.id });
  S.pane = handle;
  store.set('pane', handle);
  renderPanes();
  if (focus && handle !== 'placeholder') terms.show(handle, { focus: true });
}
function goAgent() {
  const r = selRow();
  if (!r?.p) return;
  const handle = r.it?.pane || agentOf(r.p, r.task ? r.p.st.tasks[r.task]?.owner : r.it?.actor)?.handle;
  if (handle) showPane(handle, true, r.p);
  else toast('no agent of this runs here', true);
}
function togglePanes(mode) {
  const m = $('#main');
  if (mode === 'full') m.classList.remove('no-panes'), m.classList.toggle('full-panes');
  else m.classList.remove('full-panes'), m.classList.toggle('no-panes');
  store.set('panes-mode', m.classList.contains('full-panes') ? 'full' : m.classList.contains('no-panes') ? 'hide' : '');
  requestAnimationFrame(() => terms.refit());
}
// drag the split; double-click: terminals full screen
(() => {
  const split = $('#split');
  const main = $('#main');
  const saved = store.get('panes-size', null);
  if (saved) main.style.setProperty('--panes', saved);
  const mode = store.get('panes-mode', '');
  if (mode === 'full') main.classList.add('full-panes');
  if (mode === 'hide') main.classList.add('no-panes');
  split.addEventListener('dblclick', () => togglePanes('full'));
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const box = main.getBoundingClientRect();
      const px = Math.max(80, Math.min(box.height - 120, box.bottom - ev.clientY));
      main.style.setProperty('--panes', `${px}px`);
    };
    const up = () => {
      split.removeEventListener('pointermove', move);
      store.set('panes-size', main.style.getPropertyValue('--panes'));
      terms.refit();
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up, { once: true });
  });
})();

// ---------------------------------------------------------------- keys
const HELP = [
  ['0 1 2 3', 'Overview · Tasks · Plan · Log'],
  ['j k ↑ ↓', 'move'],
  ['⏎', 'open: a plan, a task in its plan'],
  ['esc', 'up a level (plan › project › all), or cancel'],
  ['a', 'approve a review · mark your task done'],
  ['x', 'request changes'],
  ['r', 'answer a question'],
  ['n', 'a message on the task'],
  ['N', 'a note on the plan'],
  ['s', 'start the coordinator'],
  ['S', 'replace the coordinator (after a checkpoint)'],
  ['c', 'close the plan'],
  ['g', 'go to the agent'],
  ['t · f', 'hide the terminals · terminals full screen'],
  ['ctrl+]', 'leave a terminal (back to the board)'],
  ['ctrl+⏎', 'send what you wrote'],
];
function help() {
  const d = $('#help');
  d.replaceChildren(h('h3', {}, 'Keys'), h('table', {}, HELP.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))), h('p', { class: 'dim' }, 'Agents keep running when you close this page.'), h('form', { method: 'dialog' }, h('button', { class: 'btn' }, 'Close')));
  d.showModal();
}
document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || e.target.closest?.('.xterm') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  const r = selRow();
  const byKey = actionsFor(r).find((a) => a.key === k);
  if (/^[0-3]$/.test(k)) return setTab(TABS[Number(k)][0]);
  if (k === 'j' || k === 'ArrowDown') return e.preventDefault(), move(1);
  if (k === 'k' || k === 'ArrowUp') return e.preventDefault(), move(-1);
  if (k === 'Enter') return enter();
  if (k === 'Escape') {
    if (S.compose) return (S.compose = null), renderDetail();
    const sc = S.scope;
    if (sc.level === 'plan') return setScope({ level: 'project', root: sc.root });
    if (sc.level === 'project') return setScope({ level: 'all' });
    return;
  }
  if (k === '?') return help();
  if (k === 't') return togglePanes('hide');
  if (k === 'f') return togglePanes('full');
  if (byKey) return e.preventDefault(), byKey.run();
});
$('.brand').onclick = () => setScope({ level: 'all' });
// typing into a terminal: say so, and how to get back
$('#terms').addEventListener('focusin', () => {
  const x = paneList().find((y) => y.a?.handle === S.pane);
  $('#hint').textContent = `typing into ${x?.a?.name ?? 'the terminal'} · ctrl+] back to the board`;
  $('#hint').classList.add('typing');
});
$('#terms').addEventListener('focusout', () => {
  $('#hint').classList.remove('typing');
  $('#hint').textContent = hintFor(selRow());
});

// ---------------------------------------------------------------- start
setInterval(() => S.ov && (renderList(), renderTree()), 15_000); // relative times
// xterm measures the cell size when a terminal opens: load the font first
Promise.all([document.fonts.load("13px 'JetBrains Mono'"), document.fonts.load("bold 13px 'JetBrains Mono'")])
  .catch(() => {})
  .finally(() => {
    terms.connect();
    stream();
    load();
    $('#list').focus();
  });
