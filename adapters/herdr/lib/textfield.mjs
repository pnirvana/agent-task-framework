// A text field for the board: a cursor anywhere in the text, wrapped lines, the usual
// editing keys (arrows, word and line moves, deletes, kill/yank, undo, paste). No
// dependencies, no terminal I/O: keyField() edits, fieldRows() lays it out for drawing.

const isWord = (ch) => /[\p{L}\p{N}_]/u.test(ch);

/**
 * A new field. multiline: line breaks are text (else pasted ones become spaces).
 * vi: vi keys (starts in insert mode; esc to normal mode, esc there cancels).
 */
export function textField(value = '', { multiline = true, vi = false } = {}) {
  const chars = [...String(value).replace(/\t/g, '    ')];
  const vim = vi ? { mode: 'insert', buf: [], reg: { text: '', line: false }, find: null, dot: null, rec: null, anchor: 0, goal: null, group: null } : null;
  return { chars, pos: chars.length, multiline, undo: [], redo: [], kill: '', goal: null, top: 0, last: null, rows: null, vim, noSnap: false };
}

export const fieldText = (f) => f.chars.join('');

/** The vi mode shown next to the field ('INSERT', 'NORMAL', …, plus a pending command), or null. */
export function fieldMode(f) {
  if (!f.vim) return null;
  const m = { insert: 'INSERT', normal: 'NORMAL', visual: 'VISUAL', vline: 'VISUAL LINE' }[f.vim.mode];
  const pending = f.vim.buf.join('').replace(/[\x00-\x1f]/g, '');
  return pending ? `${m} ${pending}` : m;
}

// ---------- edits (each records an undo step) ----------
function snapshot(f, kind) {
  if (f.noSnap) return; // inside a vi command: the command is one undo step
  // consecutive typing (or deleting) is one undo step, cut at spaces and line breaks
  if (kind && f.last === kind) return;
  f.undo.push({ chars: [...f.chars], pos: f.pos });
  if (f.undo.length > 200) f.undo.shift();
  f.redo = [];
  f.last = kind;
}
function insert(f, text, kind = null) {
  const cs = [...text];
  if (!cs.length) return;
  snapshot(f, kind);
  f.chars.splice(f.pos, 0, ...cs);
  f.pos += cs.length;
}
function remove(f, from, to, kind = null, kill = false) {
  if (from === to) return;
  if (from > to) [from, to] = [to, from];
  snapshot(f, kind);
  const gone = f.chars.splice(from, to - from).join('');
  if (kill) f.kill = gone;
  f.pos = from;
}

// ---------- positions ----------
const lineStart = (f, p = f.pos) => {
  while (p > 0 && f.chars[p - 1] !== '\n') p--;
  return p;
};
const lineEnd = (f, p = f.pos) => {
  while (p < f.chars.length && f.chars[p] !== '\n') p++;
  return p;
};
function wordLeft(f, p = f.pos) {
  while (p > 0 && !isWord(f.chars[p - 1])) p--;
  while (p > 0 && isWord(f.chars[p - 1])) p--;
  return p;
}
function wordRight(f, p = f.pos) {
  while (p < f.chars.length && !isWord(f.chars[p])) p++;
  while (p < f.chars.length && isWord(f.chars[p])) p++;
  return p;
}

// ---------- layout ----------
/**
 * Visual rows of the text at `width` columns (one column kept for the cursor), each
 * {start, end, hard}: chars [start, end), hard when a line break ends it.
 */
export function layout(f, width, cw = () => 1) {
  const w = Math.max(2, width - 1);
  const rows = [];
  let start = 0;
  let col = 0;
  for (let i = 0; i < f.chars.length; i++) {
    const ch = f.chars[i];
    if (ch === '\n') {
      rows.push({ start, end: i, hard: true });
      start = i + 1;
      col = 0;
      continue;
    }
    const cwid = cw(ch);
    if (col + cwid > w) {
      rows.push({ start, end: i, hard: false });
      start = i;
      col = 0;
    }
    col += cwid;
  }
  rows.push({ start, end: f.chars.length, hard: false });
  return rows;
}
/** The row the cursor is on: at a soft wrap the cursor shows at the start of the next row. */
function cursorRow(rows, pos) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (pos >= r.start && (pos < r.end || (pos === r.end && (r.hard || i === rows.length - 1)))) return i;
  }
  return rows.length - 1;
}
const colOf = (f, r, pos, cw) => f.chars.slice(r.start, pos).reduce((n, ch) => n + cw(ch), 0);
function atCol(f, r, goal, cw) {
  let col = 0;
  for (let p = r.start; p < r.end; p++) {
    const w = cw(f.chars[p]);
    if (col + w > goal) return p;
    col += w;
  }
  // a soft-wrapped row's end is the next row's start: stay on this row
  return r.hard || r.end === f.chars.length ? r.end : Math.max(r.start, r.end - 1);
}
function vertical(f, delta) {
  const { rows, cw } = f.rows || { rows: layout(f, 1e9), cw: () => 1 };
  const i = cursorRow(rows, f.pos);
  if (f.goal === null) f.goal = colOf(f, rows[i], f.pos, cw);
  const j = Math.max(0, Math.min(rows.length - 1, i + delta));
  if (j === i) f.pos = delta < 0 ? rows[0].start : f.chars.length; // past the first/last row: to the text's start/end
  else f.pos = atCol(f, rows[j], f.goal, cw);
}

