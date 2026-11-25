// RaiPlay add-on test: catalogue, programme with seasons, programmes RaiPlay locks behind its
// sign-in (opened on raiplay.it), search, and a free video played with its official SRT subtitles.
// RaiPlay is mocked; the video is a small ffmpeg HLS stream behind a fake relinker.
// Run: node tests/raiplay.mjs   (needs playwright, hls.js@1.5.17 and ffmpeg)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}/`;

let HLS_JS;
try { HLS_JS = require.resolve('hls.js/dist/hls.min.js'); } catch { console.log('hls.js non installato: test saltato'); process.exit(0); }
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { console.log('ffmpeg non installato: test saltato'); process.exit(0); }

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'salotto-raiplay-'));
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000',
  '-t', '20', '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', path.join(DIR, 'v%d.ts'), path.join(DIR, 'playlist.m3u8')]);

const IMG = { landscape: '/dl/img/x.jpg' };
const RAI = {
  '/index.json': { contents: [
    { name: 'Hero', type: 'RaiPlay Hero Block', contents: [{ path_id: '/programmi/libera.json', name: 'Hero' }] },
    { name: 'Da non perdere', type: 'RaiPlay Slider Block', header: { label: 'Da non perdere' }, contents: [
      { path_id: '/programmi/libera.json', name: 'Serie libera', images: IMG },
      { path_id: '/programmi/chiusa.json', name: 'Fiction con accesso', images: IMG },
    ] },
  ] },
  '/programmi/libera.json': { name: 'Serie libera', first_item_path: '/video/2025/01/ep1.json', blocks: [{ name: 'Episodi', sets: [
    { name: 'Stagione 1', path_id: '/programmi/libera/ContentSet-1.json' }, { name: 'Stagione 2', path_id: '/programmi/libera/ContentSet-2.json' }] }] },
  '/programmi/libera/ContentSet-1.json': { items: [
    { path_id: '/video/2025/01/ep1.json', name: 'Serie libera - S1E1 - Il primo', episode_title: 'Il primo', program_name: 'Serie libera', season: '1', episode: '1', duration: '00:00:20', images: IMG, rights_management: { rights: { drm: {} } } },
  ] },
  '/programmi/libera/ContentSet-2.json': { items: [] },
  '/video/2025/01/ep1.json': { login_required: false, rights_management: { rights: { drm: {} } }, weblink: '/video/2025/01/ep1.html',
    video: { content_url: 'https://mediapolisvod.rai.it/relinker/relinkerServlet.htm?cont=ep1', subtitlesArray: [{ language: 'it', label: 'Italiano', url: '/dl/video/stl/Serie libera - Il primo.srt' }] } },
  '/programmi/chiusa.json': { name: 'Fiction con accesso', first_item_path: '/video/2025/02/f1.json', blocks: [{ name: 'Episodi', sets: [{ name: 'Stagione 1', path_id: '/programmi/chiusa/ContentSet-1.json' }] }] },
  '/programmi/chiusa/ContentSet-1.json': { items: [
    { path_id: '/video/2025/02/f1.json', name: 'Fiction - Ep 1', episode_title: 'Puntata uno', program_name: 'Fiction con accesso', season: '1', episode: '1', images: IMG, weblink: '/video/2025/02/f1.html', rights_management: { rights: { drm: {} } } },
  ] },
  '/video/2025/02/f1.json': { login_required: true, rights_management: { rights: { drm: {} } }, video: { content_url: 'https://mediapolisvod.rai.it/relinker/relinkerServlet.htm?cont=f1' } },
};
const SRT = '﻿1\r\n00:00:00,300 --> 00:00:19,000\r\n<font color="#FFFF00">Ciao, sono il primo episodio.</font>\r\n\r\n';

async function waitFor(fn, ms = 10000, what = '') {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timeout ' + what);
    await new Promise(r => setTimeout(r, 150));
  }
}

