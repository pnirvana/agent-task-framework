#!/usr/bin/env node
// atf-herdr — herdr adapter + plugin entrypoints for ATF.
// The ATF core knows nothing about herdr; everything herdr-specific lives here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPlan } from '../../src/core.mjs';
import { findRoot, getCurrentPlan, loadPlan, readConfig, writeConfig, skillInstalled } from '../../src/store.mjs';
import { herdr, inHerdr, notify, pluginContext, pluginConfig, discoverRoots, isBoardPane } from './lib/herdr.mjs';
import { sync, notifyForEvents } from './lib/sync.mjs';
import { chooseBoardSplit, tabLayout, planRebuild, withPlacementLock } from './lib/layout.mjs';
import { discoverAgents, resolveAgentDef, piArgsForAgent } from './lib/agents.mjs';
import { agentKinds, launchAgent, lifecycle, lifecycleSweep, stateDir } from './lib/launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(HERE, 'atf-herdr.mjs');
const PLUGIN_ID = 'atf.herdr';

const HELP = `atf-herdr — run and watch ATF agents inside herdr

  atf-herdr spawn <task> [--name NAME] [--kind pi] [--direction right|down]
                  [--agent DEF] [--early] [--target-pane ID | --workspace WS] [--fresh|--resume]
                  [--dry-run] [-- <agent args>]
      start an agent for a task or work package: place a pane (largest pane of the
      tab, split along its long side; an "agents" tab when full), resume the task's
      earlier session or start fresh (ATF decides; --fresh/--resume force), assign
      it and send the kickoff prompt
  atf-herdr sweep [--delay S]  one lifecycle pass: nudge idle agents that have work,
                               close idle ATF agents with nothing to do (ephemeral),
                               relaunch/resume agents when work appears for them
  atf-herdr board              open the task board (toggle) for this project
  atf-herdr overview           open the overview of all known projects (popup)
  atf-herdr agents             agent definitions spawn --agent can use (pi: ~/.pi/agent/agents/*.md,
                               .pi/agents/*.md, agents.json); a task's --agent picks one by default
  atf-herdr discover           register ATF projects found in any herdr pane
  atf-herdr recover            repair an interrupted board rearrangement (parked panes)
  atf-herdr tui                run the board in the current terminal
  atf-herdr sync               push labels/progress to herdr and run a sweep now
  atf-herdr enable-sync        install the ATF post-write hook for this project
  atf-herdr disable-sync       remove it

Plugin config ($(herdr plugin config-dir atf.herdr)/config.json):
  lifecycle: "ephemeral" (default) | "persistent"   agent_kind: "pi"
  agents: { "<kind>": { "start": [...], "resume": [..."{session}"...], "nativeSkill": bool } }

Plugin actions (atf.herdr.*): board (this project; overview if none here),
board-popup (overview of all projects), sync, enable-sync.`;

