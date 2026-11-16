// ATF live kind template: copy to ~/.config/atf/live/<kind>.mjs and adapt.
// Guide: docs/live-plugins.md. Try it: atf live-try <this file> <saved output> --cmd '<command>'
//
// This example recognizes `./deploy.sh <env>`, counts the steps it printed, and treats the
// agent as waiting until it prints DONE or FAILED.

export default {
  // the name: lowercase, digits, dashes. The same name as a built-in replaces it.
  kind: 'deploy',
  description: 'deploy script: steps done, waiting until DONE/FAILED',

  // true: the agent waits on something outside (⧖ on the board), false: it works (⚙)
  waiting: true,

  // asked before kinds with a lower priority (built-ins come last)
  priority: 0,

  // Does this shell command belong to the kind? Called for every command the agent runs:
  // keep it a cheap regex. `unquoted` has quoted strings removed (so `echo "./deploy.sh"`
  // does not match); use `cmd` for things that are usually quoted, like URLs.
  match(cmd, { unquoted }) {
    return /(^|[\s;&|(])\.\/deploy\.sh\b/.test(unquoted);
  },

  // The output so far (or of a finished run) → what the board shows. Sync, fast, no network,
  // no files outside ctx (it runs every second while the board shows it).
  summarize(text, ctx) {
    const steps = [...text.matchAll(/^step (\d+): (.+)$/gm)].map((m) => ({ n: +m[1], what: m[2] }));
    const failed = /\bFAILED\b/.test(text);
    const done = /\bDONE\b/.test(text);
    return {
      // running | waiting | ok | failed | unknown (a finished run's exit code overrides it)
      state: failed ? 'failed' : done ? 'ok' : 'waiting',
      // one short line, most important first: the board's row badge and details show it
      line: `deploy${ctx.cmd?.match(/deploy\.sh\s+(\S+)/)?.[1] ? ' ' + ctx.cmd.match(/deploy\.sh\s+(\S+)/)[1] : ''} · ${steps.length} steps${failed ? ' · FAILED' : ''}`,
      // anything your view() or open() needs
      counts: { steps },
      // lines worth acting on (failures); shown when the kind has no view()
      details: failed ? text.split('\n').filter((l) => /FAILED|ERROR/.test(l)).slice(0, 5) : [],
    };
  },

  // Optional: the detailed view (board details, `atf live`). Lines of [text, style] segments;
  // styles: '', bold, dim, red, green, yellow, cyan, magenta, gray, 'bold red', …
  view(s, { width, full }) {
    const steps = full ? s.counts.steps : s.counts.steps.slice(-4);
    return steps.map((st) => [['  ✓ ', 'green'], [`step ${st.n} `, 'bold'], [st.what.slice(0, width - 12), 'dim']]);
  },

  // Optional: what L on the board opens: { url } (browser) or { file } (followed in a tab)
  // open: (s, ctx) => ({ url: 'https://deploy.example.com/status' }),

  // Optional: data from elsewhere (an API), fetched by the board, at most every refreshEvery
  // ms; the result arrives in summarize as ctx.fetched. Return { …, final: true } once
  // nothing will change any more.
  // refreshEvery: 15_000,
  // async refresh(ctx) { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return await r.json(); },

  // Optional, in the agent's harness: when a matching command starts / ends. onStart's
  // return value is kept with the run and passed to every function as ctx.extra.
  // onStart({ root, plan, task, cwd, cmd, runFile }) { return { startedAt: Date.now() }; },
  // onEnd({ root, plan, task, cwd, cmd, runFile, exit, since, until, extra }) {},
};
