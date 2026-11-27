// ATF live artifacts for GitHub Copilot CLI (SPEC §14): translates the session's tool events
// to the shared observer (src/live-observer.mjs). It never changes a command or its output.
//
//   tool.execution_start (bash)       → start (agentId: a background subagent of this session)
//   tool.shell_output                 → output, appended (live, chunk by chunk)
//   tool.execution_complete           → end with shellExecution.exitCode; a command moved to
//                                       the background (structuredContent.shellId, no exit
//                                       code) keeps running: detach
//   tool.execution_complete read_bash → output of a background shell; its end when the
//                                       result says "<shellId: N completed with exit code X>"
//   system.notification shell_completed → end of a background shell
//   subagent.started                  → the subagent's ATF name: its display name (the
//                                       `--name` of `atf dispatch`), else `--as NAME` in its
//                                       atf commands
//   tool.execution_start view (*.log) → read
//   permission.requested / .completed → approval: the command waits for the human
//
// Works in any ATF session: a coordinator (its subagents' commands; its own have no task)
// and an agent started by atf-herdr with ATF_ACTOR (its own commands).
import { createObserver } from '../../src/live-observer.mjs';
import { writeAgentStatus } from '../../src/live.mjs';

const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell']);
const DONE_RE = /<shellId: (\S+) completed with exit code (-?\d+)>/;
const clean = (s) => String(s ?? '').replace(/\n?<(?:command with )?shellId: [^>]*>\s*$/, '');

/** Observe a joined Copilot session. Returns the observer (null outside an ATF plan). */
export function attachLive(session, { log = () => {}, root, plan } = {}) {
  const obs = createObserver({ ...(root ? { root } : {}), ...(plan ? { plan } : {}), actor: process.env.ATF_ROLE === 'coordinator' ? null : process.env.ATF_ACTOR || null });
  if (!obs) return null;
  const cwd = process.cwd();
  const reads = new Map(); // read_bash call id -> shell id
  const on = (type, f) => {
    try {
      session.on(type, (e) => {
        try {
          f(e);
        } catch (err) {
          log('live:', type, err?.message ?? err);
        }
      });
    } catch {}
  };

  on('subagent.started', (e) => obs.name(e.agentId, e.data?.agentDisplayName || null));

  on('tool.execution_start', (e) => {
    const d = e.data || {};
    const a = d.arguments || {};
    if (SHELL_TOOLS.has(d.toolName)) obs.start({ id: d.toolCallId, cmd: a.command, cwd, agent: e.agentId ?? null }).catch(() => {});
    else if (d.toolName === 'read_bash' && a.shellId != null) reads.set(d.toolCallId, String(a.shellId));
    else if (d.toolName === 'view' && typeof a.path === 'string') obs.read({ file: a.path, agent: e.agentId ?? null, cwd });
  });

  on('tool.shell_output', (e) => obs.output({ id: e.data?.toolCallId, text: e.data?.text ?? '', append: true }));

  on('tool.execution_complete', (e) => {
    const d = e.data || {};
    const content = d.result?.content ?? '';
    const shell = reads.get(d.toolCallId);
    if (shell != null) {
      // output of a background shell, read by the agent
      reads.delete(d.toolCallId);
      if (!obs.has(shell)) return;
      const m = String(content).match(DONE_RE);
      obs.output({ id: shell, text: clean(content) + '\n', append: true });
      if (m) obs.end({ id: shell, exit: +m[2] });
      return;
    }
    if (!obs.has(d.toolCallId)) return;
    const bg = d.result?.structuredContent?.shellId;
    if (d.shellExecution?.exitCode == null && bg != null && !DONE_RE.test(content)) {
      obs.output({ id: d.toolCallId, text: clean(content), append: true });
      obs.detach({ id: d.toolCallId, shell: bg }); // still running in the background
      return;
    }
    const exit = d.shellExecution?.exitCode ?? +(String(content).match(DONE_RE)?.[2] ?? (d.success ? 0 : 1));
    obs.end({ id: d.toolCallId, exit, text: clean(content) });
  });

  on('system.notification', (e) => {
    const k = e.data?.kind;
    if (k?.type === 'shell_completed' && k.shellId != null) obs.end({ id: String(k.shellId), exit: k.exitCode ?? 0 });
  });

  // Copilot asks the human before a command runs: the board shows it as waiting for them
  on('permission.requested', (e) => {
    const id = e.data?.permissionRequest?.toolCallId;
    if (id) obs.approval({ id, waiting: true });
  });
  on('permission.completed', (e) => {
    if (e.data?.toolCallId) obs.approval({ id: e.data.toolCallId, waiting: false });
  });

  on('session.shutdown', () => obs.shutdown());
  return obs;
}

/**
 * Report what the agent does (working, idle, blocked on an approval) for backends that
 * cannot see its screen (docs/webui-design.md §4.3). `where()` gives {root, plan, actor}
 * now (a coordinator's plan can change: what `atf wait` armed), or null outside a plan.
 */
export function attachStatus(session, where) {
  let last = null,
    idleTimer = null,
    approvals = 0;
  const report = (status) => {
    const w = where();
    if (!w?.root || !w?.plan || !w?.actor) return;
    const key = `${w.root}#${w.plan}#${w.actor}`;
    if (last && last.key !== key) writeAgentStatus(last.root, last.plan, last.actor, null); // moved on to another plan
    last = { key, ...w };
    writeAgentStatus(w.root, w.plan, w.actor, status);
  };
  const on = (type, f) => {
    try {
      session.on(type, () => {
        try {
          f();
        } catch {}
      });
    } catch {}
  };
  const working = () => (clearTimeout(idleTimer), report(approvals > 0 ? 'blocked' : 'working'));
  on('assistant.turn_start', working);
  on('user.message', working);
  // session.idle fires more than once per idle: settle first
  on('session.idle', () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ((approvals = 0), report('idle')), 300);
  });
  on('permission.requested', () => (approvals++, report('blocked')));
  on('permission.completed', () => ((approvals = Math.max(0, approvals - 1)), report(approvals ? 'blocked' : 'working')));
  on('session.shutdown', () => last && writeAgentStatus(last.root, last.plan, last.actor, null));
}
