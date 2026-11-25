// Mediaset Infinity add-on test: sections and rows read from the site's public pages through the
// proxy, programme pages, flat lists, search among the programmes met, videos opening on the site,
// and the message when there is no proxy. The site is mocked.
// Run: node tests/mediaset.mjs   (needs playwright)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ADDONS } from './addons-dir.mjs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}/`;
const SITE = 'https://mediasetinfinity.mediaset.it';
const ID = 'plugin.video.mediaset';

const img = (alt, n) => `<picture><source srcSet="https://img-prod-api2.mediasetplay.mediaset.it/x/${n}.jpg 1x"/><img alt="${alt}" title="${alt}" role="presentation" loading="lazy" src="https://img-prod-api2.mediasetplay.mediaset.it/x/${n}.jpg" class="w-full"/></picture>`;
const poster = (href, alt, n, desc = '') => `<li><a tabindex="0" class="card-wrapper group" data-testid="poster-card-link" href="${href}"><div>${img(alt, n)}</div><p>${desc}</p><button>La tua lista</button></a></li>`;
const keyframe = (href, alt, n, desc = '') => `<li><a tabindex="0" class="card-wrapper" data-testid="keyframe-card-link" href="${href}"><div>${img(alt, n)}</div><h3>${alt}</h3><p>${desc}</p></a></li>`;
const carousel = (title, href, cards) => `<div class="area-container"><div class="titleCarousel"><a tabindex="0" class="inline-flex" data-testid="carousel-title"${href ? ` href="${href}"` : ''}><h2 class="text-headline">${title}</h2></a></div><ul>${cards.join('')}</ul></div>`;
// the real pages carry megabytes of page data after the visible part: the add-on stops reading there
const tail = '<script>self.__next_f.push([1,"' + 'x'.repeat(300000) + '"])</script></body></html>';
const page = (body) => `<!DOCTYPE html><html><head><title>Mediaset Infinity</title></head><body><a data-testid="home-page-icon" href="/">${img('Logo', 0)}</a><main>${body}</main>${tail}`;

