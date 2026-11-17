// The harness-independent part of the live hook (SPEC §14.3): what to do when an agent's
// shell command starts, prints and ends. Harness adapters (pi: adapters/pi/atf-live.ts,
// Copilot: adapters/copilot/atf-extension.mjs, opencode: adapters/opencode/atf.mjs)
// translate their own tool events into these calls; they never wrap or change a command.
//
// One observer per agent process. Commands are attributed to an ATF actor: the process's
// own ($ATF_ACTOR), or, for subagents running inside it (Copilot background subagents,
// opencode child sessions), the name learned for that subagent: from the harness
// (`name(agent, actor)`, e.g. Copilot's subagent display name) or from `--as NAME` in the
// atf commands it runs. A command of an unknown subagent, or of an actor without a task in
// progress, is ignored: nothing is misattributed.
import fs from 'node:fs';
import path from 'node:path';
import { loadPlan, transact, resolveActor } from './store.mjs';
import { classify, cwdOf, outputFiles, artifactKind, summarizeText, writeLiveState, runsDir, readTail, loadLiveKinds, liveKind } from './live.mjs';

const RECORD_AFTER_MS = 30_000; // ordinary commands that ran this long are recorded too
const SHOW_AFTER_MS = 4_000; // ordinary commands show on the board once they run this long

const safe = (f) => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

/**
 * @param {object} o
 * @param {string} o.root   .atf directory ($ATF_DIR)
 * @param {string} o.plan   plan id ($ATF_PLAN)
 * @param {string} [o.actor] the process's own actor ($ATF_ACTOR); null: only named subagents
 * @returns the observer, or null when there is no plan to report to
 */
