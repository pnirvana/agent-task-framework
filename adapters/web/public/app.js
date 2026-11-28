// ATF web UI (docs/webui-design.md §4.5): a cockpit for agent work, every open plan at
// once. Needs you (what waits for you, your tasks) · In flight (per plan: where it
// stands, its coordinator, each task being worked on with its steps and its live run) ·
// the inspector over In flight for details (a task, a plan, a run, a file, a diff) · the
// coordinators' and agents' terminals across the bottom. Everything is grouped by plan:
// task ids are per plan. Plain ES modules, no build step.
//
// Data: /api/overview (projects, open plans with their state, what needs you, live
// glances, health, agents), loaded again when /api/stream says something changed. Writes:
// /api/action as the human, /api/coordinator.
import { $, h, ago, first, store, toast, api, q, menu, closeMenu } from './util.js';
import { createTerms } from './terms.js';
import { createDrawer } from './drawer.js';
import { initPages, renderTab, compose, STATUS_ICON, runGlyph, runClass } from './pages.js';

// ---------------------------------------------------------------- what the board says
const NEED = {
  prompt: ['!', 'waits at a prompt in its terminal'],
  approval: ['⧖', 'a command waits for your approval'],
  orphan: ['⚠', 'no agent runs it'],
  'no-coordinator': ['⚠', 'no coordinator runs this plan'],
  coordinator: ['?', 'the coordinator waits for you'],
  'your-review': ['◎', 'for you to review'],
  question: ['⊘', 'a question for you'],
  'plan-question': ['?', 'a question about the plan'],
  failed: ['✗', 'failed'],
  review: ['◎', 'for the coordinator to review'],
  stale: ['◌', 'its agent is idle, the task still in progress'],
  finished: ['●', 'all tasks finished: close the plan'],
  'your-task': ['☐', 'your task'],
};
const RANK = Object.fromEntries(Object.keys(NEED).map((k, i) => [k, i]));
const QUEUED = { review: 'waits for the coordinator’s review', question: 'a question for the coordinator', failed: 'failed: for the coordinator', stale: 'its agent idles', 'plan-question': 'a question for the coordinator' };
const STEP = { done: '✓', in_progress: '▶', failed: '✗', skipped: '–', todo: '○' };

// ---------------------------------------------------------------- state
const S = {
  ov: null,
  closed: new Map(), // key -> planView of a closed plan
  briefs: new Map(),
  changes: new Map(),
  liveLists: new Map(),
  tasks: new Map(), // tasks in full, for their pages (see taskFull)
  logs: new Map(),
  plansFolded: new Set(store.get('plansFolded', [])),
  closedOpen: false,
  pane: store.get('pane', null), // the terminal shown: a session, `ph#<plan>` (no coordinator) or null
  compose: null, // the inline composer in Needs you: {nkey, action, p, task, label, button, optional}
  drafts: new Map(),
  busy: false,
};
const projects = () => S.ov?.projects ?? [];
const allPlans = () => projects().flatMap((pr) => pr.plans.map((p) => ({ ...p, project: pr })));
const openPlans = () => allPlans().filter((p) => p.open);
function planByKey(key) {
  const p = allPlans().find((x) => x.key === key);
  if (p && !p.open && S.closed.has(key)) return { ...S.closed.get(key), project: p.project };
  return p ?? null;
}
const planTitle = (p) => p?.st?.title ?? p?.summary?.title ?? p?.id ?? '';
async function loadClosed(p) {
  if (S.closed.has(p.key) || S.closed.has(`loading#${p.key}`)) return;
  S.closed.set(`loading#${p.key}`, true);
  try {
    S.closed.set(p.key, await api(`plan?${q({ root: p.root, plan: p.id })}`));
    drawer.refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.closed.delete(`loading#${p.key}`);
  }
}

/** A plan's colour: a second hint beside its name (muted, from a few in rotation). */
const COLOURS = ['blue', 'mauve', 'teal', 'peach', 'flamingo', 'sapphire', 'green', 'yellow'];
function colourOf(p) {
  let x = 0;
  for (const ch of p.key) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return `color-mix(in srgb, var(--${COLOURS[x % COLOURS.length]}) 70%, transparent)`;
}

/** The open plans in the cockpit's order: those that need you, then those at work, then the quiet ones. */
function planOrder() {
  const rank = (p) => (p.attention.mine.length ? 0 : currentWork(p.st).length ? 1 : 2);
  return openPlans().sort((a, b) => rank(a) - rank(b) || planTitle(a).localeCompare(planTitle(b)));
}

/** A subtask's parents, outermost first: its id alone says little, its parents' titles do. */
const parentsOf = (p, t) => (t?.path || []).map((id) => p.st.tasks[id]).filter(Boolean); // path: its ancestors
const parentPath = (p, t) => {
  const ps = parentsOf(p, t);
  return ps.length ? h('span', { class: 'path', title: ps.map((x) => `${x.id} ${x.title}`).join(' › ') }, ps.map((x) => `${x.title} › `)) : '';
};

// ---------------------------------------------------------------- cached reads
const refreshIf = (f) => drawer.refresh(f);
/**
 * Data of a plan's version (`last_seq`) fetched from the server, one entry per `base`: while
 * a newer version loads, the last one stays shown (no section disappearing for a moment
 * each time the plan changes). null until the first answer.
 */
function versioned(map, base, seq, url, onLoaded, onError = () => {}) {
  const e = map.get(base) ?? {};
  if (e.seq !== seq && e.loading !== seq) {
    map.set(base, { ...e, loading: seq });
    api(url)
      .then((r) => {
        const cur = map.get(base) ?? {};
        if (cur.seq == null || cur.seq <= seq) map.set(base, { ...cur, seq, value: r, loading: cur.loading === seq ? null : cur.loading });
        onLoaded();
      })
      .catch((err) => {
        const cur = map.get(base) ?? {};
        map.set(base, { ...cur, loading: cur.loading === seq ? null : cur.loading, seq: cur.seq ?? null });
        onError(err);
      });
  }
  return e.value ?? null;
}
function briefOf(p, task) {
  return versioned(S.briefs, `${p.key}#${task ?? ''}`, p.st.last_seq, `brief?${q({ root: p.root, plan: p.id, task })}`, () => refreshIf((v) => v.pk === p.key && v.task === task));
}
/**
 * A task with its long parts (history, notes, artifacts, the whole description), for its
 * page: the overview carries only what the panels show. The current state stays the
 * overview's (newer); until the full one arrives, the overview's alone.
 */
function taskFull(p, id) {
  const lite = p.st.tasks[id];
  if (!lite) return null;
  const full = versioned(S.tasks, `${p.key}#${id}`, p.st.last_seq, `task?${q({ root: p.root, plan: p.id, task: id })}`, () => refreshIf((v) => v.pk === p.key && v.task === id));
  return full ? { ...full, ...lite, description: full.description } : lite;
}
function changesOf(p) {
  return versioned(S.changes, p.key, p.st.last_seq, `changes?${q({ root: p.root, plan: p.id })}`, () => refreshIf((v) => v.pk === p.key), (e) => toast(e.message, true));
}
function liveListOf(p, task) {
  const key = `${p.key}#${task}`;
  const c = S.liveLists.get(key);
  const t = p.st.tasks[task];
  const worth = t && !t.children.length && (t.status !== 'todo' || (t.artifacts_total ?? t.artifacts?.length ?? 0));
  if (worth && (!c || (Date.now() - c.at > 4000 && !c.loading))) {
    S.liveLists.set(key, { runs: [], ...(c || {}), loading: true, at: c?.at ?? 0 });
    api(`live?${q({ root: p.root, plan: p.id, task })}`)
      .then((r) => (S.liveLists.set(key, { ...r, at: Date.now() }), refreshIf((v) => v.pk === p.key && v.task === task && v.kind === 'task')))
      .catch(() => S.liveLists.set(key, { runs: [], ...(S.liveLists.get(key) || {}), loading: false, at: Date.now() }));
  }
  return c;
}

// ---------------------------------------------------------------- loading, live updates
let loading = null;
let again = false;
/** A load that starts after now (one in flight may predate what just changed). */
async function freshLoad() {
  await (loading ?? Promise.resolve()).catch(() => {});
  await load();
}
/**
 * Load the overview. `plans`: the keys of the plans that changed (from the stream): only
 * those come again, the others are kept. Without it (start, sessions changed, every half
 * minute: what depends on time), all of them.
 */
let pending = { all: false, plans: new Set() };
async function load(plans = null) {
  if (plans) plans.forEach((k) => pending.plans.add(k));
  else pending.all = true;
  if (loading) return (again = true), loading;
  loading = (async () => {
    try {
      const want = pending;
      pending = { all: false, plans: new Set() };
      const partial = S.ov && !want.all;
      const prev = new Map(allPlans().map((p) => [p.key, p]));
      // each plan with the version the page has: the server sends the tasks changed since
      const only = [...want.plans].map((k) => (prev.get(k)?.st ? `${k}\t${prev.get(k).st.last_seq}` : k)).join('\n') || '\n';
      const ov = await api(partial ? `overview?${q({ only })}` : 'overview');
      let missing = false;
      for (const pr of ov.projects)
        pr.plans = pr.plans.map((p) => {
          if (p.same) return prev.get(p.key) ?? ((missing = true), p);
          if (p.delta == null) return p;
          // the changed tasks, onto the version the page has
          const old = prev.get(p.key);
          if (!old?.st || old.st.last_seq !== p.delta) return (missing = true), old ?? p;
          const tasks = { ...old.st.tasks, ...p.st.tasks };
          for (const tid of p.removed) delete tasks[tid];
          return { ...p, st: { ...p.st, tasks } };
        });
      if (missing) (pending.all = true), (again = true); // a plan the page lacked or had another version of
      S.ov = ov;
      const v = drawer.current();
      const p = v && allPlans().find((x) => x.key === v.pk);
      if (p && !p.open) S.closed.delete(p.key), loadClosed(p);
      render();
    } catch (e) {
      toast(`could not load: ${e.message}`, true);
    } finally {
      loading = null;
      if (again) (again = false), load(pending.all ? null : [...pending.plans]);
    }
  })();
  return loading;
}
setInterval(() => load(), 30_000); // what depends on time (ages, an orphan after 10 minutes)
function stream() {
  const es = new EventSource('/api/stream');
  let t = null;
  let acc = { all: false, plans: new Set() };
  es.onmessage = (e) => {
    let m = {};
    try {
      m = JSON.parse(e.data);
    } catch {}
    if (m.sessions || !Array.isArray(m.plans)) acc.all = true;
    else m.plans.forEach((k) => acc.plans.add(k));
    clearTimeout(t);
    t = setTimeout(() => {
      const a = acc;
      acc = { all: false, plans: new Set() };
      load(a.all ? null : [...a.plans]);
    }, 150);
  };
  es.onopen = () => ($('#conn').classList.add('up'), load());
  es.onerror = () => $('#conn').classList.remove('up');
}

