// Regenerates the README screenshots by driving the real UI over CDP.
//
//   node docs/capture-screenshots.mjs [baseUrl] [outDir]
//
// Needs the app already running (./start.sh) against the fixture repos from
// `bash fixtures/make-sample-repo.sh` — it picks `ccd-sample-repo` itself, so
// whichever repo REPO_ROOT happened to name does not leak into the images.
//
// This exists because the screenshots went stale silently once already: the
// Primer dark theme and the breadcrumb header shipped while the README still
// showed a light Monaco and a `<select>` sidebar. Anything that changes the
// chrome should re-run this.
//
// Three things here are load-bearing, all for reasons CLAUDE.md spells out:
//
//  - snap Chromium needs `--no-sandbox` and a profile dir it can actually reach.
//    `~/.cache` is NOT one: it fails to create SingletonLock and aborts before
//    the debugger binds, which looks like "Chromium never came up". Hence the
//    mkdtemp under ~/snap/chromium/common/.
//  - peek can only be produced by a real Ctrl+click. `revealDefinition` is not
//    registered in this standalone Monaco build, so a test that drives an action
//    id passes vacuously. The `mouseMoved` before the press is what makes Monaco
//    resolve and underline the link.
//  - the word's position is found in the DOM rather than through the editor
//    instance, because the page does not expose one.
//
// Shot order matters: the palette is captured BEFORE the peek, so no peek widget
// is left sitting behind the modal, and the pointer is parked off the code before
// every capture so Monaco's hover tooltip does not photobomb it.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? import.meta.dirname;
const REPO_NAME = 'ccd-sample-repo';
const PORT = 9411;
const W = 1440, H = 620;

mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(join(homedir(), 'snap/chromium/common/ccd-shots-'));
const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--force-device-scale-factor=1', '--hide-scrollbars', '--no-first-run',
  '--disable-features=PaintHolding', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stderr.on('data', () => {});   // snap Chromium is noisy on stderr even when healthy

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = (await r.json()).filter((t) => t.type === 'page');
      if (pages[0]?.webSocketDebuggerUrl) return pages[0].webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chromium never exposed a CDP page target');
}

const ws = new WebSocket(await targetWs());   // Node 22 has a global WebSocket
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (!m.id || !pending.has(m.id)) return;
  const { resolve, reject } = pending.get(m.id);
  pending.delete(m.id);
  m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

/**
 * A poll that straddles a navigation rejects with "Inspected target navigated or
 * closed". That is normal and must be swallowed rather than treated as failure.
 */
async function evaluate(expression) {
  try {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    return r.result?.value;
  } catch (e) {
    if (/navigated or closed/i.test(e.message)) return undefined;
    throw e;
  }
}

async function waitFor(expr, what, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evaluate(`!!(${expr})`)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const parkPointer = () =>
  send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: H - 8, button: 'none' });

async function pressEscape() {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
  }
  await sleep(400);
}

async function shot(name) {
  await parkPointer();
  await sleep(800);   // let Monaco settle and any hover fade
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  console.log(`  wrote ${join(OUT, name)}`);
}

/** Clicks the nth breadcrumb chip: 0 = repo, 1 = branch, 2 = commit selection. */
const clickCrumb = (n) => evaluate(`document.querySelectorAll('.ccd-chip')[${n}]?.click()`);

/** Clicks the palette or browser row whose text contains `needle`. */
async function clickRow(selector, needle, what) {
  const outcome = await evaluate(`(() => {
    const rows = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const row = rows.find(r => r.textContent.includes(${JSON.stringify(needle)}));
    if (!row) return 'not found among: ' + rows.map(r => r.textContent.trim()).join(' | ');
    row.click();
    return 'ok';
  })()`);
  if (outcome !== 'ok') throw new Error(`${what}: ${outcome}`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: false,
});

console.log(`navigating to ${BASE} …`);
await send('Page.navigate', { url: BASE });
await waitFor(`document.querySelector('.ccd-chip')`, 'the header breadcrumb');

// Pick the fixture repo explicitly, so `shout` (declared in Utils.kt) is a
// guaranteed cross-file peek target regardless of how the backend was started.
console.log(`selecting ${REPO_NAME} …`);
await clickCrumb(0);
await waitFor(`document.querySelector('.ccd-browse-row')`, 'the repo picker');
await clickRow('.ccd-browse-row', REPO_NAME, `could not find ${REPO_NAME} in the browser`);
await evaluate(
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open')?.click()`,
);
await waitFor(`document.querySelector('.ccd-file-row')`, 'the changed-file tree');
await waitFor(`document.querySelectorAll('.view-line').length > 2`, 'the diff to render');

// Main.kt is what both of the next two shots want on screen.
await clickRow('.ccd-file-row', 'Main.kt', 'could not find Main.kt');
await waitFor(`document.querySelectorAll('.view-line').length > 2`, 'the Main.kt diff');
await sleep(1200);

console.log('shot: commit palette');
await clickCrumb(2);
await waitFor(`document.querySelector('.ccd-palette-row')`, 'the commit palette', 10_000);
await shot('screenshot-commit-palette.png');
await pressEscape();
if (await evaluate(`!!document.querySelector('.ccd-palette-row')`)) {
  throw new Error('the commit palette did not close on Escape');
}

console.log('shot: cross-file peek');
const box = await evaluate(`(() => {
  const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    const i = n.textContent.indexOf('shout');
    if (i < 0 || !n.parentElement?.closest('.view-line')) continue;
    const r = document.createRange();
    r.setStart(n, i); r.setEnd(n, i + 5);
    const b = r.getBoundingClientRect();
    if (b.width < 1) continue;
    return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  }
  return null;
})()`);
const pos = JSON.parse(box ?? 'null');
if (!pos) throw new Error('could not locate the word `shout` in the rendered diff');
console.log(`  ctrl+clicking shout at ${pos.x},${pos.y}`);
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', {
    type, x: pos.x, y: pos.y, button: 'left', clickCount: 1, modifiers: 2,
  });
  await sleep(type === 'mouseMoved' ? 900 : 120);   // the move is what resolves the link
}
await waitFor(`document.querySelector('.zone-widget')`, 'the peek widget', 20_000);
await shot('screenshot-peek.png');

// feature/wide exists for exactly this: 12 files over 5 directories so the tree
// shows a collapsed single-child chain, and a ~120-line file whose 2-line edit
// leaves collapsed unchanged regions on screen.
console.log('shot: wide branch');
await pressEscape();
await clickCrumb(1);
await waitFor(`document.querySelector('.ccd-palette-row')`, 'the branch palette', 10_000);
await clickRow('.ccd-palette-row', 'feature/wide', 'could not find feature/wide');
await waitFor(`document.querySelectorAll('.ccd-file-row').length > 5`, 'the wide file tree');
await sleep(1500);
await clickRow('.ccd-file-row', 'LongService.kt', 'could not find LongService.kt');
await waitFor(`document.querySelectorAll('.view-line').length > 10`, 'the long diff');
await sleep(1500);
await shot('screenshot-wide.png');

console.log('done');
ws.close();
chrome.kill('SIGTERM');
await sleep(500);
process.exit(0);
