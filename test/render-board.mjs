// Test helper: run the herdr board off-screen and print each frame as plain text.
// node render-board.mjs <cols> <rows> '<keys as a JSON array>'  (env: ATF registry etc.)
const [W, H, keysJson = '[]'] = process.argv.slice(2);
let buf = '';
Object.defineProperty(process.stdout, 'columns', { value: +W });
Object.defineProperty(process.stdout, 'rows', { value: +H });
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => ((buf += s), true);
const { runBoard } = await import('../adapters/herdr/lib/tui.mjs');
runBoard({ root: null, initDir: process.cwd() });
const frame = () =>
  buf
    .split('\x1b[H')
    .pop()
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\r\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
await pause(300);
const frames = [frame()];
for (const k of JSON.parse(keysJson)) {
  process.stdin.emit('data', k);
  await pause(150);
  frames.push(frame());
}
write(JSON.stringify(frames));
process.exit(0);
