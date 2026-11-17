// ATF live kind "gitlab": a GitLab pipeline the agent waits for, with its jobs per stage.
// A sample plugin (docs/live-plugins.md). Install: copy (or symlink) it to
// ~/.config/atf/live/gitlab.mjs, then `atf live-kinds` lists it.
//
// Where the data comes from:
//   1. the agent's own output (no GitLab access needed on the board's machine): the
//      pipeline's web_url / API URL, its status, and jobs if the command lists them
//      (GitLab API JSON, or `glab ci status`-like lines "(status) … name");
//   2. refresh(): the GitLab API, from the machine the board runs on:
//        GET <api>/projects/<project>/pipelines/<id>        the pipeline
//        GET <api>/projects/<project>/pipelines/<id>/jobs   its jobs (stage, status, duration)
//      <api> and <project> come from the URLs in the output. Authentication, the first
//      that applies:
//        GITLAB_TOKEN    a token with read_api (sent as PRIVATE-TOKEN), or the file
//                        ~/.config/atf/live/gitlab.token (the board may not run with your
//                        shell's environment)
//        glab            `glab api …` with glab's own login (`glab auth login`): no token
//                        to manage, if glab is installed where the board runs
//        neither         plain requests: only public projects answer
//        GITLAB_API_URL  e.g. https://gitlab.example.com/api/v4 (when the output has none)
//        GITLAB_PROJECT  project id or path (when the output has none)
//
// Adjust parse() to what your agents' commands print (try it on a saved output:
// `atf live-try gitlab.mjs output.txt --cmd '<the command>'`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/** `glab api <path>` against the API's host, with glab's login; null if glab is not there. */
function glabApi(api, rel) {
  return new Promise((resolve, reject) => {
    const host = new URL(api).host;
    execFile('glab', ['api', '--hostname', host, rel], { timeout: 8000, maxBuffer: 8 << 20 }, (err, out, errOut) => {
      if (err?.code === 'ENOENT') return resolve(null);
      if (err) return reject(new Error(`glab api: ${String(errOut || err.message).trim().split('\n')[0]}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('glab api: not JSON'));
      }
    });
  });
}

/** Jobs in pipeline order: by id (the API lists newest first; output may list them any way). */
const inOrder = (jobs) => (jobs.every((j) => j.id != null) ? [...jobs].sort((a, b) => a.id - b.id) : jobs);

/** The token: $GITLAB_TOKEN, else ~/.config/atf/live/gitlab.token (never logged or shown). */
function token() {
  if (process.env.GITLAB_TOKEN || process.env.GITLAB_PRIVATE_TOKEN) return process.env.GITLAB_TOKEN || process.env.GITLAB_PRIVATE_TOKEN;
  try {
    return fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'atf', 'live', 'gitlab.token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const TERMINAL = new Set(['success', 'failed', 'canceled', 'skipped']);
const ORDER = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'manual', 'scheduled', 'success', 'failed', 'canceled', 'skipped'];
const GLYPH = { success: ['✓', 'green'], failed: ['✗', 'red'], canceled: ['⊘', 'gray'], skipped: ['–', 'gray'], running: ['⚙', 'cyan'], pending: ['○', 'yellow'], created: ['○', 'gray'], manual: ['▶', 'magenta'], scheduled: ['◷', 'gray'], preparing: ['○', 'yellow'], waiting_for_resource: ['○', 'yellow'] };

/** Pipeline coordinates, status and jobs from the agent's output (and command). */
function parse(text, cmd = '') {
  const both = `${cmd}\n${text}`;
  const p = { api: process.env.GITLAB_API_URL || null, project: process.env.GITLAB_PROJECT || null, id: null, url: null, status: null, jobs: [] };
  // web_url: https://host/group/project/-/pipelines/123 (the best source: API base and project path)
  for (const m of both.matchAll(/(https?:\/\/[^/\s"'<>]+)\/([^\s"'<>]+?)\/-\/pipelines\/(\d+)/g)) {
    p.url = m[0];
    p.id = m[3];
    p.api ||= `${m[1]}/api/v4`;
    p.project ||= m[2];
  }
  // API URL: [https://]host/api/v4/projects/<id or path>/pipelines/<id>  (curl often omits the scheme)
  for (const m of both.matchAll(/(https?:\/\/)?([\w.-]+(?::\d+)?)\/api\/v4\/projects\/([^/\s"'?]+)\/pipelines?\/?(\d+)?/g)) {
    const host = m[2];
    p.api ||= `${m[1] || (/^(localhost|127\.)/.test(host) ? 'http://' : 'https://')}${host}/api/v4`;
    p.project ||= decodeURIComponent(m[3]);
    if (m[4]) p.id ||= m[4];
  }
  // the pipeline JSON the agent printed: {"id":123,"status":"running",…}
  for (const m of text.matchAll(/\{[^{}]*"id"\s*:\s*(\d+)[^{}]*"status"\s*:\s*"(\w+)"[^{}]*\}/g)) {
    if (/"stage"\s*:/.test(m[0])) continue; // a job, not the pipeline
    p.id = m[1];
    p.status = m[2];
  }
  // jobs as JSON (the jobs API) …
  for (const m of text.matchAll(/\{[^{}]*"stage"\s*:\s*"([^"]+)"[^{}]*\}/g)) {
    const o = m[0];
    const get = (k) => o.match(new RegExp(`"${k}"\\s*:\\s*"?([^",}]*)"?`))?.[1];
    const job = { id: Number(o.match(/"id"\s*:\s*(\d+)/)?.[1]) || null, name: get('name'), stage: m[1], status: get('status'), duration: Number(get('duration')) || null };
    if (job.name && job.status) p.jobs = [...p.jobs.filter((j) => j.name !== job.name), job];
  }
  // … or as glab-like lines: "(running) • 00m 12s   test   unit"  (adjust to your glab version)
  for (const m of text.matchAll(/^\s*\((\w+)\)\s*(?:•\s*)?(?:([\dhms ]+?)\s{2,})?(\S+)\s+(\S+)\s*$/gm)) {
    if (!ORDER.includes(m[1])) continue;
    p.jobs = [...p.jobs.filter((j) => j.name !== m[4]), { name: m[4], stage: m[3], status: m[1], duration: null }];
  }
  if (!p.status) p.status = text.match(/(?:Pipeline state|status)\s*[:=]\s*"?(\w+)/i)?.[1]?.toLowerCase() ?? null;
  return p;
}

const fmt = (s) => (s == null ? '' : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.round(s)}s`);

export default {
  kind: 'gitlab',
  description: 'GitLab pipeline: status, jobs per stage (agent output, or the GitLab API with GITLAB_TOKEN)',
  waiting: true, // the agent waits for it: ⧖ on the board
  priority: 10, // asked before the built-in "pipeline" kind

  // `glab ci …` / `glab pipeline …`, or the pipelines API (curl/wget/http; URLs are often quoted)
  match(cmd, { unquoted }) {
    return /(^|[\s;&|(/])glab\s+(ci|pipeline)\b/.test(unquoted) || (/\b(curl|wget|http)\b/.test(unquoted) && /\/api\/v4\/projects\/[^\s"']+\/pipelines?\b/.test(cmd));
  },

  // sync and fast: no network here (refresh() fetches, its result arrives as ctx.fetched)
  summarize(text, ctx) {
    const p = parse(text, ctx.cmd || '');
    const f = ctx.fetched; // {pipeline, jobs} from refresh(), when it ran
    const status = f?.pipeline?.status ?? p.status;
    const jobs = inOrder(f?.jobs?.length ? f.jobs : p.jobs).map((j) => ({ name: j.name, stage: j.stage, status: j.status, duration: j.duration ?? null, failure_reason: j.failure_reason ?? null, allow_failure: !!j.allow_failure }));
    const stages = [...new Set(jobs.map((j) => j.stage))];
    const done = jobs.filter((j) => TERMINAL.has(j.status)).length;
    const current = stages.find((s) => jobs.some((j) => j.stage === s && !TERMINAL.has(j.status)));
    const failed = jobs.filter((j) => j.status === 'failed' && !j.allow_failure);
    const state = !status ? 'waiting' : status === 'success' ? 'ok' : status === 'failed' || status === 'canceled' ? 'failed' : 'waiting';
    const line = [`pipeline${p.id ? ' #' + p.id : ''}${status ? ' ' + status : ''}`, jobs.length ? `${done}/${jobs.length} jobs` : '', current && state === 'waiting' ? current : '', failed.length ? `${failed.length} ✗` : ''].filter(Boolean).join(' · ');
    return {
      state,
      line,
      counts: { id: p.id, status, url: f?.pipeline?.web_url ?? p.url, jobs, stages, api: p.api, project: p.project },
      details: failed.map((j) => `✗ ${j.stage}/${j.name}${j.failure_reason ? ` (${j.failure_reason})` : ''}`),
    };
  },

  // the GitLab API, every refreshEvery ms while it runs; final: true stops it for a finished run
  refreshEvery: 10_000,
  async refresh(ctx) {
    const p = parse(ctx.text, ctx.cmd || '');
    if (!p.api || !p.project || !p.id) return ctx.previous; // nothing to ask yet
    const t = token();
    const headers = t ? { 'PRIVATE-TOKEN': t } : {};
    const api = p.api.replace(/\/$/, '');
    const rel = `projects/${encodeURIComponent(p.project)}/pipelines/${p.id}`;
    const fetchJson = async (r) => {
      const res = await fetch(`${api}/${r}`, { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`GitLab ${res.status} for ${api}/${r.replace(/\?.*/, '')}`);
      return res.json();
    };
    // a token if there is one, else glab's login, else a plain request (public projects)
    const get = async (r) => {
      if (t) return fetchJson(r);
      const viaGlab = await glabApi(api, r).catch(() => null); // not logged in to this host: a plain request
      return viaGlab ?? fetchJson(r);
    };
    const [pipeline, jobs] = await Promise.all([get(rel), get(`${rel}/jobs?per_page=100`)]);
    return { pipeline, jobs: inOrder(jobs), final: TERMINAL.has(pipeline.status) };
  },

  // board details and `atf live`: one line per stage (full: one per job)
  view(s, { width, full }) {
    const jobs = s.counts.jobs || [];
    if (!jobs.length) return s.details.map((d) => [[`  ${d}`, 'red']]);
    const L = [];
    const w = Math.max(...s.counts.stages.map((x) => x.length));
    for (const stage of s.counts.stages) {
      const js = jobs.filter((j) => j.stage === stage);
      const [g, c] = js.some((j) => j.status === 'failed' && !j.allow_failure) ? GLYPH.failed : js.every((j) => j.status === 'success' || j.status === 'skipped') ? GLYPH.success : js.some((j) => j.status === 'running') ? GLYPH.running : GLYPH.pending;
      if (full) {
        L.push([[`  ${g} `, c], [stage, 'bold']]);
        for (const j of js) {
          const [jg, jc] = GLYPH[j.status] || GLYPH.created;
          L.push([[`      ${jg} `, jc], [j.name.padEnd(24), j.status === 'failed' ? 'red' : ''], [j.status.padEnd(9), 'dim'], [fmt(j.duration), 'dim'], [j.failure_reason ? `  ${j.failure_reason}` : '', 'red']]);
        }
      } else {
        const segs = [[`  ${g} `, c], [stage.padEnd(w + 2), 'bold']];
        for (const j of js) {
          const [jg, jc] = GLYPH[j.status] || GLYPH.created;
          segs.push([`${jg} `, jc], [`${j.name}${j.duration ? ' ' + fmt(j.duration) : ''}  `, j.status === 'failed' ? 'red' : 'dim']);
        }
        L.push(segs);
      }
    }
    return L;
  },

  // L on the board: the pipeline page
  open: (s) => (s.counts.url ? { url: s.counts.url } : null),
};
