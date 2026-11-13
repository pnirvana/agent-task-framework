// Interactive ATF board for a herdr pane (split or popup). Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TERMINAL } from '../../../src/core.mjs';
import { listPlanIds, loadPlan, readEvents, getCurrentPlan, eventsPath, transact, resolveActor, readConfig, findRoot, initRoot } from '../../../src/store.mjs';
import { herdr, herdrAsync, agentIndex, notify, inHerdr } from './herdr.mjs';
import { sync, progressText } from './sync.mjs';
import { lifecycleSweep } from './launch.mjs';

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
 * Entry point. Without an .atf root, show an empty state that can create one
 * (or picks it up as soon as someone runs `atf init` in that directory).
 */
export function runBoard(opts) {
  if (opts.root) return runMain(opts);
  const dir = opts.initDir || process.cwd();
  const out = process.stdout;
  const draw = () => {
    const W = out.columns || 80;
    const H = out.rows || 24;
    const lines = [
      [[' ATF ', 'inverse bold'], [' no ATF project here', 'bold']],
      [['─'.repeat(W), 'gray']],
      [],
      [['  No .atf/ directory in', '']],
      [['  ' + dir, 'cyan']],
      [['  (or any parent directory / main git worktree)', 'dim']],
      [],
      [['  i', 'bold green'], ['  create one here (atf init)', '']],
      [['  q', 'bold'], ['  close', '']],
      [],
      [['  Then let your coordinator agent create a plan (atf plan new …),', 'dim']],
      [['  or run it yourself. This board updates live.', 'dim']],
    ];
    while (lines.length < H) lines.push([]);
    lines.length = H;
    out.write(`${ESC}H` + lines.map((l) => fit(l, W) + `${ESC}K`).join('\r\n'));
  };
  let done = false;
  const proceed = (root) => {
    if (done) return;
    done = true;
    clearInterval(poll);
    process.stdin.removeListener('data', onData);
    out.removeListener('resize', draw);
    runMain({ ...opts, root });
  };
  const onData = (d) => {
    if (d === 'i' || d === 'I') proceed(initRoot(dir));
    else if (d === 'q' || d === '\x1b' || d === '\x03') {
      out.write(`${ESC}?25h${ESC}?1049l`);
      process.exit(0);
    }
  };
  out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  out.on('resize', draw);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  const poll = setInterval(() => {
    const r = findRoot(dir);
    if (r) proceed(r);
  }, 1500);
  draw();
}

const TABS = [
  ['tasks', 'Tasks'],
  ['agents', 'Agents'],
  ['plan', 'Plan'],
  ['log', 'Log'],
];

