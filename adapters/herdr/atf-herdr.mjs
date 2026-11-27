#!/usr/bin/env node
// atf-herdr — herdr adapter + plugin entrypoints for ATF.
// The ATF core knows nothing about herdr; everything herdr-specific lives here.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPlan } from '../../src/core.mjs';
import { findRoot, getCurrentPlan, loadPlan, readConfig, writeConfig, skillInstalled, readEvents, initRoot } from '../../src/store.mjs';
import { herdr, inHerdr, notify, pluginContext, pluginConfig, discoverRoots, isBoardPane, isLiveBoard, focusPaneSync } from './lib/herdr.mjs';
import { sync } from './lib/sync.mjs';
import { notifyTick, notifyConfig, clientTtys, SEQ } from './lib/notify.mjs';
import { chooseBoardSplit, tabLayout, planRebuild, withPlacementLock } from './lib/layout.mjs';
import { discoverAgents, resolveAgentDef, piArgsForAgent } from './lib/agents.mjs';
import { agentKinds, agentPlacement, launchAgent, launchCoordinator, lifecycle, lifecycleSweep, stateDir, recordSessionsForEvents, linkNewPlan, launchNewCoordinator, newCoordinatorEnv } from './lib/launch.mjs';
import { restore, restoreOnStartup, restoreSummary } from './lib/restore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(HERE, 'atf-herdr.mjs');
const PLUGIN_ID = 'atf.herdr';

const HELP = `atf-herdr — run and watch ATF agents inside herdr

  atf-herdr spawn <task> [--name NAME] [--kind pi] [--placement tab|split] [--direction right|down]
                  [--agent DEF] [--early] [--target-pane ID | --workspace WS] [--fresh|--resume]
                  [--dry-run] [-- <agent args>]
      (the coordinator's tool) start an agent for a task or work package: place a pane
      (default: in the workspace's "agents" tab, so your tab keeps its layout; --placement
      split or "agent_placement": "split": beside the coordinator, an "agents" tab when full),
      assign it and send the kickoff prompt. A new agent starts fresh with the task,
      its checkpoint and the coordinator's instructions; --resume resumes the session
      that worked on the task before. Refused while an agent of that name still runs.
  atf-herdr coordinate [--plan ID] [--fresh] [--kind pi] [--reuse-pane] [--dry-run]
      start the plan's coordinator in its own tab: resumes the plan's coordinator
      session (if any), or --fresh starts a new one. A coordinator that is still
      running is left alone, or with --fresh first asked for a plan checkpoint
      (atf plan checkpoint) and then replaced. --reuse-pane: when the shell it last
      ran in is still open (you quit the agent), close it and start there.
  atf-herdr new <name> [--dir PATH] [--agent DEF] [--kind pi] [--prompt TEXT]
      a new plan in its own folder (<plans_dir>/<name>, an ATF project) and workspace:
      a coordinator (agent definition --agent, else new_plan_agent) that starts the
      design discussion with you and creates the plan, and the board beside it
  atf-herdr restore [--dry-run]
      after herdr (or the machine) went down: restart each coordinator that was running,
      in the spot of the pane herdr restored, resuming its session and told what to
      reassess; close stale subagent panes; reopen boards. Runs by itself when herdr
      starts (the plugin's startup hook; restore = "off" turns that off)
  atf-herdr sweep [--delay S]  one lifecycle pass: close agents ATF started once they
                               finished (idle, nothing in progress), nudge an idle
                               coordinator that has something to handle (incl. stalled
                               agents), report plans without a coordinator
  atf-herdr board              open the task board (toggle) for this project
  atf-herdr overview           open the overview of all known projects (popup)
  atf-herdr agents             agent definitions spawn --agent can use (pi: ~/.pi/agent/agents/*.md,
                               .pi/agents/*.md, agents.json); a task's --agent picks one by default
  atf-herdr discover           register ATF projects found in any herdr pane
  atf-herdr recover            repair an interrupted board rearrangement (parked panes)
  atf-herdr tui                run the board in the current terminal (also outside herdr,
                               e.g. beside atf-copilot; without agent state, g, s/S)
  atf-herdr sync               push labels/progress to herdr and run a sweep now
  atf-herdr notify [--test]    notifications when you are needed: the channels, the
                               terminals herdr clients run in, what waits for you now;
                               --test sends a test notification through every channel
  atf-herdr enable-sync        install the ATF post-write hook for this project
  atf-herdr disable-sync       remove it

Plugin config ($(herdr plugin config-dir atf.herdr)/config.toml; atf config shows it):
  lifecycle = "ephemeral" (default) | "persistent"
  agent_kind = "pi" (default) | "copilot" | "opencode" | "claude" | "codex"   (also --kind on spawn/coordinate)
  agent_placement = "tab" (default: agents in their own tab) | "split" (beside the coordinator)
  plans_dir = "~/plans"            where atf-herdr new creates plan folders
  new_plan_agent = "<definition>"  the coordinator of a new plan (atf-herdr agents lists them)
  new_plan_prompt = "…"            its first message (default: none, you start)
  restore = "auto" (default) | "off"  restore ATF when herdr starts
  [agents.<kind>]  start = [...], resume = [..."{session}"...], nativeSkill = true|false

Notifications (~/.config/atf/config.toml, per user):
  [notify]  herdr = true, terminal = ["toast", "bell", "progress"], command = "…", settle_seconds = 5
  terminal: written to the terminal the herdr client runs in (works over SSH): toast =
  OSC 777 (Windows Terminal 1.26+ with compatibility.allowOSC777), bell = BEL (taskbar
  flash), progress = OSC 9;4 (a yellow tab/taskbar mark while something waits for you).
  command: run with $ATF_NOTIFY_TITLE, $ATF_NOTIFY_BODY, $ATF_NOTIFY_COUNT.

Plugin actions (atf.herdr.*): board (this project; overview if none here),
board-popup (overview of all projects), sync, enable-sync.`;

