// Private add-ons and friends' tokens: the Worker serves the add-on repository at
// /addons/<token>/… (read from GitHub, mocked here), friends' tokens from TOKENS work like TOKEN
// but keep their own sync groups; in the app the Worker's repository is listed first, its
// add-ons install from there and a public copy of an installed add-on moves to the Worker.
// Run: NODE_PATH=$(npm root -g) node tests/private-addons.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}/`;
const W = 'https://relay.example';
const { default: worker, SyncStore, friendTokens } = await import(path.join(ROOT, 'cloudflare/worker.js'));

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } };
  return { storage: { sql } };
}
const stores = new Map();
const SYNC = { idFromName: (n) => n, get: (id) => { if (!stores.has(id)) stores.set(id, new SyncStore(fakeCtx())); return stores.get(id); } };
const OWNER = 'owner-token-1234567890';
const ANNA = 'anna-token-abcdefghijkl';
const env = { TOKEN: OWNER, TOKENS: `anna=${ANNA}\nmarco=corto, bad name=xxxxxxxxxxxxxxxxxxxx`, SYNC, ADDONS_GITHUB_TOKEN: 'ghp_test', ADDONS_REPO: 'me/private' };

// ---- GitHub contents API, mocked: the private repository is a copy of addons/ with the demo add-on
const PRIVATE = {
  'repository.json': JSON.stringify({ name: 'Add-on privati', addons: [{ id: 'plugin.video.demo', name: 'Video di prova', version: '9.0.0', manifest: 'plugin.video.demo/addon.json', icon: 'plugin.video.demo/icon.svg' }] }),
  'plugin.video.demo/addon.json': JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(ROOT, 'addons/plugin.video.demo/addon.json'), 'utf8')), version: '9.0.0' }),
  'plugin.video.demo/main.js': fs.readFileSync(path.join(ROOT, 'addons/plugin.video.demo/main.js'), 'utf8'),
  'plugin.video.demo/icon.svg': fs.readFileSync(path.join(ROOT, 'addons/plugin.video.demo/icon.svg'), 'utf8'),
};
let github = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.host === 'api.github.com') {
    github++;
    assert.equal(opts.headers.Authorization, 'Bearer ghp_test');
    const m = u.pathname.match(/^\/repos\/me\/private\/contents\/(.+)$/);
    const body = m && PRIVATE[m[1]];
    return body ? new Response(body) : new Response('{}', { status: 404 });
  }
  if (u.host === 'cdn.example') return new Response('#EXTM3U\nseg1.ts\n', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  return realFetch(url, opts);
};

const call = (p, e = env, init) => worker.fetch(new Request(W + p, init), e);
const sync = async (token, body) => {
  const res = await call('/sync?token=' + token + '&group=casa', env, { method: 'POST', body: JSON.stringify(body) });
  return res.status === 200 ? res.json() : res.status;
};

