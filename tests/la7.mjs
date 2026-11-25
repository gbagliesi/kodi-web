// La7 add-on test: la7play.it catalogue (GraphQL persisted queries), «Si guarda in Salotto»,
// a protected film opened on la7play.it, search, and a free episode played from La7's CDN.
// La7 is mocked; the video is a small ffmpeg HLS stream.
// Run: node tests/la7.mjs   (needs playwright, hls.js@1.5.17 and ffmpeg)
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
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}/`;

let HLS_JS;
try { HLS_JS = require.resolve('hls.js/dist/hls.min.js'); } catch { console.log('hls.js non installato: test saltato'); process.exit(0); }
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { console.log('ffmpeg non installato: test saltato'); process.exit(0); }

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'salotto-la7-'));
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000',
  '-t', '12', '-c:v', 'libx264', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', path.join(DIR, 'v%d.ts'), path.join(DIR, 'index.m3u8')]);

const IMG = { url: 'https://images.la7play.it/x.webp' };
const prop = (path, titolo) => ({ __typename: 'TermProperty', id: path, titolo, path, scenaImage: IMG });
const PAGES = {
  '/programmi': { id: '1', title: 'Programmi', contentSlots: [
    { __typename: 'NodeContentCarousel', titoloCarrello: 'Prima serata', paginatedItems: { items: [prop('/libero', 'Programma libero'), prop('/protetto', 'Serie protetta')] } },
  ] },
  '/film': { id: '2', contentSlots: [
    { titoloCarrello: 'Film scelti per te', paginatedItems: { items: [{ __typename: 'NodeEventoSingolo', id: '9', title: 'Un film', path: '/film/un-film-9', uploadVideo: { cf_duration: '6000' } }] } },
  ] },
};
const PROPS = {
  libero: { __typename: 'TermProperty', name: 'Programma libero', path: '/libero', vociSottomenu: [
    { titoloVoce: 'Puntate', sezione: null, tipoDiContenuto: { name: 'Replica' } },
    { titoloVoce: 'Rubrica', sezione: { name: 'rubrica' }, tipoDiContenuto: { name: 'Video' } },
    { titoloVoce: 'Podcast', linkMenu: '/libero/podcast' },
  ] },
  protetto: { __typename: 'TermProperty', name: 'Serie protetta', path: '/protetto', vociSottomenu: [{ titoloVoce: 'Episodi', tipoDiContenuto: { name: 'Replica' } }] },
};
const EPISODES = {
  'programma libero': [{ __typename: 'NodeReplica', title: 'Puntata del 24/11/2026', path: '/libero/puntate/puntata-1', property: { titolo: 'Programma libero' }, dataMessaInOnda: { timestamp: 1795549191 }, uploadVideo: { cf_duration: '12' } }],
  'serie protetta': [{ __typename: 'NodeReplica', title: 'St. 1 Episodio 1', path: '/protetto/puntate/ep-1', property: { titolo: 'Serie protetta' }, uploadVideo: {} }],
};
const NODES = {
  '/libero/puntate/puntata-1': { __typename: 'NodeReplica', title: 'Puntata del 24/11/2026', drm: false, uploadVideo: { cf_remote_url: '/nk/content/entry/data/0/1/a_hi.mp4,/nk/content/entry/data/0/1/a_lo.mp4' } },
  '/protetto/puntate/ep-1': { __typename: 'NodeReplica', title: 'St. 1 Episodio 1', drm: true, uploadVideo: { cf_remote_url: '/T1' } },
  '/film/un-film-9': { __typename: 'NodeEventoSingolo', title: 'Un film', drm: true, uploadVideo: {} },
};
const Q = { eed01397c9d98bba: 'page', a49a4e9d0e8b3bde: 'prop', e4ec45c8e38bb081: 'episodes', '6f384b6747f1a846': 'clips', '64b0309c926cd9f8': 'replica', b207522d293262f1: 'video', '7dcf9b94331a0879': 'evento', '4da1e384f8a63808': 'search' };
const TYPES = { replica: 'NodeReplica', video: 'NodeVideo', evento: 'NodeEventoSingolo' };
function answer(q, v) {
  if (q === 'page') return { route: { entity: PAGES[v.path] || {} } };
  if (q === 'prop') return { route: { entity: PROPS[v.path] || {} } };
  if (q === 'episodes') return { filteredNodeReplicas: { nodes: (EPISODES[v.path] || []).slice(0, v.value) } };
  if (q === 'clips') return { filteredNodeVideos: { nodes: v.sezione === 'rubrica' ? [{ __typename: 'NodeVideo', title: 'Un pezzo della rubrica', path: '/libero/video/rubrica/pezzo-1', uploadVideo: { cf_duration: '60' } }] : [] } };
  if (q === 'search') return { siteSearch: { groups: [
    { contentType: 'property', hits: [{ title: 'Programma libero', url: '/libero', contentType: 'property' }] },
    { contentType: 'video', hits: [{ title: 'Puntata cercata', url: '/libero/puntate/puntata-1', contentType: 'video', propertyName: 'Programma libero', duration: 12 }] },
  ] } };
  const n = NODES[v.path];
  return { route: { entity: n && n.__typename === TYPES[q] ? n : {} } };
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
  const cors = { 'access-control-allow-origin': '*' };
  let searched = null;
  const la7 = (url, r) => {
    const m = /\/api\/(gql|gql-search)\/(\w+)\/([\w+/=-]+)$/.exec(url.pathname);
    if (!m) return r.fulfill({ status: 404, body: '' });
    const q = Q[m[2]];
    if (!q) return r.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{"errors":[{"message":"Query persistita sconosciuta"}]}' });
    const v = JSON.parse(Buffer.from(m[3], 'base64').toString('utf8'));
    if (q === 'search') searched = v.q;
    return r.fulfill({ status: 200, contentType: 'application/json', headers: m[1] === 'gql' ? cors : {}, body: JSON.stringify({ data: answer(q, v) }) });
  };
  // gql allows other sites; gql-search doesn't (no CORS header): it must go through the proxy
  await context.route('https://www.la7play.it/**', r => la7(new URL(r.request().url()), r));
  await context.route(u => u.pathname.endsWith('/proxy') && u.searchParams.get('url'), (r) => {
    return la7(new URL(new URL(r.request().url()).searchParams.get('url')), r);
  });
  let master = '';
  await context.route('https://awsvodpkg.iltrovatore.it/**', (r) => {
    const u = r.request().url();
    if (u.endsWith('/master.m3u8')) {
      master = u;
      return r.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', headers: cors, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180\nhttps://awsvodpkg.iltrovatore.it/seg/index.m3u8\n' });
    }
    const f = path.join(DIR, u.split('/').pop());
    if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ status: 200, contentType: f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', body: fs.readFileSync(f), headers: cors });
  });
  await context.route('https://images.la7play.it/**', r => r.fulfill({ status: 404, body: '' }));
  await context.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/hls\.js/, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(HLS_JS) }));
  await context.route(/^https:\/\/(raw\.githubusercontent\.com|iptv-org\.github\.io|de1\.api\.radio-browser\.info|archive\.org|www\.raiplay\.it)\//, r => r.fulfill({ status: 404, body: '' }));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('.hero');
  assert.ok(await page.evaluate(() => window.salotto.addons.getInstalled('plugin.video.la7')), 'La7 add-on installed with the app');

  // catalogue: Programmi → row → programmes marked once checked
  await page.goto(BASE + '#/browse/plugin.video.la7');
  await page.waitForSelector('.row:has-text("Cerca su La7")');
  await page.click('.row:has-text("Si guarda in Salotto")');
  await page.waitForSelector('.row:has-text("1 programmi")', { timeout: 15000 });
  await page.click('.row:has-text("1 programmi")');
  await page.waitForSelector('.card:has-text("Programma libero")');
  assert.equal(await page.locator('.card:has-text("Serie protetta")').count(), 0, 'protected programme left out');
  await page.goto(BASE + '#/browse/plugin.video.la7?p=' + encodeURIComponent('row:/programmi|0'));
  await page.waitForSelector('.card:has-text("Serie protetta")');
  assert.match(await page.textContent('.card:has-text("Programma libero")'), /Si guarda in Salotto/);
  assert.match(await page.textContent('.card:has-text("Serie protetta")'), /Su la7play\.it/);
  // a protected series: its episodes open on la7play.it
  await page.click('.card:has-text("Serie protetta")');
  await page.waitForSelector('.card:has-text("St. 1 Episodio 1")');
  assert.match(await page.textContent('.card:has-text("St. 1 Episodio 1")'), /Si apre su la7play\.it/);
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await page.click('.card:has-text("St. 1 Episodio 1")');
  assert.deepEqual(await page.evaluate(() => window.__opened), ['https://www.la7play.it/protetto/puntate/ep-1']);
  assert.equal(await page.isVisible('#player'), false);
  // films are protected: marked, and open on the site
  await page.goto(BASE + '#/browse/plugin.video.la7?p=' + encodeURIComponent('page:/film'));
  await page.click('.row:has-text("Film scelti per te")');
  await page.waitForSelector('.card:has-text("Un film")');
  assert.match(await page.textContent('.card:has-text("Un film")'), /Si apre su la7play\.it/);
  console.log('✓ La7: catalogue rows, «Si guarda in Salotto», protected series and films open on la7play.it');

  // programme: sections (podcast link left out) and a section's videos
  await page.goto(BASE + '#/browse/plugin.video.la7?p=' + encodeURIComponent('prop:/libero'));
  await page.waitForSelector('.row:has-text("Rubrica")');
  assert.equal(await page.locator('.row:has-text("Podcast")').count(), 0);
  await page.click('.row:has-text("Rubrica")');
  await page.waitForSelector('.card:has-text("Un pezzo della rubrica")');
  console.log('✓ La7: programme sections and videos');

  // search goes through the proxy (La7's search doesn't allow other sites), then a free episode plays
  await page.goto(BASE + '#/browse/plugin.video.la7');
  await page.waitForSelector('.row:has-text("Cerca su La7")');
  await page.click('.row:has-text("Cerca su La7")');
  await page.fill('input[placeholder="Cerca…"]', 'libero');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.card:has-text("Puntata cercata")');
  assert.equal(searched, 'libero');
  await page.click('.card:has-text("Puntata cercata")');
  await page.waitForSelector('#player:not([hidden])');
  await waitFor(() => page.evaluate(() => document.getElementById('video').currentTime > 0.5), 15000, 'video plays');
  assert.equal(master, 'https://awsvodpkg.iltrovatore.it/local/hls/,/nk/content/entry/data/0/1/a_hi,/nk/content/entry/data/0/1/a_lo,.mp4.urlset/master.m3u8');
  console.log('✓ La7: search, free episode plays from La7\'s CDN');

  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(DIR, { recursive: true, force: true });
}
console.log('\nTest La7 passati.');
