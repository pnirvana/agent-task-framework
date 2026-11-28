// The editor's documents: a task, a plan, a task's live view, a file, a diff, a terminal.
// Each renders into the tab's element from the page's state (ctx, from app.js) and keeps
// its own runtime state in tab.rt (a draft being written, the live view's data, …).
import { h, ago, first, api, q, toast } from './util.js';
import { renderMarkdown, codeBlock, diffBlock, langOf } from './viewer.js';

export const STATUS_ICON = { todo: '○', in_progress: '◐', blocked: '⊘', review: '◎', done: '●', failed: '✗', cancelled: '–' };
const RUN_STATE = { ok: ['✓', 'c-green'], failed: ['✗', 'c-red'], waiting: ['⧖', 'c-yellow'], running: ['⚙', 'c-cyan'], gone: ['–', 'dim'], unknown: ['·', ''] };
const runState = (x) => (x.active ? (x.waiting || x.approval ? RUN_STATE.waiting : RUN_STATE.running) : RUN_STATE[x.summary.state] || RUN_STATE.unknown);
export const runGlyph = (x) => runState(x)[0];
export const runClass = (x) => runState(x)[1];
const isMd = (f) => /\.(md|markdown|mdx)$/i.test(f);
const base = (p) => String(p).split('/').pop();

let ctx = null;
export const initPages = (c) => (ctx = c);

/** What a tab shows in its title: {label, icon, cls, tip}. */
export function tabTitle(t) {
  const p = ctx.planByKey(t.pk);
  switch (t.kind) {
    case 'task': {
      const task = p?.st?.tasks[t.task];
      return { label: `${t.task} ${task?.title ?? ''}`, icon: h('span', { class: `s-${task?.status}` }, STATUS_ICON[task?.status] ?? '○'), tip: `${t.task} ${task?.title ?? ''} · ${ctx.planTitle(p)}` };
    }
    case 'plan':
      return { label: ctx.planTitle(p) || t.plan, icon: '▣', tip: `plan ${ctx.planTitle(p)} · ${p?.project?.name ?? ''}` };
    case 'live':
      return { label: `${t.task} live`, icon: h('span', { class: 'c-cyan' }, '⚙'), tip: `live: ${t.task} ${p?.st?.tasks[t.task]?.title ?? ''}` };
    case 'file':
      return { label: base(t.path), icon: '📄', tip: t.path };
    case 'diff':
      return { label: t.file ? base(t.file) : `${t.task ?? 'plan'} changes`, icon: h('span', { class: 'c-green' }, '±'), tip: `changes: ${t.file ?? t.task ?? ctx.planTitle(p)}` };
    case 'term':
      return { label: t.name, icon: h('span', { class: `dot ${ctx.agentStatus(t.session)}` }), tip: `terminal: ${t.name} (${ctx.planTitle(p)})` };
    default:
      return { label: t.key };
  }
}

/** Draw tab `t` into `el`. */
export function renderTab(t, el) {
  const p = ctx.planByKey(t.pk);
  if (t.kind === 'term') return renderTerm(t, el, p);
  el.classList.remove('term-doc');
  // keep what is being written (a composer) across redraws
  const ta = el.querySelector('textarea');
  const typing = ta && document.activeElement === ta ? [ta.selectionStart, ta.selectionEnd] : null;
  let page;
  if (!p) page = h('div', { class: 'page' }, h('p', { class: 'meta' }, 'This plan is gone (its project was removed?).'));
  else if (!p.st) {
    ctx.loadClosed(p);
    page = h('div', { class: 'page' }, h('p', { class: 'meta' }, 'loading…'));
  } else if (t.kind === 'task') page = taskPage(t, p);
  else if (t.kind === 'plan') page = planPage(t, p);
  else if (t.kind === 'live') page = livePage(t, p);
  else if (t.kind === 'file') page = filePage(t, p);
  else if (t.kind === 'diff') page = diffPage(t, p);
  el.replaceChildren(page);
  if (typing) {
    const nta = el.querySelector('textarea');
    if (nta) (nta.focus(), nta.setSelectionRange(...typing));
  }
}