// ---------- keys ----------
const KEYS = {
  left: ['\x1b[D', '\x1bOD', '\x02'],
  right: ['\x1b[C', '\x1bOC', '\x06'],
  up: ['\x1b[A', '\x1bOA', '\x10'],
  down: ['\x1b[B', '\x1bOB', '\x0e'],
  wordLeft: ['\x1bb', '\x1b[1;3D', '\x1b[1;5D', '\x1b[1;9D'],
  wordRight: ['\x1bf', '\x1b[1;3C', '\x1b[1;5C', '\x1b[1;9C'],
  home: ['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~', '\x01'],
  end: ['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~', '\x05'],
  textStart: ['\x1b[1;5H', '\x1b[1;3H', '\x1b<'],
  textEnd: ['\x1b[1;5F', '\x1b[1;3F', '\x1b>'],
  pageUp: ['\x1b[5~'],
  pageDown: ['\x1b[6~'],
  backspace: ['\x7f', '\b'],
  del: ['\x1b[3~', '\x04'],
  wordBack: ['\x17', '\x1b\x7f', '\x1b\b'],
  wordDel: ['\x1bd', '\x1b[3;3~', '\x1b[3;5~'],
  killStart: ['\x15'],
  killEnd: ['\x0b'],
  yank: ['\x19'],
  undo: ['\x1a', '\x1f'],
  redo: ['\x1b[122;6u', '\x1bz'],
  newline: ['\n', '\x1b\r', '\x1b\n', '\x1b[13;2u', '\x1b[13;3u', '\x1b[27;2;13~', '\x1b[27;3;13~'],
};
const KEY_OF = new Map(Object.entries(KEYS).flatMap(([name, ks]) => ks.map((k) => [k, name])));

/**
 * Apply one key. Returns 'submit' (⏎), 'cancel' (esc), or null. While `pasting`, line
 * breaks and escape are text. Before vertical moves, the caller's last fieldRows()
 * layout is used, so up/down follow the wrapped rows on screen.
 */
export function keyField(f, k, { pasting = false } = {}) {
  if (f.vim) return keyVi(f, k, { pasting });
  return keyPlain(f, k, { pasting });
}

function keyPlain(f, k, { pasting = false } = {}) {
  let name = KEY_OF.get(k);
  if (pasting && (k === '\r' || k === '\n')) name = 'newline';
  if (!name && k === '\r') return 'submit';
  if (!name && k === '\x1b') return pasting ? null : 'cancel';
  if (name !== 'up' && name !== 'down' && name !== 'pageUp' && name !== 'pageDown') f.goal = null;
  const typing = (kind) => (kind === 'type' || kind === 'del' ? kind : null);
  switch (name) {
    case 'left': f.pos = Math.max(0, f.pos - 1); break;
    case 'right': f.pos = Math.min(f.chars.length, f.pos + 1); break;
    case 'up': vertical(f, -1); break;
    case 'down': vertical(f, 1); break;
    case 'pageUp': vertical(f, -Math.max(1, (f.rows?.height ?? 5) - 1)); break;
    case 'pageDown': vertical(f, Math.max(1, (f.rows?.height ?? 5) - 1)); break;
    case 'wordLeft': f.pos = wordLeft(f); break;
    case 'wordRight': f.pos = wordRight(f); break;
    case 'home': f.pos = lineStart(f); break;
    case 'end': f.pos = lineEnd(f); break;
    case 'textStart': f.pos = 0; break;
    case 'textEnd': f.pos = f.chars.length; break;
    case 'backspace': if (f.pos > 0) remove(f, f.pos - 1, f.pos, typing('del')); break;
    case 'del': if (f.pos < f.chars.length) remove(f, f.pos, f.pos + 1, typing('del')); break;
    case 'wordBack': remove(f, wordLeft(f), f.pos, null, true); break;
    case 'wordDel': remove(f, f.pos, wordRight(f), null, true); break;
    case 'killStart': remove(f, f.pos === lineStart(f) && f.pos > 0 ? f.pos - 1 : lineStart(f), f.pos, null, true); break;
    case 'killEnd': remove(f, f.pos, f.pos === lineEnd(f) && f.pos < f.chars.length ? f.pos + 1 : lineEnd(f), null, true); break;
    case 'yank': insert(f, f.kill); break;
    case 'undo':
      if (f.undo.length) {
        f.redo.push({ chars: [...f.chars], pos: f.pos });
        Object.assign(f, f.undo.pop());
      }
      f.last = null;
      return null;
    case 'redo':
      if (f.redo.length) {
        f.undo.push({ chars: [...f.chars], pos: f.pos });
        Object.assign(f, f.redo.pop());
      }
      f.last = null;
      return null;
    case 'newline':
      if (f.multiline) insert(f, '\n');
      else if (pasting) insert(f, ' ', 'type');
      break;
    default:
      if (k === '\t') insert(f, '    ');
      else if (k.length && !k.startsWith('\x1b') && k >= ' ') insert(f, k, /\s/.test(k) ? null : 'type');
      else return null;
  }
  // a move ends the current undo group
  if (!['backspace', 'del'].includes(name) && name !== undefined) f.last = null;
  return null;
}

