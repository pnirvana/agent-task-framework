#!/usr/bin/env node
// atf-copilot: run a plan's coordinator in GitHub Copilot CLI, in this terminal (SPEC §13.7).
//
//   atf-copilot install                 install the ATF extension for Copilot (once)
//   atf-copilot [--plan P] [--fresh]    start the plan's coordinator (resumes its session)
//   atf-copilot ... -- <copilot args>   extra arguments for copilot (e.g. --model …)
//
// The coordinator starts its subagents as Copilot's own background subagents (atf dispatch).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, getCurrentPlan, loadPlan, transact, eventsPath } from '../../src/store.mjs';
import { coordinatorPrompt } from '../../src/prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATF_BIN = path.resolve(HERE, '../../bin');
const EXT_MODULE = path.join(HERE, 'atf-extension.mjs');
const copilotHome = () => process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
const EXT_DIR = () => path.join(copilotHome(), 'extensions', 'atf');
const die = (m) => (process.stderr.write(`atf-copilot: ${m}\n`), process.exit(1));

const HELP = `atf-copilot: run an ATF plan's coordinator in GitHub Copilot CLI

  atf-copilot install                 install the ATF extension for Copilot (once)
  atf-copilot [--plan P] [--fresh]    start the coordinator of plan P (default: the current
                                      plan); resumes its Copilot session unless --fresh
  atf-copilot                         without a plan: start Copilot as a coordinator; ask it
                                      to plan something with atf
  atf-copilot ... -- <copilot args>   passed to copilot (e.g. -- --model claude-sonnet-5.5)

The extension wakes the idle coordinator when something needs it, prints what waits for
you after each turn, and adds /peek [T5]. It needs Copilot's experimental mode (passed as
--experimental) and is approved once in Copilot. The board, without herdr: atf-herdr tui
(in a second terminal).`;

function parse(argv) {
  const flags = {};
  const pos = [];
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      extra.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--plan') flags.plan = argv[++i];
    else if (a === '--fresh') flags.fresh = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a.startsWith('--')) die(`unknown option ${a} (copilot options go after --)`);
    else pos.push(a);
  }
  return { flags, pos, extra };
}

function install() {
  const dir = EXT_DIR();
  fs.mkdirSync(dir, { recursive: true });
  // the SDK is resolved for the extension's own entry file: hand joinSession to the module
  const src =
    `// Installed by atf-copilot: loads the ATF extension from ${path.dirname(EXT_MODULE)}\n` +
    `import { joinSession } from '@github/copilot-sdk/extension';\n` +
    `const { default: run } = await import(${JSON.stringify(new URL(`file://${EXT_MODULE}`).href)});\n` +
    `await run({ joinSession });\n`;
  const file = path.join(dir, 'extension.mjs');
  fs.writeFileSync(file, src);
  console.log(`installed ${file}`);
  console.log('In Copilot: experimental mode must be on (atf-copilot passes --experimental), and approve the "atf" extension once when asked.');
}

function start({ flags, extra }) {
  if (spawnSync('copilot', ['--version'], { stdio: 'ignore' }).status !== 0) die('copilot not found (install GitHub Copilot CLI)');
  if (!fs.existsSync(path.join(EXT_DIR(), 'extension.mjs'))) {
    console.log('ATF extension for Copilot not installed yet: installing it');
    install();
  }
  const root = findRoot();
  const planId = flags.plan || (root ? getCurrentPlan(root) : null);
  if (planId && !(root && fs.existsSync(eventsPath(root, planId)))) die(`plan not found: ${planId}`);
  const s = planId ? loadPlan(root, planId) : null;
  const name = s?.coordinator || 'coordinator';
  const prev = s?.session?.kind === 'copilot' ? s.session.ref : null;
  const mode = prev && !flags.fresh ? 'resume' : 'fresh';
  const session = mode === 'resume' ? prev : crypto.randomUUID();
  const wake = path.join(os.tmpdir(), `atf-copilot-wake-${session}.json`);
  const env = {
    ...process.env,
    ATF_ACTOR: name,
    ATF_ROLE: 'coordinator',
    ATF_HARNESS: 'copilot',
    ATF_WAKE: wake,
    PATH: `${ATF_BIN}${path.delimiter}${process.env.PATH}`,
    ...(root ? { ATF_DIR: root } : {}),
    ...(planId ? { ATF_PLAN: planId } : {}),
  };
  const args = ['--experimental', mode === 'resume' ? '--resume' : '--session-id', session];
  if (s) args.push('-i', copilotCoordinatorPrompt(s, mode, name));
  args.push(...extra);
  if (flags.dryRun) {
    console.log(JSON.stringify({ mode, session, env: Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('ATF_'))), args }, null, 2));
    return;
  }
  // the plan's session: what the next `atf-copilot` resumes
  if (s && mode === 'fresh')
    transact(root, planId, { id: 'atf-copilot', role: 'launcher', harness: 'copilot' }, () => [{ type: 'plan.session', data: { ref: session, kind: 'copilot', actor: name } }]);
  console.log(s ? `${mode === 'resume' ? 'resuming' : 'starting'} the coordinator of "${s.title}" (session ${session})` : 'starting Copilot as an ATF coordinator (no plan yet)');
  const r = spawnSync('copilot', args, { stdio: 'inherit', env });
  try {
    fs.rmSync(wake, { force: true });
  } catch {}
  process.exit(r.status ?? 1);
}

/** The herdr coordinator prompt, plus how to start subagents in Copilot. */
export function copilotCoordinatorPrompt(s, mode, name) {
  return (
    `${coordinatorPrompt(s, mode, name)} ` +
    'You run in GitHub Copilot CLI (not herdr): start each subagent with `atf dispatch <task> --name <name>` and give the prompt it prints, unchanged, to a background subagent (your task tool, general-purpose agent, background mode).'
  );
}

const argv = parse(process.argv.slice(2));
if (argv.flags.help) console.log(HELP);
else if (argv.pos[0] === 'install') install();
else if (argv.pos.length) die(`unknown command ${argv.pos[0]} (atf-copilot --help)`);
else start(argv);
