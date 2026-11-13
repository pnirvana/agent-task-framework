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
 * Where the board fits: a right-hand column at least ~45 cols wide and most of the tab's
 * height. Returns {pane, direction:'right'} or null (caller then opens it as its own tab).
 */
export function chooseBoardSplit(paneId) {
  const layout = tabLayout(paneId);
  if (!layout) return null;
  const H = layout.area.height;
  const best = layout.panes
    .filter((p) => p.rect.height >= H * 0.75 && p.rect.width >= 110)
    .sort((a, b) => b.rect.x + b.rect.width - (a.rect.x + a.rect.width) || b.rect.width - a.rect.width)[0];
  return best ? { pane: best.pane_id, direction: 'right' } : null;
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
