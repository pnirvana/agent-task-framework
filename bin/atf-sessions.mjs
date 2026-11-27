#!/usr/bin/env node
// atf-sessions: agents in ATF's own session daemon (src/sessiond.mjs), without herdr or
// tmux. The web UI's backend (docs/webui-design.md §4.1); usable from a terminal too.
import path from 'node:path';
import { findRoot, getCurrentPlan, loadPlan } from '../src/store.mjs';
import { launchPlan } from '../src/core.mjs';
import { launchAgent, launchCoordinator, spawnTarget, agentKinds } from '../src/launch.mjs';
import { sessionsBackend, socketPath, ensureDaemon, daemonUp, call, connect } from '../src/sessions.mjs';
import { serve } from '../src/sessiond.mjs';
import { startSupervisor, superviseOnce } from '../src/supervisor.mjs';

const HELP = `atf-sessions — run ATF agents in ATF's session daemon (no herdr, no tmux)

  atf-sessions start            start the daemon (if it is not running); prints its socket
  atf-sessions daemon           run the daemon in the foreground
  atf-sessions stop             end the daemon and every session in it
  atf-sessions list             sessions: name, project, plan, task, status
  atf-sessions attach <name|id> this terminal shows the session (ctrl-] detaches; the agent goes on)
  atf-sessions kill <name|id>   end a session (it stays listed until removed)
  atf-sessions rm <name|id>     end and forget a session
  atf-sessions shell [--name N] a shell session in the current directory
  atf-sessions spawn <task> [--name NAME] [--kind pi] [--agent DEF] [--early] [--fresh|--resume] [--dry-run]
      (the coordinator's tool, as \`atf spawn\`) start an agent for a task or work package
  atf-sessions coordinate [--plan ID] [--fresh] [--kind pi] [--dry-run]
      start the plan's coordinator (resumes its session; --fresh: a new one, after a handoff)
  atf-sessions supervise [--interval S]   close finished agents, nudge an idle coordinator,
                                          file sessions on tasks (the web UI runs this itself)
  atf-sessions sweep            one supervisor pass

Settings: [sessions] in ~/.config/atf/config.toml (agent_kind, lifecycle, agents).
Socket: $ATF_SESSIOND_SOCKET, else $XDG_RUNTIME_DIR/atf-<uid>/sessiond.sock.
`;

function parse(argv) {
  const pos = [],
    flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      flags['--'] = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !['fresh', 'resume', 'early', 'dry-run', 'help'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === '-h') flags.help = true;
    else pos.push(a);
  }
  return { pos, flags };
}

const { pos, flags } = parse(process.argv.slice(2));
const fail = (m) => {
  process.stderr.write(`atf-sessions: ${m}\n`);
  process.exit(1);
};
const say = (m) => process.stdout.write(m + '\n');

function resolveRoot() {
  const root = process.env.ATF_DIR || findRoot(process.cwd());
  if (!root) fail('no .atf directory found (run `atf init`, or set ATF_DIR)');
  return root;
}
const planOf = (root) => flags.plan || process.env.ATF_PLAN || getCurrentPlan(root) || fail('no plan selected (--plan or $ATF_PLAN)');

function sessionOf(ref) {
  if (!ref) fail('which session? (atf-sessions list)');
  const list = call({ op: 'list' }).list;
  const hits = list.filter((x) => x.id === ref || x.meta?.name === ref || x.name === ref);
  const liveHits = hits.filter((x) => !x.exited);
  const x = liveHits.length === 1 ? liveHits[0] : hits.length === 1 ? hits[0] : null;
  if (!x) fail(hits.length ? `"${ref}" is ambiguous: ${hits.map((h) => `${h.id} (${h.meta?.root ? path.basename(path.dirname(h.meta.root)) : h.cwd})`).join(', ')}` : `no session "${ref}"`);
  return x;
}

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

