// ATF for pi: the coordinator's chat as the place to work with the human (SPEC §9, §13.6).
//
// 1. Wake. The coordinator does not block in `atf wait`: with $ATF_WAKE set, `atf wait`
//    reports what needs it now or tells it to end its turn. While pi is idle, this
//    extension runs `atf wait --new` in the background and wakes the agent with the report
//    (a custom message that triggers a turn). A prompt by the human cancels the background
//    wait; it starts again when pi is idle again.
// 2. What waits for the human, next to the chat: a widget above the input lists the
//    plan's requests for the human, one numbered line each. Typing a request's id at the
//    start of the input (`T5`, `t5:`) expands it in place ("peek-on-type"); alt+1…9 (or
//    `/atf [T5|plan]`) opens a read-only peek with its full brief, the diff and the files;
//    `/atf tasks` (or `t` there) the plan's task list, any task opens from it. None
//    of it is written to the transcript or the model's context; decisions go through the
//    chat (the coordinator records them with `--relay`).
//
// Load it with `pi -e <this file>`, or install the repo as a pi package
// (`pi install git:github.com/pnirvana/agent-task-framework`). atf-herdr passes it to the
// coordinators it starts.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Text, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { driverInbox, brief } from "../../src/core.mjs";
import { loadPlan, eventsPath } from "../../src/store.mjs";

const ATF_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/atf.mjs");
const NODE = "node"; // inside some harnesses process.execPath is the harness binary, not node

type Arm = { root: string; plan: string; actor: string; role?: string };
type Item = { n: number; id: string; task: string | null; kind: string; label: string; text: string };

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

