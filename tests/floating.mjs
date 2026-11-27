// Detached windows («Stacca»): two videos at once over the app, the sound on one only, drag,
// swap back into the big player, radio as a small bar; one on a phone; none on the Fire TV.
// Run: node tests/floating.mjs   (needs playwright and ffmpeg)
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
const PORT = 8807;
const BASE = `http://127.0.0.1:${PORT}/`;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { console.log('ffmpeg non installato: test saltato'); process.exit(0); }
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'salotto-fw-'));
const A = path.join(DIR, 'a.webm'), B = path.join(DIR, 'b.webm'), R = path.join(DIR, 'r.webm');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '30', '-c:v', 'libvpx', '-c:a', 'libvorbis', '-shortest', A]);
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=f=660', '-t', '30', '-c:v', 'libvpx', '-c:a', 'libvorbis', '-shortest', B]);
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300', '-t', '30', '-c:a', 'libvorbis', R]);

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
async function newPage(opts) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...opts });
  await context.route(/^https:\/\/(raw\.githubusercontent\.com|iptv-org\.github\.io|de1\.api\.radio-browser\.info|archive\.org)\//, r => r.fulfill({ status: 404, body: '' }));
  for (const [n, f] of [['a', A], ['b', B], ['r', R]]) await context.route(BASE + 'test/' + n + '.webm', r => r.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(f) }));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForSelector('.hero');
  return { context, page };
}
const play = (page, n, label, type = 'video') => page.evaluate(([n, l, t]) => import('/js/player.js').then(p => p.play({ label: l, type: t }, { url: '/test/' + n + '.webm', mime: t === 'audio' ? 'audio/webm' : undefined })), [n, label, type]);
const playing = (page) => waitFor(() => page.evaluate(() => { const v = document.getElementById('video'); return v.currentTime > 0.3; }), 10000, 'main playing');
const wins = (page) => page.evaluate(() => [...document.querySelectorAll('.fw')].map(w => ({ title: w.querySelector('.fw-title').textContent, muted: w.querySelector('video').muted, t: w.querySelector('video').currentTime, paused: w.querySelector('video').paused, audio: w.classList.contains('fw-audio'), rect: w.getBoundingClientRect().toJSON() })));