// ---------------------------------------------------------------- the inspector
const taskKinds = (v) => ['task', 'live'].includes(v.kind) || (v.kind === 'diff' && v.task && !v.file);
const planKinds = (v) => ['plan', 'planlog', 'planchanges'].includes(v.kind) || (v.kind === 'diff' && !v.task && !v.file);
const openTask = (p, task) => drawer.open({ key: `task#${p.key}#${task}`, kind: 'task', pk: p.key, task }, { replace: taskKinds(drawer.current() ?? {}) && drawer.current()?.task === task });
const openPlan = (p, kind = 'plan') => drawer.open({ key: `${kind}#${p.key}`, kind, pk: p.key }, { replace: planKinds(drawer.current() ?? {}) && drawer.current()?.pk === p.key });
const openLive = (p, task, ref = null) => {
  const cur = drawer.current();
  const v = drawer.open({ key: `live#${p.key}#${task}`, kind: 'live', pk: p.key, task, ...(ref ? { ref } : {}) }, { replace: !!cur && taskKinds(cur) && cur.task === task && cur.pk === p.key });
  if (ref && v.ref !== ref) (v.ref = ref), (v.rt.item = null), drawer.refresh();
  return v;
};
const openFile = (p, path) => drawer.open({ key: `file#${p.root}#${path}`, kind: 'file', pk: p.key, path });
const openDiff = (p, task, file) => {
  const cur = drawer.current();
  const tabbed = !file && cur && cur.pk === p.key && (task ? taskKinds(cur) && cur.task === task : planKinds(cur));
  return drawer.open({ key: `diff#${p.key}#${task ?? ''}#${file ?? ''}`, kind: 'diff', pk: p.key, task: task ?? null, file: file ?? null }, { replace: !!tabbed });
};

/** The inspector's head for a view: where it is (plan › task) and its tabs. */
function headOf(v) {
  const p = planByKey(v.pk);
  const crumbs = [{ label: planTitle(p) || 'plan', run: v.kind === 'plan' ? null : () => openPlan(p), tip: `the plan ${planTitle(p)}${p?.project?.name ? ` · ${p.project.name}` : ''}`, cls: 'pchip' }];
  const t = v.task ? p?.st?.tasks[v.task] : null;
  if (t) for (const x of parentsOf(p, t)) crumbs.push({ label: `${x.id} ${x.title}`, run: () => openTask(p, x.id) });
  if (v.task) crumbs.push({ label: `${v.task} ${t?.title ?? ''}`, run: v.kind === 'task' ? null : () => openTask(p, v.task) });
  if (v.kind === 'need') crumbs.push({ label: NEED_TITLE[v.snap?.kind] ?? 'Needs you' });
  if (v.kind === 'file') crumbs.push({ label: v.path });
  if (v.kind === 'diff' && v.file) crumbs.push({ label: v.file });
  if (crumbs.length > 1) crumbs[crumbs.length - 1].run = null;
  let tabs = [];
  if (v.kind === 'need')
    tabs = [
      { label: 'This item', on: true, run: () => {} },
      ...(t ? [{ label: 'Task', run: () => openTask(p, t.id) }, ...(!t.children.length ? [{ label: 'Live', run: () => openLive(p, t.id) }] : []), { label: 'Changes', run: () => openDiff(p, t.id) }] : p?.st ? [{ label: 'Plan', run: () => openPlan(p) }] : []),
    ];
  else if (p?.st && taskKinds(v))
    tabs = [
      { label: 'Overview', on: v.kind === 'task', run: () => openTask(p, v.task) },
      ...(t && !t.children.length ? [{ label: 'Live', on: v.kind === 'live', run: () => openLive(p, v.task) }] : []),
      { label: 'Changes', on: v.kind === 'diff', run: () => openDiff(p, v.task) },
    ];
  else if (p?.st && planKinds(v))
    tabs = [
      { label: 'Overview', on: v.kind === 'plan', run: () => openPlan(p, 'plan') },
      { label: 'Log', on: v.kind === 'planlog', run: () => openPlan(p, 'planlog') },
      { label: 'Changes', on: v.kind === 'planchanges', run: () => openPlan(p, 'planchanges') },
      { label: 'Diff', on: v.kind === 'diff', run: () => openDiff(p, null) },
    ];
  const agent = p && t ? agentOf(p, t.owner) : null;
  const tools = agent ? [h('button', { class: 'btn', title: 'its agent’s terminal (g)', onclick: () => showTerminal(agent.handle, true) }, h('span', { class: `dot ${agent.status}` }), ` ${agent.name}`)] : [];
  let status = null;
  if (t) {
    const so = statusOf(p, t);
    status = h('span', { class: `dstat st-${so.cls}`, title: so.text }, h('span', { class: `adot ${so.cls}` }), so.text);
  }
  return { crumbs, tabs, tools, status, colour: p ? colourOf(p) : null };
}
function renderView(v, el) {
  const p = planByKey(v.pk);
  if (v.kind === 'need') return needPage(v, el);
  if ((v.kind === 'planlog' || v.kind === 'planchanges') && p?.st) {
    el.replaceChildren(h('div', { class: 'list' }, v.kind === 'planlog' ? logList(p) : changesList(p)));
    return;
  }
  renderTab(v, el);
}
const drawer = createDrawer({ host: $('#drawer'), render: renderView, head: headOf, onChange: () => markOpen() });
const refreshTab = (v) => drawer.refresh((x) => x.key === v.key);