// ---------- args ----------
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const agentArgs = sep >= 0 ? argv.slice(sep + 1) : [];
const main = sep >= 0 ? argv.slice(0, sep) : argv;
const BOOL = new Set(['dry-run', 'fresh', 'resume', 'early']);
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
  if (!t.children.length && t.status === 'todo' && !t.ready && !flags.early)
    fail(`${t.id} is not ready (waits on ${t.waiting_on.join(', ')}); --early starts it anyway for work that does not need them yet`);
  const agentName = flags.agent || t.agent || [...t.path].reverse().map((id) => s.tasks[id].agent).find(Boolean) || null;
  const name = (flags.name || t.assignee || (agentName ? `${agentName}-${t.id}` : `w-${t.id}`))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z]+/, 'w-')
    .slice(0, 32);
  const force = flags.fresh ? 'fresh' : flags.resume ? 'resume' : undefined;

  if (flags['dry-run']) {
    const lp = launchPlan(s, t.id, name);
    const kind = flags.kind || pluginConfig().agent_kind || 'pi';
    const cfg = agentKinds()[kind] || {};
    const raw = ((force || lp.mode) === 'resume' ? cfg.resume : cfg.start) || [];
    let used = skillInstalled() ? raw.filter((a, i) => a !== '{skill}' && raw[i + 1] !== '{skill}') : raw;
    if (agentName) {
      const def = resolveAgentDef(agentName, path.dirname(root));
      if (!def) fail(`unknown agent definition "${agentName}" (see \`atf-herdr agents\`)`);
      const r = piArgsForAgent(def, stateDir());
      used = [...used, ...r.args];
      for (const n of r.notes) process.stdout.write(`  note: ${n}\n`);
      process.stdout.write(`  agent: ${agentName} (${def.source})\n`);
    }
    process.stdout.write(
      `${t.id} → ${name} (${kind}): ${force || lp.mode} (${lp.reason})\n` +
        `  args: ${JSON.stringify(used)}${skillInstalled() ? '  (skill installed: discovered by the agent)' : ''}${lp.session ? `  session: ${lp.session.ref}` : ''}\n` +
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
      agent: agentName,
      early: !!flags.early,
      refPane: flags['target-pane'] || workspacePane(flags.workspace) || process.env.HERDR_PANE_ID,
      direction: flags.direction,
      force,
      extraArgs: agentArgs,
    });
    sync(root);
    scheduleSweep(root, 20);
    process.stdout.write(`${t.id} → ${r.name} (${r.kind}${r.agent ? `, agent ${r.agent}` : ''}, ${r.mode}) in pane ${r.pane}\n`);
  } catch (e) {
    fail(e.message);
  }
}

/** A pane to place new agents next to in workspace `ws` (its focused pane, else any). */
function workspacePane(ws) {
  if (!ws) return null;
  const panes = herdr(['pane', 'list', '--workspace', ws])?.panes || [];
  if (!panes.length) fail(`no panes in workspace ${ws}`);
  return (panes.find((p) => p.focused) || panes[0]).pane_id;
}

// ---------- board ----------
function openBoard(placement, { start } = {}) {
  if (!inHerdr()) fail('not running inside herdr');
  // presses are handled one at a time, so a fast double press can't open two boards
  const err = withBoardLock(() => toggleBoard(placement, start));
  if (err) fail(err);
}

/**
 * The board panes that exist right now come from herdr itself (plugin panes titled
 * "ATF board"), not from a state file, so the toggle can't lose track of a board.
 * Rules (one board per workspace):
 *  - board(s) in the tab you are looking at       -> close them
 *  - a board that is its own tab                  -> switch to that tab
 *  - a board as side panel in another tab         -> close it, open one here
 */
