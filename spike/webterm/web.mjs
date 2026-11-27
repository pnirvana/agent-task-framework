#!/usr/bin/env node
// Spike: ATF web server. Serves the UI and relays WebSocket messages to the session
// daemon (starting it if needed). Binds 127.0.0.1 only: reach it through one SSH tunnel,
//   ssh -L 7420:localhost:7420 devpod
// and open the printed URL (the token keeps other local processes out).

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { socketPath } from './sessiond.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.ATF_WEB_PORT || process.argv[2] || 7420);
const TOKEN_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'atf', 'web-token');

function token() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    const t = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
    return t;
  }
}
const TOKEN = token();

// ---- session daemon ------------------------------------------------------------------

function connectDaemon() {
  const file = socketPath();
  return new Promise((resolve, reject) => {
    const tryConnect = (attempt) => {
      const c = net.connect(file);
      c.once('connect', () => resolve(c));
      c.once('error', (e) => {
        if (attempt === 0) {
          const d = spawn(process.execPath, [path.join(HERE, 'sessiond.mjs')], { detached: true, stdio: 'ignore', env: process.env });
          d.unref();
        }
        if (attempt > 30) return reject(e);
        setTimeout(() => tryConnect(attempt + 1), 100);
      });
    };
    tryConnect(0);
  });
}

// ---- WebSocket (RFC 6455, the parts a browser uses) -----------------------------------

function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const ws = { onmessage: () => {}, onclose: () => {}, closed: false };
  ws.send = (text) => {
    if (ws.closed) return;
    const body = Buffer.from(text, 'utf8');
    const n = body.length;
    const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    socket.write(Buffer.concat([head, body]));
  };
  const close = () => {
    if (ws.closed) return;
    ws.closed = true;
    socket.destroy();
    ws.onclose();
  };
  let buf = Buffer.alloc(0);
  let parts = [];
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (!masked) return close(); // clients must mask
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return close();
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 10) continue;
      parts.push(payload);
      if (fin) {
        const msg = Buffer.concat(parts).toString('utf8');
        parts = [];
        ws.onmessage(msg);
      }
    }
  });
  socket.on('close', close);
  socket.on('error', close);
  return ws;
}

// ---- HTTP ----------------------------------------------------------------------------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
const cookieOk = (req) => (req.headers.cookie || '').split(/;\s*/).includes(`atf_token=${TOKEN}`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('token') === TOKEN) {
    res.writeHead(302, { 'Set-Cookie': `atf_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
    return res.end();
  }
  if (!cookieOk(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    return res.end('Open the URL with the token that atf-web printed.\n');
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(404).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('upgrade', async (req, socket) => {
  const origin = req.headers.origin && new URL(req.headers.origin).host;
  if (!cookieOk(req) || (origin && origin !== req.headers.host) || req.url !== '/ws') return socket.destroy();
  const ws = wsAccept(req, socket);
  const early = []; // what the browser sends before the daemon connection is up
  ws.onmessage = (m) => early.push(m);
  let daemon;
  try {
    daemon = await connectDaemon();
  } catch (e) {
    ws.send(JSON.stringify({ ev: 'error', message: `session daemon: ${e.message}` }));
    return socket.destroy();
  }
  daemon.setEncoding('utf8');
  let rest = '';
  daemon.on('data', (d) => {
    rest += d;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      ws.send(rest.slice(0, i));
      rest = rest.slice(i + 1);
    }
  });
  daemon.on('close', () => socket.destroy());
  daemon.on('error', () => socket.destroy());
  ws.onmessage = (m) => daemon.write(m + '\n'); // JSON from JSON.stringify has no raw newlines
  ws.onclose = () => daemon.destroy();
  early.splice(0).forEach(ws.onmessage);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`atf-web: http://localhost:${PORT}/?token=${TOKEN}`);
});