// ---------------------------------------------------------------- actions
const agentOf = (p, actor) => (actor ? (p.agents || []).find((a) => !a.exited && (a.actor === actor || a.name === actor)) : null);
const coordAgentOf = (p) => (p.agents || []).find((a) => a.role === 'coordinator' && !a.exited);
async function act(action, p, task, message, status) {
  if (S.busy) return false;
  S.busy = true;
  try {
    const r = await api('action', { root: p.root, plan: p.id, action, task, message, status });
    toast(r.message, !r.ok);
    await load();
    return r.ok;
  } catch (e) {
    toast(e.message, true);
    return false;
  } finally {
    S.busy = false;
  }
}
async function coordinator(p, fresh) {
  if (fresh && !confirm(`Replace the coordinator of "${planTitle(p)}"? It writes a checkpoint first; a new session takes over.`)) return;
  toast(fresh ? 'asking the coordinator for a checkpoint, then starting a new one… (up to a few minutes)' : 'starting the coordinator…');
  try {
    const r = await api('coordinator', { root: p.root, plan: p.id, fresh });
    toast(r.ok ? (/running/.test(r.message) ? 'the coordinator is already running' : `coordinator ${fresh ? 'replaced' : 'started'}`) : r.message.split('\n').pop(), !r.ok);
    await load();
    const np = planByKey(p.key);
    const c = np && coordAgentOf(np);
    if (c) showTerminal(c.handle, false);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * What can be done on a task or a plan: [{key, label, run, primary?, danger?, tip?}]. The
 * inspector shows them as buttons; their keys work while it shows the task or plan.
 */
function actionsFor({ p, task, tab }) {
  const st = p.st;
  const out = [];
  const human = S.ov.human;
  const page = tab ?? drawer.current();
  const c = (action, label, extra) => () => page && compose(page, action, p, task ?? null, label, extra);
  if (task) {
    const t = st.tasks[task];
    if (!t) return [];
    if (t.status === 'review' && t.reviewer && t.reviewer !== 'coordinator') {
      out.push({ key: 'a', label: 'Approve', primary: true, run: () => act('approve', p, t.id) });
      out.push({ key: 'x', label: 'Request changes', run: c('changes', `What should change in ${t.id}?`, { button: 'Send change request' }) });
    } else if (t.status === 'review') out.push({ key: 'x', label: 'Comment for the coordinator', run: c('changes', `Your view on ${t.id}, for the coordinator`) });
    if (t.owner === human && !['done', 'failed', 'cancelled', 'review'].includes(t.status)) out.push({ key: 'a', label: 'Mark done', primary: true, run: c('finish', `${t.id} done: anything to say? (optional)`, { button: 'Mark done' }) });
    const question = t.status === 'blocked' && !t.blocked_on.length;
    out.push({ key: question ? 'r' : 'n', label: question ? 'Answer' : 'Message', primary: question, run: c('note', question ? `Your answer on ${t.id}` : `A message on ${t.id}, for the coordinator`, { button: question ? 'Send answer' : 'Send' }) });
    const agent = agentOf(p, t.owner);
    if (agent) out.push({ key: 'g', label: `Terminal: ${agent.name}`, run: () => showTerminal(agent.handle, true) });
    return dedupe(out);
  }
  if (p.open) {
    const co = p.coordinator;
    const agent = coordAgentOf(p);
    if (!co?.away) {
      if (!co?.live) out.push({ key: 's', label: 'Start coordinator', primary: !!p.attention?.mine.some((i) => i.kind === 'no-coordinator'), run: () => coordinator(p, false), tip: 'resumes its last session, or starts fresh from the plan checkpoint' });
      else out.push({ key: 'S', label: 'Replace coordinator', run: () => coordinator(p, true), tip: 'it writes a checkpoint, then a new session takes over' });
    }
    if (agent) out.push({ key: 'g', label: 'Coordinator terminal', run: () => showTerminal(agent.handle, true) });
    out.push({ key: 'N', label: 'Note for the coordinator', run: c('plan-note', `A note on "${planTitle(p)}", for the coordinator`) });
    const finished = !!p.attention?.mine.some((i) => i.kind === 'finished');
    out.push({ key: 'c', label: 'Close plan', primary: finished, danger: !finished, run: c('close-plan', `Close "${planTitle(p)}": a closing note (optional)`, { button: 'Close plan' }) });
  }
  return dedupe(out);
}
const dedupe = (list) => {
  const seen = new Set();
  return list.filter((a) => !seen.has(a.key) && seen.add(a.key));
};

// ---------------------------------------------------------------- terminals
const terms = createTerms({
  onLeave: () => document.activeElement?.blur(),
  onFocus: (id) => {
    if (!id) return;
    const a = allAgents().find((x) => x.handle === id);
    toast(`typing into ${a?.name ?? 'the terminal'} · ctrl+] back to the page`);
  },
});
const allAgents = () => openPlans().flatMap((p) => (p.agents || []).map((a) => ({ ...a, p })));
const agentStatus = (handle) => allAgents().find((a) => a.handle === handle)?.status ?? 'off';
const sessionExists = (handle) => allAgents().some((a) => a.handle === handle && !a.exited);

/** The terminals, per plan (in the cockpit's order): its coordinator first (or a placeholder), then its agents. */
/**
 * The terminals, per plan: its coordinator (or a placeholder), its agents, the shells opened
 * in its project; then the shells of no plan. A shell is an item {id, a, sh}: `a` the
 * agent-like part the panel draws (name, status), `sh` the shell.
 */
const shells = () => S.ov?.shells ?? [];
const shellItem = (sh) => ({ id: sh.id, sh, a: { name: sh.name, handle: sh.id, status: sh.status, since: sh.since, exited: sh.exited, kind: 'shell' } });
/** A shell's state in words: the command running in it, or at its prompt. */
const shellState = (sh) => (sh.exited ? `exited${sh.code != null ? ` (${sh.code})` : ''}` : sh.fg ? `running ${sh.fg} · ${ago(sh.since)}` : `at its prompt · ${ago(sh.since)}`);
function termGroups() {
  const groups = planOrder().map((p) => {
    const agents = (p.agents || []).filter((a) => !a.exited);
    const coord = agents.find((a) => a.role === 'coordinator');
    const items = [coord ? { id: coord.handle, a: coord } : { id: `ph#${p.key}`, a: null }];
    for (const a of agents.filter((x) => x.role !== 'coordinator')) items.push({ id: a.handle, a });
    for (const sh of shells().filter((x) => x.pk === p.key)) items.push(shellItem(sh));
    return { p, items };
  });
  const keys = new Set(groups.map((g) => g.p.key));
  const own = shells().filter((x) => !x.pk || !keys.has(x.pk));
  groups.push({ p: null, items: own.map(shellItem) });
  return groups;
}
/** What a terminal is, in words: the coordinator, the task its agent works on, or a shell and its folder. */
const termLabel = (x, p) => (x.sh ? `${x.sh.name[0].toUpperCase()}${x.sh.name.slice(1)} · ${p ? x.sh.cwd.split('/').pop() : shortPath(x.sh.cwd)}` : !x.a || x.a.role === 'coordinator' ? 'Coordinator' : x.a.task ? `${x.a.task} ${p.st.tasks[x.a.task]?.title ?? ''}` : x.a.name);
/** A new shell on this machine: in the plan's project folder, or home. */
async function newShell(p = null) {
  const r = await api('shell', p ? { root: p.root, plan: p.id } : {}).catch((e) => ({ ok: false, message: e.message }));
  if (!r.ok) return toast(r.message || 'could not open a shell', true);
  await freshLoad();
  showTerminal(r.id, true);
}
async function closeShell(sh) {
  if (!sh.exited && !confirm(`End ${sh.name} (${shortPath(sh.cwd)})? What runs in it stops.`)) return;
  const r = await api('shell/close', { id: sh.id }).catch((e) => ({ ok: false, message: e.message }));
  if (!r.ok) return toast(r.message || 'could not end the shell', true);
  await freshLoad();
}
/**
 * The terminal panel: the terminal shown, under a title saying whose it is (plan ›
 * coordinator or task · agent); beside it the list of all terminals, per plan.
 */
function renderTerminals() {
  const groups = termGroups();
  const items = groups.flatMap((g) => g.items.map((x) => ({ ...x, p: g.p })));
  terms.keep(new Set([...allAgents().filter((a) => !a.exited).map((a) => a.handle), ...shells().map((x) => x.id)]));
  if (!items.some((x) => x.id === S.pane)) S.pane = (items.find((x) => x.a) || items[0])?.id ?? null;
  store.set('pane', S.pane);
  const plus = (title, run) => h('button', { class: 'icon tl-add', title, onclick: (e) => (e.stopPropagation(), run()) }, '+');
  $('#term-list').replaceChildren(
    ...groups.map((g) =>
      h(
        'div',
        { class: `tl-grp${g.p ? '' : ' shells'}`, style: g.p ? `--pc:${colourOf(g.p)}` : '' },
        g.p
          ? h('div', { class: 'tl-h', title: `${planTitle(g.p)} · ${g.p.project.name} · open the plan`, onclick: () => openPlan(g.p) }, h('span', { class: 'mk' }), h('span', { class: 'pname' }, planTitle(g.p)), plus(`a new shell in ${shortPath(g.p.project.dir)}`, () => newShell(g.p)))
          : h('div', { class: 'tl-h', title: 'shells of no plan' }, h('span', { class: 'pname' }, 'Shells'), plus('a new shell in your home folder (ctrl+shift+`)', () => newShell())),
        g.items.map((x) =>
          h(
            'div',
            { class: `tl-item${x.id === S.pane ? ' on' : ''}${x.a ? '' : ' off'}${x.sh ? ' sh' : ''}`, title: x.sh ? `${x.sh.name} · ${x.sh.cwd} · ${shellState(x.sh)}` : x.a ? `${x.a.name} · ${x.a.kind ?? ''} · ${x.a.status} ${ago(x.a.since)}` : 'no coordinator runs this plan', onclick: () => showTerminal(x.id, !!x.a && !x.a.exited) },
            h('span', { class: `dot ${x.a?.status ?? 'off'}` }),
            h('span', { class: 'l' }, termLabel(x, g.p)),
            x.sh ? h('span', { class: 'who' }, x.sh.fg ? h('span', { class: 'fg' }, x.sh.fg) : '', h('button', { class: 'icon tl-x', title: x.sh.exited ? 'remove it' : 'end this shell', onclick: (e) => (e.stopPropagation(), closeShell(x.sh)) }, '×')) : h('span', { class: 'who' }, x.a ? x.a.name : g.p.coordinator?.away ? 'elsewhere' : 'not running'),
          ),
        ),
        !g.p && !g.items.length ? h('div', { class: 'tl-empty' }, h('a', { onclick: () => newShell() }, '+ new shell'), ' in your home folder') : '',
      ),
    ),
  );
  const x = items.find((y) => y.id === S.pane);
  const head = $('#term-title');
  const body = $('#tbody');
  let ph = body.querySelector(':scope > .placeholder');
  const sep = () => h('span', { class: 'sep' }, '›');
  if (!x || !x.a) {
    terms.clear(body);
    const p = x?.p;
    setTermPlan(p);
    head.replaceChildren(...(p ? [h('span', { class: 'pchip click', title: `the plan ${planTitle(p)} · ${p.project?.name ?? ''} · open it`, onclick: () => openPlan(p) }, planTitle(p)), sep(), h('b', {}, 'Coordinator'), h('span', { class: 'dim' }, '  not running')] : ['No terminal']));
    if (!ph) body.append((ph = h('div', { class: 'placeholder' })));
    const exited = p?.agents?.find((a) => a.role === 'coordinator' && a.exited);
    ph.replaceChildren(
      ...(p
        ? [h('div', {}, p.coordinator?.away ? `${p.coordinator.id} runs elsewhere (herdr, another machine).` : exited ? `The coordinator’s session ended (exit ${exited.code}).` : 'No coordinator runs for this plan.'), p.coordinator?.away ? '' : h('div', {}, h('button', { class: 'btn primary', onclick: () => coordinator(p, false) }, 'Start coordinator'))]
        : [h('div', {}, 'No agents run. Start a plan’s coordinator from In flight.')]),
    );
    ph.style.display = '';
    return;
  }
  if (ph) ph.style.display = 'none';
  setTermPlan(x.p);
  if (x.sh) {
    head.replaceChildren(
      ...(x.p ? [h('span', { class: 'pchip click', title: `the plan ${planTitle(x.p)} · ${x.p.project?.name ?? ''} · open it`, onclick: () => openPlan(x.p) }, planTitle(x.p)), sep()] : []),
      h('b', {}, 'Shell'),
      h('span', { class: 'mono path', title: x.sh.cwd }, `  ${shortPath(x.sh.cwd)}`),
      h('span', { class: 'dim' }, `   ${x.sh.name} · `),
      h('span', { class: `dot ${x.sh.status}` }),
      h('span', { class: 'dim' }, ` ${shellState(x.sh)}`),
    );
    return terms.place(x.id, body);
  }
  head.replaceChildren(
    h('span', { class: 'pchip click', title: `the plan ${planTitle(x.p)} · ${x.p.project?.name ?? ''} · open it`, onclick: () => openPlan(x.p) }, planTitle(x.p)),
    sep(),
    x.a.task ? h('b', { class: 'click', title: 'open the task', onclick: () => openTask(x.p, x.a.task) }, termLabel(x, x.p)) : h('b', {}, termLabel(x, x.p)),
    h('span', { class: 'dim' }, `   ${x.a.name}${x.a.kind ? ` · ${x.a.kind}` : ''} · `),
    h('span', { class: `dot ${x.a.status}` }),
    h('span', { class: 'dim' }, ` ${x.a.status} ${ago(x.a.since)}`),
  );
  terms.place(x.id, body);
}
/** The plan of the terminal shown: its colour on the terminal's left edge (as on its boxes and the details). */
function setTermPlan(p) {
  const el = $('#term-main');
  p ? el.style.setProperty('--pl', colourOf(p)) : el.style.removeProperty('--pl');
}
/** Show a terminal in the panel. */
function showTerminal(id, focus = false) {
  if (!id) return toast('no terminal for this', true);
  if (document.body.classList.contains('terms-hidden')) toggleTerminals(true);
  S.pane = id;
  renderTerminals();
  if (focus && !id.startsWith('ph#')) requestAnimationFrame(() => terms.focus(id));
}
function toggleTerminals(show = document.body.classList.contains('terms-hidden')) {
  document.body.classList.toggle('terms-hidden', !show);
  document.body.classList.remove('terms-max');
  store.set('terms', show ? '' : 'hidden');
  if ($('#rail')) renderRail();
  requestAnimationFrame(() => terms.refit());
}

// ---------------------------------------------------------------- the panels
function render() {
  if (!S.ov) return;
  renderNeeds();
  renderPlans();
  renderFlight();
  renderTerminals();
  renderRail();
  drawer.refresh();
  const plans = openPlans();
  const n = plans.reduce((a, p) => a + p.attention.mine.length + orphansOf(p).length, 0);
  document.title = n ? `(${n}) ATF` : 'ATF';
  const running = plans.reduce((a, p) => a + currentWork(p.st).length, 0);
  $('#summary').replaceChildren(
    h('span', { class: n ? 'hot' : '' }, h('b', {}, n || 'nothing'), n ? ` need${n === 1 ? 's' : ''} you` : ' needs you'),
    h('span', {}, h('b', {}, running), ' in progress'),
    h('span', {}, h('b', {}, plans.length), ` open plan${plans.length === 1 ? '' : 's'}`),
  );
  notifyCheck();
}
/** The cockpit's rows show what the inspector shows. */
function markOpen() {
  const v = drawer.current();
  const keys = new Set(v ? [v.key, v.task ? `task#${v.pk}#${v.task}` : `plan#${v.pk}`] : []);
  for (const el of document.querySelectorAll('[data-open]')) el.classList.toggle('open', keys.has(el.dataset.open));
}
/** A plan's section header: its name and project, first. */
/** A project's folder for people: the home directory as ~. */
function shortPath(dir) {
  const home = S.ov?.home;
  return dir && home && (dir === home || dir.startsWith(home + '/')) ? '~' + dir.slice(home.length) : dir ?? '';
}
function planHead(p, extra = []) {
  return h(
    'div',
    { class: 'grp-h', title: `${planTitle(p)} · open the plan`, onclick: () => openPlan(p) },
    h('span', { class: 'mk' }),
    h('span', { class: 'pname' }, planTitle(p)),
    h('span', { class: 'proj', title: `project ${p.project.name}: ${shortPath(p.project.dir)}` }, p.project.name),
    h('span', { class: 'right' }, extra),
  );
}
/** Draw a panel's body again, keeping its scroll and what is being typed in it. */
function redraw(body, kids) {
  const ta = document.activeElement?.tagName === 'TEXTAREA' && body.contains(document.activeElement) ? document.activeElement : null;
  const sel = ta ? [ta.dataset.k, ta.selectionStart, ta.selectionEnd] : null;
  const top = body.scrollTop;
  body.replaceChildren(...kids);
  body.scrollTop = top;
  if (sel) {
    const nta = body.querySelector(`textarea[data-k="${CSS.escape(sel[0])}"]`);
    if (nta) (nta.focus(), nta.setSelectionRange(sel[1], sel[2]));
  }
}

// ---------------------------------------------------------------- Needs you
function needLabel(it, p) {
  const t = it.task ? p.st.tasks[it.task] : null;
  if (it.kind === 'coordinator' || it.kind === 'prompt') return [h('b', {}, it.actor), it.task ? `on ${it.task} ` : '', h('span', { class: 'dim' }, NEED[it.kind][1])];
  if (t) return [h('b', {}, t.id), parentPath(p, t), t.title];
  return [NEED[it.kind]?.[1] ?? it.kind];
}
/** Write right here: an answer, a change request, a closing note. */
function inline(it, p, action, label, button, optional = false) {
  return () => {
    S.compose = { nkey: it.nkey, action, p, task: it.task ?? null, label, button, optional };
    renderNeeds();
    drawer.refresh((v) => v.kind === 'need');
    requestAnimationFrame(() => ($(`#drawer.on textarea[data-k="${CSS.escape(it.nkey)}"]`) ?? $(`#needs textarea[data-k="${CSS.escape(it.nkey)}"]`))?.focus());
  };
}
function actionsOfNeed(it, p, { inDetails = false } = {}) {
  const b = (label, run, primary = false) => h('button', { class: `${inDetails ? 'btn' : ''}${primary ? (inDetails ? ' primary' : 'primary') : ''}`, onclick: (e) => (e.stopPropagation(), run()) }, label === 'Open' && inDetails ? (it.task ? 'The task' : 'The plan') : label === 'Open the plan' && inDetails ? 'The plan' : label);
  const open = inDetails ? () => (it.task ? openTask(p, it.task) : openPlan(p)) : () => openItem(it, p);
  switch (it.kind) {
    case 'your-review':
      return [b('Approve', () => act('approve', p, it.task), true), b('Request changes', inline(it, p, 'changes', `What should change in ${it.task}?`, 'Send change request')), b('Open', open)];
    case 'your-task':
      return [b('Done', inline(it, p, 'finish', `${it.task} done: anything to say? (optional)`, 'Mark done', true), true), b('Open', open)];
    case 'question':
      return [b('Answer', inline(it, p, 'note', `Your answer on ${it.task}`, 'Send answer'), true), b('Open', open)];
    case 'plan-question':
      return [b('Answer', inline(it, p, 'plan-note', 'Your answer, for the coordinator', 'Send answer'), true), b('Open the plan', open)];
    case 'no-coordinator':
      return [b('Start coordinator', () => coordinator(p, false), true)];
    case 'coordinator':
    case 'prompt':
      return [b('Terminal', () => showTerminal(it.pane, true), true), ...(it.task ? [b('Open', () => openTask(p, it.task))] : [])];
    case 'finished':
      return [b('Close plan', inline(it, p, 'close-plan', `Close "${planTitle(p)}": a closing note (optional)`, 'Close plan', true), true), b('Open the plan', open)];
    case 'failed':
      return [b('Message', inline(it, p, 'note', `A message on ${it.task}, for the coordinator`, 'Send')), b('Open', open)];
    case 'approval': {
      const a = agentOf(p, it.actor);
      return [...(a ? [b('Terminal', () => showTerminal(a.handle, true), true)] : []), b('Live', () => openLive(p, it.task)), b('Open', open)];
    }
    case 'orphan':
      return [b('Tell the coordinator', () => act('note', p, it.task, `No agent is running ${it.task} any more (${it.actor}'s session is gone): restart or reassign it.`), true), b('Open', open)];
    case 'stale': {
      const a = agentOf(p, it.actor);
      return [...(a ? [b('Terminal', () => showTerminal(a.handle, true), true)] : []), b('Open', open)];
    }
    default:
      return [b('Open', open)];
  }
}
/** What a Needs-you item opens: the item itself in the details, or the waiting agent's terminal. */
function openItem(it, p) {
  if (it.kind === 'coordinator' || it.kind === 'prompt') return showTerminal(it.pane, true);
  const { st, root, plan, key, ...snap } = it; // a copy, shown greyed once it no longer needs you
  return drawer.open({ key: `need#${it.nkey}`, kind: 'need', pk: p.key, nkey: it.nkey, task: it.task ?? null, snap }, { replace: drawer.current()?.kind === 'need' });
}
/** The items of a plan that a details view of an item looks up (they change with the plan). */
const itemsOf = (p) => [...(p.attention?.mine ?? []), ...orphansOf(p), ...(p.attention?.todos ?? [])];
const NEED_TITLE = {
  approval: 'A command waits for your approval',
  orphan: 'No agent runs this task',
  'no-coordinator': 'No coordinator runs this plan',
  'your-review': 'For you to review',
  question: 'A question for you',
  'plan-question': 'A question about the plan',
  failed: 'Failed',
  review: 'For the coordinator to review',
  stale: 'Its agent is idle',
  finished: 'All tasks finished',
  'your-task': 'Your task',
};
/** The details of a Needs-you item: what it is about, in full, with its actions. */
function needPage(v, el) {
  const p = planByKey(v.pk);
  const live = p?.st ? itemsOf(p).find((x) => x.nkey === v.nkey) : null;
  const it = live ?? v.snap;
  const t = it.task && p?.st ? taskFull(p, it.task) : null;
  const b = t ? briefOf(p, t.id) : null;
  const out = [];
  const sec = (title, ...kids) => h('section', { class: 'sec' }, h('h3', {}, title), ...kids);
  out.push(h('h1', { class: 'need-h' }, h('span', { class: `ic k-${it.kind}` }, NEED[it.kind]?.[0] ?? '·'), NEED_TITLE[it.kind] ?? it.kind));
  out.push(
    h(
      'div',
      { class: 'facts' },
      t ? h('a', { onclick: () => openTask(p, t.id) }, h('b', { class: 'mono' }, t.id), ' ', parentPath(p, t), t.title) : h('a', { onclick: () => openPlan(p) }, `▣ ${planTitle(p)}`),
      it.actor ? h('span', {}, `from ${it.actor === S.ov.human ? 'you' : it.actor}`) : '',
      it.ts ? h('span', {}, `${ago(it.ts)} ago`) : '',
    ),
  );
  if (!live) out.push(h('div', { class: 'card gone' }, h('p', {}, '✓ This no longer needs you: it was handled or changed.'), t ? h('p', {}, h('a', { onclick: () => openTask(p, t.id) }, `the task ${t.id}`)) : ''));
  const c = live && S.compose?.nkey === it.nkey ? S.compose : null;
  if (live) out.push(h('div', { class: 'toolbar need-acts' }, c ? composerFor(it, c) : actionsOfNeed(it, p, { inDetails: true })));
  // what it is about, in full
  const q = b?.question;
  if ((it.kind === 'question' || it.kind === 'plan-question') && (q || it.message))
    out.push(h('div', { class: 'card ask' }, h('p', { class: 'big' }, q?.message ?? it.message), q?.recommend ? h('p', {}, h('b', {}, 'Recommended: '), q.recommend) : '', q?.original ? h('p', { class: 'meta' }, `originally from ${q.original.actor}: ${q.original.message}`) : '', q ? h('p', { class: 'meta' }, `asked by ${q.asked_by ?? '?'} · ${ago(q.ts)} ago`) : ''));
  else if ((it.kind === 'your-review' || it.kind === 'review') && b?.review)
    out.push(h('div', { class: 'card review' }, h('p', { class: 'big' }, b.review.submitted?.message ?? it.message ?? ''), h('p', { class: 'meta' }, b.review.submitted ? `submitted by ${b.review.submitted.actor} · ${ago(b.review.submitted.ts)} ago${b.review.round > 1 ? ` · round ${b.review.round}` : ''}` : ''), ...b.review.notes.map((n) => h('p', {}, h('span', { class: 'dim' }, `${n.kind}: `), n.message)), b.review.assessment ? h('p', {}, h('b', {}, 'Coordinator: '), b.review.assessment) : '', h('p', {}, h('a', { onclick: () => openDiff(p, t.id) }, 'its changes'))));
  else if (it.kind === 'failed') out.push(h('div', { class: 'card fail' }, h('p', { class: 'big' }, b?.failure?.message ?? it.message ?? '')));
  else if (it.message && !(it.kind === 'your-task' && it.message === t?.description)) out.push(h('div', { class: `card k-${it.kind}` }, h('p', { class: 'big' }, it.message)));
  // its context
  if (t) {
    const g = p.glance?.[t.id];
    if (it.kind === 'approval' || it.kind === 'failed' || it.kind === 'orphan' || it.kind === 'stale') {
      if (t.steps?.length) out.push(sec('Steps', h('div', { class: 'tcard flat' }, h('div', { class: 'steps' }, stepTrack(t.steps, t.steps.findIndex((x) => x.status === 'in_progress'))))));
      if (g) out.push(sec(it.kind === 'approval' ? 'The command' : 'Its last run', glanceOf(p, t)));
      if (t.owner) {
        const a = agentOf(p, t.owner);
        out.push(sec('Its agent', h('p', {}, h('b', {}, t.owner), a ? ` · ${a.status} ${ago(a.since)}` : ' · no session here', t.last_message ? h('span', { class: 'dim' }, ` · last: ${first(t.last_message, 160)}`) : ''), a ? h('p', {}, h('a', { onclick: () => showTerminal(a.handle, true) }, 'its terminal')) : ''));
      }
    }
    if (it.kind === 'your-task') {
      if (t.description && t.description !== t.title) out.push(sec('Description', h('pre', {}, t.description)));
      if (t.acceptance?.length) out.push(sec('Done when', h('ul', {}, t.acceptance.map((a) => h('li', {}, a)))));
      const waiting = p.st.order.filter((x) => p.st.tasks[x].waiting_on?.includes(t.id));
      if (waiting.length) out.push(sec('Waiting on it', h('div', { class: 'rows' }, waiting.map((x) => h('div', { class: 'r click', onclick: () => openTask(p, x) }, h('span', { class: 'mono' }, x), h('span', { class: 'm' }, p.st.tasks[x].title), h('span', { class: 'dim' }, p.st.tasks[x].owner ?? ''))))));
    }
  }
  if (it.kind === 'no-coordinator' || it.kind === 'finished' || it.kind === 'plan-question') {
    const leaves = p.st.order.filter((x) => !p.st.tasks[x].children.length);
    const fin = leaves.filter((x) => ['done', 'cancelled'].includes(p.st.tasks[x].status)).length;
    out.push(sec('The plan', h('p', {}, `${fin} of ${leaves.length} tasks done`), p.st.checkpoint?.message ? h('pre', {}, p.st.checkpoint.message) : '', h('p', {}, h('a', { onclick: () => openPlan(p) }, 'the plan’s overview'))));
  }
  el.replaceChildren(h('div', { class: 'page' }, out));
}
function needItem(it, p) {
  const msg = ['your-review', 'question', 'failed', 'review', 'plan-question', 'stale', 'orphan', 'approval'].includes(it.kind) ? it.message : it.kind === 'your-task' && it.waiting?.length ? `${it.waiting.join(', ')} wait${it.waiting.length === 1 ? 's' : ''} on it` : '';
  const target = it.kind === 'coordinator' || it.kind === 'prompt' ? null : `need#${it.nkey}`;
  const c = S.compose?.nkey === it.nkey && !drawer.shows(`need#${it.nkey}`) ? S.compose : null;
  return h(
    'div',
    { class: 'item', dataset: target ? { open: target } : {}, title: NEED[it.kind]?.[1], onclick: (e) => !e.target.closest('.icompose') && openItem(it, p) },
    h('span', { class: `ic k-${it.kind}` }, NEED[it.kind]?.[0] ?? '·'),
    h('span', { class: 't' }, needLabel(it, p)),
    h('span', { class: 'side' }, ago(it.ts)),
    msg ? h('span', { class: `sub${it.kind === 'question' || it.kind === 'plan-question' ? ' q' : ''}`, title: msg }, msg) : '',
    c ? '' : h('span', { class: 'act' }, actionsOfNeed(it, p)),
    c ? composerFor(it, c) : '',
  );
}
function composerFor(it, c) {
  const close = () => ((S.compose = null), renderNeeds(), drawer.refresh((v) => v.kind === 'need'));
  const send = () => {
    const text = S.drafts.get(it.nkey) ?? '';
    if (!c.optional && !text.trim()) return toast('nothing to send', true);
    act(c.action, c.p, c.task, text).then((ok) => ok && (S.drafts.delete(it.nkey), S.compose?.nkey === it.nkey && close()));
  };
  const ta = h('textarea', {
    'data-k': it.nkey,
    placeholder: c.label,
    oninput: (e) => S.drafts.set(it.nkey, e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), send());
      if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close());
    },
  });
  ta.value = S.drafts.get(it.nkey) ?? '';
  return h('div', { class: 'icompose' }, ta, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: send }, c.button), h('button', { class: 'btn', onclick: close }, 'Cancel'), h('span', { class: 'hint' }, '⌘/ctrl+⏎ sends · esc cancels')));
}
/**
 * What needs the human beyond the plan's attention: tasks in progress that no agent runs
 * (the server's health), commands held for the human's approval (the live glance).
 */
