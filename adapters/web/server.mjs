// atf-web: ATF in the browser (docs/webui-design.md §4.4). One server per user, on
// 127.0.0.1 only: reach it through one SSH tunnel (ssh -L 7420:localhost:7420 devpod).
//
//   GET  /?token=…          sets the session cookie (the URL atf-web prints)
//   GET  /api/overview      projects, their plans (open plans with their folded state),
//                           what needs the human, the plans' agents
//   GET  /api/plan          ?root&plan   one plan (closed ones too)
//   GET  /api/brief         ?root&plan[&task]   what to know to act on a task / the plan
//   GET  /api/doc           ?root&plan&doc      a plan document
//   GET  /api/log           ?root&plan[&n]      the plan's last events
//   POST /api/action        {root, plan, action, task?, message?, status?}  as the human
//   POST /api/coordinator   {root, plan, fresh?, kind?}  start / resume / replace it
//   GET  /api/stream        server-sent events: {plans: [key], sessions: bool} on changes
//   WS   /ws                the agents' terminals, relayed to atf-sessiond
//
// Reads go through store/core, writes through src/actions.mjs (the same events as the
// board and the CLI). The server also runs the supervisor (src/supervisor.mjs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { knownRoots, listPlanIds, readEvents, eventsPath } from '../../src/store.mjs';
import { fold, brief, HUMAN } from '../../src/core.mjs';
import { attentionOf } from '../../src/attention.mjs';
import { humanAction, ACTIONS } from '../../src/actions.mjs';
import { liveDir } from '../../src/live.mjs';
import { userConfigDir } from '../../src/config.mjs';
import { sessionsBackend, sessionsLiveness, sessionAgent, socketPath, ensureDaemon, connect } from '../../src/sessions.mjs';
import { startSupervisor } from '../../src/supervisor.mjs';
import { wsAccept } from './ws.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const SESSIONS_CLI = path.resolve(HERE, '../../bin/atf-sessions.mjs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
// what the browser may ask the daemon: watch and type into sessions, never start commands
const WS_OPS = new Set(['list', 'attach', 'detach', 'input', 'resize']);

/** The token in the URL atf-web prints: ~/.config/atf/web-token (0600), made once. */
export function webToken(file = path.join(userConfigDir(), 'web-token')) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const strip = ({ st, ...rest }) => rest; // attention items carry their plan; the client has it

/**
 * Start the server. Returns {server, url, port, close()}. Options: port (0: any free),
 * token, supervise (run the supervisor; default true), pollMs (change detection).
 */
