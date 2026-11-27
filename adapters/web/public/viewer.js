// The viewer: files (Markdown rendered, code highlighted), diffs and a task's live runs,
// in place of the board. Third-party: marked (MIT) and highlight.js (BSD-3-Clause), in
// vendor/. Rendered Markdown goes through an allowlist sanitizer: a document from a
// repository must never run script in a page that acts as the human.
import { marked } from './vendor/marked/marked.esm.js';
import hljs from './vendor/highlight/highlight.min.js';

// grammars the common bundle lacks
const EXTRA = ['dockerfile', 'gradle', 'groovy', 'scala', 'protobuf', 'powershell', 'nginx'];
const extraLoaded = Promise.all(EXTRA.map((l) => import(`./vendor/highlight/languages/${l}.min.js`).then((m) => hljs.registerLanguage(l, m.default)).catch(() => {})));

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', java: 'java', kt: 'kotlin', kts: 'kotlin',
  groovy: 'groovy', gradle: 'gradle', scala: 'scala', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', properties: 'ini', cfg: 'ini', conf: 'ini', xml: 'xml', html: 'xml', htm: 'xml',
  svg: 'xml', css: 'css', scss: 'scss', less: 'less', sql: 'sql', md: 'markdown', markdown: 'markdown', diff: 'diff', patch: 'diff', proto: 'protobuf', graphql: 'graphql', lua: 'lua',
  php: 'php', swift: 'swift', r: 'r', pl: 'perl', mk: 'makefile', tf: 'ini', log: 'plaintext', txt: 'plaintext',
};
const LANG_BY_NAME = { Dockerfile: 'dockerfile', Makefile: 'makefile', Jenkinsfile: 'groovy', 'nginx.conf': 'nginx' };
export function langOf(file) {
  const base = String(file).split('/').pop();
  if (LANG_BY_NAME[base]) return LANG_BY_NAME[base];
  if (/^Dockerfile\./.test(base)) return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return LANG_BY_EXT[ext] || null;
}
const isMarkdown = (file) => /\.(md|markdown|mdx)$/i.test(file);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const HIGHLIGHT_MAX = 400 << 10; // beyond this, plain text (highlighting would stall the page)

/** Highlighted HTML of code (escaped by highlight.js; plain escaped text without a language). */
export function highlight(text, lang) {
  if (text.length > HIGHLIGHT_MAX) return esc(text);
  try {
    if (lang && lang !== 'plaintext' && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {}
  return esc(text);
}

// ---------------------------------------------------------------- Markdown
marked.use({
  gfm: true,
  // raw HTML in a document is shown as text, never parsed
  renderer: {
    html: (token) => esc(token.text ?? token.raw ?? ''),
    code(token) {
      const lang = (token.lang || '').split(/\s/)[0].toLowerCase();
      const known = lang && hljs.getLanguage(lang) ? lang : null;
      return `<pre><code class="hljs${known ? ` language-${known}` : ''}">${known ? highlight(token.text, known) : esc(token.text)}</code></pre>\n`;
    },
  },
});
const ALLOWED = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'SPAN', 'EM', 'STRONG', 'DEL', 'S', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'BR', 'INPUT', 'IMG', 'SUP', 'SUB', 'KBD', 'DETAILS', 'SUMMARY']);
const ATTRS = { A: ['href', 'title'], CODE: ['class'], SPAN: ['class'], PRE: ['class'], TH: ['align'], TD: ['align'], INPUT: ['type', 'checked', 'disabled'], OL: ['start'], IMG: ['alt', 'title', 'src'] };
const safeHref = (h) => /^(https?:|mailto:|#)/i.test(h) || (!/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('//'));

/** Markdown as sanitized DOM nodes. `onLink(href)` gets clicks on relative links (other files). */
export function renderMarkdown(text, { onLink } = {}) {
  const html = marked.parse(text);
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html'); // inert: nothing runs or loads
  const clean = (node) => {
    for (const el of [...node.children]) {
      if (!ALLOWED.has(el.tagName)) {
        el.replaceWith(doc.createTextNode(el.textContent));
        continue;
      }
      for (const a of [...el.attributes]) if (!(ATTRS[el.tagName] || []).includes(a.name)) el.removeAttribute(a.name);
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (!safeHref(href)) el.removeAttribute('href');
        else if (/^https?:/i.test(href)) el.setAttribute('target', '_blank'), el.setAttribute('rel', 'noopener noreferrer');
      }
      if (el.tagName === 'INPUT' && el.getAttribute('type') !== 'checkbox') {
        el.remove();
        continue;
      }
      if (el.tagName === 'IMG') {
        // images are not fetched (no external requests, no file serving): their text instead
        el.replaceWith(doc.createTextNode(`[${el.getAttribute('alt') || 'image'}: ${el.getAttribute('src') || ''}]`));
        continue;
      }
      if ((el.tagName === 'CODE' || el.tagName === 'SPAN' || el.tagName === 'PRE') && el.className && !/^(hljs[\w -]*|language-[\w-]+)( [\w-]+)*$/.test(el.className)) el.removeAttribute('class');
      clean(el);
    }
  };
  const root = doc.body.firstElementChild;
  clean(root);
  const out = document.importNode(root, true);
  out.className = 'md';
  if (onLink)
    out.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      const href = a?.getAttribute('href');
      if (!href || /^(https?:|mailto:)/i.test(href)) return;
      e.preventDefault();
      if (href.startsWith('#')) return out.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView();
      onLink(href.split('#')[0]);
    });
  // heading ids for in-document links
  for (const hd of out.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    hd.id = hd.textContent
      .trim()
      .toLowerCase()
      .replace(/[^\w\- ]+/g, '')
      .replace(/\s+/g, '-');
  return out;
}

/** Code with line numbers: a gutter beside the highlighted text. */
export function codeBlock(text, lang, h) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const code = h('code', { class: `hljs${lang ? ` language-${lang}` : ''}` });
  code.innerHTML = highlight(lines.join('\n'), lang); // escaped by highlight.js / esc
  return h('div', { class: 'code' }, h('pre', { class: 'gutter', 'aria-hidden': 'true' }, lines.map((_, i) => i + 1).join('\n')), h('pre', { class: 'src' }, code));
}

/** A unified diff: per file a heading, lines coloured, hunks marked. */
export function diffBlock(text, h) {
  if (!text.trim()) return h('p', { class: 'meta' }, 'No changes.');
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.*)$/);
      cur = h('div', { class: 'dfile' }, h('div', { class: 'dhead' }, m ? m[1] : line));
      out.push(cur);
      continue;
    }
    if (!cur) cur = out[out.push(h('div', { class: 'dfile' })) - 1];
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    const cls = line.startsWith('@@') ? 'dhunk' : line.startsWith('+') ? 'dadd' : line.startsWith('-') ? 'ddel' : line.startsWith('\\') ? 'dmeta' : '';
    cur.append(h('div', { class: `dl ${cls}` }, line || ' '));
  }
  return h('div', { class: 'diff' }, out);
}

await extraLoaded;
