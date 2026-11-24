// Phone remote end to end: a screen (desktop browser) and a phone talk through the relay of
// cloudflare/worker.js. The relay's Durable Object (RemoteRoom) runs here in Node, wired to the
// browsers' WebSockets with Playwright's routeWebSocket; external services are mocked.
// Run: NODE_PATH=$(npm root -g) node tests/remote.mjs   (SHOTS=dir saves screenshots)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}/`;
const RELAY = 'https://relay.example';
const SHOTS = process.env.SHOTS || '';

const M3U = `#EXTM3U
#EXTINF:-1 tvg-id="Rai1.it" group-title="Generalisti",Rai 1
https://example.org/live/rai1.m3u8
#EXTINF:-1 tvg-id="La7.it" group-title="Generalisti",La7
https://example.org/live/la7.m3u8
#EXTINF:-1 tvg-id="" group-title="News",Notizie 24
https://example.org/live/news.m3u8
`;
const xt = (min) => {
  const d = new Date(Date.now() + min * 60000), p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
};
const EPG = `<?xml version="1.0"?><tv>
<programme start="${xt(-30)}" stop="${xt(30)}" channel="Rai1.it"><title>Telegiornale di prova</title><desc>Notizie del giorno</desc></programme>
<programme start="${xt(30)}" stop="${xt(90)}" channel="Rai1.it"><title>Film della sera</title></programme>
<programme start="${xt(-40)}" stop="${xt(20)}" channel="La7.it"><title>Notiziario La7</title></programme>
</tv>`;
function buildGuide() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salotto-epg-'));
  fs.writeFileSync(path.join(dir, 'it.xml'), EPG);
  execFileSync(process.execPath, [path.join(ROOT, 'tools/build-epg.mjs'), path.join(dir, 'it.json'), path.join(dir, 'it.xml')], { env: { ...process.env, EPG_MIN_CHANNELS: '1' } });
  return fs.readFileSync(path.join(dir, 'it.json'), 'utf8');
}
const GUIDE = buildGuide();

const { default: worker, RemoteRoom } = await import(path.join(ROOT, 'cloudflare/worker.js'));

// ---------------------------------------------------------------- the relay, as on Cloudflare
function fakeCtx() {
  const socks = [];
  return {
    socks,
    acceptWebSocket(ws, tags) { ws.tags = tags; socks.push(ws); },
    getWebSockets(tag) { return socks.filter(s => !s.closed && (!tag || s.tags.includes(tag))); },
    getTags(ws) { return ws.tags; },
  };
}
const rooms = new Map();
const REMOTE = {
  idFromName: (n) => n,
  get: (id) => { if (!rooms.has(id)) rooms.set(id, new RemoteRoom(fakeCtx())); return rooms.get(id); },
};
const env = { TOKEN: 'tok', REMOTE };

/** A browser WebSocket (Playwright route) connected to the Worker. */
async function bridge(route) {
  const url = route.url().replace(/^ws/, 'http');
  let server = null;
  const realPair = globalThis.WebSocketPair, RealResponse = globalThis.Response;
  globalThis.WebSocketPair = function () {
    server = { closed: false, send: (m) => { if (!server.closed) route.send(m); }, close: (code) => { server.closed = true; try { route.close({ code }); } catch { /* gone */ } } };
    return { 0: {}, 1: server };
  };
  globalThis.Response = class extends RealResponse {
    constructor(body, init = {}) { if (init.status === 101) { super(null, { status: 200 }); this.upgraded = true; } else super(body, init); }
  };
  let res;
  try { res = await worker.fetch(new Request(url, { headers: { Upgrade: 'websocket' } }), env); } finally { globalThis.WebSocketPair = realPair; globalThis.Response = RealResponse; }
  if (!res.upgraded) { route.close({ code: 1008, reason: await res.text() }); return; }
  const room = REMOTE.get(new URL(url).searchParams.get('room'));
  route.onMessage((m) => { if (m === 'ping') route.send('pong'); else room.webSocketMessage(server, m); });
  route.onClose((code) => { if (server.closed) return; server.closed = true; room.webSocketClose(server, code); });
}

