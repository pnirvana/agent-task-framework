// ATF for GitHub Copilot CLI (SPEC §13.7): wakes the idle coordinator when something needs
// it, says after each turn what waits for the human, and adds `/peek [T5]` (not `/atf`:
// Copilot already turns the atf skill into a `/atf` command).
//
// Copilot loads extensions from ~/.copilot/extensions/<name>/extension.mjs; `atf-copilot
// install` writes a small one there that imports this module and passes it the SDK's
// joinSession. It is inert in sessions that are not an ATF coordinator (no ATF_WAKE).
// An extension runs as its own process with the CLI's environment, but cannot change the
// agent's shell environment: the launcher (atf-copilot, or herdr) sets ATF_* and ATF_WAKE.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { driverInbox } from '../../src/core.mjs';
import { loadPlan } from '../../src/store.mjs';

const ATF_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/atf.mjs');
const NODE = process.env.ATF_NODE || 'node';
const LOG = process.env.ATF_COPILOT_LOG; // debugging: a file to log what the extension does
const log = (...a) => LOG && fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`);

// as in adapters/pi/atf.ts
const KIND_LABEL = { question: 'question', 'your-review': 'review', review: 'review', 'plan-question': 'question', finished: 'finished', failed: 'failed' };
/** The first sentence of an agent's message (they are asked to lead with one). */
const firstSentence = (s, max = 110) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = flat.match(/^.+?[.?!](?=\s|$)/);
  const one = m ? m[0] : flat;
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};

export default async function run({ joinSession }) {
  const armFile = process.env.ATF_WAKE;
  const coordinator = process.env.ATF_ROLE === 'coordinator';
  if (!armFile || !coordinator) {
    // not an ATF coordinator session: join (an extension must) but do nothing
    await joinSession({});
    return;
  }
  const envArm =
    process.env.ATF_DIR && process.env.ATF_PLAN && process.env.ATF_ACTOR
      ? { root: process.env.ATF_DIR, plan: process.env.ATF_PLAN, actor: process.env.ATF_ACTOR, role: 'coordinator' }
      : null;
  // what `atf wait` armed last (it knows the plan even when the coordinator created it), else the env
  const readArm = () => {
    try {
      const a = JSON.parse(fs.readFileSync(armFile, 'utf8'));
      if (a?.root && a?.plan && a?.actor) return a;
    } catch {}
    return envArm;
  };
  const atfEnv = (arm) => {
    const env = { ...process.env, ATF_DIR: arm.root, ATF_PLAN: arm.plan, ATF_ACTOR: arm.actor, ATF_ROLE: arm.role || 'coordinator', NO_COLOR: '1' };
    delete env.ATF_WAKE; // the waiter itself blocks
    return env;
  };

  /** Items waiting for the human in the armed plan: [{id, label, text}]. */
  const forHuman = () => {
    const arm = readArm();
    if (!arm) return { arm, items: [] };
    try {
      const s = loadPlan(arm.root, arm.plan);
      const all = driverInbox(s).filter((i) => i.for === 'human');
      // the plan's own requests (its questions, "finished") are one entry, `plan`: one reply
      // in the chat answers all open plan questions
      const planIts = all.filter((i) => !i.task);
      const qs = planIts.filter((i) => i.kind === 'plan-question');
      const items = all
        .filter((i, k) => i.task || k === all.indexOf(planIts[0]))
        .map((i) => {
          const head = i.task ? i : qs[0] ?? i;
          const more = !i.task && qs.length > 1 ? ` (+${qs.length - 1} more)` : '';
          return { id: i.task ?? 'plan', label: KIND_LABEL[head.kind] ?? head.kind, text: firstSentence(head.message ?? (i.task ? s.tasks[i.task]?.title : '')) + more };
        });
      return { arm, title: s.title, items };
    } catch (e) {
      log('inbox failed', e?.message);
      return { arm, items: [] };
    }
  };

  let session;
  const say = (msg, opts = {}) => session?.log(msg, { ephemeral: true, ...opts }).catch(() => {});

  const commands = [
    {
      name: 'peek',
      description: 'ATF: what waits for you; /peek T5 or /peek plan: one request in full; /peek tasks: all tasks',
      handler: async ({ args }) => {
        const id = String(args ?? '').trim();
        const { arm, title, items } = forHuman();
        if (!arm) return say('atf: no plan yet (the coordinator has not run `atf wait`)');
        const tasks = () => execFileSync(NODE, [ATF_CLI, 'list', '--plan', arm.plan], { env: { ...atfEnv(arm), NO_COLOR: '1' }, encoding: 'utf8' }).trimEnd();
        if (id.toLowerCase() === 'tasks' || (!id && !items.length)) {
          try {
            const head = items.length ? `atf · tasks of ${title}` : `atf · ${title}: nothing waits for you. Tasks:`;
            return say(`${head}\n${tasks()}\n  /peek T5 shows one task in full`);
          } catch (e) {
            return say(`atf list: ${String(e.stderr || e.message).trim()}`, { level: 'warning' });
          }
        }
        if (!id)
          return say(
            [`atf · for you in ${title}:`, ...items.map((i) => `  ${i.id.padEnd(5)} ${i.label.padEnd(9)} ${i.text}`), '  /peek <id> shows one in full (/peek plan: the plan\'s own questions; /peek tasks: all tasks); answer in the chat ("T5: …", "plan: …")'].join('\n'),
          );
        try {
          const text = execFileSync(NODE, [ATF_CLI, 'brief', id, '--plan', arm.plan], { env: atfEnv(arm), encoding: 'utf8' });
          say(text.trimEnd());
        } catch (e) {
          say(`atf brief ${id}: ${String(e.stderr || e.message).trim()}`, { level: 'warning' });
        }
      },
    },
  ];

  session = await joinSession({ commands });
  log('joined', session.sessionId, 'arm', armFile);

  // ---------- wake: while idle, wait for what needs the coordinator ----------
  let child = null;
  let busy = false;
  const stopWait = (why) => {
    if (!child) return;
    log('stop waiter:', why);
    child.removeAllListeners('close');
    child.kill('SIGTERM');
    child = null;
  };
  const startWait = () => {
    if (child || busy) return;
    const arm = readArm();
    if (!arm) return log('idle, not armed');
    try {
      // a closed plan needs no coordinator: nothing to wake it for
      if (!['active', 'paused'].includes(loadPlan(arm.root, arm.plan).status)) return log('plan closed, not waiting');
    } catch {}
    let out = '';
    const c = spawn(NODE, [ATF_CLI, 'wait', '--new', '--plan', arm.plan], { env: atfEnv(arm), stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    log('waiter', c.pid, arm.plan);
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', async (code) => {
      if (child !== c) return;
      child = null;
      log('waiter exit', code, JSON.stringify(out.slice(0, 160)));
      if (code !== 0 || !out.trim()) return setTimeout(startWait, 5000); // e.g. the plan was removed: retry later
      busy = true;
      try {
        await session.send({
          prompt:
            `[ATF wake-up for the coordinator, not a message from the human] New in plan ${arm.plan}:\n\n${out.trim()}\n\n` +
            'Handle it (atf skill, coordinator part). When you are done, run `atf wait`, then end your turn with your message for the human (what you did, what waits for them).',
          source: 'automation-atf',
        });
      } catch (e) {
        busy = false;
        log('send failed', e?.message);
      }
    });
  };

  // after each turn: one transient line with what waits for the human (not in the transcript)
  let lastLine = '';
  const endOfTurn = () => {
    const { items } = forHuman();
    const line = items.length ? `for you: ${items.map((i) => `${i.id} ${i.label}`).join(' · ')}   (/peek <id> for details)` : '';
    if (line && line !== lastLine) say(line);
    lastLine = line;
  };

  let idleTimer = null;
  session.on('session.idle', () => {
    // fires more than once per idle: settle first
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      busy = false;
      endOfTurn();
      startWait();
    }, 300);
  });
  session.on('assistant.turn_start', () => {
    busy = true;
    clearTimeout(idleTimer);
    stopWait('turn start');
  });
  session.on('user.message', () => {
    busy = true;
    stopWait('user message');
  });
  session.on('session.shutdown', () => {
    stopWait('shutdown');
    try {
      fs.rmSync(armFile, { force: true });
    } catch {}
  });
  // no wait before the first turn: the launcher's kickoff prompt arrives a moment after the
  // session starts, and a wake sent meanwhile would sit in Copilot's queue, stale (the wait
  // starts at the first session.idle; `atf wait` arms the plan when there is one)
}
