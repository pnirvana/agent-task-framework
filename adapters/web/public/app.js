// ATF web UI (docs/webui-design.md §4.5): an IDE for agent work. Explorer (projects,
// plans, agents) · Needs you (always) and a work panel (Tasks, Log, Changes, per plan or
// all) · the editor (tasks, plans, live views, files, diffs, terminals as tabs) · In flight
// (what runs now, always) · the agents' terminals. Plain ES modules, no build step.
//
// Data: /api/overview (projects, open plans with their state, what needs you, live
// badges, agents), loaded again when /api/stream says something changed. Writes: /api/action
// as the human, /api/coordinator.
import { $, h, ago, first, store, toast, api, q, menu, closeMenu } from './util.js';
import { createTerms } from './terms.js';
import { createEditor } from './editor.js';
import { initPages, renderTab, tabTitle, compose, STATUS_ICON } from './pages.js';

// ---------------------------------------------------------------- what the board says
const NEED = {
  prompt: ['!', 'waits at a prompt in its terminal'],
  'no-coordinator': ['⚠', 'no coordinator runs this plan'],
  coordinator: ['?', 'the coordinator waits for you'],
  'your-review': ['◎', 'for you to review'],
  question: ['⊘', 'a question'],
  'plan-question': ['?', 'a question about the plan'],
  failed: ['✗', 'failed'],
  review: ['◎', 'for the coordinator to review'],
  stale: ['◌', 'its agent is idle, the task still in progress'],
  finished: ['●', 'all tasks finished: close the plan'],
  'your-task': ['☐', 'your task'],
};
const RANK = Object.fromEntries(Object.keys(NEED).map((k, i) => [k, i]));

// ---------------------------------------------------------------- state
const S = {
  ov: null,
  workTab: store.get('workTab', 'tasks'), // tasks | log | changes
  filter: store.get('filter', 'all'), // 'all' | plan key
  closed: new Map(), // key -> planView of a closed plan
  briefs: new Map(),
  changes: new Map(),
  liveLists: new Map(),
  logs: new Map(),
  todosOpen: store.get('todosOpen', true),
  showClosed: new Set(),
  pane: store.get('pane', null), // the session shown in the terminal panel
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
const filterPlans = () => (S.filter === 'all' ? openPlans() : [planByKey(S.filter)].filter((p) => p?.st));
async function loadClosed(p) {
  if (S.closed.has(p.key) || S.closed.has(`loading#${p.key}`)) return;
  S.closed.set(`loading#${p.key}`, true);
  try {
    S.closed.set(p.key, await api(`plan?${q({ root: p.root, plan: p.id })}`));
    render();
  } catch (e) {
    toast(e.message, true);
  } finally {
    S.closed.delete(`loading#${p.key}`);
  }
}

// ---------------------------------------------------------------- cached reads
function briefOf(p, task) {
  const key = `${p.key}#${task ?? ''}#${p.st.last_seq}`;
  const b = S.briefs.get(key);
  if (b === undefined) {
    S.briefs.set(key, 'loading');
    api(`brief?${q({ root: p.root, plan: p.id, task })}`)
      .then((r) => (S.briefs.set(key, r), refreshTabs((t) => t.pk === p.key && t.task === task)))
      .catch(() => S.briefs.delete(key));
    return null;
  }
  return b === 'loading' ? null : b;
}
function changesOf(p) {
  const key = `${p.key}#${p.st.last_seq}`;
  const c = S.changes.get(key);
  if (c === undefined) {
    S.changes.set(key, 'loading');
    api(`changes?${q({ root: p.root, plan: p.id })}`)
      .then((r) => {
        S.changes.set(key, r);
        if (S.workTab === 'changes') renderWork();
        refreshTabs((t) => t.pk === p.key && t.kind === 'task');
      })
      .catch((e) => (S.changes.delete(key), toast(e.message, true)));
    return null;
  }
  return c === 'loading' ? null : c;
}
function liveListOf(p, task) {
  const key = `${p.key}#${task}`;
  const c = S.liveLists.get(key);
  const t = p.st.tasks[task];
  const worth = t && !t.children.length && (t.status !== 'todo' || t.artifacts.length);
  if (worth && (!c || (Date.now() - c.at > 4000 && !c.loading))) {
    S.liveLists.set(key, { runs: [], ...(c || {}), loading: true, at: c?.at ?? 0 });
    api(`live?${q({ root: p.root, plan: p.id, task })}`)
      .then((r) => (S.liveLists.set(key, { ...r, at: Date.now() }), refreshTabs((x) => x.pk === p.key && x.task === task && x.kind === 'task')))
      .catch(() => S.liveLists.set(key, { runs: [], at: Date.now() }));
  }
  return c;
}

// ---------------------------------------------------------------- loading, live updates
let loading = null;
async function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      S.ov = await api('overview');
      for (const t of editor.all()) {
        const p = allPlans().find((x) => x.key === t.pk);
        if (p && !p.open) S.closed.delete(p.key), loadClosed(p);
      }
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
  es.onopen = () => ($('#conn').classList.add('up'), load());
  es.onerror = () => $('#conn').classList.remove('up');
}