function orphansOf(p) {
  const out = Object.entries(p.health || {})
    .filter(([, v]) => v === 'orphan')
    .map(([tid]) => {
      const t = p.st.tasks[tid];
      return { kind: 'orphan', task: tid, actor: t.owner, ts: t.updated_at, nkey: `orphan|${p.key}|${tid}`, message: `${t.owner}’s session is gone and nothing happened for ${ago(t.updated_at)}` };
    });
  for (const [tid, g] of Object.entries(p.glance || {}))
    if (g.active && g.approval) out.push({ kind: 'approval', task: tid, actor: p.st.tasks[tid]?.owner, ts: g.since ? new Date(g.since).toISOString() : null, nkey: `approval|${p.key}|${tid}|${g.ref}`, message: `$ ${String(g.cmd ?? '').split('\n')[0]}` });
  return out;
}
function renderNeeds() {
  const kids = [];
  const plans = planOrder();
  let n = 0;
  for (const p of plans) {
    const items = [...p.attention.mine, ...orphansOf(p)].sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.ts || '').localeCompare(b.ts || ''));
    n += items.length;
    if (!items.length) continue;
    kids.push(h('section', { class: 'pgrp', style: `--pc:${colourOf(p)}` }, planHead(p, [h('span', { class: 'n c-red' }, String(items.length))]), h('div', { class: 'grp-body' }, items.map((it) => needItem(it, p)))));
  }
  $('#needs-n').textContent = n || '';
  if (!n) kids.push(h('div', { class: 'empty' }, plans.length ? 'Nothing needs you: every plan is moving on its own.' : 'No open plans.'));
  redraw($('#needs .body'), kids);
  renderTodos();
  markOpen();
}
/** Your tasks: what you will have to do eventually (Needs you: what needs you now). */
function renderTodos() {
  const plans = planOrder().filter((p) => p.attention.todos.length);
  const n = plans.reduce((a, p) => a + p.attention.todos.length, 0);
  $('#todos-n').textContent = n || '';
  redraw($('#todos .body'), n ? plans.map((p) => h('section', { class: 'pgrp', style: `--pc:${colourOf(p)}` }, planHead(p, [h('span', { class: 'n' }, String(p.attention.todos.length))]), h('div', { class: 'grp-body' }, p.attention.todos.map((it) => needItem(it, p))))) : [h('div', { class: 'empty' }, 'No tasks of yours in the open plans.')]);
}

