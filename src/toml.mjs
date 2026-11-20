// TOML for ATF's config files (no dependencies): parseToml / stringifyToml, and
// readConfigFile, which reads <dir>/<name>.toml and falls back to <name>.json (the
// format before TOML). Covered: comments, bare/quoted/dotted keys, [tables], [[arrays of
// tables]], basic/literal/multi-line strings, integers (dec/hex/oct/bin), floats,
// booleans, arrays and inline tables. Not covered: dates and times (an error says so).
import fs from 'node:fs';
import path from 'node:path';

export function parseToml(src) {
  src = String(src).replace(/^﻿/, '');
  let i = 0;
  const root = {};
  let cur = root;
  const defined = new Set(); // tables declared with [header]
  const lineAt = () => src.slice(0, i).split('\n').length;
  const fail = (m) => {
    throw new SyntaxError(`line ${lineAt()}: ${m}`);
  };
  const ws = () => {
    while (src[i] === ' ' || src[i] === '\t') i++;
  };
  const comment = () => {
    if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
  };
  const blank = () => {
    for (;;) {
      ws();
      comment();
      if (src[i] === '\n') i++;
      else if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
      else return;
    }
  };
  const eol = () => {
    ws();
    comment();
    if (i >= src.length) return;
    if (src[i] === '\n') return void i++;
    if (src[i] === '\r' && src[i + 1] === '\n') return void (i += 2);
    fail(`unexpected ${JSON.stringify(src[i])} (one key = value per line)`);
  };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function simpleKey() {
    if (src[i] === '"') return basicString();
    if (src[i] === "'") return literalString();
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
    if (!m) fail('expected a key');
    i += m[0].length;
    return m[0];
  }
  function keyPath() {
    const keys = [];
    for (;;) {
      ws();
      keys.push(simpleKey());
      ws();
      if (src[i] !== '.') return keys;
      i++;
    }
  }
  function escape() {
    const c = src[i++];
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
    if (c in simple) return simple[c];
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8;
      const hex = src.slice(i, i + n);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) fail('bad \\u escape');
      i += n;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    fail(`unknown escape \\${c}`);
  }
  function basicString() {
    i++; // "
    let s = '';
    for (;;) {
      const c = src[i];
      if (c === undefined || c === '\n') fail('unterminated string');
      i++;
      if (c === '"') return s;
      s += c === '\\' ? escape() : c;
    }
  }
  function literalString() {
    i++; // '
    const end = src.indexOf("'", i);
    const nl = src.indexOf('\n', i);
    if (end < 0 || (nl >= 0 && nl < end)) fail('unterminated string');
    const s = src.slice(i, end);
    i = end + 1;
    return s;
  }
  function multiString(q) {
    i += 3;
    if (src[i] === '\n') i++;
    else if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
    let s = '';
    for (;;) {
      if (i >= src.length) fail('unterminated multi-line string');
      if (src.startsWith(q.repeat(3), i)) {
        // up to two quotes right before the closing three belong to the string
        let n = 0;
        while (src[i + n] === q) n++;
        if (n > 5) fail('too many quotes');
        i += n;
        return s + q.repeat(n - 3);
      }
      const c = src[i++];
      if (q === '"' && c === '\\') {
        // a backslash at the end of a line trims the newline and following whitespace
        const rest = /^[ \t]*\r?\n[\s]*/.exec(src.slice(i));
        if (rest) i += rest[0].length;
        else s += escape();
      } else s += c;
    }
  }
  function value() {
    if (src.startsWith('"""', i)) return multiString('"');
    if (src.startsWith("'''", i)) return multiString("'");
    const c = src[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        blank();
        if (src[i] === ']') return i++, arr;
        arr.push(value());
        blank();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') fail('expected , or ] in array');
      }
    }
    if (c === '{') {
      i++;
      const t = {};
      ws();
      if (src[i] === '}') return i++, t;
      for (;;) {
        const keys = keyPath();
        if (src[i] !== '=') fail('expected = in inline table');
        i++;
        ws();
        put(t, keys, value());
        ws();
        if (src[i] === '}') return i++, t;
        if (src[i] !== ',') fail('expected , or } in inline table');
        i++;
      }
    }
    const rest = src.slice(i);
    let m;
    if ((m = /^(true|false)(?![A-Za-z0-9_-])/.exec(rest))) return (i += m[0].length), m[0] === 'true';
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(rest)) fail('dates and times are not supported here: quote them');
    if ((m = /^[+-]?(inf|nan)(?![A-Za-z0-9_])/.exec(rest))) return (i += m[0].length), m[1] === 'inf' ? (m[0][0] === '-' ? -Infinity : Infinity) : NaN;
    if ((m = /^0x[0-9a-fA-F_]+|^0o[0-7_]+|^0b[01_]+/.exec(rest))) return (i += m[0].length), Number(m[0].replace(/_/g, ''));
    if ((m = /^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?(?![A-Za-z0-9_.:-])/.exec(rest))) return (i += m[0].length), Number(m[0].replace(/_/g, ''));
    fail(`expected a value${rest[0] ? ` (strings need quotes: "${rest.split(/[\s#]/)[0]}")` : ''}`);
  }
  function put(table, keys, v) {
    let t = table;
    for (const k of keys.slice(0, -1)) {
      if (t[k] === undefined) t[k] = {};
      else if (!isObj(t[k])) fail(`${keys.join('.')}: ${k} is not a table`);
      t = t[k];
    }
    const last = keys.at(-1);
    if (last in t) fail(`${keys.join('.')} is defined twice`);
    t[last] = v;
  }

  for (;;) {
    blank();
    if (i >= src.length) return root;
    if (src[i] === '[') {
      const array = src[i + 1] === '[';
      i += array ? 2 : 1;
      const keys = keyPath();
      if (!src.startsWith(array ? ']]' : ']', i)) fail(`expected ${array ? ']]' : ']'}`);
      i += array ? 2 : 1;
      eol();
      let t = root;
      for (const k of keys.slice(0, -1)) {
        if (t[k] === undefined) t[k] = {};
        t = Array.isArray(t[k]) ? t[k].at(-1) : t[k];
        if (!isObj(t)) fail(`${keys.join('.')}: ${k} is not a table`);
      }
      const last = keys.at(-1);
      if (array) {
        if (t[last] === undefined) t[last] = [];
        if (!Array.isArray(t[last])) fail(`${keys.join('.')} is not an array of tables`);
        t[last].push((cur = {}));
      } else {
        const name = keys.join('\0');
        if (defined.has(name)) fail(`[${keys.join('.')}] is defined twice`);
        defined.add(name);
        if (t[last] === undefined) t[last] = {};
        if (!isObj(t[last])) fail(`${keys.join('.')} is not a table`);
        cur = t[last];
      }
      continue;
    }
    const keys = keyPath();
    if (src[i] !== '=') fail('expected =');
    i++;
    ws();
    put(cur, keys, value());
    eol();
  }
}

