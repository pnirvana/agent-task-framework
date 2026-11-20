// Thin wrapper around the herdr CLI (the herdr plugin API is its CLI).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRoot, registerRoot } from '../../../src/store.mjs';
import { readConfigFile } from '../../../src/toml.mjs';
import { pluginConfigDir } from '../../../src/config.mjs';

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

/** What a pane shows (its plain text), or '' (e.g. the screen of an agent that did not start). */
export function paneText(pane) {
  try {
    return execFileSync(herdrBin(), ['pane', 'read', pane], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
  } catch {
    return '';
  }
}

/**
 * Why an agent did not get ready in its pane, from what the pane shows: a question the
 * harness asks first (Copilot: trust this folder?), else its last lines.
 */
export function startFailure(kind, screen, cwd) {
  const lines = String(screen)
    .split('\n')
    .map((l) => l.replace(/[│┃╹▀]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (/trust/i.test(screen) && /folder|director|files/i.test(screen))
    return `${kind} asks whether to trust ${cwd}: start ${kind} there once yourself, accept, then spawn again`;
  return lines.length ? `its pane showed:\n  ${lines.slice(-4).join('\n  ')}` : '';
}

/**
 * Bring a pane to the front: its workspace, its tab, then the pane. `agent focus` alone
 * switches to the workspace but leaves it on its current tab, so an agent in another
 * workspace's second tab stayed hidden. Where the pane is now comes from herdr (panes move
 * between tabs). Resolves to true when the pane was focused.
 */
export async function focusPane(paneId) {
  if (!paneId) return false;
  const pane = (await herdrAsync(['pane', 'get', paneId]))?.pane;
  if (!pane) return false;
  if (pane.workspace_id) await herdrAsync(['workspace', 'focus', pane.workspace_id]);
  if (pane.tab_id) await herdrAsync(['tab', 'focus', pane.tab_id]);
  return !!((await herdrAsync(['agent', 'focus', paneId])) || pane.tab_id);
}

/** focusPane, synchronously (for CLI commands). */
export function focusPaneSync(paneId) {
  const pane = paneId && herdr(['pane', 'get', paneId])?.pane;
  if (!pane) return false;
  if (pane.workspace_id) herdr(['workspace', 'focus', pane.workspace_id]);
  if (pane.tab_id) herdr(['tab', 'focus', pane.tab_id]);
  return !!(herdr(['agent', 'focus', paneId]) || pane.tab_id);
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

/** Run a herdr command asynchronously; resolves to its plain-text stdout, or null on failure. */
export function herdrText(args) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(herdrBin(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out : null));
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

/** Map of herdr agents keyed by agent name, pane id, and `names:<name>` (all agents of that name). */
export async function agentIndex() {
  return indexAgents(await herdrAsync(['agent', 'list']));
}
/** agentIndex, synchronously (hooks and sweeps). */
export const agentIndexSync = () => indexAgents(herdr(['agent', 'list']));
function indexAgents(res) {
  const idx = new Map();
  for (const a of res?.agents || []) {
    if (a.name) {
      idx.set(`name:${a.name}`, a);
      idx.set(`names:${a.name}`, [...(idx.get(`names:${a.name}`) || []), a]); // names may repeat across projects
    }
    idx.set(`pane:${a.pane_id}`, a);
  }
  return idx;
}

/** Plugin user config: $HERDR_PLUGIN_CONFIG_DIR/config.toml (or config.json; all optional). */
export function pluginConfig() {
  return readConfigFile(pluginConfigDir()).data;
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
/**
 * Is this herdr agent working in the project of `root`? Agent names repeat across
 * projects (each may have a "coordinator"), so a name alone never identifies an actor:
 * its directory must be the project's (or inside it, or a parent of it).
 */
export function inProject(agent, root) {
  if (!root) return true;
  const projDir = path.dirname(root);
  const cwd = agent?.foreground_cwd || agent?.cwd;
  return !cwd || cwd === projDir || cwd.startsWith(projDir + path.sep) || projDir.startsWith(cwd + path.sep);
}

/** Live named herdr agents by name; with `root`, only those working in that project. */
export function liveAgents(root = null) {
  const m = new Map();
  for (const a of herdr(['agent', 'list'])?.agents || []) if (a.name && inProject(a, root)) m.set(a.name, a);
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

export function pluginStateDir() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR || path.join(os.homedir(), '.local/state/herdr/plugins/atf.herdr');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Board panes are plugin panes titled "ATF board" (see herdr-plugin.toml). */
export const BOARD_LABEL = 'ATF board';
export const isBoardPane = (p) => p?.label === BOARD_LABEL;
export function boardPaneIds() {
  return (herdr(['pane', 'list'])?.panes || []).filter(isBoardPane).map((p) => p.pane_id);
}

// A pane keeps its "ATF board" label when herdr restores a session, but it comes back
// as a plain shell. So a running board registers itself (pane id, server, pid), and a
// labelled pane only counts as a board while that process is alive.
const boardFile = (paneId, socket = currentSocket()) =>
  path.join(pluginStateDir(), 'boards', `${String(paneId).replace(/[^A-Za-z0-9_-]/g, '_')}-${Buffer.from(socket || 'none').toString('base64url').slice(-16)}.json`);

/** Called by the board process itself; removes the registration again on exit. */
export function registerBoardProcess() {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane || !process.env.HERDR_PLUGIN_ID) return;
  const file = boardFile(pane);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pane, pid: process.pid, socket: currentSocket(), started: Date.now() }));
    process.on('exit', () => {
      try {
        if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true });
      } catch {}
    });
  } catch {}
}

function pidIsBoard(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  try {
    // guard against pid reuse after a restart
    return /atf-herdr/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  } catch {
    return false;
  }
}

/** Is this "ATF board" pane really running a board (not a shell restored in its place)? */
export function isLiveBoard(p) {
  if (!isBoardPane(p)) return false;
  try {
    const r = JSON.parse(fs.readFileSync(boardFile(p.pane_id), 'utf8'));
    return r.pane === p.pane_id && pidIsBoard(r.pid);
  } catch {
    return false;
  }
}

/**
 * Let ctrl+h/j/k/l reach this pane while `on`. Pane-navigation plugins like
 * herdr-nvim-nav bind those keys in herdr and forward them only to panes that registered
 * as Neovim: a file named after the pane holding the owner's pid. The board registers
 * while a list wants ctrl+j/ctrl+k (the plan picker), so they still move between panes
 * otherwise. A no-op outside herdr or without such a plugin.
 */
export function claimNavKeys(on) {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) return;
  const file = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'herdr', 'nvim-panes', pane);
  try {
    if (on) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(process.pid));
      if (!claimNavKeys.hooked) {
        claimNavKeys.hooked = true;
        process.on('exit', () => claimNavKeys(false));
      }
    } else if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true });
  } catch {}
}