// ---------- args ----------
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const agentArgs = sep >= 0 ? argv.slice(sep + 1) : [];
const main = sep >= 0 ? argv.slice(0, sep) : argv;
const BOOL = new Set(['help', 'dry-run', 'fresh', 'resume', 'early', 'test']);

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
  if (flags.help || flags.h) {
    const lines = HELP.split('\n');
    const i = lines.findIndex((l) => l.includes('atf-herdr spawn'));
    const j = lines.findIndex((l, k) => k > i && /^  atf-herdr /.test(l));
    process.stdout.write(lines.slice(i, j).join('\n') + '\n');
    process.exit(0);
  }
  if (!taskArg) fail('usage: atf-herdr spawn <task> [--name NAME] [--agent DEF] [--early] (atf-herdr --help)');
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
    let placement;
    try {
      placement = flags.direction ? `split (--direction ${flags.direction})` : agentPlacement(flags.placement || (flags['target-pane'] ? 'split' : undefined));
    } catch (e) {
      fail(e.message);
    }
    const lp = launchPlan(s, t.id, name);
    const kind = flags.kind || pluginConfig().agent_kind || 'pi';
    const cfg = agentKinds()[kind] || {};
    const raw = ((force || lp.mode) === 'resume' ? cfg.resume : cfg.start) || [];
    let used = [...(skillInstalled() ? raw.filter((a, i) => a !== '{skill}' && raw[i + 1] !== '{skill}') : raw), ...(cfg.agent || [])];
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
        (cfg.env ? `  env: ${Object.keys(cfg.env).join(', ')} (opencode: the ATF plugin, live view)\n` : '') +
        `  lifecycle: ${lifecycle()}\n` +
        `  placement: ${placement}\n`,
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
      // an explicit target pane means: place it there
      placement: flags.placement || (flags['target-pane'] ? 'split' : undefined),
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