/**
 * The field's visible rows at `width` columns, at most `height` of them, scrolled so the
 * cursor shows. Each row is a list of [text, style] segments, the cursor in inverse.
 * Also returns whether rows are hidden above/below.
 */
export function fieldRows(f, width, height, cw = () => 1) {
  const rows = layout(f, width, cw);
  f.rows = { rows, cw, height };
  const cur = cursorRow(rows, f.pos);
  if (cur < f.top) f.top = cur;
  if (cur >= f.top + height) f.top = cur - height + 1;
  f.top = Math.max(0, Math.min(f.top, Math.max(0, rows.length - height)));
  const sel = selection(f);
  const inSel = (p) => sel && p >= sel[0] && p < sel[1];
  const out = rows.slice(f.top, f.top + height).map((r, i) => {
    const segs = [];
    const push = (t, s) => (segs.length && segs.at(-1)[1] === s ? (segs.at(-1)[0] += t) : segs.push([t, s]));
    const isCur = f.top + i === cur;
    for (let p = r.start; p < r.end; p++) push(f.chars[p], isCur && p === f.pos ? 'inverse' : inSel(p) ? 'selected' : '');
    if (isCur && f.pos === r.end) push(' ', 'inverse');
    else if (r.hard && inSel(r.end)) push(' ', 'selected'); // a selected line break
    return segs.length ? segs : [['', '']];
  });
  return { rows: out, above: f.top > 0, below: f.top + height < rows.length };
}