const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  await waitFor(() => fetch(BASE + 'proxy/health').then(r => r.ok).catch(() => false));
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const cors = { 'access-control-allow-origin': '*' };
  let searched = null, resolved = 0;
  await context.route('https://www.raiplay.it/**', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith('/msearch')) {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' } });
      searched = JSON.parse(r.request().postData()).params.param;
      return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ agg: { titoli: { cards: [{ titolo: 'Serie libera', path_id: '/programmi/libera.json', immagine: '/dl/img/x.jpg' }] }, video: { cards: [] } } }) });
    }
    if (u.pathname.endsWith('.srt')) return r.fulfill({ status: 200, contentType: 'application/x-subrip', headers: cors, body: SRT });
    const body = RAI[decodeURIComponent(u.pathname)];
    return body ? r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) }) : r.fulfill({ status: 404, body: '' });
  });
  // the relinker allows no other site; the stream it leads to does
  await context.route('https://mediapolisvod.rai.it/**', r => r.fulfill({ status: 302, headers: { location: 'https://vod.test/playlist.m3u8?tok=1' } }));
  await context.route('https://vod.test/**', (r) => {
    const f = path.join(DIR, new URL(r.request().url()).pathname.slice(1));
    if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ status: 200, contentType: f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', body: fs.readFileSync(f), headers: cors });
  });
  await context.route(u => u.pathname.endsWith('/proxy') && u.searchParams.get('resolve') === '1', (r) => {
    resolved++;
    assert.match(new URL(r.request().url()).searchParams.get('url'), /^https:\/\/mediapolisvod\.rai\.it\/relinker\//);
    return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ url: 'https://vod.test/playlist.m3u8?tok=1', status: 200 }) });
  });
  await context.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/hls\.js/, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(HLS_JS) }));
  await context.route(/^https:\/\/(raw\.githubusercontent\.com|iptv-org\.github\.io|de1\.api\.radio-browser\.info|archive\.org)\//, r => r.fulfill({ status: 404, body: '' }));
  await context.addInitScript(() => {
    if (!localStorage.getItem('salotto:subs')) localStorage.setItem('salotto:subs', JSON.stringify({ mode: 'on' }));
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('.hero');
  assert.ok(await page.evaluate(() => window.salotto.addons.getInstalled('plugin.video.raiplay')), 'RaiPlay add-on installed with the app');

  // catalogue
  await page.goto(BASE + '#/browse/plugin.video.raiplay');
  await page.waitForSelector('.row:has-text("Cerca su RaiPlay")');
  await page.click('.row:has-text("In evidenza")');
  await page.waitForSelector('.row:has-text("Da non perdere")');
  assert.equal(await page.locator('.row:has-text("Hero")').count(), 0, 'hero rows left out');
  await page.click('.row:has-text("Da non perdere")');
  await page.waitForSelector('.card:has-text("Fiction con accesso")');
  // a programme behind RaiPlay's sign-in: its episodes open on raiplay.it
  await page.click('.card:has-text("Fiction con accesso")');
  await page.waitForSelector('.card:has-text("Puntata uno")');
  assert.match(await page.textContent('.card:has-text("Puntata uno")'), /Si apre su raiplay\.it/);
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await page.click('.card:has-text("Puntata uno")');
  assert.deepEqual(await page.evaluate(() => window.__opened), ['https://www.raiplay.it/video/2025/02/f1.html']);
  assert.equal(await page.isVisible('#player'), false);
  console.log('✓ RaiPlay: catalogue rows; programmes behind RaiPlay\'s sign-in open on raiplay.it');

  // search → programme with two seasons → episode with subtitles
  await page.goto(BASE + '#/browse/plugin.video.raiplay');
  await page.waitForSelector('.row:has-text("Cerca su RaiPlay")');
  await page.click('.row:has-text("Cerca su RaiPlay")');
  await page.fill('input[placeholder="Cerca…"]', 'libera');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.card:has-text("Serie libera")');
  assert.equal(searched, 'libera');
  await page.click('.card:has-text("Serie libera")');
  await page.waitForSelector('.row:has-text("Stagione 2")');
  await page.click('.row:has-text("Stagione 1")');
  await page.waitForSelector('.card:has-text("Il primo")');
  assert.match(await page.textContent('.card:has-text("Il primo")'), /St 1 Ep 1/);
  await page.click('.card:has-text("Il primo")');
  await page.waitForSelector('#player:not([hidden])');
  await waitFor(() => page.evaluate(() => document.getElementById('video').currentTime > 0.5), 15000, 'video plays');
  assert.equal(resolved, 1, 'relinker resolved through the proxy');
  assert.match(await page.textContent('#pl-route'), /Diretto/);
  await waitFor(() => page.evaluate(() => { const o = document.getElementById('pl-subs'); return !o.hidden && /primo episodio/.test(o.textContent); }), 10000, 'official subtitles shown');
  assert.equal(await page.evaluate(() => document.getElementById('pl-subs').textContent), 'Ciao, sono il primo episodio.', 'SRT tags removed');
  console.log('✓ RaiPlay: search, seasons, free episode plays (relinker resolved, stream direct) with its official SRT subtitles');

  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(DIR, { recursive: true, force: true });
}
console.log('\nTest RaiPlay passati.');
