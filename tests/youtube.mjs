// YouTube add-on test: no key (set-key item, a pasted link plays, saved channel via RSS through
// the proxy), with a key (trending, search with channels/playlists/videos, channel page, follow,
// playlist), the official embedded player (mocked IFrame API) driven by keys on a computer and
// on the TV app, favourites, errors that only allow «Apri su YouTube», and the key never shown.
// YouTube is mocked. Run: node tests/youtube.mjs   (needs playwright)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ADDONS } from './addons-dir.mjs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}/`;
const KEY = 'AIzaTESTKEY_not_real_1234567890abcdefgh';
const CH = 'UC' + 'a'.repeat(22);

async function waitFor(fn, ms = 10000, what = '') {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timeout ' + what);
    await new Promise(r => setTimeout(r, 120));
  }
}

const sn = (title, extra = {}) => ({ title, channelTitle: 'Canale Prova', channelId: CH, publishedAt: '2026-11-20T10:00:00Z', description: 'Descrizione di ' + title, thumbnails: { high: { url: 'https://i.ytimg.com/vi/x/hq.jpg' } }, liveBroadcastContent: 'none', ...extra });
const VIDEOS = {
  'Vid_Trend01': sn('Video di tendenza'),
  'Vid_Found01': sn('Video trovato'),
  'Vid_Upld001': sn('Ultimo caricamento'),
  'Vid_Pl00001': sn('Primo della playlist'),
  'blocked-X01': sn('Video non incorporabile'),
};
const video = (id) => ({ id, snippet: VIDEOS[id], contentDetails: { duration: 'PT4M13S' }, statistics: { viewCount: '1234567' } });

function api(url) {
  const ep = url.pathname.split('/').pop();
  const q = url.searchParams;
  if (q.get('key') !== KEY) return [400, { error: { code: 400, message: 'API key not valid', errors: [{ reason: 'badRequest' }] } }];
  if (ep === 'videos' && q.get('chart')) return [200, { items: [video('Vid_Trend01')], nextPageToken: q.get('pageToken') ? undefined : 'P2' }];
  if (ep === 'videos') return [200, { items: q.get('id').split(',').filter(id => VIDEOS[id]).map(video) }];
  if (ep === 'search') {
    if (q.get('eventType') === 'live') return [200, { items: [] }];
    if (q.get('q') === 'quota') return [403, { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }];
    return [200, { items: [
      { id: { kind: 'youtube#channel', channelId: CH }, snippet: sn('Canale Prova') },
      { id: { kind: 'youtube#playlist', playlistId: 'PLtest' }, snippet: sn('Playlist di prova') },
      { id: { kind: 'youtube#video', videoId: 'Vid_Found01' }, snippet: sn('Video trovato') },
      { id: { kind: 'youtube#video', videoId: 'blocked-X01' }, snippet: sn('Video non incorporabile') },
    ] }];
  }
  if (ep === 'channels') return [200, { items: [{ id: CH, snippet: sn('Canale Prova') }] }];
  if (ep === 'playlistItems') {
    const id = q.get('playlistId') === 'UU' + CH.slice(2) ? 'Vid_Upld001' : 'Vid_Pl00001';
    return [200, { items: [{ snippet: { ...VIDEOS[id], resourceId: { videoId: id } } }] }];
  }
  if (ep === 'playlists') return [200, { items: [{ id: 'PLtest', snippet: sn('Playlist di prova'), contentDetails: { itemCount: 1 } }] }];
  return [404, { error: { code: 404, errors: [{ reason: 'notFound' }] } }];
}