// ---------------------------------------------------------------- Plans: every plan with its tasks
/**
 * Whether a task in progress is being worked on right now: `working` (its agent works or a
 * command of it runs), `approval` (a command waits for you), `idle` (its agent waits),
 * `orphan` (no agent runs it), `elsewhere`, `quiet` (in progress, nothing running); null when
 * it is not in progress.
 */
function activityOf(p, t) {
  if (t.children.length || t.status !== 'in_progress') return null;
  const agent = agentOf(p, t.owner);
  const g = p.glance?.[t.id];
  const hv = p.health?.[t.id];
  if (hv === 'orphan') return { cls: 'orphan', tip: 'no agent runs it' };
  if (g?.active && g.approval) return { cls: 'approval', tip: 'a command waits for your approval' };
  if (agent?.status === 'working' || g?.active) return { cls: 'working', tip: g?.active ? `working: ${g.kind} running` : 'working' };
  if (agent) return { cls: 'idle', tip: `its agent is ${agent.status}` };
  if (hv === 'elsewhere') return { cls: 'idle', tip: 'its agent runs elsewhere' };
  return { cls: 'quiet', tip: 'in progress, nothing running' };
}
const ACT_ORDER = ['orphan', 'approval', 'working', 'idle', 'quiet'];
/**
 * A task's state for the details' header: the dot of the Plans view (whether it is worked
 * on right now) with the status in words; a parent its tasks in progress and parts done.
 */
function statusOf(p, t) {
  const s = t.rollup_status ?? t.status;
  const label = s.replace('_', ' ');
  if (t.children.length) {
    const kids = t.children.map((id) => p.st.tasks[id]).filter(Boolean);
    const parts = `${kids.filter((x) => ['done', 'cancelled'].includes(x.rollup_status ?? x.status)).length}/${kids.length} parts done`;
    const acts = leavesOf(p.st, t).map((x) => activityOf(p, x)).filter(Boolean).sort((a, b) => ACT_ORDER.indexOf(a.cls) - ACT_ORDER.indexOf(b.cls));
    if (acts.length) return { cls: acts[0].cls, text: `${label} · ${acts.length} ${acts[0].cls === 'working' ? 'working' : `task${acts.length === 1 ? '' : 's'} in progress`} · ${parts}` };
    return { cls: s, text: `${label} · ${parts}` };
  }
  const a = activityOf(p, t);
  if (a) return { cls: a.cls, text: `${label} · ${a.cls === 'quiet' ? 'nothing running' : a.tip}` };
  if (s === 'todo' && t.waiting_on?.length) return { cls: 'todo', text: `todo · waits on ${t.waiting_on.join(', ')}` };
  if (s === 'todo' && t.ready) return { cls: 'ready', text: t.owner ? 'ready' : 'ready · nobody assigned' };
  if (s === 'blocked' && t.blocked_on?.length) return { cls: 'blocked', text: `blocked on ${t.blocked_on.join(', ')}` };
  return { cls: s, text: label };
}
/** A task's row in the Plans panel; `more`: what a wider view adds after its title (the details). */
function treeRow(p, t, more = null) {
  const s = t.rollup_status ?? t.status;
  const kids = t.children.length;
  const fin = kids ? t.children.filter((id) => ['done', 'cancelled'].includes(p.st.tasks[id]?.rollup_status ?? p.st.tasks[id]?.status)).length : 0;
  const who = t.owner === S.ov.human ? 'you' : t.owner ?? (t.ready ? 'ready' : '');
  // a leaf: its own activity; a parent: how many of its leaves are in progress, the most urgent first
  let act = activityOf(p, t);
  let side = kids ? `${fin}/${kids}` : who;
  if (kids) {
    const acts = leavesOf(p.st, t).map((x) => activityOf(p, x)).filter(Boolean);
    if (acts.length) {
      act = acts.sort((a, b) => ACT_ORDER.indexOf(a.cls) - ACT_ORDER.indexOf(b.cls))[0];
      act = { ...act, tip: `${acts.length} in progress below, ${fin} of ${kids} parts done` };
      side = `${acts.length} ${act.cls === 'working' ? 'working' : 'in progress'}`;
    }
  }
  return h(
    'div',
    { class: `trow${['done', 'cancelled'].includes(s) ? ' fin' : ''}${kids ? ' parent' : ''}${act ? ` act-${act.cls}` : ''}`, dataset: { open: `task#${p.key}#${t.id}` }, style: `padding-left:${12 + (t.depth ?? 0) * 16}px`, title: `${t.id} ${t.title}: ${s.replace('_', ' ')}${act ? ` · ${act.tip}` : ''}`, onclick: () => openTask(p, t.id) },
    h('span', { class: `s-${s}` }, STATUS_ICON[s] ?? ''),
    h('span', { class: 'tid' }, t.id),
    h('span', { class: 'tt' }, t.title, more ?? ''),
    h('span', { class: 'side' }, act ? h('span', { class: `adot ${act.cls}` }) : '', side),
  );
}
function renderPlans() {
  if (document.body.classList.contains('hide-plans')) return;
  const kids = [];
  const open = openPlans().sort((a, b) => a.project.name.localeCompare(b.project.name) || planTitle(a).localeCompare(planTitle(b)));
  for (const p of open) {
    const st = p.st;
    const folded = S.plansFolded.has(p.key);
    const leaves = st.order.filter((id) => !st.tasks[id].children.length);
    const fin = leaves.filter((id) => ['done', 'cancelled'].includes(st.tasks[id].status)).length;
    const fold = (e) => {
      e.stopPropagation();
      folded ? S.plansFolded.delete(p.key) : S.plansFolded.add(p.key);
      store.set('plansFolded', [...S.plansFolded]);
      renderPlans();
    };
    const head = planHead(p, [`${fin}/${leaves.length}`]);
    head.prepend(h('span', { class: 'fold', title: folded ? 'show its tasks' : 'hide its tasks', onclick: fold }, folded ? '▸' : '▾'));
    kids.push(h('section', { class: 'pgrp', style: `--pc:${colourOf(p)}` }, head, folded ? '' : h('div', { class: 'tree' }, st.order.length ? st.order.map((id) => treeRow(p, st.tasks[id])) : h('div', { class: 'empty' }, 'no tasks yet'))));
  }
  if (!open.length) kids.push(h('div', { class: 'empty' }, 'No open plans.'));
  const closed = allPlans().filter((p) => !p.open);
  if (closed.length) {
    kids.push(h('div', { class: 'sub-h', onclick: () => ((S.closedOpen = !S.closedOpen), renderPlans()) }, S.closedOpen ? '▾' : '▸', 'Closed plans', h('span', { class: 'n' }, closed.length)));
    if (S.closedOpen) for (const p of closed) kids.push(h('div', { class: 'trow fin', dataset: { open: `plan#${p.key}` }, onclick: () => openPlan(p) }, h('span', {}, '▣'), h('span', { class: 'tt' }, planTitle(p)), h('span', { class: 'side' }, p.project.name)));
  }
  redraw($('#plans .body'), kids);
}
// ---------------------------------------------------------------- panels: shown and hidden
// Every panel but In flight can be hidden (its header's –, its icon on the rail, alt+shift+1…4);
// the rail on the left brings it back, its badge saying what it holds meanwhile.
const PANELS = [
  // icons: 20×20, drawn with the text colour
  { id: 'plans', label: 'Plans', svg: '<path d="M3 4.5h14M6 10h11M9 15.5h8"/><circle cx="3.5" cy="10" r=".6"/><circle cx="6.5" cy="15.5" r=".6"/>' },
  { id: 'needs', label: 'Needs you', svg: '<circle cx="10" cy="10" r="7.2"/><path d="M10 6v5"/><circle cx="10" cy="14" r=".7"/>' },
  { id: 'todos', label: 'Your tasks', svg: '<rect x="3" y="3" width="14" height="14" rx="2.5"/><path d="M6.5 10.2l2.3 2.3 4.7-5"/>' },
  { id: 'terms', label: 'Terminal', svg: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M5.5 8l2.5 2-2.5 2M10 13h4"/>' },
];
const railIcon = (x) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 20 20');
  el.innerHTML = x.svg; // constant markup above
  return el;
};
const shown = (id) => (id === 'terms' ? !document.body.classList.contains('terms-hidden') : !document.body.classList.contains(`hide-${id}`));
function togglePanel(id, show = !shown(id)) {
  if (id === 'terms') toggleTerminals(show);
  else {
    document.body.classList.toggle(`hide-${id}`, !show);
    store.set('panels', { ...store.get('panels', {}), [id]: show ? 'shown' : 'hidden' });
    if (show) id === 'plans' ? renderPlans() : renderNeeds();
  }
  renderRail();
  requestAnimationFrame(() => terms.refit());
}
function renderRail() {
  const plans = S.ov ? openPlans() : [];
  const needs = plans.reduce((a, p) => a + p.attention.mine.length + orphansOf(p).length, 0);
  const todos = plans.reduce((a, p) => a + p.attention.todos.length, 0);
  const waiting = plans.some((p) => p.attention.mine.some((it) => it.kind === 'coordinator' || it.kind === 'prompt'));
  const badge = { needs: needs ? h('span', { class: 'badge hot' }, String(needs)) : '', todos: todos ? h('span', { class: 'badge todo' }, String(todos)) : '', terms: waiting ? h('span', { class: 'badge dot', title: 'a coordinator or agent waits for you' }) : '' };
  const tip = { needs: needs ? ` · ${needs} need${needs === 1 ? 's' : ''} you` : '', todos: todos ? ` · ${todos}` : '', terms: waiting ? ' · one waits for you' : '' };
  $('#rail').replaceChildren(
    ...PANELS.flatMap((x, i) => [
      ...(x.id === 'terms' ? [h('span', { class: 'sep' })] : []),
      h('button', { 'aria-pressed': String(shown(x.id)), title: `${shown(x.id) ? 'hide' : 'show'} ${x.label}${tip[x.id] ?? ''} (alt+shift+${i + 1})`, onclick: () => togglePanel(x.id) }, railIcon(x), badge[x.id] ?? ''),
    ]),
  );
}

