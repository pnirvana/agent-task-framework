// ATF live artifacts for pi (SPEC §14): observes the agent's shell commands, never wraps
// or changes them. For an agent working on an ATF task (ATF_DIR, ATF_PLAN, ATF_ACTOR in
// its environment, a task of its own in progress):
//   - while a command runs, it is listed in `<plan>/live/<actor>.json` with its kind
//     (maven, tests, pipeline, wait, build) and its output so far: the board shows what
//     the agent runs or waits for;
//   - when a build, test run or pipeline watch ends (or any command that ran 30s or more),
//     its output is kept and recorded on the task as an artifact with exit code and
//     summary;
//   - a file the command writes in the background (`… > build.log &`, `| tee x.log`), or
//     a log file the agent keeps reading, is registered as a live artifact.
// The model sees nothing of this: its commands and their output are unchanged.
//
// atf-herdr loads it into every pi agent it starts; installed as a pi package, it loads
// with the ATF extension. Without an ATF task it does nothing.
import fs from "node:fs";
import path from "node:path";
import { loadPlan, transact, resolveActor } from "../../src/store.mjs";
import { classify, cwdOf, outputFiles, artifactKind, summarizeText, writeLiveState, runsDir, readTail, loadLiveKinds, liveKind } from "../../src/live.mjs";

const RECORD_AFTER_MS = 30_000; // ordinary commands that ran this long are recorded too
const SHOW_AFTER_MS = 4_000; // ordinary commands show on the board once they run this long

type Run = { id: string; task: string; kind: string; cmd: string; cwd: string; since: string; out: string; t0: number; full?: string; shown: boolean; timer?: any; extra?: any };