// ---------- vi mode ----------
const isBlank = (ch) => ch === ' ' || ch === '\t';
/** Character class for word motions: 0 blank or line break, 1 punctuation (or any WORD char), 2 word. */
const cls = (ch, big) => (ch === undefined || /\s/.test(ch) ? 0 : big ? 1 : isWord(ch) ? 2 : 1);
const firstNonBlank = (f, p = f.pos) => {
  let s = lineStart(f, p);
  const e = lineEnd(f, p);
  while (s < e && isBlank(f.chars[s])) s++;
  return s;
};
function lineStarts(f) {
  const s = [0];
  f.chars.forEach((ch, i) => ch === '\n' && s.push(i + 1));
  return s;
}
const lineIndex = (starts, p) => {
  let i = 0;
  while (i + 1 < starts.length && starts[i + 1] <= p) i++;
  return i;
};
/** The position `delta` lines away at the remembered column; null when it cannot move. */
function lineMove(f, delta, p = f.pos) {
  const starts = lineStarts(f);
  const i = lineIndex(starts, p);
  const j = Math.max(0, Math.min(starts.length - 1, i + delta));
  if (j === i && delta) return null;
  if (f.vim.goal === null) f.vim.goal = p - starts[i];
  return Math.min(starts[j] + f.vim.goal, lineEnd(f, starts[j]));
}
function wFwd(f, p, big) {
  const c = f.chars;
  const n = c.length;
  const c0 = cls(c[p], big);
  if (c0) while (p < n && cls(c[p], big) === c0) p++;
  while (p < n && !cls(c[p], big)) {
    if (c[p] === '\n' && (c[p + 1] === '\n' || p + 1 === n) && p + 1 > f.pos) return p + 1; // an empty line is a word
    p++;
  }
  return p;
}
function eFwd(f, p, big) {
  const c = f.chars;
  p++;
  while (p < c.length && !cls(c[p], big)) p++;
  const c0 = cls(c[p], big);
  while (p + 1 < c.length && cls(c[p + 1], big) === c0) p++;
  return Math.min(p, Math.max(0, c.length - 1));
}
function bBack(f, p, big) {
  const c = f.chars;
  p--;
  while (p > 0 && !cls(c[p], big)) p--;
  const c0 = cls(c[p], big);
  while (p > 0 && cls(c[p - 1], big) === c0) p--;
  return Math.max(0, p);
}
function geBack(f, p, big) {
  const c = f.chars;
  const c0 = cls(c[p], big);
  while (p > 0 && cls(c[p], big) === c0 && c0) p--;
  while (p > 0 && !cls(c[p], big)) p--;
  return p;
}
function findInLine(f, key, ch, count, p = f.pos) {
  const ls = lineStart(f, p);
  const le = lineEnd(f, p);
  let q = p;
  for (let n = 0; n < count; n++) {
    if (key === 'f' || key === 't') {
      let r = q + 1;
      while (r < le && f.chars[r] !== ch) r++;
      if (r >= le) return null;
      q = r;
    } else {
      let r = q - 1;
      while (r >= ls && f.chars[r] !== ch) r--;
      if (r < ls) return null;
      q = r;
    }
  }
  return key === 't' ? q - 1 : key === 'T' ? q + 1 : q;
}
const PAIRS = { '(': '()', ')': '()', b: '()', '[': '[]', ']': '[]', '{': '{}', '}': '{}', B: '{}', '<': '<>', '>': '<>' };
function matchBracket(f, p) {
  const c = f.chars;
  let q = p;
  const le = lineEnd(f, p);
  while (q < le && !'()[]{}'.includes(c[q])) q++;
  if (q >= le) return null;
  const [o, cl] = PAIRS[c[q]];
  const dir = c[q] === o ? 1 : -1;
  for (let r = q + dir, d = 0; r >= 0 && r < c.length; r += dir) {
    if (c[r] === (dir > 0 ? o : cl)) d++;
    else if (c[r] === (dir > 0 ? cl : o)) {
      if (!d) return r;
      d--;
    }
  }
  return null;
}

/** Where motion `m` goes: {to, incl (the end char is in the range), line (linewise)}, or null. */
function motion(f, m, count, op) {
  const p = f.pos;
  const c = f.chars;
  const n = count ?? 1;
  const repeat = (fn) => {
    let q = p;
    for (let i = 0; i < n; i++) q = fn(q, i);
    return q;
  };
  switch (m.key) {
    case 'h': return { to: Math.max(lineStart(f), p - n) };
    case 'l': return { to: Math.min(lineEnd(f), p + n) };
    case 'j': case 'k': {
      const to = lineMove(f, m.key === 'j' ? n : -n);
      return to === null ? null : { to, line: true };
    }
    case 'gj': case 'gk': case 'down': case 'up': {
      const save = f.pos;
      vertical(f, m.key === 'gj' || m.key === 'down' ? n : -n);
      const to = f.pos;
      f.pos = save;
      return { to };
    }
    case 'w': case 'W': {
      const big = m.key === 'W';
      return {
        to: repeat((q, i) => {
          const r = wFwd(f, q, big);
          // dw on a line's last word stops at the line's end
          return op && i === n - 1 && c.slice(q, r).includes('\n') ? lineEnd(f, q) : r;
        }),
      };
    }
    case 'e': case 'E': return { to: repeat((q) => eFwd(f, q, m.key === 'E')), incl: true };
    case 'b': case 'B': return { to: repeat((q) => bBack(f, q, m.key === 'B')) };
    case 'ge': case 'gE': return { to: repeat((q) => geBack(f, q, m.key === 'gE')), incl: true };
    case '0': return { to: lineStart(f) };
    case '^': return { to: firstNonBlank(f) };
    case '$': {
      const q = n > 1 ? lineMove(f, n - 1) : p;
      return q === null ? null : { to: lineEnd(f, q), dollar: true };
    }
    case 'G': case 'gg': {
      const starts = lineStarts(f);
      const i = count ? Math.min(count, starts.length) - 1 : m.key === 'G' ? starts.length - 1 : 0;
      return { to: firstNonBlank(f, starts[i]), line: true };
    }
    case 'f': case 'F': case 't': case 'T': {
      f.vim.find = { key: m.key, ch: m.ch };
      const to = findInLine(f, m.key, m.ch, n);
      return to === null ? null : { to, incl: m.key === 'f' || m.key === 't' };
    }
    case ';': case ',': {
      const last = f.vim.find;
      if (!last) return null;
      const flip = { f: 'F', F: 'f', t: 'T', T: 't' };
      const key = m.key === ';' ? last.key : flip[last.key];
      const to = findInLine(f, key, last.ch, n);
      return to === null ? null : { to, incl: key === 'f' || key === 't' };
    }
    case '%': {
      const to = matchBracket(f, p);
      return to === null ? null : { to, incl: true };
    }
  }
  return null;
}
const MOTION_KEYS = new Set(['h', 'l', 'j', 'k', 'gj', 'gk', 'up', 'down', 'w', 'W', 'e', 'E', 'b', 'B', 'ge', 'gE', '0', '^', '$', 'G', 'gg', 'f', 'F', 't', 'T', ';', ',', '%']);