function list() {
  if (!daemonUp()) return say('atf-sessiond is not running (atf-sessions start)');
  const B = sessionsBackend();
  const all = B.sessions();
  if (flags.json) return say(JSON.stringify(all, null, 2));
  if (!all.length) return say('no sessions');
  const statusOf = new Map();
  for (const root of new Set(all.map((x) => x.meta?.root).filter(Boolean))) for (const a of B.agents(root).values()) statusOf.set(a.handle, a.status);
  const rows = all.map((x) => [
    x.meta?.name || x.name,
    x.id,
    x.meta?.role || 'shell',
    x.meta?.kind || '',
    x.meta?.root ? path.basename(path.dirname(x.meta.root)) : x.cwd.replace(process.env.HOME, '~'),
    [x.meta?.plan, x.meta?.task].filter(Boolean).join(' '),
    x.exited ? `exited ${x.code}` : statusOf.get(x.id) || 'running',
    `out ${ago(x.lastOutput)} ago`,
  ]);
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) say(r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd());
}

// What a program in a session may have turned on in the terminal, turned off again when
// this terminal stops showing it: kitty keyboard protocol (pop, then flags 0),
// modifyOtherKeys, win32-input-mode, mouse reporting, focus events, bracketed paste,
// application cursor keys and keypad, the alternate screen; cursor shown, colours reset.
const RESET_TERMINAL = '\x1b[<99u\x1b[=0u\x1b[>4;0m\x1b[?9001l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>\x1b[?1049l\x1b[?25h\x1b[0m';
// ctrl-] as a plain byte, and as the kitty keyboard protocol and modifyOtherKeys send it
const DETACH = [Buffer.from([0x1d]), Buffer.from('\x1b[93;5u'), Buffer.from('\x1b[27;5;93~')];

/** This terminal shows the session until ctrl-] (the agent keeps running). */
function attach(ref) {
  const x = sessionOf(ref);
  const who = x.meta?.name || x.name;
  if (x.exited) {
    // its program ended (e.g. you quit the agent): nothing to attach to
    const again = x.meta?.role === 'coordinator' ? `start it again: atf-sessions coordinate${x.meta.plan ? ` --plan ${x.meta.plan}` : ''}` : `atf-sessions rm ${x.id} removes it`;
    fail(`${who}'s session ended ${ago(x.lastOutput)} ago (exit ${x.code}); ${again}`);
  }
  if (!process.stdin.isTTY) fail('attach needs a terminal');
  let finished = false;
  const done = (why) => {
    if (finished) return;
    finished = true;
    try {
      process.stdin.setRawMode(false);
    } catch {}
    process.stdout.write(`${RESET_TERMINAL}\r\n[atf-sessions] ${why}\r\n`, () => process.exit(0));
  };
  const conn = connect((m) => {
    if (m.id !== undefined && m.id !== x.id) return;
    if (m.ev === 'replay') {
      process.stdout.write(m.data);
      if (m.exited) done(`${who}'s session has ended (exit ${m.code})`);
    } else if (m.ev === 'out') process.stdout.write(m.data);
    else if (m.ev === 'exit') done(`${who}'s session ended (exit ${m.code})`);
    else if (m.ev === 'closed') done('the connection to atf-sessiond closed');
  });
  const size = () => conn.send({ op: 'resize', id: x.id, cols: process.stdout.columns, rows: process.stdout.rows });
  process.stdin.setRawMode(true);
  process.stdin.on('data', (d) => {
    if (DETACH.some((k) => d.includes(k))) return done(`detached from ${who}; it keeps running (atf-sessions attach ${who})`);
    conn.send({ op: 'input', id: x.id, data: d.toString('utf8') });
  });
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => done('detached'));
  process.stdout.on('resize', size);
  conn.socket.on('connect', () => {
    size();
    conn.send({ op: 'attach', id: x.id });
  });
}