// ---------------------------------------------------------------- shared pieces
const sec = (title, ...kids) => h('section', { class: 'sec' }, h('h3', {}, title), ...kids);
const btn = (a) => h('button', { class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`, title: a.tip ?? '', onclick: a.run }, a.label, a.key ? h('kbd', {}, a.key) : '');
const notes = (list, max = 12) =>
  [...list]
    .reverse()
    .slice(0, max)
    .map((n) => h('div', { class: 'note' }, h('div', { class: 'who' }, `${n.actor} · ${n.kind} · ${ago(n.ts)} ago`), h('div', { class: `msg kind-${n.kind}` }, n.message)));

/** The composer for a tab's pending action (answer, change request, note, …). */
function composer(t) {
  const c = t.rt.compose;
  if (!c) return '';
  const optional = ['finish', 'close-plan'].includes(c.action);
  const send = () => {
    const text = t.rt.draft ?? '';
    if (!optional && !text.trim()) return toast('nothing to send', true);
    ctx.act(c.action, c.p, c.task, text, c.status).then((ok) => ok && ((t.rt.compose = null), (t.rt.draft = ''), ctx.refreshTab(t)));
  };
  const ta = h('textarea', {
    placeholder: c.placeholder ?? '',
    oninput: (e) => (t.rt.draft = e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), send());
      if (e.key === 'Escape') (e.preventDefault(), (t.rt.compose = null), ctx.refreshTab(t));
    },
  });
  ta.value = t.rt.draft ?? '';
  requestAnimationFrame(() => t.rt.compose === c && !c.focused && ((c.focused = true), ta.focus()));
  return h(
    'div',
    { class: 'composer' },
    h('label', {}, c.label),
    ta,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: send }, c.button ?? 'Send'), h('button', { class: 'btn', onclick: () => ((t.rt.compose = null), ctx.refreshTab(t)) }, 'Cancel'), h('span', { class: 'hint' }, '⌘/ctrl+⏎ sends · esc cancels')),
  );
}
export function compose(t, action, p, task, label, extra = {}) {
  ctx.editor.keep(t.key); // working in a tab keeps it
  t.rt.compose = { action, p, task, label, ...extra };
  t.rt.draft = t.rt.draft ?? '';
  ctx.refreshTab(t);
}

// ---------------------------------------------------------------- the task page
function taskPage(tab, p) {
  const st = p.st;
  const t = st.tasks[tab.task];
  if (!t) return h('div', { class: 'page' }, h('h1', {}, tab.task), h('p', { class: 'meta' }, 'This task is gone from the plan.'));
  const b = ctx.briefOf(p, t.id);
  const agent = ctx.agentOf(p, t.owner);
  const facts = h(
    'div',
    { class: 'facts' },
    h('span', { class: `chip s-${t.status}` }, `${STATUS_ICON[t.status] ?? ''} ${t.status.replace('_', ' ')}`),
    h('a', { onclick: () => ctx.openPlan(p, { preview: false }) }, `▣ ${ctx.planTitle(p)}`),
    t.owner ? h('span', {}, 'owner ', agent ? h('a', { onclick: () => ctx.showTerminal(agent.handle, true, p) }, h('span', { class: `dot ${agent.status}` }), ' ', t.owner) : t.owner === ctx.human ? 'you' : t.owner) : h('span', {}, t.ready ? 'ready, not started' : 'not started'),
    t.reviewer ? h('span', {}, `reviewer ${t.reviewer === ctx.human ? 'you' : t.reviewer}`) : '',
    t.status === 'in_progress' && t.percent != null ? h('span', {}, `${t.percent}%`) : '',
    h('span', {}, `updated ${ago(t.updated_at)} ago`),
  );
  const out = [h('h1', {}, h('span', { class: 'id' }, t.id), t.title), facts];
  if (t.path.length > 1) out.push(h('div', { class: 'facts' }, t.path.slice(0, -1).map((id, i) => [i ? ' › ' : '', h('a', { onclick: () => ctx.openTask(p, id) }, `${id} ${st.tasks[id]?.title ?? ''}`)])));
  out.push(h('div', { class: 'toolbar' }, ctx.actionsFor({ p, task: t.id, tab }).map(btn)));
  out.push(composer(tab));
  if (b?.question)
    out.push(h('div', { class: 'card ask' }, h('h3', {}, b.question.for === ctx.human ? 'Question for you' : 'Question for the coordinator'), h('p', {}, b.question.message ?? ''), h('p', { class: 'meta' }, `asked by ${b.question.asked_by ?? '?'} · ${ago(b.question.ts)} ago`), b.question.recommend ? h('p', {}, h('b', {}, 'Recommended: '), b.question.recommend) : '', b.question.original ? h('p', { class: 'meta' }, `originally from ${b.question.original.actor}: ${b.question.original.message}`) : ''));
  if (b?.review)
    out.push(h('div', { class: 'card review' }, h('h3', {}, `Submitted for review${b.review.round > 1 ? ` · round ${b.review.round}` : ''}`), h('p', {}, b.review.submitted?.message ?? ''), h('p', { class: 'meta' }, b.review.submitted ? `by ${b.review.submitted.actor} · ${ago(b.review.submitted.ts)} ago` : ''), ...b.review.notes.map((n) => h('p', {}, h('span', { class: 'dim' }, `${n.kind}: `), n.message)), b.review.assessment ? h('p', {}, h('b', {}, 'Coordinator: '), b.review.assessment) : ''));
  if (b?.failure) out.push(h('div', { class: 'card fail' }, h('h3', {}, 'Failed'), h('p', {}, b.failure.message ?? '')));
  if (t.description && t.description !== t.title) out.push(sec('Description', h('pre', {}, t.description)));
  if (t.acceptance?.length) out.push(sec('Acceptance', h('ul', {}, t.acceptance.map((a) => h('li', {}, a)))));
  if (b?.latest) out.push(sec(t.status === 'in_progress' ? 'Latest' : 'Result', h('pre', {}, b.latest.message)));
  if (b?.checkpoint) out.push(sec('Checkpoint', h('pre', {}, b.checkpoint.message)));
  if (t.steps?.length) out.push(sec('Steps', h('ul', {}, t.steps.map((s) => h('li', { class: `s-${s.status}` }, `${STATUS_ICON[s.status] ?? ''} ${s.title}`)))));
  if (t.waiting_on?.length) out.push(sec('Waits on', h('div', { class: 'rows' }, t.waiting_on.map((id) => h('div', { class: 'r click', onclick: () => ctx.openTask(p, id) }, h('span', { class: `s-${st.tasks[id]?.status}` }, STATUS_ICON[st.tasks[id]?.status] ?? ''), h('span', { class: 'm' }, `${id} ${st.tasks[id]?.title ?? ''}`), '')))));
  // live runs
  const lv = ctx.liveListOf(p, t.id);
  if (lv?.runs.length)
    out.push(
      sec(
        'Live',
        h('div', { class: 'rows' }, lv.runs.slice(0, 10).map((x) => h('div', { class: 'r click', title: x.cmd ?? x.ref, onclick: () => ctx.openLive(p, t.id, x.ref) }, h('span', { class: runClass(x) }, `${runGlyph(x)} ${x.kind}`), h('span', { class: `m ${runClass(x)}` }, first(x.summary.line || x.cmd || '', 120)), h('span', { class: 'dim' }, x.active ? 'now' : ago(x.ts))))),
        lv.earlierText ? h('p', { class: 'meta' }, lv.earlierText) : '',
      ),
    );
  // changes
  const c = ctx.changesOf(p);
  const ch = c?.tasks?.[t.id];
  if (ch?.totals.files)
    out.push(
      sec(
        `Changes · ${ch.totals.files} file${ch.totals.files === 1 ? '' : 's'}`,
        h('div', { class: 'rows' }, ch.sets.flatMap((s) => s.files.map((f) => h('div', { class: 'r click', onclick: () => ctx.openDiff(p, t.id, f.project) }, h('span', { class: 'dim mono' }, f.status ?? ''), h('span', { class: 'm mono' }, f.project), h('span', { class: 'mono' }, h('span', { class: 'c-green' }, `+${f.added ?? 0}`), ' ', h('span', { class: 'c-red' }, `−${f.removed ?? 0}`)))))),
        h('p', {}, h('a', { onclick: () => ctx.openDiff(p, t.id) }, 'all changes of the task')),
      ),
    );
  // artifacts (runs are under Live, as src/live.mjs taskLive picks them)
  const projDir = p.project?.dir;
  const inProject = (ref) => (ref.startsWith('/') ? (projDir && ref.startsWith(projDir + '/') ? ref.slice(projDir.length + 1) : null) : ref);
  const arts = t.artifacts.filter((a) => !a.live && !a.cmd && !['maven', 'tests', 'pipeline', 'build', 'deploy', 'wait'].includes(a.kind));
  if (arts.length)
    out.push(
      sec(
        'Artifacts',
        h('div', { class: 'rows' }, [...arts].reverse().slice(0, 12).map((a) => {
          const rel = ['file', 'log'].includes(a.kind) ? inProject(a.git?.path ?? a.ref) : null;
          const link = a.kind === 'url' || a.kind === 'pr' ? h('a', { href: a.ref, target: '_blank', rel: 'noopener' }, a.ref) : rel ? h('a', { onclick: () => ctx.openFile(p, rel) }, a.ref) : a.ref;
          return h('div', { class: 'r' }, h('span', { class: 'dim' }, a.kind), h('span', { class: 'm' }, link, a.description ? h('span', { class: 'dim' }, ` — ${first(a.description, 100)}`) : ''), h('span', { class: 'dim' }, ago(a.ts)));
        })),
      ),
    );
  if (t.notes.length) out.push(sec('Notes', ...notes(t.notes)));
  const hist = [...t.history].reverse().slice(0, 15);
  if (hist.length)
    out.push(
      sec(
        'History',
        h('div', { class: 'rows' }, hist.map((x) => h('div', { class: 'r' }, h('span', { class: 'dim mono' }, new Date(x.ts).toLocaleTimeString()), h('span', { class: 'm' }, h('b', {}, x.actor), ' ', x.type === 'status' ? h('span', { class: `s-${x.to}` }, `→ ${String(x.to).replace('_', ' ')}`) : x.type, x.message ? h('span', { class: 'dim' }, `  ${first(x.message, 140)}`) : x.percent != null ? h('span', { class: 'dim' }, `  ${x.percent}%`) : x.assignee ? h('span', { class: 'dim' }, `  ${x.assignee}`) : ''), h('span', { class: 'dim' }, `${ago(x.ts)} ago`)))),
      ),
    );
  return h('div', { class: 'page' }, out);
}

// ---------------------------------------------------------------- the plan page
function planPage(tab, p) {
  const st = p.st;
  const c = p.coordinator || {};
  const coordAgent = (p.agents || []).find((a) => a.role === 'coordinator' && !a.exited);
  const facts = h(
    'div',
    { class: 'facts' },
    h('span', { class: `chip ${p.open ? 's-in_progress' : 's-done'}` }, st.status),
    h('span', {}, `${p.project?.name ?? ''} · ${st.id}`),
    h('span', {}, `${Math.round((st.progress || 0) * 100)}% · ${st.counts?.done ?? 0}/${st.total ?? 0} done`),
    h('span', {}, `updated ${ago(st.updated_at)} ago`),
  );
  const out = [h('h1', {}, st.title), facts, h('div', { class: 'progress', style: 'max-width:420px' }, h('i', { style: `width:${Math.round((st.progress || 0) * 100)}%` }))];
  out.push(h('div', { class: 'toolbar' }, ctx.actionsFor({ p, tab }).map(btn)));
  out.push(composer(tab));
  for (const it of p.attention?.mine ?? []) {
    if (it.kind === 'plan-question') out.push(h('div', { class: 'card ask' }, h('h3', {}, 'Question for you'), h('p', {}, it.message), h('p', { class: 'meta' }, `${it.actor} · ${ago(it.ts)} ago`), h('div', { class: 'toolbar' }, btn({ label: 'Answer', primary: true, run: () => compose(tab, 'plan-note', p, null, 'Your answer, for the coordinator', { button: 'Send answer' }) }))));
    if (it.kind === 'finished') out.push(h('div', { class: 'card review' }, h('h3', {}, 'All tasks finished'), h('p', {}, 'Every task is done, failed or cancelled. Close the plan when you are satisfied.')));
    if (it.kind === 'no-coordinator') out.push(h('div', { class: 'card fail' }, h('h3', {}, 'No coordinator runs'), h('p', {}, 'Nobody decides or starts anything for this plan. Start its coordinator: it resumes its last session, or starts fresh from the plan checkpoint.')));
  }
  if (p.open)
    out.push(
      sec(
        'Coordinator',
        h('div', { class: 'rows' }, h('div', { class: `r${coordAgent ? ' click' : ''}`, onclick: coordAgent ? () => ctx.showTerminal(coordAgent.handle, true, p) : null }, h('span', { class: `dot ${c.live?.status ?? 'off'}` }), h('span', { class: 'm' }, c.id ?? 'none', '  ', h('span', { class: 'dim' }, c.away ? 'runs elsewhere (herdr, another machine)' : c.live ? c.live.status : 'not running')), coordAgent ? h('span', { class: 'dim' }, 'open its terminal') : '')),
        p.attention?.queued.length ? h('p', { class: 'meta' }, `waiting on it: ${p.attention.queued.map((i) => `${i.task ?? 'plan'} ${i.kind}`).join(', ')}`) : '',
      ),
    );
  if (st.checkpoint) out.push(sec('Where it stands', h('pre', {}, st.checkpoint.message), h('p', { class: 'meta' }, `${st.checkpoint.actor} · ${ago(st.checkpoint.ts)} ago`)));
  if (st.goal) out.push(sec('Goal', h('p', {}, st.goal)));
  if (st.description) out.push(sec('Description', h('pre', {}, st.description)));
  if (st.docs?.length) out.push(sec('Documents', h('div', { class: 'rows' }, st.docs.map((d) => h('div', { class: 'r click', onclick: () => ctx.openFile(p, d) }, h('span', {}, '📄'), h('span', { class: 'm' }, d), h('span', { class: 'dim' }, 'open'))))));
  out.push(
    sec(
      'Tasks',
      h('div', { class: 'rows' }, st.order.map((id) => {
        const t = st.tasks[id];
        const s = t.rollup_status ?? t.status;
        const badge = p.live?.[id];
        return h('div', { class: 'r click', onclick: () => ctx.openTask(p, id), ondblclick: () => ctx.openTask(p, id, { preview: false }) }, h('span', { class: `s-${s}` }, STATUS_ICON[s] ?? ''), h('span', { class: 'm' }, h('span', { class: 'tree-i' }, '  '.repeat(t.depth ?? 0)), h('b', { class: 'mono' }, id), ' ', t.title, badge ? h('span', { class: `c-${badge.color}` }, `  ${badge.glyph} ${first(badge.text, 60)}`) : ''), h('span', { class: 'dim' }, t.owner === ctx.human ? 'you' : t.owner ?? ''));
      })),
    ),
  );
  if (st.notes.length) out.push(sec('Notes', ...notes(st.notes, 15)));
  return h('div', { class: 'page' }, out);
}

// ---------------------------------------------------------------- files and diffs
function filePage(tab, p) {
  const rt = tab.rt;
  if (!rt.file && !rt.loading) {
    rt.loading = true;
    api(`file?${q({ root: p.root, path: tab.path })}`)
      .then((f) => Object.assign(rt, { file: f, mode: rt.mode ?? (isMd(f.path) ? 'rendered' : 'source') }))
      .catch((e) => (rt.error = e.message))
      .finally(() => ((rt.loading = false), ctx.refreshTab(tab)));
  }
  const f = rt.file;
  const md = f && isMd(f.path);
  const head = h(
    'div',
    { class: 'vhead' },
    h('div', { class: 'vtitle' }, h('b', {}, tab.path), f ? h('span', { class: 'dim' }, `  ${(f.size / 1024).toFixed(f.size < 10240 ? 1 : 0)} KB${f.truncated ? ' · first 2 MB' : ''}`) : ''),
    h('div', { class: 'vtools' }, md ? h('button', { class: 'btn', onclick: () => ((rt.mode = rt.mode === 'rendered' ? 'source' : 'rendered'), ctx.refreshTab(tab)) }, rt.mode === 'rendered' ? 'Source' : 'Rendered') : '', h('button', { class: 'btn', title: 'read it again', onclick: () => ((rt.file = null), ctx.refreshTab(tab)) }, '↻')),
  );
  const body = h('div', { class: 'vbody' });
  if (rt.error) body.append(h('p', { class: 'c-red' }, rt.error));
  else if (!f) body.append(h('p', { class: 'meta' }, 'loading…'));
  else if (f.binary) body.append(h('p', { class: 'meta' }, 'A binary file: not shown.'));
  else if (md && rt.mode === 'rendered') body.append(renderMarkdown(f.text, { onLink: (href) => ctx.openFile(p, joinPath(tab.path, href)) }));
  else body.append(codeBlock(f.text, langOf(f.path), h));
  return h('div', {}, head, body);
}
/** A link in document `from` (project-relative) to `href`: the project-relative path. */
export function joinPath(from, href) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function diffPage(tab, p) {
  const rt = tab.rt;
  if (rt.text == null && !rt.loading) {
    rt.loading = true;
    api(`diff?${q({ root: p.root, plan: p.id, task: tab.task, file: tab.file })}`)
      .then((r) => (rt.text = r.text))
      .catch((e) => (rt.error = e.message))
      .finally(() => ((rt.loading = false), ctx.refreshTab(tab)));
  }
  const label = tab.file ?? (tab.task ? `${tab.task} ${p.st.tasks[tab.task]?.title ?? ''}` : ctx.planTitle(p));
  const head = h('div', { class: 'vhead' }, h('div', { class: 'vtitle' }, h('span', { class: 'dim' }, 'changes  '), h('b', {}, label)), h('div', { class: 'vtools' }, tab.file ? h('button', { class: 'btn', onclick: () => ctx.openFile(p, tab.file, { preview: false }) }, 'Open file') : '', h('button', { class: 'btn', title: 'again', onclick: () => ((rt.text = null), ctx.refreshTab(tab)) }, '↻')));
  const body = h('div', { class: 'vbody' });
  if (rt.error) body.append(h('p', { class: 'c-red' }, rt.error));
  else if (rt.text == null) body.append(h('p', { class: 'meta' }, 'loading…'));
  else body.append(diffBlock(rt.text, h));
  return h('div', {}, head, body);
}

// ---------------------------------------------------------------- live
const segs = (list) => list.map(([text, style]) => h('span', { class: style ? style.split(' ').map((x) => `st-${x}`).join(' ') : '' }, text));

/** A task's live view: polled while shown (every 1.5 s while a run is active). */
async function liveTick(tab) {
  const rt = tab.rt;
  clearTimeout(rt.timer);
  rt.timer = null;
  const p = ctx.planByKey(tab.pk);
  if (!p?.st || rt.stopped) return;
  try {
    const list = await api(`live?${q({ root: p.root, plan: p.id, task: tab.task })}`);
    rt.runs = list.runs;
    rt.earlierText = list.earlierText;
    const x = rt.runs.find((r) => r.ref === tab.ref) || rt.runs[0];
    if (x) {
      tab.ref = x.ref;
      const raw = rt.raw || !x.view;
      rt.data = await api(`live/run?${q({ root: p.root, plan: p.id, task: tab.task, ref: x.ref, ...(raw ? { raw: 1 } : {}), ...(rt.item != null ? { item: rt.item } : {}) })}`);
      rt.error = null;
    } else rt.data = null;
  } catch (e) {
    rt.error = e.message;
  }
  if (rt.stopped) return;
  ctx.refreshTab(tab);
  rt.timer = setTimeout(() => liveTick(tab), rt.runs?.some((r) => r.active) ? 1500 : 5000);
}
function livePage(tab, p) {
  const rt = tab.rt;
  // polling: while the tab is shown; stopped when it is hidden or closed
  rt.hidden ??= () => ((rt.stopped = true), clearTimeout(rt.timer), (rt.timer = null));
  rt.dispose ??= rt.hidden;
  if (rt.stopped || (!rt.timer && !rt.started)) {
    rt.stopped = false;
    rt.started = true;
    rt.follow = true;
    liveTick(tab);
  }
  const t = p.st.tasks[tab.task];
  const runs = rt.runs || [];
  const x = runs.find((r) => r.ref === tab.ref);
  const i = runs.indexOf(x);
  const when = !x ? '' : x.active ? `${x.approval ? 'waiting for your approval' : x.waiting ? 'waiting' : 'running'} ${ago(x.since)}` : x.exit != null ? `exit ${x.exit}${x.duration_ms ? ` · took ${Math.round(x.duration_ms / 1000)}s` : ''} · ${ago(x.ts)} ago` : x.live ? 'live file' : '';
  const raw = rt.raw || (x && !x.view);
  const step = (d) => {
    if (!runs.length) return;
    tab.ref = runs[(i + d + runs.length) % runs.length].ref;
    rt.item = null;
    rt.follow = true;
    liveTick(tab);
  };
  rt.step = step;
  rt.toggleRaw = () => ((rt.raw = !rt.raw), (rt.item = null), (rt.follow = true), liveTick(tab));
  const head = h(
    'div',
    { class: 'vhead' },
    h('div', { class: 'vtitle' }, h('a', { onclick: () => ctx.openTask(p, tab.task, { preview: false }) }, h('b', {}, `${tab.task} `), t?.title ?? ''), runs.length > 1 ? h('span', { class: 'dim' }, `   run ${i + 1} of ${runs.length}`) : ''),
    h(
      'div',
      { class: 'vtools' },
      runs.length > 1 ? h('button', { class: 'btn', title: 'previous run ([)', onclick: () => step(-1) }, '‹') : '',
      runs.length > 1 ? h('select', { class: 'btn', onchange: (e) => ((tab.ref = e.target.value), (rt.item = null), (rt.follow = true), liveTick(tab)) }, runs.map((r) => h('option', { value: r.ref, selected: r.ref === tab.ref ? true : null }, `${runGlyph(r)} ${r.kind} · ${r.active ? 'now' : ago(r.ts) + ' ago'}`))) : '',
      runs.length > 1 ? h('button', { class: 'btn', title: 'next run (])', onclick: () => step(1) }, '›') : '',
      x?.view ? h('button', { class: 'btn', onclick: rt.toggleRaw }, rt.raw ? 'View' : 'Output') : '',
      rt.item != null ? h('button', { class: 'btn', onclick: () => ((rt.item = null), liveTick(tab)) }, '← back') : '',
    ),
    x ? h('div', { class: 'vrun' }, h('span', { class: runClass(x) }, `${runGlyph(x)} ${x.kind}`), h('span', { class: 'dim' }, `  ${when}  `), h('span', { class: runClass(x) }, x.summary.line || '')) : '',
    x ? h('div', { class: 'vcmd dim' }, x.cmd ? `$ ${String(x.cmd).split('\n')[0]}` : x.ref) : '',
  );
  const body = h('div', { class: 'vbody' });
  if (!rt.runs) body.append(h('p', { class: 'meta' }, 'loading…'));
  else if (!runs.length) body.append(h('p', { class: 'meta' }, `Nothing live on ${tab.task} yet: the builds, tests and pipelines its agent runs show here.`));
  else if (rt.error) body.append(h('p', { class: 'c-red' }, rt.error));
  else if (rt.data?.item) body.append(h('div', { class: 'lines' }, rt.data.item.map((l) => h('div', { class: 'ln' }, segs(l)))));
  else if (raw) {
    const text = rt.data?.raw;
    if (text == null) body.append(h('p', { class: 'meta' }, 'no output (yet)'));
    else body.append(h('pre', { class: 'raw' }, text.split('\n').slice(-4000).map((l) => h('div', { class: /\b(ERROR|FAIL(ED|URE)?)\b/.test(l) ? 'c-red' : /\bWARN(ING)?\b/.test(l) ? 'c-yellow' : '' }, l || ' '))));
  } else if (rt.data?.lines) {
    rt.folded ??= new Map();
    const box = h('div', { class: 'lines' });
    let folded = false;
    for (const l of rt.data.lines) {
      if (l.section) {
        const s = l.section;
        folded = rt.folded.has(s) ? rt.folded.get(s) : l.folded;
        const f = folded;
        box.append(h('div', { class: 'ln sechead', onclick: () => (rt.folded.set(s, !f), ctx.refreshTab(tab)) }, h('span', { class: 'c-cyan' }, f ? '▸ ' : '▾ '), segs(l.segs)));
        continue;
      }
      if (folded) continue;
      box.append(h('div', { class: `ln${l.item != null ? ' it' : ''}`, title: l.item != null ? 'details' : null, onclick: l.item != null ? () => ((rt.item = l.item), liveTick(tab)) : null }, segs(l.segs)));
    }
    body.append(box);
  }
  const page = h('div', {}, head, body);
  // the output of a running command: follow its end while you are at its end
  requestAnimationFrame(() => {
    const doc = page.parentElement;
    if (!doc || !raw) return;
    const atEnd = rt.atEnd ?? true;
    if (rt.follow || atEnd) doc.scrollTop = doc.scrollHeight;
    rt.follow = false;
    doc.onscroll = () => ((tab.rt.scroll = doc.scrollTop), (rt.atEnd = doc.scrollHeight - doc.scrollTop - doc.clientHeight < 40));
  });
  return page;
}

// ---------------------------------------------------------------- a terminal as a tab
function renderTerm(tab, el, p) {
  el.classList.add('term-doc');
  if (!ctx.sessionExists(tab.session)) {
    el.replaceChildren(h('div', { class: 'placeholder' }, h('div', {}, `${tab.name}'s session has ended.`), p?.open ? h('div', {}, h('button', { class: 'btn', onclick: () => ctx.openPlan(p, { preview: false }) }, 'Open the plan')) : ''));
    return;
  }
  for (const c of [...el.children]) if (!c.classList.contains('term')) c.remove();
  ctx.placeTerminal(tab.session, el, tab);
}