/** Text object `i`/`a` + ch around the cursor: [from, to), or null. */
function textObject(f, kind, ch) {
  const c = f.chars;
  const p = f.pos;
  const ls = lineStart(f);
  const le = lineEnd(f);
  if (ch === 'w' || ch === 'W') {
    const big = ch === 'W';
    const k = cls(c[p], big);
    const same = (q) => q >= ls && q < le && cls(c[q], big) === k;
    let a = p;
    let b = p;
    while (same(a - 1)) a--;
    while (same(b)) b++;
    if (kind === 'a') {
      if (k) {
        const b0 = b;
        while (b < le && isBlank(c[b])) b++;
        if (b === b0) while (a > ls && isBlank(c[a - 1])) a--; // no blanks after: take those before
      } else {
        const k2 = cls(c[b], big);
        while (b < le && cls(c[b], big) === k2 && k2) b++;
      }
    }
    return b > a ? [a, b] : null;
  }
  if (ch === '"' || ch === "'" || ch === '`') {
    const qs = [];
    for (let q = ls; q < le; q++) if (c[q] === ch && c[q - 1] !== '\\') qs.push(q);
    for (let i = 0; i + 1 < qs.length; i += 2) {
      if (p <= qs[i + 1]) {
        let [a, b] = [qs[i], qs[i + 1] + 1];
        if (kind === 'i') [a, b] = [a + 1, b - 1];
        else while (b < le && isBlank(c[b])) b++;
        return [a, b];
      }
    }
    return null;
  }
  const pair = PAIRS[ch];
  if (pair) {
    const [o, cl] = pair;
    let a = -1;
    for (let q = p, d = 0; q >= 0; q--) {
      if (c[q] === cl && q !== p) d++;
      else if (c[q] === o) {
        if (!d) {
          a = q;
          break;
        }
        d--;
      }
    }
    if (a < 0) return null;
    let b = -1;
    for (let q = a + 1, d = 0; q < c.length; q++) {
      if (c[q] === o) d++;
      else if (c[q] === cl) {
        if (!d) {
          b = q;
          break;
        }
        d--;
      }
    }
    if (b < 0) return null;
    return kind === 'i' ? [a + 1, b] : [a, b + 1];
  }
  return null;
}

// one undo step per vi command (an insert included, until esc)
function beginGroup(f) {
  if (f.vim.group) return;
  f.vim.group = { chars: [...f.chars], pos: f.pos };
  f.noSnap = true;
}
function endGroup(f) {
  const g = f.vim.group;
  if (!g) return;
  f.vim.group = null;
  f.noSnap = false;
  f.last = null;
  if (g.chars.join('') === f.chars.join('')) return;
  f.undo.push(g);
  if (f.undo.length > 200) f.undo.shift();
  f.redo = [];
}

/** Apply operator d / c / y / ~ / u / U to [a, b) or, linewise, to the lines of a..b. */
function applyOp(f, op, a, b, line) {
  const v = f.vim;
  const c = f.chars;
  if (line) {
    const ls = lineStart(f, Math.min(a, b));
    const le = lineEnd(f, Math.max(a, b));
    const text = c.slice(ls, le).join('') + '\n';
    if (op === 'y') {
      v.reg = { text, line: true };
      f.pos = Math.min(f.pos, a, b);
      return;
    }
    if (op === 'd') {
      v.reg = { text, line: true };
      if (le < c.length) remove(f, ls, le + 1);
      else if (ls > 0) remove(f, ls - 1, le);
      else remove(f, ls, le);
      f.pos = firstNonBlank(f, Math.min(f.pos, f.chars.length));
      return;
    }
    if (op === 'c') {
      v.reg = { text, line: true };
      remove(f, ls, le);
      f.pos = ls;
      v.mode = 'insert';
      return;
    }
    return applyOp(f, op, ls, le, false);
  }
  if (a > b) [a, b] = [b, a];
  const text = c.slice(a, b).join('');
  if (op === 'y') {
    v.reg = { text, line: false };
    f.pos = a;
  } else if (op === 'd' || op === 'c') {
    if (b > a) v.reg = { text, line: false };
    remove(f, a, b);
    f.pos = a;
    if (op === 'c') v.mode = 'insert';
  } else {
    const t = [...text].map((ch) => (op === 'u' ? ch.toLowerCase() : op === 'U' ? ch.toUpperCase() : ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()));
    remove(f, a, b);
    insert(f, t.join(''));
    f.pos = a;
  }
}

