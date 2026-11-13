#!/usr/bin/env node
// atf-herdr — herdr adapter + plugin entrypoints for ATF.
// The ATF core knows nothing about herdr; everything herdr-specific lives here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPlan } from '../../src/core.mjs';
import { findRoot, getCurrentPlan, loadPlan, readConfig, writeConfig } from '../../src/store.mjs';
import { herdr, inHerdr, notify, pluginContext, pluginConfig } from './lib/herdr.mjs';
import { sync, notifyForEvents } from './lib/sync.mjs';
import { chooseBoardSplit, tabLayout } from './lib/layout.mjs';
import { agentKinds, launchAgent, lifecycle, lifecycleSweep, readBoards, writeBoards, stateDir } from './lib/launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(HERE, 'atf-herdr.mjs');
const PLUGIN_ID = 'atf.herdr';

const HELP = `atf-herdr — run and watch ATF agents inside herdr

  atf-herdr spawn <task> [--name NAME] [--kind pi] [--direction right|down]
                  [--target-pane ID] [--fresh|--resume] [--dry-run] [-- <agent args>]
      start an agent for a task or work package: place a pane (largest pane of the
      tab, split along its long side; an "agents" tab when full), resume the task's
      earlier session or start fresh (ATF decides; --fresh/--resume force), assign
      it and send the kickoff prompt
  atf-herdr sweep [--delay S]  one lifecycle pass: nudge idle agents that have work,
                               close idle ATF agents with nothing to do (ephemeral),
                               relaunch/resume agents when work appears for them
  atf-herdr board              open the task board (toggle) for this project
  atf-herdr tui                run the board in the current terminal
  atf-herdr sync               push labels/progress to herdr and run a sweep now
  atf-herdr enable-sync        install the ATF post-write hook for this project
  atf-herdr disable-sync       remove it

Plugin config ($(herdr plugin config-dir atf.herdr)/config.json):
  lifecycle: "ephemeral" (default) | "persistent"   agent_kind: "pi"
  agents: { "<kind>": { "start": [...], "resume": [..."{session}"...], "nativeSkill": bool } }

Plugin actions (atf.herdr.*): board, board-popup, sync, enable-sync.`;

// ---------- args ----------
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const agentArgs = sep >= 0 ? argv.slice(sep + 1) : [];
const main = sep >= 0 ? argv.slice(0, sep) : argv;
const BOOL = new Set(['dry-run', 'fresh', 'resume']);
const flags = {};
const pos = [];
for (let i = 0; i < main.length; i++) {
  const a = main[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    flags[k] = BOOL.has(k) ? true : main[++i];
  } else pos.push(a);
}

function fail(msg) {
  process.stderr.write(`atf-herdr: ${msg}\n`);
  process.exit(1);
}

/** Directory the user is "in": the focused pane's cwd when invoked as a plugin. */
function userDir() {
  const ctx = pluginContext();
  return process.env.ATF_INIT_DIR || ctx.focused_pane_cwd || ctx.workspace_cwd || process.cwd();
}

/** Resolve the .atf root: $ATF_DIR, cwd, or the cwd of the pane the plugin was invoked from. */
function resolveRoot({ optional = false } = {}) {
  const ctx = pluginContext();
  const root =
    findRoot() ||
    [ctx.focused_pane_cwd, ctx.workspace_cwd]
      .filter(Boolean)
      .map((d) => findRoot(d))
      .find(Boolean);
  if (!root && optional) return null;
  if (!root) {
    if (process.env.HERDR_PLUGIN_ID) notify('ATF: no .atf found', `in ${ctx.focused_pane_cwd || process.cwd()}; run \`atf init\` there`, 'none');
    fail('no .atf directory found (run `atf init`, or set ATF_DIR)');
  }
  return root;
}

