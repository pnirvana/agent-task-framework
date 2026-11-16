// A stand-in for two GitLab API endpoints, for trying the gitlab live plugin without
// GitLab: node examples/live-plugins/fake-gitlab.mjs   (http://localhost:8765)
//   curl -s -X POST localhost:8765/api/v4/projects/demo/pipeline   starts pipeline N (≈70 s)
//   curl -s localhost:8765/api/v4/projects/demo/pipelines/N        {"id","status","web_url"}
//   …/pipelines/N/jobs   its jobs (compile, lint, unit, integration, staging)
//   http://localhost:8765/demo/shop/-/pipelines/N   a page for humans
import http from 'node:http';
const PORT = 8765, RUN_MS = 70_000;
const pipes = new Map();
let next = 4711;
const status = (p) => (Date.now() - p.t0 < 8000 ? 'pending' : Date.now() - p.t0 < RUN_MS ? 'running' : 'success');
const json = (p) => ({ id: p.id, status: status(p), ref: 'main', web_url: `http://localhost:${PORT}/demo/shop/-/pipelines/${p.id}` });
// jobs: [stage, name, start s, end s] after the pipeline started (like GET …/pipelines/:id/jobs)
const JOBS = [['build', 'compile', 8, 20], ['build', 'lint', 8, 15], ['test', 'unit', 20, 45], ['test', 'integration', 20, 62], ['deploy', 'staging', 62, 69]];
const jobs = (p) => {
  const t = (Date.now() - p.t0) / 1000;
  return JOBS.map(([stage, name, a, b], i) => ({ id: p.id * 10 + i, name, stage, status: t < a ? (t < 8 ? 'created' : 'pending') : t < b ? 'running' : 'success', duration: t < a ? null : Math.round((Math.min(t, b) - a) * 10) / 10, allow_failure: false, web_url: `http://localhost:${PORT}/demo/shop/-/jobs/${p.id * 10 + i}` })).reverse();
};
http.createServer((req, res) => {
  let m;
  if (req.method === 'POST' && /\/api\/v4\/projects\/demo\/pipeline\/?$/.test(req.url)) {
    const p = { id: next++, t0: Date.now() };
    pipes.set(p.id, p);
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(json(p)) + '\n');
  }
  if ((m = req.url.match(/\/api\/v4\/projects\/demo(?:%2Fshop)?\/pipelines\/(\d+)\/jobs/)) && pipes.has(+m[1])) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(jobs(pipes.get(+m[1]))) + '\n');
  }
  if ((m = req.url.match(/\/api\/v4\/projects\/demo(?:%2Fshop)?\/pipelines\/(\d+)/)) && pipes.has(+m[1])) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(json(pipes.get(+m[1]))) + '\n');
  }
  if ((m = req.url.match(/\/-\/pipelines\/(\d+)/)) && pipes.has(+m[1])) {
    const p = pipes.get(+m[1]), s = status(p), pct = Math.min(100, Math.round(((Date.now() - p.t0) / RUN_MS) * 100));
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><meta http-equiv="refresh" content="3"><title>Pipeline #${p.id}</title><body style="font:16px system-ui;margin:40px"><h1>Pipeline #${p.id} <small style="color:${s === 'success' ? 'green' : '#c80'}">${s}</small></h1><p>demo stand-in for GitLab · ref main</p><p>build ✓ · test ${pct >= 60 ? '✓' : '…'} · deploy ${s === 'success' ? '✓' : '…'}</p><progress max=100 value=${pct} style="width:400px"></progress>`);
  }
  res.writeHead(404);
  res.end('not found\n');
}).listen(PORT, '127.0.0.1', () => console.log(`demo CI on http://localhost:${PORT}`));
