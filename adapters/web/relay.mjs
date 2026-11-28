// The terminals' relay (docs/webui-design.md §12c): browser <-> atf-sessiond, in a process of
// its own. atf-web checks a terminal connection (its cookie, its origin) and hands the
// connection over (child_process handle passing); from then on keystrokes and output never
// touch atf-web's event loop, so a slow refresh of the board cannot delay a shell.
//
// Run by atf-web (fork, with the daemon's socket as argument); `relay()` is also used in
// atf-web itself when this process is not running.
import { wsAccept } from './ws.mjs';
import { connect } from '../../src/sessions.mjs';

// what the browser may ask the daemon: watch and type into sessions, never start commands
export const WS_OPS = new Set(['list', 'attach', 'detach', 'input', 'resize']);

/** Relay one accepted WebSocket to the daemon at `daemonSocket`: its own daemon connection. */
export function relay(ws, daemonSocket) {
  const d = connect((m) => {
    if (m.ev === 'closed') return ws.close();
    ws.send(JSON.stringify(m));
  }, daemonSocket);
  ws.onmessage = (text) => {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!WS_OPS.has(m.op)) return ws.send(JSON.stringify({ ev: 'error', rid: m.rid, message: `not allowed from the browser: ${m.op}` }));
    d.send(m);
  };
  ws.onclose = () => d.close();
}

// as atf-web's child: connections arrive with their request's headers, already checked
if (process.send && process.argv[2]) {
  const daemonSocket = process.argv[2];
  process.on('message', (m, sock) => {
    if (m?.type !== 'ws' || !sock) return;
    sock.resume?.();
    relay(wsAccept({ headers: m.headers }, sock), daemonSocket);
  });
  process.on('disconnect', () => process.exit(0)); // atf-web is gone
  process.send({ type: 'ready' });
}
