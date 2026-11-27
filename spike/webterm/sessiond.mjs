#!/usr/bin/env node
// Spike: ATF session daemon. Owns the agents' terminals so they outlive the web server
// and the browser. One process per user, a Unix socket, newline-delimited JSON.
//
// Terminal per session, without native modules:
//   Linux:  util-linux `script` (accepts a pipe on stdin, >= 2.35)
//   macOS:  python3's pty module (development only: macOS `script` needs a tty on stdin)
// The child first prints its tty in a private OSC sequence (stripped here), so we can
// resize it from outside with `stty -F <tty>`: the kernel then sends SIGWINCH.
//
// Requests  {op:'list'} {op:'create', id?, name, cmd, cwd, cols, rows}
//           {op:'attach', id} {op:'detach', id} {op:'input', id, data}
//           {op:'resize', id, cols, rows} {op:'kill', id} {op:'remove', id}
// Events    {ev:'sessions', list} {ev:'replay', id, data, cols, rows}
//           {ev:'out', id, data} {ev:'exit', id, code} {ev:'error', message}

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const socketPath = () => {
  const dir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `atf-${process.getuid()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, 'sessiond.sock');
};

const MAX_BUF = 2 << 20; // characters of output kept per session for replay
const MARK = /\x1b\]6973;tty;([^;\x07]*);(\d+)\x07/;
const sessions = new Map();
const clients = new Set();
const log = (...a) => process.env.ATF_SESSIOND_LOG && fs.appendFileSync(process.env.ATF_SESSIOND_LOG, `${new Date().toISOString()} ${a.join(' ')}\n`);

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function startPty({ cmd, cwd, env, cols, rows }) {
  const userShell = env.SHELL || '/bin/sh';
  const inner = `printf '\\033]6973;tty;%s;%s\\007' "$(tty)" "$$"; stty rows ${rows} cols ${cols}; export SHELL=${sq(userShell)}; exec ${cmd}`;
  const e = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', SHELL: '/bin/sh' };
  if (process.platform === 'linux') return spawn('script', ['-qfec', inner, '/dev/null'], { cwd, env: e });
  const py = 'import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))';
  return spawn('python3', ['-c', py, '/bin/sh', '-c', inner], { cwd, env: e });
}

const info = (s) => ({ id: s.id, name: s.name, cmd: s.cmd, cwd: s.cwd, cols: s.cols, rows: s.rows, pid: s.pid, started: s.started, lastOutput: s.lastOutput, exited: s.exited, code: s.code, clients: s.clients.size });
const list = () => [...sessions.values()].map(info);
const send = (c, msg) => c.writable && c.write(JSON.stringify(msg) + '\n');
const broadcastList = () => clients.forEach((c) => send(c, { ev: 'sessions', list: list() }));

/** What a reattaching terminal needs: from the last switch to the alternate screen, if still on it. */
function replayText(buf) {
  const on = buf.lastIndexOf('\x1b[?1049h');
  if (on >= 0 && on > buf.lastIndexOf('\x1b[?1049l')) return buf.slice(on);
  return buf;
}

function create(req) {
  const id = req.id || crypto.randomBytes(4).toString('hex');
  if (sessions.has(id)) throw new Error(`session ${id} exists`);
  const cols = req.cols || 120, rows = req.rows || 32;
  const cwd = req.cwd ? req.cwd.replace(/^~(?=\/|$)/, os.homedir()) : os.homedir();
  const proc = startPty({ cmd: req.cmd || '$SHELL -l', cwd, env: { ...process.env, ...(req.env || {}) }, cols, rows });
  const s = { id, name: req.name || req.cmd || 'shell', cmd: req.cmd, cwd, cols, rows, proc, tty: null, buf: '', pending: '', started: Date.now(), lastOutput: Date.now(), exited: false, code: null, clients: new Set() };
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
    }
    out(s, text);
  });
  proc.stderr.on('data', (d) => out(s, d.toString()));
  proc.on('exit', (code, sig) => {
    s.exited = true;
    s.code = code ?? sig;
    log('exit', id, s.code);
    for (const c of clients) send(c, { ev: 'exit', id, code: s.code });
    broadcastList();
  });
  sessions.set(id, s);
  log('create', id, req.cmd, cwd);
  broadcastList();
  return s;
}

function out(s, text) {
  if (!text) return;
  s.lastOutput = Date.now();
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
  switch (req.op) {
    case 'list': return send(c, { ev: 'sessions', list: list() });
    case 'create': {
      const n = create(req);
      if (req.attach) n.clients.add(c), send(c, { ev: 'replay', id: n.id, data: '', cols: n.cols, rows: n.rows });
      return send(c, { ev: 'created', id: n.id, ref: req.ref });
    }
    case 'attach': {
      need().clients.add(c);
      send(c, { ev: 'replay', id: s.id, data: replayText(s.buf), cols: s.cols, rows: s.rows, exited: s.exited, code: s.code });
      return broadcastList();
    }
    case 'detach': return need().clients.delete(c), broadcastList();
    case 'input': return need().exited || s.proc.stdin.write(req.data);
    case 'resize': return resize(need(), Math.max(10, req.cols | 0), Math.max(4, req.rows | 0));
    case 'kill': return hangup(need());
    case 'remove': {
      hangup(need());
      sessions.delete(s.id);
      return broadcastList();
    }
    default: throw new Error(`unknown op ${req.op}`);
  }
}

function serve(file) {
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
        try {
          handle(c, JSON.parse(line));
        } catch (e) {
          send(c, { ev: 'error', message: e.message });
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
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sessiond.mjs')) {
  process.on('SIGHUP', () => {}); // survive the terminal that started us
  serve(socketPath());
}
