#!/usr/bin/env node
// atf-herdr — herdr adapter + plugin entrypoints for ATF.
// The ATF core knows nothing about herdr; everything herdr-specific lives here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, getCurrentPlan, readConfig, writeConfig } from '../../src/store.mjs';
import { herdr, inHerdr, notify, pluginContext, pluginConfig } from './lib/herdr.mjs';
import { sync, notifyForEvents, nudgeIdle } from './lib/sync.mjs';
import { chooseSplit, chooseBoardSplit, tabLayout } from './lib/layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(HERE, 'atf-herdr.mjs');
const ATF = path.resolve(HERE, '../../bin/atf.mjs');
const SKILL_DIR = path.resolve(HERE, '../../skill/atf');
const PLUGIN_ID = 'atf.herdr';

const HELP = `atf-herdr — run and watch ATF agents inside herdr

  atf-herdr spawn <task> [--name NAME] [--kind pi] [--direction right|down]
                  [--target-pane ID] [--dry-run] [-- <agent args>]
      place a pane (largest pane of the tab, split along its long side; an
      "agents" tab when full; --direction forces a split of the current pane),
      start an agent with ATF env + skill, assign the task/package, prompt it
  atf-herdr board            open the task board pane (toggle) for this project
  atf-herdr tui              run the board in the current terminal
  atf-herdr sync             push task labels / plan progress to herdr now
  atf-herdr enable-sync      install the ATF post-write hook for this project
  atf-herdr disable-sync     remove it

Plugin actions (atf.herdr.*): board, board-popup, sync, enable-sync.`;

// ---------- args ----------
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const agentArgs = sep >= 0 ? argv.slice(sep + 1) : [];
const main = sep >= 0 ? argv.slice(0, sep) : argv;
const flags = {};
const pos = [];
for (let i = 0; i < main.length; i++) {
  const a = main[i];
  if (a === '--dry-run') flags.dryRun = true;
  else if (a.startsWith('--')) flags[a.slice(2)] = main[++i];
  else pos.push(a);
}
const dry = !!flags.dryRun;

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

const herdrPath = () => process.env.HERDR_BIN_PATH || 'herdr';