// ---------- coordinator ----------
function coordinateCmd() {
  if (flags.help) {
    const lines = HELP.split('\n');
    const i = lines.findIndex((l) => l.includes('atf-herdr coordinate'));
    const j = lines.findIndex((l, k) => k > i && /^  atf-herdr /.test(l));
    process.stdout.write(lines.slice(i, j).join('\n') + '\n');
    process.exit(0);
  }
  if (!inHerdr() && !flags['dry-run']) fail('not running inside herdr (HERDR_ENV != 1)');
  const root = flags.root || resolveRoot();
  const planId = flags.plan || pos[1] || getCurrentPlan(root);
  if (!planId) fail('no plan selected (--plan or $ATF_PLAN)');
  try {
    const say = (m) => process.stdout.write(m + '\n');
    const r = launchCoordinator({ root, planId, fresh: !!flags.fresh, kind: flags.kind, dryRun: !!flags['dry-run'], say, handoffMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined, reusePane: !!flags['reuse-pane'] });
    if (r.mode === 'running') {
      if (!flags['dry-run']) focusPaneSync(r.pane);
      return say(`coordinator ${r.name} is already running in pane ${r.pane} (--fresh replaces it with a new session)`);
    }
    if (flags['dry-run']) return say(`coordinator ${r.name}: would start ${r.mode}${r.session ? ` (session ${r.session})` : ''}${r.pane ? `, replacing the one in pane ${r.pane}` : ''}`);
    sync(root);
    // a new workspace for the plan: the board goes beside its coordinator, as with `new`
    if (r.created) {
      const err = withBoardLock(() => toggleBoard('split', undefined, { root, target: r.pane, workspace: r.created.workspace, tab: r.created.tab }));
      if (err) process.stderr.write(`atf-herdr: ${err}\n`);
      herdr(['agent', 'focus', r.pane]);
    }
    say(`coordinator ${r.name} started (${r.mode === 'resume' ? 'resumed its session' : 'new session'}) in pane ${r.pane}${r.created ? `, in a new workspace "${path.basename(path.dirname(root))}"` : ''}`);
    if (r.leftover) say(`its old shell (pane ${r.leftover}) is still open; --reuse-pane closes it and starts the coordinator there`);
  } catch (e) {
    fail(e.message);
  }
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
function toggleBoard(placement, start, at = null) {
  // `at`: a board for that project beside that pane (a restore, a new plan), not where you are
  const root = at ? at.root : resolveRoot({ optional: true }); // board offers `atf init` when missing
  const ctx = pluginContext();
  const dir = root ? path.dirname(root) : at ? (herdr(['pane', 'get', at.target])?.pane?.cwd ?? userDir()) : userDir();
  const target = at ? at.target : ctx.focused_pane_id || process.env.HERDR_PANE_ID;
  const ws = at ? at.workspace : ctx.workspace_id || process.env.HERDR_WORKSPACE_ID || null;
  const here = at ? at.tab : ctx.tab_id || process.env.HERDR_TAB_ID || null;
  if (placement !== 'popup') {
    const panes = herdr(['pane', 'list', ...(ws ? ['--workspace', ws] : [])])?.panes || [];
    const close = (p) => herdr(['plugin', 'pane', 'close', p.pane_id]) || herdr(['pane', 'close', p.pane_id]);
    // "ATF board" panes without a running board (a shell herdr restored in its place):
    // leftovers, closed unless something else (an agent) runs in them now
    const labelled = panes.filter(isBoardPane);
    const boards = labelled.filter(isLiveBoard);
    labelled.filter((p) => !boards.includes(p) && !p.agent).forEach(close);
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
  start ??= pluginConfig().board_start; // "plan": open the project's plan instead of the Overview
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
function enableSync(on, root = resolveRoot()) {
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
const SOON_S = 3; // follow-up sweep while an agent finishes its turn or another sweep holds the lock
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
  const { actions, pending, soon } = lifecycleSweep(root);
  if (actions.length) sync(root);
  const n = notifyTick({ extraRoots: [root] });
  // keep watching while ATF agents are alive or launching; closely while one is about to need us
  // (or something that needs the human is about to be notified)
  if (soon || n.pending) scheduleSweep(root, soon ? SOON_S : Math.max(1, Math.ceil(notifyConfig().settleMs / 1000)));
  else if (pending || n.watch) scheduleSweep(root, 15);
  if (!flags.marker) process.stdout.write((actions.length ? actions.join('\n') : 'nothing to do') + '\n');
}

/** atf-herdr notify [--test]: the notification setup, and what waits for the human now. */
function notifyCmd() {
  const cfg = notifyConfig();
  const ttys = clientTtys();
  const root = resolveRoot({ optional: true });
  if (flags.test) {
    const title = 'ATF · test';
    const body = 'notifications reach you here';
    if (cfg.herdr) notify(title, body, 'request');
    for (const t of ttys) {
      try {
        fs.writeFileSync(t, (cfg.terminal.includes('toast') ? SEQ.toast(title, body) : '') + (cfg.terminal.includes('bell') ? SEQ.bell() : '') + (cfg.terminal.includes('progress') ? SEQ.progress(true) : ''));
      } catch {}
    }
    if (cfg.terminal.includes('progress')) setTimeout(() => ttys.forEach((t) => fs.writeFileSync(t, SEQ.progress(false))), 5000);
    if (cfg.command) spawnSync('sh', ['-c', cfg.command], { stdio: 'inherit', env: { ...process.env, ATF_NOTIFY_TITLE: title, ATF_NOTIFY_BODY: body, ATF_NOTIFY_COUNT: '0' } });
  }
  const n = notifyTick({ extraRoots: root ? [root] : [] });
  const L = [
    `herdr:     ${cfg.herdr ? 'on (how it shows: [ui.toast] delivery in herdr\'s config.toml)' : 'off'}`,
    `terminal:  ${cfg.terminal.length ? cfg.terminal.join(', ') : 'off'}${cfg.terminal.length ? `  → ${ttys.length ? ttys.join(', ') : 'no herdr client terminal found'}` : ''}`,
    `command:   ${cfg.command || 'none'}`,
    '',
    n.busy ? 'another check is running; try again' : n.items.length ? `waiting for you (${n.items.length}):\n${n.items.map((i) => `  ${i.project} · ${i.text}`).join('\n')}` : 'nothing waits for you',
  ];
  if (flags.test) L.unshift(`test sent${cfg.terminal.includes('progress') ? ' (the progress mark clears in 5 s)' : ''}`, '');
  process.stdout.write(L.join('\n') + '\n');
}

/** Invoked by the ATF post-write hook after every committed transaction. */
function hook() {
  if (!inHerdr()) return; // writer is not inside herdr: nothing to project onto
  const root = process.env.ATF_DIR;
  const plan = process.env.ATF_PLAN;
  if (!root || !plan) return;
  sync(root);
  const { actions, soon } = lifecycleSweep(root);
  if (actions.length) sync(root);
  const types = (process.env.ATF_HOOK_TYPES || '').split(',');
  const written = () => readEvents(root, plan).filter((e) => e.seq >= Number(process.env.ATF_HOOK_FROM_SEQ) && e.seq <= Number(process.env.ATF_HOOK_TO_SEQ));
  if (types.includes('plan.created')) linkNewPlan(root, plan, written()); // a coordinator from `atf-herdr new`
  if (types.includes('task.status')) recordSessionsForEvents(root, plan, written());
  // what now needs the human: notified once (SPEC §12.5, lib/notify.mjs)
  const n = notifyTick({ extraRoots: [root] });
  scheduleSweep(root, soon ? SOON_S : n.pending ? Math.max(1, Math.ceil(notifyConfig().settleMs / 1000)) : 20);
}

// ---------- a new plan: its own folder and workspace ----------
/**
 * atf-herdr new <name>: <plans_dir>/<name> (an ATF project), a workspace for it, a
 * coordinator (agent definition: --agent or new_plan_agent) that starts the design
 * discussion and creates the plan itself, and the board beside it.
 */
function newPlanCmd() {
  const name = pos[1];
  if (!name || flags.help) fail('usage: atf-herdr new <name> [--dir PATH] [--agent DEF] [--kind pi] [--prompt TEXT]');
  if (!inHerdr()) fail('not running inside herdr (HERDR_ENV != 1)');
  const cfg = pluginConfig();
  const home = (p) => String(p).replace(/^~(?=\/|$)/, process.env.HOME || '');
  const dir = flags.dir ? path.resolve(home(flags.dir)) : cfg.plans_dir ? path.join(path.resolve(home(cfg.plans_dir)), name) : fail('where should it go? set plans_dir in the plugin config (atf config shows it), or pass --dir');
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.existsSync(path.join(dir, '.atf', 'plans')) ? path.join(dir, '.atf') : initRoot(dir);
  enableSync(true, root);
  const env = newCoordinatorEnv(root, flags.kind);
  const ws = herdr(['workspace', 'create', '--cwd', dir, '--label', name, '--focus', ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])]);
  const pane = ws?.root_pane?.pane_id;
  if (!pane) fail('could not create a workspace');
  if (ws.tab?.tab_id) herdr(['tab', 'rename', ws.tab.tab_id, `plan: ${name}`.slice(0, 40)]);
  const agent = flags.agent ?? cfg.new_plan_agent ?? null;
  let r;
  try {
    r = launchNewCoordinator({ root, pane, kind: flags.kind, agent: agent || null, prompt: flags.prompt ?? cfg.new_plan_prompt ?? null });
  } catch (e) {
    fail(e.message);
  }
  const err = withBoardLock(() => toggleBoard('split', undefined, { root, target: pane, workspace: ws.workspace?.workspace_id, tab: ws.tab?.tab_id }));
  if (err) process.stderr.write(`atf-herdr: ${err}\n`);
  herdr(['agent', 'focus', r.pane]);
  process.stdout.write(`new plan workspace "${name}" in ${dir}: ${r.name} is its coordinator${agent ? ` (agent ${agent})` : ''}\n`);
}

// ---------- dispatch ----------
switch (pos[0]) {
  case 'spawn':
    spawnAgent();
    break;
  case 'sweep':
    await sweepCmd();
    break;
  case 'coordinate':
    coordinateCmd();
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
  case 'restore':
  case 'startup': {
    // startup: herdr's plugin startup hook, after it restored the session
    const openAt = (at) => withBoardLock(() => toggleBoard('split', undefined, { ...at, tab: herdr(['pane', 'get', at.target])?.pane?.tab_id ?? at.tab }));
    const opts = { openBoard: openAt, dryRun: !!flags['dry-run'], say: (m) => process.stdout.write(m + '\n') };
    const r = pos[0] === 'startup' ? await restoreOnStartup(opts) : await restore(opts);
    if (r) process.stdout.write((flags['dry-run'] ? '(dry run, nothing changed) ' : '') + (restoreSummary(r) || 'nothing to restore') + (r.skipped.length ? `\nleft alone: ${r.skipped.join('; ')}` : '') + '\n');
    break;
  }
  case 'new':
    newPlanCmd();
    break;
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
  case 'notify':
    notifyCmd();
    break;
  default:
    process.stdout.write(HELP + '\n');
}