async function unit() {
  assert.deepEqual(friendTokens(env).map(f => f.name), ['anna'], 'short tokens and bad names are ignored');
  // tokens
  assert.equal((await call('/proxy/health?token=' + OWNER)).status, 200);
  assert.equal((await call('/proxy/health?token=' + ANNA)).status, 200, 'a friend token works');
  assert.equal((await call('/proxy/health?token=corto')).status, 401, 'a too short friend token does not');
  assert.equal((await call('/proxy/health?token=' + ANNA, { ...env, TOKENS: '' })).status, 401, 'revoked');
  // a friend's sync groups are their own
  await sync(OWNER, { since: 0, changes: [{ id: 'fav/mio', v: { key: 'mio' }, t: Date.now() }] });
  let r = await sync(ANNA, { since: 0, changes: [] });
  assert.deepEqual(r.entries, {}, "the friend does not see the owner's favourites");
  await sync(ANNA, { since: 0, changes: [{ id: 'fav/suo', v: { key: 'suo' }, t: Date.now() }] });
  r = await sync(OWNER, { since: 0, changes: [] });
  assert.deepEqual(Object.keys(r.entries), ['fav/mio']);
  // the playlist's segments carry the caller's token
  const pl = await (await call('/proxy?token=' + ANNA + '&url=' + encodeURIComponent('https://cdn.example/live.m3u8'))).text();
  assert.match(pl, new RegExp('token=' + ANNA));
  assert.doesNotMatch(pl, new RegExp(OWNER));

  // add-ons
  assert.equal(await (await call('/addons/health')).text(), 'ok');
  assert.equal((await call('/addons/health', { TOKEN: OWNER })).status, 501);
  assert.equal((await call('/addons/sbagliato/repository.json')).status, 401);
  assert.equal((await call('/addons/repository.json')).status, 400, 'no token segment');
  assert.equal((await call('/addons/' + OWNER + '/../secrets')).status, 400);
  assert.equal((await call('/addons/' + OWNER + '/.git/config')).status, 400, 'hidden files refused');
  let res = await call('/addons/' + ANNA + '/repository.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('content-type'), /json/);
  assert.equal(JSON.parse(await res.text()).addons[0].version, '9.0.0');
  res = await call('/addons/' + OWNER + '/plugin.video.demo/icon.svg');
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.equal((await call('/addons/' + OWNER + '/nessuno/addon.json')).status, 404);
  assert.equal((await call('/addons/' + OWNER + '/repository.json', { ...env, ADDONS_GITHUB_TOKEN: '' })).status, 501);
  console.log('worker: ok');
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

async function ui() {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const errors = [];
  try {
    await waitFor(() => realFetch(BASE).then(r => r.ok).catch(() => false), 8000, 'server');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await ctx.route(/^https:\/\/(?!relay\.example)/, r => r.fulfill({ status: 404, body: '' }));
    await ctx.route(W + '/**', async (r) => {
      const req = r.request();
      if (/\/sync\?/.test(req.url())) return r.fulfill({ status: 501, body: '', headers: { 'access-control-allow-origin': '*' } });
      const res = await worker.fetch(new Request(req.url(), { method: req.method() }), env);
      r.fulfill({ status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: Object.fromEntries(res.headers) });
    });
    await ctx.addInitScript((w) => {
      if (localStorage.getItem('salotto:settings')) return;
      localStorage.setItem('salotto:settings', JSON.stringify({ proxyUrl: w, proxyToken: 'anna-token-abcdefghijkl' }));
      localStorage.setItem('salotto:sync', JSON.stringify({ on: false }));
    }, W);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE);
    await page.waitForFunction(() => window.salotto?.addons.getInstalled('plugin.video.demo'));
    // the public copy of the demo add-on moved to the Worker (newer version there)
    await waitFor(() => page.evaluate(() => window.salotto.addons.getInstalled('plugin.video.demo').manifest.version === '9.0.0'), 10000, 'update from the Worker');
    const rec = await page.evaluate(() => window.salotto.addons.getInstalled('plugin.video.demo'));
    assert.equal(rec.manifestUrl, W + '/addons/anna-token-abcdefghijkl/plugin.video.demo/addon.json');
    // the Worker's repository is listed first
    await page.goto(BASE + '#/addons/repo');
    await page.waitForSelector('.section-title');
    assert.equal(await page.locator('.section-title').first().textContent(), 'Add-on privati');
    // a new token: the saved address is read with it
    await page.evaluate(() => window.salotto.store.setSettings({ proxyToken: 'owner-token-1234567890' }));
    await page.evaluate(() => window.salotto.addons.detectProxy());
    assert.equal(await page.evaluate((u) => window.salotto.addons.withCurrentToken(u), rec.manifestUrl), W + '/addons/owner-token-1234567890/plugin.video.demo/addon.json');
    await page.evaluate(() => window.salotto.addons.uninstall('plugin.video.demo'));
    await page.evaluate((u) => window.salotto.addons.installFromManifestUrl(u, { source: 'repo' }), rec.manifestUrl);
    assert.equal(await page.evaluate(() => window.salotto.addons.getInstalled('plugin.video.demo').manifestUrl), W + '/addons/owner-token-1234567890/plugin.video.demo/addon.json');
    // the add-on runs from the Worker's code
    await page.goto(BASE + '#/browse/plugin.video.demo');
    await page.waitForSelector('.tile, .row', { timeout: 10000 });
    // without a token there is no Worker repository, just a hint
    await page.evaluate(() => { window.salotto.store.setSettings({ proxyToken: '' }); return window.salotto.addons.detectProxy(); });
    await page.goto(BASE + '#/addons');
    await page.goto(BASE + '#/addons/repo');
    await page.waitForSelector('.section-title');
    assert.match(await page.locator('.empty').first().textContent(), /add-on privati/);
    assert.deepEqual(errors, []);
    console.log('app: ok');
  } finally {
    await browser.close();
    server.kill();
  }
}

await unit();
await ui();
console.log('private add-ons: all ok');
