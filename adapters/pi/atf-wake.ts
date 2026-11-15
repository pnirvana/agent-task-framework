// ATF wake: lets a pi coordinator wait for its plan without blocking (SPEC §9.4).
//
// Without it, a coordinator loops on `atf wait`, which blocks inside a bash tool call: pi
// shows as working, herdr reports it as working, and the human cannot prompt it.
//
// With it, `atf wait` (it sees $ATF_WAKE) reports what needs the coordinator *now* and
// otherwise tells it to end its turn. When pi settles (idle), this extension runs
// `atf wait --new` in the background and, as soon as something new needs the coordinator,
// wakes it with the report (a custom message that triggers a turn). A prompt by the human
// cancels the background wait; it starts again when pi is idle again.
//
// Load it with `pi -e <this file>`, or install the repo as a pi package
// (`pi install git:github.com/pnirvana/agent-task-framework`). atf-herdr passes it to the
// coordinators it starts.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@earendil-works/pi-tui";

const ATF_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/atf.mjs");
const nodeBin = () => (/node(\.exe)?$/i.test(process.execPath) ? process.execPath : "node");

type Arm = { root: string; plan: string; actor: string; role?: string };

/** "T1 dispatch · T3 review": the items of an `atf wait` report, for a one-line display. */
function summarize(report: string): string {
	const items = report
		.split("\n")
		.map((l) => l.match(/^(T\d+|plan)\s+(\S+)/))
		.filter(Boolean)
		.map((m) => `${m![1]} ${m![2]}`);
	const uniq = [...new Set(items)];
	return uniq.length ? uniq.slice(0, 6).join(" · ") + (uniq.length > 6 ? ` · +${uniq.length - 6}` : "") : report.split("\n")[0].slice(0, 80);
}

export default function (pi: any) {
	// loaded twice (installed package and -e)? one instance is enough
	const g = globalThis as any;
	if (g.__atfWakeLoaded) return;
	g.__atfWakeLoaded = true;

	// `atf wait` writes the plan, actor and project it waits for here (the "arm" file)
	const armFile = process.env.ATF_WAKE || path.join(os.tmpdir(), `atf-wake-${process.pid}.json`);
	process.env.ATF_WAKE = armFile; // inherited by the bash tool (pi copies process.env per command)

	let child: ChildProcess | null = null;
	let idle = true;
	let ctxRef: any = null;

	const readArm = (): Arm | null => {
		try {
			const a = JSON.parse(fs.readFileSync(armFile, "utf8"));
			return a?.root && a?.plan && a?.actor ? a : null;
		} catch {
			return null;
		}
	};
	const status = (text?: string) => {
		try {
			ctxRef?.ui?.setStatus?.("atf-wake", text);
		} catch {}
	};
	const stop = () => {
		if (child) {
			child.removeAllListeners("close");
			child.kill("SIGTERM");
			child = null;
		}
		status(undefined);
	};
	const start = () => {
		if (child || !idle) return;
		const arm = readArm();
		if (!arm) return;
		const env = { ...process.env, ATF_DIR: arm.root, ATF_PLAN: arm.plan, ATF_ACTOR: arm.actor, ATF_ROLE: arm.role || "coordinator", NO_COLOR: "1" };
		delete (env as any).ATF_WAKE; // this one blocks
		let out = "";
		const c = spawn(nodeBin(), [ATF_CLI, "wait", "--new", "--plan", arm.plan], { env, stdio: ["ignore", "pipe", "pipe"] });
		child = c;
		c.stdout?.on("data", (d) => (out += d));
		c.stderr?.on("data", (d) => (out += d));
		c.on("error", () => {
			if (child === c) child = null;
		});
		c.on("close", (code) => {
			if (child !== c) return;
			child = null;
			status(undefined);
			const report = out.trim();
			if (code !== 0 || !report) {
				// e.g. the plan is gone: try again on the next idle, not in a tight loop
				return;
			}
			pi.sendMessage(
				{
					customType: "atf-wake",
					content: `[ATF] Something needs you in plan ${arm.plan}:\n\n${report}\n\nHandle it (atf skill, coordinator part). When you are done, run \`atf wait\`, then end your turn with your message for the human (what you did, what waits for them).`,
					display: true,
					details: { plan: arm.plan, summary: summarize(report) },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		});
		status(`atf: waiting on ${arm.plan}`);
	};

	// the wake-up is plumbing between ATF and the agent: one dim line in the transcript,
	// so the agent's own messages to the human stay what the human reads (expand: full report)
	pi.registerMessageRenderer?.("atf-wake", (message: any, options: any, theme: any) => {
		const head = theme.fg("dim", `⟳ atf: ${message.details?.summary ?? "woken"}`);
		return new Text(options?.expanded ? `${head}\n${theme.fg("dim", String(message.content))}` : head, options?.outputPad ?? 0, 0);
	});

	pi.on("session_start", async (_e: any, ctx: any) => {
		ctxRef = ctx;
		// a resumed coordinator session: pick up the plan it waited for before
		idle = true;
		setTimeout(start, 500);
	});
	pi.on("agent_start", async (_e: any, ctx: any) => {
		ctxRef = ctx;
		idle = false;
		stop(); // the agent works (the human prompted it, or it was woken): it reads the plan itself
	});
	pi.on("agent_settled", async (_e: any, ctx: any) => {
		ctxRef = ctx;
		idle = true;
		start();
	});
	pi.on("session_shutdown", async () => {
		stop();
		fs.rmSync(armFile, { force: true });
	});
}
