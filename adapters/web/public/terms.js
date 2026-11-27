// Agent panes: xterm.js terminals on the agents' sessions in atf-sessiond, through one
// WebSocket to atf-web (which relays to the daemon). Closing a pane, the tab or the browser
// leaves the agent running; reconnecting replays its screen.
import { Terminal } from './vendor/xterm/xterm.mjs';
import { FitAddon } from './vendor/xterm/addon-fit.mjs';
import { WebglAddon } from './vendor/xterm/addon-webgl.mjs';

const css = getComputedStyle(document.documentElement);
const v = (n) => css.getPropertyValue(`--term-${n}`).trim();
const THEME_KEYS = ['background', 'foreground', 'cursor', 'selection', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const theme = () => Object.fromEntries(THEME_KEYS.map((k) => [k === 'selection' ? 'selectionBackground' : k, v(k)]));

/**
 * The panes. `host`: the element terminals go in. `onLeave()`: the user left the terminal
 * with ctrl+] (focus goes back to the board). `onState(up)`: the connection.
 */
export function createTerms({ host, onLeave = () => {}, onState = () => {} }) {
  let ws = null;
  const open = new Map(); // session id -> {term, fit, el, attached, size}
  let active = null;
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      onState(true);
      host.querySelectorAll('.banner').forEach((b) => b.remove());
      for (const [id, t] of open) (t.attached = false), send({ op: 'attach', id });
    };
    ws.onmessage = (e) => onEvent(JSON.parse(e.data));
    ws.onclose = () => {
      onState(false);
      for (const t of open.values()) if (!t.el.querySelector('.banner')) t.el.insertAdjacentHTML('beforeend', '<div class="banner">reconnecting…</div>');
      setTimeout(connect, 1000);
    };
  }

  function onEvent(m) {
    const t = open.get(m.id);
    if (!t) return;
    if (m.ev === 'replay') {
      t.term.reset();
      if (m.cols && m.rows) t.term.resize(m.cols, m.rows); // replay at the size it was written
      t.term.write(m.data, () => {
        t.attached = true;
        fit(m.id, true);
      });
      if (m.exited) t.term.write(`\r\n\x1b[2m[session ended: exit ${m.code}]\x1b[0m\r\n`);
    } else if (m.ev === 'out') t.term.write(m.data);
    else if (m.ev === 'exit') t.term.write(`\r\n\x1b[2m[session ended: exit ${m.code}]\x1b[0m\r\n`);
  }

  function useWebgl(term) {
    // draws box-drawing and block characters itself: lines without gaps
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch (e) {
      console.warn('atf: WebGL renderer unavailable, using the DOM renderer', e);
    }
  }

  function ensure(id) {
    if (open.has(id)) return open.get(id);
    const el = document.createElement('div');
    el.className = 'term';
    host.append(el);
    const term = new Terminal({ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, theme: theme(), cursorBlink: true, scrollback: 10000, allowProposedApi: true });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    useWebgl(term);
    // ctrl+] leaves the terminal (as atf-sessions attach detaches): the board has the keys again
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && (e.key === ']' || e.code === 'BracketRight')) {
        term.blur();
        onLeave();
        return false;
      }
      return true;
    });
    term.onData((data) => send({ op: 'input', id, data }));
    term.onBinary((data) => send({ op: 'input', id, data }));
    const t = { term, fit: fitAddon, el, attached: false, size: '' };
    open.set(id, t);
    new ResizeObserver(() => fit(id)).observe(el);
    send({ op: 'attach', id });
    return t;
  }

  function fit(id, force = false) {
    const t = open.get(id);
    if (!t || id !== active || !t.attached || !t.el.offsetWidth) return;
    t.fit.fit();
    const size = `${t.term.cols}x${t.term.rows}`;
    if (force || size !== t.size) (t.size = size), send({ op: 'resize', id, cols: t.term.cols, rows: t.term.rows });
  }

  return {
    connect,
    /** Show session `id` (attaching to it the first time); null shows none. */
    show(id, { focus = false } = {}) {
      active = id;
      if (id) ensure(id);
      for (const [k, t] of open) t.el.classList.toggle('on', k === id);
      requestAnimationFrame(() => {
        fit(id, true);
        if (focus) open.get(id)?.term.focus();
      });
    },
    focus: () => open.get(active)?.term.focus(),
    /** Stop showing sessions that are gone (detaches from them). */
    keep(ids) {
      for (const [id, t] of open)
        if (!ids.has(id)) {
          send({ op: 'detach', id });
          t.term.dispose();
          t.el.remove();
          open.delete(id);
        }
    },
    refit: () => fit(active, true),
    get active() {
      return active;
    },
  };
}