// ---------------------------------------------------------------- opening things
const openTask = (p, task, o = {}) => editor.open({ key: `task#${p.key}#${task}`, kind: 'task', pk: p.key, task }, o);
const openPlan = (p, o = {}) => editor.open({ key: `plan#${p.key}`, kind: 'plan', pk: p.key }, o);
const openLive = (p, task, ref = null, o = {}) => {
  const t = editor.open({ key: `live#${p.key}#${task}`, kind: 'live', pk: p.key, task, ...(ref ? { ref } : {}) }, { preview: false, ...o });
  if (ref && t.ref !== ref) (t.ref = ref), (t.rt.item = null), refreshTab(t);
  return t;
};
const openFile = (p, path, o = {}) => editor.open({ key: `file#${p.root}#${path}`, kind: 'file', pk: p.key, path }, o);
const openDiff = (p, task, file, o = {}) => editor.open({ key: `diff#${p.key}#${task ?? ''}#${file ?? ''}`, kind: 'diff', pk: p.key, task: task ?? null, file: file ?? null }, o);
const openTerminalTab = (a, p) => editor.open({ key: `term#${a.handle}`, kind: 'term', pk: p.key, session: a.handle, name: a.name }, { preview: false });

/** What a Needs-you item opens: its task, its plan, or the waiting agent's terminal. */
function openItem(it, p, o = {}) {
  if (it.kind === 'coordinator' || it.kind === 'prompt') return showTerminal(it.pane, true, p);
  if (it.task) return openTask(p, it.task, o);
  return openPlan(p, o);
}

// ---------------------------------------------------------------- actions
const agentOf = (p, actor) => (actor ? (p.agents || []).find((a) => !a.exited && (a.actor === actor || a.name === actor)) : null);
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
    const c = np?.agents.find((a) => a.role === 'coordinator' && !a.exited);
    if (c) showTerminal(c.handle, false, np);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * What can be done on a task or a plan: [{key, label, run, primary?, danger?, tip?}]. The
 * task page and the plan page show them as buttons; the keys work on the active tab.
 */
function actionsFor({ p, task, tab }) {
  const st = p.st;
  const out = [];
  const human = S.ov.human;
  const page = tab ?? editor.active();
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
    if (!t.children.length) out.push({ key: 'L', label: 'Live', run: () => openLive(p, t.id) });
    out.push({ key: 'd', label: 'Changes', run: () => openDiff(p, t.id, null, { preview: false }) });
    const agent = agentOf(p, t.owner);
    if (agent) out.push({ key: 'g', label: `Terminal: ${agent.name}`, run: () => showTerminal(agent.handle, true, p) });
    return dedupe(out);
  }
  if (p.open) {
    const co = p.coordinator;
    const agent = (p.agents || []).find((a) => a.role === 'coordinator' && !a.exited);
    if (!co?.away) {
      if (!co?.live) out.push({ key: 's', label: 'Start coordinator', primary: !!p.attention?.mine.some((i) => i.kind === 'no-coordinator'), run: () => coordinator(p, false), tip: 'resumes its last session, or starts fresh from the plan checkpoint' });
      else out.push({ key: 'S', label: 'Replace coordinator', run: () => coordinator(p, true), tip: 'it writes a checkpoint, then a new session takes over' });
    }
    if (agent) out.push({ key: 'g', label: 'Coordinator terminal', run: () => showTerminal(agent.handle, true, p) });
    out.push({ key: 'N', label: 'Note for the coordinator', run: c('plan-note', `A note on "${planTitle(p)}", for the coordinator`) });
    out.push({ key: 'd', label: 'All changes', run: () => openDiff(p, null, null, { preview: false }) });
    const finished = !!p.attention?.mine.some((i) => i.kind === 'finished');
    out.push({ key: 'c', label: 'Close plan', primary: finished, danger: !finished, run: c('close-plan', `Close "${planTitle(p)}": a closing note (optional)`, { button: 'Close plan' }) });
  }
  return dedupe(out);
}
const dedupe = (list) => {
  const seen = new Set();
  return list.filter((a) => !seen.has(a.key) && seen.add(a.key));
};

// ---------------------------------------------------------------- the editor
const editor = createEditor({
  host: $('#editor'),
  render: (t, el) => renderTab(t, el),
  title: tabTitle,
  welcome: () =>
    h(
      'div',
      { class: 'welcome' },
      h('h1', {}, 'Agent Task Framework'),
      h('p', {}, 'Open what needs you on the left, a task from the list below it, or a run from In flight on the right. A single click opens a preview; a double-click keeps the tab.'),
      h('table', {}, [
        ['⌘K / ctrl+K', 'search plans, tasks, documents, agents and commands'],
        ['ctrl+`', 'show or hide the terminals'],
        ['ctrl+]', 'leave a terminal'],
        ['?', 'all keys'],
      ].map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))),
    ),
  onChange: () => markOpen(),
  onClose: (t) => {
    if (t.kind === 'term') requestAnimationFrame(renderTerminals);
  },
});
const refreshTab = (t) => editor.refresh((x) => x.key === t.key);
const refreshTabs = (f) => editor.refresh(f);

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
const inEditor = (handle) => editor.isOpen(`term#${handle}`);

