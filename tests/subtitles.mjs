// Subtitles test: a small HLS stream made with ffmpeg (video, a tone as sound, an Italian WebVTT
// track), played with the real hls.js. Checks the channel's own subtitles, then the generated
// ones with a fake Whisper (the real model can't be downloaded here) fed by the video's sound.
// Run: node tests/subtitles.mjs   (needs playwright, hls.js@1.5.17 and ffmpeg)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}/`;

let HLS_JS;
try { HLS_JS = require.resolve('hls.js/dist/hls.min.js'); } catch { console.log('hls.js non installato (npm i -g hls.js@1.5.17): test saltato'); process.exit(0); }
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { console.log('ffmpeg non installato: test saltato'); process.exit(0); }

// ---- the stream
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'salotto-subs-'));
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000',
  '-t', '40', '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', path.join(DIR, 'av%d.ts'), path.join(DIR, 'av.m3u8')]);
fs.writeFileSync(path.join(DIR, 'sub.vtt'), 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\n00:00:00.200 --> 00:00:39.000\nBuonasera, questo è il <i>telegiornale</i>\n');
fs.writeFileSync(path.join(DIR, 'sub.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:40\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:40,\nsub.vtt\n#EXT-X-ENDLIST\n');
fs.writeFileSync(path.join(DIR, 'empty.vtt'), 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\n');
fs.writeFileSync(path.join(DIR, 'empty.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:40\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:40,\nempty.vtt\n#EXT-X-ENDLIST\n');
fs.writeFileSync(path.join(DIR, 'master-empty.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Sottotitoli",URI="empty.m3u8"\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c01e,mp4a.40.2",SUBTITLES="subs"\nav.m3u8\n');
fs.writeFileSync(path.join(DIR, 'master.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Italiano",LANGUAGE="it",DEFAULT=NO,AUTOSELECT=YES,URI="sub.m3u8"\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c01e,mp4a.40.2",SUBTITLES="subs"\nav.m3u8\n');

// a pretend Whisper: "hears" a sentence in every piece with sound
const FAKE_TRANSFORMERS = `export const env = {};
export async function pipeline(task, model, o) {
  self.__pieces = 0;
  o.progress_callback?.({ status: 'progress_total', loaded: 150e6, total: 300e6 });
  await new Promise(r => setTimeout(r, 300));
  return async (audio, opts) => {
    if (opts.language !== 'italian') throw new Error('language');
    if (audio.length === 16000) return { text: '' }; // warm-up on silence
    self.__pieces++;
    return { text: ' Buongiorno, pezzo numero ' + self.__pieces + ' di ' + (audio.length / 16000).toFixed(1) + ' secondi.' };
  };
}`;

async function mock(context) {
  const types = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', vtt: 'text/vtt' };
  await context.route('https://media.test/**', (r) => {
    const f = path.join(DIR, new URL(r.request().url()).pathname.slice(1));
    if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ status: 200, contentType: types[f.split('.').pop()], body: fs.readFileSync(f), headers: { 'access-control-allow-origin': '*' } });
  });
  await context.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/hls\.js/, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(HLS_JS) }));
  await context.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers/, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TRANSFORMERS, headers: { 'access-control-allow-origin': '*' } }));
  await context.route(/^https:\/\/(raw\.githubusercontent\.com|iptv-org\.github\.io|de1\.api\.radio-browser\.info|archive\.org)\//, r => r.fulfill({ status: 404, body: '' }));
}

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
  await mock(context);
  // this computer "has" a WebGPU graphics card
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => ({ requestAdapter: async () => ({ features: new Set() }) }) });
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForSelector('.hero');
  const play = (url, label) => page.evaluate(([u, l]) => import('/js/player.js').then(p => p.play({ label: l, type: 'video' }, { url: u })), [url, label]);
  const overlay = () => page.evaluate(() => { const o = document.getElementById('pl-subs'); return o.hidden ? '' : o.textContent; });
  const clickCc = async (pg = page) => { await pg.mouse.move(600, 400); await pg.mouse.move(620, 420); await pg.click('#pl-cc'); };
  const options = () => page.$$eval('#pl-cclist .cc-opt', bs => bs.map(b => (b.classList.contains('on') ? '✓' : '') + b.querySelector('b').textContent + (b.disabled ? ' (x)' : '')));

  // ---- the channel's own subtitles
  await play('https://media.test/master.m3u8', 'Con sottotitoli');
  await page.waitForSelector('#pl-cc:not([hidden])');
  await waitFor(() => page.evaluate(() => document.getElementById('video').currentTime > 0.5), 10000, 'video plays');
  assert.equal(await overlay(), '', 'subtitles off by default');
  await clickCc();
  await page.waitForSelector('#pl-ccbox:not([hidden])');
  await waitFor(async () => (await options()).includes('Italiano'), 8000, 'Italian track listed');
  assert.deepEqual(await options(), ['✓Spenti', 'Automatici', 'Italiano', 'Generati dal computer']);
  await page.click('.cc-opt:has-text("Automatici")');
  await waitFor(async () => /telegiornale/.test(await overlay()), 10000, 'cue shown');
  assert.equal(await overlay(), 'Buonasera, questo è il telegiornale', 'cue text without tags');
  assert.deepEqual(await options(), ['Spenti', '✓Automatici', '✓Italiano', 'Generati dal computer']);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('salotto:subs')).mode), 'on');
  assert.equal(await page.evaluate(() => import('/js/player.js').then(p => p.remoteState().subs.label)), 'Italiano');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#pl-ccbox'), false, 'Escape closes the box first');
  assert.equal(await page.isVisible('#player'), true);
  console.log('✓ subtitles of the stream (HLS WebVTT): listed, shown in our overlay, choice remembered');

  // ---- generated subtitles: a stream without subtitles, "Automatici" still on
  await page.keyboard.press('Escape');
  await waitFor(() => page.evaluate(() => document.getElementById('player').hidden));
  await play('https://media.test/av.m3u8', 'Senza sottotitoli');
  await waitFor(() => page.evaluate(() => import('/js/player.js').then(p => p.remoteState().subs?.active === 'gen')), 9000, 'generated after a few seconds without subtitles');
  await clickCc();
  assert.deepEqual(await options(), ['Spenti', '✓Automatici', '✓Generati dal computer']);
  await waitFor(async () => /^Buongiorno, pezzo numero 1 di [345]\.\d secondi\.$/.test(await overlay()), 15000, 'generated sentence shown');
  assert.match(await page.textContent('#pl-ccnote'), /In ascolto/);
  assert.equal(await page.locator('.cc-model').count(), 3, 'three qualities');
  assert.match(await page.textContent('.cc-model.on'), /Bilanciata/);
  console.log('✓ generated subtitles: start by themselves on a channel without subtitles, the video\'s sound reaches Whisper in pieces of 3–5.5 s');
  // a subtitle track that never carries text (Safari shows one on many channels): set aside, generated instead
  await page.keyboard.press('Escape');
  await page.evaluate(() => import('/js/player.js').then(p => p.close()));
  await play('https://media.test/master-empty.m3u8', 'Traccia vuota');
  await waitFor(() => page.evaluate(() => import('/js/player.js').then(p => p.remoteState().subs?.label === 'Sottotitoli')), 8000, 'empty track picked first');
  await waitFor(() => page.evaluate(() => import('/js/player.js').then(p => p.remoteState().subs?.active === 'gen')), 30000, 'empty track set aside');
  await waitFor(async () => /Buongiorno/.test(await overlay()), 15000, 'generated after the empty track');
  await clickCc();
  assert.match(await page.textContent('.cc-opt:has-text("Sottotitoli") small'), /Finora vuoti/);
  console.log('✓ a channel subtitle track that stays empty gives way to the generated subtitles');
  // the phone remote: off and on again
  await page.evaluate(() => import('/js/player.js').then(p => p.toggleSubs()));
  assert.equal(await overlay(), '', 'off from the remote');
  assert.equal(await page.evaluate(() => import('/js/player.js').then(p => p.remoteState().subs.on)), false);
  await page.keyboard.press('s');
  assert.equal(await page.evaluate(() => import('/js/player.js').then(p => p.remoteState().subs.on)), true, 's key turns them on');
  console.log('✓ phone remote and the S key turn subtitles on and off');
  await page.evaluate(() => import('/js/player.js').then(p => p.close()));

  if (process.env.SHOTS) {
    await play('https://media.test/av.m3u8', 'Senza sottotitoli');
    await waitFor(async () => /Buongiorno/.test(await overlay()), 20000, 'shot');
    await clickCc();
    await page.screenshot({ path: process.env.SHOTS + '/subs-box.png' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(4500);
    await page.screenshot({ path: process.env.SHOTS + '/subs-idle.png' });
    await page.evaluate(() => import('/js/player.js').then(p => p.close()));
  }

  // ---- Safari: no captureStream(), the sound goes through Web Audio (createMediaElementSource)
  const saf = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await mock(saf);
  await saf.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => ({ requestAdapter: async () => ({ features: new Set(['shader-f16']) }) }) });
    delete HTMLMediaElement.prototype.captureStream;
    localStorage.setItem('salotto:subs', JSON.stringify({ mode: 'gen', model: 'base' }));
  });
  const sp = await saf.newPage();
  sp.on('pageerror', e => errors.push(e.message));
  await sp.goto(BASE);
  await sp.waitForSelector('.hero');
  await sp.evaluate(() => import('/js/player.js').then(p => p.play({ label: 'Safari', type: 'video' }, { url: 'https://media.test/av.m3u8' })));
  await waitFor(() => sp.evaluate(() => /Buongiorno/.test(document.getElementById('pl-subs').textContent)), 20000, 'Safari path');
  assert.equal(await sp.evaluate(() => document.getElementById('video').muted), false);
  await saf.close();
  console.log('✓ Safari-like browser: the sound reaches Whisper from hls.js audio pieces (ADTS + decodeAudioData), "Generati" remembered');

  // ---- iPad: no generated subtitles (too heavy), the reason is shown
  const ipad = await browser.newContext({ ...devices['iPad Pro 11 landscape'], serviceWorkers: 'block' });
  await mock(ipad);
  const ip = await ipad.newPage();
  ip.on('pageerror', e => errors.push(e.message));
  await ip.goto(BASE);
  await ip.waitForSelector('.hero');
  await ip.evaluate(() => import('/js/player.js').then(p => p.play({ label: 'iPad', type: 'video' }, { url: 'https://media.test/av.m3u8' })));
  await ip.waitForSelector('#pl-cc:not([hidden])');
  await ip.evaluate(() => document.getElementById('pl-cc').click());
  const gen = ip.locator('.cc-opt:has-text("Generati")');
  assert.equal(await gen.isDisabled(), true, 'generated subtitles disabled on iPad');
  assert.match(await gen.textContent(), /Mac o un PC/);
  assert.equal(await ip.locator('#pl-ccmodels').isVisible(), false);
  await ipad.close();
  console.log('✓ iPad: generated subtitles not offered, with the reason');

  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(DIR, { recursive: true, force: true });
}
console.log('\nTest dei sottotitoli passati.');