// ---------------------------------------------------------------- In flight
// What is being worked on now and how its runs go: per plan (a box under its name), a card
// per task in progress. Cards keep their size and place (the plan's order): only their
// content changes. What waits for someone is in Needs you, not here.
const currentWork = (st) => st.order.map((id) => st.tasks[id]).filter((t) => !t.children.length && t.status === 'in_progress');
function idleReason(st) {
  const leaves = st.order.map((id) => st.tasks[id]).filter((t) => !t.children.length);
  if (!leaves.length) return 'no tasks yet';
  if (leaves.every((t) => ['done', 'failed', 'cancelled'].includes(t.status))) return 'all tasks finished';
  if (st.status === 'paused') return 'paused';
  const n = (f) => leaves.filter(f).length;
  const bits = [];
  if (n((t) => t.status === 'review')) bits.push(`${n((t) => t.status === 'review')} in review`);
  if (n((t) => t.status === 'blocked')) bits.push(`${n((t) => t.status === 'blocked')} blocked`);
  if (n((t) => t.ready && !t.owner)) bits.push(`${n((t) => t.ready && !t.owner)} ready, not started`);
  if (n((t) => t.status === 'todo' && t.waiting_on.length)) bits.push(`${n((t) => t.status === 'todo' && t.waiting_on.length)} waiting on dependencies`);
  return 'Nothing in progress' + (bits.length ? ': ' + bits.join(', ') : '');
}
const segs = (list) => list.map(([text, style]) => h('span', { class: style ? style.split(' ').map((x) => `st-${x}`).join(' ') : '' }, text));
/** The leaves under a task (itself when it has no parts). */
function leavesOf(st, t) {
  return t.children.length ? t.children.flatMap((id) => (st.tasks[id] ? leavesOf(st, st.tasks[id]) : [])) : [t];
}
/**
 * The parts of a plan: its top-level tasks that have parts, each with its own state.
 * Not a sequence: parts run side by side unless one depends on another, so there is no one
 * "current" part; every part with work in progress is marked, and one that waits says on what.
 */
function partsOf(p) {
  const st = p.st;
  const top = st.order.map((id) => st.tasks[id]).filter((t) => !(t.depth ?? 0) && t.children.length);
  if (!top.length) return null;
  return h(
    'div',
    { class: 'stages' },
    h('span', { class: 'lbl' }, 'Parts'),
    top.map((t) => {
      const s = t.rollup_status ?? t.status;
      const leaves = leavesOf(st, t);
      const running = leaves.filter((x) => x.status === 'in_progress').length;
      const fin = leaves.filter((x) => ['done', 'cancelled'].includes(x.status)).length;
      const waits = [...new Set(leaves.flatMap((x) => (x.status === 'todo' ? x.waiting_on : [])).filter((d) => !leaves.some((x) => x.id === d)))];
      const note = running ? `${running} in progress` : waits.length && s === 'todo' ? `after ${waits.join(', ')}` : leaves.length > 1 && fin < leaves.length ? `${fin}/${leaves.length}` : '';
      return h(
        'span',
        { class: `s-${s}${running ? ' on' : ''}`, title: `${t.id} ${t.title}: ${s.replace('_', ' ')}${note ? `, ${note}` : ''}`, onclick: () => openTask(p, t.id) },
        `${STATUS_ICON[s] ?? ''} ${t.title}`,
        note ? h('span', { class: 'dim' }, ` ${note}`) : '',
      );
    }),
  );
}
/** A task's run at a glance: a box of fixed height (the kind's compact view). */
function glanceOf(p, t) {
  const g = p.glance?.[t.id];
  if (!g) return h('div', { class: 'glance none' }, h('div', { class: 'gh dim' }, 'no command running'));
  const when = g.active ? `${g.approval ? 'waits for your approval' : g.waiting ? 'waiting' : 'running'} ${ago(g.since)}` : g.exit != null ? `exit ${g.exit} · ${ago(g.ts)} ago` : ago(g.ts);
  return h(
    'div',
    { class: 'glance', title: `${g.cmd ?? g.ref}\nopen the live view`, onclick: () => openLive(p, t.id, g.ref) },
    h('div', { class: 'gh' }, h('span', { class: runClass(g) }, `${runGlyph(g)} ${g.kind}`), h('span', { class: `gl ${runClass(g)}` }, g.summary.line || first(g.cmd ?? '', 80)), h('span', { class: 'gw' }, when, g.runs > 1 ? ` · ${g.runs} runs` : '')),
    g.lines.map((l) => h('div', { class: 'ln' }, segs(l))),
  );
}
/**
 * A task's steps in one line of fixed height, whatever its width: a track (a segment per
 * step: done, current, to do, failed; its title on hover), then where it is, the current
 * step first so it is never what gets cut, then the next one if there is room.
 */
function stepTrack(steps, at, done) {
  const failed = steps.findIndex((s) => s.status === 'failed');
  const cur = at >= 0 ? at : failed >= 0 ? failed : steps.findIndex((s) => s.status === 'todo');
  const all = steps.map((s) => `${STEP[s.status] ?? '○'} ${s.n}. ${s.title}`).join('\n');
  const track = h('span', { class: 'track', title: all }, steps.map((s) => h('i', { class: s.status, title: `${s.n}. ${s.title}: ${s.status.replace('_', ' ')}` })));
  if (cur < 0) return [track, h('span', { class: 'n' }, `${steps.length}/${steps.length}`), h('span', { class: 'done', title: all }, `✓ all ${steps.length} steps done`)];
  const c = steps[cur];
  const next = steps.slice(cur + 1).find((s) => s.status === 'todo');
  return [
    track,
    h('span', { class: 'n' }, `${cur + 1}/${steps.length}`),
    h('span', { class: `cur ${c.status}`, title: all }, `${STEP[c.status] ?? '○'} ${c.title}`),
    next ? h('span', { class: 'next', title: all }, `next: ${next.title}`) : '',
  ];
}
function taskCard(p, t) {
  const agent = agentOf(p, t.owner);
  const hv = p.health?.[t.id];
  const who = t.owner === S.ov.human ? 'you' : t.owner ?? '';
  const steps = t.steps || [];
  const at = steps.findIndex((s) => s.status === 'in_progress');
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const tool = (label, run) => h('button', { onclick: (e) => (e.stopPropagation(), run()) }, label);
  const state = agent ? `${agent.status} ${ago(agent.since)}` : hv === 'elsewhere' ? 'elsewhere' : t.owner === S.ov.human ? '' : 'no session';
  return h(
    'div',
    { class: 'tcard', dataset: { open: `task#${p.key}#${t.id}` } },
    h(
      'div',
      { class: 'th' },
      h('span', { class: 'tid', onclick: () => openTask(p, t.id) }, t.id),
      h('span', { class: 'tt', title: `${t.title}: open the task`, onclick: () => openTask(p, t.id) }, t.title),
      h('span', { class: 'tools' }, tool('Live', () => openLive(p, t.id)), tool('Message', () => compose(openTask(p, t.id), 'note', p, t.id, `A message on ${t.id}, for the coordinator`, { button: 'Send' })), tool('Changes', () => openDiff(p, t.id))),
      h('span', { class: `who${hv === 'orphan' ? ' c-red' : ''}`, title: agent ? 'its terminal' : '', onclick: () => agent && showTerminal(agent.handle, true) }, h('span', { class: `dot ${agent?.status ?? 'off'}` }), h('b', {}, who), ` ${state}`),
    ),
    h(
      'div',
      { class: 'steps' },
      steps.length ? stepTrack(steps, at, done) : h('span', { class: 'dim', title: t.last_message ?? '' }, t.last_message ?? 'no steps'),
    ),
    glanceOf(p, t),
  );
}
/**
 * The cards of a plan, nested under their parent tasks as the plan's tree is (subtask ids
 * say little; their parents do): a parent's own cards first, then its parts that have work,
 * each a box of its own. Siblings run side by side; nothing here implies an order.
 */