function runMain({ root, popup = false, targetPane = null, spawnCmd }) {
  const out = process.stdout;
  const ui = {
    plans: [],
    planIdx: 0,
    state: null,
    rows: [], // visible task ids in tree order (collapsed subtrees hidden)
    prefix: {}, // id -> tree connector prefix
    collapsed: new Set(),
    sel: 0,
    scroll: 0,
    tab: 'tasks', // tasks | agents | plan | log
    overlay: null, // detail | help | null
    scrolls: {}, // per-view scroll offsets
    agents: new Map(),
    agentsSince: new Map(), // pane -> {status, since}
    flash: null,
    lastSeqSeen: new Map(), // plan -> seq (for notifications)
  };
  const hookNotifies = (readConfig(root).hooks?.post_write || []).some((h) => h.join(' ').includes('atf-herdr'));
  const view = () => ui.overlay || ui.tab;

  function flash(msg, style = 'yellow') {
    ui.flash = { msg, style, until: Date.now() + 4000 };
    draw();
  }

  // ---------- data ----------
  function loadPlans() {
    const states = listPlanIds(root).map((id) => loadPlan(root, id));
    const rank = (s) => (s.status === 'active' ? 0 : s.status === 'paused' ? 1 : 2);
    states.sort((a, b) => rank(a) - rank(b) || (b.updated_at || '').localeCompare(a.updated_at || ''));
    let prevId = ui.state?.id ?? process.env.ATF_PLAN ?? getCurrentPlan(root);
    // follow a newly started plan if the one on screen is already finished
    const prev = states.find((s) => s.id === prevId);
    if (prev && prev.status !== 'active' && states[0]?.status === 'active' && !ui.plans.some((p) => p.id === states[0].id)) prevId = states[0].id;
    ui.plans = states;
    const idx = states.findIndex((s) => s.id === prevId);
    ui.planIdx = idx >= 0 ? idx : 0;
    setPlan();
  }

  function setPlan() {
    const prevSel = ui.rows[ui.sel];
    ui.state = ui.plans[ui.planIdx] || null;
    ui.rows = [];
    ui.prefix = {};
    const s = ui.state;
    if (s) {
      const visit = (id, prefix, isLast, depth) => {
        ui.rows.push(id);
        ui.prefix[id] = depth ? prefix + (isLast ? '└─' : '├─') : '';
        if (ui.collapsed.has(id)) return;
        const kids = s.tasks[id].children;
        kids.forEach((c, i) => visit(c, depth ? prefix + (isLast ? '  ' : '│ ') : '', i === kids.length - 1, depth + 1));
      };
      const roots = s.order.filter((id) => !s.tasks[id].parent || !s.tasks[s.tasks[id].parent]);
      roots.forEach((id, i) => visit(id, '', i === roots.length - 1, 0));
    }
    const keep = ui.rows.indexOf(prevSel);
    ui.sel = keep >= 0 ? keep : Math.min(ui.sel, Math.max(0, ui.rows.length - 1));
  }

  function reloadCurrent() {
    if (!ui.state) return loadPlans();
    const fresh = loadPlan(root, ui.state.id);
    if (!hookNotifies && inHerdr()) maybeNotify(fresh);
    ui.plans[ui.planIdx] = fresh;
    setPlan();
  }

  function maybeNotify(s) {
    const seen = ui.lastSeqSeen.get(s.id);
    ui.lastSeqSeen.set(s.id, s.last_seq);
    if (seen === undefined || s.last_seq <= seen) return;
    for (const e of readEvents(root, s.id).filter((e) => e.seq > seen)) {
      if (e.type === 'task.status' && ['blocked', 'review', 'failed'].includes(e.data?.status))
        notify(`ATF ${e.task} ${e.data.status}: ${s.tasks[e.task]?.title ?? ''}`, `${e.actor?.id ?? '?'}: ${e.data.message ?? ''}`);
    }
  }

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

  /** Live herdr agent for an ATF actor id (by agent name, else by the pane it last wrote from). */
  function liveAgent(actorId) {
    if (!actorId || !ui.state) return null;
    const actor = ui.state.actors[actorId];
    const a = ui.agents.get(`name:${actorId}`) || (actor?.ctx?.herdr_pane && ui.agents.get(`pane:${actor.ctx.herdr_pane}`));
    if (!a) return null;
    return { ...a, since: ui.agentsSince.get(`pane:${a.pane_id}`)?.since ?? Date.now() };
  }

  function agentFor(t) {
    const a = liveAgent(t?.owner);
    if (!a) return null;
    const stale = t.status === 'in_progress' && ['idle', 'done'].includes(a.agent_status) && Date.now() - a.since > STALE_MS;
    return { ...a, stale };
  }

  const effStatus = (t) => t.rollup_status ?? t.status;
  const packageOf = (t) => (t.assignee ? null : [...t.path].reverse().find((id) => ui.state.tasks[id].assignee) ?? null);

  // ---------- rendering helpers ----------
  function bar(frac, w) {
    const fill = Math.round(frac * w);
    return [
      ['█'.repeat(fill), 'green'],
      ['░'.repeat(w - fill), 'gray'],
    ];
  }

  function header(W) {
    const s = ui.state;
    if (!s) return [[[' ATF ', 'inverse bold'], [' no plans in ' + root, 'dim']]];
    const pct = Math.round(s.progress * 100);
    const planNav = ui.plans.length > 1 ? `  plan ${ui.planIdx + 1}/${ui.plans.length} [p]` : '';
    const tabs = [[' ', '']];
    TABS.forEach(([id, label], i) => {
      tabs.push([` ${i + 1} ${label} `, ui.tab === id ? 'inverse bold' : 'dim'], [' ', '']);
    });
    return [
      [[' ATF ', 'inverse bold'], [' ' + s.title, 'bold'], [s.status !== 'active' ? `  (${s.status})` : '', 'yellow'], [planNav, 'dim']],
      [[' ', ''], ...bar(s.progress, Math.max(8, Math.min(30, W - 40))), [` ${pct}%  `, 'bold'], [progressText(s), 'dim']],
      tabs,
    ];
  }

  function taskRow(id, W, selected) {
    const s = ui.state;
    const t = s.tasks[id];
    const st = effStatus(t);
    const [g, color] = STATUS[st];
    const a = agentFor(t);
    const right = [];
    if (t.children.length) {
      const done = t.children.filter((c) => effStatus(s.tasks[c]) === 'done').length;
      right.push([`${done}/${t.children.length}`, 'dim']);
      if (t.assignee) right.push([`▣ ${t.assignee}`, 'cyan bold']); // work package owner
    } else {
      if (t.status === 'todo' && t.waiting_on.length) right.push([`⧗ ${t.waiting_on.join(',')}`, 'dim']);
      if (t.ready && !t.owner) right.push(['ready', 'green']);
      if (t.status === 'in_progress' && t.percent != null) right.push([`${t.percent}%`, 'yellow']);
      if (t.assignee) right.push([t.assignee, 'cyan']);
      else if (t.owner) right.push([`↳${t.owner}`, 'cyan dim']); // inherited from package
      if (a) {
        const [ag, ac] = AGENT_GLYPH[a.agent_status] || AGENT_GLYPH.unknown;
        right.push([ag, ac]);
      }
      if (a?.stale) right.push(['stale?', 'red bold']);
    }
    for (let i = right.length - 1; i > 0; i--) right.splice(i, 0, [' ', '']);
    const rightLen = right.reduce((n, [x]) => n + [...x].length, 0);
    const fold = t.children.length ? (ui.collapsed.has(id) ? '▸' : '▾') : ' ';
    const lead = `${selected ? '›' : ' '}${ui.prefix[id] || ''}`;
    const left = `${fold}${t.id} `;
    // -1: leave a margin column; some terminals (herdr included) draw ○ ⊘ ◐ etc. double-width
    const titleW = Math.max(4, W - 1 - [...lead].length - [...left].length - 2 - rightLen - 2);
    const title = [...t.title].length > titleW ? [...t.title].slice(0, titleW - 1).join('') + '…' : t.title.padEnd(titleW);
    const base = selected ? 'inverse ' : '';
    return [
      [lead, selected ? 'inverse cyan bold' : 'gray'],
      [left, base + 'bold'],
      [g + ' ', (base + color).trim()],
      [title + '  ', (base + (t.children.length ? 'bold' : TERMINAL.has(t.status) && t.status !== 'failed' ? 'dim' : '')).trim()],
      ...right,
    ];
  }

  function detailLines(id, W) {
    const s = ui.state;
    const t = s.tasks[id];
    if (!t) return [];
    const L = [];
    if (t.path.length) L.push([[t.path.map((p) => `${p} ${s.tasks[p].title}`).join(' › ') + ' ›', 'dim']]);
    const st = effStatus(t);
    L.push([[`${t.id} `, 'bold'], [`${STATUS[st][0]} ${st}`, STATUS[st][1]], ['  ' + t.title, 'bold']]);
    const meta = [];
    if (t.assignee) meta.push([(t.children.length ? '▣ package owner @' : '@') + t.assignee + '  ', 'cyan']);
    else if (t.owner) meta.push([`↳ @${t.owner} via package ${packageOf(t)}  `, 'cyan']);
    const a = agentFor(t);
    if (a) meta.push([`herdr ${a.pane_id} ${a.agent_status}  `, a.stale ? 'red' : 'dim']);
    if (t.deps.length) meta.push([`deps ${t.deps.map((d) => `${d}${effStatus(s.tasks[d] || {}) === 'done' ? '✓' : ''}`).join(' ')}  `, 'dim']);
    if (t.labels.length) meta.push([`#${t.labels.join(' #')}  `, 'magenta']);
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
        const ct = s.tasks[c];
        const cs = effStatus(ct);
        L.push([[`  ${STATUS[cs][0]} `, STATUS[cs][1]], [`${c} `, 'bold'], [ct.title + ' ', ''], [ct.owner && ct.owner !== t.owner ? '@' + ct.owner : '', 'cyan'], [ct.children.length ? `  (${ct.children.length} subtasks)` : '', 'dim']]);
      }
    }
    if (t.acceptance.length) {
      L.push([], [['acceptance', 'bold']]);
      for (const ac of t.acceptance) for (const [i, l] of wrap(ac, W - 6).entries()) L.push([[i ? '      ' : `  [${t.status === 'done' ? 'x' : ' '}] `, 'dim'], [l, '']]);
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

  /** Agents tab: what each agent owns, grouped by work package, with the path to each task. */
  function agentLines(W) {
    const s = ui.state;
    const L = [];
    const actors = Object.values(s.actors).filter((a) => a.owned.length || a.packages.length || a.tasks.length);
    const unowned = s.order.filter((id) => !s.tasks[id].owner && !s.tasks[id].children.length);
    if (!actors.length) L.push([[' No assignments yet.', 'dim']]);
    for (const a of actors) {
      const owned = a.owned.map((id) => s.tasks[id]);
      const done = owned.filter((t) => t.status === 'done').length;
      const live = liveAgent(a.id);
      const [ag, ac] = live ? AGENT_GLYPH[live.agent_status] || AGENT_GLYPH.unknown : [' ', ''];
      L.push([]);
      L.push([[' ' + a.id + ' ', 'bold cyan'], [`${a.role ?? ''} `, 'dim'], [ag + ' ', ac], [live ? `${live.agent_status} in ${live.pane_id}  ` : a.inferred ? 'not started  ' : 'no live pane  ', 'dim'], ...bar(owned.length ? done / owned.length : 0, 12), [` ${done}/${owned.length}`, 'dim'], [a.last_seen ? `  seen ${ago(a.last_seen)}` : '', 'dim']]);
      // group owned leaves by the package (assigned ancestor) they belong to
      const groups = new Map();
      for (const t of owned) {
        const pkg = packageOfOwner(t, a.id) ?? '';
        if (!groups.has(pkg)) groups.set(pkg, []);
        groups.get(pkg).push(t);
      }
      for (const [pkg, ts] of groups) {
        if (pkg) {
          const p = s.tasks[pkg];
          const crumb = p.path.length ? p.path.map((x) => `${x} ${s.tasks[x].title}`).join(' › ') + ' › ' : '';
          L.push([['   ▣ ', 'cyan'], [crumb, 'dim'], [`${pkg} ${p.title}`, 'bold'], [`  ${STATUS[effStatus(p)][0]} ${p.rollup_percent ?? 0}%`, STATUS[effStatus(p)][1]]]);
        } else L.push([['   individual tasks', 'dim']]);
        for (const t of ts) {
          const st = t.status;
          const rel = pkg ? t.path.slice(t.path.indexOf(pkg) + 1) : t.path;
          const crumb = rel.length ? rel.map((x) => s.tasks[x].title).join(' › ') + ' › ' : '';
          L.push([[`     ${STATUS[st][0]} `, STATUS[st][1]], [`${t.id} `, 'bold'], [crumb, 'dim'], [t.title, TERMINAL.has(st) && st !== 'failed' ? 'dim' : ''], [st === 'in_progress' && t.percent != null ? `  ${t.percent}%` : '', 'yellow'], [st === 'todo' && t.waiting_on.length ? `  ⧗ ${t.waiting_on.join(',')}` : '', 'dim']]);
        }
      }
    }
    if (unowned.length) {
      L.push([], [[' unassigned', 'bold'], [`  ${unowned.filter((id) => s.tasks[id].ready).length} ready`, 'green']]);
      for (const id of unowned) {
        const t = s.tasks[id];
        const crumb = t.path.length ? t.path.map((x) => s.tasks[x].title).join(' › ') + ' › ' : '';
        L.push([[`     ${STATUS[t.status][0]} `, STATUS[t.status][1]], [`${t.id} `, 'bold'], [crumb, 'dim'], [t.title, ''], [t.ready ? '  ready' : '', 'green']]);
      }
    }
    return L;
  }

  /** Nearest ancestor-or-self parent task assigned to `who` (the package a task belongs to). */
  function packageOfOwner(t, who) {
    for (const id of [...t.path].reverse()) if (ui.state.tasks[id].assignee === who) return id;
    return null;
  }

  /** Plan tab: goal/description, per-branch progress, ownership summary, decisions, questions, artifacts. */
  function planLines(W) {
    const s = ui.state;
    const L = [];
    L.push([[' ' + s.title, 'bold'], [`  ${s.status}`, s.status === 'completed' ? 'green' : s.status === 'active' ? 'blue' : 'yellow']]);
    L.push([[` ${s.id} · created ${s.created_at?.slice(0, 16).replace('T', ' ') ?? '?'} by ${s.created_by ?? '?'} · updated ${ago(s.updated_at)} ago`, 'dim']]);
    if (s.goal) {
      L.push([], [[' goal', 'bold']]);
      for (const l of wrap(s.goal, W - 3)) L.push([['  ' + l, '']]);
    }
    if (s.description) {
      L.push([], [[' description', 'bold']]);
      for (const l of wrap(s.description, W - 3)) L.push([['  ' + l, '']]);
    }
    if (s.status_message) {
      L.push([], [[' outcome', 'bold']]);
      for (const l of wrap(s.status_message, W - 3)) L.push([['  ' + l, 'green']]);
    }
    // per top-level branch progress
    const roots = s.order.filter((id) => !s.tasks[id].parent || !s.tasks[s.tasks[id].parent]);
    if (roots.length) {
      L.push([], [[' breakdown', 'bold'], ['  (top-level branches)', 'dim']]);
      const nameW = Math.min(36, Math.max(...roots.map((id) => [...`${id} ${s.tasks[id].title}`].length)));
      for (const id of roots) {
        const t = s.tasks[id];
        const st = effStatus(t);
        const pct = t.children.length ? (t.rollup_percent ?? 0) : st === 'done' ? 100 : (t.percent ?? 0);
        const label = `${id} ${t.title}`;
        const name = [...label].length > nameW ? [...label].slice(0, nameW - 1).join('') + '…' : label.padEnd(nameW);
        const owners = [...new Set(s.order.filter((x) => (x === id || s.tasks[x].path.includes(id)) && s.tasks[x].owner).map((x) => s.tasks[x].owner))];
        L.push([[`  ${STATUS[st][0]} `, STATUS[st][1]], [name + ' ', t.children.length ? 'bold' : ''], ...bar(pct / 100, 10), [` ${String(pct).padStart(3)}%  `, 'dim'], [owners.join(', '), 'cyan']]);
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

  function logLines() {
    const evs = readEvents(root, ui.state.id).slice(-300).reverse();
    return evs.map((e) => {
      const d = e.data || {};
      const bits = [d.status, d.percent != null ? d.percent + '%' : null, d.assignee !== undefined ? '→ ' + (d.assignee ?? '-') : null, d.title, d.ref, d.message].filter((x) => x != null && x !== '');
      return [[`${ago(e.ts).padStart(4)} `, 'dim'], [(e.actor?.id ?? '?').slice(0, 10).padEnd(11), 'cyan'], [e.type.replace(/^task\./, '').padEnd(9), 'bold'], [e.task ? e.task + ' ' : '', ''], [bits.join(' · '), 'dim']];
    });
  }

  function helpLines() {
    const H = (t) => [[' ' + t, 'bold']];
    const T = (t, st = '') => [['   ' + t, st]];
    const sym = (g, color, name, desc) => [['   ' + g + ' ', color], [name.padEnd(13), color], [desc, '']];
    return [
      H('Views'),
      T('Tab / 1-4    Tasks · Agents · Plan · Log          p / P   next / previous plan'),
      [],
      H('Keys (Tasks view)'),
      T('↑↓ j/k  move        ←→ h/l  collapse / expand        space  toggle subtree'),
      T('⏎  details          g  go to the owning agent\'s pane'),
      T('s  spawn a subagent for the selected task or work package'),
      T('a  approve a task in review          ? help          q / esc  back / quit'),
      [],
      H('Task status: the symbol before a task'),
      sym(STATUS.todo[0], STATUS.todo[1], 'todo', 'not started (⧗ T3 = waits on dependencies)'),
      sym(STATUS.in_progress[0], STATUS.in_progress[1], 'in progress', 'an agent is working on it'),
      sym(STATUS.review[0], STATUS.review[1], 'review', 'agent finished, waiting for the coordinator to approve'),
      sym(STATUS.done[0], STATUS.done[1], 'done', 'finished (approved if it went through review)'),
      sym(STATUS.blocked[0], STATUS.blocked[1], 'blocked', 'agent cannot continue: a question, or "blocked on T8"'),
      sym(STATUS.failed[0], STATUS.failed[1], 'failed', 'agent gave up; coordinator can reopen it'),
      sym(STATUS.cancelled[0], STATUS.cancelled[1], 'cancelled', 'dropped'),
      T('Parent tasks show the combined status of their subtasks', 'dim'),
      T('(blocked if any subtask is blocked, done when all are done).', 'dim'),
      [],
      H('Agent state: the symbol after an agent name (live from herdr)'),
      sym(AGENT_GLYPH.working[0], AGENT_GLYPH.working[1], 'working', 'the agent is running'),
      sym(AGENT_GLYPH.idle[0], AGENT_GLYPH.idle[1], 'idle', 'the agent waits for input'),
      sym(AGENT_GLYPH.done[0], AGENT_GLYPH.done[1], 'done', 'the agent finished its turn'),
      sym(AGENT_GLYPH.blocked[0], AGENT_GLYPH.blocked[1], 'prompt', 'stuck at an approval/question prompt in its terminal'),
      [['   stale?         ', 'red bold'], ['task in progress but its agent idle > 90s: probably stopped without reporting', '']],
      [],
      H('Ownership and labels'),
      [['   ▣ backend      ', 'cyan bold'], ['work package: this parent task and its whole subtree belong to backend', '']],
      [['   ↳backend       ', 'cyan dim'], ['owner inherited from the package', '']],
      [['   backend        ', 'cyan'], ['assigned directly', '']],
      [['   ready          ', 'green'], ['can start now and nobody owns it yet', '']],
      [['   40%            ', 'yellow'], ['progress last reported by the agent', '']],
      [['   2/3            ', 'dim'], ['finished / total subtasks of a parent', '']],
      [],
      T(`root: ${root}`, 'dim'),
    ];
  }

  function footer() {
    if (ui.flash && ui.flash.until > Date.now()) return [[' ' + ui.flash.msg, ui.flash.style]];
    const keys = {
      tasks: '↑↓ move  ←→ fold  ⏎ details  g agent  s spawn  a approve  tab views  ? help  q quit',
      agents: '↑↓ scroll  tab views  ? help  q quit',
      plan: '↑↓ scroll  tab views  ? help  q quit',
      log: '↑↓ scroll  tab views  ? help  q quit',
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

  function draw() {
    const W = out.columns || 80;
    const H = out.rows || 24;
    const lines = [...header(W), [['─'.repeat(W), 'gray']]];
    const bodyH = H - lines.length - 1;
    const v = view();

    if (!ui.state) lines.push([[' No plans yet. Create one with `atf plan new <title>`.', 'dim']]);
    else if (v === 'help') scrolled(lines, helpLines(), 'help', bodyH); else if (v === 'detail') scrolled(lines, detailLines(ui.rows[ui.sel], W), 'detail', bodyH);
    else if (v === 'agents') scrolled(lines, agentLines(W), 'agents', bodyH);
    else if (v === 'plan') scrolled(lines, planLines(W), 'plan', bodyH);
    else if (v === 'log') scrolled(lines, logLines(), 'log', bodyH);
    else {
      // tasks: tree on top, attention + preview of the selected task below if room
      const attention = ui.state.order.map((id) => ui.state.tasks[id]).filter((t) => t.status === 'blocked' || t.status === 'review' || agentFor(t)?.stale);
      const listH = Math.min(ui.rows.length, Math.max(3, Math.floor(bodyH * 0.6)));
      if (ui.sel < ui.scroll) ui.scroll = ui.sel;
      if (ui.sel >= ui.scroll + listH) ui.scroll = ui.sel - listH + 1;
      for (let i = ui.scroll; i < Math.min(ui.rows.length, ui.scroll + listH); i++) lines.push(taskRow(ui.rows[i], W, i === ui.sel));
      if (!ui.rows.length) lines.push([[' No tasks yet. Add with `atf add <title>`.', 'dim']]);
      if (ui.rows.length > listH) lines.push([[`  … ${ui.rows.length - listH} more (${ui.scroll + 1}-${ui.scroll + listH})`, 'dim']]);
      let room = bodyH - (lines.length - 4);
      if (attention.length && room > 2) {
        const att = [
          [['─ needs attention ', 'red bold'], ['─'.repeat(Math.max(0, W - 18)), 'gray']],
          ...attention.map((t) => {
            const kind = agentFor(t)?.stale ? 'stale?' : t.status;
            return [[` ${t.id} `, 'bold'], [`${kind} `, kind === 'review' ? 'magenta' : 'red'], [t.last_message || t.title, 'dim']];
          }),
        ];
        lines.push(...att.slice(0, room));
        room -= att.length;
      }
      if (room > 3 && ui.rows.length) {
        lines.push([['─'.repeat(W), 'gray']]);
        lines.push(...detailLines(ui.rows[ui.sel], W).slice(0, room - 1));
      }
    }
    while (lines.length < H - 1) lines.push([]);
    lines.length = H - 1;
    lines.push(footer());
    out.write(`${ESC}H` + lines.map((l) => fit(l, W) + `${ESC}K`).join('\r\n'));
  }

  // ---------- actions ----------
  const selected = () => ui.state?.tasks[ui.rows[ui.sel]];

  async function goToAgent() {
    const t = selected();
    if (!t?.owner) return flash('task has no owner');
    const pane = ui.state.actors[t.owner]?.ctx?.herdr_pane;
    let ok = await herdrAsync(['agent', 'focus', t.owner]);
    if (!ok && pane) ok = await herdrAsync(['agent', 'focus', pane]);
    if (!ok) return flash(`no live herdr agent for ${t.owner}`, 'red');
    if (popup) quit(); // let the popup close so the agent pane is visible
  }

  function spawnAgent() {
    const t = selected();
    if (!t) return;
    const isPackage = t.children.length > 0;
    if (isPackage && TERMINAL.has(effStatus(t))) return flash(`${t.id} is already ${effStatus(t)}`);
    if (!isPackage && !t.ready) return flash(`${t.id} is not ready (${t.status}${t.waiting_on.length ? ', waits on ' + t.waiting_on.join(',') : ''})`);
    if (!spawnCmd) return flash('spawn unavailable');
    flash(`spawning agent for ${isPackage ? 'package ' : ''}${t.id}…`, 'blue');
    const args = [...spawnCmd, 'spawn', t.id, '--plan', ui.state.id];
    if (targetPane) args.push('--target-pane', targetPane);
    const p = spawn(args[0], args.slice(1), { env: { ...process.env, ATF_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stderr.on('data', (d) => (buf += d));
    p.on('error', (e) => flash(`spawn failed: ${e.message}`, 'red'));
    p.on('close', (code) => flash(code === 0 ? buf.trim().split('\n').pop() : `spawn failed: ${buf.trim().split('\n').pop()}`, code === 0 ? 'green' : 'red'));
  }

  function approve() {
    const t = selected();
    if (!t || t.status !== 'review') return flash('only tasks in review can be approved');
    try {
      transact(root, ui.state.id, resolveActor({ role: 'coordinator' }), (st) =>
        st.tasks[t.id].status === 'review' ? [{ type: 'task.status', task: t.id, data: { status: 'done', message: `approved via board: ${t.last_message ?? ''}`.trim() } }] : [],
      );
      flash(`${t.id} approved`, 'green');
      reloadCurrent();
    } catch (e) {
      flash(e.message, 'red');
    }
  }

  function setCollapsed(id, on) {
    const t = ui.state?.tasks[id];
    if (!t?.children.length) return false;
    if (on) ui.collapsed.add(id);
    else ui.collapsed.delete(id);
    setPlan();
    return true;
  }

  // ---------- lifecycle ----------
  const watched = new Set();
  function watchAll() {
    for (const id of listPlanIds(root)) {
      const p = eventsPath(root, id);
      if (watched.has(p)) continue;
      watched.add(p);
      fs.watchFile(p, { interval: 250 }, () => {
        if (ui.state?.id === id) reloadCurrent();
        else loadPlans();
        if (inHerdr() && !hookNotifies) sync(root);
        draw();
      });
    }
  }

  function quit() {
    for (const p of watched) fs.unwatchFile(p);
    out.write(`${ESC}?25h${ESC}?1049l`);
    process.exit(0);
  }

  const UP = ['\x1b[A', 'k'];
  const DOWN = ['\x1b[B', 'j'];
  function onKey(k) {
    const n = ui.rows.length;
    const page = Math.max(1, (out.rows || 24) - 8);
    const v = view();
    if (k === 'q' || k === '\x03') {
      if (ui.overlay && k === 'q') ui.overlay = null;
      else return quit();
    } else if (v === 'help') {
      if (UP.includes(k)) ui.scrolls.help = Math.max(0, (ui.scrolls.help ?? 0) - 1);
      else if (DOWN.includes(k)) ui.scrolls.help = (ui.scrolls.help ?? 0) + 1;
      else ui.overlay = null;
    }
    else if (k === '\x1b') {
      if (ui.overlay) ui.overlay = null;
      else if (ui.tab !== 'tasks') ui.tab = 'tasks';
      else return quit();
    } else if (k === '\t' || k === '\x1b[Z') {
      const i = TABS.findIndex(([id]) => id === ui.tab);
      ui.tab = TABS[(i + (k === '\t' ? 1 : TABS.length - 1)) % TABS.length][0];
      ui.overlay = null;
    } else if (/^[1-4]$/.test(k)) {
      ui.tab = TABS[Number(k) - 1][0];
      ui.overlay = null;
    } else if (k === '?') ui.overlay = 'help';
    else if (k === 'p' || k === 'P') {
      if (ui.plans.length > 1) {
        ui.planIdx = (ui.planIdx + (k === 'p' ? 1 : ui.plans.length - 1)) % ui.plans.length;
        ui.sel = 0;
        ui.scrolls = {};
        setPlan();
      }
    } else if (v === 'tasks') {
      const t = selected();
      if (UP.includes(k)) ui.sel = Math.max(0, ui.sel - 1);
      else if (DOWN.includes(k)) ui.sel = Math.min(n - 1, ui.sel + 1);
      else if (k === '\x1b[5~') ui.sel = Math.max(0, ui.sel - page);
      else if (k === '\x1b[6~') ui.sel = Math.min(n - 1, ui.sel + page);
      else if (k === '\x1b[H') ui.sel = 0;
      else if (k === 'G' || k === '\x1b[F') ui.sel = n - 1;
      else if (k === '\x1b[D' || k === 'h') {
        // collapse, or jump to parent
        if (!(t?.children.length && !ui.collapsed.has(t.id) && setCollapsed(t.id, true)) && t?.parent) ui.sel = Math.max(0, ui.rows.indexOf(t.parent));
      } else if (k === '\x1b[C' || k === 'l') {
        if (t && ui.collapsed.has(t.id)) setCollapsed(t.id, false);
        else if (t?.children.length) ui.sel = Math.min(n - 1, ui.sel + 1);
      } else if (k === ' ') t && setCollapsed(t.id, !ui.collapsed.has(t.id));
      else if (k === '\r') (ui.overlay = 'detail'), (ui.scrolls.detail = 0);
      else if (k === 'g') return goToAgent();
      else if (k === 's') return spawnAgent();
      else if (k === 'a') return approve();
      else if (k === 'r') loadPlans();
    } else {
      // scrollable views
      const key = v;
      if (UP.includes(k)) ui.scrolls[key] = Math.max(0, (ui.scrolls[key] ?? 0) - 1);
      else if (DOWN.includes(k)) ui.scrolls[key] = (ui.scrolls[key] ?? 0) + 1;
      else if (k === '\x1b[5~') ui.scrolls[key] = Math.max(0, (ui.scrolls[key] ?? 0) - page);
      else if (k === '\x1b[6~') ui.scrolls[key] = (ui.scrolls[key] ?? 0) + page;
      else if (k === '\r' && v === 'detail') ui.overlay = null;
      else if (v === 'detail' && k === 'g') return goToAgent();
      else if (v === 'detail' && k === 's') return spawnAgent();
      else if (v === 'detail' && k === 'a') return approve();
    }
    draw();
  }

  out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit);
  out.on('resize', draw);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    // split bursts of keys, keeping escape sequences together
    const keys = d.match(/\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|\x1b|[\s\S]/g) || [];
    for (const k of keys) onKey(k);
  });

  loadPlans();
  watchAll();
  if (inHerdr() && !hookNotifies) sync(root);
  for (const s of ui.plans) ui.lastSeqSeen.set(s.id, s.last_seq);
  draw();
  refreshAgents();
  setInterval(refreshAgents, 3000);
  // agents go idle after their last write (no hook fires then): sweep periodically too
  if (inHerdr()) setInterval(() => lifecycleSweep(root), 20_000);
  setInterval(() => {
    if (listPlanIds(root).length !== ui.plans.length) loadPlans(); // plan created/removed
    watchAll();
    draw(); // refresh relative times / flash expiry
  }, 2000);
}