// ---------- writing ----------

const bareKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTableArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isTable);

function inline(v) {
  if (typeof v === 'string') return JSON.stringify(v); // a JSON string is a valid TOML basic string
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf';
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.filter((x) => x != null).map(inline).join(', ')}]`;
  if (isTable(v)) {
    const parts = Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => `${bareKey(k)} = ${inline(x)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  throw new TypeError(`cannot write ${typeof v} as TOML`);
}

/** TOML text for a plain object (null / undefined values are left out: TOML has no null). */
export function stringifyToml(obj) {
  const out = [];
  const section = (t, prefix) => {
    const entries = Object.entries(t).filter(([, v]) => v != null);
    for (const [k, v] of entries) if (!isTable(v) && !isTableArray(v)) out.push(`${bareKey(k)} = ${inline(v)}`);
    for (const [k, v] of entries) {
      const name = [...prefix, bareKey(k)];
      if (isTable(v)) {
        const scalars = Object.values(v).some((x) => x != null && !isTable(x) && !isTableArray(x));
        // a table holding only tables needs no header of its own
        if (scalars || !Object.keys(v).length) out.push('', `[${name.join('.')}]`);
        section(v, name);
      } else if (isTableArray(v))
        for (const item of v) {
          out.push('', `[[${name.join('.')}]]`);
          section(item, name);
        }
    }
  };
  section(obj, []);
  while (out[0] === '') out.shift();
  return out.join('\n') + '\n';
}

// ---------- config files ----------

/**
 * Read <dir>/<name>.toml, else <name>.json. Returns {data, file, format, error}: data is
 * {} when there is no file or it cannot be read (then `error` says why).
 */
export function readConfigFile(dir, name = 'config') {
  for (const format of ['toml', 'json']) {
    const file = path.join(dir, `${name}.${format}`);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const data = format === 'toml' ? parseToml(text) : JSON.parse(text);
      return { data: data && typeof data === 'object' ? data : {}, file, format, error: null };
    } catch (e) {
      return { data: {}, file, format, error: e.message };
    }
  }
  return { data: {}, file: null, format: null, error: null };
}

/** Write <dir>/<name>.toml (atomically) and remove an old <name>.json beside it. */
export function writeConfigFile(dir, data, name = 'config', header = '') {
  const file = path.join(dir, `${name}.toml`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file + '.tmp', header + stringifyToml(data));
  fs.renameSync(file + '.tmp', file);
  fs.rmSync(path.join(dir, `${name}.json`), { force: true });
  return file;
}
