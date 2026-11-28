// Agent terminals: xterm.js on the agents' sessions in atf-sessiond, through one WebSocket
// to atf-web (which relays to the daemon). A terminal shows in the bottom panel or as an
// editor tab (it moves between them); several can be visible at once. Closing it, the
// tab or the browser leaves the agent running; reconnecting replays its screen.
import { Terminal } from './vendor/xterm/xterm.mjs';
import { FitAddon } from './vendor/xterm/addon-fit.mjs';
import { WebglAddon } from './vendor/xterm/addon-webgl.mjs';

const css = getComputedStyle(document.documentElement);
const v = (n) => css.getPropertyValue(`--term-${n}`).trim();
const THEME_KEYS = ['background', 'foreground', 'cursor', 'selection', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const theme = () => Object.fromEntries(THEME_KEYS.map((k) => [k === 'selection' ? 'selectionBackground' : k, v(k)]));

/** `onLeave()`: ctrl+] left a terminal. `onState(up)`: the connection. `onFocus(id|null)`. */
export function createTerms({ onLeave = () => {}, onState = () => {}, onFocus = () => {} } = {}) {
  let ws = null;
  const open = new Map(); // session id -> {term, fit, el, attached, size}
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      onState(true);
      for (const [id, t] of open) {
        t.el.querySelector('.banner')?.remove();
        t.attached = false;
        send({ op: 'attach', id });
      }
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

  const FONT = "'JetBrains Mono', monospace";
  // weight and size from the stylesheet (--term-font-weight, --term-font-weight-bold, --term-font-size)
  const css = (name, dflt) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || dflt;
  const fontOpts = () => ({ fontFamily: FONT, fontWeight: css('--term-font-weight', '400'), fontWeightBold: css('--term-font-weight-bold', '700'), fontSize: Number(css('--term-font-size', '13')) });
  const fontReady = (() => {
    const o = fontOpts();
    return Promise.all([`${o.fontWeight} ${o.fontSize}px`, `${o.fontWeightBold} ${o.fontSize}px`, `italic ${o.fontWeight} ${o.fontSize}px`].map((f) => document.fonts.load(`${f} 'JetBrains Mono'`))).catch(() => {});
  })();

  function ensure(id) {
    if (open.has(id)) return open.get(id);
    const el = document.createElement('div');
    el.className = 'term';
    const term = new Terminal({ ...fontOpts(), theme: theme(), cursorBlink: true, scrollback: 10000, allowProposedApi: true });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const t = { term, fit: fitAddon, el, attached: false, size: '', opened: false };
    open.set(id, t);
    // ctrl+] leaves the terminal (as atf-sessions attach detaches): the page has the keys again
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && (e.key === ']' || e.code === 'BracketRight')) {
        term.blur();
        onLeave(id);
        return false;
      }
      return true;
    });
    term.onData((data) => send({ op: 'input', id, data }));
    term.onBinary((data) => send({ op: 'input', id, data }));
    term.textarea?.addEventListener?.('focus', () => onFocus(id));
    new ResizeObserver(() => fit(id)).observe(el);
    send({ op: 'attach', id });
    return t;
  }

  /** xterm opens once it is in the document (it measures its cells there). */
  function realize(t, id) {
    if (t.opened) return;
    t.term.open(t.el);
    t.opened = true;
    try {
      const gl = new WebglAddon(); // draws box-drawing characters itself: lines without gaps
      gl.onContextLoss(() => gl.dispose());
      t.term.loadAddon(gl);
    } catch (e) {
      console.warn('atf: WebGL renderer unavailable, using the DOM renderer', e);
    }
    t.term.textarea?.addEventListener('focus', () => onFocus(id));
    t.term.textarea?.addEventListener('blur', () => onFocus(null));
    // a terminal opened before the font arrived measured and drew a fallback font: once it is
    // loaded, set the font again (xterm measures anew, the renderer redraws its glyphs)
    fontReady.then(() => {
      t.term.options.fontFamily = 'monospace';
      t.term.options.fontFamily = FONT;
      fit(id, true);
    });
  }

  function fit(id, force = false) {
    const t = open.get(id);
    if (!t || !t.attached || !t.el.isConnected || !t.el.offsetWidth || !t.el.offsetHeight) return;
    t.fit.fit();
    const size = `${t.term.cols}x${t.term.rows}`;
    if (force || size !== t.size) (t.size = size), send({ op: 'resize', id, cols: t.term.cols, rows: t.term.rows });
  }

  return {
    connect,
    /** Show session `id` in `host` (the panel, or an editor tab's page): moved there if it was elsewhere. */
    place(id, host, { focus = false } = {}) {
      const t = ensure(id);
      if (t.el.parentNode !== host) host.append(t.el);
      for (const el of host.querySelectorAll(':scope > .term')) el.classList.toggle('on', el === t.el);
      realize(t, id);
      requestAnimationFrame(() => {
        fit(id, true);
        t.term.refresh(0, t.term.rows - 1);
        if (focus) t.term.focus();
      });
    },
    /** Hide whatever shows in `host`. */
    clear(host) {
      for (const el of host.querySelectorAll(':scope > .term')) el.classList.remove('on');
    },
    focus: (id) => open.get(id)?.term.focus(),
    /** Where session `id` shows now (its element's parent), or null. */
    hostOf: (id) => open.get(id)?.el.parentNode ?? null,
    /** Stop watching sessions that are gone (detaches from them). */
    keep(ids) {
      for (const [id, t] of open)
        if (!ids.has(id)) {
          send({ op: 'detach', id });
          t.term.dispose();
          t.el.remove();
          open.delete(id);
        }
    },
    refit() {
      for (const id of open.keys()) fit(id, true);
    },
  };
}