/** The terminal panel's tabs: the agents of the plans the filter shows (a plan's coordinator first). */
function paneList() {
  const out = [];
  for (const p of S.filter === 'all' ? openPlans() : filterPlans()) {
    const agents = (p.agents || []).filter((a) => !a.exited || a.role === 'coordinator');
    const coord = agents.filter((a) => a.role === 'coordinator').sort((a, b) => a.exited - b.exited)[0];
    if (coord && !coord.exited) out.push({ p, a: coord });
    else if (S.filter !== 'all' && p.open) out.push({ p, a: null, placeholder: true });
    for (const a of agents.filter((x) => x.role !== 'coordinator' && !x.exited)) out.push({ p, a });
  }
  return out;
}
function renderTerminals() {
  const list = paneList();
  terms.keep(new Set(allAgents().filter((a) => !a.exited).map((a) => a.handle)));
  const avail = list.filter((x) => x.a && !inEditor(x.a.handle));
  const known = list.some((x) => (x.a?.handle ?? 'placeholder') === S.pane);
  if (!known || (S.pane !== 'placeholder' && inEditor(S.pane))) S.pane = avail[0]?.a.handle ?? (list.some((x) => x.placeholder) ? 'placeholder' : null);
  $('#ptabs').replaceChildren(
    ...list.map((x) =>
      x.a
        ? h(
            'div',
            {
              class: `tab${S.pane === x.a.handle ? ' on' : ''}${inEditor(x.a.handle) ? ' elsewhere' : ''}`,
              title: `${x.a.kind ?? ''} · ${x.a.status} · ${planTitle(x.p)}${inEditor(x.a.handle) ? ' · open in the editor' : ''} · right-click: more`,
              onclick: () => showTerminal(x.a.handle, true, x.p),
              oncontextmenu: (e) => menu(e, [{ label: 'Open as an editor tab', run: () => openTerminalTab(x.a, x.p) }, { label: x.a.task ? `Open ${x.a.task}` : 'Open the plan', run: () => (x.a.task ? openTask(x.p, x.a.task) : openPlan(x.p)) }]),
            },
            h('span', { class: `dot ${x.a.status}` }),
            x.a.name,
            h('span', { class: 'task' }, x.a.task ?? (x.a.role === 'coordinator' ? 'coordinator' : '')),
          )
        : h('div', { class: `tab${S.pane === 'placeholder' ? ' on' : ''}`, onclick: () => ((S.pane = 'placeholder'), renderTerminals()) }, h('span', { class: 'dot off' }), 'coordinator', h('span', { class: 'task' }, 'not running')),
    ),
  );
  const host = $('#terms');
  let ph = host.querySelector('.placeholder');
  if (!S.pane || S.pane === 'placeholder' || inEditor(S.pane)) {
    terms.clear(host);
    if (!ph) host.append((ph = h('div', { class: 'placeholder' })));
    const sp = S.filter === 'all' ? null : planByKey(S.filter);
    const exitedCoord = sp?.agents?.find((a) => a.role === 'coordinator' && a.exited);
    ph.replaceChildren(
      ...(S.pane && S.pane !== 'placeholder'
        ? [h('div', {}, 'This terminal is open in the editor.')]
        : sp?.open
          ? [h('div', {}, sp.coordinator?.away ? `${sp.coordinator.id} runs elsewhere (herdr, another machine).` : exitedCoord ? `The coordinator's session ended (exit ${exitedCoord.code}).` : 'No coordinator runs for this plan.'), sp.coordinator?.away ? '' : h('div', {}, h('button', { class: 'btn primary', onclick: () => coordinator(sp, false) }, 'Start coordinator'))]
          : list.length
            ? [h('div', {}, 'The terminals shown here are open as editor tabs.'), h('div', {}, list.filter((x) => x.a).map((x) => h('button', { class: 'btn', onclick: () => (editor.close(`term#${x.a.handle}`), showTerminal(x.a.handle, true, x.p)) }, `${x.a.name} back here`)))]
            : [h('div', {}, 'No agents run in the plans shown. Start a plan’s coordinator from its page.')]),
    );
    ph.style.display = '';
  } else {
    if (ph) ph.style.display = 'none';
    terms.place(S.pane, host);
  }
}
/** Show an agent's terminal: in its editor tab if it has one, else in the panel. */
function showTerminal(handle, focus = false, p = null) {
  if (!handle) return toast('no terminal for this', true);
  if (inEditor(handle)) {
    editor.activate(`term#${handle}`);
    if (focus) terms.focus(handle);
    return;
  }
  if (document.body.classList.contains('terms-hidden')) toggleTerminals(true);
  if (p && S.filter !== 'all' && S.filter !== p.key) setFilter('all');
  S.pane = handle;
  store.set('pane', handle);
  renderTerminals();
  if (focus) requestAnimationFrame(() => terms.focus(handle));
}
function placeTerminal(handle, el) {
  terms.place(handle, el);
  requestAnimationFrame(renderTerminals);
}
function toggleTerminals(show = document.body.classList.contains('terms-hidden')) {
  document.body.classList.toggle('terms-hidden', !show);
  document.body.classList.remove('terms-max');
  store.set('terms', show ? '' : 'hidden');
  requestAnimationFrame(() => terms.refit());
}

// ---------------------------------------------------------------- panels
function render() {
  if (!S.ov) return;
  renderExplorer();
  renderNeeds();
  renderWork();
  renderInflight();
  renderTerminals();
  editor.draw();
  const n = openPlans().reduce((a, p) => a + p.attention.mine.length, 0);
  document.title = n ? `(${n}) ATF` : 'ATF';
  const pill = $('#needs-count');
  pill.textContent = n ? `${n} need${n === 1 ? 's' : ''} you` : 'all quiet';
  pill.classList.toggle('hot', !!n);
  notifyCheck();
}
/** The panels' rows show which documents are shown in the editor. */
function markOpen() {
  const active = new Set(editor.shown().map((t) => t.key));
  for (const el of document.querySelectorAll('[data-open]')) el.classList.toggle('open', active.has(el.dataset.open));
}

