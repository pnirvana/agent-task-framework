// Small helpers shared by the page's modules: DOM building, times, storage, the API.

export const $ = (s, root = document) => root.querySelector(s);

/** An element: h('div', {class: 'x', onclick}, child, 'text', [more]); text is never parsed as HTML. */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false && c !== '') el.append(c instanceof Node ? c : String(c));
  return el;
}

export const ago = (ts) => {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
export const first = (s, max = 160) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};

export const store = {
  get: (k, d) => {
    try {
      return JSON.parse(localStorage.getItem(`atf.${k}`)) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => localStorage.setItem(`atf.${k}`, JSON.stringify(v)),
};

let toastTimer = null;
export function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `on${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 6000 : 3500);
}

export async function api(path, body) {
  const r = await fetch(`/api/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) location.reload();
  if (!r.ok && !('ok' in j)) throw new Error(j.error || `${r.status}`);
  return j;
}
export const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

/** A small menu at the pointer: items [{label, run, danger?}] (null: a separator). */
export function menu(e, items) {
  e.preventDefault();
  closeMenu();
  const m = h(
    'div',
    { class: 'menu', role: 'menu' },
    items.map((it) => (it ? h('button', { class: it.danger ? 'danger' : '', role: 'menuitem', onclick: () => (closeMenu(), it.run()) }, it.label, it.key ? h('kbd', {}, it.key) : '') : h('hr'))),
  );
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  setTimeout(() => addEventListener('pointerdown', onAway, { once: true }), 0);
}
const onAway = (e) => (e.target.closest('.menu') ? addEventListener('pointerdown', onAway, { once: true }) : closeMenu());
export const closeMenu = () => document.querySelectorAll('.menu').forEach((m) => m.remove());
