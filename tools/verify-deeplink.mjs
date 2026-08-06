#!/usr/bin/env node
// verify-deeplink.mjs — the deep-link contract, checked in a real browser.
//
//   node tools/verify-deeplink.mjs [baseUrl]
//
// Needs the app running (./start.sh) and both fixture repos from
// `bash fixtures/make-sample-repo.sh`.
//
// There is no test runner here; this is the assertion. It exists because every
// claim below has a way of passing vacuously, and three of them did while this
// was being written:
//
//  - Testing a link against the SAME repository the backend booted with proves
//    nothing: the default would answer identically. Every read check names
//    ccd-sample-repo-2, which REPO_ROOT is not.
//  - Reading location.href straight after a navigate proves nothing either —
//    that is the URL the browser was handed, whether or not anything in the app
//    ever wrote it. The write check starts from a bare `/` and then makes a
//    second, in-app change.
//  - "It uses replaceState" is a claim about behaviour, so it is measured:
//    history.length before and after two selections.
//
// Waits are on `.ccd-card .monaco-diff-editor`, never `.ccd-card` or
// `.view-line`: a card exists for every changed file the moment the preview
// lands but is empty until its editor mounts, and cards mount lazily.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const PORT = 9414;
const W = 1400, H = 900;

// The repo the backend was NOT started with, so a passing read check cannot be
// the default repository answering.
const LINKED_REPO = join(homedir(), 'ccd-sample-repo-2');
const LINKED_REF = 'refs/heads/feature/scoped-defs';
const NO_SUCH_SHA = '0'.repeat(40);

const profile = mkdtempSync(join(homedir(), 'snap/chromium/common/ccd-deeplink-'));
const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--no-first-run', '--disable-features=PaintHolding', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stderr.on('data', () => {});   // snap Chromium is noisy even when healthy

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

let failures = 0;
function check(what, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const crumbs = () =>
  evaluate(`[...document.querySelectorAll('.ccd-chip')].map(c => c.textContent.trim())`);
const status = () => evaluate(`document.querySelector('.ccd-status')?.textContent ?? ''`);
const linkTo = (params) =>
  `${BASE}/?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const [head, second] = await twoCommitsOf(LINKED_REPO, LINKED_REF);

// --- 1. a link opens the review it names -----------------------------------
console.log('1. a link opens the repo, ref and commits it names');
await send('Page.navigate', { url: linkTo({ path: LINKED_REPO, ref: LINKED_REF, shas: `${head},${second}` }) });
await waitFor(`document.querySelector('.ccd-card .monaco-diff-editor')`, 'a mounted diff editor');

const opened = await crumbs();
check('opened the linked repository', opened[0]?.includes('ccd-sample-repo-2'), opened[0]);
check('opened the linked ref', opened[1]?.includes('feature/scoped-defs'), opened[1]);
// The crumb says "2 commits"; which two is only answerable here.
const selected = await evaluate(`window.__ccd.selectedShas`);
check('selected exactly the linked commits', String(selected) === String([head, second]), String(selected));

// --- 2. the address bar is written, and keeps being written ----------------
console.log('2. the address bar names the current review, live');
await send('Page.navigate', { url: BASE });   // bare '/', nothing to copy from
await waitFor(`document.querySelector('.ccd-card .monaco-diff-editor')`, 'a mounted diff editor');

const afterBoot = await evaluate(`location.href`);
const historyBefore = await evaluate(`history.length`);
check('boot filled an empty URL', /[?&]path=/.test(afterBoot ?? ''), afterBoot);

const bootShas = await evaluate(`window.__ccd.selectedShas`);
await evaluate(`document.querySelectorAll('.ccd-chip')[2]?.click()`);
await waitFor(`document.querySelector('.ccd-palette-row')`, 'the commit palette');
await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.ccd-palette-row')];
  rows[1]?.click();
  const apply = document.querySelector('.ccd-btn-primary');
  if (apply && document.querySelector('.ccd-palette-row')) apply.click();
})()`);
await waitFor(`String(window.__ccd.selectedShas) !== ${JSON.stringify(String(bootShas))}`, 'the new selection');
await waitFor(`document.querySelector('.ccd-card .monaco-diff-editor')`, 'the new preview');

const afterPick = await evaluate(`location.href`);
const historyAfter = await evaluate(`history.length`);
const picked = await evaluate(`window.__ccd.selectedShas`);
check('an in-app pick rewrites the URL', afterPick !== afterBoot && afterPick?.includes(picked[0]), afterPick);
// The number is the assertion: pushState would have grown this.
check('replaceState, not pushState', historyAfter === historyBefore, `history.length ${historyBefore} -> ${historyAfter}`);

// --- 3. a repository the backend refuses is reported, not swapped ----------
console.log('3. an unopenable link says so instead of opening something else');
await send('Page.navigate', { url: linkTo({ path: '/definitely/not/a/repo' }) });
await waitFor(`(document.querySelector('.ccd-status')?.textContent ?? '').length > 0`, 'a status message');

const refusal = await status();
check('names the failed path', refusal.includes('/definitely/not/a/repo'), refusal);
// Without this, a regression that quietly opened the default repo would pass
// every other assertion in this block.
const refusedCrumbs = await crumbs();
check('did NOT fall back to another repository', refusedCrumbs[0]?.includes('Choose repository'), refusedCrumbs[0]);

// --- 4. a well-formed but unknown sha takes the existing 404 path ----------
console.log('4. an unknown commit lands in the error handling that already existed');
await send('Page.navigate', { url: linkTo({ path: LINKED_REPO, ref: LINKED_REF, shas: NO_SUCH_SHA }) });
await waitFor(`(document.querySelector('.ccd-status')?.textContent ?? '').includes('Error')`, 'the preview error');
// Names the route and the code rather than matching "not found", which the HTTP
// status text supplies for free and would pass for any 404 anywhere.
const unknown = await status();
check('the 404 came from /api/preview', unknown.includes('/api/preview') && unknown.includes('404'), unknown);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
chrome.kill();
process.exit(failures === 0 ? 0 : 1);

/** The two newest commits of `ref`, straight from git — the link's raw material. */
async function twoCommitsOf(repoPath, ref) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(
    'git', ['log', '--format=%H', '-n', '2', '--end-of-options', ref, '--'], { cwd: repoPath },
  );
  const shas = stdout.split('\n').filter(Boolean);
  if (shas.length < 2) throw new Error(`${repoPath} ${ref} has fewer than two commits`);
  return shas;
}
