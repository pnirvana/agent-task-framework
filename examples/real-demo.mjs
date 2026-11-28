#!/usr/bin/env node
// A demo with a real coordinator and real agents (not simulated): a small Node project and
// a plan with a brief but no tasks. You start the plan's coordinator in the cockpit
// (atf-web: "Start coordinator"); it plans the work, splits it into tasks, starts agents
// on them, reviews what they hand in, and asks you when it has to.
//
//   node examples/real-demo.mjs [dir]       (default: ~/Dev/atf-real-demo; --fresh: start over)
//
// The agents are the kind set in ~/.config/atf/config.toml ([sessions] agent_kind: claude,
// copilot, pi, …): real models, real tokens. The work is small on purpose (a few minutes
// per task). What it exercises in the cockpit:
//   - the coordinator's terminal, and getting to it from anywhere (its chip, C)
//   - tasks appearing in Plans and In flight as the coordinator creates them, in parallel
//     (coupons and the receipt do not depend on each other; the command line does)
//   - a question for you: whether two coupons may be combined is left open on purpose
//   - a review for you: the receipt's layout is yours to approve
//   - agents' terminals, their steps and test runs, and their changes (git)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATF = path.join(REPO, 'bin', 'atf.mjs');
const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(os.homedir(), 'Dev', 'atf-real-demo'));
const TITLE = 'Coupons and receipts';

if (fresh && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
// not as whoever runs this (a herdr pane, an agent): the plan's actors belong to no terminal,
// else the cockpit takes its coordinator for one running elsewhere
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR_'))), ATF_DIR: '', ATF_PLAN: '', ATF_ACTOR: 'lead', ATF_ROLE: 'coordinator', ATF_BACKEND: '' };
const atf = (a, extra = {}) => JSON.parse(execFileSync(process.execPath, [ATF, ...a, '--json'], { cwd: dir, env: { ...env, ...extra }, maxBuffer: 64 << 20 }).toString());
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString();
const write = (rel, text) => (fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), text));

