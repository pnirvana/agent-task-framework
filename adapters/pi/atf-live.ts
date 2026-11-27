// ATF live artifacts for pi (SPEC §14): observes the agent's shell commands, never wraps
// or changes them. The work is done by src/live-observer.mjs (shared with the Copilot and
// opencode adapters); this file translates pi's tool events:
//   tool_execution_start (bash)  → start: classify, list it as running on the board
//   tool_execution_update        → output: pi's snapshot, or its spill file for long output
//   tool_execution_end           → end: exit code from the result; record it on the task
//   tool_execution_start (read)  → read: a .log file read again and again is watched
// For an agent with ATF_DIR, ATF_PLAN, ATF_ACTOR and a task of its own in progress;
// otherwise it does nothing. The model sees nothing of this.
//
// atf-herdr loads it into every pi agent it starts; installed as a pi package, it loads
// with the ATF extension.
import path from "node:path";
import { createObserver } from "../../src/live-observer.mjs";
import { writeAgentStatus } from "../../src/live.mjs";

export default function (pi: any) {
	const g = globalThis as any;
	if (g.__atfLiveLoaded) return;
	const me = Symbol("atf-live");
	g.__atfLiveLoaded = me;

	const obs = process.env.ATF_ACTOR ? createObserver() : null;
	const textOf = (r: any): string => (r?.content || []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");

	pi.on("tool_execution_start", async (e: any, ctx: any) => {
		if (!obs) return;
		const cwd = ctx?.cwd || process.cwd();
		if (e.toolName === "bash") await obs.start({ id: e.toolCallId, cmd: e.args?.command, cwd });
		else if (e.toolName === "read" && e.args?.path) obs.read({ file: path.resolve(cwd, e.args.path), cwd });
	});

	pi.on("tool_execution_update", async (e: any) => {
		// pi sends the output so far (its tail); long output also goes to a spill file
		obs?.output({ id: e.toolCallId, text: textOf(e.partialResult), file: e.partialResult?.details?.fullOutputPath ?? null });
	});

	pi.on("tool_execution_end", async (e: any) => {
		if (!obs?.has(e.toolCallId)) return;
		const text = textOf(e.result);
		const exit = +(text.match(/Command exited with code (\d+)/)?.[1] ?? (e.isError ? 1 : 0));
		obs.end({ id: e.toolCallId, exit, durationMs: e.durationMs ?? null, text });
	});

	// what the agent does, for backends that cannot see its screen (sessions); a coordinator
	// reports through the ATF extension (its plan can change)
	const env = process.env;
	const status = (st: string | null) => {
		if (env.ATF_DIR && env.ATF_PLAN && env.ATF_ACTOR && env.ATF_ROLE !== "coordinator") writeAgentStatus(env.ATF_DIR, env.ATF_PLAN, env.ATF_ACTOR, st);
	};
	pi.on("agent_start", async () => status("working"));
	pi.on("agent_settled", async () => status("idle"));

	pi.on("session_shutdown", async () => {
		status(null);
		obs?.shutdown();
		if (g.__atfLiveLoaded === me) g.__atfLiveLoaded = undefined;
	});
}