const FEED = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/"><title>Canale Prova</title>
<entry><yt:videoId>Vid_Feed001</yt:videoId><title>Dal feed RSS</title><published>2026-11-24T08:00:00+00:00</published><media:group><media:thumbnail url="https://i.ytimg.com/vi/Vid_Feed001/hqdefault.jpg" width="480" height="360"/><media:description>Senza chiave</media:description><media:community><media:statistics views="321"/></media:community></media:group></entry></feed>`;

// The IFrame Player API, as far as Salotto uses it.
const FAKE_YT = `(() => {
  window.__yt = { calls: [], created: [] };
  window.YT = { Player: function (id, opts) {
    const host = document.getElementById(id);
    const f = document.createElement('iframe'); f.src = 'about:blank'; f.id = id; host.replaceWith(f);
    let st = -1, t = 0;
    window.__yt.created.push({ videoId: opts.videoId || '', vars: opts.playerVars });
    window.__yt.player = this;
    this.playVideo = () => { st = 1; window.__yt.calls.push('play'); };
    this.pauseVideo = () => { st = 2; window.__yt.calls.push('pause'); };
    this.getPlayerState = () => st;
    this.getCurrentTime = () => t;
    this.getDuration = () => 600;
    this.seekTo = (x) => { t = x; window.__yt.calls.push('seek:' + x); };
    this.nextVideo = () => window.__yt.calls.push('next');
    this.previousVideo = () => window.__yt.calls.push('prev');
    let rate = 1, mods = new Set();
    this.getPlaybackRate = () => rate;
    this.getAvailablePlaybackRates = () => [0.5, 1, 1.5, 2];
    this.setPlaybackRate = (r) => { rate = r; window.__yt.calls.push('rate:' + r); };
    this.loadModule = (m) => mods.add(m);
    this.unloadModule = (m) => { mods.delete(m); window.__yt.calls.push('cc:off'); };
    this.getOption = (m, o) => mods.has('captions') && o === 'tracklist' ? [{ languageCode: 'it', displayName: 'Italiano' }, { languageCode: 'en', displayName: 'Inglese', kind: 'asr' }] : undefined;
    this.setOption = (m, o, v) => window.__yt.calls.push('cc:' + v.languageCode);
    this.destroy = () => { f.remove(); window.__yt.calls.push('destroy'); };
    setTimeout(() => opts.events.onReady({ target: this }), 10);
    if (opts.videoId === 'blocked-X01') setTimeout(() => opts.events.onError({ data: 150 }), 30);
  } };
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);
})();`;

const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
const browser = await chromium.launch();
const errors = [];
const seenUrls = [];

async function newPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', ...opts });
  const cors = { 'access-control-allow-origin': '*' };
  await context.route('https://www.googleapis.com/youtube/v3/**', (r) => {
    const [status, body] = api(new URL(r.request().url()));
    return r.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  });
  await context.route('https://www.youtube.com/iframe_api', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_YT }));
  // the RSS feed has no CORS header: it must come through the proxy
  await context.route('https://www.youtube.com/feeds/**', r => r.fulfill({ status: 200, contentType: 'application/xml', body: FEED }));
  await context.route(u => u.pathname.endsWith('/proxy') && u.searchParams.get('url')?.startsWith('https://www.youtube.com/feeds/'), r => r.fulfill({ status: 200, contentType: 'application/xml', body: FEED }));
  await context.route(/^https:\/\/(i\.ytimg\.com|raw\.githubusercontent\.com|iptv-org\.github\.io|de1\.api\.radio-browser\.info|archive\.org|www\.raiplay\.it|www\.la7play\.it)\//, r => r.fulfill({ status: 404, body: '' }));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => seenUrls.push(r.url()));
  await page.goto(BASE);
  await page.waitForSelector('.hero');
  return { context, page };
}

const setKey = (page, key) => page.evaluate(async (k) => {
  const { setAddonSettings, stopHost } = await import('./js/addons.js');
  setAddonSettings('plugin.video.youtube', { apiKey: k });
}, key);

try {
  await waitFor(() => fetch(BASE + 'proxy/health').then(r => r.ok).catch(() => false));

  // ------------------------------------------------ computer, no key
  {
    const { context, page } = await newPage();
    assert.ok(await page.evaluate(() => window.salotto.addons.getInstalled('plugin.video.youtube')), 'YouTube add-on installed with the app');
    await page.goto(BASE + '#/browse/plugin.video.youtube');
    await page.waitForSelector('.row:has-text("Imposta la chiave API")');
    // opening the add-on already loads YouTube's player API (the video starts sooner)
    await waitFor(() => page.evaluate(() => !!window.YT?.Player), 5000, 'API preloaded');
    assert.ok(await page.evaluate(() => !!document.querySelector('link[rel=preconnect][href="https://www.youtube.com"]')));
    await page.click('.row:has-text("Cerca su YouTube")');
    await page.fill('input[placeholder="Cerca…"]', 'https://youtu.be/Vid_Found01?si=abc');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.card:has-text("Video YouTube Vid_Found01")');
    await page.click('.card:has-text("Video YouTube Vid_Found01")');
    await page.waitForSelector('#yt-player:not([hidden])');
    await waitFor(() => page.evaluate(() => window.__yt?.calls.includes('play')), 5000, 'autoplay');
    const made = await page.evaluate(() => window.__yt.created[0]);
    assert.equal(made.videoId, 'Vid_Found01');
    assert.equal(made.vars.autoplay, 1);
    assert.equal(made.vars.origin, new URL(BASE).origin);
    assert.equal(await page.isVisible('#player'), false, 'Salotto\'s own video player stays closed');
    // keys: OK pauses, → skips, Esc closes
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await page.evaluate(() => window.__yt.calls.slice(1)), ['pause', 'seek:10']);
    // Mac keyboard: ▲ shows Salotto's controls (YouTube's own buttons can't be reached), → moves in them
    assert.ok(await page.evaluate(() => document.getElementById('yt-player').classList.contains('peek')), 'progress shown after → on a computer too');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'yt-play');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'yt-fwd');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'yt-cc');
    await page.keyboard.press('Escape'); // controls away first
    assert.equal(await page.isVisible('#yt-player'), true);
    assert.ok(await page.evaluate(() => document.getElementById('yt-player').classList.contains('bar-hidden')));
    // the mouse: YouTube's own controls, Salotto's step aside
    await page.mouse.click(5, 300);
    await waitFor(() => page.evaluate(() => document.activeElement.id === 'yt-player'), 3000, 'focus taken back from YouTube\'s frame');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'yt-play', 'a key brings them back');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#yt-player'), false);
    assert.ok(await page.evaluate(() => window.__yt.calls.includes('destroy')));
    console.log('✓ YouTube without a key: a pasted link plays in YouTube\'s player; Mac keyboard: OK, →, ▲ controls, Esc');

    // a search without a key explains what is needed
    await page.goto(BASE + '#/browse/plugin.video.youtube?q=gatti&t=x');
    await page.waitForSelector('text=serve la chiave API');
    // saved channel without a key: its RSS feed through the proxy
    await page.goto(BASE + '#/browse/plugin.video.youtube?p=' + encodeURIComponent('ch:' + CH));
    await page.waitForSelector('.card:has-text("Dal feed RSS")');
    await page.click('.card:has-text("Aggiungi ai miei canali")');
    await page.waitForSelector('.row:has-text("è nei tuoi canali"), .card:has-text("è nei tuoi canali")');
    await page.goto(BASE + '#/browse/plugin.video.youtube?p=mine');
    await page.waitForSelector(':is(.row,.card):has-text("' + CH + '")');
    console.log('✓ YouTube without a key: search asks for the key, channel via RSS (proxy), «I miei canali»');
    await context.close();
  }

  // ------------------------------------------------ computer, with a key
  {
    const { context, page } = await newPage();
    await setKey(page, 'wrong-key');
    await page.goto(BASE + '#/browse/plugin.video.youtube?p=' + encodeURIComponent('chart:0'));
    await page.waitForSelector('text=non è valida');
    assert.ok(!(await page.textContent('body')).includes('wrong-key'), 'the key is not shown in errors');
    await setKey(page, KEY);
    await page.goto(BASE + '#/browse/plugin.video.youtube');
    await page.waitForSelector('.row:has-text("Di tendenza")');
    assert.equal(await page.locator('.row:has-text("Imposta la chiave API")').count(), 0);
    await page.click('.row:has-text("Di tendenza")');
    await page.waitForSelector('.card:has-text("Video di tendenza")');
    assert.match(await page.textContent('.card:has-text("Video di tendenza")'), /Canale Prova · 1,2 Mln visualizzazioni/);
    await page.click('.card:has-text("Altri risultati")');
    await page.waitForSelector('.card:has-text("Video di tendenza")');
    console.log('✓ YouTube with a key: wrong key explained (key not shown), trending with views, next page');

    await page.goto(BASE + '#/browse/plugin.video.youtube');
    await page.waitForSelector('.row:has-text("Cerca su YouTube")');
    await page.click('.row:has-text("Cerca su YouTube")');
    await page.fill('input[placeholder="Cerca…"]', 'prova');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.card:has-text("Video trovato")');
    assert.equal(await page.locator('.card:has-text("Playlist di prova")').count(), 1);
    // a channel: uploads, follow
    await page.click('.card:has-text("Canale Prova")');
    await page.waitForSelector('.card:has-text("Ultimo caricamento")');
    await page.click('.card:has-text("Aggiungi ai miei canali")');
    await page.waitForSelector(':is(.row,.card):has-text("«Canale Prova» è nei tuoi canali")');
    await page.goBack();
    await page.waitForSelector('.card:has-text("Togli dai miei canali")');
    await page.click('.card:has-text("Playlist del canale")');
    await page.waitForSelector('.card:has-text("Playlist di prova")');
    await page.click('.card:has-text("Playlist di prova")');
    await page.waitForSelector('.card:has-text("Primo della playlist")');
    await page.click('.card:has-text("Guarda tutta la playlist")');
    await page.waitForSelector('#yt-player:not([hidden])');
    await waitFor(() => page.evaluate(() => window.__yt?.created.length));
    assert.equal(await page.evaluate(() => window.__yt.created.at(-1).vars.list), 'PLtest');
    await page.keyboard.press('MediaTrackNext');
    assert.ok(await page.evaluate(() => window.__yt.calls.includes('next')));
    await page.keyboard.press('Escape');
    console.log('✓ YouTube: search (channels, playlists, videos), channel uploads, follow/unfollow, whole playlist');

    // a video its author doesn't let others embed: only «Apri su YouTube»
    await page.goto(BASE + '#/browse/plugin.video.youtube?q=prova&t=x');
    await page.waitForSelector('.card:has-text("Video non incorporabile")');
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    await page.click('.card:has-text("Video non incorporabile")');
    await page.waitForSelector('#yt-msg:not([hidden]):has-text("non permette di guardarlo fuori da YouTube")');
    await page.click('#yt-msg .btn.primary');
    assert.deepEqual(await page.evaluate(() => window.__opened), ['https://www.youtube.com/watch?v=blocked-X01']);
    await page.click('#yt-msg .btn:has-text("Chiudi")');
    assert.equal(await page.isVisible('#yt-player'), false);
    // favourites: ☆ in the bar, then opened from Preferiti
    await page.click('.card:has-text("Video trovato")');
    await page.waitForSelector('#yt-player:not([hidden])');
    await page.click('#yt-fav');
    assert.equal(await page.textContent('#yt-fav'), '★');
    await page.click('#yt-close');
    await page.goto(BASE + '#/favourites');
    await page.click(':is(.row,.card):has-text("Video trovato")');
    await page.waitForSelector('#yt-player:not([hidden])');
    assert.equal(await page.evaluate(() => window.__yt.created.at(-1).videoId), 'Vid_Found01');
    await page.click('#yt-close');
    // quota finished: a clear message
    await page.goto(BASE + '#/browse/plugin.video.youtube?q=quota&t=x');
    await page.waitForSelector('text=unità gratuite di oggi');
    console.log('✓ YouTube: embedding refused → «Apri su YouTube», favourites, quota message');
    await context.close();
  }

  // ------------------------------------------------ Fire TV app
  {
    const { context, page } = await newPage({ userAgent: 'Mozilla/5.0 (Linux; Android 9; AFTSSS) AppleWebKit/537.36 Chrome/120 Safari/537.36 SalottoTV/1' });
    await setKey(page, KEY);
    await page.goto(BASE + '#/browse/plugin.video.youtube?p=' + encodeURIComponent('chart:0'));
    await page.waitForSelector('.card:has-text("Video di tendenza")');
    await page.focus('.card:has-text("Video di tendenza")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#yt-player:not([hidden])');
    await waitFor(() => page.evaluate(() => window.__yt?.calls.includes('play')));
    assert.ok(await page.evaluate(() => document.getElementById('yt-player').classList.contains('bar-hidden')), 'TV: video fills the screen');
    assert.equal(await page.evaluate(() => document.querySelector('#yt-player iframe').tabIndex), -1, 'TV: the frame never takes the remote');
    await page.keyboard.press('ArrowLeft'); // at 0: stays at 0
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.__yt.calls.slice(1)), ['seek:0', 'seek:10', 'pause']);
    // ◀▶ with the controls hidden: the progress bar peeks, quick presses add up
    assert.ok(await page.evaluate(() => document.getElementById('yt-player').classList.contains('peek')), 'TV: progress shown after a skip');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    assert.deepEqual(await page.evaluate(() => window.__yt.calls.slice(-3)), ['seek:20', 'seek:50', 'seek:80'], 'held → bigger steps from where the last aimed');
    await waitFor(() => page.evaluate(() => document.getElementById('yt-cur').textContent === '1:20'));
    // ▲ shows Salotto's controls with the focus on ⏯; → ⟳ skips; speed and subtitles menus
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'yt-play');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'yt-fwd');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__yt.calls.at(-1)), 'seek:90');
    await page.focus('#yt-rate'); await page.keyboard.press('Enter');
    await page.waitForSelector('#yt-menu:not([hidden]) .row.on:has-text("Normale")');
    assert.match(await page.evaluate(() => document.activeElement.textContent), /Normale/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__yt.calls.at(-1)), 'rate:1.5');
    assert.equal(await page.isVisible('#yt-menu'), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'yt-rate');
    await waitFor(() => page.evaluate(() => document.getElementById('yt-rate').textContent === 'Velocità 1,5×'));
    await page.focus('#yt-cc'); await page.keyboard.press('Enter');
    await page.waitForSelector('#yt-menu:not([hidden]) .row:has-text("Inglese (automatici)")');
    await page.click('#yt-menu .row:has-text("Italiano")');
    assert.equal(await page.evaluate(() => window.__yt.calls.at(-1)), 'cc:it');
    await waitFor(() => page.evaluate(() => document.getElementById('yt-cc').textContent === 'Sottotitoli: IT'));
    // Back closes an open menu first
    await page.focus('#yt-cc'); await page.keyboard.press('Enter');
    await page.waitForSelector('#yt-menu:not([hidden])');
    assert.equal(await page.evaluate(() => window.salottoBack()), true);
    assert.equal(await page.isVisible('#yt-menu'), false);
    assert.equal(await page.isVisible('#yt-ctrl'), true);
    // ▲ from the controls reaches the top bar
    await page.focus('#yt-play'); await page.keyboard.press('ArrowUp');
    assert.match(await page.evaluate(() => document.activeElement.id), /^yt-(close|fav|ext)$/);
    assert.equal(await page.evaluate(() => window.salottoBack()), true);
    assert.ok(await page.evaluate(() => document.getElementById('yt-player').classList.contains('bar-hidden')));
    assert.equal(await page.isVisible('#yt-player'), true);
    assert.equal(await page.evaluate(() => window.salottoBack()), true);
    assert.equal(await page.isVisible('#yt-player'), false);
    assert.match(await page.evaluate(() => document.activeElement.textContent), /Video di tendenza/, 'focus back on the tile');
    console.log('✓ YouTube on the TV app: full screen, ◀▶ with progress (held = bigger steps), OK, ▲ controls, speed and subtitles menus, Back closes menu → controls → player, focus back on the tile');
    await context.close();
  }

  assert.ok(!seenUrls.some(u => u.includes('/proxy') && u.includes('googleapis')), 'the API key never goes through the proxy');
  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
  server.kill();
}
console.log('\nTest YouTube passati.');