const PAGES = {
  '/programmitv': page(
    carousel('Prima serata', '/browse/prima-serata_e1', [
      poster('/programmi-tv/verissimo_SE000000000023', 'Verissimo', 1, 'Il salotto di Silvia'),
      poster('/programmi-tv/leiene_SE000000000061', 'Le Iene', 2),
    ]) +
    carousel('Le clip più viste', '/browse/clip_e2', [keyframe('/video/verissimo/un-intervista_F314717301020C88', 'Un&#x27;intervista &quot;integrale&quot;', 3, 'Racconta tutto')]) +
    carousel('Le dirette', '', [poster('/diretta/canale5_cC5', 'Canale 5', 4)]) +
    carousel('I racconti', '/browse/racconti_e3', [])),
  '/programmi-tv/verissimo_SE000000000023': page(
    carousel('Tutte le puntate', '/browse/tutte-le-puntate_e4', [keyframe('/video/verissimo/domenica-22-novembre_F314717301002001', 'Domenica 22 novembre', 5, 'Gli ospiti del salotto')]) +
    carousel('Verissimo: le interviste', '/browse/interviste_e5', [keyframe('/video/verissimo/un-intervista_F314717301020C88', 'Un&#x27;intervista &quot;integrale&quot;', 3)])),
  '/browse/tutte-le-puntate_e4': page(
    keyframe('/video/verissimo/domenica-22-novembre_F314717301002001', 'Domenica 22 novembre', 5) +
    keyframe('/video/verissimo/sabato-21-novembre_F314717301001901', 'Sabato 21 novembre', 6)),
  '/cinema': page(carousel('Film ultimi arrivi', '/browse/film_e6', [poster('/movie/unfilm/un-film_F006121501000104', 'Un film', 7)])),
  '/fiction': page(carousel('Fiction del momento', '/browse/fiction_e7', [poster('/fiction/violacomeilmare_SE000000001800', 'Viola come il mare', 8)])),
};
for (const p of ['/documentari', '/kids', '/news-e-sport']) PAGES[p] = page('');

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
const browser = await chromium.launch();
const errors = [];
try {
  await waitFor(() => fetch(BASE + 'proxy/health').then(r => r.ok).catch(() => false));
  const fetched = [];
  async function setup(withProxy) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    // the site doesn't allow other sites: direct requests fail (no CORS header)
    await context.route(SITE + '/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: 'no cors' }));
    await context.route(u => u.pathname.endsWith('/proxy') && u.searchParams.get('url'), (r) => {
      const target = new URL(new URL(r.request().url()).searchParams.get('url'));
      if (target.origin !== SITE) return r.fulfill({ status: 404, body: '' });
      fetched.push(target.pathname);
      const body = PAGES[target.pathname];
      return r.fulfill(body ? { status: 200, contentType: 'text/html; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body } : { status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'not found' });
    });
    if (!withProxy) await context.route(u => u.pathname.endsWith('/proxy/health'), r => r.fulfill({ status: 404, body: '' }));
    await context.route('https://img-prod-api2.mediasetplay.mediaset.it/**', r => r.fulfill({ status: 404, body: '' }));
    await context.route(/^https:\/\/(raw\.githubusercontent\.com|iptv-org\.github\.io|de1\.api\.radio-browser\.info|archive\.org|www\.raiplay\.it|www\.la7play\.it|cdn\.jsdelivr\.net)\//, r => r.fulfill({ status: 404, body: '' }));
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE);
    await page.waitForSelector('.hero');
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    return { context, page };
  }

  const { context, page } = await setup(true);
  assert.ok(await page.evaluate((id) => window.salotto.addons.getInstalled(id), ID), 'Mediaset add-on installed with the app');

  // sections → rows (the live-channel row is left out, an empty row opens its full list)
  await page.goto(BASE + '#/browse/' + ID);
  await page.waitForSelector('.row:has-text("Cerca un programma")');
  await page.click('.row:has-text("Programmi TV")');
  await page.waitForSelector('.row:has-text("Prima serata")');
  assert.match(await page.textContent('.row:has-text("Prima serata")'), /2 titoli/);
  assert.equal(await page.locator('.row:has-text("Le dirette")').count(), 0, 'live row left out');
  assert.match(await page.textContent('.row:has-text("I racconti")'), /Apri l'elenco/);
  // a row of programmes, with its full list first
  await page.click('.row:has-text("Prima serata")');
  await page.waitForSelector('.card:has-text("Le Iene")');
  assert.ok(await page.locator('.card:has-text("Tutti: Prima serata")').count(), 'link to the full list');
  // a programme: its rows; the episodes' full list is a flat page of cards
  await page.click('.card:has-text("Verissimo")');
  await page.waitForSelector('.row:has-text("Tutte le puntate")');
  await page.click('.row:has-text("Tutte le puntate")');
  await page.waitForSelector('.card:has-text("Domenica 22 novembre")');
  assert.match(await page.textContent('.card:has-text("Domenica 22 novembre")'), /Si apre su Mediaset Infinity/);
  await page.click('.card:has-text("Tutti: Tutte le puntate")');
  await page.waitForSelector('.card:has-text("Sabato 21 novembre")');
  // a video opens on the site, never in the player
  await page.click('.card:has-text("Sabato 21 novembre")');
  await waitFor(() => page.evaluate(() => window.__opened.length), 5000, 'site opened');
  assert.deepEqual(await page.evaluate(() => window.__opened), [SITE + '/video/verissimo/sabato-21-novembre_F314717301001901']);
  assert.equal(await page.isVisible('#player'), false);
  // titles with HTML entities
  await page.goto(BASE + '#/browse/' + ID + '?p=' + encodeURIComponent('row:/programmitv|1'));
  await page.waitForSelector('.card:has-text("Un\'intervista \\"integrale\\"")');
  console.log('✓ Mediaset: sections, rows, programme page, full lists, videos open on the site');

  // search among the programmes met in the sections
  fetched.length = 0;
  await page.goto(BASE + '#/browse/' + ID);
  await page.click('.row:has-text("Cerca un programma")');
  await page.fill('input[placeholder="Cerca…"]', 'viola mare');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.card:has-text("Viola come il mare")');
  assert.ok(await page.locator('.card:has-text("sul sito")').count(), 'full search on the site offered');
  assert.equal(await page.locator('.card:has-text("Le Iene")').count(), 0);
  assert.ok(fetched.includes('/fiction'), 'sections read for the search');
  console.log('✓ Mediaset: search among the programmes');
  await context.close();

  // without a proxy: say so, and offer the site
  const noProxy = await setup(false);
  await noProxy.page.goto(BASE + '#/browse/' + ID + '?p=' + encodeURIComponent('page:/cinema'));
  await noProxy.page.waitForSelector('.row:has-text("Serve il proxy")');
  assert.ok(await noProxy.page.locator('.row:has-text("Apri Mediaset Infinity")').count());
  await noProxy.context.close();
  console.log('✓ Mediaset: without a proxy, a clear message and the site');

  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
  server.kill();
}
console.log('\nTest Mediaset passati.');