/** The first sentence of an agent's message (they are asked to lead with one). */
function firstSentence(s: string | null | undefined, max = 110): string {
	const flat = String(s ?? "").replace(/\s+/g, " ").trim();
	const m = flat.match(/^.+?[.?!](?=\s|$)/);
	const one = m ? m[0] : flat;
	return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

const KIND_LABEL: Record<string, string> = { question: "question", "your-review": "review", review: "review", "plan-question": "question", finished: "finished", failed: "failed" };

export default function (pi: any) {
	// loaded twice (installed package and -e)? one instance is enough. Released on
	// session_shutdown: /reload loads the extensions again in the same process
	const g = globalThis as any;
	if (g.__atfPiLoaded) return;
	const me = Symbol("atf");
	g.__atfPiLoaded = me;

	// `atf wait` writes the plan, actor and project it waits for here (the "arm" file)
	const armFile = process.env.ATF_WAKE || path.join(os.tmpdir(), `atf-wake-${process.pid}.json`);
	process.env.ATF_WAKE = armFile; // inherited by the bash tool (pi copies process.env per command)
	// a launcher that starts the coordinator passes its plan in the environment: armed from the start
	const envArm: Arm | null =
		process.env.ATF_DIR && process.env.ATF_PLAN && process.env.ATF_ACTOR && process.env.ATF_ROLE === "coordinator"
			? { root: process.env.ATF_DIR, plan: process.env.ATF_PLAN, actor: process.env.ATF_ACTOR, role: "coordinator" }
			: null;
	const readArm = (): Arm | null => {
		try {
			const a = JSON.parse(fs.readFileSync(armFile, "utf8"));
			return a?.root && a?.plan && a?.actor ? a : envArm;
		} catch {
			return envArm;
		}
	};

	let ctxRef: any = null;
	const ui = () => ctxRef?.ui;
	const safe = (f: () => void) => {
		try {
			f();
		} catch {}
	};

	// ---------------------------------------------------------------- wake
	let child: ChildProcess | null = null;
	let idle = true;
	const status = (text?: string) => safe(() => ui()?.setStatus?.("atf", text));
	const stopWait = () => {
		if (child) {
			child.removeAllListeners("close");
			child.kill("SIGTERM");
			child = null;
		}
		status(undefined);
	};
	const startWait = () => {
		if (child || !idle) return;
		const arm = readArm();
		if (!arm) return;
		const env: any = { ...process.env, ATF_DIR: arm.root, ATF_PLAN: arm.plan, ATF_ACTOR: arm.actor, ATF_ROLE: arm.role || "coordinator", NO_COLOR: "1" };
		delete env.ATF_WAKE; // this one blocks
		let out = "";
		const c = spawn(NODE, [ATF_CLI, "wait", "--new", "--plan", arm.plan], { env, stdio: ["ignore", "pipe", "pipe"] });
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
			if (code !== 0 || !report) return; // e.g. the plan is gone: try again on the next idle
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

	// ---------------------------------------------------------------- what waits for the human
	let items: Item[] = [];
	let planState: any = null;
	let watched: string | null = null;
	let expanded: string | null = null; // peek-on-type: the id typed at the start of the input

	const refresh = () => {
		const arm = readArm();
		if (!arm) {
			items = [];
			planState = null;
			return render();
		}
		const file = eventsPath(arm.root, arm.plan);
		if (watched !== file) {
			if (watched) fs.unwatchFile(watched);
			watched = file;
			if (fs.existsSync(file)) fs.watchFile(file, { interval: 500 }, refresh);
		}
		try {
			planState = loadPlan(arm.root, arm.plan);
		} catch {
			planState = null;
		}
		const its = planState ? driverInbox(planState).filter((i: any) => i.for === "human") : [];
		// the plan's own requests (its questions, "finished") are one entry, `plan`: one reply
		// in the chat answers all open plan questions
		const planIts = its.filter((i: any) => !i.task);
		const qs = planIts.filter((i: any) => i.kind === "plan-question");
		const merged = its.filter((i: any, k: number) => i.task || k === its.indexOf(planIts[0]));
		items = merged.slice(0, 9).map((i: any, k: number) => {
			const head = i.task ? i : qs[0] ?? i;
			return {
				n: k + 1,
				id: i.task ?? "plan",
				task: i.task ?? null,
				kind: head.kind,
				label: KIND_LABEL[head.kind] ?? head.kind,
				text: firstSentence(head.message ?? (i.task ? planState.tasks[i.task]?.title : "")) + (!i.task && qs.length > 1 ? ` (+${qs.length - 1} more)` : ""),
			};
		});
		render();
	};

	/** A few lines of an item's brief, for peek-on-type (from the plan only: instant). */
	const expandLines = (it: Item, theme: any, width: number): string[] => {
		const b: any = planState ? brief(planState, it.task) : null;
		if (!b) return [];
		const out: string[] = [];
		const wrap = (s: string, style = (x: string) => x, prefix = "     ") =>
			wrapTextWithAnsi(String(s ?? "").replace(/\s+/g, " ").trim(), Math.max(20, width - prefix.length))
				.slice(0, 3)
				.map((l) => prefix + style(l));
		if (b.kind === "plan") for (const q of b.questions) out.push(...wrap(q.message));
		if (b.kind === "plan" && b.finished && !b.questions.length) out.push(...wrap("all tasks are finished; the plan can be closed"));
		if (b.question) {
			out.push(...wrap(b.question.message));
			if (b.question.recommend) out.push(...wrap(`recommended: ${b.question.recommend}`, (x) => theme.fg("success", x)));
			if (b.question.original) out.push(...wrap(`originally asked by ${b.question.original.actor}: ${firstSentence(b.question.original.message, 200)}`, (x) => theme.fg("dim", x)));
		}
		if (b.review) {
			if (b.review.submitted) out.push(...wrap(`${b.review.submitted.actor ?? "?"}: ${firstSentence(b.review.submitted.message, 240)}`));
			if (b.task?.acceptance?.length) out.push(...wrap(`acceptance: ${b.task.acceptance.join(" · ")}`, (x) => theme.fg("dim", x)));
			const files = (b.artifacts ?? []).filter((a: any) => a.kind === "file").map((a: any) => a.ref);
			if (files.length) out.push(...wrap(`files: ${[...new Set(files)].join(", ")}`, (x) => theme.fg("dim", x)));
		}
		if (b.failure) out.push(...wrap(b.failure.message ?? ""));
		out.push(theme.fg("dim", `     alt+${it.n} details · r there to reply`));
		return out;
	};

	const render = () =>
		safe(() => {
			const u = ui();
			if (!u?.setWidget) return;
			if (!items.length) return u.setWidget("atf", undefined);
			const title = planState?.title ?? "";
			u.setWidget("atf", (_tui: any, theme: any) => ({
				render(width: number): string[] {
					const lines = [theme.fg("warning", "⏳ for you") + theme.fg("dim", ` · ${title}`) + theme.fg("dim", `   alt+1…${items.length} details · type T5 to peek · /atf tasks`)];
					for (const it of items) {
						const id = it.id.padEnd(4);
						const head = `  ${theme.fg("dim", String(it.n))} ${theme.fg("accent", id)} ${theme.fg(it.kind === "your-review" ? "success" : "warning", it.label.padEnd(9))} `;
						lines.push(truncateToWidth(head + it.text, width));
						if (expanded && expanded.toLowerCase() === it.id.toLowerCase()) lines.push(...expandLines(it, theme, width).map((l) => truncateToWidth(l, width)));
					}
					return lines;
				},
				invalidate() {},
			}));
		});

	// peek-on-type: watch the input as the human types (observing only, never consuming keys)
	let typeTimer: any = null;
	const checkTyping = () => {
		let text = "";
		try {
			text = String(ui()?.getEditorText?.() ?? "");
		} catch {}
		const m = String(text).match(/^\s*(t\d+|plan)\b/i);
		const id = m && items.find((i) => i.id.toLowerCase() === m[1].toLowerCase()) ? m[1] : null;
		if (id?.toLowerCase() !== expanded?.toLowerCase()) {
			expanded = id;
			render();
		}
	};

	// ---------------------------------------------------------------- peek (read-only overlay)
	const runCli = (args: string[], arm: Arm): Promise<string> =>
		new Promise((resolve) =>
			execFile(NODE, [ATF_CLI, ...args, "--plan", arm.plan], { env: { ...process.env, ATF_DIR: arm.root, NO_COLOR: "1" }, maxBuffer: 8 << 20 }, (_e, stdout) => resolve(String(stdout ?? ""))),
		);
	const git = (cwd: string, args: string[]): Promise<{ code: number; out: string }> =>
		new Promise((resolve) =>
			execFile("git", ["-C", cwd, ...args], { maxBuffer: 16 << 20 }, (e: any, stdout) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(stdout ?? "") })),
		);

	/** The plan's tasks as a tree, in creation order: the rows of the task list (row 0: the plan). */
	const taskRows = (): { id: string; depth: number; t: any }[] => {
		if (!planState) return [];
		const ts = Object.values(planState.tasks) as any[];
		const num = (id: string) => Number(String(id).replace(/\D/g, "")) || 0;
		const out: { id: string; depth: number; t: any }[] = [{ id: "plan", depth: 0, t: null }];
		const walk = (parent: string | null, depth: number) => {
			for (const t of ts.filter((x) => (x.parent ?? null) === parent).sort((a, b) => num(a.id) - num(b.id))) {
				out.push({ id: t.id, depth, t });
				walk(t.id, depth + 1);
			}
		};
		walk(null, 0);
		return out;
	};
	const GLYPH: Record<string, [string, string]> = {
		todo: ["○", "dim"],
		in_progress: ["◐", "warning"],
		review: ["◎", "accent"],
		done: ["✓", "success"],
		blocked: ["⊘", "error"],
		failed: ["✗", "error"],
		cancelled: ["–", "dim"],
	};

	/**
	 * The read-only peek: a request's brief (its question or review), its diff and files, and
	 * the plan's task list. `/atf` opens the first request (the task list when none waits),
	 * `/atf T5` / `/atf plan` that one, `/atf tasks` the list. Nothing is written: `r` puts
	 * `T5: ` into the input, the human answers in the chat.
	 */
	const peek = async (ctx: any, startId?: string | null) => {
		ctxRef = ctx ?? ctxRef;
		const arm = readArm();
		refresh();
		if (!arm || !planState) return ui()?.notify?.("No ATF plan yet (the coordinator has not run `atf wait`).", "info");
		const want = String(startId ?? "").trim().toLowerCase();
		const taskId = (id: string) => Object.keys(planState.tasks).find((k) => k.toLowerCase() === id) ?? null;
		if (want && want !== "tasks" && want !== "plan" && !taskId(want)) return ui()?.notify?.(`No ${startId} in this plan (/atf tasks lists them).`, "warning");
		const projectDir = path.dirname(arm.root);
		const reply = await ui().custom(
			(tui: any, theme: any, keybindings: any, done: (r: string | null) => void) => {
				// view: the task list, or one entry (brief) with its diff / files
				let view: "list" | "brief" | "diff" | "file" = "brief";
				// where the brief was opened from: ←/→ go to the next request, or the next task
				let src: "requests" | "tasks" = "requests";
				let cur = "plan";
				let idx = 0; // in items
				let sel = 0; // in taskRows()
				let body: string[] = ["loading…"];
				let files: string[] = [];
				let fileIdx = 0;
				let scroll = 0;
				let cache: string[] | undefined;
				let cacheW = 0;
				const height = () => Math.max(8, Math.floor((process.stdout.rows || 30) * 0.8) - 2);
				const update = (lines: string[]) => {
					body = lines;
					scroll = 0;
					cache = undefined;
					tui.requestRender();
				};
				const showList = () => {
					view = "list";
					cache = undefined;
					tui.requestRender();
				};
				const loadBrief = async (id = cur) => {
					cur = id;
					view = "brief";
					update(["loading…"]);
					const raw = await runCli(["brief", id, "--json"], arm);
					let b: any = null;
					try {
						b = JSON.parse(raw);
					} catch {}
					if (!b) return update([raw || "no details"]);
					files = (b.files ?? []).filter((f: any) => !["missing", "dir"].includes(f.state)).map((f: any) => f.path);
					fileIdx = 0;
					update(briefLines(b, theme));
				};
				const loadDiff = async () => {
					view = "diff";
					if (!files.length) return update([theme.fg("dim", "no file artifacts on this task")]);
					update(["loading diff…"]);
					const out: string[] = [];
					for (const f of files) {
						const abs = path.resolve(projectDir, f);
						const cwd = path.dirname(abs);
						const tracked = (await git(cwd, ["ls-files", "--error-unmatch", abs])).code === 0;
						const d = tracked ? await git(cwd, ["diff", "HEAD", "--", abs]) : await git(projectDir, ["diff", "--no-index", "--", "/dev/null", f]);
						out.push(theme.fg("accent", `── ${f}${tracked ? "" : " (new)"}`));
						const text = d.out.trim() || (tracked ? "(no uncommitted changes; see the task's commits)" : safeRead(abs));
						out.push(...text.split("\n").map((l) => (l.startsWith("+") ? theme.fg("success", l) : l.startsWith("-") ? theme.fg("error", l) : l.startsWith("@@") ? theme.fg("accent", l) : l)));
					}
					update(out);
				};
				const loadFile = () => {
					view = "file";
					if (!files.length) return update([theme.fg("dim", "no file artifacts on this task")]);
					const f = files[fileIdx % files.length];
					update([theme.fg("accent", `── ${f}`) + theme.fg("dim", files.length > 1 ? `  (tab: next of ${files.length})` : ""), ...safeRead(path.resolve(projectDir, f)).split("\n")]);
				};
				const listLines = (rows: ReturnType<typeof taskRows>, inner: number): string[] =>
					rows.map((r, k) => {
						const mine = items.find((i) => i.id === r.id);
						const pointer = k === sel ? theme.fg("accent", "› ") : "  ";
						if (!r.t) {
							const n = rows.length - 1;
							const fin = rows.filter((x) => x.t && ["done", "cancelled"].includes(x.t.status)).length;
							return truncateToWidth(pointer + theme.fg("accent", "plan ") + (planState?.title ?? "") + theme.fg("dim", `  ${fin}/${n} finished`) + (mine ? theme.fg("warning", `  for you: ${mine.label}`) : ""), inner);
						}
						const t = r.t;
						const st = t.rollup_status ?? t.status; // a parent: the combined status of its subtasks
						const [g, color] = GLYPH[st] ?? ["?", "dim"];
						const kids = t.children?.length ? `${t.children.filter((c: string) => ["done", "cancelled"].includes(planState.tasks[c]?.status)).length}/${t.children.length}` : "";
						const meta = [t.owner ? `@${t.owner}` : "", st === "in_progress" && t.percent != null && !kids ? `${t.percent}%` : "", kids, t.ready && !t.owner ? "ready" : st.replace("_", " ")].filter(Boolean).join(" · ");
						const title = k === sel ? theme.bold?.(t.title) ?? t.title : t.title;
						return truncateToWidth(
							pointer + "  ".repeat(r.depth) + theme.fg(color, g) + " " + theme.fg("accent", t.id.padEnd(4)) + title + theme.fg("dim", `  ${meta}`) + (mine ? theme.fg("warning", `  for you: ${mine.label}`) : ""),
							inner,
						);
					});

				// start: the request asked for, a task, the list
				const rows0 = taskRows();
				const asItem = items.findIndex((i) => i.id.toLowerCase() === want);
				if (want === "tasks" || (!want && !items.length)) showList();
				else if (!want || asItem >= 0) {
					idx = Math.max(0, asItem);
					loadBrief(items[idx].id);
				} else {
					src = "tasks";
					sel = Math.max(0, rows0.findIndex((r) => r.id.toLowerCase() === want));
					loadBrief(rows0[sel].id);
				}

				return {
					render(width: number): string[] {
						if (cache && cacheW === width) return cache;
						const inner = width - 4;
						const h = height() - 3;
						const border = (s: string) => theme.fg("border", s);
						let title: string;
						let keys: string;
						let view_: string[];
						let more = "";
						if (view === "list") {
							const rows = taskRows();
							sel = Math.max(0, Math.min(sel, rows.length - 1));
							const all = listLines(rows, inner);
							scroll = Math.max(0, Math.min(Math.max(scroll, sel - h + 1), sel)); // keep the selection visible
							view_ = all.slice(scroll, scroll + h);
							if (all.length > h) more = `${scroll + 1}-${scroll + view_.length} of ${all.length}`;
							title = ` tasks · ${planState?.title ?? arm.plan} `;
							keys = `↑↓ select · ⏎ details · r reply${items.length ? " · w what waits for you" : ""} · esc close`;
						} else {
							const wrapped = body.flatMap((l) => (l === "" ? [""] : wrapTextWithAnsi(l, inner)));
							scroll = Math.max(0, Math.min(scroll, Math.max(0, wrapped.length - h)));
							view_ = wrapped.slice(scroll, scroll + h);
							if (wrapped.length > h) more = `${scroll + 1}-${scroll + view_.length} of ${wrapped.length}`;
							const it = items.find((i) => i.id === cur);
							const pos = src === "requests" && items.length > 1 ? ` (${idx + 1}/${items.length})` : "";
							title = ` ${cur}${it ? ` · ${it.label}` : cur === "plan" ? "" : ` · ${planState?.tasks[cur]?.title ?? ""}`}${pos} `;
							keys =
								view === "brief"
									? src === "requests"
										? `esc close · r reply${files.length ? " · d diff · o files" : ""} · ←/→ other requests · t all tasks · ↑↓ scroll`
										: `esc back · r reply${files.length ? " · d diff · o files" : ""} · ←/→ other tasks · ↑↓ scroll`
									: `esc/b back${view === "file" && files.length > 1 ? " · tab next file" : ""} · ↑↓ pgup/pgdn scroll`;
						}
						const lines = [border("┌─") + theme.fg("accent", title) + border("─".repeat(Math.max(0, width - 3 - title.length)) + "┐")];
						for (const l of view_) lines.push(border("│ ") + truncateToWidth(l, inner, "…", true) + border(" │"));
						if (more) lines.push(border("│ ") + truncateToWidth(theme.fg("dim", more), inner, "…", true) + border(" │"));
						lines.push(border("└ ") + truncateToWidth(theme.fg("dim", keys), width - 4, "…", true) + border(" ┘"));
						cache = lines;
						cacheW = width;
						return lines;
					},
					handleInput(data: string) {
						const h = height() - 3;
						const redraw = () => {
							cache = undefined;
							tui.requestRender();
						};
						if (view === "list") {
							const rows = taskRows();
							if (matchesKey(data, "escape") || data === "q") return done(null);
							if (matchesKey(data, "enter") || matchesKey(data, "right") || data === "l") {
								src = "tasks";
								return void loadBrief(rows[sel]?.id ?? "plan");
							}
							if (data === "r") return done(rows[sel]?.id ?? "plan");
							if (data === "w" && items.length) {
								src = "requests";
								idx = 0;
								return void loadBrief(items[0].id);
							}
							if (matchesKey(data, "down") || data === "j") sel = Math.min(rows.length - 1, sel + 1);
							else if (matchesKey(data, "up") || data === "k") sel = Math.max(0, sel - 1);
							else if (matchesKey(data, "pageDown") || data === " ") sel = Math.min(rows.length - 1, sel + h);
							else if (matchesKey(data, "pageUp")) sel = Math.max(0, sel - h);
							else return;
							return redraw();
						}
						if (matchesKey(data, "escape") || (view !== "brief" && data === "b")) {
							if (view !== "brief") return void loadBrief();
							if (src === "tasks") return showList();
							return done(null);
						}
						if (view === "brief" && data === "r") return done(cur);
						if (view === "brief" && data === "d") return void loadDiff();
						if (view === "brief" && data === "o") return void loadFile();
						if (view === "brief" && data === "t") {
							src = "tasks";
							sel = Math.max(0, taskRows().findIndex((r) => r.id === cur));
							scroll = 0;
							return showList();
						}
						if (view === "file" && matchesKey(data, "tab")) {
							fileIdx++;
							return loadFile();
						}
						if (view === "brief" && (matchesKey(data, "right") || matchesKey(data, "left"))) {
							const step = matchesKey(data, "right") ? 1 : -1;
							if (src === "requests") {
								if (!items.length) return;
								idx = (idx + step + items.length) % items.length;
								return void loadBrief(items[idx].id);
							}
							const rows = taskRows();
							sel = (sel + step + rows.length) % rows.length;
							return void loadBrief(rows[sel].id);
						}
						if (matchesKey(data, "down") || data === "j") scroll++;
						else if (matchesKey(data, "up") || data === "k") scroll--;
						else if (matchesKey(data, "pageDown") || data === " ") scroll += h;
						else if (matchesKey(data, "pageUp")) scroll -= h;
						else return;
						scroll = Math.max(0, scroll);
						redraw();
					},
					invalidate() {
						cache = undefined;
					},
				};
			},
			{ overlay: true, overlayOptions: { width: "85%", maxHeight: "85%", anchor: "center" } },
		);
		// r: answer it in the chat (the input keeps what was typed after the prefix)
		if (reply) {
			const cur = String(ui()?.getEditorText?.() ?? "").replace(/^\s*(t\d+|plan)\b:?\s*/i, "");
			ui()?.setEditorText?.(`${reply}: ${cur}`);
		}
	};

	const safeRead = (f: string) => {
		try {
			const s = fs.readFileSync(f, "utf8");
			return s.length > 200_000 ? s.slice(0, 200_000) + "\n… (truncated)" : s;
		} catch (e: any) {
			return `(cannot read: ${e?.message ?? e})`;
		}
	};

	function briefLines(b: any, theme: any): string[] {
		const L: string[] = [];
		const dim = (s: string) => theme.fg("dim", s);
		if (b.kind === "plan") {
			L.push(theme.bold?.(b.title) ?? b.title);
			if (b.goal) L.push(dim("goal: ") + b.goal);
			if (b.docs?.length) L.push(dim("documents: ") + b.docs.join(", "));
			for (const q of b.questions ?? []) L.push("", theme.fg("warning", "question for you") + dim(` (${q.actor ?? "?"})`), q.message);
			if (b.finished) L.push("", theme.fg("success", "finished") + ": all tasks are finished; the plan can be closed (tell the coordinator)");
			if (b.checkpoint) L.push("", dim("coordinator's checkpoint:"), b.checkpoint);
			return L;
		}
		const t = b.task;
		L.push((t.path?.length ? dim(t.path.join(" › ") + " › ") : "") + theme.fg("accent", `${t.id} ${t.title}`) + dim(`  ${t.status}${t.owner ? " · " + t.owner : ""}`));
		if (b.question) {
			L.push("", theme.fg("warning", "question") + dim(` asked by ${b.question.asked_by ?? "?"}`), b.question.message ?? "");
			if (b.question.recommend) L.push("", theme.fg("success", "recommended: ") + b.question.recommend);
			if (b.question.original) L.push("", dim(`originally asked by ${b.question.original.actor}:`), b.question.original.message ?? "");
		}
		if (b.review) {
			const r = b.review;
			if (r.submitted) L.push("", theme.fg("success", "submitted") + dim(` by ${r.submitted.actor ?? "?"}${r.round > 1 ? ` (round ${r.round})` : ""}`), r.submitted.message ?? "");
			for (const n of r.notes ?? []) L.push("", dim(`${n.kind}: `) + n.message);
			if (r.assessment) L.push("", theme.fg("success", "coordinator: ") + r.assessment);
		}
		if (b.failure) L.push("", theme.fg("error", "failed: ") + (b.failure.message ?? ""));
		// a task that asks nothing of the human (opened from the task list): where it stands
		if (b.latest) L.push("", dim(`latest${b.latest.percent != null ? ` (${b.latest.percent}%)` : ""}: `) + b.latest.message);
		if (b.checkpoint) L.push("", dim("checkpoint: ") + b.checkpoint.message);
		if (t.acceptance?.length) L.push("", dim("acceptance:"), ...t.acceptance.map((a: string) => `  - ${a}`));
		else if (t.description) L.push("", dim("goal: ") + t.description);
		if (b.files?.length)
			L.push("", dim("files: ") + b.files.map((f: any) => `${f.path}${f.added != null ? ` (+${f.added}${f.removed ? ` -${f.removed}` : ""}${f.state === "new" ? ", new" : ""})` : ` (${f.state})`}`).join("  "));
		const other = (b.artifacts ?? []).filter((a: any) => a.kind !== "file");
		if (other.length) L.push(dim("artifacts: ") + other.map((a: any) => `${a.kind}: ${a.ref}`).join("  "));
		return L;
	}

	for (let n = 1; n <= 9; n++)
		pi.registerShortcut?.(`alt+${n}`, {
			description: `ATF: details of the request #${n} waiting for you`,
			handler: async (ctx: any) => {
				if (items[n - 1]) await peek(ctx, items[n - 1].id);
			},
		});
	pi.registerCommand?.("atf", {
		description: "ATF: what waits for you (/atf T5 · /atf plan: one request · /atf tasks: all tasks of the plan)",
		handler: async (args: string, ctx: any) => peek(ctx, (args || "").trim() || null),
	});

	// autocomplete: `T` at the start of the input suggests the requests waiting for the human
	const addAutocomplete = (u: any) =>
		safe(() =>
			u?.addAutocompleteProvider?.((current: any) => ({
				triggerCharacters: ["T", "p"],
				async getSuggestions(lines: string[], line: number, col: number, options: any) {
					const before = (lines[line] ?? "").slice(0, col);
					const m = line === 0 && before.match(/^(T\d*|t\d+|pl?a?n?)$/);
					if (!m || !items.length) return current.getSuggestions(lines, line, col, options);
					const hits = items.filter((i) => i.id.toLowerCase().startsWith(m[1].toLowerCase()));
					if (!hits.length) return current.getSuggestions(lines, line, col, options);
					return { prefix: m[1], items: hits.map((i) => ({ value: `${i.id}: `, label: `${i.id} ${i.label}`, description: i.text })) };
				},
				applyCompletion(lines: string[], line: number, col: number, item: any, prefix: string) {
					return current.applyCompletion(lines, line, col, item, prefix);
				},
				shouldTriggerFileCompletion(lines: string[], line: number, col: number) {
					return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
				},
			})),
		);

	// ---------------------------------------------------------------- lifecycle
	let unInput: (() => void) | null = null;
	let tick: any = null;
	pi.on("session_start", async (_e: any, ctx: any) => {
		ctxRef = ctx;
		idle = true;
		if (ctx?.hasUI !== false) {
			unInput?.();
			unInput =
				ctx.ui?.onTerminalInput?.(() => {
					clearTimeout(typeTimer);
					typeTimer = setTimeout(checkTyping, 60); // after the editor applied the key
					return undefined; // never consume
				}) ?? null;
			addAutocomplete(ctx.ui);
		}
		refresh();
		clearInterval(tick);
		tick = setInterval(refresh, 5000); // arm changes (a plan chosen later), relative times
		tick.unref?.();
		setTimeout(startWait, 500);
	});
	pi.on("agent_start", async (_e: any, ctx: any) => {
		ctxRef = ctx;
		idle = false;
		stopWait(); // the agent works (the human prompted it, or it was woken): it reads the plan itself
		if (expanded) {
			expanded = null; // the message was sent
			render();
		}
	});
	pi.on("agent_settled", async (_e: any, ctx: any) => {
		ctxRef = ctx;
		idle = true;
		refresh();
		startWait();
	});
	pi.on("session_shutdown", async (e: any) => {
		stopWait();
		unInput?.();
		clearInterval(tick);
		if (watched) fs.unwatchFile(watched);
		watched = null;
		if (g.__atfPiLoaded === me) g.__atfPiLoaded = undefined;
		// a reload keeps the coordinator's plan (the reloaded extension reads the same arm file)
		if (e?.reason !== "reload") fs.rmSync(armFile, { force: true });
	});
}
