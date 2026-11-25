// Storage test: add-on code lives in Cache Storage, not localStorage, so the app still installs
// its add-ons when another page of the same site has nearly filled localStorage; add-ons
// installed by older versions (code inside localStorage) are moved out at start-up.
// Run: node tests/storage.mjs   (needs playwright)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}/`;
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 150)); } };

const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
const browser = await chromium.launch();
const errors = [];
try {
  await waitFor(() => fetch(BASE + 'proxy/health').then(r => r.ok).catch(() => false));
  const block = (ctx) => ctx.route(/^https:\/\/(?!127\.0\.0\.1)/, r => r.fulfill({ status: 404, body: '' }));

  // 1) another page of the site filled localStorage almost to the brim
  let ctx = await browser.newContext({ serviceWorkers: 'block' });
  await block(ctx);
  await ctx.addInitScript(() => {
    if (localStorage.getItem('altra-app')) return;
    let n = 2400 * 1024; // characters (UTF-16: ~4.7 MB)
    for (;;) { try { localStorage.setItem('altra-app', 'x'.repeat(n)); break; } catch { n -= 8192; } }
    // leave about 40 KB
    localStorage.setItem('altra-app', 'x'.repeat(Math.max(0, n - 20 * 1024)));
  });
  let page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('.hero');
  const ids = await page.evaluate(() => window.salotto.addons.listInstalled().map(a => a.manifest.id + (a.code ? '+code' : '')));
  assert.equal(ids.length, 7, 'all bundled add-ons installed: ' + ids);
  assert.ok(ids.every(i => !i.endsWith('+code')), 'no code in localStorage');
  await page.goto(BASE + '#/browse/plugin.video.demo');
  await page.waitForSelector('.row, .card');
  await page.goto(BASE + '#/settings');
  assert.match(await page.textContent('#view'), /Memoria del browser: Salotto \d+ KB, altre pagine dello stesso sito \d{4} KB/);
  console.log('✓ add-ons install and run with localStorage nearly full (code in Cache Storage)');
  await ctx.close();

  // 2) an add-on installed by an older version, code inside localStorage: moved out, still works
  ctx = await browser.newContext({ serviceWorkers: 'block' });
  await block(ctx);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'addons/plugin.video.demo/addon.json'), 'utf8'));
  const code = fs.readFileSync(path.join(ROOT, 'addons/plugin.video.demo/main.js'), 'utf8');
  await ctx.addInitScript(([manifest, code]) => {
    if (localStorage.getItem('salotto:addons')) return;
    localStorage.setItem('salotto:addons', JSON.stringify({ 'plugin.video.demo': { manifest, code, source: 'local', manifestUrl: '', enabled: true, settings: {} } }));
    localStorage.setItem('salotto:bundled-installed', 'true');
    localStorage.setItem('salotto:bundled-seen', JSON.stringify(['plugin.video.demo', 'plugin.video.archive', 'plugin.video.iptv', 'plugin.audio.radiobrowser', 'plugin.audio.podcast', 'plugin.video.raiplay', 'plugin.video.la7']));
  }, [manifest, code]);
  page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('.hero');
  await waitFor(() => page.evaluate(() => !JSON.parse(localStorage.getItem('salotto:addons'))['plugin.video.demo'].code));
  await page.goto(BASE + '#/browse/plugin.video.demo');
  await page.waitForSelector('.row, .card');
  console.log('✓ code of add-ons from older versions moved out of localStorage; add-on still runs');
  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await browser.close();
  server.kill();
}
console.log('\nTest memoria passati.');
