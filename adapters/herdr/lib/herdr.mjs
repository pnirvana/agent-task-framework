// Thin wrapper around the herdr CLI (the herdr plugin API is its CLI).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRoot, registerRoot } from '../../../src/store.mjs';

export function herdrBin() {
  if (process.env.HERDR_BIN_PATH) return process.env.HERDR_BIN_PATH;
  const local = path.join(os.homedir(), '.local/bin/herdr');
  return fs.existsSync(local) ? local : 'herdr';
}

/** Run a herdr command synchronously; returns parsed `.result` or null on any failure. */
export function herdr(args, { timeout = 10_000 } = {}) {
  try {
    const out = execFileSync(herdrBin(), args, { stdio: ['ignore', 'pipe', 'ignore'], timeout }).toString();
    const json = JSON.parse(out);
    return json.result ?? json;
  } catch {
    return null;
  }
}

/** Run a herdr command asynchronously; resolves to parsed `.result` or null. */
export function herdrAsync(args) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(herdrBin(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        resolve(j.result ?? j);
      } catch {
        resolve(null);
      }
    });
  });
}

export const inHerdr = () => process.env.HERDR_ENV === '1';

export function pluginContext() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
  } catch {
    return {};
  }
}

export function notify(title, body, sound = 'request') {
  const args = ['notification', 'show', title.slice(0, 80)];
  if (body) args.push('--body', body.slice(0, 200));
  args.push('--sound', sound);
  herdr(args);
}

/** Map of herdr agents keyed by both agent name and pane id. */
export async function agentIndex() {
  const res = await herdrAsync(['agent', 'list']);
  const idx = new Map();
  for (const a of res?.agents || []) {
    if (a.name) idx.set(`name:${a.name}`, a);
    idx.set(`pane:${a.pane_id}`, a);
  }
  return idx;
}

/** Plugin user config: $HERDR_PLUGIN_CONFIG_DIR/config.json (all optional). */
export function pluginConfig() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(os.homedir(), '.config/herdr/plugins/config/atf.herdr');
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * herdr ids (panes, agent names) are only unique within one herdr server/session.
 * Events record the writer's socket as ctx.herdr_socket; only actors from *this*
 * server may be controlled. Actors without the field (older events) count as local.
 */
export const currentSocket = () => process.env.HERDR_SOCKET_PATH || null;
export function sameServer(actor) {
  const s = actor?.ctx?.herdr_socket;
  return !s || !currentSocket() || s === currentSocket();
}

/** Live agents of this server, by name. */
export function liveAgents() {
  const m = new Map();
  for (const a of herdr(['agent', 'list'])?.agents || []) if (a.name) m.set(a.name, a);
  return m;
}

/** Register every ATF project found in the working directory of any pane of this server. */
export function discoverRoots() {
  const found = new Set();
  for (const p of herdr(['pane', 'list'])?.panes || []) {
    for (const dir of new Set([p.foreground_cwd, p.cwd].filter(Boolean))) {
      const r = findRoot(dir);
      if (r) found.add(r);
    }
  }
  for (const r of found) registerRoot(r);
  return [...found];
}

/** Board panes are plugin panes titled "ATF board" (see herdr-plugin.toml). */
export const BOARD_LABEL = 'ATF board';
export const isBoardPane = (p) => p?.label === BOARD_LABEL;
export function boardPaneIds() {
  return (herdr(['pane', 'list'])?.panes || []).filter(isBoardPane).map((p) => p.pane_id);
}
