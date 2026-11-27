// ATF's session daemon as a backend of the launcher (src/launch.mjs): agents in sessions
// of atf-sessiond (src/sessiond.mjs) instead of herdr panes. Used where herdr is not, e.g.
// by the web UI (docs/webui-design.md §4.1-4.3).
//
// The launcher is synchronous (it runs inside `atf spawn`), so is this client: each call
// is a short child process that talks to the daemon's socket. The web server uses the
// asynchronous connect() for terminals.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketPath } from './sessiond.mjs';
import { readAgentStatus } from './live.mjs';
import { readConfigFile } from './toml.mjs';
import { userConfigDir } from './config.mjs';

export { socketPath };
const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessiond.mjs');
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// one request, one reply: run as `node -e CLIENT <socket>` with the request on stdin
const CLIENT = `
const net = require('node:net');
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const req = { ...JSON.parse(input), rid: 1 };
  const c = net.connect(process.argv[1]);
  let rest = '';
  c.on('connect', () => c.write(JSON.stringify(req) + '\\n'));
  c.on('data', (d) => {
    rest += d;
    let i;
    while ((i = rest.indexOf('\\n')) >= 0) {
      const m = JSON.parse(rest.slice(0, i));
      rest = rest.slice(i + 1);
      if (m.rid === 1) { process.stdout.write(JSON.stringify(m)); c.destroy(); process.exit(0); }
    }
  });
  c.on('error', (e) => { process.stdout.write(JSON.stringify({ ev: 'error', down: true, message: e.code || e.message })); process.exit(0); });
});`;

/** A request to the daemon, synchronously: its reply ({ev:'ok', …}); throws on an error. */
export function call(req, socket = socketPath()) {
  const r = spawnSync(process.execPath, ['-e', CLIENT, socket], { input: JSON.stringify(req), encoding: 'utf8', timeout: 10_000 });
  let m;
  try {
    m = JSON.parse(r.stdout);
  } catch {
    throw Object.assign(new Error(`atf-sessiond did not answer (${r.error?.message || r.stderr || 'no reply'})`), { down: true });
  }
  if (m.ev === 'error') throw Object.assign(new Error(m.down ? `atf-sessiond is not running (${m.message})` : m.message), { down: !!m.down });
  return m;
}

/** Is a daemon listening on the socket? */
export function daemonUp(socket = socketPath()) {
  if (!fs.existsSync(socket)) return false;
  try {
    call({ op: 'list' }, socket);
    return true;
  } catch {
    return false;
  }
}

/** Start the daemon unless it runs (detached: it outlives whoever started it). */
export function ensureDaemon(socket = socketPath()) {
  if (daemonUp(socket)) return false;
  if (Buffer.byteLength(socket) > 103) throw new Error(`socket path too long for a Unix socket: ${socket}; set ATF_SESSIOND_SOCKET to a shorter one`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ATF_(?!SESSIOND)|HERDR_)/.test(k)));
  const d = spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', cwd: os.homedir(), env: { ...env, ATF_SESSIOND_SOCKET: socket } });
  d.unref();
  for (const t0 = Date.now(); Date.now() - t0 < 5000; sleepMs(50)) if (daemonUp(socket)) return true;
  throw new Error(`atf-sessiond did not start (socket ${socket})`);
}

/**
 * An asynchronous connection (terminals, live session lists): returns {send(req),
 * request(req) -> Promise<reply>, close()}; `onEvent` gets every event.
 */
export function connect(onEvent = () => {}, socket = socketPath()) {
  const c = net.connect(socket);
  const waiting = new Map();
  let rid = 0,
    rest = '';
  c.setEncoding('utf8');
  c.on('data', (d) => {
    rest += d;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const m = JSON.parse(rest.slice(0, i));
      rest = rest.slice(i + 1);
      const w = m.rid != null && waiting.get(m.rid);
      if (w) {
        waiting.delete(m.rid);
        m.ev === 'error' ? w.reject(new Error(m.message)) : w.resolve(m);
      } else onEvent(m);
    }
  });
  const fail = (e) => {
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
    onEvent({ ev: 'closed', error: e?.message });
  };
  c.on('error', fail);
  c.on('close', () => fail(new Error('connection closed')));
  return {
    socket: c,
    send: (req) => c.write(JSON.stringify(req) + '\n'),
    request: (req) =>
      new Promise((resolve, reject) => {
        const id = ++rid;
        waiting.set(id, { resolve, reject });
        c.write(JSON.stringify({ ...req, rid: id }) + '\n');
      }),
    close: () => c.destroy(),
  };
}

