// What needs the human, as one line each (notifications, every frontend's toasts and
// browser notifications), and each item's identity: the same question, review or waiting
// agent keeps its key, so it is notified once. Items come from src/attention.mjs and carry
// their plan's state (`st`).

// derived from live agent state, not from an event: must hold a moment before it counts
export const LIVE_KINDS = new Set(['prompt', 'no-coordinator', 'coordinator', 'stale']);

/** An item's identity: the same question / review / waiting agent keeps its key. */
export const keyOf = (it) => [it.root, it.plan, it.kind, it.task ?? '', LIVE_KINDS.has(it.kind) ? (it.actor ?? '') : (it.ts ?? '')].join('|');

export const firstLine = (s, n = 140) => {
  const t = String(s ?? '').split('\n')[0].trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** One line: what the human is needed for. */
export function describe(it) {
  const t = it.task ? it.st.tasks[it.task] : null;
  const title = t ? ` (${firstLine(t.title, 60)})` : '';
  switch (it.kind) {
    case 'question':
      return `${it.task} asks: ${firstLine(it.message)}`;
    case 'your-review':
      return `${it.task} waits for your review${title}`;
    case 'your-task':
      return `a task for you: ${it.task} ${firstLine(t?.title, 80)}`;
    case 'review':
      return `${it.task} in review${title}`;
    case 'failed':
      return `${it.task} failed: ${firstLine(it.message)}`;
    case 'plan-question':
      return `plan question: ${firstLine(it.message)}`;
    case 'finished':
      return 'all tasks finished: close the plan';
    case 'no-coordinator':
      return 'no coordinator running: start one (board: s)';
    case 'coordinator':
      return `${it.actor} waits for you`;
    case 'prompt':
      return `${it.actor} waits for input${it.task ? ` on ${it.task}` : ''}`;
    case 'stale':
      return `${it.task}: ${firstLine(it.message)}`;
    default:
      return `${it.kind}${it.task ? ' ' + it.task : ''}`;
  }
}

/** What to say for newly appeared items: {title, body}. */
export function message(items) {
  if (items.length === 1) {
    const it = items[0];
    return { title: `ATF · ${it.st.title}`, body: describe(it) };
  }
  const plans = new Set(items.map((it) => it.st.title));
  return {
    title: `ATF · ${items.length} things need you${plans.size === 1 ? ` · ${[...plans][0]}` : ''}`,
    body: items.map((it) => (plans.size === 1 ? '' : `${it.st.title}: `) + describe(it)).join(' · '),
  };
}