function toggleBoard(placement, start) {
  const root = resolveRoot({ optional: true }); // board offers `atf init` when missing
  const dir = root ? path.dirname(root) : userDir();
  const ctx = pluginContext();
  const target = ctx.focused_pane_id || process.env.HERDR_PANE_ID;
  const ws = ctx.workspace_id || process.env.HERDR_WORKSPACE_ID || null;
  const here = ctx.tab_id || process.env.HERDR_TAB_ID || null;
  if (placement !== 'popup') {
    const panes = herdr(['pane', 'list', ...(ws ? ['--workspace', ws] : [])])?.panes || [];
    const boards = panes.filter(isBoardPane);
    const close = (p) => herdr(['plugin', 'pane', 'close', p.pane_id]) || herdr(['pane', 'close', p.pane_id]);
    const inTab = boards.filter((p) => p.tab_id === here);
    if (inTab.length) {
      inTab.forEach(close);
      return null;
    }
    for (const b of boards) {
      const ownTab = panes.filter((p) => p.tab_id === b.tab_id).length === 1;
      if (ownTab && herdr(['tab', 'focus', b.tab_id])) {
        herdr(['plugin', 'pane', 'focus', b.pane_id]);
        boards.filter((o) => o !== b).forEach(close); // never more than one per workspace
        return null;
      }
    }
    boards.forEach(close); // side panels elsewhere: replaced by a board here
  }
  let boardSplit = null;
  const entry = placement === 'popup' ? 'board-popup' : 'board';
  const args = ['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', entry, '--cwd', dir, '--env', root ? `ATF_DIR=${root}` : `ATF_INIT_DIR=${dir}`];
  if (target) args.push('--env', `ATF_HERDR_TARGET_PANE=${target}`);
  if (start) args.push('--env', `ATF_BOARD_START=${start}`);
  if (placement === 'popup') args.push('--placement', 'popup', '--width', '90%', '--height', '85%');
  else {
    // auto: a full-height right-hand column (the tab is rearranged around it, see
    // openFullHeight); "beside": next to the tallest pane only; "tab": its own tab
    const pref = flags.placement || pluginConfig().board_placement || 'auto';
    const layout = target && tabLayout(target);
    if (pref === 'auto' && layout && layout.area.width >= 110) {
      const err = withPlacementLock(() => openFullHeight(args, layout));
      if (!err) return null;
      process.stderr.write(`atf-herdr: full-height board failed (${err}); placing it beside a pane\n`);
    }
    const split = pref === 'tab' ? null : target && chooseBoardSplit(target);
    boardSplit = split;
    if (split) args.push('--placement', 'split', '--target-pane', split.pane, '--direction', 'right', '--focus');
    else args.push('--placement', 'tab', ...(ws ? ['--workspace', ws] : []), '--focus');
  }
  const res = herdr(args);
  if (!res) return `could not open board (is the ${PLUGIN_ID} plugin linked? \`herdr plugin link ${HERE}\`)`;
  const paneId = res.plugin_pane?.pane?.pane_id ?? res.pane?.pane_id ?? res.pane_id;
  // a split board is a side column: ~38% of the pane it was split from, at least 50 columns
  if (paneId && boardSplit) {
    const W = boardSplit.width;
    const boardW = Math.max(50, Math.round(W * 0.38));
    const amount = Math.min(0.25, Math.max(0, (W - boardW) / W - 0.5));
    if (amount > 0.01) herdr(['pane', 'resize', '--pane', paneId, '--direction', 'right', '--amount', amount.toFixed(3)]);
  }
  return null;
}

// ---------- full-height board: rearrange the tab around it ----------
// herdr can only split panes, not the tab. To get a column spanning the whole tab:
// park every pane but one (the anchor) in a temporary tab, split the lone anchor
// (now a full-height split), then move the parked panes back, replaying the original
// split tree next to the anchor. Agents keep running; pane ids stay the same within a
// workspace. A checkpoint lets `atf-herdr recover` repair an interrupted rearrangement.
const checkpointFile = () => path.join(stateDir(), 'rebuild.json');

function hx(args) {
  const r = herdr(args, { timeout: 15_000 });
  if (!r) throw new Error(`herdr ${args.slice(0, 2).join(' ')} failed`);
  return r;
}

function openFullHeight(openArgs, layout) {
  try {
    recoverRebuild(); // finish any interrupted earlier rearrangement first
    const panes = layout.panes;
    const plan = panes.length > 1 ? planRebuild(panes) : { anchor: panes[0].pane_id, steps: [] };
    const cp = { tab: layout.tab_id, workspace: layout.workspace_id, anchor: plan.anchor, steps: plan.steps, parked: [], parkTab: null, placeholder: null };
    if (plan.steps.length) {
      const park = hx(['tab', 'create', '--workspace', layout.workspace_id, '--label', 'atf-parking', '--no-focus']);
      cp.parkTab = park.tab.tab_id;
      cp.placeholder = park.root_pane.pane_id;
      fs.writeFileSync(checkpointFile(), JSON.stringify(cp));
      for (const p of panes) {
        if (p.pane_id === plan.anchor) continue;
        hx(['pane', 'move', p.pane_id, '--tab', cp.parkTab, '--split', 'right', '--no-focus']);
        cp.parked.push(p.pane_id);
        fs.writeFileSync(checkpointFile(), JSON.stringify(cp));
      }
    }
    // the anchor is alone now: splitting it gives a full-height column
    const res = hx([...openArgs, '--placement', 'split', '--target-pane', plan.anchor, '--direction', 'right', '--focus']);
    const board = res.plugin_pane?.pane?.pane_id ?? res.pane?.pane_id;
    const W = layout.area.width;
    const boardW = Math.max(50, Math.round(W * 0.38));
    const amount = Math.min(0.25, Math.max(0, (W - boardW) / W - 0.5));
    if (board && amount > 0.01) herdr(['pane', 'resize', '--pane', board, '--direction', 'right', '--amount', amount.toFixed(3)]);
    replay(cp);
    return null;
  } catch (e) {
    try {
      recoverRebuild();
    } catch {}
    return e.message;
  }
}