async function workerUnit() {
  const W = 'https://salotto-proxy.example.workers.dev';
  const call = (q, e) => worker.fetch(new Request(W + q), e);
  assert.equal((await call('/remote/health', {})).status, 501, 'no Durable Object binding: 501');
  assert.equal(await (await call('/remote/health', env)).text(), 'ok');
  assert.equal((await call('/remote/ws?room=abcdefghijklmnopqrstuv&role=tv', env)).status, 401, 'token required');
  assert.equal((await call('/remote/ws?token=tok&room=short&role=tv', env)).status, 400, 'room id checked');
  // relay: the TV's messages go to the remotes and back, never to the sender's own side
  const room = new RemoteRoom(fakeCtx());
  const sock = (tag) => { const s = { got: [], closed: false, send: (m) => s.got.push(m), close() { s.closed = true; } }; room.ctx.acceptWebSocket(s, [tag]); return s; };
  const tv = sock('tv'), r1 = sock('remote'), r2 = sock('remote');
  room.webSocketMessage(r1, '{"t":"cmd","c":"zap"}');
  room.webSocketMessage(tv, '{"t":"state"}');
  assert.deepEqual(tv.got, ['{"t":"cmd","c":"zap"}']);
  assert.deepEqual(r1.got, ['{"t":"state"}']);
  assert.deepEqual(r2.got, ['{"t":"state"}']);
  room.webSocketClose(r2, 1006);
  assert.equal(r2.closed, true);
  assert.deepEqual(JSON.parse(tv.got.at(-1)), { t: 'peers', tv: 1, remotes: 1 });
  console.log('✓ worker: remote relay (health, token, room id, TV ↔ phones)');
}

