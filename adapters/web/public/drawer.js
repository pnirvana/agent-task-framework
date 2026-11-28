// The inspector: details of one thing (a task, a plan, a run, a file, a diff) in a panel
// that slides in over In flight, with the cockpit staying where it is. One at a time; what
// you open from it goes on top, ‹ (or the browser's back) returns, esc closes. Its views
// keep their state (a draft being written) while you go back and forth.
import { h, store } from './util.js';

/**
 * `host`: the drawer element. `render(view, el)` draws a view into `el`; `head(view)` ->
 * {crumbs: [{label, run?, tip?, cls?}], colour?: the plan's, tabs: [{label, key, on}], tools: [elements], status?: element}
 * (the status: on the tabs' row, at its right); `onChange()`.
 */
export function createDrawer({ host, render, head, onChange = () => {} }) {
  const views = new Map(); // key -> view {key, kind, ..., rt}; kept while in the stack
  let stack = []; // keys, the last shown
  const body = h('div', { class: 'dbody' });
  const bar = h('div', { class: 'dhead' });
  host.replaceChildren(h('div', { class: 'dgrip', title: 'drag: wider / narrower' }), bar, body);

  const cur = () => (stack.length ? views.get(stack[stack.length - 1]) : null);
  const save = () => store.set('drawer', stack.map((k) => strip(views.get(k))).filter(Boolean));
  const strip = (v) => {
    if (!v) return null;
    const { rt, ...rest } = v;
    return rest;
  };

  /** Show `desc` ({key, kind, ...}). `replace`: instead of the current one (its tabs). */
  function open(desc, { replace = false, push = true } = {}) {
    const old = cur();
    let v = views.get(desc.key);
    if (v) Object.assign(v, desc);
    else views.set(desc.key, (v = { ...desc, rt: {} }));
    if (old && old.key === v.key) return draw(), v;
    if (old) old.rt.hidden?.();
    if (replace && stack.length) stack[stack.length - 1] = v.key;
    else stack = [...stack.filter((k) => k !== v.key), v.key];
    prune();
    if (push) (replace && old ? history.replaceState : history.pushState).call(history, { atf: stack }, '');
    host.classList.add('on');
    draw(true);
    return v;
  }
  function prune() {
    for (const k of views.keys()) if (!stack.includes(k)) views.get(k).rt.dispose?.(), views.delete(k);
  }
  function back() {
    cur()?.rt.hidden?.();
    stack = stack.slice(0, -1);
    prune();
    stack.length ? draw(true) : hide();
  }
  function close() {
    cur()?.rt.hidden?.();
    stack = [];
    prune();
    hide();
  }
  function hide() {
    host.classList.remove('on');
    body.replaceChildren();
    body.dataset.key = '';
    save();
    onChange();
  }
  // the browser's back and forward go through what the drawer showed
  addEventListener('popstate', (e) => {
    const want = e.state?.atf ?? [];
    if (!want.length) return close();
    const top = want[want.length - 1];
    if (views.has(top)) {
      cur()?.rt.hidden?.();
      stack = want.filter((k) => views.has(k));
      host.classList.add('on');
      draw(true);
    }
  });

  function draw(moved = false) {
    const v = cur();
    if (!v) return hide();
    const hd = head(v);
    // what it belongs to: the plan's colour on the panel's edge (as on the plan's box)
    hd.colour ? host.style.setProperty('--pl', hd.colour) : host.style.removeProperty('--pl');
    bar.replaceChildren(
      h('button', { class: 'icon', title: 'back (the browser’s back too)', disabled: stack.length < 2 ? true : null, onclick: () => history.back() }, '‹'),
      h(
        'nav',
        { class: 'crumbs' },
        hd.crumbs.map((c, i) => [
          i ? h('span', { class: 'sep' }, '›') : '',
          c.run ? h('a', { class: c.cls ?? null, onclick: c.run, title: c.tip ?? '' }, c.label) : h('b', { class: c.cls ?? null, title: c.tip ?? '' }, c.label),
        ]),
      ),
      ...(hd.tools ?? []),
      h('button', { class: 'icon', title: 'close (esc)', onclick: close }, '×'),
      hd.tabs?.length || hd.status
        ? h(
            'div',
            { class: 'drow' },
            h('nav', { class: 'dtabs', role: 'tablist' }, (hd.tabs ?? []).map((t) => h('button', { role: 'tab', 'aria-selected': String(!!t.on), onclick: t.run }, t.label))),
            hd.status ?? '',
          )
        : '',
    );
    if (moved || body.dataset.key !== v.key) {
      body.scrollTop = v.rt.scroll ?? 0;
      body.onscroll = () => (v.rt.scroll = body.scrollTop);
    }
    body.dataset.key = v.key;
    render(v, body);
    save();
    onChange();
  }

  /** Draw the shown view again (its data changed). */
  const refresh = (filter = () => true) => {
    const v = cur();
    if (v && filter(v)) draw();
  };

  /** The views shown when the page was left: `valid(view)` keeps it. */
  function restore(valid) {
    const list = store.get('drawer', []).filter(valid);
    for (const d of list) views.set(d.key, { ...d, rt: {} });
    stack = list.map((d) => d.key);
    if (stack.length) {
      history.replaceState({ atf: stack }, '');
      host.classList.add('on');
      draw(true);
    }
  }

  // resizing: the grip on its left edge
  const grip = host.querySelector('.dgrip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const right = host.getBoundingClientRect().right;
    const parent = host.parentElement.getBoundingClientRect();
    const move = (ev) => {
      const w = Math.round(Math.max(380, Math.min(parent.width - 40, right - ev.clientX)));
      document.documentElement.style.setProperty('--w-drawer', `${w}px`);
      store.set('sizes', { ...store.get('sizes', {}), 'w-drawer': `${w}px` });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', () => grip.removeEventListener('pointermove', move), { once: true });
  });

  return {
    open,
    back,
    close,
    refresh,
    restore,
    current: cur,
    isOpen: () => !!cur(),
    shows: (key) => cur()?.key === key,
    get: (key) => views.get(key),
  };
}