/** Move parked panes back in plan order; drop the parking tab; clear the checkpoint. */
function replay(cp) {
  for (const st of cp.steps) {
    hx(['pane', 'move', st.pane, '--tab', cp.tab, '--split', st.dir, '--target-pane', st.target, '--ratio', String(st.ratio), '--no-focus']);
    cp.parked = cp.parked.filter((id) => id !== st.pane);
    fs.writeFileSync(checkpointFile(), JSON.stringify(cp));
  }
  if (cp.placeholder) herdr(['pane', 'close', cp.placeholder]);
  fs.rmSync(checkpointFile(), { force: true });
}

/** Repair an interrupted rearrangement: bring every parked pane home. */
function recoverRebuild() {
  let cp;
  try {
    cp = JSON.parse(fs.readFileSync(checkpointFile(), 'utf8'));
  } catch {
    return false;
  }
  const exists = (id) => !!herdr(['pane', 'get', id])?.pane;
  const stillParked = (id) => herdr(['pane', 'get', id])?.pane?.tab_id === cp.parkTab;
  // replay what we can in order; anything else is put back next to the anchor
  for (const st of cp.steps) {
    if (!stillParked(st.pane)) continue;
    const target = exists(st.target) && herdr(['pane', 'get', st.target]).pane.tab_id === cp.tab ? st.target : cp.anchor;
    herdr(['pane', 'move', st.pane, '--tab', cp.tab, '--split', st.dir, '--target-pane', target, '--ratio', String(st.ratio), '--no-focus']) ||
      herdr(['pane', 'move', st.pane, '--tab', cp.tab, '--split', 'right', '--no-focus']);
  }
  if (cp.placeholder && exists(cp.placeholder)) herdr(['pane', 'close', cp.placeholder]);
  fs.rmSync(checkpointFile(), { force: true });
  return true;
}

function withBoardLock(fn) {
  const lock = path.join(stateDir(), 'board.lock');
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15_000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() - t0 > 10_000) return 'another board toggle is still running';
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
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
  case 'overview':
    discoverRoots();
    openBoard('popup', { start: 'overview-all' }); // quick look: everything that needs you
    break;
  case 'agents': {
    // agent definitions spawn can use: atf-herdr spawn <task> --agent NAME
    const cwd = flags.root ? path.dirname(flags.root) : resolveRoot({ optional: true }) ? path.dirname(resolveRoot({ optional: true })) : process.cwd();
    const defs = [...discoverAgents(cwd).values()];
    if (flags.json !== undefined || process.argv.includes('--json')) process.stdout.write(JSON.stringify(defs.map(({ systemPrompt, ...d }) => d), null, 2) + '\n');
    else
      process.stdout.write(
        (defs.length
          ? defs.map((d) => `${d.name.padEnd(16)} ${d.description}\n${' '.repeat(17)}${[d.model && `model ${d.model}`, d.tools?.length && `tools ${d.tools.join(',')}`, d.source].filter(Boolean).join(' · ')}`).join('\n')
          : 'no agent definitions found (~/.pi/agent/agents/*.md, .pi/agents/*.md, agents.json)') + '\n',
      );
    break;
  }
  case 'recover':
    process.stdout.write(recoverRebuild() ? 'recovered an interrupted board rearrangement\n' : 'nothing to recover\n');
    break;
  case 'discover':
    process.stdout.write(discoverRoots().join('\n') + '\n');
    break;
  case 'tui':
    await tui();
    break;
  case 'sync':
  case 'action-sync': {
    const r = flags.root || resolveRoot();
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