function put(f, before, count) {
  const { text, line } = f.vim.reg;
  if (!text) return;
  if (line && f.multiline) {
    const t = text.repeat(count);
    if (before) {
      const ls = lineStart(f);
      f.pos = ls;
      insert(f, t);
      f.pos = firstNonBlank(f, ls);
    } else {
      const le = lineEnd(f);
      f.pos = le;
      insert(f, '\n' + t.slice(0, -1));
      f.pos = firstNonBlank(f, le + 1);
    }
    return;
  }
  const t = (line ? text.replace(/\n$/, '').replace(/\n/g, ' ') : text).repeat(count);
  if (!before && f.pos < lineEnd(f)) f.pos++;
  insert(f, t);
  f.pos = Math.max(0, f.pos - 1);
}

function join(f, count) {
  for (let i = 0; i < Math.max(1, count - 1); i++) {
    const le = lineEnd(f);
    if (le >= f.chars.length) return;
    let q = le + 1;
    while (q < f.chars.length && isBlank(f.chars[q])) q++;
    remove(f, le, q);
    const next = f.chars[le];
    if (next !== undefined && next !== '\n' && next !== ')' && le > lineStart(f, le) && !isBlank(f.chars[le - 1])) insert(f, ' ');
    f.pos = le;
  }
}

/** Normal mode: the cursor sits on a character, not after a line's last one. */
function clampNormal(f) {
  f.pos = Math.max(0, Math.min(f.pos, f.chars.length));
  if (f.pos === lineEnd(f) && f.pos > lineStart(f)) f.pos--;
}

/**
 * Split pending keys into a command: [count] [operator [count]] motion-or-command [char].
 * 'more' while incomplete, null when it is no command.
 */
function parseVi(keys, visual) {
  let i = 0;
  const digits = () => {
    let s = '';
    while (i < keys.length && /^[0-9]$/.test(keys[i]) && !(s === '' && keys[i] === '0')) s += keys[i++];
    return s;
  };
  let count = digits();
  if (i >= keys.length) return 'more';
  let key = keys[i++];
  let op = null;
  if (!visual && 'dcy'.includes(key) && key.length === 1) {
    op = key;
    if (i >= keys.length) return 'more';
    if (keys[i] === op) return i + 1 === keys.length ? { count: +count || null, op, key: op, line: true } : null;
    const c2 = digits();
    if (count || c2) count = String((+count || 1) * (+c2 || 1));
    if (i >= keys.length) return 'more';
    key = keys[i++];
  }
  if (key === 'g') {
    if (i >= keys.length) return 'more';
    key = 'g' + keys[i++];
  }
  let ch = null;
  if ('fFtTr'.includes(key) && key.length === 1 && !(op && key === 'r')) {
    if (i >= keys.length) return 'more';
    ch = keys[i++];
  } else if ((op || visual) && (key === 'i' || key === 'a')) {
    if (i >= keys.length) return 'more';
    ch = keys[i++];
  }
  if (i < keys.length) return null;
  return { count: count ? +count : null, op, key, ch };
}

// keys that mean a vi key in normal and visual mode
const VI_ALIAS = { '\x1b[D': 'h', '\x1bOD': 'h', '\x1b[C': 'l', '\x1bOC': 'l', '\x1b[A': 'up', '\x1bOA': 'up', '\x1b[B': 'down', '\x1bOB': 'down', '\x7f': 'h', '\b': 'h', ' ': 'l', '\x1b[H': '0', '\x1bOH': '0', '\x1b[1~': '0', '\x1b[F': '$', '\x1bOF': '$', '\x1b[4~': '$', '\x1b[3~': 'x' };
const CHANGES = new Set(['x', 'X', 'D', 'C', 's', 'S', 'r', '~', 'J', 'p', 'P', 'i', 'a', 'I', 'A', 'o', 'O']);