// ---------- the backend ----------
/** The sessions backend's settings: [sessions] in ~/.config/atf/config.toml. */
export const sessionsConfig = () => readConfigFile(userConfigDir()).data?.sessions || {};
export const sessionsStateDir = () => {
  const d = process.env.ATF_SESSIONS_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'atf/sessions');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// the states programs report in OSC 7501, as backend statuses
const STATES = { idle: 'idle', working: 'working', busy: 'working', blocked: 'blocked', done: 'done' };
// no output for this long: idle (for agents whose harness does not report its status)
const QUIET_MS = 8000;
// a kind without a `prompt` argument gets its first prompt typed in once its screen has
// been quiet this long after the first output (it is ready for input)
const READY_QUIET_MS = 1500;
const READY_MAX_MS = 30_000;

/** The same project directory, however it is spelled (macOS: /var is /private/var). */
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const sameRoot = (a, b) => !!a && !!b && (a === b || real(a) === real(b));

/** Environment variables of the launcher's process an agent must not inherit. */
const inherited = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ATF_(?!SESSIOND_SOCKET|NODE)|HERDR_|TMUX)/.test(k)));

/**
 * What the agent in session `x` (a daemon list entry) is doing: the latest of its
 * extension's report and the state the program writes to its terminal (OSC 7501,
 * Copilot), else the terminal's activity. -> {status, since}
 */
export function sessionStatus(x) {
  if (x.exited) return { status: 'done', since: x.lastOutput };
  const m = x.meta || {};
  const reported = m.root && m.plan && m.actor ? readAgentStatus(m.root, m.plan, m.actor) : null;
  const said = [reported && { status: reported.status, since: Date.parse(reported.since) }, x.appState && STATES[x.appState.state] && { status: STATES[x.appState.state], since: x.appState.at }].filter(Boolean);
  if (said.length) return said.sort((a, b) => b.since - a.since)[0];
  const quiet = Date.now() - x.lastOutput;
  return quiet < QUIET_MS ? { status: 'working', since: x.lastOutput } : { status: 'idle', since: x.lastOutput };
}

/** A session as the launcher's agent: {name, actor, handle, role, task, plan, kind, status, since}. */
export const sessionAgent = (x) => ({ name: x.meta?.name || x.name, actor: x.meta?.actor || x.meta?.name || x.name, handle: x.id, workspace: null, role: x.meta?.role || null, task: x.meta?.task || null, plan: x.meta?.plan || null, kind: x.meta?.kind || null, exited: !!x.exited, code: x.code ?? null, ...sessionStatus(x) });

/**
 * The daemon's sessions as a liveness source of src/attention.mjs, from a session list
 * (the web server keeps one current). An actor whose writes came from herdr or another
 * daemon runs elsewhere. `st.root` must be set (the plan's project).
 */
export function sessionsLiveness(list, socket = socketPath()) {
  const agents = list.filter((x) => !x.exited).map((x) => ({ x, a: sessionAgent(x) }));
  return {
    known: true,
    local: (actor) => (actor?.ctx?.sessiond ? actor.ctx.sessiond === socket : !actor?.ctx?.herdr_pane),
    agent(st, actorId) {
      const here = agents.filter(({ x }) => sameRoot(x.meta?.root, st.root));
      const hit = here.find(({ x, a }) => a.actor === actorId && x.meta?.plan === st.id) || here.find(({ a }) => a.actor === actorId) || here.find(({ a }) => a.name === actorId);
      return hit ? hit.a : null;
    },
  };
}

/**
 * The backend (see the interface in src/launch.mjs). Sessions carry the launcher's meta
 * {root, plan, name, actor, role, kind, task}; agents are found by it.
 */
