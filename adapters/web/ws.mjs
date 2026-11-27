// A minimal WebSocket server side (RFC 6455): the parts a browser uses. Text frames only;
// pings are answered; clients must mask. No dependencies.
import crypto from 'node:crypto';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Accept an upgrade request: returns {send(text), close(), onmessage, onclose}. */
export function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + MAGIC).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const ws = { onmessage: () => {}, onclose: () => {}, closed: false };
  const frame = (op, body) => {
    const n = body.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) head = Buffer.from([0x80 | op, 126, n >> 8, n & 255]);
    else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    return Buffer.concat([head, body]);
  };
  ws.send = (text) => {
    if (!ws.closed) socket.write(frame(0x1, Buffer.from(text, 'utf8')));
  };
  ws.close = () => {
    if (ws.closed) return;
    ws.closed = true;
    try {
      socket.end(frame(0x8, Buffer.alloc(0)));
    } catch {}
    setTimeout(() => socket.destroy(), 1000).unref();
    ws.onclose();
  };
  const gone = () => {
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
      const fin = buf[0] & 0x80,
        op = buf[0] & 0x0f,
        masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f,
        off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (!masked) return gone(); // clients must mask
      if (len > 16 << 20) return gone();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 0x8) return ws.close();
      if (op === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (op === 0xa) continue;
      parts.push(payload);
      if (fin) {
        const msg = Buffer.concat(parts).toString('utf8');
        parts = [];
        ws.onmessage(msg);
      }
    }
  });
  socket.on('close', gone);
  socket.on('error', gone);
  return ws;
}