function keyVi(f, k, { pasting = false, replay = false } = {}) {
  const v = f.vim;
  if (pasting) {
    // pasted text goes in as text at the cursor, in any mode
    return keyPlain(f, k, { pasting });
  }
  if (v.mode === 'insert') {
    // ⏎ is a new line here (sending is normal mode's); a one-line field has none: it sends
    if (k === '\r' && !f.multiline) return 'submit';
    if (k === '\r') k = '\n';
    if (k === '\x1b') {
      endGroup(f);
      v.mode = 'normal';
      if (f.pos > lineStart(f)) f.pos--;
      if (v.rec && !replay) {
        v.dot = [...v.rec, '\x1b'];
        v.rec = null;
      }
      return null;
    }
    if (KEY_OF.get(k) === 'undo' || KEY_OF.get(k) === 'redo') endGroup(f);
    if (v.rec && !replay) v.rec.push(k);
    if (!v.group && KEY_OF.get(k) !== 'undo' && KEY_OF.get(k) !== 'redo') beginGroup(f);
    return keyPlain(f, k);
  }
  const visual = v.mode === 'visual' || v.mode === 'vline';
  const awaitingChar = v.buf.length && /^[fFtTria]$/.test(v.buf.at(-1));
  if (k === '\r' && !awaitingChar) return (v.buf = []), 'submit';
  if (k === '\x1b') {
    if (v.buf.length) v.buf = [];
    else if (visual) v.mode = 'normal';
    else return 'cancel';
    return null;
  }
  const key = awaitingChar ? k : (VI_ALIAS[k] ?? k);
  if (key.length !== 1 && !['up', 'down'].includes(key)) return null; // other escape sequences
  v.buf.push(key);
  const cmd = parseVi(v.buf, visual);
  if (cmd === 'more') return null;
  const keys = v.buf;
  v.buf = [];
  if (!cmd) return null;
  if (!['j', 'k'].includes(cmd.key)) v.goal = null;
  if (!['up', 'down', 'gj', 'gk'].includes(cmd.key)) f.goal = null;
  if (visual) runVisual(f, cmd);
  else {
    const change = cmd.op === 'd' || cmd.op === 'c' || CHANGES.has(cmd.key);
    if (change && !replay) v.rec = [...keys];
    runNormal(f, cmd, replay);
    if (change && !replay && v.mode !== 'insert') {
      v.dot = v.rec;
      v.rec = null;
    }
  }
  if (v.mode === 'normal') clampNormal(f);
  return null;
}

function runNormal(f, cmd, replay) {
  const v = f.vim;
  const n = cmd.count ?? 1;
  const { key, op } = cmd;
  if (op) {
    beginGroup(f);
    if (cmd.line) {
      const to = n > 1 ? (lineMove(f, n - 1) ?? lineEnd(f)) : f.pos;
      applyOp(f, op, f.pos, to, true);
    } else if (key === 'i' || key === 'a') {
      const r = textObject(f, key, cmd.ch);
      if (r) applyOp(f, op, r[0], r[1], false);
    } else if (MOTION_KEYS.has(key)) {
      // cw on a word changes to its end (like ce)
      const m = op === 'c' && (key === 'w' || key === 'W') && cls(f.chars[f.pos], key === 'W') ? { key: key === 'w' ? 'e' : 'E' } : { key, ch: cmd.ch };
      const r = motion(f, m, cmd.count, op);
      if (r) {
        if (r.line) applyOp(f, op, f.pos, r.to, true);
        else applyOp(f, op, f.pos, r.incl ? Math.max(f.pos, r.to) + 1 : r.to, false);
      }
    }
    if (v.mode !== 'insert') endGroup(f);
    return;
  }
  if (MOTION_KEYS.has(key)) {
    const r = motion(f, { key, ch: cmd.ch }, cmd.count, null);
    if (r) f.pos = r.to;
    return;
  }
  const insertAt = (p) => {
    beginGroup(f);
    f.pos = p;
    v.mode = 'insert';
  };
  const change = (fn) => {
    beginGroup(f);
    fn();
    if (v.mode !== 'insert') endGroup(f);
  };
  switch (key) {
    case 'i': return insertAt(f.pos);
    case 'a': return insertAt(Math.min(f.pos + 1, lineEnd(f)));
    case 'I': return insertAt(firstNonBlank(f));
    case 'A': return insertAt(lineEnd(f));
    case 'o': case 'O':
      if (!f.multiline) return;
      beginGroup(f);
      f.pos = key === 'o' ? lineEnd(f) : lineStart(f);
      insert(f, '\n');
      if (key === 'O') f.pos--;
      v.mode = 'insert';
      return;
    case 'x': return change(() => applyOp(f, 'd', f.pos, Math.min(lineEnd(f), f.pos + n), false));
    case 'X': return change(() => applyOp(f, 'd', Math.max(lineStart(f), f.pos - n), f.pos, false));
    case 'D': case 'C': return change(() => applyOp(f, key === 'D' ? 'd' : 'c', f.pos, lineEnd(f, n > 1 ? (lineMove(f, n - 1) ?? f.pos) : f.pos), false));
    case 's': return change(() => applyOp(f, 'c', f.pos, Math.min(lineEnd(f), f.pos + n), false));
    case 'S': return change(() => applyOp(f, 'c', f.pos, n > 1 ? (lineMove(f, n - 1) ?? f.pos) : f.pos, true));
    case 'Y': return applyOp(f, 'y', f.pos, n > 1 ? (lineMove(f, n - 1) ?? f.pos) : f.pos, true);
    case 'r':
      if (f.pos + n > lineEnd(f) || cmd.ch.length !== 1 || cmd.ch < ' ') return;
      return change(() => {
        remove(f, f.pos, f.pos + n);
        insert(f, cmd.ch.repeat(n));
        f.pos--;
      });
    case '~': return change(() => {
      const b = Math.min(lineEnd(f), f.pos + n);
      applyOp(f, '~', f.pos, b, false);
      f.pos = b;
    });
    case 'J': return f.multiline && change(() => join(f, n));
    case 'p': case 'P': return change(() => put(f, key === 'P', n));
    case 'u': case '\x1a':
      for (let i = 0; i < n; i++) keyPlain(f, '\x1a');
      return;
    case '\x12': // ctrl+r
      for (let i = 0; i < n; i++) keyPlain(f, '\x1bz');
      return;
    case '.':
      if (!v.dot || replay) return;
      for (let i = 0; i < n; i++) for (const k of v.dot) keyVi(f, k, { replay: true });
      return;
    case 'v': case 'V':
      v.mode = key === 'v' ? 'visual' : 'vline';
      v.anchor = f.pos;
      return;
  }
}