export async function startWebServer({ port = 7420, host = '127.0.0.1', token = webToken(), supervise = true, pollMs = 1000, log = () => {} } = {}) {
  const socket = socketPath();
  ensureDaemon(socket);
  const backend = sessionsBackend({ socket });

  // ---------- sessions: one connection, a current list ----------
  let sessions = [];
  let daemon = null;
  const refreshSessions = async () => {
    try {
      if (!daemon) {
        daemon = connect((m) => {
          if (m.ev === 'sessions') sessions = m.list;
          if (m.ev === 'closed') daemon = null;
        }, socket);
      }
      sessions = (await daemon.request({ op: 'list' })).list;
    } catch (e) {
      daemon = null;
      try {
        ensureDaemon(socket); // it ended (atf-sessions stop): start a new one
      } catch {}
    }
  };
  await refreshSessions();

  // ---------- plans: folded once per change of their log ----------
  const planCache = new Map(); // key -> {sig, st}
  const repoCache = new Map(); // root -> git common dir (worktrees of one repository group under it)
  const roots = () => {
    const seen = new Map();
    for (const r of [...knownRoots(), ...sessions.map((x) => x.meta?.root).filter(Boolean)]) {
      const k = real(r);
      if (!seen.has(k) && fs.existsSync(path.join(k, 'plans'))) seen.set(k, k);
    }
    return [...seen.values()];
  };
  const sigOf = (root, id) => {
    try {
      const s = fs.statSync(eventsPath(root, id));
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return 'none';
    }
  };
  function plan(root, id) {
    const key = `${root}#${id}`;
    const sig = sigOf(root, id);
    const hit = planCache.get(key);
    if (hit?.sig === sig) return hit.st;
    const st = fold(readEvents(root, id));
    st.root = root;
    planCache.set(key, { sig, st });
    return st;
  }
  function repoOf(root) {
    if (!repoCache.has(root)) {
      let repo = null;
      try {
        repo = real(path.resolve(path.dirname(root), execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: path.dirname(root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()));
        repo = path.basename(repo) === '.git' ? path.dirname(repo) : repo;
      } catch {}
      repoCache.set(root, repo);
    }
    return repoCache.get(root);
  }

  const agentsOf = (root, id) => sessions.filter((x) => x.meta?.root && real(x.meta.root) === root && (x.meta.plan === id || (!x.meta.plan && x.meta.role === 'coordinator'))).map(sessionAgent);

  /** One plan for the client: its state, attention, agents. Closed plans: no attention. */
  function planView(root, id, lv = sessionsLiveness(sessions, socket)) {
    const st = plan(root, id);
    const key = `${root}#${id}`;
    const open = ['active', 'paused'].includes(st.status);
    const att = open ? attentionOf(lv, { root, id, st, key }) : { mine: [], queued: [], todos: [], coord: { id: st.coordinator || null, live: null, away: false } };
    return {
      key,
      root,
      id,
      st,
      open,
      attention: { mine: att.mine.map(strip), queued: att.queued.map(strip), todos: att.todos.map(strip) },
      coordinator: { id: att.coord.id, live: att.coord.live, away: att.coord.away },
      agents: agentsOf(root, id),
    };
  }

  function overview() {
    const lv = sessionsLiveness(sessions, socket);
    const projects = roots().map((root) => {
      const plans = listPlanIds(root).map((id) => {
        const v = planView(root, id, lv);
        if (v.open) return v;
        // a closed plan: enough to list it
        const { st } = v;
        return { key: v.key, root, id, open: false, summary: { title: st.title, status: st.status, progress: st.progress, total: st.total, updated_at: st.updated_at } };
      });
      return { root, dir: path.dirname(root), name: path.basename(path.dirname(root)), repo: repoOf(root), plans };
    });
    return { human: HUMAN, now: Date.now(), projects, sessions: sessions.length };
  }

  const known = (root, id) => {
    const r = root && real(root);
    if (!r || !roots().includes(r)) throw Object.assign(new Error(`unknown project ${root}`), { status: 404 });
    if (id && !listPlanIds(r).includes(id)) throw Object.assign(new Error(`unknown plan ${id}`), { status: 404 });
    return r;
  };

  // ---------- change detection, server-sent events ----------
  const streams = new Set();
  let lastSigs = new Map();
  let lastSessions = '';
  const liveSig = (root, id) => {
    const d = liveDir(root, id);
    const parts = [];
    for (const sub of ['', 'status']) {
      try {
        for (const f of fs.readdirSync(path.join(d, sub))) if (f.endsWith('.json')) parts.push(`${sub}/${f}:${fs.statSync(path.join(d, sub, f)).mtimeMs}`);
      } catch {}
    }
    return parts.join(',');
  };
  async function poll() {
    await refreshSessions();
    const changed = [];
    const sigs = new Map();
    for (const root of roots())
      for (const id of listPlanIds(root)) {
        const key = `${root}#${id}`;
        const sig = `${sigOf(root, id)}|${liveSig(root, id)}`;
        sigs.set(key, sig);
        if (lastSigs.get(key) !== sig) changed.push(key);
      }
    // sessions: which exist, and what their agents do
    const sSig = sessions.map((x) => `${x.id}:${x.exited}:${sessionAgent(x).status}`).join(',');
    const sChanged = sSig !== lastSessions;
    lastSessions = sSig;
    const first = !lastSigs.size;
    lastSigs = sigs;
    if (!first && (changed.length || sChanged)) for (const s of streams) s.write(`data: ${JSON.stringify({ plans: changed, sessions: sChanged })}\n\n`);
  }
  let polling = false;
  const pollTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      await poll();
    } catch (e) {
      log(`poll: ${e.message}`);
    } finally {
      polling = false;
    }
  }, pollMs);
  const keepAlive = setInterval(() => streams.forEach((s) => s.write(': keep-alive\n\n')), 25_000);

  const stopSupervisor = supervise ? startSupervisor(backend, { onActions: (a) => a.forEach((x) => log(`supervisor: ${x}`)), onError: (e) => log(`supervisor: ${e.message}`) }) : () => {};

  // ---------- HTTP ----------
  const cookieOk = (req) => (req.headers.cookie || '').split(/;\s*/).includes(`atf_token=${token}`);
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return true;
    try {
      return new URL(o).host === req.headers.host;
    } catch {
      return false;
    }
  };
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let b = '';
      req.on('data', (d) => {
        b += d;
        if (b.length > 1 << 20) reject(Object.assign(new Error('too large'), { status: 413 })), req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(b ? JSON.parse(b) : {});
        } catch {
          reject(Object.assign(new Error('not JSON'), { status: 400 }));
        }
      });
    });

  /** Start / resume / replace a coordinator: in a child process (a handoff can take minutes). */
  const coordinate = (root, id, { fresh, kind }) =>
    new Promise((resolve) => {
      const args = [SESSIONS_CLI, 'coordinate', '--plan', id, ...(fresh ? ['--fresh'] : []), ...(kind ? ['--kind', String(kind)] : [])];
      const env = { ...process.env, ATF_DIR: root, ATF_SESSIOND_SOCKET: socket };
      for (const k of ['ATF_PLAN', 'ATF_ACTOR', 'ATF_ROLE', 'ATF_BACKEND']) delete env[k];
      execFile(process.execPath, args, { cwd: path.dirname(root), env, timeout: 300_000 }, (err, stdout, stderr) => {
        resolve(err ? { ok: false, message: String(stderr || err.message).trim().replace(/^atf-sessions: /, '') } : { ok: true, message: stdout.trim() });
      });
    });

  async function api(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    const route = `${req.method} ${url.pathname}`;
    if (req.method === 'POST' && !/^application\/json\b/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON only' });
    switch (route) {
      case 'GET /api/overview':
        return json(res, 200, overview());
      case 'GET /api/plan':
        return json(res, 200, planView(known(q.root, q.plan), q.plan));
      case 'GET /api/brief': {
        const st = plan(known(q.root, q.plan), q.plan);
        const b = brief(st, q.task || null);
        return b ? json(res, 200, b) : json(res, 404, { error: `unknown task ${q.task}` });
      }
      case 'GET /api/log': {
        // the plan's events, newest last (the Log view): the last `n` (default 400)
        const root = known(q.root, q.plan);
        const evs = readEvents(root, q.plan);
        const n = Math.min(Number(q.n) || 400, 5000);
        return json(res, 200, { total: evs.length, events: evs.slice(-n) });
      }
      case 'GET /api/doc': {
        const root = known(q.root, q.plan);
        const st = plan(root, q.plan);
        // only the plan's own documents, inside the project
        if (!st.docs.includes(q.doc)) return json(res, 404, { error: 'not a document of this plan' });
        const file = path.resolve(path.dirname(root), q.doc);
        if (!file.startsWith(path.dirname(root) + path.sep)) return json(res, 403, { error: 'outside the project' });
        return json(res, 200, { doc: q.doc, text: fs.readFileSync(file, 'utf8') });
      }
      case 'POST /api/action': {
        const b = await readBody(req);
        if (!ACTIONS.includes(b.action)) return json(res, 400, { error: `unknown action ${b.action}` });
        const root = known(b.root, b.plan);
        const r = humanAction(root, b.plan, b.action, { task: b.task, message: b.message, status: b.status });
        poll().catch(() => {});
        return json(res, r.ok ? 200 : 409, r);
      }
      case 'POST /api/coordinator': {
        const b = await readBody(req);
        const root = known(b.root, b.plan);
        const r = await coordinate(root, b.plan, b);
        poll().catch(() => {});
        return json(res, r.ok ? 200 : 409, r);
      }
      case 'GET /api/stream': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': hello\n\n');
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      default:
        return json(res, 404, { error: `no ${route}` });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL('http://x' + (req.url.startsWith('/') ? req.url : '/' + req.url)); // never throws on '//…'
    if (url.searchParams.get('token') === token) {
      res.writeHead(302, { 'Set-Cookie': `atf_token=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
      return res.end();
    }
    if (!cookieOk(req)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Open the URL with the token that atf-web printed (atf-web url shows it again).\n');
    }
    if (url.pathname.startsWith('/api/')) {
      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request' });
      try {
        return await api(req, res, url);
      } catch (e) {
        return json(res, e.status || 500, { error: e.message });
      }
    }
    let rel;
    try {
      rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      return res.writeHead(400).end();
    }
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(404).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  // the agents' terminals: each browser connection gets its own daemon connection
  server.on('upgrade', (req, sock) => {
    if (!cookieOk(req) || !sameOrigin(req) || req.url !== '/ws') return sock.destroy();
    const ws = wsAccept(req, sock);
    const d = connect((m) => {
      if (m.ev === 'closed') return ws.close();
      ws.send(JSON.stringify(m));
    }, socket);
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
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    server,
    port: actual,
    url: `http://localhost:${actual}/?token=${token}`,
    overview,
    close: () =>
      new Promise((resolve) => {
        clearInterval(pollTimer);
        clearInterval(keepAlive);
        stopSupervisor();
        daemon?.close();
        for (const s of streams) s.end();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------- the command ----------
const HELP = `atf-web — ATF in the browser

  atf-web [--port 7420]     serve on 127.0.0.1 (prints the URL to open, with its token)
  atf-web url               the URL again
  atf-web --no-supervise    without the supervisor (when atf-sessions supervise runs)

From another machine: ssh -L 7420:localhost:7420 <host>, then open the URL there.
Agents run in atf-sessiond (started when needed); they outlive the server.
`;

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] ?? true : undefined;
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const port = Number(flag('port') || process.env.ATF_WEB_PORT || 7420);
  if (argv[0] === 'url') {
    process.stdout.write(`http://localhost:${port}/?token=${webToken()}\n`);
    process.exit(0);
  }
  process.on('SIGHUP', () => {}); // survive the terminal that started it
  const stamp = () => new Date().toLocaleTimeString();
  startWebServer({ port, supervise: !argv.includes('--no-supervise'), log: (m) => process.stdout.write(`${stamp()} ${m}\n`) })
    .then((w) => process.stdout.write(`atf-web: ${w.url}\n`))
    .catch((e) => {
      process.stderr.write(`atf-web: ${e.code === 'EADDRINUSE' ? `port ${port} is in use (another atf-web? --port N)` : e.message}\n`);
      process.exit(1);
    });
}

