// Spike: sessions in the browser. One WebSocket to atf-web, which relays to the session
// daemon. Terminals are xterm.js; the agents keep running when the page closes.
import { Terminal } from './vendor/xterm/xterm.mjs';
import { FitAddon } from './vendor/xterm/addon-fit.mjs';

const $ = (s) => document.querySelector(s);
const css = getComputedStyle(document.documentElement);
const v = (n) => css.getPropertyValue(`--term-${n}`).trim();
const THEME = Object.fromEntries(['background', 'foreground', 'cursor', 'selection', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'].map((k) => [k === 'selection' ? 'selectionBackground' : k, v(k)]));
const IDLE_MS = 5000;

let ws = null;
let sessions = []; // from the daemon
const open = new Map(); // id -> {term, fit, el, attached}
let active = localStorage.getItem('atf.active') || null;
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    $('#conn').classList.add('up');
    document.querySelectorAll('.banner').forEach((b) => b.remove());
    send({ op: 'list' });
    for (const [id, t] of open) (t.attached = false), send({ op: 'attach', id });
  };
  ws.onmessage = (e) => onEvent(JSON.parse(e.data));
  ws.onclose = () => {
    $('#conn').classList.remove('up');
    for (const t of open.values()) if (!t.el.querySelector('.banner')) t.el.insertAdjacentHTML('beforeend', '<div class="banner">reconnecting…</div>');
    setTimeout(connect, 1000);
  };
}

function onEvent(m) {
  if (m.ev === 'sessions') {
    sessions = m.list;
    for (const id of open.keys()) if (!sessions.some((s) => s.id === id)) closeTab(id, false);
    if (active && !open.has(active) && sessions.some((s) => s.id === active)) openTab(active);
    return render();
  }
  if (m.ev === 'created') return openTab(m.id);
  const t = open.get(m.id);
  if (m.ev === 'replay' && t) {
    t.term.reset();
    if (m.cols && m.rows) t.term.resize(m.cols, m.rows); // replay at the size it was written
    t.term.write(m.data, () => {
      t.attached = true;
      fitTab(m.id, true);
    });
  } else if (m.ev === 'out' && t) t.term.write(m.data);
  else if (m.ev === 'exit' && t) t.term.write(`\r\n\x1b[2m[exited ${m.code}]\x1b[0m\r\n`);
  else if (m.ev === 'error') console.warn('atf:', m.message);
}

function openTab(id) {
  if (!open.has(id)) {
    const el = document.createElement('div');
    el.className = 'term';
    $('#terms').append(el);
    const term = new Terminal({ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, theme: THEME, cursorBlink: true, scrollback: 10000, allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.onData((data) => send({ op: 'input', id, data }));
    term.onBinary((data) => send({ op: 'input', id, data }));
    const t = { term, fit, el, attached: false, size: '' };
    open.set(id, t);
    new ResizeObserver(() => fitTab(id)).observe(el);
    send({ op: 'attach', id });
  }
  activate(id);
}

function fitTab(id, force = false) {
  const t = open.get(id);
  if (!t || !t.el.classList.contains('active') || !t.attached) return;
  t.fit.fit();
  const size = `${t.term.cols}x${t.term.rows}`;
  if (force || size !== t.size) (t.size = size), send({ op: 'resize', id, cols: t.term.cols, rows: t.term.rows });
}

function activate(id) {
  active = id;
  localStorage.setItem('atf.active', id);
  for (const [k, t] of open) t.el.classList.toggle('active', k === id);
  $('#empty').style.display = open.size ? 'none' : '';
  requestAnimationFrame(() => {
    fitTab(id, true);
    open.get(id)?.term.focus();
  });
  render();
}

function closeTab(id, detach = true) {
  const t = open.get(id);
  if (!t) return;
  if (detach) send({ op: 'detach', id });
  t.term.dispose();
  t.el.remove();
  open.delete(id);
  if (active === id) {
    const next = [...open.keys()].pop();
    next ? activate(next) : ((active = null), localStorage.removeItem('atf.active'), ($('#empty').style.display = ''));
  }
  render();
}

const state = (s) => (s.exited ? 'exited' : Date.now() - s.lastOutput < IDLE_MS ? 'working' : 'idle');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function render() {
  $('#sessions').innerHTML = sessions
    .map((s) => `<li data-id="${s.id}" class="${s.id === active ? 'active' : ''}" title="${esc(s.cmd || '')}  ·  ${esc(s.cwd)}"><span class="dot ${state(s)}"></span><span class="name">${esc(s.name)}</span><span class="meta">${s.exited ? `exit ${esc(s.code)}` : esc(s.cwd.split('/').pop())}</span></li>`)
    .join('');
  $('#tabs').innerHTML = [...open.keys()]
    .map((id) => {
      const s = sessions.find((x) => x.id === id);
      return `<div class="tab ${id === active ? 'active' : ''}" data-id="${id}"><span>${esc(s?.name || id)}</span><button class="close" data-close="${id}" title="close tab (the session keeps running)">×</button></div>`;
    })
    .join('');
}

$('#sessions').onclick = (e) => {
  const li = e.target.closest('li');
  if (li) openTab(li.dataset.id);
};
$('#sessions').oncontextmenu = (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  const s = sessions.find((x) => x.id === li.dataset.id);
  if (confirm(s.exited ? `Remove ${s.name}?` : `Stop ${s.name}?`)) send({ op: s.exited ? 'remove' : 'kill', id: s.id });
};
$('#tabs').onclick = (e) => {
  if (e.target.dataset.close) return closeTab(e.target.dataset.close);
  const tab = e.target.closest('.tab');
  if (tab) activate(tab.dataset.id);
};
document.querySelectorAll('.presets button').forEach((b) => (b.onclick = () => (($('#new').cmd.value = b.dataset.cmd), $('#new').name.value || ($('#new').name.value = b.textContent))));
$('#new').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  const box = $('#terms').getBoundingClientRect();
  send({ op: 'create', name: f.name.value || f.cmd.value || 'shell', cmd: f.cmd.value || '$SHELL -l', cwd: f.cwd.value || '~', cols: Math.floor((box.width - 8) / 7.8), rows: Math.floor((box.height - 6) / 17) });
  f.name.value = '';
};
setInterval(render, 2000); // idle dots
connect();
