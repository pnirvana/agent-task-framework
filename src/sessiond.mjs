#!/usr/bin/env node
// ATF's session daemon (docs/webui-design.md §4.1): holds the agents' terminals, so they
// outlive the web server, the browser and the terminal that started them. One process per
// user, a Unix socket only its owner can open, newline-delimited JSON.
//
// A terminal per session, without native modules:
//   Linux:  util-linux `script` (accepts a pipe on stdin, >= 2.35)
//   macOS:  python3's pty module (development: macOS `script` needs a tty on stdin)
// The session first prints its tty and pid in a private OSC sequence (stripped here), so
// it can be resized from outside with `stty -F <tty>`: the kernel then sends SIGWINCH.
//
// Requests carry an optional `rid`; every request with one gets {ev:'ok', rid, …} or
// {ev:'error', rid, message} back.
//   {op:'list'}                                   -> ok {list}
//   {op:'create', id?, name, argv | cmd, cwd, env, cols, rows, meta, attach?}  -> ok {id}
//   {op:'attach', id} -> replay {id, data, cols, rows, exited, code}, then out events
//   {op:'detach', id} {op:'input', id, data} {op:'resize', id, cols, rows}
//   {op:'kill', id}    hang up (the session stays listed, exited)
//   {op:'remove', id}  hang up and forget it
//   {op:'shutdown'}    hang up every session and exit
// Events (to every client): {ev:'sessions', list}, {ev:'exit', id, code};
// to attached clients: {ev:'replay', …}, {ev:'out', id, data}.
// A session's `meta` (root, plan, actor, task, role, kind, session) is the launcher's:
// it finds a task's agent by it, without a registry of its own.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** The daemon's socket: $ATF_SESSIOND_SOCKET, else in $XDG_RUNTIME_DIR (or the temp dir), owner only. */
export function socketPath() {
  if (process.env.ATF_SESSIOND_SOCKET) return process.env.ATF_SESSIOND_SOCKET;
  const dir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `atf-${process.getuid()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, 'sessiond.sock');
}

const MAX_BUF = 2 << 20; // characters of output kept per session for replay
const MARK = /\x1b\]6973;tty;([^;\x07]*);(\d+)\x07/;
const sessions = new Map();
const clients = new Set();
const log = (...a) => process.env.ATF_SESSIOND_LOG && fs.appendFileSync(process.env.ATF_SESSIOND_LOG, `${new Date().toISOString()} ${a.join(' ')}\n`);

/** Shell quoting, for a session started from an argument list. */
export const sq = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

function startPty({ cmd, cwd, env, cols, rows }) {
  const userShell = env.SHELL || '/bin/sh';
  const inner = `printf '\\033]6973;tty;%s;%s\\007' "$(tty)" "$$"; stty rows ${rows} cols ${cols}; export SHELL=${sq(userShell)}; exec ${cmd}`;
  const e = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', SHELL: '/bin/sh' };
  if (process.platform === 'linux') return spawn('script', ['-qfec', inner, '/dev/null'], { cwd, env: e });
  const py = 'import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))';
  return spawn('python3', ['-c', py, '/bin/sh', '-c', inner], { cwd, env: e });
}

const info = (s) => ({ id: s.id, name: s.name, cmd: s.cmd, cwd: s.cwd, cols: s.cols, rows: s.rows, pid: s.pid ?? null, started: s.started, lastOutput: s.lastOutput, lastInput: s.lastInput, exited: s.exited, code: s.code, bracketedPaste: !!s.bracketedPaste, appState: s.appState || null, clients: s.clients.size, meta: s.meta });
const list = () => [...sessions.values()].map(info);
const send = (c, msg) => c.writable && c.write(JSON.stringify(msg) + '\n');
const broadcastList = () => clients.forEach((c) => send(c, { ev: 'sessions', list: list() }));

/** What a reattaching terminal needs: from the last switch to the alternate screen, if still on it. */
export function replayText(buf) {
  const on = buf.lastIndexOf('\x1b[?1049h');
  if (on >= 0 && on > buf.lastIndexOf('\x1b[?1049l')) return buf.slice(on);
  return buf;
}

function create(req) {
  const id = req.id || crypto.randomBytes(4).toString('hex');
  if (sessions.has(id)) throw new Error(`session ${id} exists`);
  const cols = req.cols || 120,
    rows = req.rows || 32;
  const cwd = req.cwd ? req.cwd.replace(/^~(?=\/|$)/, os.homedir()) : os.homedir();
  const cmd = req.argv?.length ? req.argv.map(sq).join(' ') : req.cmd || '$SHELL -l';
  // the client's environment as given (it knows what the agent needs), else the daemon's
  const proc = startPty({ cmd, cwd, env: req.env || process.env, cols, rows });
  const s = { id, name: req.name || req.argv?.[0] || req.cmd || 'shell', cmd, cwd, cols, rows, proc, tty: null, buf: '', pending: '', started: Date.now(), lastOutput: Date.now(), lastInput: null, exited: false, code: null, clients: new Set(), meta: req.meta || {} };
  const dec = new StringDecoder('utf8');
  proc.stdout.on('data', (d) => {
    let text = dec.write(d);
    if (!s.tty) {
      // the marker comes first; hold output back until it is complete
      s.pending += text;
      const m = s.pending.match(MARK);
      if (!m) return s.pending.length > 4096 && ((text = s.pending), (s.pending = ''), (s.tty = '?'), out(s, text));
      s.tty = m[1];
      s.pid = Number(m[2]); // the agent: leader of the terminal's session and process group
      text = s.pending.replace(MARK, '');
      s.pending = '';
      if (s.cols !== cols || s.rows !== rows) resize(s, s.cols, s.rows);
      broadcastList();
    }
    out(s, text);
  });
  proc.stderr.on('data', (d) => out(s, d.toString()));
  proc.on('error', (e) => out(s, `\r\n[atf-sessiond] ${e.message}\r\n`));
  proc.on('exit', (code, sig) => {
    s.exited = true;
    s.code = code ?? sig;
    log('exit', id, s.code);
    for (const c of clients) send(c, { ev: 'exit', id, code: s.code });
    broadcastList();
  });
  sessions.set(id, s);
  log('create', id, cmd, cwd);
  broadcastList();
  return s;
}

function out(s, text) {
  if (!text) return;
  s.lastOutput = Date.now();
  // does the program take bracketed paste (CSI ?2004 h/l)? Clients paste prompts that way
  const on = text.lastIndexOf('\x1b[?2004h'),
    off = text.lastIndexOf('\x1b[?2004l');
  if (on > off) s.bracketedPaste = true;
  else if (off > on) s.bracketedPaste = false;
  // the program's own state report (Copilot: OSC 7501;state=idle|working|blocked[:app=…][:kind=…])
  const scan = (s.oscTail || '') + text;
  let st = null;
  for (const m of scan.matchAll(/\x1b\]7501;state=(\w+)((?::[\w-]+=[^:\x07\x1b]*)*)/g)) st = m;
  if (st) s.appState = { state: st[1], ...Object.fromEntries([...st[2].matchAll(/:([\w-]+)=([^:]*)/g)].map((x) => [x[1], x[2]])), at: Date.now() };
  s.oscTail = scan.slice(-256);
  s.buf += text;
  if (s.buf.length > MAX_BUF) {
    const cut = s.buf.indexOf('\n', s.buf.length - MAX_BUF / 2);
    s.buf = s.buf.slice(cut + 1);
  }
  for (const c of s.clients) send(c, { ev: 'out', id: s.id, data: text });
}

/** Like closing a terminal window: hang up the agent's process group (util-linux script ignores SIGHUP). */
function hangup(s) {
  if (s.exited) return;
  try {
    if (s.pid) process.kill(-s.pid, 'SIGHUP');
    else s.proc.kill('SIGTERM');
  } catch {
    s.proc.kill('SIGTERM');
  }
  setTimeout(() => s.exited || s.proc.kill('SIGKILL'), 5000).unref();
}

function resize(s, cols, rows) {
  s.cols = cols;
  s.rows = rows;
  if (!s.tty || s.tty === '?' || s.exited) return;
  execFile('stty', [process.platform === 'linux' ? '-F' : '-f', s.tty, 'cols', String(cols), 'rows', String(rows)], (err) => err && log('resize', s.id, err.message));
}

function handle(c, req) {
  const s = req.id && sessions.get(req.id);
  const need = () => {
    if (!s) throw new Error(`no session ${req.id}`);
    return s;
  };
  const ok = (extra = {}) => req.rid != null && send(c, { ev: 'ok', rid: req.rid, ...extra });
  switch (req.op) {
    case 'list':
      if (req.rid != null) return ok({ list: list() });
      return send(c, { ev: 'sessions', list: list() });
    case 'create': {
      const n = create(req);
      if (req.attach) n.clients.add(c), send(c, { ev: 'replay', id: n.id, data: '', cols: n.cols, rows: n.rows });
      return ok({ id: n.id });
    }
    case 'attach': {
      need().clients.add(c);
      send(c, { ev: 'replay', id: s.id, data: replayText(s.buf), cols: s.cols, rows: s.rows, exited: s.exited, code: s.code });
      broadcastList();
      return ok({ id: s.id });
    }
    case 'detach':
      need().clients.delete(c);
      broadcastList();
      return ok();
    case 'input':
      if (!need().exited) s.proc.stdin.write(req.data), (s.lastInput = Date.now());
      return ok();
    case 'resize':
      resize(need(), Math.max(10, req.cols | 0), Math.max(4, req.rows | 0));
      return ok();
    case 'kill':
      hangup(need());
      return ok();
    case 'remove':
      hangup(need());
      sessions.delete(s.id);
      broadcastList();
      return ok();
    case 'shutdown':
      for (const x of sessions.values()) hangup(x);
      ok();
      log('shutdown');
      setTimeout(() => process.exit(0), 300);
      return;
    default:
      throw new Error(`unknown op ${req.op}`);
  }
}

/**
 * One daemon per socket: whoever starts it (atf-web, atf-sessions, a launcher) may race
 * another starting at the same moment; the second one must not take the socket over (the
 * first one's clients and sessions would be cut off from new ones). A lock file next to
 * the socket holds the running daemon's pid; a lock of a process that is gone is taken.
 */
function claim(file) {
  const lock = `${file}.lock`;
  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      process.on('exit', () => {
        try {
          if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.rmSync(lock, { force: true });
        } catch {}
      });
      return true;
    } catch {
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(lock, 'utf8'));
      } catch {}
      let alive = false;
      try {
        alive = !!pid && (process.kill(pid, 0), true);
      } catch (e) {
        alive = e.code === 'EPERM';
      }
      if (alive) return false;
      fs.rmSync(lock, { force: true }); // its daemon is gone
    }
  }
  return false;
}

/** Serve on `file`; null when another daemon already serves it (this one should exit). */
export function serve(file = socketPath()) {
  // sun_path: 104 bytes on macOS, 108 on Linux
  if (Buffer.byteLength(file) > 103) throw new Error(`socket path too long for a Unix socket (${Buffer.byteLength(file)} bytes): ${file}; set ATF_SESSIOND_SOCKET to a shorter one`);
  if (!claim(file)) {
    log('another daemon serves', file);
    return null;
  }
  try {
    fs.unlinkSync(file);
  } catch {}
  const server = net.createServer((c) => {
    clients.add(c);
    let rest = '';
    c.setEncoding('utf8');
    c.on('data', (d) => {
      rest += d;
      let i;
      while ((i = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, i);
        rest = rest.slice(i + 1);
        if (!line.trim()) continue;
        let req = {};
        try {
          req = JSON.parse(line);
          handle(c, req);
        } catch (e) {
          send(c, { ev: 'error', rid: req.rid, message: e.message });
        }
      }
    });
    const gone = () => {
      clients.delete(c);
      for (const s of sessions.values()) s.clients.delete(c);
    };
    c.on('close', gone);
    c.on('error', gone);
  });
  server.listen(file, () => {
    fs.chmodSync(file, 0o600);
    log('listening', file, process.pid);
  });
  return server;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  process.on('SIGHUP', () => {}); // survive the terminal that started us
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0)); // the lock goes with it
  if (!serve()) process.exit(0);
}