// ---------- spawn ----------
function spawnAgent() {
  const taskArg = pos[1];
  if (!taskArg) fail('usage: atf-herdr spawn <task> [--name NAME]');
  if (!inHerdr() && !flags['dry-run']) fail('not running inside herdr (HERDR_ENV != 1)');
  const root = resolveRoot();
  const planId = flags.plan || getCurrentPlan(root);
  if (!planId) fail('no plan selected (--plan or $ATF_PLAN)');
  const s = loadPlan(root, planId);
  const t = s.tasks[taskArg];
  if (!t) fail(`unknown task ${taskArg}`);
  const eff = t.rollup_status ?? t.status;
  if (['done', 'cancelled'].includes(eff)) fail(`${t.id} is already ${eff}`);
  // A parent task is a work package: the agent owns the whole subtree and works through it.
  if (!t.children.length && t.status === 'todo' && !t.ready) fail(`${t.id} is not ready (waits on ${t.waiting_on.join(', ')})`);
  const name = (flags.name || t.assignee || `w-${t.id}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z]+/, 'w-')
    .slice(0, 32);
  const force = flags.fresh ? 'fresh' : flags.resume ? 'resume' : undefined;

  if (flags['dry-run']) {
    const lp = launchPlan(s, t.id, name);
    const kind = flags.kind || pluginConfig().agent_kind || 'pi';
    const cfg = agentKinds()[kind] || {};
    process.stdout.write(
      `${t.id} → ${name} (${kind}): ${force || lp.mode} (${lp.reason})\n` +
        `  args: ${JSON.stringify((force || lp.mode) === 'resume' ? cfg.resume : cfg.start)}${lp.session ? `  session: ${lp.session.ref}` : ''}\n` +
        `  lifecycle: ${lifecycle()}\n`,
    );
    return;
  }
  try {
    const r = launchAgent({
      root,
      planId,
      taskId: t.id,
      name,
      kind: flags.kind,
      refPane: flags['target-pane'] || process.env.HERDR_PANE_ID,
      direction: flags.direction,
      force,
      extraArgs: agentArgs,
    });
    sync(root);
    scheduleSweep(root, 20);
    process.stdout.write(`${t.id} → ${r.name} (${r.kind}, ${r.mode}) in pane ${r.pane}\n`);
  } catch (e) {
    fail(e.message);
  }
}

// ---------- board ----------
function openBoard(placement) {
  if (!inHerdr()) fail('not running inside herdr');
  const root = resolveRoot({ optional: true }); // board offers `atf init` when missing
  const dir = root ? path.dirname(root) : userDir();
  const ctx = pluginContext();
  const target = ctx.focused_pane_id || process.env.HERDR_PANE_ID;
  const ws = ctx.workspace_id || process.env.HERDR_WORKSPACE_ID || 'default';
  const boards = readBoards();

  // One board per workspace. Toggle: close it if it is in the tab you are looking at;
  // if it lives in another tab, bring it into view instead.
  const existing = placement !== 'popup' && boards[ws] && herdr(['pane', 'get', boards[ws]])?.pane;
  if (existing) {
    const here = ctx.tab_id || process.env.HERDR_TAB_ID;
    if (!here || existing.tab_id === here) {
      herdr(['plugin', 'pane', 'close', boards[ws]]) || herdr(['pane', 'close', boards[ws]]);
      delete boards[ws];
      writeBoards(boards);
    } else herdr(['plugin', 'pane', 'focus', boards[ws]]);
    return;
  }
  const entry = placement === 'popup' ? 'board-popup' : 'board';
  const args = ['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', entry, '--cwd', dir, '--env', root ? `ATF_DIR=${root}` : `ATF_INIT_DIR=${dir}`];
  if (target) args.push('--env', `ATF_HERDR_TARGET_PANE=${target}`);
  if (placement === 'popup') args.push('--placement', 'popup', '--width', '90%', '--height', '85%');
  else {
    // auto: a tall right-hand column if the tab has one, otherwise a dedicated tab
    const pref = flags.placement || pluginConfig().board_placement || 'auto';
    const split = pref === 'tab' ? null : target && chooseBoardSplit(target);
    if (split) args.push('--placement', 'split', '--target-pane', split.pane, '--direction', 'right', '--focus');
    else args.push('--placement', 'tab', ...(ws !== 'default' ? ['--workspace', ws] : []), '--focus');
  }
  const res = herdr(args);
  if (!res) fail(`could not open board (is the ${PLUGIN_ID} plugin linked? \`herdr plugin link ${HERE}\`)`);
  const paneId = res.plugin_pane?.pane?.pane_id ?? res.pane?.pane_id ?? res.pane_id;
  // a split board is a side column: ~38% of the tab width, at least 50 columns
  if (paneId && args.includes('split')) {
    const area = tabLayout(paneId)?.area;
    if (area) {
      const boardW = Math.max(50, Math.round(area.width * 0.38));
      const amount = Math.min(0.25, Math.max(0, (area.width - boardW) / area.width - 0.5));
      if (amount > 0.01) herdr(['pane', 'resize', '--pane', paneId, '--direction', 'right', '--amount', amount.toFixed(3)]);
    }
  }
  if (placement !== 'popup' && paneId) {
    boards[ws] = paneId;
    writeBoards(boards);
  }
}

async function tui() {
  const root = resolveRoot({ optional: true });
  const { runBoard } = await import('./lib/tui.mjs');
  runBoard({
    root,
    initDir: userDir(),
    popup: process.env.HERDR_PLUGIN_ENTRYPOINT_ID === 'board-popup',
    targetPane: process.env.ATF_HERDR_TARGET_PANE || null,
    spawnCmd: [process.execPath, SELF],
  });
}

// ---------- hook / sync / sweep ----------
function enableSync(on) {
  const root = resolveRoot();
  const cfg = readConfig(root);
  const hooks = (cfg.hooks ??= {});
  const list = (hooks.post_write || []).filter((h) => !(Array.isArray(h) && h.join(' ').includes('atf-herdr')));
  if (on) list.push([path.resolve(HERE, '../../bin/atf-herdr'), 'hook']); // shim: survives node upgrades
  hooks.post_write = list;
  writeConfig(root, cfg);
  if (on && inHerdr()) sync(root);
  const msg = on ? `ATF live sync enabled for ${path.dirname(root)}` : 'ATF live sync disabled';
  if (process.env.HERDR_PLUGIN_ID) notify(msg, root, 'none');
  process.stdout.write(msg + '\n');
}

/**
 * Run a sweep later, in a detached process. Agents go idle *after* their last write,
 * so the hook alone would never see them idle; a delayed sweep does. At most one
 * pending sweep per root (a newer request replaces the timestamp; the old one exits).
 */
function scheduleSweep(root, delaySec) {
  const marker = path.join(stateDir(), `sweep-${Buffer.from(root).toString('base64url').slice(-40)}`);
  const due = Date.now() + delaySec * 1000;
  try {
    const cur = Number(fs.readFileSync(marker, 'utf8'));
    if (cur > Date.now() && cur <= due) return; // an earlier sweep is already pending
  } catch {}
  fs.writeFileSync(marker, String(due));
  const child = spawn(process.execPath, [SELF, 'sweep', '--root', root, '--delay', String(delaySec), '--marker', marker, '--due', String(due)], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ATF_DIR: root },
  });
  child.on('error', () => {});
  child.unref();
}

