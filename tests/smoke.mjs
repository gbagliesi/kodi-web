// End-to-end smoke test: starts server.js, opens the app in Chromium with an
// iPad-sized viewport and mocks every external service the add-ons call.
// Run: node tests/smoke.mjs   (needs the `playwright` package)
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}/`;
const SHOTS = process.env.SHOTS || '';

const M3U = `#EXTM3U
#EXTINF:-1 tvg-id="Rai1.it" tvg-logo="https://example.org/rai1.png" group-title="Generalisti",Rai 1
https://example.org/live/rai1.m3u8
#EXTINF:-1 tvg-id="La7.it" group-title="Generalisti",La7 Ⓖ
https://example.org/live/la7.m3u8
#EXTINF:-1 tvg-id="" group-title="Generalisti",Euronews Ⓨ
https://www.youtube.com/user/euronewsit/live
#EXTINF:-1 tvg-id="Rai1.it" group-title="Generalisti",Rai 1 Ⓖ
https://mediapolis.example.org/relinker/relinkerServlet.htm?cont=2606803&output=7
#EXTINF:-1 tvg-id="" group-title="News",Notizie 24
#EXTVLCOPT:http-referrer=https://example.org/
https://example.org/live/news.m3u8
`;

function xmltvNow(offsetMin) {
  const d = new Date(Date.now() + offsetMin * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
}
const EPG = `<?xml version="1.0"?><tv>
<programme start="${xmltvNow(-30)}" stop="${xmltvNow(30)}" channel="Rai1.it"><title>Telegiornale di prova</title><desc>Notizie</desc></programme>
<programme start="${xmltvNow(30)}" stop="${xmltvNow(90)}" channel="Rai1.it"><title>Film della sera</title></programme>
</tv>`;

const RADIO = [{ stationuuid: 'u1', name: 'Radio Prova', url_resolved: 'https://example.org/radio.mp3', country: 'Italy', tags: 'pop', bitrate: 128, favicon: '' },
  { stationuuid: 'u2', name: 'Solo HTTP', url_resolved: 'http://example.org/radio.mp3', country: 'Italy', tags: '', bitrate: 64, favicon: '' }];

async function mock(context) {
  await context.route(/^https:\/\/(raw\.githubusercontent\.com|iptv-org\.github\.io)\//, r => r.fulfill({ status: 200, contentType: 'audio/x-mpegurl', body: M3U.replace('#EXTM3U', `#EXTM3U url-tvg="https://epg.example.org/guide.xml"`), headers: { 'access-control-allow-origin': '*' } }));
  await context.route('https://epg.example.org/**', r => r.fulfill({ status: 200, contentType: 'application/xml', body: EPG, headers: { 'access-control-allow-origin': '*' } }));
  await context.route('https://de1.api.radio-browser.info/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RADIO), headers: { 'access-control-allow-origin': '*' } }));
  await context.route('https://archive.org/advancedsearch.php**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ response: { numFound: 1, docs: [{ identifier: 'film1', title: 'Film di prova', year: 1950, description: '<b>Trama</b>' }] } }) }));
  await context.route('https://archive.org/metadata/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ d1: 'ia800.example.org', dir: '/1/items/film1', files: [{ name: 'film1.ogv' }, { name: 'film1_512kb.mp4', format: 'h.264' }] }) }));
  // media + images: tiny empty responses
  await context.route(/^https:\/\/(example\.org|ia800\.example\.org|commondatastorage\.googleapis\.com|archive\.org\/services)\//, r => r.fulfill({ status: 404, body: '' }));
  await context.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.Hls={isSupported:()=>true,Events:{ERROR:"e"},ErrorTypes:{},prototype:{}};window.Hls=Object.assign(function(){return{on(){},loadSource(u){window.__hlsSrc=u},attachMedia(){},destroy(){}}},window.Hls);' }));
}

async function waitFor(fn, ms = 8000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 100));
  }
}