// ---------------------------------------------------------------- the project
if (!fs.existsSync(path.join(dir, '.git'))) {
  fs.mkdirSync(dir, { recursive: true });
  write('package.json', JSON.stringify({ name: 'tiny-shop', version: '0.1.0', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n');
  write(
    'src/cart.js',
    `// A shopping cart. Prices are in cents (integers), never floats.

/** A new, empty cart. */
export function createCart() {
  return { items: [] };
}

/** Add \`qty\` of an item (\`sku\`, \`name\`, \`price\` in cents); the same sku adds up. */
export function addItem(cart, { sku, name, price }, qty = 1) {
  if (!Number.isInteger(price) || price < 0) throw new Error(\`bad price for \${sku}: \${price}\`);
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(\`bad quantity for \${sku}: \${qty}\`);
  const line = cart.items.find((x) => x.sku === sku);
  if (line) line.qty += qty;
  else cart.items.push({ sku, name, price, qty });
  return cart;
}

/** The sum of the lines, in cents. */
export function subtotal(cart) {
  return cart.items.reduce((sum, x) => sum + x.price * x.qty, 0);
}

/** What the customer pays, in cents (no discounts yet). */
export function total(cart) {
  return subtotal(cart);
}
`,
  );
  write(
    'src/money.js',
    `/** Cents as a price: 1234 -> "12.34". */
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const n = Math.abs(cents);
  return \`\${sign}\${Math.floor(n / 100)}.\${String(n % 100).padStart(2, '0')}\`;
}
`,
  );
  write(
    'test/cart.test.js',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCart, addItem, subtotal, total } from '../src/cart.js';
import { formatCents } from '../src/money.js';

test('a cart adds up its lines', () => {
  const cart = createCart();
  addItem(cart, { sku: 'mug', name: 'Mug', price: 1250 }, 2);
  addItem(cart, { sku: 'tea', name: 'Green tea', price: 499 });
  addItem(cart, { sku: 'mug', name: 'Mug', price: 1250 });
  assert.equal(cart.items.length, 2);
  assert.equal(subtotal(cart), 4249);
  assert.equal(total(cart), 4249);
});

test('bad prices and quantities are refused', () => {
  assert.throws(() => addItem(createCart(), { sku: 'x', name: 'X', price: 9.99 }));
  assert.throws(() => addItem(createCart(), { sku: 'x', name: 'X', price: 100 }, 0));
});

test('cents print as prices', () => {
  assert.equal(formatCents(4249), '42.49');
  assert.equal(formatCents(5), '0.05');
});
`,
  );
  write('examples/cart.json', JSON.stringify({ items: [{ sku: 'mug', name: 'Mug', price: 1250, qty: 2 }, { sku: 'tea', name: 'Green tea', price: 499, qty: 1 }] }, null, 2) + '\n');
  write('README.md', '# tiny-shop\n\nA small shopping cart library. `npm test` runs the tests (Node 18+, no dependencies).\n');
  write('.gitignore', '.atf/\nnode_modules/\n');
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'tiny-shop: a cart');
}

// ---------------------------------------------------------------- the brief
write(
  'docs/brief.md',
  `# Coupons and receipts

tiny-shop is a small cart library (\`src/cart.js\`, prices in cents; \`npm test\`). Add:

1. **Coupons.** A coupon code applied to a cart changes its total:
   - \`SAVE10\`: 10% off the subtotal (rounded down to whole cents)
   - \`FIVEOFF\`: 5.00 off, never below 0
   - an unknown code is refused with a clear error
   Keep the codes in one place, so more can be added.
2. **Receipt.** \`formatReceipt(cart, { coupon })\` returns a plain-text receipt: one line
   per item (quantity, name, unit price, line total), then subtotal, the discount (with
   its code) if any, and the total, amounts aligned on the right. **The human reviews the
   receipt's layout before it is done.**
3. **Command line.** \`node bin/shop.js receipt <cart.json> [--coupon CODE]\` prints the
   receipt of a cart file (\`examples/cart.json\` is one); a test runs it.
4. **README.** A short section on coupons and the command line.

Coupons and the receipt do not depend on each other: they can be worked on at the same
time. The command line needs both; the README comes last.

**Open question, for the human:** may two coupons be combined on one cart (e.g. SAVE10 and
FIVEOFF), and if so in which order? Ask before building anything for it; until then, one
coupon per cart.

Every task: tests with \`node:test\` next to the existing ones, \`npm test\` green before
handing in. Small, focused changes; no dependencies.
`,
);

// ---------------------------------------------------------------- the plan
let root = path.join(dir, '.atf');
if (!fs.existsSync(path.join(root, 'plans'))) {
  root = atf(['init']).root;
  atf(['projects', 'add', dir]);
}
let plan = atf(['plan', 'list']).find((p) => p.title === TITLE && ['active', 'paused'].includes(p.status))?.id;
if (!plan) plan = atf(['plan', 'new', TITLE, '--coordinator', 'lead', '--goal', 'Coupons, a receipt and a command line for tiny-shop, as docs/brief.md says', '--doc', 'docs/brief.md']).plan;

// ---------------------------------------------------------------- what to do next
let kind = 'pi (the default)';
try {
  const cfg = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'atf', 'config.toml'), 'utf8');
  const m = cfg.match(/^\s*agent_kind\s*=\s*"([^"]+)"/m);
  if (m) kind = m[1];
} catch {}
console.log(`project  ${dir}
plan     ${plan} "${TITLE}" (no tasks yet: its coordinator plans them)
agents   ${kind}   ([sessions] agent_kind in ~/.config/atf/config.toml)

Next:
  1. atf-web                      (if it is not running; it prints the URL)
  2. In the cockpit, Needs you: "${TITLE}" › no coordinator runs this plan › Start coordinator
  3. Watch: the coordinator plans, starts agents; it will ask you about combining coupons,
     and the receipt's layout comes to you for review.

Real models, real tokens: a few small tasks. Start over with --fresh.`);
