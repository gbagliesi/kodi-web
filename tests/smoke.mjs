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
    assert.equal(installed.length, 5, 'bundled add-ons installed: ' + installed);
    console.log('✓ app boots and installs bundled add-ons:', installed.join(', '));
    // An outdated add-on from the official repository is updated on the next start
    await page.evaluate(() => {
      const k = 'salotto:addons'; const m = JSON.parse(localStorage.getItem(k));
      m['plugin.video.iptv'].manifest.version = '1.0.0'; localStorage.setItem(k, JSON.stringify(m));
    });
    await page.reload();
    await page.waitForSelector('.hero');
    assert.equal(await page.evaluate(() => window.salotto.addons.getInstalled('plugin.video.iptv').manifest.version), '1.3.2');
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
    console.log('✓ live TV: Italian presets, groups, EPG now/next, geo/YouTube marks, HLS playback');

    // Zapping: CH +/−, arrows, typed numbers and the channel list, without leaving the player
    const nowSrc = () => page.evaluate(() => window.__hlsSrc || document.getElementById('video').src);
    const title = () => page.evaluate(() => document.getElementById('pl-title').textContent);
    assert.equal(await page.isVisible('#pl-chup'), true, 'CH + visible for live channels');
    assert.equal(await page.isVisible('#pl-rew'), false, 'rewind hidden for live channels');
    await page.keyboard.press('ArrowUp');
    await waitFor(async () => /la7\.m3u8/.test(await nowSrc()));
    assert.equal(await title(), 'La7');
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
    const rows = await page.locator('.ch-row').allTextContents();
    assert.deepEqual(rows, ['1Rai 1', '7La7', '8Rai 1'], 'channel list: broadcast numbers, YouTube channels left out');
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
    await page.click('#pl-close');
    console.log('✓ live TV: rewind within the broadcaster window, LIVE button returns to the live edge');

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
        assert.equal(await pp.evaluate(() => document.fullscreenElement?.id), 'player', 'Android opens videos full screen');
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
        assert.equal(await pp.evaluate(() => document.fullscreenElement?.id), 'player', 'the full screen button turns it landscape, stays full screen');
        assert.equal(await pp.getAttribute('#pl-fs', 'aria-label'), 'Ruota in verticale');
        await pp.click('#pl-fs');
        await waitFor(() => pp.evaluate(() => window.__orient.includes('lock:portrait')));
        assert.equal(await pp.getAttribute('#pl-fs', 'aria-label'), 'Ruota in orizzontale');
        await pp.evaluate(() => document.exitFullscreen());
        await waitFor(() => pp.evaluate(() => window.__orient.includes('unlock')));
        await pp.click('#pl-close');
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
          assert.equal(await pp.evaluate(() => document.getElementById('pl-title').textContent), 'Rai 1', 'edge swipe ignored');
        }
        await swipeUp();
        await waitFor(() => pp.evaluate(() => document.getElementById('pl-title').textContent === 'La7'));
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