async function proxyTests() {
  // Upstream that serves an HLS playlist with relative segment URLs.
  const up = http.createServer((req, res) => {
    if (req.url.startsWith('/live/index.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\nhttps://cdn.example.net/seg2.ts\n');
    } else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('referer=' + (req.headers.referer || '')); }
  }).listen(0);
  await new Promise(r => up.once('listening', r));
  const upPort = up.address().port;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '8798', '--host', '127.0.0.1'], { env: { ...process.env, ALLOW_PRIVATE: '1' }, stdio: 'ignore' });
  try {
    await waitFor(() => fetch('http://127.0.0.1:8798/proxy/health').then(r => r.ok).catch(() => false));
    const pl = await (await fetch(`http://127.0.0.1:8798/proxy?url=${encodeURIComponent(`http://127.0.0.1:${upPort}/live/index.m3u8`)}`)).text();
    assert.match(pl, new RegExp(`URI="proxy\\?url=${encodeURIComponent(`http://127.0.0.1:${upPort}/live/key.bin`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.match(pl, /\nproxy\?url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Flive%2Fseg1\.ts\n/);
    assert.match(pl, /proxy\?url=https%3A%2F%2Fcdn\.example\.net%2Fseg2\.ts/);
    const h = encodeURIComponent(JSON.stringify({ Referer: 'https://ref.example/' }));
    const echo = await (await fetch(`http://127.0.0.1:8798/proxy?url=${encodeURIComponent(`http://127.0.0.1:${upPort}/x`)}&headers=${h}`)).text();
    assert.equal(echo, 'referer=https://ref.example/');
    console.log('✓ proxy rewrites HLS playlists and forwards headers');
  } finally { srv.kill(); up.close(); }

  const srv2 = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '8797', '--host', '127.0.0.1'], { stdio: 'ignore' });
  try {
    await waitFor(() => fetch('http://127.0.0.1:8797/proxy/health').then(r => r.ok).catch(() => false));
    const r = await fetch('http://127.0.0.1:8797/proxy?url=' + encodeURIComponent('http://127.0.0.1:22/'));
    assert.equal(r.status, 403);
    const status = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: 8797, path: '/..%2f..%2fetc%2fpasswd' }, res => { res.resume(); resolve(res.statusCode); }));
    assert.equal(status, 404, 'path traversal blocked');
    console.log('✓ proxy refuses private addresses by default');
  } finally { srv2.kill(); }
}