try {
  await waitFor(() => fetch(BASE + 'proxy/health').then(r => r.ok).catch(() => false));

  // ---- desktop
  {
    const { context, page } = await newPage({ viewport: { width: 1280, height: 800 } });
    await play(page, 'a', 'Canale A'); await playing(page);
    await page.mouse.move(600, 400);
    assert.ok(await page.isVisible('#pl-detach'), 'Stacca visible on desktop');
    await page.click('#pl-detach');
    assert.ok(await page.isHidden('#player'), 'player closed after detach');
    await waitFor(async () => (await wins(page))[0]?.t > 0.5, 8000, 'window A plays');
    let w = await wins(page);
    assert.equal(w.length, 1); assert.equal(w[0].title, 'Canale A'); assert.equal(w[0].muted, false, 'A keeps the sound');
    // the app is usable: navigate while A plays
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForTimeout(400);
    assert.equal((await wins(page)).length, 1, 'window survives navigation');
    // second video in the big player: it takes the sound, A goes quiet
    await play(page, 'b', 'Canale B'); await playing(page);
    await waitFor(async () => (await wins(page))[0].muted, 3000, 'A muted when B plays');
    assert.equal(await page.evaluate(() => document.getElementById('video').muted), false);
    // 🔊 on A: B is muted and the big player offers it back
    await page.click('.fw .fw-sound');
    assert.equal((await wins(page))[0].muted, false);
    assert.equal(await page.evaluate(() => document.getElementById('video').muted), true, 'B muted');
    assert.ok(await page.isVisible('#pl-unmute'));
    assert.match(await page.textContent('#pl-unmute'), /Canale A/);
    await page.click('#pl-unmute');
    assert.equal(await page.evaluate(() => document.getElementById('video').muted), false);
    assert.equal((await wins(page))[0].muted, true, 'A muted again');
    // detach B too: two windows, the dock appears; tile puts them side by side
    await page.mouse.move(600, 400);
    await page.click('#pl-detach');
    await waitFor(async () => (await wins(page)).length === 2 && (await wins(page))[1].t > 0.5, 8000, 'B in a window');
    w = await wins(page);
    assert.equal(w[1].muted, false, 'B has the sound'); assert.equal(w[0].muted, true);
    assert.ok(await page.isVisible('.fw-dock'));
    await page.click('.fw-dock .fw-btn >> nth=0');
    w = await wins(page);
    assert.ok(Math.abs(w[0].rect.top - w[1].rect.top) < 2 && w[0].rect.right <= w[1].rect.left + 1, 'side by side');
    assert.ok(w[0].rect.width > 500, 'tiled big: ' + w[0].rect.width);
    // drag A by the title bar
    const before = (await wins(page))[0].rect;
    await page.mouse.move(before.left + 40, before.top + 15); await page.mouse.down();
    await page.mouse.move(before.left - 10, before.top + 115, { steps: 5 }); await page.mouse.up();
    const after = (await wins(page))[0].rect;
    assert.ok(Math.abs(after.left - (before.left - 50)) < 3 && Math.abs(after.top - (before.top + 100)) < 3, 'dragged');
    // resize from the corner keeps 16:9
    await page.mouse.move(after.right - 6, after.bottom - 6); await page.mouse.down();
    await page.mouse.move(after.right - 206, after.bottom - 6, { steps: 4 }); await page.mouse.up();
    const small = (await wins(page))[0].rect;
    assert.ok(Math.abs(small.width - (after.width - 200)) < 3, 'resized'); assert.ok(Math.abs((small.height - 34) - small.width * 9 / 16) < 3, '16:9');
    // both play together, watching time counted
    w = await wins(page);
    assert.ok(w.every(x => !x.paused));
    assert.ok(await page.evaluate(() => import('/js/floating.js').then(f => f.anyPlaying())));
    // ⤢ on A: back in the big player, nothing to swap (player closed)
    await page.click('.fw >> nth=0 >> .fw-expand');
    await playing(page);
    assert.equal(await page.textContent('#pl-title'), 'Canale A');
    assert.equal((await wins(page)).length, 1);
    // ⤢ on B while A is in the big player: they swap
    await page.click('.fw .fw-expand');
    await playing(page);
    assert.equal(await page.textContent('#pl-title'), 'Canale B');
    w = await wins(page);
    assert.equal(w.length, 1); assert.equal(w[0].title, 'Canale A'); assert.equal(w[0].muted, true, 'swapped one is quiet');
    // a radio as a small bar
    await play(page, 'r', 'Radio Test', 'audio');
    await waitFor(() => page.evaluate(() => document.getElementById('video').currentTime > 0.3), 8000, 'radio');
    await page.mouse.move(600, 400);
    await page.click('#pl-detach');
    await waitFor(async () => (await wins(page)).some(x => x.audio && x.t > 0.3), 8000, 'radio bar');
    const radio = (await wins(page)).find(x => x.audio);
    assert.ok(radio.rect.height < 100, 'radio is a bar'); assert.equal(radio.muted, false);
    // close all
    await page.click('.fw-dock .fw-btn >> nth=1');
    assert.equal((await wins(page)).length, 0);
    assert.ok(await page.isHidden('.fw-dock'));
    // four at most on a computer: the fifth replaces the oldest
    for (let i = 1; i <= 5; i++) { await play(page, i % 2 ? 'a' : 'b', 'V' + i); await playing(page); await page.evaluate(() => import('/js/floating.js').then(f => f.detachCurrent())); }
    w = await wins(page);
    assert.deepEqual(w.map(x => x.title), ['V2', 'V3', 'V4', 'V5']);
    await context.close();
    console.log('ok desktop');
  }

  // ---- phone: one mini player, the next replaces it
  {
    const { context, page } = await newPage({ ...devices['Pixel 7'] });
    await play(page, 'a', 'Uno'); await playing(page);
    await page.evaluate(() => import('/js/floating.js').then(f => f.detachCurrent()));
    await play(page, 'b', 'Due'); await playing(page);
    await page.evaluate(() => import('/js/floating.js').then(f => f.detachCurrent()));
    const w = await wins(page);
    assert.deepEqual(w.map(x => x.title), ['Due']);
    assert.ok(w[0].rect.right <= 412 && w[0].rect.width < 300, 'mini player fits the phone');
    await context.close();
    console.log('ok phone');
  }
  // ---- tablet: two
  {
    const { context, page } = await newPage({ ...devices['iPad Pro 11 landscape'] });
    for (const n of ['a', 'b', 'a']) { await play(page, n, n); await playing(page); await page.evaluate(() => import('/js/floating.js').then(f => f.detachCurrent())); }
    assert.equal((await wins(page)).length, 2);
    await context.close();
    console.log('ok tablet');
  }
  // ---- Fire TV: no Stacca
  {
    const { context, page } = await newPage({ viewport: { width: 1280, height: 720 }, userAgent: 'Mozilla/5.0 (Linux; Android 9; AFTSSS) AppleWebKit/537.36 Chrome/120 Safari/537.36 SalottoTV' });
    await play(page, 'a', 'TV'); await playing(page);
    assert.ok(await page.isHidden('#pl-detach'));
    await context.close();
    console.log('ok tv');
  }
  assert.deepEqual(errors, []);
  console.log('floating: tutto ok');
} finally {
  await browser.close();
  server.kill();
}
