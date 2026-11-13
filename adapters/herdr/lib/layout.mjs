// Pane placement for spawned agents and the board, based on herdr's pane geometry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { herdr } from './herdr.mjs';

// Terminal cells are roughly twice as tall as wide; compare visual size, not cell counts.
const CELL_ASPECT = 2.2;
export const MIN_COLS = 60; // a pi/claude pane narrower than this is unpleasant
export const MIN_ROWS = 12;

export function tabLayout(paneId) {
  return herdr(['pane', 'layout', '--pane', paneId])?.layout ?? null;
}

/**
 * Pick where a new agent pane goes in the tab containing `paneId`:
 * split the largest pane (excluding `exclude`, e.g. the board), preferring its visually
 * longer side. Returns {pane, direction} or null if no split leaves both halves usable.
 */
export function chooseSplit(paneId, { exclude = [] } = {}) {
  const layout = tabLayout(paneId);
  if (!layout) return null;
  // For each pane try the visually longer axis first, then the other one; keep the
  // biggest pane that can be halved with both halves still usable.
  const candidates = [];
  for (const p of layout.panes.filter((p) => !exclude.includes(p.pane_id))) {
    const { width: w, height: h } = p.rect;
    const order = w >= h * CELL_ASPECT ? ['right', 'down'] : ['down', 'right'];
    const direction = order.find((d) => (d === 'right' ? Math.floor(w / 2) >= MIN_COLS && h >= MIN_ROWS : w >= MIN_COLS && Math.floor(h / 2) >= MIN_ROWS));
    if (direction) candidates.push({ pane: p.pane_id, direction, area: w * h });
  }
  candidates.sort((a, b) => b.area - a.area);
  return candidates[0] ?? null;
}

/**
 * Where the board goes: a column to the right of the tallest pane that has room for it
 * (>= 110 cols so both sides stay usable, >= 15 rows), preferring the rightmost one.
 * herdr can only split panes, not the whole tab, so with stacked panes the board sits
 * beside one of them. Returns {pane, direction:'right', width} or null (-> own tab).
 */
export function chooseBoardSplit(paneId) {
  const layout = tabLayout(paneId);
  if (!layout) return null;
  const best = layout.panes
    .filter((p) => p.rect.width >= 110 && p.rect.height >= 15)
    .sort((a, b) => b.rect.height - a.rect.height || b.rect.x + b.rect.width - (a.rect.x + a.rect.width))[0];
  return best ? { pane: best.pane_id, direction: 'right', width: best.rect.width } : null;
}

/** Serialize pane placement across processes (parallel spawns must see each other's panes). */
export function withPlacementLock(fn, timeoutMs = 20_000) {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR || path.join(os.homedir(), '.local/state/herdr/plugins/atf.herdr');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'placement.lock');
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() - start > timeoutMs) break; // give up waiting; place anyway
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Recover how a tab's layout was built, from pane rectangles alone. herdr layouts are
 * binary split trees, so the rectangles can always be cut cleanly in two (vertically
 * or horizontally) and each half again. Returns {anchor, steps}: starting from
 * `anchor` alone, replaying `steps` in order (each "move `pane` next to `target`,
 * split `dir`, target keeps `ratio`") recreates the layout. Pure; throws if the
 * rectangles are not a clean split tree.
 */
export function planRebuild(panes) {
  const R = panes.map((p) => ({ id: p.pane_id, x: p.rect.x, y: p.rect.y, w: p.rect.width, h: p.rect.height }));
  const build = (rs) => {
    if (rs.length === 1) return { anchor: rs[0].id, steps: [] };
    for (const [dir, s, e] of [
      ['right', (r) => r.x, (r) => r.x + r.w],
      ['down', (r) => r.y, (r) => r.y + r.h],
    ]) {
      const lo = Math.min(...rs.map(s));
      const hi = Math.max(...rs.map(e));
      const cuts = [...new Set(rs.map(e))].filter((c) => c > lo && c < hi).sort((a, b) => a - b);
      for (const cut of cuts) {
        const before = rs.filter((r) => e(r) <= cut);
        const after = rs.filter((r) => s(r) >= cut);
        if (!before.length || before.length + after.length !== rs.length) continue;
        const A = build(before);
        const B = build(after);
        const ratio = Math.round(((cut - lo) / (hi - lo)) * 1000) / 1000;
        return { anchor: A.anchor, steps: [{ pane: B.anchor, dir, target: A.anchor, ratio }, ...A.steps, ...B.steps] };
      }
    }
    throw new Error('layout is not a clean split tree');
  };
  return build(R);
}
