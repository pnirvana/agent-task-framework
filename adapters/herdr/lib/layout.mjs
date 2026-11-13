// Pane placement for spawned agents and the board, based on herdr's pane geometry.
import { herdr } from './herdr.mjs';

// Terminal cells are roughly twice as tall as wide; compare visual size, not cell counts.
const CELL_ASPECT = 2.2;
export const MIN_COLS = 70; // a pi/claude pane narrower than this is unpleasant
export const MIN_ROWS = 14;

export function tabLayout(paneId) {
  return herdr(['pane', 'layout', '--pane', paneId])?.layout ?? null;
}

/**
 * Pick where a new agent pane goes in the tab containing `paneId`:
 * split the largest pane (excluding `exclude`, e.g. the board) along its visually
 * longer side. Returns {pane, direction} or null if no split leaves both halves usable.
 */
export function chooseSplit(paneId, { exclude = [] } = {}) {
  const layout = tabLayout(paneId);
  if (!layout) return null;
  const candidates = layout.panes
    .filter((p) => !exclude.includes(p.pane_id))
    .map((p) => {
      const { width: w, height: h } = p.rect;
      const direction = w >= h * CELL_ASPECT ? 'right' : 'down';
      const half = direction === 'right' ? { w: Math.floor(w / 2), h } : { w, h: Math.floor(h / 2) };
      return { pane: p.pane_id, direction, area: w * h, ok: half.w >= MIN_COLS && half.h >= MIN_ROWS };
    })
    .filter((c) => c.ok)
    .sort((a, b) => b.area - a.area);
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