function workGroups(p, work) {
  const st = p.st;
  const node = (task) => ({ task, cards: [], kids: new Map() });
  const root = node(null);
  for (const t of work) {
    let n = root;
    for (const a of parentsOf(p, t)) {
      if (!n.kids.has(a.id)) n.kids.set(a.id, node(a));
      n = n.kids.get(a.id);
    }
    n.cards.push(t);
  }
  const draw = (n) => {
    const cards = n.cards.length ? h('div', { class: 'cards' }, n.cards.map((t) => taskCard(p, t))) : '';
    const subs = [...n.kids.values()].sort((a, b) => st.order.indexOf(a.task.id) - st.order.indexOf(b.task.id)).map(draw);
    if (!n.task) return [cards, ...subs];
    const kids = n.task.children.map((id) => st.tasks[id]).filter(Boolean);
    const fin = kids.filter((x) => ['done', 'cancelled'].includes(x.rollup_status ?? x.status)).length;
    return h(
      'div',
      { class: 'subgrp' },
      h('div', { class: 'subgrp-h', title: 'open the task', onclick: () => openTask(p, n.task.id) }, h('span', { class: 'tid' }, n.task.id), h('span', { class: 'pt' }, n.task.title), h('span', { class: 'right' }, `${fin}/${kids.length} parts done`)),
      cards,
      ...subs,
    );
  };
  return draw(root);
}
function renderFlight() {
  const kids = [];
  const plans = planOrder();
  let running = 0;
  for (const p of plans) {
    const st = p.st;
    const c = p.coordinator || {};
    const ca = coordAgentOf(p);
    const work = currentWork(st);
    running += work.length;
    const leaves = st.order.filter((id) => !st.tasks[id].children.length);
    const fin = leaves.filter((id) => ['done', 'cancelled'].includes(st.tasks[id].status)).length;
    const pct = Math.round((st.progress || 0) * 100);
    const queued = p.attention.queued || [];
    const coordEl = c.away
      ? h('span', { class: 'coord' }, h('span', { class: 'dot idle' }), `coordinator ${c.id} elsewhere`)
      : ca
        ? h('span', { class: 'coord click', title: 'its terminal', onclick: (e) => (e.stopPropagation(), showTerminal(ca.handle, true)) }, h('span', { class: `dot ${ca.status}` }), `coordinator ${ca.name} ${ca.status} ${ago(ca.since)}`)
        : h('span', { class: 'coord c-red' }, h('span', { class: 'dot off' }), 'no coordinator');
    kids.push(
      h(
        'section',
        { class: 'pgrp', style: `--pc:${colourOf(p)}` },
        planHead(p, [h('span', { class: 'bar', title: `${pct}%` }, h('i', { style: `width:${pct}%` })), `${fin}/${leaves.length} done`]),
        h(
          'div',
          { class: 'pfacts' },
          coordEl,
          queued.length ? h('span', { class: 'click', title: queued.map((it) => `${it.task ?? 'plan'}: ${QUEUED[it.kind] ?? it.kind}`).join('\n'), onclick: () => openPlan(p) }, `${queued.length} waiting for the coordinator`) : '',
          h('span', { class: 'grow' }),
          h('span', { title: 'the plan’s last change' }, `changed ${ago(st.updated_at)} ago`),
        ),
        partsOf(p) ?? '',
        st.checkpoint?.message ? h('div', { class: 'stand', title: `${st.checkpoint.message}\n— ${st.checkpoint.actor}, ${ago(st.checkpoint.ts)} ago` }, h('span', { class: 'lbl' }, 'Where it stands'), first(st.checkpoint.message, 240)) : '',
        work.length ? workGroups(p, work) : h('div', { class: 'why' }, idleReason(st)),
      ),
    );
  }
  if (!plans.length) kids.push(h('div', { class: 'empty' }, 'No open plans. Start one with your coordinator (atf coordinate), or `atf init` in a project.'));
  $('#flight-sum').textContent = plans.length ? `${running} task${running === 1 ? '' : 's'} in progress · ${plans.length} plan${plans.length === 1 ? '' : 's'}` : '';
  redraw($('#flight .body'), kids);
  markOpen();
}

// ---------------------------------------------------------------- a plan's log and changes (inspector)
const LOG_HIDDEN = new Set(['task.snapshot', 'task.session', 'plan.session']);
/** The plan's last events (the previous ones stay shown while a newer version loads). */
function logOf(p) {
  return versioned(S.logs, p.key, p.st.last_seq, `log?${q({ root: p.root, plan: p.id, n: 300 })}`, () => refreshIf((v) => v.kind === 'planlog' && v.pk === p.key), (e) => toast(e.message, true))?.events ?? null;
}
function logList(p) {
  const evs = logOf(p);
  if (!evs) return [h('div', { class: 'empty' }, 'loading…')];
  const all = evs.filter((e) => !LOG_HIDDEN.has(e.type)).sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  if (!all.length) return [h('div', { class: 'empty' }, 'No events.')];
  return all.slice(0, 400).map((e) => {
    const d = e.data || {};
    const status = e.type.endsWith('.status');
    let what = status ? `→ ${String(d.status).replace('_', ' ')}${d.message ? `  ${d.message}` : ''}` : d.message ?? d.title ?? d.assignee ?? d.ref ?? d.summary ?? (d.percent != null ? `${d.percent}%` : '');
    if (typeof what !== 'string') what = JSON.stringify(what);
    return h(
      'div',
      { class: 'item', title: `${e.ts} · ${e.type}`, onclick: () => (e.task ? openTask(p, e.task) : null) },
      h('span', { class: `ic ${status ? `s-${d.status}` : 'dim'}` }, status ? STATUS_ICON[d.status] ?? '·' : '·'),
      h('span', { class: 't' }, h('b', {}, e.actor?.id ?? ''), e.task ? `${e.task} ` : '', h('span', { class: 'dim' }, e.type.replace(/^(task|plan)\./, ''))),
      h('span', { class: 'side' }, new Date(e.ts).toLocaleTimeString()),
      what ? h('span', { class: `sub${status ? ` s-${d.status}` : ''}` }, first(what, 300)) : '',
    );
  });
}
function changesList(p) {
  const c = changesOf(p);
  if (!c) return [h('div', { class: 'empty' }, 'reading the changes (git)…')];
  if (!c.plan.totals.files) return [h('div', { class: 'empty' }, 'No changes recorded yet.')];
  const out = [h('div', { class: 'empty' }, `${c.plan.totals.files} files · `, h('span', { class: 'c-green' }, `+${c.plan.totals.added}`), ' ', h('span', { class: 'c-red' }, `−${c.plan.totals.removed}`))];
  for (const id of p.st.order) {
    const ch = c.tasks[id];
    if (!ch) continue;
    const t = p.st.tasks[id];
    out.push(h('div', { class: 'item', onclick: () => openDiff(p, id) }, h('span', { class: `ic s-${t.status}` }, STATUS_ICON[t.status] ?? ''), h('span', { class: 't' }, h('b', {}, id), t.title), h('span', { class: 'side mono' }, h('span', { class: 'c-green' }, `+${ch.totals.added}`), ' ', h('span', { class: 'c-red' }, `−${ch.totals.removed}`))));
    for (const set of ch.sets)
      for (const f of set.files) {
        const also = (f.tasks || []).filter((x) => x !== id);
        out.push(
          h(
            'div',
            { class: 'item', title: f.project, onclick: () => openDiff(p, id, f.project), oncontextmenu: (e) => menu(e, [{ label: 'Diff', run: () => openDiff(p, id, f.project) }, { label: 'Open the file', run: () => openFile(p, f.project) }]) },
            h('span', { class: 'ic dim mono' }, f.status ?? ''),
            h('span', { class: 't mono', style: 'font-size:12px' }, '  ', f.project, also.length ? h('span', { class: 'c-yellow' }, `  also ${also.join(', ')}`) : ''),
            h('span', { class: 'side mono' }, h('span', { class: 'c-green' }, `+${f.added ?? 0}`), ' ', h('span', { class: 'c-red' }, `−${f.removed ?? 0}`)),
          ),
        );
      }
  }
  return out;
}

// ---------------------------------------------------------------- the command palette
function paletteItems() {
  const out = [];
  for (const p of allPlans()) {
    out.push({ icon: '▣', label: planTitle(p), detail: `plan · ${p.project.name}${p.open ? '' : ' · closed'}`, run: () => openPlan(p) });
    if (!p.st) continue;
    for (const id of p.st.order) {
      const t = p.st.tasks[id];
      out.push({ icon: STATUS_ICON[t.status] ?? '·', label: `${id} ${t.title}`, detail: planTitle(p), run: () => openTask(p, id) });
    }
    for (const d of p.st.docs || []) out.push({ icon: '📄', label: d, detail: `document · ${planTitle(p)}`, run: () => openFile(p, d) });
    for (const a of (p.agents || []).filter((x) => !x.exited)) out.push({ icon: '⌨', label: a.name, detail: `terminal · ${a.task ?? a.role ?? ''} · ${planTitle(p)}`, run: () => showTerminal(a.handle, true) });
    if (p.open) for (const a of actionsFor({ p }).filter((x) => !['N', 'c'].includes(x.key))) out.push({ icon: '›', label: `${a.label}: ${planTitle(p)}`, detail: 'command', run: a.run });
  }
  for (const x of PANELS) out.push({ icon: '›', label: `Show / hide ${x.label}`, detail: 'command', run: () => togglePanel(x.id) });
  out.push({ icon: '›', label: 'New shell', detail: 'in your home folder · ctrl+shift+`', run: () => newShell() });
  for (const p of openPlans()) out.push({ icon: '›', label: `New shell in ${p.project.name}`, detail: `${shortPath(p.project.dir)} · ${planTitle(p)}`, run: () => newShell(p) });
  for (const sh of shells()) out.push({ icon: '▭', label: `${sh.name} · ${shortPath(sh.cwd)}`, detail: sh.exited ? 'shell, exited' : 'shell', run: () => showTerminal(sh.id, !sh.exited) });
  out.push({ icon: '›', label: 'Turn on notifications', detail: 'command', run: () => $('#bell').click() });
  return out;
}
/** A fuzzy match: the query's characters in order; better when together and at word starts. */
function score(label, query) {
  const l = label.toLowerCase();
  let s = 0,
    i = 0,
    last = -2;
  for (const ch of query.toLowerCase()) {
    if (ch === ' ') continue;
    const j = l.indexOf(ch, i);
    if (j < 0) return -1;
    s += j === last + 1 ? 3 : 1;
    if (j === 0 || /[\s/·-]/.test(l[j - 1])) s += 2;
    last = j;
    i = j + 1;
  }
  return s - l.length / 100;
}
function palette() {
  const el = $('#palette');
  const items = paletteItems();
  let sel = 0;
  let shown = [];
  const input = h('input', { placeholder: 'Search plans, tasks, documents, agents, commands…', spellcheck: 'false' });
  const list = h('div', { class: 'list' });
  const close = () => ((el.hidden = true), el.replaceChildren());
  const draw = () => {
    const qy = input.value.trim();
    shown = qy
      ? items
          .map((it) => ({ it, s: score(`${it.label} ${it.detail}`, qy) }))
          .filter((x) => x.s >= 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 60)
          .map((x) => x.it)
      : items.slice(0, 60);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.replaceChildren(...(shown.length ? shown.map((it, i) => h('div', { class: `opt${i === sel ? ' on' : ''}`, onmousemove: () => sel !== i && ((sel = i), draw()), onclick: () => (close(), it.run()) }, h('span', {}, it.icon), h('span', { class: 'l' }, it.label), h('span', { class: 'd' }, it.detail))) : [h('div', { class: 'empty' }, 'Nothing matches.')]));
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  input.oninput = () => ((sel = 0), draw());
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), (sel = Math.min(shown.length - 1, sel + 1)), draw());
    else if (e.key === 'ArrowUp') (e.preventDefault(), (sel = Math.max(0, sel - 1)), draw());
    else if (e.key === 'Enter') (e.preventDefault(), shown[sel] && (close(), shown[sel].run()));
    else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close());
  };
  el.onclick = (e) => e.target === el && close();
  el.replaceChildren(h('div', { class: 'box' }, input, list));
  el.hidden = false;
  draw();
  input.focus();
}