/** The selected range [from, to) in visual mode, else null. */
function selection(f) {
  const v = f.vim;
  if (!v || (v.mode !== 'visual' && v.mode !== 'vline')) return null;
  const a = Math.min(v.anchor, f.pos);
  const b = Math.max(v.anchor, f.pos);
  if (v.mode === 'vline') return [lineStart(f, a), Math.min(f.chars.length, lineEnd(f, b) + 1)];
  return [a, Math.min(f.chars.length, b + 1)];
}

function runVisual(f, cmd) {
  const v = f.vim;
  const { key } = cmd;
  if (MOTION_KEYS.has(key)) {
    const r = motion(f, { key, ch: cmd.ch }, cmd.count, null);
    if (r) f.pos = Math.min(r.to, Math.max(0, f.chars.length - 1));
    return;
  }
  if ((key === 'i' || key === 'a') && cmd.ch) {
    const r = textObject(f, key, cmd.ch);
    if (r) [v.anchor, f.pos] = [r[0], Math.max(r[0], r[1] - 1)];
    return;
  }
  const a = Math.min(v.anchor, f.pos);
  const b = Math.max(v.anchor, f.pos);
  const line = v.mode === 'vline';
  const end = Math.min(f.chars.length, b + 1);
  const op = (o, lw = line) => {
    beginGroup(f);
    v.mode = 'normal';
    f.pos = a;
    applyOp(f, o, a, lw ? b : end, lw);
    if (v.mode !== 'insert') endGroup(f);
  };
  switch (key) {
    case 'o': case 'O': [v.anchor, f.pos] = [f.pos, v.anchor]; return;
    case 'v': case 'V': {
      const m = key === 'v' ? 'visual' : 'vline';
      v.mode = v.mode === m ? 'normal' : m;
      return;
    }
    case 'd': case 'x': return op('d');
    case 'X': case 'D': return op('d', true);
    case 'c': case 's': return op('c');
    case 'C': case 'S': case 'R': return op('c', true);
    case 'y': return op('y');
    case 'Y': return op('y', true);
    case '~': case 'u': case 'U': return op(key);
    case 'J':
      if (!f.multiline) return;
      beginGroup(f);
      v.mode = 'normal';
      f.pos = a;
      join(f, Math.max(2, lineIndex(lineStarts(f), b) - lineIndex(lineStarts(f), a) + 1));
      endGroup(f);
      return;
    case 'p': case 'P': {
      const reg = v.reg;
      beginGroup(f);
      v.mode = 'normal';
      applyOp(f, 'd', a, line ? b : end, line);
      const replaced = v.reg;
      v.reg = reg;
      put(f, true, 1);
      v.reg = replaced;
      endGroup(f);
      return;
    }
  }
}