async function uiTests() {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const errors = [];
  try {
    await waitFor(() => fetch(BASE + 'proxy/health').then(r => r.ok).catch(() => false));
    const context = await browser.newContext({ ...devices['iPad Pro 11 landscape'], serviceWorkers: 'block' });
    await mock(context);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

    await page.goto(BASE);
    await page.waitForSelector('.hero');
    const installed = await page.evaluate(() => window.salotto.addons.listInstalled().map(a => a.manifest.id));
    assert.equal(installed.length, 5, 'bundled add-ons installed: ' + installed);
    console.log('✓ app boots and installs bundled add-ons:', installed.join(', '));
    // An outdated add-on from the official repository is updated on the next start
    await page.evaluate(() => {
      const k = 'salotto:addons'; const m = JSON.parse(localStorage.getItem(k));
      m['plugin.video.iptv'].manifest.version = '1.0.0'; localStorage.setItem(k, JSON.stringify(m));
    });
    await page.reload();
    await page.waitForSelector('.hero');
    assert.equal(await page.evaluate(() => window.salotto.addons.getInstalled('plugin.video.iptv').manifest.version), '1.2.1');
    console.log('✓ outdated bundled add-ons are updated at start-up');
    assert.ok(await page.evaluate(() => window.salotto.addons.getProxy().includes('/proxy?url=')), 'proxy auto-detected');
    if (SHOTS) await page.screenshot({ path: SHOTS + '/home.png' });

    // Video -> demo add-on -> folder -> play
    await page.click('.menu-item:has-text("Video")');
    await page.click('.tile:has-text("Video di prova")');
    await page.click('.row:has-text("Cortometraggi Blender")');
    await page.waitForSelector('.grid.wide .card');
    assert.equal(await page.locator('.card').count(), 4);
    await page.click('.card:has-text("Sintel")');
    await page.waitForSelector('#player:not([hidden])');
    assert.match(await page.evaluate(() => document.getElementById('video').src), /Sintel\.mp4$/);
    await page.keyboard.press('Escape');
    await waitFor(() => page.evaluate(() => document.getElementById('player').hidden));
    console.log('✓ browse demo add-on and open the player');

    // Archive add-on with resolve()
    await page.goto(BASE + '#/browse/plugin.video.archive?p=c%2Ffeature_films%2F1');
    await page.waitForSelector('.card:has-text("Film di prova")');
    await page.click('.card:has-text("Film di prova")');
    await page.waitForSelector('#player:not([hidden])');
    assert.equal(await page.evaluate(() => document.getElementById('video').src), 'https://ia800.example.org/1/items/film1/film1_512kb.mp4');
    await page.click('#pl-close');
    console.log('✓ Internet Archive add-on resolves an MP4');

    // Live TV with presets, groups, EPG and HLS
    await page.goto(BASE + '#/live');
    await page.click('.tile:has-text("TV in diretta")');
    await page.waitForSelector('.row:has-text("Digitale terrestre Italia")');
    await page.click('.row:has-text("Digitale terrestre Italia")');
    await page.waitForSelector('.row:has-text("Generalisti")');
    await page.click('.row:has-text("Generalisti")');
    await page.waitForSelector('.row:has-text("Rai 1")');
    const sub = await page.locator('.row:has-text("Rai 1") .row-sub').first().textContent();
    assert.match(sub, /Ora: Telegiornale di prova .* Poi: Film della sera/);
    assert.match(await page.locator('.row:has-text("La7") .row-sub').textContent(), /Solo dall'Italia/);
    assert.equal((await page.locator('.row:has-text("La7") .row-label').textContent()).trim(), 'La7');
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    await page.click('.row:has-text("Euronews")');
    assert.deepEqual(await page.evaluate(() => window.__opened), ['https://www.youtube.com/user/euronewsit/live']);
    assert.equal(await page.evaluate(() => document.getElementById('player').hidden), true);
    if (SHOTS) await page.screenshot({ path: SHOTS + '/live.png' });
    await page.locator('.row:has-text("Rai 1")').first().click();
    await page.waitForSelector('#player:not([hidden])');
    await waitFor(() => page.evaluate(() => window.__hlsSrc || document.getElementById('video').src));
    const src = await page.evaluate(() => window.__hlsSrc || document.getElementById('video').src);
    assert.match(src, /rai1\.m3u8/);
    if (SHOTS) await page.screenshot({ path: SHOTS + '/player.png' });
    await page.click('#pl-close');
    console.log('✓ live TV: Italian presets, groups, EPG now/next, geo/YouTube marks, HLS playback');

    // Channel with Referer goes through the proxy
    await page.goBack();
    await page.waitForSelector('.row:has-text("News")');
    await page.click('.row:has-text("News")');
    await page.click('.row:has-text("Notizie 24")');
    const viaProxy = () => page.evaluate(() => [window.__hlsSrc || '', document.getElementById('video').src].find(u => u.includes('/proxy?url=')));
    await waitFor(viaProxy);
    assert.match(await viaProxy(), /headers=%7B%22Referer/);
    await page.click('#pl-close');
    console.log('✓ channels with custom headers are routed through the proxy');

    // Radio: https-only filter
    await page.goto(BASE + '#/browse/plugin.audio.radiobrowser?p=top');
    await page.waitForSelector('.row:has-text("Radio Prova")');
    assert.equal(await page.locator('.row:has-text("Solo HTTP")').count(), 0);
    console.log('✓ radio add-on filters out insecure streams');

    // Add-on settings round-trip
    await page.goto(BASE + '#/addons/plugin.video.iptv');
    await page.waitForSelector('#set-playlists');
    await page.fill('#set-playlists', 'Mia | https://raw.githubusercontent.com/me/list.m3u');
    await page.click('.btn:has-text("Salva")');
    const saved = await page.evaluate(() => window.salotto.addons.getAddonSettings('plugin.video.iptv').playlists);
    assert.match(saved, /Mia \|/);
    console.log('✓ add-on settings are saved');

    // Keyboard / remote navigation
    await page.goto(BASE + '#/');
    await page.waitForSelector('.hero');
    await page.keyboard.press('ArrowDown');
    const f1 = await page.evaluate(() => document.activeElement.textContent);
    await page.keyboard.press('ArrowRight');
    const f2 = await page.evaluate(() => document.activeElement.textContent);
    assert.ok(f1 && f2 && f1 !== f2, `focus moved: ${f1} -> ${f2}`);
    console.log('✓ arrow-key navigation moves focus');

    // Desktop Chrome: extension-less broadcaster links go through hls.js
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await mock(desktop);
    const p3 = await desktop.newPage();
    await p3.goto(BASE + '#/browse/plugin.video.iptv?p=p%2F0%2Fg%2FGeneralisti');
    await p3.waitForSelector('.row:has-text("Solo dall\'Italia")');
    await p3.click('.row:has-text("Rai 1"):has-text("Solo dall\'Italia")');
    await waitFor(() => p3.evaluate(() => (window.__hlsSrc || '').includes('relinkerServlet')));
    await desktop.close();
    console.log('✓ desktop: extension-less live links are played with hls.js');

    // Portrait layout (bottom bar)
    const portrait = await browser.newContext({ ...devices['iPad Mini'], serviceWorkers: 'block' });
    await mock(portrait);
    const p2 = await portrait.newPage();
    await p2.goto(BASE);
    await p2.waitForSelector('.hero');
    const dir = await p2.evaluate(() => getComputedStyle(document.getElementById('app')).flexDirection);
    assert.equal(dir, 'column-reverse');
    if (SHOTS) await p2.screenshot({ path: SHOTS + '/portrait.png' });
    console.log('✓ portrait layout uses a bottom menu bar');

    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    server.kill();
  }
}

await proxyTests();
await uiTests();
console.log('\nTutti i test sono passati.');
