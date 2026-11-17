// ATF for opencode: the live view of what the agent runs (SPEC §14). An opencode plugin;
// atf-herdr loads it into the opencode agents it starts (OPENCODE_CONFIG_CONTENT), or add
// it to your opencode config: "plugin": ["file:///<repo>/adapters/opencode/atf.mjs"].
//
// It translates opencode's tool events to the shared observer (src/live-observer.mjs) and
// never changes a command or its output:
//   message.part.updated, tool "bash", running   → start, then output (metadata.output:
//                                                  the output so far)
//   … completed / error                          → end (metadata.exit; metadata.outputPath:
//                                                  the full output of a long run)
//   … tool "read" of a .log file                 → read
//   permission.asked / permission.replied        → approval: the command waits for the human
//   session.created with parentID                → a child session (a subagent): its
//                                                  commands count for the ATF name it uses
//                                                  in `atf … --as NAME`
// It does nothing outside an ATF plan (ATF_DIR, ATF_PLAN), and for a coordinator only its
// subagents' commands count (its own have no task).
import { createObserver } from '../../src/live-observer.mjs';

export const AtfLivePlugin = async (ctx = {}) => {
  if (!process.env.ATF_DIR || !process.env.ATF_PLAN) return {};
  const obs = createObserver({ actor: process.env.ATF_ROLE === 'coordinator' ? null : process.env.ATF_ACTOR || null });
  if (!obs) return {};
  const children = new Set(); // child sessions (subagents)
  const seen = new Set(); // tool calls already started
  const asked = new Map(); // permission request id -> tool call id
  const agentOf = (sessionID) => (children.has(sessionID) ? sessionID : null);
  const dir = ctx.directory || process.cwd();

  return {
    event: async ({ event }) => {
      try {
        const p = event?.properties ?? {};
        if ((event.type === 'session.created' || event.type === 'session.updated') && p.info?.parentID) children.add(p.info.id);
        // opencode asks the human before a command runs: the board shows it as waiting for them
        if (event.type === 'permission.asked' && p.tool?.callID) {
          asked.set(p.id, p.tool.callID);
          obs.approval({ id: p.tool.callID, waiting: true });
        }
        if (event.type === 'permission.replied' && asked.has(p.requestID)) {
          obs.approval({ id: asked.get(p.requestID), waiting: false });
          asked.delete(p.requestID);
        }
        if (event.type !== 'message.part.updated' || p.part?.type !== 'tool') return;
        const part = p.part;
        const st = part.state ?? {};
        const id = part.callID;
        const agent = agentOf(part.sessionID);
        if (part.tool === 'bash') {
          if (st.status === 'running') {
            if (!seen.has(id)) {
              seen.add(id);
              await obs.start({ id, cmd: st.input?.command, cwd: st.input?.workdir || dir, agent });
            }
            obs.output({ id, text: String(st.metadata?.output ?? '') });
          } else if ((st.status === 'completed' || st.status === 'error') && seen.has(id)) {
            seen.delete(id);
            const m = st.metadata ?? {};
            if (m.outputPath) obs.output({ id, file: m.outputPath }); // the full output of a long run
            const exit = typeof m.exit === 'number' ? m.exit : st.status === 'error' ? 1 : 0;
            // the observer's own clock: opencode's state.time does not span the command
            // (a 50 s build came out as 2 ms)
            obs.end({ id, exit, text: m.outputPath ? null : String(st.output ?? m.output ?? st.error ?? '') });
          }
        } else if (part.tool === 'read' && st.status === 'running' && !seen.has(id)) {
          seen.add(id);
          const file = st.input?.filePath ?? st.input?.path;
          if (file) obs.read({ file, agent, cwd: dir });
        }
      } catch {} // never disturb opencode
    },
  };
};

export default { id: 'atf.opencode', server: AtfLivePlugin };