export function sessionsBackend({ socket = socketPath() } = {}) {
  const pending = new Map(); // handle -> spec of an agent opened but not started yet (begin)
  const sessions = () => call({ op: 'list' }, socket).list;
  const live = () => sessions().filter((x) => !x.exited);
  const byHandle = (h) => sessions().find((x) => x.id === h || (x.meta?.name === h && !x.exited)) || null;

  const asAgent = sessionAgent;

  function paste(handle, text, x = byHandle(handle)) {
    // bracketed paste (when the program takes it): a multi-line prompt arrives as one
    // message, then Enter sends it; otherwise its lines are joined, so Enter sends it whole
    const data = x?.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : String(text).replace(/\s*\n\s*/g, ' ');
    call({ op: 'input', id: handle, data }, socket);
    sleepMs(150);
    call({ op: 'input', id: handle, data: '\r' }, socket);
  }

  const backend = {
    name: 'sessions',
    stateDir: sessionsStateDir,
    config: sessionsConfig,
    // one daemon per user: an actor whose agent ran under another daemon is not ours
    local: (actor) => !actor?.ctx?.sessiond || actor.ctx.sessiond === socket,
    socket: () => socket,
    /** Every session, exited ones included (the supervisor, `atf-sessions list`). */
    sessions,
    agents(root) {
      const m = new Map();
      for (const x of live()) if (sameRoot(x.meta?.root, root)) m.set(x.meta.name || x.name, asAgent(x));
      return m;
    },
    /** By name, else by the actor it runs as (a coordinator renamed for uniqueness), else by the session its last write came from. */
    find(s, actor, agents) {
      const all = [...agents.values()];
      const a = agents.get(actor.id) || all.find((x) => x.actor === actor.id) || (actor.ctx?.atf_session && all.find((x) => x.handle === actor.ctx.atf_session));
      if (!a || (s.actors[a.name] && a.name !== actor.id && a.actor !== actor.id)) return null;
      return a;
    },
    sessionRef(handle, root) {
      const x = byHandle(handle);
      if (x && x.meta?.root && !sameRoot(x.meta.root, root)) return false;
      return x?.meta?.session || null; // kinds whose id ATF picks: the launcher knows it
    },
    nameTaken: (name) => live().some((x) => (x.meta?.name || x.name) === name),
    open(spec) {
      ensureDaemon(socket);
      const handle = crypto.randomBytes(4).toString('hex');
      pending.set(handle, spec);
      return { handle, workspace: null };
    },
    /** Start an opened agent with its first prompt (on its command line when the kind takes one). */
    begin(handle, text) {
      const spec = pending.get(handle);
      if (!spec) return text ? backend.prompt(handle, text) : true;
      pending.delete(handle);
      const { role, name, actor, kind, kindCfg = {}, args, env, cwd, root, task } = spec;
      const bin = kindCfg.bin || kind;
      const promptArgs = text && kindCfg.prompt ? kindCfg.prompt.map((a) => a.replace('{prompt}', () => text)) : [];
      const meta = { root, plan: env.ATF_PLAN || null, name, actor: actor || name, role, kind, task: task || null };
      call({
        op: 'create',
        id: handle,
        name,
        argv: [bin, ...args, ...promptArgs],
        cwd,
        env: { ...inherited(), ...env, ATF_SESSIOND_SOCKET: socket, ATF_CTX_SESSIOND: socket, ATF_CTX_ATF_SESSION: handle },
        cols: spec.cols || 120,
        rows: spec.rows || 32,
        meta,
      }, socket);
      if (text && !kindCfg.prompt) {
        // wait until it is ready for input: output came, then stopped
        const t0 = Date.now();
        for (; Date.now() - t0 < READY_MAX_MS; sleepMs(200)) {
          const x = byHandle(handle);
          if (!x || x.exited) return false;
          if (x.lastOutput > x.started && Date.now() - x.lastOutput > READY_QUIET_MS) break;
        }
        paste(handle, text);
      }
      return true;
    },
    prompt(handle, text) {
      if (pending.has(handle)) return backend.begin(handle, text);
      const x = byHandle(handle);
      if (!x || x.exited) return false;
      paste(x.id, text, x);
      return true;
    },
    interrupt: (handle) => call({ op: 'input', id: handle, data: '\x1b' }, socket),
    close: (handle) => {
      try {
        call({ op: 'remove', id: handle }, socket);
      } catch {}
    },
  };
  return backend;
}