async function sweepCmd() {
  const root = flags.root || resolveRoot();
  const delay = Number(flags.delay || 0);
  if (delay) await new Promise((r) => setTimeout(r, delay * 1000));
  if (flags.marker) {
    // superseded by a newer schedule? let that one run instead
    try {
      if (fs.readFileSync(flags.marker, 'utf8') !== flags.due) return;
      fs.rmSync(flags.marker, { force: true });
    } catch {}
  }
  const { actions, pending } = lifecycleSweep(root);
  if (actions.length) sync(root);
  if (pending) scheduleSweep(root, 15); // keep watching while ATF agents are alive or launching
  if (!flags.marker) process.stdout.write((actions.length ? actions.join('\n') : 'nothing to do') + '\n');
}

/** Invoked by the ATF post-write hook after every committed transaction. */
function hook() {
  if (!inHerdr()) return; // writer is not inside herdr: nothing to project onto
  const root = process.env.ATF_DIR;
  const plan = process.env.ATF_PLAN;
  if (!root || !plan) return;
  sync(root);
  const { actions } = lifecycleSweep(root);
  if (actions.length) sync(root);
  scheduleSweep(root, 20);
  if ((process.env.ATF_HOOK_TYPES || '').split(',').includes('task.status'))
    notifyForEvents(root, plan, Number(process.env.ATF_HOOK_FROM_SEQ), Number(process.env.ATF_HOOK_TO_SEQ));
}

// ---------- dispatch ----------
switch (pos[0]) {
  case 'spawn':
    spawnAgent();
    break;
  case 'sweep':
    await sweepCmd();
    break;
  case 'board':
  case 'action-board':
    openBoard('split');
    break;
  case 'action-board-popup':
    openBoard('popup');
    break;
  case 'tui':
    await tui();
    break;
  case 'sync':
  case 'action-sync': {
    const r = resolveRoot();
    const d = sync(r);
    const { actions } = lifecycleSweep(r);
    process.stdout.write(`synced ${d.panes.size} pane(s), ${d.workspaces.size} workspace(s)${actions.length ? '\n' + actions.join('\n') : ''}\n`);
    break;
  }
  case 'enable-sync':
  case 'action-enable-sync':
    enableSync(true);
    break;
  case 'disable-sync':
    enableSync(false);
    break;
  case 'hook':
    hook();
    break;
  default:
    process.stdout.write(HELP + '\n');
}