// ---------------------------------------------------------------- notifications
// The browser's own (after you allow them once), for what needs you: the same items and
// texts as herdr's notifications (src/notify.mjs). Each is notified once, when it appears;
// again only after it went away and came back. What comes from agents' live state must
// hold a few seconds first. While this page has the focus: a toast instead.
const LIVE_N = new Set(['prompt', 'no-coordinator', 'coordinator', 'stale']);
const SETTLE_MS = 5000;
const firstSeen = new Map();
let notifyTimer = null;
function notifyCheck() {
  const fresh = store.get('notified', null) === null;
  const notified = new Set(store.get('notified', []));
  const now = Date.now();
  const present = new Set();
  const due = [];
  let later = false;
  for (const p of openPlans())
    for (const it of [...p.attention.mine, ...p.attention.todos]) {
      present.add(it.nkey);
      if (!firstSeen.has(it.nkey)) firstSeen.set(it.nkey, now);
      if (notified.has(it.nkey)) continue;
      if (!fresh && LIVE_N.has(it.kind) && now - firstSeen.get(it.nkey) < SETTLE_MS) {
        later = true;
        continue;
      }
      notified.add(it.nkey);
      if (!fresh) due.push({ it, p });
    }
  for (const k of notified) if (!present.has(k)) notified.delete(k);
  for (const k of firstSeen.keys()) if (!present.has(k)) firstSeen.delete(k);
  store.set('notified', [...notified]);
  clearTimeout(notifyTimer);
  if (later) notifyTimer = setTimeout(notifyCheck, SETTLE_MS);
  if (!due.length) return;
  const plans = new Set(due.map((d) => planTitle(d.p)));
  const head = due.length === 1 ? `ATF · ${planTitle(due[0].p)}` : `ATF · ${due.length} things need you${plans.size === 1 ? ` · ${[...plans][0]}` : ''}`;
  const body = due.map((d) => (plans.size > 1 ? `${planTitle(d.p)}: ` : '') + d.it.text).join(' · ');
  if (window.Notification?.permission === 'granted' && (document.hidden || !document.hasFocus())) {
    const n = new Notification(head, { body, tag: due.length === 1 ? due[0].it.nkey : 'atf' });
    n.onclick = () => (window.focus(), openItem(due[0].it, due[0].p), n.close());
  } else toast(body);
}
function bell() {
  const b = $('#bell');
  const perm = window.Notification?.permission;
  b.textContent = perm === 'granted' ? '🔔' : '🔕';
  b.title = !window.Notification ? 'this browser has no notifications' : perm === 'granted' ? 'notifications on (what needs you, while this page is in the background)' : perm === 'denied' ? 'notifications are blocked: allow them in the browser’s site settings' : 'turn on notifications';
}
$('#bell').onclick = async () => {
  if (!window.Notification) return toast('this browser has no notifications', true);
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission === 'granted') toast('notifications on: you hear when something needs you');
  else if (Notification.permission === 'denied') toast('notifications are blocked: allow them in the browser’s site settings', true);
  bell();
};
bell();

// ---------------------------------------------------------------- layout: sizes
(() => {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(store.get('sizes', {}))) if (['w-plans', 'w-needs', 'h-needs', 'w-drawer', 'h-terms'].includes(k)) root.style.setProperty(`--${k}`, v);
  // the Plans panel: shown when the window is wide enough, unless you hid it
  const panels = store.get('panels', {});
  const plansPref = panels.plans ?? store.get('plansPanel', null); // (plansPanel: before the rail)
  if (plansPref === 'hidden' || (plansPref == null && innerWidth < 1700)) document.body.classList.add('hide-plans');
  for (const id of ['needs', 'todos']) if (panels[id] === 'hidden') document.body.classList.add(`hide-${id}`);
  if (store.get('terms', '') === 'hidden') toggleTerminals(false);
  const save = (k, v) => {
    root.style.setProperty(`--${k}`, v);
    store.set('sizes', { ...store.get('sizes', {}), [k]: v });
  };
  for (const g of document.querySelectorAll('.gutter')) {
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      g.classList.add('drag');
      const col = g.dataset.col;
      const row = g.dataset.row;
      const target = col === 'plans' ? $('#plans') : col ? $('#leftcol') : row === 'needs' ? $('#needs') : $('#terminals');
      const start = target.getBoundingClientRect();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const move = (ev) => {
        if (col) save(col === 'plans' ? 'w-plans' : 'w-needs', `${Math.round(Math.max(220, Math.min(innerWidth * 0.4, start.width + (ev.clientX - x0))))}px`);
        else if (row === 'needs') save('h-needs', `${Math.round(Math.max(90, Math.min($('#leftcol').getBoundingClientRect().height - 90, start.height + (ev.clientY - y0))))}px`);
        // the terminals never get too small to follow a conversation (about 10 rows)
        else save('h-terms', `${Math.round(Math.max(210, Math.min(innerHeight * 0.85, start.height - (ev.clientY - y0))))}px`);
      };
      const up = () => {
        g.classList.remove('drag');
        g.removeEventListener('pointermove', move);
        terms.refit();
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up, { once: true });
    });
    g.addEventListener('dblclick', () => {
      if (g.dataset.row === 'terminals') document.body.classList.toggle('terms-max');
      requestAnimationFrame(() => terms.refit());
    });
  }
})();
$('#palette-open').onclick = palette;
for (const b of document.querySelectorAll('.panel > header .hide')) b.onclick = (e) => (e.stopPropagation(), togglePanel(b.dataset.hide, false));
renderRail();
$('#term-hide').onclick = () => toggleTerminals(false);
$('#term-max').onclick = () => (document.body.classList.toggle('terms-max'), requestAnimationFrame(() => terms.refit()));
addEventListener('resize', () => terms.refit());

// ---------------------------------------------------------------- keys
const HELP = [
  ['Everywhere', [
    ['⌘K / ctrl+K', 'search: plans, tasks, documents, agents, commands'],
    ['alt+1 … 9', 'the coordinators’ terminals, in the order of the plans'],
    ['ctrl+`', 'hide / show the terminal'],
    ['ctrl+shift+`', 'a new shell (in the shown plan’s project, else your home folder)'],
    ['alt+shift+1 … 4', 'show / hide Plans, Needs you, Your tasks, the terminal (or the rail on the left)'],
    ['ctrl+]', 'leave a terminal (the page has the keys again)'],
    ['esc', 'close the details · cancel what you write'],
    ['?', 'this help'],
  ]],
  ['The details of a task', [
    ['a', 'approve a review · mark your task done'],
    ['x', 'request changes'],
    ['r · n', 'answer a question · a message for the coordinator'],
    ['L · d', 'its live view · its changes'],
    ['g', 'its agent’s terminal'],
  ]],
  ['The details of a plan', [
    ['s · S', 'start · replace the coordinator'],
    ['N', 'a note for the coordinator'],
    ['c', 'close the plan'],
    ['g', 'the coordinator’s terminal'],
  ]],
  ['A live view', [
    ['[ ]', 'the previous · next run'],
    ['o', 'the raw output / the view'],
  ]],
  ['Mouse', [
    ['click', 'a task, a run, a plan: its details, over In flight'],
    ['‹ / browser back', 'what the details showed before'],
    ['a terminal in the list', 'show it (the list beside the terminal, per plan)'],
    ['drag', 'the lines between the panels; double-click the one above the terminals: taller'],
  ]],
];
function help() {
  const d = $('#help');
  d.replaceChildren(
    h('h2', { style: 'margin:0 0 6px;font-size:16px' }, 'Agent Task Framework'),
    h('p', { class: 'dim', style: 'margin:0' }, 'Agents keep running when you close this page.'),
    HELP.map(([title, rows]) => [h('h3', {}, title), h('table', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v))))]),
    h('form', { method: 'dialog', style: 'margin-top:14px' }, h('button', { class: 'btn' }, 'Close')),
  );
  d.showModal();
}
$('#help-open').onclick = help;
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return e.preventDefault(), palette();
  if (e.ctrlKey && e.shiftKey && e.code === 'Backquote') return e.preventDefault(), newShell(drawer.current() ? planByKey(drawer.current().pk) : null);
  if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) return e.preventDefault(), toggleTerminals();
  if (e.altKey && e.shiftKey && /^Digit[1-4]$/.test(e.code)) return e.preventDefault(), togglePanel(PANELS[Number(e.code.slice(5)) - 1].id);
  if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
    const g = termGroups().filter((x) => x.p)[Number(e.code.slice(5)) - 1];
    if (g) (e.preventDefault(), showTerminal(g.items[0].id, true));
    return;
  }
  const tag = e.target.tagName;
  if (e.key === 'Escape') {
    closeMenu();
    if (tag !== 'TEXTAREA' && !e.target.closest?.('.xterm') && $('#palette').hidden && !$('#help').open && drawer.isOpen()) return drawer.close();
  }
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || e.target.closest?.('.xterm') || e.metaKey || e.ctrlKey || e.altKey || !$('#palette').hidden) return;
  if (e.key === '?') return help();
  const v = drawer.current();
  if (!v) return;
  const p = planByKey(v.pk);
  if (!p?.st) return;
  if (v.kind === 'live') {
    if (e.key === '[') return v.rt.step?.(-1);
    if (e.key === ']') return v.rt.step?.(1);
    if (e.key === 'o') return v.rt.toggleRaw?.();
  }
  if (v.task && taskKinds(v)) {
    if (e.key === 'L') return openLive(p, v.task);
    if (e.key === 'd') return openDiff(p, v.task);
  }
  const acts = v.kind === 'task' ? actionsFor({ p, task: v.task, tab: v }) : v.kind === 'plan' ? actionsFor({ p, tab: v }) : [];
  const a = acts.find((x) => x.key === e.key);
  if (a) (e.preventDefault(), a.run());
});

// ---------------------------------------------------------------- start
initPages({
  treeRow,
  shortPath,
  taskFull,
  get human() {
    return S.ov?.human ?? 'human';
  },
  planByKey,
  planTitle,
  loadClosed,
  briefOf,
  changesOf,
  liveListOf,
  agentOf,
  agentStatus,
  sessionExists,
  actionsFor,
  act,
  refreshTab,
  openTask,
  openPlan: (p) => openPlan(p),
  openLive,
  openFile,
  openDiff,
  showTerminal: (handle, focus) => showTerminal(handle, focus),
  placeTerminal: () => {},
});
setInterval(() => S.ov && (renderNeeds(), renderFlight()), 15_000); // relative times
// xterm measures the cell size when a terminal opens: load the font first
Promise.all([document.fonts.load("13px 'JetBrains Mono'"), document.fonts.load("bold 13px 'JetBrains Mono'")])
  .catch(() => {})
  .finally(async () => {
    terms.connect();
    stream();
    await load();
    // what the details showed: if its plan still exists
    drawer.restore((v) => !!allPlans().find((p) => p.key === v.pk));
    render();
  });