function sh(cmd, args, { json = true } = {}) {
  const shown = [cmd, ...args].map((x) => (/[\s"'`]/.test(x) ? JSON.stringify(x) : x)).join(' ');
  if (dry) {
    process.stdout.write(`$ ${shown}\n`);
    return json ? { result: { pane: { pane_id: '<new-pane>' } } } : '';
  }
  const out = execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
  return json ? JSON.parse(out) : out;
}

// ---------- spawn ----------
function spawnAgent() {
  const task = pos[1];
  if (!task) fail('usage: atf-herdr spawn <task> [--name NAME]');
  if (!inHerdr() && !dry) fail('not running inside herdr (HERDR_ENV != 1)');
  const root = resolveRoot();
  const plan = flags.plan || getCurrentPlan(root);
  if (!plan) fail('no plan selected (--plan or $ATF_PLAN)');
  const kind = flags.kind || process.env.ATF_AGENT_KIND || pluginConfig().agent_kind || 'pi';
  const env = {
    ATF_DIR: root,
    ATF_PLAN: plan,
    ATF_ROLE: 'subagent',
    ATF_HARNESS: 'herdr',
    PATH: `${path.dirname(ATF)}:${process.env.PATH}`, // `atf` resolvable without a global install
  };

  let t = { id: task, title: '(dry run)' };
  if (!dry) {
    t = JSON.parse(execFileSync(process.execPath, [ATF, 'show', task, '--json'], { env: { ...process.env, ...env } }).toString());
    const eff = t.rollup_status ?? t.status;
    if (['done', 'cancelled'].includes(eff)) fail(`${t.id} is already ${eff}`);
    // A parent task is a work package: the agent owns the whole subtree and works through it.
    if (!t.children.length && t.status === 'todo' && !t.ready) fail(`${t.id} is not ready (waits on ${t.waiting_on.join(', ')})`);
  }
  const name = (flags.name || t.assignee || `w-${t.id}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z]+/, 'w-')
    .slice(0, 32);
  env.ATF_ACTOR = name;

  const pane = placeAgentPane(path.dirname(root), env);

  // pi loads the skill natively; other agents are told where to read it.
  const nativeArgs = kind === 'pi' ? ['--skill', SKILL_DIR, ...agentArgs] : agentArgs;
  sh(herdrPath(), ['agent', 'start', name, '--kind', kind, '--pane', pane, ...(nativeArgs.length ? ['--', ...nativeArgs] : [])]);

  const coordEnv = { ...process.env, ...env, ATF_ACTOR: process.env.ATF_ACTOR || 'coordinator', ATF_ROLE: 'coordinator' };
  if (dry) sh('atf', ['assign', t.id, name], { json: false });
  else execFileSync(process.execPath, [ATF, 'assign', t.id, name], { env: coordEnv });

  const skillHint = kind === 'pi' ? 'Follow the atf skill.' : `First read ${path.join(SKILL_DIR, 'SKILL.md')} and follow its subagent section.`;
  const isPackage = !!t.children?.length;
  const prompt = isPackage
    ? `You are subagent "${name}". You own ATF work package ${t.id}: ${t.title} (the whole subtree). ` +
      `Run \`atf show ${t.id}\` and \`atf list --mine\` to see it. Then loop: \`atf next --package\` picks your next ready task; ` +
      `do it and finish it (done/review/block/fail); repeat until nothing is left. You may split a task further with ` +
      `\`atf add <title> --parent <id>\`. If tasks wait on dependencies outside your package, use \`atf wait\`. ${skillHint}`
    : `You are subagent "${name}". Your ATF task is ${t.id}: ${t.title}. ` +
      `Run \`atf show ${t.id}\` for details and acceptance criteria, then \`atf start ${t.id}\` and do the work. ` +
      `${skillHint} Report progress with atf and finish with atf done/review/block/fail.`;
  sh(herdrPath(), ['agent', 'prompt', name, prompt]);
  if (!dry) sync(root);
  process.stdout.write(`${t.id} → ${name} (${kind}) in pane ${pane}\n`);
}

// ---------- board ----------
/**
 * Create the pane for a new agent. Default: split the largest pane of the current tab
 * along its longer side (never the board); if nothing has room, open an "agents" tab.
 * `--direction` keeps the old behaviour: split the target/current pane that way.
 */
function placeAgentPane(cwd, env) {
  const target = flags['target-pane'] || process.env.HERDR_PANE_ID;
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  if (dry) return sh(herdrPath(), ['pane', 'split', ...(target ? ['--pane', target] : ['--current']), '--direction', flags.direction || 'auto', '--cwd', cwd, '--no-focus', ...envArgs]).result.pane.pane_id;
  if (flags.direction || !target) {
    const args = ['pane', 'split', ...(target ? ['--pane', target] : ['--current']), '--direction', flags.direction || 'right', '--cwd', cwd, '--no-focus', ...envArgs];
    return sh(herdrPath(), args).result.pane.pane_id;
  }
  const choice = chooseSplit(target, { exclude: Object.values(readBoards()) });
  if (choice) return sh(herdrPath(), ['pane', 'split', '--pane', choice.pane, '--direction', choice.direction, '--cwd', cwd, '--no-focus', ...envArgs]).result.pane.pane_id;
  const ws = tabLayout(target)?.workspace_id || process.env.HERDR_WORKSPACE_ID;
  const res = sh(herdrPath(), ['tab', 'create', ...(ws ? ['--workspace', ws] : []), '--cwd', cwd, '--label', 'agents', '--no-focus', ...envArgs]);
  return res.result.root_pane.pane_id;
}

function readBoards() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function stateFile() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR || path.join(process.env.HOME, '.local/state/herdr/plugins', PLUGIN_ID);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'boards.json');
}

function openBoard(placement) {
  if (!inHerdr()) fail('not running inside herdr');
  const root = resolveRoot({ optional: true }); // board offers `atf init` when missing
  const dir = root ? path.dirname(root) : userDir();
  const ctx = pluginContext();
  const target = ctx.focused_pane_id || process.env.HERDR_PANE_ID;
  const ws = ctx.workspace_id || process.env.HERDR_WORKSPACE_ID || 'default';
  const boards = readBoards();

  // the board toggles per workspace: close it if one is open (split or tab)
  if (placement !== 'popup' && boards[ws] && herdr(['pane', 'get', boards[ws]])) {
    herdr(['plugin', 'pane', 'close', boards[ws]]) || herdr(['pane', 'close', boards[ws]]);
    delete boards[ws];
    fs.writeFileSync(stateFile(), JSON.stringify(boards));
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
  if (placement !== 'popup' && paneId) {
    boards[ws] = paneId;
    fs.writeFileSync(stateFile(), JSON.stringify(boards));
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

// ---------- hook / sync ----------
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

/** Invoked by the ATF post-write hook after every committed transaction. */
function hook() {
  if (!inHerdr()) return; // writer is not inside herdr: nothing to project onto
  const root = process.env.ATF_DIR;
  const plan = process.env.ATF_PLAN;
  if (!root || !plan) return;
  sync(root);
  nudgeIdle(root);
  if ((process.env.ATF_HOOK_TYPES || '').split(',').includes('task.status'))
    notifyForEvents(root, plan, Number(process.env.ATF_HOOK_FROM_SEQ), Number(process.env.ATF_HOOK_TO_SEQ));
}

// ---------- dispatch ----------
switch (pos[0]) {
  case 'spawn':
    spawnAgent();
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
    const n = nudgeIdle(r);
    process.stdout.write(`synced ${d.panes.size} pane(s), ${d.workspaces.size} workspace(s)${n.length ? `; woke ${n.join(', ')}` : ''}\n`);
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
