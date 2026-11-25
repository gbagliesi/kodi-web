// Picture zoom test: a film with black bars above and at the sides (windowboxed), on a phone in
// landscape. Pinch with two fingers, drag, double tap = fill without bars, controls untouched.
// Run: node tests/zoom.mjs   (needs playwright and ffmpeg)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8803;
const BASE = `http://127.0.0.1:${PORT}/`;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { console.log('ffmpeg non installato: test saltato'); process.exit(0); }

// 640×360 frame; the picture is 400×170 (2.35:1) in the middle, black all around
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'salotto-zoom-'));
const FILM = path.join(DIR, 'film.webm');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=400x170:rate=25', '-t', '20',
  '-vf', 'pad=640:360:120:95:black', '-c:v', 'libvpx', '-b:v', '600k', FILM]);

async function waitFor(fn, ms = 10000, what = '') {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timeout ' + what);
    await new Promise(r => setTimeout(r, 120));
  }
}

const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  await waitFor(() => fetch(BASE + 'proxy/health').then(r => r.ok).catch(() => false));
  const pixel = devices['Pixel 7'];
  const context = await browser.newContext({ ...pixel, viewport: { width: pixel.viewport.height, height: pixel.viewport.width }, serviceWorkers: 'block' });
  await context.route(/^https:\/\/(raw\.githubusercontent\.com|iptv-org\.github\.io|de1\.api\.radio-browser\.info|archive\.org)\//, r => r.fulfill({ status: 404, body: '' }));
  // served from the app's own origin, like the blob: pictures hls.js makes
  await context.route(BASE + 'test/film.webm', r => r.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(FILM) }));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForSelector('.hero');
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1 })) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function pinch(cx, cy, d0, d1, steps = 8) {
    await touch('touchStart', [[cx - d0 / 2, cy]]);
    await touch('touchStart', [[cx - d0 / 2, cy], [cx + d0 / 2, cy]]);
    for (let i = 1; i <= steps; i++) {
      const d = d0 + (d1 - d0) * i / steps;
      await touch('touchMove', [[cx - d / 2, cy], [cx + d / 2, cy]]);
      await sleep(16);
    }
    await touch('touchEnd', []);
  }
  async function tap(x, y) { await touch('touchStart', [[x, y]]); await sleep(30); await touch('touchEnd', []); }
  const scale = () => page.evaluate(() => { const t = getComputedStyle(document.getElementById('video')).transform; return t === 'none' ? 1 : new DOMMatrix(t).a; });
  const box = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(','); }, sel);
  const W = pixel.viewport.height, H = pixel.viewport.width;

  await page.evaluate(() => import('/js/player.js').then(p => p.play({ label: 'Film con le bande', type: 'video' }, { url: '/test/film.webm' })));
  await waitFor(() => page.evaluate(() => { const v = document.getElementById('video'); return v.videoWidth && v.currentTime > 0.3; }), 10000, 'playing');
  const bottomBefore = await box('.player-bottom'), topBefore = await box('.player-top');

  // pinch out: bigger, the controls don't move
  await pinch(W / 2, H / 2, 100, 220);
  const s1 = await scale();
  assert.ok(s1 > 1.8 && s1 < 2.4, 'pinch enlarges the picture about 2.2× (got ' + s1 + ')');
  assert.equal(await box('.player-bottom'), bottomBefore, 'bottom controls stay in place');
  assert.equal(await box('.player-top'), topBefore, 'top controls stay in place');
  assert.match(await page.textContent('.player-zoom'), /Zoom \d+%/);
  // the picture can't be dragged off the screen
  await touch('touchStart', [[W / 2, H / 2]]);
  await touch('touchMove', [[W / 2 + 2000, H / 2]]);
  await touch('touchEnd', []);
  const r = await page.evaluate(() => document.getElementById('video').getBoundingClientRect().toJSON());
  assert.ok(r.left <= 0.5 && r.right >= W - 0.5, 'dragged picture still covers the screen');
  // pinch back in below 1×: original size
  await pinch(W / 2, H / 2, 300, 80);
  assert.equal(await scale(), 1, 'pinching back returns to the original size');
  assert.equal(await page.evaluate(() => document.getElementById('player').classList.contains('zoomed')), false);

  // double tap: fill the screen without the bars. The picture (400×170 in 640×360) shown at
  // contain size, then enlarged until it touches the screen edges.
  const uiHidden = await page.evaluate(() => document.getElementById('player-ui').classList.contains('idle'));
  await tap(W / 2, H / 2); await sleep(80); await tap(W / 2, H / 2);
  await sleep(400);
  const k = Math.min(W / 640, H / 360), want = Math.min(W / (400 * k), H / (170 * k));
  const s2 = await scale();
  assert.ok(Math.abs(s2 - want) / want < 0.06, `double tap fills without the bars (got ${s2.toFixed(2)}, want ≈${want.toFixed(2)})`);
  assert.equal(await page.evaluate(() => document.getElementById('player-ui').classList.contains('idle')), uiHidden, 'double tap leaves the controls as they were');
  assert.match(await page.textContent('.player-zoom'), /Schermo pieno/);
  await page.screenshot({ path: path.join(DIR, 'filled.png') });
  // double tap again: back
  await sleep(400);
  await tap(W / 2, H / 2); await sleep(80); await tap(W / 2, H / 2);
  await sleep(350);
  assert.equal(await scale(), 1, 'second double tap: original size');

  // a single tap still shows/hides the controls
  const idle0 = await page.evaluate(() => document.getElementById('player-ui').classList.contains('idle'));
  await tap(W / 2, H / 2); await sleep(450);
  assert.notEqual(await page.evaluate(() => document.getElementById('player-ui').classList.contains('idle')), idle0, 'single tap toggles the controls');

  // the zoom lasts for this video only
  await pinch(W / 2, H / 2, 100, 220);
  assert.ok(await scale() > 1.5);
  await page.evaluate(() => import('/js/player.js').then(p => p.play({ label: 'Altro', type: 'video' }, { url: '/test/film.webm?2' })));
  assert.equal(await scale(), 1, 'a new video starts at the original size');
  await page.evaluate(() => import('/js/player.js').then(p => p.close()));

  assert.deepEqual(errors, []);
  console.log('zoom: ok (' + path.join(DIR, 'filled.png') + ')');
} finally {
  await browser.close();
  server.kill();
}
