// Agent definitions ("profiles") that `atf-herdr spawn --agent NAME` can run tasks with.
//
// ATF itself only stores the name (task.agent). This module resolves names to pi
// agent definitions, in the two formats used with pi:
//  - pi's subagent extension: Markdown with frontmatter (name, description, tools,
//    model) whose body is the system prompt, in ~/.pi/agent/agents/*.md and the
//    nearest project .pi/agents/*.md
//  - the pi-agent-handoff extension: agents.json ({agents: [{id, description, model,
//    tools, systemPrompt}]}) in ~/.pi/agent/agents.json, <project>/agents.json,
//    <project>/.pi/agents.json
// Later sources override earlier ones: user < project; json < markdown.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const piAgentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, '');
    fm[kv[1]] = v;
  }
  return { fm, body: m[2] };
}

const toolList = (t) => (Array.isArray(t) ? t : typeof t === 'string' ? t.split(',') : []).map((x) => String(x).trim()).filter(Boolean);

function fromMarkdownDir(dir, scope) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return out;
  }
  for (const f of entries) {
    try {
      const { fm, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (typeof fm.name !== 'string' || typeof fm.description !== 'string') continue;
      out.push({ name: fm.name, description: fm.description, model: typeof fm.model === 'string' ? fm.model : undefined, tools: toolList(fm.tools), systemPrompt: body.trim() || undefined, source: `${scope}:${path.join(dir, f)}` });
    } catch {}
  }
  return out;
}

function fromJson(file, scope) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (j.agents || [])
      .filter((a) => a && a.id && a.description)
      .map((a) => ({ name: a.id, description: a.description, model: a.model, tools: toolList(a.tools), systemPrompt: a.systemPrompt, source: `${scope}:${file}` }));
  } catch {
    return [];
  }
}

function nearestProjectDir(cwd, rel) {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const c = path.join(d, rel);
    if (fs.existsSync(c)) return c;
    if (path.dirname(d) === d) return null;
  }
}

/** All agent definitions visible from `cwd`, keyed by name (later sources win). */
export function discoverAgents(cwd = process.cwd()) {
  const map = new Map();
  const add = (list) => list.forEach((a) => map.set(a.name, a));
  add(fromJson(path.join(piAgentDir(), 'agents.json'), 'user'));
  add(fromMarkdownDir(path.join(piAgentDir(), 'agents'), 'user'));
  const projJson = [nearestProjectDir(cwd, path.join('.pi', 'agents.json')), nearestProjectDir(cwd, 'agents.json')].filter(Boolean);
  for (const f of projJson.reverse()) add(fromJson(f, 'project'));
  const projMd = nearestProjectDir(cwd, path.join('.pi', 'agents'));
  if (projMd) add(fromMarkdownDir(projMd, 'project'));
  return map;
}

export function resolveAgentDef(name, cwd) {
  return discoverAgents(cwd).get(name) || null;
}

/**
 * pi arguments for an agent definition: --model, --tools, --append-system-prompt.
 * ATF agents must be able to run `atf` (via bash), so bash is added to a tool
 * allowlist that lacks it; the definition's prompt still sets its boundaries.
 * The prompt is written to a file in `stateDir` (kept, so resumes can use it too).
 */
export function piArgsForAgent(def, stateDir) {
  const args = [];
  const notes = [];
  if (def.model) args.push('--model', def.model);
  if (def.tools?.length) {
    const tools = def.tools.includes('bash') ? def.tools : [...def.tools, 'bash'];
    if (tools !== def.tools) notes.push(`added "bash" to ${def.name}'s tools so it can run atf`);
    args.push('--tools', tools.join(','));
  }
  if (def.systemPrompt) {
    const dir = path.join(stateDir, 'agent-prompts');
    fs.mkdirSync(dir, { recursive: true });
    // one file per definition source: two projects may each define a different "reviewer"
    const tag = crypto.createHash('sha1').update(def.source || def.name).digest('hex').slice(0, 8);
    const file = path.join(dir, `${def.name.replace(/[^A-Za-z0-9_.-]/g, '_')}-${tag}.md`);
    fs.writeFileSync(file, def.systemPrompt, { mode: 0o600 });
    args.push('--append-system-prompt', file);
  }
  return { args, notes };
}