async function mock(context) {
  await context.route(BASE + 'epg/it.json', r => r.fulfill({ status: 200, contentType: 'application/json', body: GUIDE }));
  await context.route(RELAY + '/remote/health', r => r.fulfill({ status: 200, body: 'ok', headers: { 'access-control-allow-origin': '*' } }));
  // add-on downloads, direct or through the proxy
  await context.route(/^https:\/\/(raw\.githubusercontent\.com|iptv-org\.github\.io)\//, r => r.fulfill({ status: 200, contentType: 'audio/x-mpegurl', body: M3U, headers: { 'access-control-allow-origin': '*' } }));
  await context.route(RELAY + '/proxy**', (r) => {
    const target = new URL(r.request().url()).searchParams.get('url') || '';
    if (/raw\.githubusercontent\.com|iptv-org\.github\.io/.test(target)) return r.fulfill({ status: 200, contentType: 'audio/x-mpegurl', body: M3U, headers: { 'access-control-allow-origin': '*' } });
    if (target === '' && /\/proxy\/health/.test(r.request().url())) return r.fulfill({ status: 200, body: 'ok', headers: { 'access-control-allow-origin': '*' } });
    return r.fulfill({ status: 404, body: '', headers: { 'access-control-allow-origin': '*' } });
  });
  await context.route(/^https:\/\/(example\.org|de1\.api\.radio-browser\.info|archive\.org|www\.gstatic\.com)\//, r => r.fulfill({ status: 404, body: '' }));
  await context.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.Hls={isSupported:()=>true,Events:{ERROR:"e"},ErrorTypes:{},prototype:{}};window.Hls=Object.assign(function(){return{on(){},loadSource(u){window.__hlsSrc=u},attachMedia(){},destroy(){},stopLoad(){},startLoad(){}}},window.Hls);' }));
  await context.routeWebSocket(/\/remote\/ws/, bridge);
}

async function waitFor(fn, ms = 8000, what = '') {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timeout ' + what);
    await new Promise(r => setTimeout(r, 100));
  }
}

async function uiTests() {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const errors = [];
  try {
    await waitFor(() => fetch(BASE).then(r => r.ok).catch(() => false), 8000, 'server');
    // ---- the screen
    const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await mock(tvCtx);
    await tvCtx.addInitScript(([relay]) => {
      if (!localStorage.getItem('salotto:settings')) localStorage.setItem('salotto:settings', JSON.stringify({ proxyUrl: relay, proxyToken: 'tok' }));
    }, [RELAY]);
    const tv = await tvCtx.newPage();
    tv.on('pageerror', e => errors.push('tv: ' + e.message));
    await tv.goto(BASE + '#/settings');
    await tv.click('text=Collega il cellulare');
    await tv.waitForSelector('.qr-box svg');
    const link = await tv.inputValue('.remote-link');
    const pair = new URLSearchParams(new URL(link).hash.slice(1));
    assert.equal(pair.get('w'), RELAY);
    assert.equal(pair.get('t'), 'tok');
    assert.match(pair.get('r'), /^[A-Za-z0-9_-]{24}$/);
    assert.ok(link.startsWith(BASE + 'remote.html#'), link);
    await waitFor(() => tv.textContent('#remote-status').then(t => /in attesa/.test(t)), 8000, 'tv connected');
    if (SHOTS) await tv.screenshot({ path: path.join(SHOTS, 'remote-pair.png') });
    console.log('✓ pairing page: QR code and link with room, Worker and token');

    // ---- the phone
    const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' });
    await mock(phoneCtx);
    const ph = await phoneCtx.newPage();
    ph.on('pageerror', e => errors.push('phone: ' + e.message));
    await ph.goto(link);
    await waitFor(() => ph.getAttribute('#r-dot', 'class').then(c => /\bon\b/.test(c)), 8000, 'phone online');
    await waitFor(() => tv.textContent('#remote-status').then(t => /1 cellulare/.test(t)), 8000, 'tv sees phone');
    assert.match(await ph.textContent('#r-name'), /Linux|Mac|PC|Salotto/);
    assert.match(await ph.textContent('#r-title'), /Nessun video/);
    console.log('✓ phone connects; the screen shows it is paired');

    // channels with now/next, tap opens the channel on the screen
    await ph.click('.r-tabbtn[data-tab=channels]');
    await ph.waitForSelector('.r-ch-name:has-text("Rai 1")');
    await waitFor(() => ph.textContent('#r-chlist').then(t => t.includes('Telegiornale di prova')), 8000, 'now on air in list');
    if (SHOTS) await ph.screenshot({ path: path.join(SHOTS, 'remote-channels.png') });
    await ph.click('.r-ch-main:has-text("Rai 1")');
    await waitFor(() => tv.evaluate(() => window.salotto.player.isOpen()), 8000, 'player open');
    await waitFor(() => tv.textContent('#pl-title').then(t => t.includes('Rai 1')));
    await waitFor(() => ph.textContent('#r-title').then(t => t === 'Rai 1'), 8000, 'phone shows channel');
    await waitFor(() => ph.textContent('#r-prog').then(t => t.includes('Telegiornale di prova')));
    console.log('✓ channel list on the phone opens the channel on the screen, now playing shown');

    // channel up
    await ph.dispatchEvent('.r-rocker [data-cmd=zap][data-d="1"]', 'pointerdown');
    await ph.dispatchEvent('.r-rocker [data-cmd=zap][data-d="1"]', 'pointerup');
    await waitFor(() => tv.textContent('#pl-title').then(t => t.includes('La7')), 8000, 'zapped');
    await waitFor(() => ph.textContent('#r-title').then(t => t === 'La7'));
    // number pad
    await ph.click('#r-keypad-btn');
    await ph.click('.r-kp button:has-text("1")');
    await ph.click('.r-kp button:has-text("OK")');
    await waitFor(() => tv.textContent('#pl-title').then(t => t.includes('Rai 1')), 8000, 'number');
    console.log('✓ CH ▲ and channel number from the phone');

    // volume and mute
    await ph.dispatchEvent('#r-volrock [data-d="-5"]', 'pointerdown');
    await ph.dispatchEvent('#r-volrock [data-d="-5"]', 'pointerup');
    await waitFor(() => tv.evaluate(() => Math.abs(document.getElementById('video').volume - 0.95) < 0.001), 5000, 'volume');
    await waitFor(() => ph.textContent('#r-vollbl').then(t => t === '95%'));
    await ph.click('#r-mute');
    await waitFor(() => tv.evaluate(() => document.getElementById('video').muted), 5000, 'muted');
    await waitFor(() => ph.textContent('#r-vollbl').then(t => t === 'MUTO'));
    await ph.click('#r-mute');
    await waitFor(() => tv.evaluate(() => !document.getElementById('video').muted));
    console.log('✓ volume and mute');

    // full screen: entered at once or after a tap on the screen, left from the phone
    await ph.click('#r-fs');
    await waitFor(() => tv.evaluate(() => !!document.fullscreenElement || !document.getElementById('fs-hint').hidden), 5000, 'fs asked');
    if (!await tv.evaluate(() => !!document.fullscreenElement)) await tv.mouse.click(5, 400);
    await waitFor(() => tv.evaluate(() => document.fullscreenElement === document.documentElement), 5000, 'fullscreen');
    await waitFor(() => ph.textContent('#r-fs small').then(t => t === 'Esci'));
    await ph.click('#r-fs');
    await waitFor(() => tv.evaluate(() => !document.fullscreenElement), 5000, 'fullscreen off');
    await waitFor(() => ph.textContent('#r-fs small').then(t => t === 'Intero'));
    console.log('✓ full screen on and off from the phone');

    // A/V sync box follows the player; channel list / info on the screen
    assert.equal(await ph.isVisible('#r-av'), true);
    await ph.click('[data-cmd=info]');
    await waitFor(() => tv.isVisible('#pl-epg'), 5000, 'info on screen');
    if (SHOTS) await ph.screenshot({ path: path.join(SHOTS, 'remote-pad.png') });

    // guide tab
    await ph.click('.r-tabbtn[data-tab=guide]');
    await ph.waitForSelector('.r-g-title:has-text("Telegiornale di prova")');
    await ph.click('.r-chip:has-text("Dopo")');
    await ph.waitForSelector('.r-g-title:has-text("Film della sera")');
    await ph.click('.r-g:has-text("Film della sera")');
    await ph.waitForSelector('.r-sheet-box h2:has-text("Film della sera")');
    if (SHOTS) await ph.screenshot({ path: path.join(SHOTS, 'remote-guide.png') });
    await ph.click('#r-sheet-close');
    await ph.click('.r-chip:has-text("Adesso")');
    await ph.click('.r-wide:has-text("Mostra la guida")');
    await waitFor(() => tv.evaluate(() => location.hash.startsWith('#/guide')), 5000, 'guide on screen');
    console.log('✓ guide on the phone (now / later, details) and on the screen');

    // arrows + OK + Back drive the screen's menus
    await ph.click('.r-tabbtn[data-tab=remote]');
    await waitFor(() => tv.evaluate(() => !window.salotto.player.isOpen()));
    await ph.click('[data-go=""]');
    await waitFor(() => tv.evaluate(() => location.hash === '#/'), 5000, 'home');
    await ph.dispatchEvent('.r-dpad .down', 'pointerdown');
    await ph.dispatchEvent('.r-dpad .down', 'pointerup');
    await waitFor(() => tv.evaluate(() => document.body.classList.contains('kbd-nav') && document.activeElement && document.activeElement !== document.body), 5000, 'focus moved');
    for (let i = 0; i < 2 && await tv.evaluate(() => /Home/.test(document.activeElement.textContent)); i++) {
      await ph.dispatchEvent('.r-dpad .down', 'pointerdown');
      await ph.dispatchEvent('.r-dpad .down', 'pointerup');
      await new Promise(r => setTimeout(r, 300));
    }
    const focused = await tv.evaluate(() => document.activeElement.textContent.trim());
    await ph.click('.r-dpad .ok');
    await waitFor(() => tv.evaluate(() => location.hash !== '#/'), 5000, 'OK pressed ' + focused);
    await ph.click('[data-key=Back]');
    await waitFor(() => tv.evaluate(() => location.hash === '#/' || location.hash === ''), 5000, 'back');
    console.log('✓ arrows, OK and Back move around the screen (' + focused + ')');

    // stop from the phone
    await ph.click('.r-tabbtn[data-tab=channels]');
    await ph.click('.r-ch-main:has-text("La7")');
    await waitFor(() => tv.evaluate(() => window.salotto.player.isOpen()), 8000, 'reopen');
    await ph.click('.r-tabbtn[data-tab=remote]');
    await ph.click('[data-cmd=stop]');
    await waitFor(() => tv.evaluate(() => !window.salotto.player.isOpen()), 5000, 'stopped');
    await waitFor(() => ph.textContent('#r-title').then(t => /Nessun video/.test(t)));
    console.log('✓ stop');

    // the phone remembers the screen without the address
    const ph2 = await phoneCtx.newPage();
    await ph2.goto(BASE + 'remote.html');
    await waitFor(() => ph2.getAttribute('#r-dot', 'class').then(c => /\bon\b/.test(c)), 8000, 'remembered');
    assert.match(ph2.url(), /#r=/);
    await ph2.close();
    // unpair: a new room, the old link stops working
    tv.on('dialog', d => d.accept());
    await tv.goto(BASE + '#/remote');
    await tv.waitForSelector('.qr-box svg');
    await tv.click('text=Scollega tutti i cellulari');
    await tv.click('#modal .btn.danger');
    await waitFor(() => tv.inputValue('.remote-link').then(v => v !== link), 5000, 'new link');
    await waitFor(() => ph.getAttribute('#r-dot', 'class').then(c => /\bwait\b/.test(c)), 8000, 'old pairing offline');
    console.log('✓ phone remembers the screen; «Scollega» makes a new code');

    // unpaired phone
    const fresh = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    const ph3 = await fresh.newPage();
    await ph3.goto(BASE + 'remote.html');
    assert.equal(await ph3.isVisible('#r-unpaired'), true);
    await fresh.close();
    assert.deepEqual(errors, []);
    console.log('✓ no page errors');
  } finally {
    await browser.close();
    server.kill();
  }
}

await workerUnit();
await uiTests();
console.log('remote: all good');