// Explorer
function renderExplorer() {
  const kids = [];
  const sorted = [...projects()].sort((a, b) => (a.repo || a.dir).localeCompare(b.repo || b.dir) || a.dir.localeCompare(b.dir));
  for (const pr of sorted) {
    const open = pr.plans.filter((p) => p.open);
    const closed = pr.plans.filter((p) => !p.open);
    const n = open.reduce((a, p) => a + p.attention.mine.length, 0);
    const worktree = pr.repo && pr.repo !== pr.dir ? ` ⑂ ${pr.repo.split('/').pop()}` : '';
    kids.push(h('div', { class: 'proj', title: pr.dir }, h('span', { class: 'name' }, pr.name, h('span', { class: 'dim' }, worktree)), n ? h('span', { class: 'count' }, n) : ''));
    for (const p0 of [...open, ...(S.showClosed.has(pr.root) ? closed : [])]) {
      const p = { ...p0, project: pr };
      const pn = p.open ? p.attention.mine.length : 0;
      kids.push(
        h(
          'div',
          {
            class: `plan${S.filter === p.key ? ' on' : ''}${p.open ? '' : ' closed'}`,
            title: `${p.id} · click: open the plan, show its work`,
            onclick: () => (openPlan(p), setFilter(p.key)),
            ondblclick: () => openPlan(p, { preview: false }),
            oncontextmenu: (e) => menu(e, [{ label: 'Open the plan', run: () => openPlan(p, { preview: false }) }, { label: 'Show only its work', run: () => setFilter(p.key) }, { label: 'Show all plans', run: () => setFilter('all') }, ...(p.open && p.st ? [null, ...actionsFor({ p }).filter((a) => !['N', 'c'].includes(a.key)).map((a) => ({ label: a.label, run: a.run }))] : [])]),
          },
          h('span', { class: 'name' }, planTitle(p)),
          pn ? h('span', { class: 'count' }, pn) : '',
        ),
      );
      for (const a of (p.agents || []).filter((x) => !x.exited))
        kids.push(h('div', { class: 'agent', title: `${a.kind ?? ''} · ${a.status} · click: its terminal`, onclick: () => showTerminal(a.handle, true, p), oncontextmenu: (e) => menu(e, [{ label: 'Terminal in the panel', run: () => showTerminal(a.handle, true, p) }, { label: 'Terminal as an editor tab', run: () => openTerminalTab(a, p) }, ...(a.task ? [{ label: `Open ${a.task}`, run: () => openTask(p, a.task) }] : [])]) }, h('span', { class: `dot ${a.status}` }), h('span', { class: 'name' }, a.name), h('span', { class: 'dim' }, a.task ?? (a.role === 'coordinator' ? 'coord' : ''))));
    }
    if (closed.length) kids.push(h('div', { class: 'more', onclick: () => (S.showClosed.has(pr.root) ? S.showClosed.delete(pr.root) : S.showClosed.add(pr.root), renderExplorer()) }, S.showClosed.has(pr.root) ? '− hide closed plans' : `+ ${closed.length} closed`));
  }
  if (!kids.length) kids.push(h('div', { class: 'empty' }, 'No ATF projects yet: `atf init` in a project.'));
  $('#tree').replaceChildren(...kids);
}