function spawnCmd() {
  if (!pos[1]) fail('usage: atf-sessions spawn <task> [--name NAME] [--kind K] [--agent DEF] [--early]');
  const root = resolveRoot();
  const planId = planOf(root);
  const s = loadPlan(root, planId);
  let target;
  try {
    target = spawnTarget(s, pos[1], { name: flags.name, agent: flags.agent, early: !!flags.early });
  } catch (e) {
    fail(e.message);
  }
  const B = sessionsBackend();
  const force = flags.fresh ? 'fresh' : flags.resume ? 'resume' : undefined;
  if (flags['dry-run']) {
    const lp = launchPlan(s, target.t.id, target.name);
    const kind = flags.kind || process.env.ATF_AGENT_KIND || B.config().agent_kind || 'pi';
    return say(`${target.t.id} → ${target.name} (${kind}): ${force || lp.mode} (${lp.reason})\n  bin: ${agentKinds(B)[kind]?.bin || kind}`);
  }
  try {
    const r = launchAgent({ backend: B, root, planId, taskId: target.t.id, name: target.name, kind: flags.kind, agent: target.agent, early: !!flags.early, force, extraArgs: flags['--'] || [] });
    say(`${target.t.id} → ${r.name} (${r.kind}${r.agent ? `, agent ${r.agent}` : ''}, ${r.mode}) in session ${r.pane}`);
  } catch (e) {
    fail(e.message);
  }
}

function coordinateCmd() {
  const root = resolveRoot();
  const planId = flags.plan || pos[1] || planOf(root);
  try {
    const r = launchCoordinator({ backend: sessionsBackend(), root, planId, fresh: !!flags.fresh, kind: flags.kind, dryRun: !!flags['dry-run'], say, handoffMs: flags.timeout ? Number(flags.timeout) * 1000 : undefined });
    if (flags['dry-run']) return say(`coordinator ${r.name}: ${r.mode === 'running' ? `running (session ${r.pane})` : `would start ${r.mode}`}${r.session ? ` (session ${r.session})` : ''}`);
    if (r.mode === 'running') return say(`coordinator ${r.name} is running (session ${r.pane}); --fresh replaces it`);
    say(`coordinator ${r.hname} (${r.mode}) in session ${r.pane}: atf-sessions attach ${r.hname}`);
  } catch (e) {
    fail(e.message);
  }
}

try {
  if (flags.help || !pos[0] || pos[0] === 'help') {
    process.stdout.write(HELP);
    process.exit(0);
  }
  switch (pos[0]) {
    case 'daemon':
      process.on('SIGHUP', () => {});
      serve(socketPath());
      break;
    case 'start':
      say(`${ensureDaemon() ? 'started' : 'running'}: ${socketPath()}`);
      break;
    case 'stop':
      if (!daemonUp()) say('not running');
      else call({ op: 'shutdown' }), say('stopped (all sessions ended)');
      break;
    case 'list':
    case 'ls':
      list();
      break;
    case 'attach':
    case 'a':
      attach(pos[1]);
      break;
    case 'kill':
      call({ op: 'kill', id: sessionOf(pos[1]).id });
      break;
    case 'rm':
      call({ op: 'remove', id: sessionOf(pos[1]).id });
      break;
    case 'shell': {
      ensureDaemon();
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ATF_(?!SESSIOND_SOCKET)|HERDR_)/.test(k)));
      const r = call({ op: 'create', name: flags.name || 'shell', cmd: '$SHELL -l', cwd: process.cwd(), env, cols: process.stdout.columns || 120, rows: process.stdout.rows || 32 });
      say(`shell in session ${r.id}: atf-sessions attach ${r.id}`);
      break;
    }
    case 'spawn':
      spawnCmd();
      break;
    case 'coordinate':
      coordinateCmd();
      break;
    case 'sweep': {
      const { actions } = superviseOnce(sessionsBackend());
      say(actions.length ? actions.join('\n') : 'nothing to do');
      break;
    }
    case 'supervise': {
      ensureDaemon();
      const ms = Number(flags.interval || 5) * 1000;
      say(`supervising sessions every ${ms / 1000}s (ctrl-c ends)`);
      startSupervisor(sessionsBackend(), { intervalMs: ms, onActions: (a) => a.forEach((x) => say(`${new Date().toLocaleTimeString()} ${x}`)), onError: (e) => say(`error: ${e.message}`) });
      break;
    }
    default:
      fail(`unknown command ${pos[0]} (atf-sessions --help)`);
  }
} catch (e) {
  fail(e.message);
}