export function createObserver({ root = process.env.ATF_DIR, plan = process.env.ATF_PLAN, actor = process.env.ATF_ACTOR || null } = {}) {
  if (!root || !plan) return null;
  const ready = loadLiveKinds().catch(() => null);
  const names = new Map(); // subagent key -> actor
  const runs = new Map(); // command id -> run
  const shells = new Map(); // harness shell id (a command moved to the background) -> command id
  const starting = new Map(); // command id -> its start, still being registered
  const published = new Set(); // actors with a live state file
  const registered = new Set(); // task|file registered as live
  const reads = new Map(); // file -> times read

  const actorOf = (agent) => (agent == null ? actor : names.get(agent) ?? null);
  const actorBlock = (id) => ({ ...resolveActor({ id }), id, ...(id !== process.env.ATF_ACTOR ? { role: 'subagent' } : {}) });

  /** The task an actor works on: its own leaf task in progress, the most recently started. */
  const currentTask = (who) =>
    safe(() => {
      const st = loadPlan(root, plan);
      const mine = Object.values(st.tasks).filter((t) => t.status === 'in_progress' && (t.assignee === who || t.owner === who) && !t.children?.length);
      mine.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
      for (const t of mine) for (const a of t.artifacts) if (a.live) registered.add(`${t.id}|${a.ref}`);
      return mine[0]?.id ?? null;
    }) ?? null;

  const publish = () => {
    const by = new Map();
    for (const r of runs.values()) if (r.shown) by.set(r.actor, [...(by.get(r.actor) || []), r]);
    for (const who of new Set([...published, ...by.keys()])) {
      const list = by.get(who) || [];
      writeLiveState(root, plan, who, { pid: process.pid, runs: list.map(({ id, task, kind, cmd, cwd, since, out, full, extra, approval }) => ({ id, task, kind, cmd, cwd, since, out: full || out, ...(extra ? { extra } : {}), ...(approval ? { approval: true } : {}) })) });
      if (list.length) published.add(who);
      else published.delete(who);
    }
  };

  const record = (who, task, data) => safe(() => transact(root, plan, actorBlock(who), (st) => (st.tasks[task] ? [{ type: 'task.artifact', task, data }] : [])));

  const registerLive = (who, task, file, kind, cmd, cwd, extra) => {
    const key = `${task}|${file}`;
    if (registered.has(key)) return;
    registered.add(key);
    record(who, task, { kind, ref: file, live: true, cmd, cwd, since: new Date().toISOString(), ...(extra ? { extra } : {}) });
  };

  /**
   * A file a command writes in the background: summarized as the kind of the command that
   * writes it (`nohup ./mvnw verify > b.log &`: maven; a plugin's kind for its commands;
   * build and wait commands: a log), with that kind's onStart (maven: the previous run's
   * test classes, for the total).
   */
  const registerOutput = (who, task, f, cmd, cwd) => {
    if (registered.has(`${task}|${f.file}`)) return;
    const k = classify(f.seg || cmd, cwd);
    const kind = k ? artifactKind(k) : 'log';
    const def = k ? liveKind(kind) : null;
    // runFile: a name under the plan's runs (a kind may write next to it), not the agent's file
    const runFile = path.join(runsDir(root, plan), `${task}-${Date.now()}-${kind}.log`);
    const extra = def?.onStart ? safe(() => (fs.mkdirSync(path.dirname(runFile), { recursive: true }), def.onStart({ root, plan, task, cwd, cmd: f.seg || cmd, runFile, file: f.file }))) || undefined : undefined;
    registerLive(who, task, f.file, kind, cmd, cwd, extra);
  };

  const watched = (who, file, how) => {
    const t = currentTask(who);
    if (!t) return;
    const n = (reads.get(file) ?? 0) + 1;
    reads.set(file, n);
    if (n >= 2 && fs.existsSync(file)) registerLive(who, t, file, 'log', how, path.dirname(file));
  };

  /** A subagent's actor name, from atf commands it runs with `--as NAME`. */
  const learn = (agent, cmd) => {
    if (agent == null) return;
    const m = String(cmd).match(/\batf\b[^\n;&|]*?\s--as[ =]([\w.@-]+)/);
    if (m) names.set(agent, m[1]);
  };

  const finish = (run, exit, ms, text) => {
    runs.delete(run.id);
    for (const [k, v] of shells) if (v === run.id) shells.delete(k);
    clearTimeout(run.timer);
    if (run.kind !== 'shell' || ms >= RECORD_AFTER_MS) {
      // keep the whole output: the harness's spill file, what streamed, or the result
      safe(() => {
        if (run.full && fs.existsSync(run.full)) fs.copyFileSync(run.full, run.out);
        else if (!fs.existsSync(run.out) || (text && text.length > fs.statSync(run.out).size)) fs.writeFileSync(run.out, text ?? '');
      });
      const def = liveKind(run.kind);
      const ctx = { cwd: run.cwd, cmd: run.cmd, exit, since: run.t0 - 1000, until: Date.now() + 1000, extra: run.extra || {} };
      const s = summarizeText(run.kind, readTail(run.out, 1 << 20) ?? text ?? '', ctx);
      record(run.actor, run.task, { kind: artifactKind(run.kind), ref: run.out, cmd: run.cmd, cwd: run.cwd, since: run.since, exit, duration_ms: ms, description: s.line, ...(run.extra ? { extra: run.extra } : {}) });
      if (def?.onEnd) safe(() => def.onEnd({ root, plan, task: run.task, cwd: run.cwd, cmd: run.cmd, runFile: run.out, exit, since: run.t0 - 1000, until: Date.now() + 1000, extra: run.extra || {} }));
    } else safe(() => fs.rmSync(run.out, { force: true }));
    publish();
  };

  const api = {
    ready,
    /** The harness knows a subagent's ATF name (e.g. Copilot's display name for it). */
    name(agent, who) {
      if (agent != null && who) names.set(agent, who);
    },
    /** The actor a command of `agent` belongs to (null: not attributable). */
    actorOf,
    /**
     * A shell command starts. `id`: the harness's call id; `cwd`: the agent's directory;
     * `agent`: a subagent key (null for the process's own agent).
     */
    async start({ id, cmd, cwd: base = process.cwd(), agent = null }) {
      await ready;
      cmd = String(cmd ?? '');
      learn(agent, cmd);
      const who = actorOf(agent);
      if (!who) return;
      const task = currentTask(who);
      if (!task) return;
      const cwd = cwdOf(cmd, base);
      const kind = classify(cmd, cwd);
      for (const f of outputFiles(cmd, base)) registerOutput(who, task, f, cmd, cwd);
      const m = cmd.match(/^\s*(?:tail|cat|less|head)\b[^|;&]*?\s([^\s|;&]+\.(?:log|out))\b/);
      if (m) watched(who, path.resolve(cwd, m[1]), cmd);
      const dir = runsDir(root, plan);
      safe(() => fs.mkdirSync(dir, { recursive: true }));
      const run = { id, actor: who, task, kind: kind ?? 'shell', cmd, cwd, since: new Date().toISOString(), t0: Date.now(), out: path.join(dir, `${task}-${Date.now()}-${kind ?? 'shell'}.log`), shown: !!kind };
      // the kind's onStart (maven: the previous run's test classes, before a `clean`)
      const def = kind ? liveKind(kind) : null;
      if (def?.onStart) run.extra = safe(() => def.onStart({ root, plan, task, cwd, cmd, runFile: run.out })) || undefined;
      runs.set(id, run);
      safe(() => fs.writeFileSync(run.out, ''));
      if (run.shown) publish();
      else {
        run.timer = setTimeout(() => {
          run.shown = true;
          publish();
        }, SHOW_AFTER_MS);
        run.timer.unref?.();
      }
    },
    /**
     * Output of a running command: `text` the whole output so far (`append: false`) or a new
     * chunk (`append: true`); `file`: the harness keeps the full output in this file.
     */
    output({ id, text = '', append = false, file = null }) {
      const run = runs.get(id) ?? runs.get(shells.get(id));
      if (!run) return;
      if (file && run.full !== file) {
        run.full = file; // the board reads the harness's file directly
        if (run.shown) publish();
      }
      if (run.full) return;
      safe(() => (append ? fs.appendFileSync(run.out, text) : fs.writeFileSync(run.out, text)));
    },
    /**
     * The command keeps running after its tool call returned (moved to the background):
     * later output and its end come under the harness's `shell` id.
     */
    detach({ id, shell }) {
      if (runs.has(id)) shells.set(String(shell), id);
    },
    /** The command ended. `text`: its output, if the harness has it in one piece. */
    end({ id, exit = 0, durationMs = null, text = null }) {
      const run = runs.get(id) ?? runs.get(shells.get(String(id)));
      if (!run) return;
      finish(run, exit ?? 0, durationMs ?? Date.now() - run.t0, text);
    },
    /**
     * The harness asks the human whether the command may run (`waiting: true`), or got the
     * answer (`false`). The board shows it as waiting for the human, not as running.
     */
    approval({ id, waiting = true }) {
      const run = runs.get(id);
      if (!run || !!run.approval === !!waiting) return;
      run.approval = !!waiting;
      if (waiting) run.shown = true;
      publish();
    },
    /** Whether a command (or background shell) is being observed. */
    has: (id) => runs.has(id) || shells.has(String(id)),
    /** The agent read a file: a log it reads again and again is one it watches. */
    read({ file, agent = null, cwd = process.cwd() }) {
      const who = actorOf(agent);
      if (who && /\.(log|out)$/.test(String(file))) watched(who, path.resolve(cwd, file), '');
    },
    /** The agent's process ends: nothing runs any more. */
    shutdown() {
      for (const r of runs.values()) clearTimeout(r.timer);
      runs.clear();
      publish();
    },
  };
  // A harness may report a command's output or end while its start is still being
  // registered (Copilot refuses a command at once): those wait for the start.
  const start = api.start;
  api.start = (x) => {
    const p = start(x).finally(() => starting.get(x.id) === p && starting.delete(x.id));
    starting.set(x.id, p);
    return p;
  };
  for (const m of ['output', 'detach', 'end', 'approval']) {
    const f = api[m];
    api[m] = (x) => (starting.has(x?.id) ? starting.get(x.id).then(() => f(x)) : f(x));
  }
  const has = api.has;
  api.has = (id) => starting.has(id) || has(id);
  return api;
}