// Needs you
function needLabel(it, p) {
  const t = it.task ? p.st.tasks[it.task] : null;
  if (t) return [h('b', {}, t.id), t.title];
  if (it.kind === 'coordinator' || it.kind === 'prompt') return [h('b', {}, it.actor), it.task ? ` on ${it.task}` : '', h('span', { class: 'dim' }, ` · ${NEED[it.kind][1]}`)];
  return [NEED[it.kind]?.[1] ?? it.kind];
}
function quickFor(it, p) {
  const b = (label, run, primary = false) => h('button', { class: primary ? 'primary' : '', onclick: (e) => (e.stopPropagation(), run()) }, label);
  switch (it.kind) {
    case 'your-review':
      return [b('Approve', () => act('approve', p, it.task), true), b('Open', () => openTask(p, it.task, { preview: false }))];
    case 'your-task':
      return [b('Done', () => act('finish', p, it.task, ''), true)];
    case 'question':
      return [b('Answer', () => compose(openTask(p, it.task, { preview: false }), 'note', p, it.task, `Your answer on ${it.task}`, { button: 'Send answer' }), true)];
    case 'plan-question':
      return [b('Answer', () => compose(openPlan(p, { preview: false }), 'plan-note', p, null, 'Your answer, for the coordinator', { button: 'Send answer' }), true)];
    case 'no-coordinator':
      return [b('Start', () => coordinator(p, false), true)];
    case 'coordinator':
    case 'prompt':
      return [b('Terminal', () => showTerminal(it.pane, true, p), true)];
    case 'finished':
      return [b('Close plan', () => compose(openPlan(p, { preview: false }), 'close-plan', p, null, `Close "${planTitle(p)}": a closing note (optional)`, { button: 'Close plan' }), true)];
    default:
      return [];
  }
}
function needItem(it, p) {
  const msg = ['your-review', 'question', 'failed', 'review', 'plan-question', 'stale'].includes(it.kind) ? it.message : it.kind === 'your-task' && it.waiting?.length ? `${it.waiting.join(', ')} wait${it.waiting.length === 1 ? 's' : ''} on it` : '';
  const target = it.kind === 'coordinator' || it.kind === 'prompt' ? null : it.task ? `task#${p.key}#${it.task}` : `plan#${p.key}`;
  return h(
    'div',
    { class: 'item', dataset: target ? { open: target } : {}, title: NEED[it.kind]?.[1], onclick: () => openItem(it, p), ondblclick: () => openItem(it, p, { preview: false }) },
    h('span', { class: `ic k-${it.kind}` }, NEED[it.kind]?.[0] ?? '·'),
    h('span', { class: 't' }, needLabel(it, p)),
    h('span', { class: 'side' }, ago(it.ts)),
    msg ? h('span', { class: `sub${it.kind === 'question' || it.kind === 'plan-question' ? ' q' : ''}` }, first(msg, 200)) : '',
    h('span', { class: 'quick' }, quickFor(it, p)),
  );
}
function renderNeeds() {
  const body = $('#needs .body');
  const kids = [];
  const plans = openPlans();
  const needs = plans.flatMap((p) => p.attention.mine.map((it) => ({ it, p }))).sort((a, b) => RANK[a.it.kind] - RANK[b.it.kind] || (a.it.ts || '').localeCompare(b.it.ts || ''));
  $('#needs-n').textContent = needs.length || '';
  if (!needs.length) kids.push(h('div', { class: 'empty' }, 'Nothing needs you: every plan is moving on its own.'));
  const groups = new Map();
  for (const x of needs) groups.set(x.p.key, [...(groups.get(x.p.key) || []), x]);
  const multi = groups.size > 1;
  for (const items of groups.values()) {
    if (multi) kids.push(h('div', { class: 'plan-h', onclick: () => openPlan(items[0].p) }, planTitle(items[0].p), h('span', { class: 'dim' }, `  ${items[0].p.project.name}`)));
    for (const { it, p } of items) kids.push(needItem(it, p));
  }
  const todos = plans.flatMap((p) => p.attention.todos.map((it) => ({ it, p })));
  if (todos.length) {
    kids.push(h('div', { class: 'group-h todos', onclick: () => ((S.todosOpen = !S.todosOpen), store.set('todosOpen', S.todosOpen), renderNeeds()) }, S.todosOpen ? '▾' : '▸', 'Your tasks', h('span', { class: 'n' }, todos.length)));
    if (S.todosOpen) for (const { it, p } of todos) kids.push(needItem(it, p));
  }
  body.replaceChildren(...kids);
  markOpen();
}