export default function (pi: any) {
	const g = globalThis as any;
	if (g.__atfLiveLoaded) return;
	const me = Symbol("atf-live");
	g.__atfLiveLoaded = me;

	const root = process.env.ATF_DIR;
	const plan = process.env.ATF_PLAN;
	const actorId = process.env.ATF_ACTOR;
	const active = !!(root && plan && actorId);
	const runs = new Map<string, Run>();
	// live kinds from plugins (~/.config/atf/live, $ATF_LIVE_PLUGINS): docs/live-plugins.md
	const ready = active ? loadLiveKinds().catch(() => null) : Promise.resolve(null);
	const registered = new Set<string>(); // task|file already registered as live
	const reads = new Map<string, number>(); // log file -> times the agent read it

	const safe = <T>(f: () => T): T | undefined => {
		try {
			return f();
		} catch {
			return undefined;
		}
	};
	const actor = () => ({ ...resolveActor({ id: actorId }), id: actorId! });

	/** The task the agent works on: its own task in progress, the most recently started. */
	const currentTask = (): string | null =>
		safe(() => {
			const st = loadPlan(root!, plan!);
			const mine = Object.values<any>(st.tasks).filter((t) => t.status === "in_progress" && (t.assignee === actorId || t.owner === actorId) && !(t.children?.length));
			mine.sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")));
			for (const t of mine) for (const a of t.artifacts) if (a.live) registered.add(`${t.id}|${a.ref}`);
			return mine[0]?.id ?? null;
		}) ?? null;

	const publish = () =>
		writeLiveState(root!, plan!, actorId!, {
			pid: process.pid,
			runs: [...runs.values()].filter((r) => r.shown).map(({ id, task, kind, cmd, cwd, since, out, full, extra }) => ({ id, task, kind, cmd, cwd, since, out: full || out, ...(extra ? { extra } : {}) })),
		});

	const record = (task: string, data: any) =>
		safe(() => transact(root!, plan!, actor(), (st: any) => (st.tasks[task] ? [{ type: "task.artifact", task, data }] : [])));

	const registerLive = (task: string, file: string, kind: string, cmd: string, cwd: string) => {
		const key = `${task}|${file}`;
		if (registered.has(key)) return;
		registered.add(key);
		record(task, { kind, ref: file, live: true, cmd, cwd, since: new Date().toISOString() });
	};

	const textOf = (r: any): string => (r?.content || []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");

	pi.on("tool_execution_start", async (e: any, ctx: any) => {
		if (!active || e.toolName !== "bash") {
			// reading a log file again and again: the agent watches it
			if (active && e.toolName === "read" && /\.(log|out)$/.test(String(e.args?.path ?? ""))) watched(path.resolve(ctx?.cwd || process.cwd(), e.args.path), "");
			return;
		}
		await ready;
		const cmd = String(e.args?.command ?? "");
		const base = ctx?.cwd || process.cwd();
		const task = currentTask();
		if (!task) return;
		const cwd = cwdOf(cmd, base);
		const kind = classify(cmd, cwd);
		for (const f of outputFiles(cmd, base)) registerLive(task, f.file, kind === "maven" || kind === "tests" ? kind : "log", cmd, cwd);
		const m = cmd.match(/^\s*(?:tail|cat|less|head)\b[^|;&]*?\s([^\s|;&]+\.(?:log|out))\b/);
		if (m) watched(path.resolve(cwd, m[1]), cmd);
		const dir = runsDir(root!, plan!);
		safe(() => fs.mkdirSync(dir, { recursive: true }));
		const run: Run = { id: e.toolCallId, task, kind: kind ?? "shell", cmd, cwd, since: new Date().toISOString(), t0: Date.now(), out: path.join(dir, `${task}-${Date.now()}-${kind ?? "shell"}.log`), shown: !!kind };
		// the kind's onStart (maven: the previous run's test classes, before a `clean`)
		const def: any = kind ? liveKind(kind) : null;
		if (def?.onStart) run.extra = safe(() => def.onStart({ root, plan, task, cwd, cmd, runFile: run.out })) || undefined;
		runs.set(e.toolCallId, run);
		if (run.shown) publish();
		else
			run.timer = setTimeout(() => {
				run.shown = true;
				publish();
			}, SHOW_AFTER_MS);
		run.timer?.unref?.();

		function watched(file: string, how: string) {
			const t = currentTask();
			if (!t) return;
			const n = (reads.get(file) ?? 0) + 1;
			reads.set(file, n);
			if (n >= 2 && fs.existsSync(file)) registerLive(t, file, "log", how, path.dirname(file));
		}
	});

	pi.on("tool_execution_update", async (e: any) => {
		const run = runs.get(e.toolCallId);
		if (!run) return;
		const full = e.partialResult?.details?.fullOutputPath;
		if (full && run.full !== full) {
			run.full = full; // pi spills long output to a file: the board reads it directly
			if (run.shown) publish();
		}
		if (!run.full) safe(() => fs.writeFileSync(run.out, textOf(e.partialResult)));
	});

	pi.on("tool_execution_end", async (e: any) => {
		const run = runs.get(e.toolCallId);
		if (!run) return;
		runs.delete(e.toolCallId);
		clearTimeout(run.timer);
		const ms = e.durationMs ?? Date.now() - run.t0;
		const text = textOf(e.result);
		const exit = +(text.match(/Command exited with code (\d+)/)?.[1] ?? (e.isError ? 1 : 0));
		if (run.kind !== "shell" || ms >= RECORD_AFTER_MS) {
			// keep the whole output: pi's spill file when it had one, else what it returned
			safe(() => (run.full && fs.existsSync(run.full) ? fs.copyFileSync(run.full, run.out) : fs.writeFileSync(run.out, text)));
			const kind = artifactKind(run.kind);
			const def: any = liveKind(run.kind);
			const s = summarizeText(run.kind, readTail(run.out, 1 << 20) ?? text, { cwd: run.cwd, cmd: run.cmd, exit, since: run.t0 - 1000, until: Date.now() + 1000, extra: run.extra || {} });
			record(run.task, { kind, ref: run.out, cmd: run.cmd, cwd: run.cwd, since: run.since, exit, duration_ms: ms, description: s.line, ...(run.extra ? { extra: run.extra } : {}) });
			if (def?.onEnd) safe(() => def.onEnd({ root, plan, task: run.task, cwd: run.cwd, cmd: run.cmd, runFile: run.out, exit, since: run.t0 - 1000, until: Date.now() + 1000, extra: run.extra || {} }));
		} else safe(() => fs.rmSync(run.out, { force: true }));
		publish();
	});

	pi.on("session_shutdown", async () => {
		for (const r of runs.values()) clearTimeout(r.timer);
		runs.clear();
		if (active) publish();
		if (g.__atfLiveLoaded === me) g.__atfLiveLoaded = undefined;
	});
}
