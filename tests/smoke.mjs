// End-to-end smoke test: starts server.js, opens the app in Chromium with an
// iPad-sized viewport and mocks every external service the add-ons call.
// Run: node tests/smoke.mjs   (needs the `playwright` package)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
<channel id="LA7.HD.it"><display-name>LA7 HD</display-name></channel>
<programme start="${xmltvNow(-100)}" stop="${xmltvNow(-90)}" channel="LA7.HD.it"><title>Prima pagina</title><desc>Le notizie del mattino lette e commentate in studio. Le notizie del mattino lette e commentate in studio.</desc></programme>
<programme start="${xmltvNow(-90)}" stop="${xmltvNow(-80)}" channel="LA7.HD.it"><title>Prima pagina</title></programme>
<programme start="${xmltvNow(-40)}" stop="${xmltvNow(20)}" channel="LA7.HD.it"><title>Notiziario La7</title><category>Informazione</category></programme>
<programme start="${xmltvNow(20)}" stop="${xmltvNow(80)}" channel="LA7.HD.it"><title>Talk della sera</title><desc>Ospiti in studio</desc></programme>
</tv>`;

// Salotto's own guide (epg/it.json), built from the XMLTV above by the same script the Pages workflow runs.
function buildGuide() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salotto-epg-'));
  fs.writeFileSync(path.join(dir, 'it.xml'), EPG);
  execFileSync(process.execPath, [path.join(ROOT, 'tools/build-epg.mjs'), path.join(dir, 'it.json'), path.join(dir, 'it.xml')], { env: { ...process.env, EPG_MIN_CHANNELS: '1' } });
  return fs.readFileSync(path.join(dir, 'it.json'), 'utf8');
}
const GUIDE = buildGuide();
{
  const la7 = JSON.parse(GUIDE).ch['LA7.HD.it'].p;
  const pp = la7.filter(p => p[2] === 'Prima pagina');
  assert.equal(pp.length, 1, 'guide: parts of a programme with the same title are merged');
  assert.equal(pp[0][1] - pp[0][0], 20 * 60);
  assert.equal(pp[0][3], 'Le notizie del mattino lette e commentate in studio.', 'guide: repeated description kept once');
}

const RADIO = [{ stationuuid: 'u1', name: 'Radio Prova', url_resolved: 'https://example.org/radio.mp3', country: 'Italy', tags: 'pop', bitrate: 128, favicon: '' },
  { stationuuid: 'u2', name: 'Solo HTTP', url_resolved: 'http://example.org/radio.mp3', country: 'Italy', tags: '', bitrate: 64, favicon: '' }];

// Fake Google Cast SDK: records what would be sent to the TV
const FAKE_CAST = `(() => {
  let sess = null, idle = null; const ctxL = []; window.__castLoads = []; window.__castPP = 0; window.__castStopped = 0;
  window.chrome = window.chrome || {};
  window.chrome.cast = { AutoJoinPolicy: { ORIGIN_SCOPED: 'o' }, Image: function (u) { this.url = u; }, media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845', HlsSegmentFormat: { TS: 'ts', FMP4: 'fmp4', AAC: 'aac', MP3: 'mp3', AC3: 'ac3' }, HlsVideoSegmentFormat: { MPEG2_TS: 'mpeg2_ts', FMP4: 'fmp4' }, StreamType: { LIVE: 'LIVE', BUFFERED: 'BUFFERED' },
    MediaInfo: function (u, t) { this.contentId = u; this.contentType = t; },
    GenericMediaMetadata: function () {}, MusicTrackMediaMetadata: function () {}, LoadRequest: function (m) { this.media = m; } } };
  const fire = (st) => { for (const [t, f] of ctxL) if (t === 'session') f({ sessionState: st }); };
  const ctx = { setOptions() {}, addEventListener(t, f) { ctxL.push([t, f]); }, getCastState: () => 'NOT_CONNECTED', getCurrentSession: () => sess,
    requestSession() {
      sess = { getCastDevice: () => ({ friendlyName: 'TV Salotto' }),
        loadMedia: async (r) => { window.__castLoads.push([r.media.contentId, r.media.contentType, r.media.streamType, r.media.metadata.title, r.media.hlsSegmentFormat || '', r.media.hlsVideoSegmentFormat || '']); },
        getMediaSession: () => ({ idleReason: idle, stop() { window.__castStopped++; } }) };
      fire('SESSION_STARTED'); return Promise.resolve();
    } };
  window.cast = { framework: { CastContext: { getInstance: () => ctx },
    CastContextEventType: { CAST_STATE_CHANGED: 'state', SESSION_STATE_CHANGED: 'session' },
    SessionState: { SESSION_STARTED: 'SESSION_STARTED', SESSION_RESUMED: 'SESSION_RESUMED', SESSION_ENDED: 'SESSION_ENDED' },
    RemotePlayer: function () { this.currentTime = 0; this.duration = 0; this.isPaused = false; },
    RemotePlayerController: function (pl) { const L = {}; this.addEventListener = (t, f) => { L[t] = f; }; window.__castError = () => { pl.playerState = 'IDLE'; idle = 'ERROR'; L.psc && L.psc(); }; this.playOrPause = () => { window.__castPP++; }; this.seek = () => {}; },
    RemotePlayerEventType: { PLAYER_STATE_CHANGED: 'psc' } } };
  window.__endCast = () => { sess = null; fire('SESSION_ENDED'); };
  setTimeout(() => window.__onGCastApiAvailable(true), 0);
})();`;

async function mock(context) {
  await context.route(BASE + 'epg/it.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: GUIDE }));
  await context.route(/^https:\/\/(raw\.githubusercontent\.com|iptv-org\.github\.io)\//, r => r.fulfill({ status: 200, contentType: 'audio/x-mpegurl', body: M3U.replace('#EXTM3U', `#EXTM3U x-tvg-url="https://epg.example.org/epg_DE1.xml.gz, https://epg.example.org/epg_IT1.xml, https://epg.example.org/epg_US1.xml.gz"`), headers: { 'access-control-allow-origin': '*' } }));
  await context.route('https://epg.example.org/**', r => r.request().url().endsWith('/epg_IT1.xml') ? r.fulfill({ status: 200, contentType: 'application/xml', body: EPG, headers: { 'access-control-allow-origin': '*' } }) : r.fulfill({ status: 404, body: '' }));
  await context.route('https://de1.api.radio-browser.info/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RADIO), headers: { 'access-control-allow-origin': '*' } }));
  await context.route('https://archive.org/advancedsearch.php**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ response: { numFound: 1, docs: [{ identifier: 'film1', title: 'Film di prova', year: 1950, description: '<b>Trama</b>' }] } }) }));
  await context.route('https://archive.org/metadata/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ d1: 'ia800.example.org', dir: '/1/items/film1', files: [{ name: 'film1.ogv' }, { name: 'film1_512kb.mp4', format: 'h.264' }] }) }));
  // media + images: tiny empty responses
  await context.route(/^https:\/\/(example\.org|ia800\.example\.org|commondatastorage\.googleapis\.com|archive\.org\/services)\//, r => r.fulfill({ status: 404, body: '' }));
  await context.addInitScript(() => { window.chrome = window.chrome || {}; });
  await context.route('https://www.gstatic.com/cv/js/sender/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_CAST }));
  await context.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.Hls={isSupported:()=>true,Events:{ERROR:"e"},ErrorTypes:{},prototype:{}};window.Hls=Object.assign(function(){return{on(){},loadSource(u){window.__hlsSrc=u},attachMedia(){},destroy(){},stopLoad(){},startLoad(){}}},window.Hls);' }));
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

async function workerTests() {
  const { default: worker } = await import(path.join(ROOT, 'cloudflare/worker.js'));
  const up = http.createServer((req, res) => {
    if (req.url.startsWith('/live/index.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg1.ts\n');
    } else { res.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-3/10' }); res.end('ref=' + (req.headers.referer || '') + ';range=' + (req.headers.range || '')); }
  }).listen(0);
  await new Promise(r => up.once('listening', r));
  const port = up.address().port;
  const W = 'https://salotto-proxy.example.workers.dev';
  const env = { TOKEN: 's3cret', ALLOWED_ORIGINS: 'https://gbagliesi.github.io' };
  const call = (q, headers = {}) => worker.fetch(new Request(W + q, { headers }), env);
  try {
    assert.equal(await (await call('/proxy/health')).text(), 'ok');
    const target = encodeURIComponent(`http://127.0.0.1:${port}/live/index.m3u8`);
    assert.equal((await call('/proxy?url=' + target)).status, 401);
    // with a TOKEN the token is the protection; the Chromecast (another origin) must get through
    assert.equal((await call('/proxy?token=s3cret&url=' + target, { Origin: 'https://www.gstatic.com' })).status, 200);
    // without a TOKEN the origin allow-list applies, Cast receivers always allowed
    const env2 = { ALLOWED_ORIGINS: 'https://gbagliesi.github.io' };
    const call2 = (q, headers = {}) => worker.fetch(new Request(W + q, { headers }), env2);
    assert.equal((await call2('/proxy?url=' + target, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await call2('/proxy?url=' + target, { Origin: 'https://www.gstatic.com' })).status, 200);
    assert.equal((await call2('/proxy?url=' + target, { Origin: 'https://gbagliesi.github.io' })).status, 200);
    const pl = await call('/proxy?token=s3cret&url=' + target, { Origin: 'https://gbagliesi.github.io' });
    assert.equal(pl.headers.get('access-control-allow-origin'), '*');
    const body = await pl.text();
    assert.match(body, /URI="proxy\?url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Flive%2Finit\.mp4&token=s3cret"/);
    assert.match(body, /\nproxy\?url=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Flive%2Fseg1\.ts&token=s3cret/);
    // with a file name in the path (for native HLS players), relative links still resolve to the proxy
    const named = await call('/proxy/live.m3u8?token=s3cret&url=' + target);
    assert.equal(named.status, 200);
    assert.match(await named.text(), /\nproxy\?url=/);
    assert.equal((await call('/proxy/a/b?token=s3cret&url=' + target)).status, 404);
    const h = encodeURIComponent(JSON.stringify({ Referer: 'https://www.raiplay.it/' }));
    const seg = await call(`/proxy?token=s3cret&headers=${h}&url=` + encodeURIComponent(`http://127.0.0.1:${port}/live/seg1.ts`), { Range: 'bytes=0-3' });
    assert.equal(seg.status, 206);
    assert.equal(seg.headers.get('content-range'), 'bytes 0-3/10');
    assert.equal(await seg.text(), 'ref=https://www.raiplay.it/;range=bytes=0-3');
    console.log('✓ Cloudflare worker: token, origin allow-list (Chromecast allowed), HLS rewrite, headers and ranges');
  } finally { up.close(); }
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
    assert.equal(installed.length, 8, 'bundled add-ons installed: ' + installed);
    console.log('✓ app boots and installs bundled add-ons:', installed.join(', '));
    // An outdated add-on from the official repository is updated on the next start
    await page.evaluate(() => {
      const k = 'salotto:addons'; const m = JSON.parse(localStorage.getItem(k));
      m['plugin.video.iptv'].manifest.version = '1.0.0';
      // a visit from before RaiPlay was added: it is installed once, by itself
      delete m['plugin.video.raiplay']; localStorage.setItem(k, JSON.stringify(m)); localStorage.removeItem('salotto:bundled-seen');
    });
    await page.reload();
    await page.waitForSelector('.hero');
    assert.equal(await page.evaluate(() => window.salotto.addons.getInstalled('plugin.video.iptv').manifest.version), '1.5.0');
    await waitFor(() => page.evaluate(() => !!window.salotto.addons.getInstalled('plugin.video.raiplay')), 8000);
    // removed by the user: it stays removed
    await page.evaluate(() => window.salotto.addons.uninstall('plugin.video.raiplay'));
    await page.reload();
    await page.waitForSelector('.hero');
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(await page.evaluate(() => !!window.salotto.addons.getInstalled('plugin.video.raiplay')), false, 'an add-on the user removed is not reinstalled');
    await page.evaluate(() => window.salotto.addons.installFromManifestUrl('addons/plugin.video.raiplay/addon.json', { source: 'repo' }));
    console.log('✓ outdated bundled add-ons are updated at start-up, new ones installed once');
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
    await page.click('.row:has-text("TGR regionali")');
    await page.waitForSelector('.row:has-text("TGR Puglia")');
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    await page.click('.row:has-text("TGR Toscana")');
    assert.deepEqual(await page.evaluate(() => window.__opened), ['https://www.rainews.it/tgr/toscana']);
    await page.goBack();
    await page.waitForSelector('.row:has-text("Digitale terrestre Italia")');
    await page.click('.row:has-text("Digitale terrestre Italia")');
    await page.waitForSelector('.row:has-text("Generalisti")');
    await page.click('.row:has-text("Generalisti")');
    await page.waitForSelector('.row:has-text("Rai 1")');
    const labels = await page.locator('.row-label').allTextContents();
    assert.ok(labels.includes('1Rai 1') && labels.includes('7La7'), 'channel lists show the channel numbers: ' + labels.join(' | '));
    const sub = await page.locator('.row:has-text("Rai 1") .row-sub').first().textContent();
    assert.match(sub, /Ora: Telegiornale di prova .* Poi: Film della sera/);
    assert.match(await page.locator('.row:has-text("La7") .row-sub').textContent(), /Solo dall'Italia/);
    assert.equal((await page.locator('.row:has-text("La7") .row-label').textContent()).trim(), '7La7');
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
    console.log('✓ live TV: Italian presets, groups, EPG now/next, geo/YouTube marks, HLS playback');

    // Zapping: CH +/−, arrows, typed numbers and the channel list, without leaving the player
    const nowSrc = () => page.evaluate(() => window.__hlsSrc || document.getElementById('video').src);
    const title = () => page.evaluate(() => document.getElementById('pl-title').textContent);
    assert.equal(await page.isVisible('#pl-chup'), true, 'CH + visible for live channels');
    assert.equal(await page.isVisible('#pl-rew'), false, 'rewind hidden for live channels');
    await page.keyboard.press('ArrowUp');
    await waitFor(async () => /la7\.m3u8/.test(await nowSrc()));
    assert.equal(await title(), '7  La7', 'player title shows the channel number');
    assert.equal(await page.isVisible('#player'), true);
    await page.click('#pl-chdown');
    await waitFor(async () => /rai1\.m3u8/.test(await nowSrc()));
    await page.keyboard.press('7'); // La7 is channel 7 on Italian TV
    assert.match(await page.textContent('#pl-osd'), /7/);
    await waitFor(async () => /la7\.m3u8/.test(await nowSrc()));
    await page.keyboard.press('1');
    await waitFor(async () => /rai1\.m3u8/.test(await nowSrc()));
    await page.click('#pl-chlist');
    await page.waitForSelector('#pl-channels:not([hidden])');
    const rows = await page.locator('.ch-row').evaluateAll(els => els.map(e => e.querySelector('.ch-num').textContent + e.querySelector('.ch-name').textContent));
    assert.deepEqual(rows, ['1Rai 1', '7La7', '8Rai 1'], 'channel list: broadcast numbers, YouTube channels left out');
    assert.equal(await page.locator('.ch-row:has-text("La7") .ch-prog').textContent(), 'Notiziario La7', 'channel list shows what is on');
    if (SHOTS) await page.screenshot({ path: SHOTS + '/channels.png' });
    await page.click('.ch-row:has-text("8")');
    await waitFor(async () => /relinkerServlet/.test(await nowSrc()));
    assert.equal(await page.isVisible('#pl-channels'), false);
    await page.click('#pl-chlist');
    await page.fill('#pl-chnum', '7');
    await page.keyboard.press('Enter');
    await waitFor(async () => /la7\.m3u8/.test(await nowSrc()));
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#player'), false);
    console.log('✓ live TV: change channel inside the player (CH +/−, arrows, number, channel list)');

    // Audio/video sync: A/V button, ±50 ms steps, saved per channel, Azzera
    await page.locator('.row:has-text("Rai 1")').first().click();
    await page.waitForSelector('#player:not([hidden])');
    await waitFor(async () => /rai1\.m3u8/.test(await nowSrc()));
    const wasNative = await page.evaluate(() => { const n = !window.__hlsSrc; window.__hlsSrc = ''; return n; });
    assert.equal(await page.isVisible('#pl-sync'), true, 'A/V button visible for video');
    await page.click('#pl-sync');
    await page.waitForSelector('#pl-syncbox:not([hidden])');
    assert.equal(await page.isDisabled('#pl-syncreset'), true);
    for (let i = 0; i < 3; i++) await page.click('#pl-synclater');
    assert.equal(await page.textContent('#pl-syncval'), '+150 ms');
    assert.match(await page.textContent('#pl-syncnote'), /150 ms dopo/);
    assert.equal(await page.textContent('#pl-syncbadge'), '+150 ms');
    const avSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('salotto:avsync')));
    assert.deepEqual(Object.values(avSaved), [150], 'sync saved for one channel');
    assert.match(Object.keys(avSaved)[0], /Rai 1|rai1/);
    if (SHOTS) await page.screenshot({ path: SHOTS + '/avsync.png' });
    // a native player (iPad) switches to hls.js so the sound can be moved
    if (wasNative) {
      await waitFor(async () => /rai1\.m3u8/.test(await page.evaluate(() => window.__hlsSrc)));
      await page.evaluate(() => { window.__hlsSrc = ''; });
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#pl-syncbox'), false, 'Escape closes the sync box first');
    assert.equal(await page.isVisible('#player'), true);
    await page.click('#pl-chup');
    await waitFor(async () => /la7\.m3u8/.test(await nowSrc()));
    assert.equal(await page.textContent('#pl-syncbadge'), '', 'another channel keeps its own sync (none)');
    await page.click('#pl-chdown');
    await waitFor(async () => /rai1\.m3u8/.test(await nowSrc()));
    assert.equal(await page.textContent('#pl-syncbadge'), '+150 ms', 'the channel remembers its sync');
    await page.click('#pl-sync');
    await page.click('#pl-syncearlier');
    assert.equal(await page.textContent('#pl-syncval'), '+100 ms');
    await page.click('#pl-syncreset');
    assert.equal(await page.textContent('#pl-syncval'), '0 ms');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('salotto:avsync'))), {}, 'Azzera forgets the channel sync');
    await page.click('#pl-syncclose');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#player'), false);
    await page.evaluate(() => { window.__hlsSrc = ''; });
    console.log('✓ audio/video sync: A/V button, steps, saved per channel, reset');

    // TV guide: grid of channels and times, OK on what is on opens the channel
    await page.evaluate(() => { location.hash = '#/guide'; });
    await page.waitForSelector('.guide .grow');
    const gnames = await page.locator('.gch-name').allTextContents();
    assert.deepEqual(gnames, ['Rai 1', 'La7'], 'guide rows: channels with a guide, matched by code or by name, one row per channel');
    assert.match(await page.locator('.grow').nth(1).locator('.gcell.on').textContent(), /Notiziario La7/);
    assert.match(await page.textContent('.guide-foot'), /1 canale non ha la guida/);
    if (SHOTS) await page.screenshot({ path: SHOTS + '/guide.png' });
    await page.locator('.grow').nth(1).locator('.gcell.on').click(); // tap on what is on: details first, no playback
    await page.waitForSelector('#modal:not([hidden])');
    assert.match(await page.textContent('#modal'), /Notiziario La7.*IN ONDA/s);
    assert.equal(await page.isHidden('#player'), true, 'tapping a programme does not start the channel');
    await page.click('#modal-actions .btn:not(.primary)');
    await page.waitForSelector('#modal', { state: 'hidden' });
    await page.locator('.grow').first().locator('.gcell:has-text("Film della sera")').click();
    await page.waitForSelector('#modal:not([hidden])');
    assert.match(await page.textContent('#modal'), /Film della sera/);
    await page.click('#modal-actions .btn.primary');
    await page.waitForSelector('#player:not([hidden])');
    await waitFor(async () => /rai1\.m3u8/.test(await nowSrc()));
    assert.match(await page.textContent('#pl-prog'), /Telegiornale di prova .*Poi: Film della sera/, 'player shows the programme on now');
    // ⓘ: whole description beside the video, which keeps playing
    const before = await nowSrc();
    await page.click('#pl-info');
    await page.waitForSelector('#pl-epg:not([hidden])');
    assert.match(await page.textContent('#pl-epg'), /Telegiornale di prova.*Notizie.*Film della sera/s);
    assert.equal(await nowSrc(), before, 'the stream keeps playing');
    if (SHOTS) await page.screenshot({ path: SHOTS + '/player-info.png' });
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#pl-epg'), true);
    assert.equal(await page.isVisible('#player'), true, 'closing the info keeps the player open');
    await page.keyboard.press('ArrowUp'); // zapping from the guide goes through the guide's channels
    await waitFor(async () => /la7\.m3u8/.test(await nowSrc()));
    assert.match(await page.textContent('#pl-prog'), /Notiziario La7/);
    await page.keyboard.press('Escape');
    // remote: ▼ keeps the time and moves to the next channel
    await page.locator('.grow').first().locator('.gcell.on').focus();
    await page.keyboard.press('ArrowDown');
    assert.match(await page.evaluate(() => document.activeElement.textContent), /Notiziario La7/);
    await page.keyboard.press('ArrowRight');
    assert.match(await page.evaluate(() => document.activeElement.textContent), /Talk della sera/);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#modal:not([hidden])');
    assert.match(await page.textContent('#modal'), /Ospiti in studio/, 'OK on a programme shows its description');
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.getElementById('modal')._close?.());
    await page.waitForSelector('#modal', { state: 'hidden' });
    // tapping a channel shows what is on now there
    await page.locator('.gch:has-text("La7")').click();
    await page.waitForSelector('#modal:not([hidden])');
    assert.match(await page.textContent('#modal'), /Notiziario La7.*Dopo, alle .*Talk della sera/s);
    assert.equal(await page.isHidden('#player'), true);
    assert.equal(await page.locator('.guide-info').count(), 0, 'no detail box above the grid');
    await page.evaluate(() => document.getElementById('modal')._close?.());
    console.log('✓ TV guide: grid, now/next in lists, player and channel list, remote navigation');
    await page.goBack();

    // Live rewind: the broadcaster's window (seekable range) drives the seek bar, ⟲10 and LIVE
    await page.locator('.row:has-text("Rai 1")').first().click();
    await page.waitForSelector('#player:not([hidden])');
    assert.equal(await page.isVisible('#pl-rew'), false, 'no rewind without a window');
    await page.evaluate(() => {
      const v = document.getElementById('video');
      let t = 400;
      Object.defineProperty(v, 'seekable', { configurable: true, get: () => ({ length: 1, start: () => 100, end: () => 400 }) });
      Object.defineProperty(v, 'currentTime', { configurable: true, get: () => t, set: (x) => { t = x; } });
      Object.defineProperty(v, 'duration', { configurable: true, get: () => Infinity });
      v.dispatchEvent(new Event('progress'));
    });
    assert.equal(await page.isVisible('#pl-rew'), true, 'rewind shown when the stream has a window');
    assert.equal((await page.textContent('#pl-dur')).trim(), 'LIVE');
    await page.click('#pl-rew'); await page.click('#pl-rew'); await page.click('#pl-rew');
    assert.equal(await page.evaluate(() => document.getElementById('video').currentTime), 370);
    assert.equal((await page.textContent('#pl-cur')).trim(), '−0:30');
    assert.match(await page.textContent('#pl-dur'), /LIVE ▶▶/);
    await page.click('#pl-dur');
    assert.ok(await page.evaluate(() => document.getElementById('video').currentTime) >= 395, 'LIVE jumps back to the live edge');
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('ArrowLeft');
    assert.ok(await page.evaluate(() => document.getElementById('video').currentTime) < 395, 'left arrow rewinds live TV');
    // Fire TV app: the remote's Back key closes the player (window.salottoBack)
    assert.equal(await page.evaluate(() => window.salottoBack()), true);
    assert.equal(await page.evaluate(() => document.getElementById('player').hidden), true);
    console.log('✓ live TV: rewind within the broadcaster window, LIVE button returns to the live edge');

    // Channel with Referer goes through the proxy
    await page.goBack();
    await page.waitForSelector('.row:has-text("News")');
    await page.click('.row:has-text("News")');
    await page.click('.row:has-text("Notizie 24")');
    const viaProxy = () => page.evaluate(() => [window.__hlsSrc || '', document.getElementById('video').src].find(u => u.includes('/proxy?url=')));
    await waitFor(viaProxy);
    assert.match(await viaProxy(), /headers=%7B%22Referer/);
    assert.equal(await page.textContent('#pl-route'), 'Proxy ⓘ', 'badge: proxied stream');
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

    // Proxy settings: a bare Cloudflare address plus token become a full proxy URL
    await page.goto(BASE + '#/settings');
    await page.waitForSelector('#proxy');
    await page.fill('#proxy', 'https://salotto-proxy.example.workers.dev/');
    await page.fill('#proxy-token', 'abc');
    await page.click('.btn:has-text("Salva")');
    await waitFor(() => page.evaluate(() => window.salotto.addons.getProxy() === 'https://salotto-proxy.example.workers.dev/proxy?token=abc&url='));
    await page.evaluate(() => window.salotto.store.setSettings({ proxyUrl: '', proxyToken: '' }));
    await page.evaluate(() => window.salotto.addons.detectProxy());
    console.log('✓ proxy settings accept a Cloudflare address and token');

    // Start page: 📌 on a channel list, relaunch on Home → opens there, ← goes back to Home
    await page.goto(BASE + '#/browse/plugin.video.iptv?p=p%2F0%2Fg%2FGeneralisti');
    await page.waitForSelector('#pin-btn:not([hidden])');
    await page.click('#pin-btn');
    assert.equal(await page.evaluate(() => window.salotto.store.getSettings().startPage), '#/browse/plugin.video.iptv?p=p%2F0%2Fg%2FGeneralisti');
    assert.equal(await page.evaluate(() => document.getElementById('pin-btn').classList.contains('active')), true);
    await page.goto(BASE + '#/');
    await page.reload();
    await page.waitForSelector('.row:has-text("Rai 1")');
    assert.match(page.url(), /#\/browse\/plugin\.video\.iptv/);
    await page.click('#back-btn');
    await page.waitForSelector('.hero');
    await page.goto(BASE + '#/settings');
    assert.equal(await page.inputValue('#startpage'), '#/browse/plugin.video.iptv?p=p%2F0%2Fg%2FGeneralisti');
    await page.selectOption('#startpage', '');
    await page.click('.actions .btn.primary');
    await waitFor(() => page.evaluate(() => window.salotto.store.getSettings().startPage === ''));
    console.log('✓ start page: 📌 sets it, the app opens there with Home behind, settings can reset it');

    // List order: by name, by channel number, manual (▲▼), survives source updates
    const G = BASE + '#/browse/plugin.video.iptv?p=p%2F0%2Fg%2FGeneralisti';
    const rowLabels = () => page.locator('#view .row-label').allTextContents();
    const sortDlg = async (value, button = 'OK') => {
      await page.click('#view-btn');
      await page.waitForSelector('#dlg-sort');
      if (value) await page.selectOption('#dlg-sort', value);
      await page.click(button === "OK" ? "#modal-actions button:has-text(\"OK\")" : `#modal-body button:has-text("${button}")`);
    };
    await page.goto(G);
    await page.waitForSelector('.row:has-text("La7")');
    const source = await rowLabels();
    await sortDlg('name');
    await waitFor(async () => { const l = await rowLabels(); return l.indexOf('7La7') >= 0 && l.indexOf('7La7') < l.indexOf('1Rai 1'); });
    await sortDlg('number');
    await waitFor(async () => (await rowLabels()).slice(0, 3).join('|') === '1Rai 1|7La7|8Rai 1');
    // manual: move the first channel down one place
    await sortDlg('', 'Riordina a mano');
    await page.waitForSelector('.reorder-row');
    await page.locator('.reorder-row').first().locator('button[aria-label="Giù"]').click();
    await page.click('.reorder-bar button:has-text("Fatto")');
    await waitFor(async () => (await rowLabels()).slice(0, 2).join('|') === '7La7|1Rai 1');
    const sortCfg = await page.evaluate(() => Object.values(window.salotto.store.load('sort', {}))[0]);
    assert.equal(sortCfg.mode, 'custom');
    // source updated: the saved order is matched by channel key (an old order saved by address is
    // migrated), channels missing from the list are remembered, new ones go next to their source
    // neighbour and are marked NUOVO
    await page.evaluate(() => {
      const all = window.salotto.store.load('sort', {}); const k = Object.keys(all)[0];
      all[k] = { mode: 'custom', order: ['https://www.youtube.com/user/euronewsit/live', 'https://example.org/live/la7.m3u8', 'https://example.org/gone.m3u8'] };
      window.salotto.store.save('sort', all);
    });
    await page.reload();
    await page.waitForSelector('.row:has-text("La7")');
    const after = await rowLabels();
    assert.deepEqual(after.map(l => l.replace(/^\d+/, '')), ['Rai 1NUOVO', 'Euronews', 'Rai 1NUOVO', 'La7'], 'saved order kept, new channels next to their source neighbour: ' + after.join('|'));
    const cfg2 = await page.evaluate(() => Object.values(window.salotto.store.load('sort', {}))[0]);
    assert.deepEqual(cfg2.order, ['n:euronews', 'id:la7.it', 'https://example.org/gone.m3u8'], 'order migrated to channel keys, missing channel remembered');
    assert.ok(cfg2.gone['https://example.org/gone.m3u8'], 'missing channel tracked');
    // the original list can be shown without losing the custom order, which can then be deleted
    await sortDlg('source');
    await waitFor(async () => (await rowLabels()).join('|') === source.join('|'));
    assert.equal((await page.evaluate(() => Object.values(window.salotto.store.load('sort', {}))[0])).order.length, 3, 'custom order kept while the original list is shown');
    await page.click('#view-btn');
    await page.waitForSelector('#dlg-sort');
    await page.click('#modal-body button:has-text("Cancella il mio ordine")');
    await page.waitForSelector('#modal-title:has-text("Cancellare il tuo ordine?")');
    await page.click('#modal-actions button:has-text("Cancella")');
    await waitFor(async () => Object.keys(await page.evaluate(() => window.salotto.store.load('sort', {}))).length === 0);
    console.log('✓ list order: by name, by number, manual, kept when the source list changes, original list and reset');

    // Keyboard / remote navigation
    await page.goto(BASE + '#/');
    await page.waitForSelector('.hero');
    await page.keyboard.press('ArrowDown');
    const f1 = await page.evaluate(() => document.activeElement.textContent);
    await page.keyboard.press('ArrowRight');
    const f2 = await page.evaluate(() => document.activeElement.textContent);
    assert.ok(f1 && f2 && f1 !== f2, `focus moved: ${f1} -> ${f2}`);
    console.log('✓ arrow-key navigation moves focus');

    // Favourites can be ordered too
    await page.evaluate(() => window.salotto.store.save('favourites', [
      { key: 'u|https://example.org/b.m3u8', item: { label: 'Bravo', url: 'https://example.org/b.m3u8', playable: true } },
      { key: 'u|https://example.org/a.m3u8', item: { label: 'Alfa', url: 'https://example.org/a.m3u8', playable: true } },
      { key: 'u|https://example.org/c.m3u8', item: { label: 'Charlie', url: 'https://example.org/c.m3u8', playable: true } },
    ]));
    await page.goto(BASE + '#/favourites');
    await page.waitForSelector('.row:has-text("Bravo")');
    assert.deepEqual(await rowLabels(), ['Bravo', 'Alfa', 'Charlie']);
    await sortDlg('name');
    await waitFor(async () => (await rowLabels()).join('|') === 'Alfa|Bravo|Charlie');
    await sortDlg('', 'Riordina a mano');
    await page.waitForSelector('.reorder-row');
    await page.locator('.reorder-row').last().locator('button[aria-label="Su"]').click();
    await page.click('.reorder-bar button:has-text("Fatto")');
    await waitFor(async () => (await rowLabels()).join('|') === 'Alfa|Charlie|Bravo');
    console.log('✓ favourites: by name and in a custom order');

    // Playlist updates: summary after a manual update, last good copy when the download fails
    {
      const uc = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      await mock(uc);
      let body = M3U, fail = false;
      await uc.route(/^https:\/\/(raw\.githubusercontent\.com|iptv-org\.github\.io)\//, r => fail
        ? r.fulfill({ status: 500, body: '' })
        : r.fulfill({ status: 200, contentType: 'audio/x-mpegurl', body, headers: { 'access-control-allow-origin': '*' } }));
      const up = await uc.newPage();
      await up.goto(G);
      await up.waitForSelector('.row:has-text("La7")');
      body = M3U.replace('https://example.org/live/la7.m3u8', 'https://example.org/live/la7-new.m3u8')
        + '#EXTINF:-1 group-title="Generalisti",Canale Nuovo\nhttps://example.org/live/nuovo.m3u8\n';
      await up.click('#view-btn');
      await up.waitForSelector('#dlg-sort');
      assert.match(await up.textContent('#modal-body'), /Scaricata oggi alle/);
      if (SHOTS) await up.screenshot({ path: SHOTS + '/sort-dialog.png' });
      await up.click('#modal-body button:has-text("Aggiorna la lista adesso")');
      await up.waitForSelector('.list-notice:has-text("Lista aggiornata: 1 nuovo, 1 con indirizzo cambiato.")');
      await up.waitForSelector('.row:has-text("Canale Nuovo")');
      if (SHOTS) await up.screenshot({ path: SHOTS + '/list-updated.png' });
      fail = true;
      await up.reload();
      await up.waitForSelector('.row:has-text("Canale Nuovo")'); // the saved copy
      await up.waitForSelector('.list-notice.warn:has-text("Non ho potuto aggiornare la lista")');
      await uc.close();
      console.log('✓ playlist updates: manual update with summary, last good copy kept when the download fails');
    }

    // Fire TV app (user agent "SalottoTV"): remote-control navigation
    {
      const tvc = await browser.newContext({ viewport: { width: 960, height: 540 }, isMobile: true, serviceWorkers: 'block',
        userAgent: 'Mozilla/5.0 (Linux; Android 9; AFTSSS) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 SalottoTV/1' });
      await mock(tvc);
      const tv = await tvc.newPage();
      await tv.goto(BASE + '#/settings');
      await tv.waitForSelector('#proxy');
      const focusedTag = () => tv.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
      assert.notEqual(await focusedTag(), 'proxy', 'TV: settings do not start inside a text field');
      await tv.focus('#proxy');
      await tv.keyboard.press('ArrowLeft');
      assert.notEqual(await focusedTag(), 'proxy', 'TV: the arrow leaves an empty text field');
      // ▲▼ stay in the side menu; only ◀▶ cross to the page
      await tv.goto(BASE + '#/');
      await tv.waitForSelector('.hero');
      await tv.evaluate(() => document.querySelector('.menu-item:last-child').focus());
      await tv.keyboard.press('ArrowDown');
      assert.equal(await tv.evaluate(() => !!document.activeElement.closest('#sidebar')), true, 'TV: ▼ at the end of the menu stays there');
      await tv.evaluate(() => document.querySelector('.menu-item').focus());
      await tv.keyboard.press('ArrowUp');
      assert.equal(await tv.evaluate(() => !!document.activeElement.closest('#sidebar')), true, 'TV: ▲ at the top of the menu stays there');
      await tv.keyboard.press('ArrowRight');
      assert.equal(await tv.evaluate(() => !!document.activeElement.closest('#main')), true, 'TV: ▶ goes to the page');
      const mh = await tv.evaluate(() => { const m = document.getElementById('menu'); return m.scrollHeight - m.clientHeight; });
      assert.ok(mh <= 1, 'TV: the whole side menu fits on screen');
      await tv.goto(BASE + '#/browse/plugin.video.iptv?p=p%2F0%2Fg%2FGeneralisti');
      await tv.waitForSelector('.row:has-text("La7")');
      await tv.click('.row:has-text("Rai 1") >> nth=0');
      await tv.waitForSelector('#player:not([hidden])');
      const tvTitle = () => tv.textContent('#pl-title');
      const t0 = await tvTitle();
      // controls shown: ▲ moves to the top bar instead of changing channel
      await tv.keyboard.press('ArrowUp');
      assert.equal(await tvTitle(), t0, 'TV: arrows move between controls while they are shown');
      assert.equal(await tv.evaluate(() => !!document.activeElement.closest('.player-top')), true, 'TV: ▲ reaches the top bar');
      // Back hides the controls; then ▲ changes channel
      assert.equal(await tv.evaluate(() => window.salottoBack()), true);
      assert.equal(await tv.evaluate(() => document.getElementById('player-ui').classList.contains('idle')), true);
      assert.equal(await tv.evaluate(() => getComputedStyle(document.querySelector('#player video')).cursor), 'none', 'hidden controls hide the mouse pointer too');
      await tv.keyboard.press('ArrowUp');
      await waitFor(async () => (await tvTitle()) !== t0);
      const t1 = await tvTitle();
      assert.equal(await tv.evaluate(() => document.getElementById('player-ui').classList.contains('idle')), true, 'TV: zapping keeps the controls hidden');
      await tv.keyboard.press('ArrowUp');
      await waitFor(async () => (await tvTitle()) !== t1);
      // the new channel starting to play does not bring the controls back
      await tv.evaluate(() => { const v = document.querySelector('#player video'); v.dispatchEvent(new Event('playing')); v.dispatchEvent(new Event('pause')); });
      assert.equal(await tv.evaluate(() => document.getElementById('player-ui').classList.contains('idle')), true, 'TV: a channel starting does not show the controls');
      // the menu key opens the channel list
      await tv.keyboard.press('ContextMenu');
      await tv.waitForSelector('#pl-channels:not([hidden])');
      assert.equal(await tv.evaluate(() => innerWidth), 1280, 'TV: page laid out on 1280 px');
      // ▲ from the first channel reaches the channel-number box
      await tv.evaluate(() => document.querySelector('.ch-row').focus());
      await tv.keyboard.press('ArrowUp');
      assert.equal(await focusedTag(), 'pl-chnum', 'TV: ▲ from the first channel reaches the number box');
      await tv.keyboard.press('ArrowDown');
      assert.equal(await tv.evaluate(() => document.activeElement.classList.contains('ch-row')), true, 'TV: ▼ from the number box goes back to the list');
      await tv.evaluate(() => window.salottoBack());
      assert.equal(await tv.isHidden('#pl-channels'), true);
      // full screen / volume buttons make no sense on the TV; ▶ on the position bar reaches LIVE
      assert.equal(await tv.isHidden('#pl-fs'), true, 'TV: no full screen button');
      assert.equal(await tv.isHidden('#pl-vol'), true, 'TV: no volume slider');
      await tv.evaluate(() => { const s = document.getElementById('pl-seek'); s.disabled = false; s.focus(); });
      await tv.keyboard.press('ArrowRight');
      assert.equal(await focusedTag(), 'pl-dur', 'TV: ▶ on the position bar goes to the LIVE button');
      // TV guide with the remote: opens on what is on now, ◀ from the first programme reaches the menu
      await tv.evaluate(() => window.salottoBack());
      await tv.evaluate(() => { location.hash = '#/guide'; });
      await tv.waitForSelector('.guide .gcell');
      await tv.waitForFunction(() => document.activeElement?.classList.contains('gcell'));
      assert.match(await tv.evaluate(() => document.activeElement.textContent), /Telegiornale di prova/, 'TV guide: focus starts on what is on now');
      if (SHOTS) await tv.screenshot({ path: SHOTS + '/tv-guide.png' });
      await tv.keyboard.press('ArrowLeft');
      assert.equal(await tv.evaluate(() => document.activeElement.classList.contains('gch')), true, 'TV guide: ◀ from the first programme goes to the channel');
      await tv.keyboard.press('ArrowLeft');
      assert.equal(await tv.evaluate(() => !!document.activeElement.closest('#sidebar')), true, 'TV guide: ◀ from the channel goes to the menu');
      await tvc.close();
      console.log('✓ Fire TV app: no auto-focused text field, arrows leave fields, player controls reachable, Back hides controls, menu column, quiet zapping');
    }

    // Desktop Chrome: extension-less broadcaster links go through hls.js
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await mock(desktop);
    // Picture-in-picture stub (headless Chromium has no real floating window)
    await desktop.addInitScript(() => {
      Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', { get: () => true, configurable: true });
      let pipEl = null; window.__pip = 0;
      Object.defineProperty(Document.prototype, 'pictureInPictureElement', { get: () => pipEl, configurable: true });
      HTMLVideoElement.prototype.requestPictureInPicture = function () { pipEl = this; window.__pip++; this.dispatchEvent(new Event('enterpictureinpicture')); return Promise.resolve({}); };
      const play0 = HTMLMediaElement.prototype.play; window.__plays = 0;
      HTMLMediaElement.prototype.play = function () { window.__plays++; return play0.call(this); };
      Document.prototype.exitPictureInPicture = function () { const e = pipEl; pipEl = null; e && e.dispatchEvent(new Event('leavepictureinpicture')); return Promise.resolve(); };
    });
    const p3 = await desktop.newPage();
    await p3.goto(BASE + '#/browse/plugin.video.iptv?p=p%2F0%2Fg%2FGeneralisti');
    await p3.waitForSelector('.row:has-text("Solo dall\'Italia")');
    await p3.click('.row:has-text("Rai 1"):has-text("Solo dall\'Italia")');
    await waitFor(() => p3.evaluate(() => (window.__hlsSrc || '').includes('relinkerServlet')));
    assert.equal(await p3.textContent('#pl-route'), 'Diretto ⓘ', 'badge: direct stream');
    // tapping the badge shows the stream details, tapping them hides them
    await p3.click('#pl-route');
    await p3.waitForSelector('#pl-stats:not([hidden])');
    const stats = await p3.textContent('#pl-stats');
    assert.match(stats, /Motore\s*hls\.js/); assert.match(stats, /Percorso\s*Diretto/); assert.match(stats, /Buffer/); assert.match(stats, /Canale\s*\d+ · Rai 1/);
    await p3.click('#pl-stats');
    assert.equal(await p3.isHidden('#pl-stats'), true);
    console.log('✓ desktop: extension-less live links are played with hls.js');

    // Floating window (picture-in-picture): button toggles it, closing the player leaves it
    await p3.waitForSelector('#pl-pip:not([hidden])');
    await p3.click('#pl-pip');
    await waitFor(() => p3.evaluate(() => window.__pip === 1 && document.getElementById('pl-pip').classList.contains('active')));
    // back to the app from the window: the browser pauses the video, the app resumes it
    const plays0 = await p3.evaluate(() => { const v = document.getElementById('video'); v.pause(); document.exitPictureInPicture(); return window.__plays; });
    await waitFor(() => p3.evaluate((n) => window.__plays > n && !document.getElementById('pl-pip').classList.contains('active'), plays0));
    await p3.click('#pl-pip');
    await p3.click('#pl-pip');
    await waitFor(() => p3.evaluate(() => !document.pictureInPictureElement && !document.getElementById('pl-pip').classList.contains('active')));
    console.log('✓ picture-in-picture: the player button opens and closes the floating window, playback resumes when returning to the app');

    // Google Cast: the TV gets the proxied stream, zapping follows on the TV, controls drive it
    // (Rai 1 served as an fMP4 master playlist so the segment format is detected for the receiver)
    await desktop.route(/\/proxy\?url=[^&]*relinkerServlet/, r => r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nproxy?url=' + encodeURIComponent('https://cdn.example.net/v/media.m3u8') + '\n' }));
    await desktop.route(/\/proxy\?url=[^&]*media\.m3u8/, r => r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nproxy?url=' + encodeURIComponent('https://cdn.example.net/v/s1.m4s?x=1') + '\n' }));
    await p3.waitForSelector('#pl-cast:not([hidden])');
    await p3.click('#pl-cast');
    await waitFor(() => p3.evaluate(() => window.__castLoads.length === 1));
    let loads = await p3.evaluate(() => window.__castLoads);
    assert.match(loads[0][0], /^http:\/\/127\.0\.0\.1:\d+\/proxy\?url=.*relinkerServlet/, 'cast URL goes through the proxy, absolute');
    assert.deepEqual(loads[0].slice(1), ['application/x-mpegurl', 'LIVE', 'Rai 1', 'fmp4', 'fmp4'], 'fMP4 segment format detected for the receiver');
    assert.match(await p3.textContent('#pl-msg'), /In riproduzione su TV Salotto/);
    assert.equal(await p3.textContent('#pl-route'), 'TV · Proxy ⓘ', 'badge: the TV gets the stream through the proxy');
    assert.equal(await p3.evaluate(() => document.getElementById('player').classList.contains('casting')), true);
    await p3.click('#pl-chdown');
    await waitFor(() => p3.evaluate(() => window.__castLoads.length === 2));
    loads = await p3.evaluate(() => window.__castLoads);
    assert.match(loads[1][3], /La7/, 'zapping sends the new channel to the TV');
    // the receiver failing (logo stays on the TV) is reported in the app
    await p3.evaluate(() => window.__castError());
    assert.match(await p3.textContent('#pl-msg'), /La TV non riesce a riprodurre/);
    await p3.click('#pl-play');
    assert.equal(await p3.evaluate(() => window.__castPP), 1, 'play/pause drives the TV');
    await p3.click('#pl-close');
    assert.equal(await p3.evaluate(() => window.__castStopped), 1, 'closing stops the TV');
    await p3.evaluate(() => window.__endCast());
    assert.equal(await p3.evaluate(() => document.getElementById('player').classList.contains('casting')), false);
    console.log('✓ Google Cast: proxied stream sent to the TV, zapping and controls follow');

    // Portrait layout (bottom bar)
    const portrait = await browser.newContext({ ...devices['iPad Mini'], serviceWorkers: 'block' });
    await mock(portrait);
    const p2 = await portrait.newPage();
    await p2.goto(BASE);
    await p2.waitForSelector('.hero');
    const dir = await p2.evaluate(() => getComputedStyle(document.getElementById('app')).flexDirection);
    assert.equal(dir, 'column-reverse');
    if (SHOTS) await p2.screenshot({ path: SHOTS + '/portrait.png' });
    // AirPlay: WebKit's picker opens from the cast button
    await p2.goto(BASE + '#/browse/plugin.video.demo?p=films');
    // the listener is attached at start-up only when WebKit has AirPlay: emulate a fresh start with it
    await p2.addInitScript(() => { window.WebKitPlaybackTargetAvailabilityEvent = function () {}; });
    await p2.reload();
    await p2.waitForSelector('.card');
    await p2.locator('.card').first().click();
    await p2.waitForSelector('#player:not([hidden])');
    await p2.evaluate(() => {
      const v = document.getElementById('video');
      window.__picker = 0; v.webkitShowPlaybackTargetPicker = () => { window.__picker++; };
      const e = new Event('webkitplaybacktargetavailabilitychanged'); e.availability = 'available'; v.dispatchEvent(e);
    });
    await p2.click('#pl-cast');
    assert.equal(await p2.evaluate(() => window.__picker), 1, 'AirPlay picker opens');
    console.log('✓ AirPlay: the cast button opens the AirPlay picker on Apple devices');

    // Phones: the list area must scroll with a finger swipe (bug seen on Android)
    for (const name of ['Pixel 7', 'iPhone 13']) {
      const phone = await browser.newContext({ ...devices[name], serviceWorkers: 'block' });
      await mock(phone);
      const pp = await phone.newPage();
      await pp.goto(BASE);
      await pp.waitForSelector('.hero');
      const dims = await pp.evaluate(() => { const v = document.getElementById('view'); return [v.clientHeight, v.scrollHeight, document.getElementById('sidebar').getBoundingClientRect().bottom <= innerHeight + 1]; });
      assert.ok(dims[1] > dims[0], `${name}: content taller than the viewport (${dims})`);
      assert.ok(dims[2], `${name}: bottom menu visible`);
      const menu = await pp.evaluate(() => {
        const m = document.getElementById('menu');
        const items = [...m.querySelectorAll('.menu-item')];
        return { fits: m.scrollWidth <= m.clientWidth + 1, inside: items.every(i => i.getBoundingClientRect().bottom <= innerHeight + 1),
          oneLine: items.every(i => i.querySelector('.lbl-short').getBoundingClientRect().height < 20) };
      });
      assert.deepEqual(menu, { fits: true, inside: true, oneLine: true }, `${name}: bottom menu fits on one line`);
      await pp.evaluate(() => window.scrollTo(0, 120));
      await pp.waitForTimeout(50);
      assert.equal(await pp.evaluate(() => window.scrollY), 0, `${name}: the page itself never scrolls`);
      const cdp = await phone.newCDPSession(pp);
      const y0 = Math.round(await pp.evaluate(() => innerHeight * 0.6));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: y0 }] });
      for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: y0 - i * 25 }] }); await pp.waitForTimeout(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await pp.waitForTimeout(200);
      assert.ok(await pp.evaluate(() => document.getElementById('view').scrollTop) > 0, `${name}: list scrolls`);
      if (name === 'Pixel 7') {
        // Full screen video locks landscape; leaving full screen unlocks it
        await pp.evaluate(() => {
          window.__orient = [];
          const o = screen.orientation;
          o.lock = (v) => { window.__orient.push('lock:' + v); return Promise.resolve(); };
          o.unlock = () => { window.__orient.push('unlock'); };
        });
        await pp.goto(BASE + '#/browse/plugin.video.demo?p=films');
        await pp.waitForSelector('.card');
        await pp.locator('.card').first().click();
        await pp.waitForSelector('#player:not([hidden])');
        await pp.waitForTimeout(500); // let the player's own start-up play() happen first
        // Android: the video opens full screen by itself (for the automatic floating window), still portrait
        assert.equal(await pp.evaluate(() => document.fullscreenElement === document.documentElement), true, 'Android opens videos full screen');
        assert.ok(!(await pp.evaluate(() => window.__orient.includes('lock:landscape'))), 'automatic full screen keeps the orientation');
        // Tapping the picture shows/hides the controls without pausing
        await pp.evaluate(() => {
          window.__media = [];
          HTMLMediaElement.prototype.play = function () { window.__media.push('play'); return Promise.resolve(); };
          HTMLMediaElement.prototype.pause = function () { window.__media.push('pause'); };
        });
        const ui = () => pp.evaluate(() => document.getElementById('player-ui').classList.contains('idle'));
        assert.equal(await ui(), false);
        await pp.touchscreen.tap(180, 300);
        assert.equal(await ui(), true, 'tap hides controls');
        await pp.touchscreen.tap(180, 300);
        assert.equal(await ui(), false, 'second tap shows controls');
        assert.deepEqual(await pp.evaluate(() => window.__media), [], 'taps do not pause or play');
        await pp.touchscreen.tap(180, 300);
        const box = await pp.locator('#pl-play').boundingBox();
        await pp.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        assert.equal(await ui(), false, 'tapping where the hidden play button is only shows the controls');
        assert.deepEqual(await pp.evaluate(() => window.__media), []);
        await pp.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        assert.equal((await pp.evaluate(() => window.__media)).length, 1, 'play button works once visible');
        await pp.click('#pl-fs');
        await waitFor(() => pp.evaluate(() => window.__orient.includes('lock:landscape')));
        assert.equal(await pp.evaluate(() => !!document.fullscreenElement), true, 'the full screen button turns it landscape, stays full screen');
        assert.equal(await pp.getAttribute('#pl-fs', 'aria-label'), 'Ruota in verticale');
        await pp.click('#pl-fs');
        await waitFor(() => pp.evaluate(() => window.__orient.includes('lock:portrait')));
        assert.equal(await pp.getAttribute('#pl-fs', 'aria-label'), 'Ruota in orizzontale');
        await pp.evaluate(() => document.exitFullscreen());
        await waitFor(() => pp.evaluate(() => window.__orient.includes('unlock')));
        // full screen lost: a tap on the picture brings the automatic full screen back
        await pp.touchscreen.tap(180, 300);
        await waitFor(() => pp.evaluate(() => document.fullscreenElement === document.documentElement));
        await pp.click('#pl-close');
        // automatic mode: the app stays full screen after closing the video (Chrome's notice shows once)
        assert.equal(await pp.evaluate(() => document.fullscreenElement === document.documentElement), true, 'stays full screen between videos');
        // Live TV: a vertical swipe on the picture changes channel
        await pp.goto(BASE + '#/browse/plugin.video.iptv?p=p%2F0%2Fg%2FGeneralisti');
        await pp.waitForSelector('.row:has-text("La7")');
        await pp.locator('.row:has-text("Rai 1")').first().click();
        await pp.waitForSelector('#player:not([hidden])');
        const before = (await pp.evaluate(() => window.__media)).length;
        const swipeUp = async () => {
          const x = 180, y = Math.round(await pp.evaluate(() => innerHeight * 0.65));
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 20 }] }); await pp.waitForTimeout(16); }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        };
        // a swipe from the bottom edge (Android's home gesture) does not change channel
        {
          const x = 180, y = Math.round(await pp.evaluate(() => innerHeight - 10));
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 30 }] }); await pp.waitForTimeout(16); }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await pp.waitForTimeout(400);
          assert.equal(await pp.evaluate(() => document.getElementById('pl-title').textContent), '1  Rai 1', 'edge swipe ignored');
        }
        await swipeUp();
        await waitFor(() => pp.evaluate(() => document.getElementById('pl-title').textContent === '7  La7'));
        assert.ok(await pp.isVisible('#pl-chup'));
        assert.equal((await pp.evaluate(() => window.__media)).slice(before).filter(m => m === 'pause').length, 0, 'swipe does not pause');
      }
      await phone.close();
    }
    console.log('✓ phones: tap shows/hides player controls; swipe changes live channel; Android opens videos full screen; full screen button locks landscape');
    console.log('✓ phones (Android, iPhone): lists scroll with a swipe');
    console.log('✓ portrait layout uses a bottom menu bar');

    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    server.kill();
  }
}

await proxyTests();
await workerTests();
await uiTests();
console.log('\nTutti i test sono passati.');