// the work panel: Tasks · Log · Changes, for all plans or one
const WORK_TABS = [
  ['tasks', 'Tasks'],
  ['log', 'Log'],
  ['changes', 'Changes'],
];
function setFilter(f) {
  S.filter = f;
  store.set('filter', f);
  renderExplorer();
  renderWork();
  renderTerminals();
}
function renderWork() {
  $('#work-tabs').replaceChildren(...WORK_TABS.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': String(S.workTab === id), onclick: () => ((S.workTab = id), store.set('workTab', id), renderWork()) }, label)));
  const sel = $('#work-filter');
  const opts = [['all', 'All open plans'], ...openPlans().map((p) => [p.key, `${planTitle(p)} · ${p.project.name}`])];
  if (S.filter !== 'all' && !opts.some(([k]) => k === S.filter)) {
    const p = planByKey(S.filter);
    if (p) opts.push([p.key, `${planTitle(p)} (closed)`]);
    else S.filter = 'all';
  }
  sel.replaceChildren(...opts.map(([k, l]) => h('option', { value: k, selected: k === S.filter ? true : null }, l)));
  sel.onchange = () => setFilter(sel.value);
  if (S.filter !== 'all') {
    const p = planByKey(S.filter);
    if (p && !p.st) loadClosed(p);
  }
  const plans = filterPlans();
  const body = $('#work .body');
  const top = body.scrollTop;
  const kids = S.workTab === 'tasks' ? tasksList(plans) : S.workTab === 'log' ? logList(plans) : changesList(plans);
  body.replaceChildren(...kids);
  body.scrollTop = top;
  markOpen();
}
function taskItem(p, t, depth = 0) {
  const s = t.rollup_status ?? t.status;
  const badge = p.live?.[t.id];
  const who = t.owner ? (t.owner === S.ov.human ? 'you' : t.owner) : t.ready ? 'ready' : t.waiting_on?.length ? `waits on ${t.waiting_on.join(', ')}` : '';
  const agent = agentOf(p, t.owner);
  return h(
    'div',
    {
      class: 'item',
      dataset: { open: `task#${p.key}#${t.id}` },
      onclick: () => openTask(p, t.id),
      ondblclick: () => openTask(p, t.id, { preview: false }),
      oncontextmenu: (e) => menu(e, [{ label: 'Open', run: () => openTask(p, t.id, { preview: false }) }, { label: 'Open to the side', run: () => openTask(p, t.id, { preview: false, group: 'other' }) }, ...(t.children.length ? [] : [{ label: 'Live view', run: () => openLive(p, t.id) }]), { label: 'Changes', run: () => openDiff(p, t.id, null, { preview: false }) }, ...(agent ? [{ label: `Terminal: ${agent.name}`, run: () => showTerminal(agent.handle, true, p) }] : [])]),
    },
    h('span', { class: `ic s-${s}`, title: s.replace('_', ' ') }, STATUS_ICON[s] ?? ''),
    h('span', { class: 't' }, depth ? h('span', { class: 'tree-i' }, '  '.repeat(depth)) : '', h('b', {}, t.id), t.title),
    h('span', { class: 'side' }, who),
    badge ? h('span', { class: `sub c-${badge.color}`, title: 'open its live view', onclick: (e) => (e.stopPropagation(), openLive(p, t.id)) }, `${badge.glyph} ${first(badge.text, 90)}`) : '',
  );
}
function tasksList(plans) {
  if (!plans.length) return [h('div', { class: 'empty' }, 'No open plans.')];
  const out = [];
  for (const p of plans) {
    if (S.filter === 'all') out.push(h('div', { class: 'plan-h', dataset: { open: `plan#${p.key}` }, onclick: () => openPlan(p) }, planTitle(p), h('span', { class: 'dim' }, `  ${p.project.name} · ${Math.round((p.st.progress || 0) * 100)}%`)));
    for (const id of p.st.order) out.push(taskItem(p, p.st.tasks[id], p.st.tasks[id].depth ?? 0));
  }
  return out;
}
// bookkeeping the human does not need to read (change snapshots, session ids)
const LOG_HIDDEN = new Set(['task.snapshot', 'task.session', 'plan.session']);
function logOf(p) {
  const key = `${p.key}#${p.st.last_seq}`;
  if (!S.logs.has(key)) {
    S.logs.set(key, null);
    api(`log?${q({ root: p.root, plan: p.id, n: 300 })}`)
      .then((r) => (S.logs.set(key, r.events), S.workTab === 'log' && renderWork()))
      .catch((e) => toast(e.message, true));
  }
  return S.logs.get(key);
}
function logList(plans) {
  const all = [];
  let waiting = false;
  for (const p of plans) {
    const evs = logOf(p);
    if (!evs) waiting = true;
    else for (const e of evs) if (!LOG_HIDDEN.has(e.type)) all.push({ e, p });
  }
  if (!all.length) return [h('div', { class: 'empty' }, waiting ? 'loading…' : 'No events.')];
  all.sort((a, b) => (b.e.ts || '').localeCompare(a.e.ts || ''));
  const multi = plans.length > 1;
  return all.slice(0, 400).map(({ e, p }) => {
    const d = e.data || {};
    const status = e.type.endsWith('.status');
    let what = status ? `→ ${String(d.status).replace('_', ' ')}${d.message ? `  ${d.message}` : ''}` : d.message ?? d.title ?? d.assignee ?? d.ref ?? d.summary ?? (d.percent != null ? `${d.percent}%` : '');
    if (typeof what !== 'string') what = JSON.stringify(what);
    return h(
      'div',
      { class: 'item', title: `${e.ts} · ${e.type}`, onclick: () => (e.task ? openTask(p, e.task) : openPlan(p)) },
      h('span', { class: `ic ${status ? `s-${d.status}` : 'dim'}` }, status ? STATUS_ICON[d.status] ?? '·' : '·'),
      h('span', { class: 't' }, h('b', {}, e.actor?.id ?? ''), e.task ? `${e.task} ` : '', h('span', { class: 'dim' }, e.type.replace(/^(task|plan)\./, ''))),
      h('span', { class: 'side' }, new Date(e.ts).toLocaleTimeString()),
      what ? h('span', { class: `sub${status ? ` s-${d.status}` : ''}` }, multi ? `${planTitle(p)} · ` : '', first(what, 200)) : '',
    );
  });
}
function changesList(plans) {
  if (!plans.length) return [h('div', { class: 'empty' }, 'No open plans.')];
  const out = [];
  for (const p of plans) {
    const c = changesOf(p);
    if (S.filter === 'all') out.push(h('div', { class: 'plan-h', onclick: () => openPlan(p) }, planTitle(p), c ? h('span', { class: 'dim' }, `  ${c.plan.totals.files} files · +${c.plan.totals.added} −${c.plan.totals.removed}`) : ''));
    if (!c) {
      out.push(h('div', { class: 'empty' }, 'reading the changes (git)…'));
      continue;
    }
    if (!c.plan.totals.files) out.push(h('div', { class: 'empty' }, 'No changes recorded yet.'));
    for (const id of p.st.order) {
      const ch = c.tasks[id];
      if (!ch) continue;
      const t = p.st.tasks[id];
      out.push(h('div', { class: 'item', dataset: { open: `diff#${p.key}#${id}#` }, onclick: () => openDiff(p, id), ondblclick: () => openDiff(p, id, null, { preview: false }) }, h('span', { class: `ic s-${t.status}` }, STATUS_ICON[t.status] ?? ''), h('span', { class: 't' }, h('b', {}, id), t.title), h('span', { class: 'side mono' }, h('span', { class: 'c-green' }, `+${ch.totals.added}`), ' ', h('span', { class: 'c-red' }, `−${ch.totals.removed}`))));
      for (const set of ch.sets)
        for (const f of set.files) {
          const also = (f.tasks || []).filter((x) => x !== id);
          out.push(
            h(
              'div',
              { class: 'item', dataset: { open: `diff#${p.key}#${id}#${f.project}` }, title: f.project, onclick: () => openDiff(p, id, f.project), ondblclick: () => openDiff(p, id, f.project, { preview: false }), oncontextmenu: (e) => menu(e, [{ label: 'Diff', run: () => openDiff(p, id, f.project, { preview: false }) }, { label: 'Open the file', run: () => openFile(p, f.project, { preview: false }) }]) },
              h('span', { class: 'ic dim mono' }, f.status ?? ''),
              h('span', { class: 't mono', style: 'font-size:12px' }, '  ', f.project, also.length ? h('span', { class: 'c-yellow' }, `  also ${also.join(', ')}`) : ''),
              h('span', { class: 'side mono' }, h('span', { class: 'c-green' }, `+${f.added ?? 0}`), ' ', h('span', { class: 'c-red' }, `−${f.removed ?? 0}`)),
            ),
          );
        }
    }
  }
  return out;
}

// In flight: what runs now, per plan
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
function renderInflight() {
  const body = $('#inflight .body');
  const kids = [];
  const plans = openPlans();
  if (!plans.length) kids.push(h('div', { class: 'empty' }, 'No active plans.'));
  for (const p of plans) {
    const st = p.st;
    const c = p.coordinator || {};
    const coordAgent = (p.agents || []).find((a) => a.role === 'coordinator' && !a.exited);
    const pct = Math.round((st.progress || 0) * 100);
    const work = currentWork(st);
    kids.push(
      h(
        'div',
        { class: 'flight' },
        h('div', { class: 'fh', title: 'open the plan', onclick: () => openPlan(p), ondblclick: () => openPlan(p, { preview: false }) }, h('b', {}, planTitle(p)), h('span', { class: 'pct' }, `${pct}%`)),
        h('div', { class: 'progress' }, h('i', { style: `width:${pct}%` })),
        h(
          'div',
          { class: 'coord' },
          h('span', { class: `dot ${c.live?.status ?? 'off'}` }),
          coordAgent ? h('a', { title: 'its terminal', onclick: () => showTerminal(coordAgent.handle, true, p) }, c.id) : h('span', {}, c.id ?? 'no coordinator'),
          h('span', { class: 'dim' }, c.away ? 'runs elsewhere' : c.live ? c.live.status : 'not running'),
          !c.live && !c.away ? h('a', { onclick: () => coordinator(p, false) }, 'start') : '',
        ),
        work.length ? '' : h('div', { class: 'why' }, idleReason(st)),
        work.slice(0, 8).map((t) => {
          const a = agentOf(p, t.owner);
          const badge = p.live?.[t.id];
          return h(
            'div',
            { class: 'run' },
            h('span', { class: 'tid', title: `${t.title}: open the task`, onclick: () => openTask(p, t.id) }, t.id),
            h('span', { class: 'who', title: a ? 'its terminal' : '', onclick: () => a && showTerminal(a.handle, true, p) }, a ? h('span', { class: `dot ${a.status}` }) : '', t.owner ?? ''),
            h('span', { class: `what ${badge ? `c-${badge.color}` : 'dim'}`, title: `${badge ? badge.text : t.last_message ?? t.title}: open the live view`, onclick: () => openLive(p, t.id) }, badge ? `${badge.glyph} ${badge.text}` : first(t.last_message ?? t.title, 80)),
          );
        }),
        work.length > 8 ? h('div', { class: 'why' }, `+ ${work.length - 8} more in progress`) : '',
      ),
    );
  }
  body.replaceChildren(...kids);
}

// ---------------------------------------------------------------- the command palette
function paletteItems() {
  const out = [];
  for (const p of allPlans()) {
    out.push({ icon: '▣', label: planTitle(p), detail: `plan · ${p.project.name}${p.open ? '' : ' · closed'}`, run: () => openPlan(p, { preview: false }) });
    if (!p.st) continue;
    for (const id of p.st.order) {
      const t = p.st.tasks[id];
      out.push({ icon: STATUS_ICON[t.status] ?? '·', label: `${id} ${t.title}`, detail: planTitle(p), run: () => openTask(p, id, { preview: false }) });
    }
    for (const d of p.st.docs || []) out.push({ icon: '📄', label: d, detail: `document · ${planTitle(p)}`, run: () => openFile(p, d, { preview: false }) });
    for (const a of (p.agents || []).filter((x) => !x.exited)) out.push({ icon: '⌨', label: a.name, detail: `terminal · ${a.task ?? a.role ?? ''} · ${planTitle(p)}`, run: () => showTerminal(a.handle, true, p) });
    if (p.open) for (const a of actionsFor({ p }).filter((x) => !['N', 'c'].includes(x.key))) out.push({ icon: '›', label: `${a.label}: ${planTitle(p)}`, detail: 'command', run: a.run });
  }
  out.push({ icon: '›', label: 'Show / hide the terminals', detail: 'ctrl+`', run: () => toggleTerminals() });
  out.push({ icon: '›', label: 'Show / hide the Explorer', detail: 'command', run: toggleExplorer });
  out.push({ icon: '›', label: 'Show all plans in the work panel', detail: 'command', run: () => setFilter('all') });
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
    else if (e.key === 'Escape') (e.preventDefault(), close());
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
    n.onclick = () => (window.focus(), openItem(due[0].it, due[0].p, { preview: false }), n.close());
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

// ---------------------------------------------------------------- layout: sizes, panels
function toggleExplorer() {
  document.body.classList.toggle('no-explorer');
  store.set('explorer', document.body.classList.contains('no-explorer') ? 'hidden' : '');
  requestAnimationFrame(() => terms.refit());
}
(() => {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(store.get('sizes', {}))) root.style.setProperty(`--${k}`, v);
  // narrow windows: the Explorer starts hidden (☰ shows it)
  const pref = store.get('explorer', null);
  if (pref === 'hidden' || (pref == null && innerWidth < 1400)) document.body.classList.add('no-explorer');
  if (store.get('terms', '') === 'hidden') document.body.classList.add('terms-hidden');
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
      const target = col ? $(`#${col}`) : row === 'needs' ? $('#needs') : $('#terminals');
      const start = target.getBoundingClientRect();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const move = (ev) => {
        if (col) {
          const w = g.dataset.side === 'right' ? start.width - (ev.clientX - x0) : start.width + (ev.clientX - x0);
          save(col === 'explorer' ? 'w-explorer' : col === 'leftcol' ? 'w-left' : 'w-inflight', `${Math.round(Math.max(160, Math.min(innerWidth * 0.5, w)))}px`);
        } else if (row === 'needs') {
          const parent = $('#leftcol').getBoundingClientRect();
          save('h-needs', `${Math.round(Math.max(80, Math.min(parent.height - 120, start.height + (ev.clientY - y0))))}px`);
        } else save('h-terms', `${Math.round(Math.max(80, Math.min(innerHeight * 0.85, start.height - (ev.clientY - y0))))}px`);
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
$('#explorer-toggle').onclick = toggleExplorer;
$('#palette-open').onclick = palette;
$('#term-hide').onclick = () => toggleTerminals(false);
$('#term-max').onclick = () => (document.body.classList.toggle('terms-max'), requestAnimationFrame(() => terms.refit()));
$('#term-to-editor').onclick = () => {
  const a = allAgents().find((x) => x.handle === S.pane);
  if (a) openTerminalTab(a, a.p);
  else toast('no terminal shown', true);
};
$('#needs-count').onclick = () => $('#needs .body').scrollTo({ top: 0, behavior: 'smooth' });
addEventListener('resize', () => terms.refit());

// ---------------------------------------------------------------- keys
const HELP = [
  ['Everywhere', [
    ['⌘K / ctrl+K', 'search: plans, tasks, documents, agents, commands'],
    ['ctrl+`', 'show or hide the terminals'],
    ['ctrl+]', 'leave a terminal (the page has the keys again)'],
    ['?', 'this help'],
    ['esc', 'cancel what you write, close the search'],
  ]],
  ['On a task (its tab active)', [
    ['a', 'approve a review · mark your task done'],
    ['x', 'request changes'],
    ['r · n', 'answer a question · a message for the coordinator'],
    ['L', 'its live view'],
    ['d', 'its changes'],
    ['g', 'its agent’s terminal'],
  ]],
  ['On a plan (its tab active)', [
    ['s · S', 'start · replace the coordinator'],
    ['N', 'a note for the coordinator'],
    ['c', 'close the plan'],
    ['g', 'the coordinator’s terminal'],
  ]],
  ['In a live view', [
    ['[ ]', 'the previous · next run'],
    ['o', 'the raw output / the view'],
  ]],
  ['Mouse', [
    ['click', 'a preview tab (the next click replaces it)'],
    ['double-click', 'keep the tab open'],
    ['right-click', 'more: open to the side, live view, terminal as a tab, …'],
    ['middle-click', 'close a tab'],
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
  if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) return e.preventDefault(), toggleTerminals();
  if (e.key === 'Escape') closeMenu();
  const tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || e.target.closest?.('.xterm') || e.metaKey || e.ctrlKey || e.altKey || !$('#palette').hidden) return;
  if (e.key === '?') return help();
  const t = editor.active();
  if (!t) return;
  const p = planByKey(t.pk);
  if (!p?.st) return;
  if (t.kind === 'live') {
    if (e.key === '[') return t.rt.step?.(-1);
    if (e.key === ']') return t.rt.step?.(1);
    if (e.key === 'o') return t.rt.toggleRaw?.();
  }
  const acts = t.kind === 'task' ? actionsFor({ p, task: t.task, tab: t }) : t.kind === 'plan' ? actionsFor({ p, tab: t }) : [];
  const a = acts.find((x) => x.key === e.key);
  if (a) (e.preventDefault(), a.run());
});

// ---------------------------------------------------------------- start
initPages({
  editor,
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
  openPlan,
  openLive,
  openFile,
  openDiff,
  showTerminal,
  placeTerminal,
});
setInterval(() => S.ov && (renderNeeds(), renderInflight()), 15_000); // relative times
// xterm measures the cell size when a terminal opens: load the font first
Promise.all([document.fonts.load("13px 'JetBrains Mono'"), document.fonts.load("bold 13px 'JetBrains Mono'")])
  .catch(() => {})
  .finally(async () => {
    terms.connect();
    stream();
    await load();
    // the tabs that were open: those whose plan still exists
    editor.restore((t) => !!allPlans().find((p) => p.key === t.pk));
    render();
  });
