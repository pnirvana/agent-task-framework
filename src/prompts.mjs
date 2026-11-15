// Prompts that start ATF agents, shared by all launchers (herdr, atf dispatch, atf-copilot).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillInstalled } from './store.mjs';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skill/atf');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');

function lastNoteFromOthers(t) {
  return [...t.notes].reverse().find((n) => n.actor && n.actor !== t.owner && n.kind !== 'checkpoint');
}

function wasReopened(t) {
  return t.status === 'todo' && t.history.some((h) => h.type === 'status' && h.to === 'todo' && ['review', 'done', 'failed', 'blocked'].includes(h.from));
}

/** Why the agent is (re)started, in words, for the prompt. */
function situation(s, t) {
  if (t.changes_requested) {
    const fb = t.feedback[t.feedback.length - 1];
    return `it came back from review (round ${fb.round}) with these instructions from ${fb.actor ?? 'the coordinator'}: "${fb.message}". Address every point, say in an atf note how, then send it to review again.`;
  }
  if (t.can_resume) return `it was blocked on ${t.blocked_on.join(', ')}, which ${t.blocked_on.length > 1 ? 'are' : 'is'} done now.`;
  if (t.answered) {
    const n = lastNoteFromOthers(t);
    return `its question was answered${n ? ` by ${n.actor}: "${n.message}"` : ''}.`;
  }
  if (wasReopened(t)) {
    const h = [...t.history].reverse().find((x) => x.type === 'status' && x.to === 'todo');
    return `it was reopened by ${h?.actor ?? 'the coordinator'}${h?.message ? `: "${h.message}"` : ''}.`;
  }
  return null;
}

/**
 * The prompt that starts a subagent on a task. `inSession`: the agent is a subagent of the
 * coordinator's own harness (atf dispatch), so it shares the coordinator's environment and
 * must name itself on every atf command (`--as <name>`).
 */
export function buildPrompt({ s, t, name, mode, pkg, kindCfg = {}, early = false, inSession = false }) {
  const p = promptBody({ s, t, name, mode, pkg, kindCfg, early });
  if (!inSession) return p;
  return (
    `${p.replace(/`atf ([^`]*)`/g, (_, c) => `\`atf ${c} --as ${name}\``)} ` +
    `Your shell has the coordinator's ATF identity: add \`--as ${name}\` to every atf command you run, or your work is recorded as the coordinator's. ` +
    `When you end, reply with one or two sentences: what you did and the task's status.`
  );
}

function promptBody({ s, t, name, mode, pkg, kindCfg, early }) {
  const skill = kindCfg.nativeSkill || skillInstalled() ? 'Follow the atf skill (load it if it is not loaded yet).' : `First read ${SKILL_FILE} and follow its subagent section.`;
  // v2: a subagent does its assignment and ends; it never waits
  const end = 'When your assignment is finished (or blocked and nothing else is ready for you), end your turn: do not wait; the coordinator starts a new agent when there is more.';
  const why = situation(s, t);
  if (mode === 'resume')
    return (
      `[ATF] You are resumed in your earlier session for ${t.id} (${t.title})${why ? `: ${why}` : '.'} ` +
      `Run \`atf show ${t.id}\` to see what changed, then \`atf start ${t.id}\` and continue where you left off. ${end} ${skill}`
    );
  if (early && t.waiting_on?.length)
    return (
      `You are subagent "${name}". Your ATF task is ${t.id}: ${t.title}. It is started EARLY: it depends on ${t.waiting_on.join(', ')}, which ${t.waiting_on.length > 1 ? 'are' : 'is'} not done yet. ` +
      `Run \`atf show ${t.id}\`, then \`atf start ${t.id} --early\` and do everything that does not need ${t.waiting_on.join(', ')}. ` +
      `When you reach what does, write a checkpoint (\`atf note ${t.id} --kind checkpoint "done: … left: …"\`) and run \`atf block ${t.id} --on ${t.waiting_on.join(',')} -m "<what you need>"\`. ${end} ${skill}`
    );
  const history = t.started_at
    ? ` This task was worked on before: ${why ? why + ' ' : ''}\`atf show ${t.id}\` has its checkpoint, notes and history. Continue from there instead of starting over.`
    : '';
  if (pkg)
    return (
      `You are subagent "${name}". You own ATF work package ${pkg.id}: ${pkg.title} (the whole subtree); your next task is ${t.id}: ${t.title}.${history} ` +
      `Run \`atf show ${pkg.id}\` and \`atf list --mine\` to see the package. Then loop: \`atf next --package\`, do the task, finish it ` +
      `(done/review/block/fail). You may split a task with \`atf add <title> --parent <id>\`. Questions and decisions go to the coordinator as a block. ${end} ${skill}`
    );
  return (
    `You are subagent "${name}". Your ATF task is ${t.id}: ${t.title}.${history} ` +
    `Run \`atf show ${t.id}\` for details and acceptance criteria, then \`atf start ${t.id}\` and do the work. ${skill} ` +
    (t.review || (t.reviewer && t.reviewer !== 'coordinator')
      ? `Report progress with atf. This task needs review: finish with \`atf review ${t.id} -m "<summary + what to check>"\` (not done), or block/fail. `
      : `Report progress with atf and finish with atf done/review/block/fail. `) +
    `Questions and decisions go to the coordinator: \`atf block ${t.id} -m "<question>"\` after a checkpoint. ${end}`
  );
}

export function coordinatorPrompt(s, mode, name) {
  const plan = `--plan ${s.id}`;
  if (mode === 'resume')
    return `[ATF] You are resumed as the coordinator of plan "${s.title}" (${plan}). Catch up: \`atf wait ${plan}\` reports what happened since your last wait, \`atf status ${plan}\` shows where things stand. Handle what needs you, then run \`atf wait ${plan}\` again (if it says you will be woken, end your turn). Follow the atf skill (coordinator part).`;
  const docs = s.docs?.length ? ` the documents it lists (${s.docs.join(', ')}),` : '';
  return (
    `You are "${name}", the coordinator of ATF plan "${s.title}" (${plan}), in a new session. Follow the atf skill, coordinator part: you make the decisions and start every subagent. ` +
    `Get up to speed first: \`atf plan show ${plan}\` (goal, documents, the plan checkpoint from the previous session),${docs} then \`atf status ${plan}\`. ` +
    `Then handle what needs attention and run \`atf wait ${plan}\` (if it says you will be woken, end your turn; otherwise keep waiting in a loop). Your identity is set (ATF_ACTOR=${name}, ATF_ROLE=coordinator).`
  );
}
