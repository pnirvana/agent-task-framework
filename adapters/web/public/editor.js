// The editor area: groups of tabs (at most two, side by side), each tab a document: a task,
// a plan, a live view, a file, a diff, a terminal. As in an IDE: a single click opens a
// preview tab (the next preview replaces it), a double-click or working in it keeps it;
// the open tabs are remembered across reloads.
import { h, store, menu } from './util.js';

/**
 * `host`: the editor element. `render(tab, el, {visible})` draws a tab's document into
 * `el`; `title(tab)` -> {label, icon, cls, tip}; `welcome()` -> the empty editor's content;
 * `onChange()` after tabs change (the panels mark what is open).
 */
export function createEditor({ host, render, title, welcome, onChange = () => {}, onClose = () => {} }) {
  const tabs = new Map(); // key -> tab {key, kind, ..., preview, rt}
  let groups = [{ tabs: [], active: null }];
  let focused = 0;

  const save = () =>
    store.set('editor', {
      groups: groups.map((g) => ({ tabs: g.tabs.map((k) => strip(tabs.get(k))).filter(Boolean), active: g.active })),
      focused,
    });
  const strip = (t) => {
    if (!t) return null;
    const { rt, ...rest } = t;
    return rest;
  };

  function restore(valid) {
    const s = store.get('editor', null);
    if (!s?.groups?.length) return;
    groups = s.groups.map((g) => ({ tabs: [], active: null, want: g.active }));
    s.groups.forEach((g, i) => {
      for (const t of g.tabs) {
        if (!valid(t)) continue;
        tabs.set(t.key, { ...t, rt: {} });
        groups[i].tabs.push(t.key);
      }
      groups[i].active = groups[i].tabs.includes(groups[i].want) ? groups[i].want : groups[i].tabs[0] ?? null;
      delete groups[i].want;
    });
    groups = groups.filter((g, i) => g.tabs.length || i === 0);
    focused = Math.min(s.focused ?? 0, groups.length - 1);
  }

  const groupOf = (key) => groups.findIndex((g) => g.tabs.includes(key));

  /**
   * Open a document. `preview`: replace the group's preview tab (a single click); else
   * a kept tab. `group`: 0 / 1 / 'other' (split); default the focused group.
   */
  function open(desc, { preview = true, group = null, activate = true } = {}) {
    let gi = group === 'other' ? (groups.length > 1 ? 1 - focused : (groups.push({ tabs: [], active: null }), groups.length - 1)) : group ?? focused;
    const existing = tabs.get(desc.key);
    if (existing) {
      const at = groupOf(desc.key);
      Object.assign(existing, { ...desc, preview: existing.preview && preview });
      if (group != null && at !== gi) move(desc.key, gi);
      else gi = at;
    } else {
      const g = groups[gi];
      const prev = g.tabs.map((k) => tabs.get(k)).find((t) => t.preview);
      const t = { ...desc, preview, rt: {} };
      tabs.set(desc.key, t);
      if (preview && prev) {
        // the preview's place, the old one gone
        g.tabs[g.tabs.indexOf(prev.key)] = desc.key;
        drop(prev.key);
      } else {
        const at = g.tabs.indexOf(g.active);
        g.tabs.splice(at < 0 ? g.tabs.length : at + 1, 0, desc.key);
      }
    }
    if (activate) {
      groups[gi].active = desc.key;
      focused = gi;
    }
    draw();
    return tabs.get(desc.key);
  }
  function drop(key) {
    const t = tabs.get(key);
    if (!t) return;
    t.rt?.dispose?.();
    tabs.delete(key);
    onClose(t);
  }
  function close(key) {
    const gi = groupOf(key);
    if (gi < 0) return;
    const g = groups[gi];
    const i = g.tabs.indexOf(key);
    g.tabs.splice(i, 1);
    drop(key);
    if (g.active === key) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] ?? null;
    if (!g.tabs.length && groups.length > 1) {
      groups.splice(gi, 1);
      focused = 0;
    }
    draw();
  }
  function move(key, gi) {
    const from = groupOf(key);
    if (from < 0 || from === gi) return;
    groups[from].tabs.splice(groups[from].tabs.indexOf(key), 1);
    if (groups[from].active === key) groups[from].active = groups[from].tabs[0] ?? null;
    if (!groups[gi]) groups.push({ tabs: [], active: null });
    groups[gi].tabs.push(key);
    groups[gi].active = key;
    focused = gi;
    if (!groups[from].tabs.length && groups.length > 1) {
      groups.splice(from, 1);
      focused = groups.findIndex((g) => g.tabs.includes(key));
    }
    draw();
  }
  const keep = (key) => {
    const t = tabs.get(key);
    if (t?.preview) (t.preview = false), draw();
  };
  function activate(key) {
    const gi = groupOf(key);
    if (gi < 0) return;
    groups[gi].active = key;
    focused = gi;
    draw();
  }

  const docEls = new Map(); // group index -> its document element
  function draw() {
    const els = groups.map((g, gi) => {
      const bar = h(
        'div',
        { class: 'etabs', role: 'tablist' },
        g.tabs.map((k) => {
          const t = tabs.get(k);
          const ti = title(t);
          return h(
            'div',
            {
              class: `etab${k === g.active ? ' on' : ''}${t.preview ? ' preview' : ''} ${ti.cls ?? ''}`,
              title: ti.tip ?? ti.label,
              role: 'tab',
              onclick: () => activate(k),
              ondblclick: () => keep(k),
              onauxclick: (e) => e.button === 1 && close(k),
              oncontextmenu: (e) =>
                menu(e, [
                  { label: 'Keep open', run: () => keep(k) },
                  { label: groups.length > 1 ? 'Move to the other side' : 'Open to the side', run: () => move(k, groups.length > 1 ? 1 - gi : 1) },
                  null,
                  { label: 'Close', run: () => close(k) },
                  { label: 'Close the others', run: () => g.tabs.filter((x) => x !== k).forEach(close) },
                  { label: 'Close all', run: () => [...g.tabs].forEach(close) },
                ]),
            },
            ti.icon ? h('span', { class: 'kind' }, ti.icon) : '',
            h('span', { class: 'lbl' }, ti.label),
            h('button', { class: 'x', title: 'close', onclick: (e) => (e.stopPropagation(), close(k)) }, '×'),
          );
        }),
        g.active && groups.length === 1 ? h('span', { class: 'tools' }, h('button', { class: 'icon', title: 'open to the side (split)', onclick: () => move(g.active, 1) }, '◫')) : '',
      );
      let doc = docEls.get(gi);
      if (!doc) docEls.set(gi, (doc = h('div', { class: 'edoc' })));
      doc.onpointerdown = () => focused !== gi && ((focused = gi), host.querySelectorAll('.egroup').forEach((x, i) => x.classList.toggle('focus', i === gi)));
      return h('div', { class: `egroup${gi === focused && groups.length > 1 ? ' focus' : ''}` }, bar, doc);
    });
    for (const k of [...docEls.keys()]) if (k >= groups.length) docEls.delete(k);
    host.replaceChildren(...els);
    groups.forEach((g, gi) => {
      const doc = docEls.get(gi);
      const t = g.active && tabs.get(g.active);
      doc.className = 'edoc';
      if (!t) {
        doc.replaceChildren(welcome());
        doc.dataset.key = '';
      } else {
        if (doc.dataset.key !== t.key) doc.scrollTop = t.rt.scroll ?? 0;
        doc.onscroll = () => (t.rt.scroll = doc.scrollTop);
        doc.dataset.key = t.key;
        render(t, doc, { visible: true });
      }
    });
    // tabs not shown now: they stop what they do while hidden (live polling)
    for (const t of tabs.values()) if (!groups.some((g) => g.active === t.key)) t.rt.hidden?.();
    save();
    onChange();
  }

  /** Draw the shown tabs again (their data changed). */
  function refresh(filter = () => true) {
    groups.forEach((g, gi) => {
      const t = g.active && tabs.get(g.active);
      if (t && filter(t)) render(t, docEls.get(gi), { visible: true });
    });
  }

  return {
    open,
    close,
    keep,
    activate,
    move,
    refresh,
    draw,
    restore,
    get: (key) => tabs.get(key),
    all: () => [...tabs.values()],
    shown: () => groups.map((g) => g.active && tabs.get(g.active)).filter(Boolean),
    active: () => (groups[focused]?.active ? tabs.get(groups[focused].active) : null),
    isOpen: (key) => tabs.has(key),
  };
}
