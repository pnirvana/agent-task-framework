// Changesets (SPEC §15): which files a task, a work package or a plan changed, and the
// combined diff of each, opened in the user's diff viewer.
//
// Two sources, chosen per project in .atf/config.toml `"changes"`:
//   "snapshots" (default) — when a leaf task starts and when it leaves in_progress, ATF
//     records the working tree of every git repository in the project as a commit
//     (`git add -A` into a temporary index, `git write-tree`, `git commit-tree`), kept by a
//     hidden ref refs/atf/<plan>/<task>/<start|end>. Nothing in the repo changes: not the
//     index, not HEAD, not a branch. A task's changes are its start snapshot against its
//     end snapshot (against the working tree while it runs). Tasks that overlap in time in
//     one repo share their windows; such a task is narrowed to the files it reported.
//   "artifacts" — only what agents record: file, commit and branch artifacts, diffed
//     against the commit before them (files: HEAD), to the working tree.
//
// A changeset is per repository: {repo, rel, base, target, live, files, tasks, overlap}.
// `target` null means the working tree; `live` is then a snapshot of it taken for the
// statistics (untracked new files included), and the read-only viewers use it.
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile } from './toml.mjs';
import { userConfigDir } from './config.mjs';

export const CHANGE_MODES = ['snapshots', 'artifacts'];
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const GIT_ENV = { GIT_AUTHOR_NAME: 'atf', GIT_AUTHOR_EMAIL: 'atf@localhost', GIT_COMMITTER_NAME: 'atf', GIT_COMMITTER_EMAIL: 'atf@localhost', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const SKIP = new Set(['node_modules', 'target', 'build', 'dist', 'vendor', '__pycache__']);

function gitSync(cwd, args, env) {
  try {
    return execFileSync('git', args, { cwd, env: env ?? { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 64 << 20 }).toString();
  } catch {
    return null;
  }
}
function gitAsync(cwd, args, env) {
  return new Promise((resolve) =>
    execFile('git', args, { cwd, env: env ?? { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 30_000, maxBuffer: 64 << 20 }, (err, stdout) => resolve(err ? null : String(stdout))),
  );
}

/** The project's change source: .atf/config.toml "changes", $ATF_CHANGES overrides. */
export function changeMode(cfg = {}) {
  const m = process.env.ATF_CHANGES || cfg.changes;
  return CHANGE_MODES.includes(m) ? m : 'snapshots';
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * The git repositories of a project: the one the project directory is in, and those
 * below it (three levels deep; hidden directories and build output skipped).
 */
const repoCache = new Map();
export function findRepos(projDir) {
  const hit = repoCache.get(projDir);
  if (hit && Date.now() - hit.at < 30_000) return hit.repos;
  const found = new Set();
  const top = gitSync(projDir, ['rev-parse', '--show-toplevel'])?.trim();
  if (top) found.add(real(top));
  const walk = (dir, depth) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const d = path.join(dir, e.name);
      if (fs.existsSync(path.join(d, '.git'))) found.add(real(d));
      if (depth < 3) walk(d, depth + 1);
    }
  };
  walk(projDir, 1);
  const repos = [...found].sort();
  repoCache.set(projDir, { at: Date.now(), repos });
  return repos;
}

/** A repo's path as recorded on events: relative to the project ('.': the project's own). */
const relRepo = (projDir, repo) => path.relative(real(projDir), repo) || '.';
const absRepo = (projDir, rel) => real(path.resolve(projDir, rel));

/**
 * Record the working tree of a repo as a commit (parent: HEAD), without touching the
 * index, HEAD or any branch. `ref` keeps it from git's garbage collection.
 */
async function snapshot(repo, { ref = null, message = 'atf snapshot' } = {}) {
  const run = gitAsync;
  const idx = (await run(repo, ['rev-parse', '--git-path', 'index']))?.trim();
  if (!idx) return null;
  const tmp = path.join(os.tmpdir(), `atf-index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const abs = path.resolve(repo, idx);
    if (fs.existsSync(abs)) fs.copyFileSync(abs, tmp); // the stat cache: only changed files are hashed
    const env = { ...process.env, ...GIT_ENV, GIT_INDEX_FILE: tmp };
    if ((await run(repo, ['add', '-A', '--', '.'], env)) === null) return null;
    const tree = (await run(repo, ['write-tree'], env))?.trim();
    if (!tree) return null;
    const head = (await run(repo, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() || null;
    const commit = (await run(repo, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], env))?.trim();
    if (!commit) return null;
    if (ref) await run(repo, ['update-ref', ref, commit]);
    return { commit, head };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Snapshot drafts for a transaction (called by store.transact under the plan lock): a
 * `task.snapshot` after each status draft by which a leaf task starts (the first time)
 * or leaves in_progress. Never fails a transaction: no git, no repo → no snapshot.
 */
export function snapshotDrafts({ root, planId, state, drafts, cfg }) {
  if (changeMode(cfg) !== 'snapshots' || !drafts.some((d) => d.type === 'task.status')) return drafts;
  const projDir = path.dirname(root);
  let repos = null;
  const status = new Map(); // status per task as the drafts change it
  const out = [];
  for (const d of drafts) {
    out.push(d);
    if (d.type !== 'task.status' || !d.task) continue;
    const t = state.tasks[d.task];
    if (!t || t.children?.length) continue;
    const from = status.get(t.id) ?? t.status;
    status.set(t.id, d.data?.status);
    const phase = d.data?.status === 'in_progress' && from !== 'in_progress' ? (t.snapshots?.start ? null : 'start') : from === 'in_progress' && d.data?.status !== 'in_progress' ? 'end' : null;
    if (!phase) continue;
    try {
      repos ??= findRepos(projDir);
      const recorded = [];
      for (const repo of repos) {
        const s = snapshotSync(repo, { ref: `refs/atf/${planId}/${t.id}/${phase}`, message: `atf ${planId} ${t.id} ${phase}` });
        if (s) recorded.push({ path: relRepo(projDir, repo), commit: s.commit, head: s.head });
      }
      if (recorded.length) out.push({ type: 'task.snapshot', task: t.id, data: { phase, repos: recorded } });
    } catch {}
  }
  return out;
}

/** snapshot(), synchronously (inside a transaction). */
function snapshotSync(repo, { ref, message }) {
  const idx = gitSync(repo, ['rev-parse', '--git-path', 'index'])?.trim();
  if (!idx) return null;
  const tmp = path.join(os.tmpdir(), `atf-index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const abs = path.resolve(repo, idx);
    if (fs.existsSync(abs)) fs.copyFileSync(abs, tmp);
    const env = { ...process.env, ...GIT_ENV, GIT_INDEX_FILE: tmp };
    if (gitSync(repo, ['add', '-A', '--', '.'], env) === null) return null;
    const tree = gitSync(repo, ['write-tree'], env)?.trim();
    if (!tree) return null;
    const head = gitSync(repo, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() || null;
    const commit = gitSync(repo, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], env)?.trim();
    if (!commit) return null;
    if (ref) gitSync(repo, ['update-ref', ref, commit]);
    return { commit, head };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- changesets ----------

/** Leaf tasks under `id` (itself when a leaf); all leaves of the plan for null. */
export function leavesOf(state, id = null) {
  const out = [];
  const visit = (tid) => {
    const t = state.tasks[tid];
    if (!t) return;
    if (t.children?.length) t.children.forEach(visit);
    else out.push(tid);
  };
  if (id) visit(id);
  else for (const tid of state.order) if (!state.tasks[tid].children?.length) out.push(tid);
  return out;
}

const LIVE_TTL = 3000;
const liveCache = new Map(); // repo -> {at, promise}
/** A snapshot of the working tree now (no ref; reused for a few seconds). */
function liveSnapshot(repo) {
  const hit = liveCache.get(repo);
  if (hit && Date.now() - hit.at < LIVE_TTL) return hit.promise;
  const promise = snapshot(repo, { message: 'atf working tree' }).then((s) => s?.commit ?? null);
  liveCache.set(repo, { at: Date.now(), promise });
  return promise;
}

/** Files of a diff with their status and line counts: [{path, status, added, removed}]. */
async function diffFiles(repo, base, target, files = null) {
  const spec = files ? ['--', ...files.map((f) => `:(literal)${f}`)] : [];
  if (files && !files.length) return [];
  const [names, nums] = await Promise.all([
    gitAsync(repo, ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', base, target, ...spec]),
    gitAsync(repo, ['diff', '--no-ext-diff', '--no-renames', '--numstat', '-z', base, target, ...spec]),
  ]);
  if (names === null) return [];
  const res = new Map();
  const n = names.split('\0');
  for (let i = 0; i + 1 < n.length; i += 2) if (n[i]) res.set(n[i + 1], { path: n[i + 1], status: n[i][0], added: 0, removed: 0 });
  for (const rec of (nums || '').split('\0')) {
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.+)$/s);
    const f = m && res.get(m[3]);
    if (f) Object.assign(f, m[1] === '-' ? { binary: true } : { added: Number(m[1]), removed: Number(m[2]) });
  }
  return [...res.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The repo (of `repos`) holding an absolute path, and the path inside it. */
function locate(repos, abs) {
  const p = real(path.dirname(abs)) + path.sep + path.basename(abs);
  const repo = repos.filter((r) => p === r || p.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
  return repo ? { repo, file: path.relative(repo, p) } : null;
}

const timeOf = (s) => (s?.ts ? Date.parse(s.ts) : 0);

/** One leaf task's changesets in snapshot mode. */
async function taskSnapshots(projDir, state, id, repos) {
  const t = state.tasks[id];
  const start = t.snapshots?.start;
  if (!start) return [];
  const end = t.status === 'in_progress' ? null : t.snapshots?.end ?? null;
  const reported = t.artifacts.filter((a) => a.kind === 'file' && !a.live).map((a) => locate(repos, path.resolve(projDir, a.ref))).filter(Boolean);
  const [from, to] = [timeOf(start), end ? timeOf(end) : Infinity];
  const sets = [];
  for (const s of start.repos || []) {
    const repo = absRepo(projDir, s.path);
    if (!fs.existsSync(repo)) continue;
    const e = end?.repos?.find((x) => x.path === s.path);
    const live = e ? null : await liveSnapshot(repo);
    const target = e?.commit ?? null;
    const files = await diffFiles(repo, s.commit, target ?? live);
    const mine = reported.filter((r) => r.repo === repo).map((r) => r.file);
    if (files.length) sets.push({ repo, rel: s.path, base: s.commit, target, live, files, tasks: [id], overlap: [], narrowed: false, mine, reported: reported.length > 0, at: { base: from, target: e ? to : null }, window: [from, to] });
  }
  return sets;
}

/**
 * Tasks that changed files in one repo at the same time: each one's window holds the
 * other's changes too. Mark them, and narrow a task that reported files to those (in a
 * repo where it reported none, it then has no changes).
 */
function markOverlaps(perTask) {
  const all = Object.values(perTask).flat();
  for (const s of all) {
    s.overlap = all.filter((o) => o.tasks[0] !== s.tasks[0] && o.repo === s.repo && o.window[0] < s.window[1] && o.window[1] > s.window[0]).map((o) => o.tasks[0]);
  }
  for (const [id, sets] of Object.entries(perTask)) {
    for (const s of sets)
      // an agent that reports files reports its files: in every repo, not only this one
      if (s.overlap.length && s.reported) {
        s.files = s.files.filter((f) => s.mine.includes(f.path));
        s.narrowed = true;
      }
    perTask[id] = sets.filter((s) => s.files.length);
    if (!perTask[id].length) delete perTask[id];
  }
}

/**
 * Where a reported file lives in git, recorded on the artifact when it is reported:
 * {path (absolute), repo, head (HEAD then; null in a repo without commits)}. In artifact
 * mode the file's change is read from that HEAD on, so it does not vanish once committed.
 * null outside git.
 */
export function fileOrigin(file) {
  const abs = path.resolve(file);
  const repo = gitSync(path.dirname(abs), ['rev-parse', '--show-toplevel'])?.trim();
  if (!repo) return null;
  return { path: abs, repo: real(repo), head: gitSync(repo, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() || null };
}

/** One leaf task's changesets in artifact mode. */
async function taskArtifacts(projDir, state, id, repos) {
  const t = state.tasks[id];
  const byRepo = new Map(); // repo -> {files:Set, commits:[]}
  const branches = [];
  const slot = (repo) => (byRepo.has(repo) ? byRepo.get(repo) : byRepo.set(repo, { files: new Set(), commits: [], heads: [] }).get(repo));
  for (const a of t.artifacts.filter((x) => !x.live && !x.cmd)) {
    if (a.kind === 'file') {
      // recorded where it was reported (the agent's directory); older events: the project's
      const l = locate(repos, a.git?.path ?? path.resolve(projDir, a.ref));
      if (!l) continue;
      const s = slot(l.repo);
      s.files.add(l.file);
      if (a.git && a.git.repo === l.repo) s.heads.push(a.git.head || EMPTY_TREE);
    } else if (a.kind === 'commit' || a.kind === 'branch') {
      for (const repo of repos) {
        const sha = (await gitAsync(repo, ['rev-parse', '--verify', '-q', `${a.ref}^{commit}`]))?.trim();
        if (!sha) continue;
        if (a.kind === 'commit') slot(repo).commits.push(sha);
        else branches.push({ repo, ref: a.ref, sha });
        break;
      }
    }
  }
  const sets = [];
  for (const [repo, s] of byRepo) {
    const files = new Set(s.files);
    const parents = [];
    for (const c of s.commits) {
      for (const f of ((await gitAsync(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', c])) || '').split('\0')) if (f) files.add(f);
      parents.push((await gitAsync(repo, ['rev-parse', '--verify', '-q', `${c}^`]))?.trim() || EMPTY_TREE);
    }
    // from the oldest point: the reported commits' parents and HEAD when files were
    // reported (gone after a rebase: skipped); with neither, the current HEAD
    for (const h of s.heads) if (h === EMPTY_TREE || (await gitAsync(repo, ['rev-parse', '--verify', '-q', `${h}^{commit}`]))) parents.push(h);
    let base = (await gitAsync(repo, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() || EMPTY_TREE;
    if (parents.length) base = parents.includes(EMPTY_TREE) ? EMPTY_TREE : (await gitAsync(repo, ['merge-base', '--octopus', ...new Set(parents)]))?.trim() || parents[0];
    const live = await liveSnapshot(repo);
    const list = await diffFiles(repo, base, live, [...files]);
    if (list.length) sets.push({ repo, rel: relRepo(projDir, repo), base, target: null, live, files: list, tasks: [id], overlap: [] });
  }
  for (const b of branches) {
    const main = await defaultBranch(b.repo);
    const base = (main && (await gitAsync(b.repo, ['merge-base', main, b.sha]))?.trim()) || `${b.sha}^`;
    const list = await diffFiles(b.repo, base, b.sha);
    if (list.length) sets.push({ repo: b.repo, rel: relRepo(projDir, b.repo), base, target: b.sha, branch: b.ref, live: null, files: list, tasks: [id], overlap: [] });
  }
  return sets;
}

async function defaultBranch(repo) {
  const origin = (await gitAsync(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  if (origin) return origin;
  for (const b of ['main', 'master']) if ((await gitAsync(repo, ['rev-parse', '--verify', '-q', b])) !== null) return b;
  return null;
}

/**
 * When a changeset's base / target was taken (for the earliest base and the latest
 * target of a combination): a snapshot's event time (ms), else the commit's time.
 */
async function timeAt(repo, s, end) {
  const at = s.at?.[end];
  if (at) return at;
  const c = s[end];
  if (!c || c === EMPTY_TREE) return 0;
  return (Number((await gitAsync(repo, ['show', '-s', '--format=%ct', c]))?.trim()) || 0) * 1000;
}

/**
 * Combine changesets of several tasks: per repo (and target kind), from the earliest
 * base to the latest target (the working tree while any of them is live), over the
 * union of their files.
 */
async function combine(sets) {
  const groups = new Map();
  for (const s of sets) {
    const k = `${s.repo}\0${s.branch ?? ''}`;
    groups.set(k, [...(groups.get(k) || []), s]);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    const repo = list[0].repo;
    let base = list[0].base;
    let bt = await timeAt(repo, list[0], 'base');
    for (const s of list.slice(1)) {
      const t = await timeAt(repo, s, 'base');
      if (s.base === EMPTY_TREE || t < bt) [base, bt] = [s.base, t];
    }
    const isLive = list.some((s) => !s.target);
    let target = null;
    if (!isLive) {
      let tt = -1;
      for (const s of list) {
        const t = await timeAt(repo, s, 'target');
        if (t > tt) [target, tt] = [s.target, t];
      }
    }
    const live = isLive ? list.find((s) => s.live)?.live ?? (await liveSnapshot(repo)) : null;
    const paths = [...new Set(list.flatMap((s) => s.files.map((f) => f.path)))];
    const files = await diffFiles(repo, base, target ?? live, paths);
    const tasks = [...new Set(list.flatMap((s) => s.tasks))];
    const overlap = [...new Set(list.flatMap((s) => s.overlap))].filter((o) => !tasks.includes(o));
    if (files.length) out.push({ repo, rel: list[0].rel, base, target, live, branch: list[0].branch, files, tasks, overlap, narrowed: list.some((s) => s.narrowed) });
  }
  return out;
}

/** Which task changed a file, per changeset (for the views): path -> [task ids]. */
function annotate(sets, perTask) {
  for (const s of sets) for (const f of s.files) f.tasks = Object.entries(perTask).filter(([, ts]) => ts.some((x) => x.repo === s.repo && x.files.some((g) => g.path === f.path))).map(([id]) => id);
  return sets;
}

/**
 * Changes of a plan: per leaf task, per parent task (its subtree combined) and for the
 * whole plan. {mode, tasks: {id: sets}, groups: {id: sets}, plan: sets}.
 */
export async function planChanges(projDir, state, { mode = 'snapshots' } = {}) {
  const repos = findRepos(projDir);
  const perTask = {};
  const leaves = leavesOf(state);
  await Promise.all(leaves.map(async (id) => (perTask[id] = mode === 'artifacts' ? await taskArtifacts(projDir, state, id, repos) : await taskSnapshots(projDir, state, id, repos))));
  for (const id of leaves) if (!perTask[id].length) delete perTask[id];
  if (mode === 'snapshots') markOverlaps(perTask);
  const groups = {};
  for (const id of state.order) {
    if (!state.tasks[id].children?.length) continue;
    const sets = leavesOf(state, id).flatMap((l) => perTask[l] || []);
    if (sets.length) groups[id] = annotate(await combine(sets), perTask);
  }
  const plan = annotate(await combine(Object.values(perTask).flat()), perTask);
  for (const [id, sets] of Object.entries(perTask)) annotate(sets, { [id]: sets });
  return { mode, repos, tasks: perTask, groups, plan };
}

/** The changesets of one level: a task (leaf or parent) or the plan (null). */
export function levelSets(changes, id = null) {
  if (!id) return changes.plan;
  return changes.tasks[id] || changes.groups[id] || [];
}

/** Totals of changesets: {files, added, removed}. */
export function totals(sets) {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const s of sets)
    for (const f of s.files) {
      files++;
      added += f.added || 0;
      removed += f.removed || 0;
    }
  return { files, added, removed };
}

/** Keep only one file (a path relative to the project) of changesets. */
export function onlyFile(sets, projDir, file) {
  const abs = real(path.resolve(projDir, file));
  return sets
    .map((s) => ({ ...s, files: s.files.filter((f) => path.join(s.repo, f.path) === abs) }))
    .filter((s) => s.files.length);
}

/** A file of a changeset, relative to the project. */
export const projectPath = (s, f) => (s.rel === '.' ? f.path : path.join(s.rel, f.path));

// ---------- viewers ----------

/**
 * The user's diff viewer: $ATF_DIFF_TOOL, else ~/.config/atf/config.toml `diff.tool`:
 * "git" (default: git diff in less), "diffview" (Neovim's diffview.nvim, one tab per
 * repo), "difftool" (git difftool --dir-diff), or a command template with {repo},
 * {base}, {target}, {range} and {files}, run once per repository.
 */
/** The user's own settings: ~/.config/atf/config.toml (or, before TOML, config.json). */
export function userConfig() {
  return readConfigFile(userConfigDir()).data;
}
export const diffTool = () => process.env.ATF_DIFF_TOOL || userConfig().diff?.tool || 'git';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The shell command that shows changesets in `tool`. */
export function viewerCommand(sets, tool = diffTool()) {
  if (!sets.length) return null;
  if (tool === 'diffview') {
    // diffview: -C<repo>, rev (vs the working tree, editable) or base..target, then the
    // paths. diffview lists untracked files only against the index, so when a live set has
    // new untracked files it compares with the snapshot of the working tree instead.
    const esc = (s) => String(s).replace(/([\\ |"])/g, '\\$1');
    const untracked = (s) => !!gitSync(s.repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...s.files.map((f) => `:(literal)${f.path}`)]);
    const range = (s) => (s.target ? `${s.base}..${s.target}` : s.live && untracked(s) ? `${s.base}..${s.live}` : s.base);
    const cmds = sets.map((s) => `DiffviewOpen -C${esc(s.repo)} ${range(s)} -- ${s.files.map((f) => esc(f.path)).join(' ')}`);
    return `nvim ${cmds.map((c) => `-c ${q(c)}`).join(' ')} -c ${q('silent! tabclose 1')}`;
  }
  if (tool === 'difftool') return sets.map((s) => `git -C ${q(s.repo)} difftool --dir-diff ${s.base} ${s.target ?? ''} -- ${s.files.map((f) => q(f.path)).join(' ')}`).join(' ; ');
  if (tool === 'git' || !tool.includes('{')) {
    // read-only: the working tree as snapshotted (new untracked files included)
    const parts = sets.map((s) => {
      const rev = `${s.base} ${s.target ?? s.live}`;
      const files = s.files.map((f) => q(f.path)).join(' ');
      const head = sets.length > 1 || s.rel !== '.' ? `printf '\\033[1m== %s\\033[0m\\n\\n' ${q(s.rel === '.' ? path.basename(s.repo) : s.rel)}; ` : '';
      return `${head}git -C ${q(s.repo)} --no-pager diff --stat ${rev} -- ${files}; echo; git -C ${q(s.repo)} --no-pager diff --color=always ${rev} -- ${files}; echo`;
    });
    return `{ ${parts.join(' ')} ; } | less -R`;
  }
  return sets
    .map((s) =>
      tool
        .replaceAll('{repo}', q(s.repo))
        .replaceAll('{base}', s.base)
        .replaceAll('{target}', s.target ?? '')
        .replaceAll('{range}', s.target ? `${s.base}..${s.target}` : s.base)
        .replaceAll('{files}', s.files.map((f) => q(f.path)).join(' ')),
    )
    .join(' ; ');
}

/** The combined patch of changesets (plain text). */
export async function patchText(sets, { color = false } = {}) {
  const parts = [];
  for (const s of sets) {
    const p = await gitAsync(s.repo, ['--no-pager', 'diff', '--no-ext-diff', `--color=${color ? 'always' : 'never'}`, ...(s.rel !== '.' ? [`--src-prefix=a/${s.rel}/`, `--dst-prefix=b/${s.rel}/`] : []), s.base, s.target ?? s.live, '--', ...s.files.map((f) => `:(literal)${f.path}`)]);
    if (p) parts.push(p);
  }
  return parts.join('');
}
