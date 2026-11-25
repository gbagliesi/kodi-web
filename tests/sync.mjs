// Sync between devices: the Worker's SyncStore (Durable Object with SQLite, run here on
// node:sqlite) and three Salotto pages with their own storage talking to it through a mocked
// Worker address: favourites, settings, resume points and add-ons travel; a device switched
// off keeps its own; the newest change wins.
// Run: NODE_PATH=$(npm root -g) node tests/sync.mjs   (SHOTS=dir saves screenshots)
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}/`;
const RELAY = 'https://relay.example';
const SHOTS = process.env.SHOTS || '';
const { default: worker, SyncStore } = await import(path.join(ROOT, 'cloudflare/worker.js'));

// ---------------------------------------------------------------- Durable Object storage
function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(q, ...b) {
      const st = db.prepare(q);
      const rows = /^\s*SELECT/i.test(q) ? st.all(...b) : (st.run(...b), []);
      return { toArray: () => rows.map(r => ({ ...r })) };
    },
  };
  return { storage: { sql, transactionSync: (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } } };
}
const stores = new Map();
const SYNC = { idFromName: (n) => n, get: (id) => { if (!stores.has(id)) stores.set(id, new SyncStore(fakeCtx())); return stores.get(id); } };
const env = { TOKEN: 'tok', SYNC };

const W = 'https://salotto-proxy.example.workers.dev';
const send = async (body, q = 'token=tok&group=casa', e = env) => {
  const res = await worker.fetch(new Request(W + '/sync?' + q, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), e);
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
};

async function unit() {
  assert.equal((await worker.fetch(new Request(W + '/sync/health'), { TOKEN: 'tok' })).status, 501, 'no binding: 501');
  assert.equal(await (await worker.fetch(new Request(W + '/sync/health'), env)).text(), 'ok');
  assert.equal((await send({}, 'group=casa')).status, 401, 'token required');
  assert.equal((await send({}, 'token=tok&group=Casa Mia!')).status, 400, 'group checked');
  const pre = await worker.fetch(new Request(W + '/sync?token=tok', { method: 'OPTIONS' }), env);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);

  let r = await send({ since: 0, changes: [] });
  assert.deepEqual(r.body, { rev: 0, full: false, entries: {} });
  const t0 = Date.now() - 10000;
  r = await send({ since: 0, changes: [{ id: 'fav/a', v: { key: 'a' }, t: t0 }, { id: 'settings/viewMode', v: 'list', t: t0 }] });
  assert.equal(r.body.rev, 2);
  assert.deepEqual(Object.keys(r.body.entries).sort(), ['fav/a', 'settings/viewMode']);
  // another device: older change loses, newer wins, and it hears about both
  r = await send({ since: 2, changes: [{ id: 'settings/viewMode', v: 'grid', t: t0 - 5000 }, { id: 'fav/b', v: { key: 'b' }, t: t0 + 1 }] });
  assert.equal(r.body.entries['settings/viewMode'].v, 'list', 'older change told what won');
  assert.equal(r.body.rev, 3);
  r = await send({ since: 3, changes: [] });
  assert.deepEqual(r.body.entries, {}, 'nothing new');
  r = await send({ since: 2, changes: [] });
  assert.deepEqual(Object.keys(r.body.entries), ['fav/b']);
  // deletion = tombstone; a clock in the future does not win forever
  r = await send({ since: 3, changes: [{ id: 'fav/a', v: null, t: Date.now() + 86400000 * 365 }] });
  assert.equal(r.body.entries['fav/a'].v, null);
  assert.ok(r.body.entries['fav/a'].t <= Date.now());
  r = await send({ since: 4, changes: [{ id: 'fav/a', v: { key: 'a', again: 1 }, t: Date.now() }] });
  assert.equal(r.body.entries['fav/a'].v.again, 1, 're-added after a far-future delete');
  // weak: fills a gap or a deletion, never replaces a shared value (the losing value is kept in history)
  r = await send({ since: 0, changes: [{ id: 'astore/x/list', v: [1], t: Date.now(), weak: true }] });
  assert.deepEqual(r.body.entries['astore/x/list'].v, [1]);
  r = await send({ since: 0, changes: [{ id: 'astore/x/list', v: [], t: Date.now(), weak: true }] });
  assert.deepEqual(r.body.entries['astore/x/list'].v, [1], 'weak loses against a value');
  await send({ since: 0, changes: [{ id: 'astore/x/list', v: null, t: Date.now() }] });
  r = await send({ since: 0, changes: [{ id: 'astore/x/list', v: [2], t: Date.now() - 60000, weak: true }] });
  assert.deepEqual(r.body.entries['astore/x/list'].v, [2], 'weak wins against a deletion');
  // groups are separate
  r = await send({ since: 0, changes: [] }, 'token=tok&group=bambini');
  assert.deepEqual(r.body.entries, {});
  // device from before a reset (since > rev) gets everything
  r = await send({ since: 999, changes: [] });
  assert.equal(r.body.full, true);
  assert.equal(Object.keys(r.body.entries).length, 4);
  // too big values are refused one by one
  r = await send({ since: 5, changes: [{ id: 'big', v: 'x'.repeat(70000), t: Date.now() }] });
  assert.equal(r.body.entries.big, undefined);
  console.log('✓ worker: sync store (token, groups, revisions, newest wins, tombstones, full state)');
}

// ---------------------------------------------------------------- the app on three devices
async function waitFor(fn, ms = 10000, what = '') {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timeout ' + what);
    await new Promise(r => setTimeout(r, 150));
  }
}

let calls = 0;
async function device(browser, name, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await ctx.route(/^https:\/\/(?!relay\.example)/, r => r.fulfill({ status: 404, body: '' }));
  await ctx.route(RELAY + '/proxy/health**', r => r.fulfill({ status: 200, body: 'ok', headers: { 'access-control-allow-origin': '*' } }));
  await ctx.route(RELAY + '/proxy?**', r => r.fulfill({ status: 404, body: '', headers: { 'access-control-allow-origin': '*' } }));
  await ctx.route(RELAY + '/sync**', async (r) => {
    calls++;
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'POST' } });
    const res = await worker.fetch(new Request(req.url(), { method: req.method(), body: req.postData(), headers: { 'Content-Type': 'application/json' } }), env);
    r.fulfill({ status: res.status, contentType: 'application/json', body: await res.text(), headers: { 'access-control-allow-origin': '*' } });
  });
  await ctx.addInitScript(([relay, extra]) => {
    if (localStorage.getItem('salotto:settings')) return;
    localStorage.setItem('salotto:settings', JSON.stringify({ proxyUrl: relay, proxyToken: 'tok', startPage: extra.startPage || '' }));
    if (extra.sync) localStorage.setItem('salotto:sync', JSON.stringify(extra.sync));
  }, [RELAY, extra]);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  await page.goto(BASE);
  await page.waitForFunction(() => window.salotto?.sync && window.salotto.addons.getInstalled('plugin.video.youtube'));
  await waitFor(() => page.evaluate(() => window.salotto.sync.getStatus().state === 'ok' || window.salotto.sync.getStatus().state === 'off'), 10000, name + ' first sync');
  return page;
}
const syncNow = (p) => p.evaluate(() => window.salotto.sync.syncNow());
const favKeys = (p) => p.evaluate(() => window.salotto.store.getFavourites().map(f => f.key));
const fav = (key, label) => ({ key, addonId: 'plugin.video.demo', item: { label, url: 'https://example.org/' + key + '.mp4' } });

const errors = [];
async function ui() {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
  const browser = await chromium.launch();
  stores.clear();
  try {
    await waitFor(() => fetch(BASE).then(r => r.ok).catch(() => false), 8000, 'server');
    // ---- device A: favourites, an add-on key, a disabled add-on, a setting, a resume point
    const a = await device(browser, 'A', { startPage: '#/live' });
    await a.evaluate(([f1, f2]) => {
      const { store, addons } = window.salotto;
      store.toggleFavourite(f1); store.toggleFavourite(f2);
      addons.setAddonSettings('plugin.video.youtube', { apiKey: 'chiave-di-prova' });
      addons.setEnabled('plugin.audio.podcast', false);
      store.setSettings({ viewMode: 'list' });
      store.setResume('plugin.video.demo|film', 600, 5400);
      return addons.writeAddonStore('plugin.video.youtube', 'channels', [{ id: 'UCprova', title: 'Canale di prova' }]);
    }, [fav('f1', 'Primo'), fav('f2', 'Secondo')]);
    await syncNow(a);
    assert.deepEqual(await favKeys(a), ['f2', 'f1']);

    // ---- device B, new: gets all of it, start page included
    const b = await device(browser, 'B');
    await waitFor(async () => (await favKeys(b)).length === 2, 10000, 'B favourites');
    assert.deepEqual(await favKeys(b), ['f2', 'f1'], 'same order');
    const bState = await b.evaluate(() => {
      const { store, addons } = window.salotto;
      return { key: addons.getAddonSettings('plugin.video.youtube').apiKey, podcast: addons.getInstalled('plugin.audio.podcast').enabled, view: store.getSettings().viewMode, start: store.getSettings().startPage, proxy: store.getSettings().proxyUrl, resume: store.getResume('plugin.video.demo|film') };
    });
    assert.deepEqual(bState, { key: 'chiave-di-prova', podcast: false, view: 'list', start: '#/live', proxy: RELAY, resume: 600 });
    assert.deepEqual(await b.evaluate(() => window.salotto.addons.readAddonStore('plugin.video.youtube', 'channels')), [{ id: 'UCprova', title: 'Canale di prova' }], 'YouTube saved channels');
    // the browser loses the add-on data (or an old «Forza aggiornamento»): it comes back, never deleted everywhere
    await b.evaluate(() => caches.delete('salotto-addon-data'));
    await syncNow(b);
    assert.deepEqual(await b.evaluate(() => window.salotto.addons.readAddonStore('plugin.video.youtube', 'channels')), [{ id: 'UCprova', title: 'Canale di prova' }], 'lost add-on data restored');
    await syncNow(a);
    assert.deepEqual(await a.evaluate(() => window.salotto.addons.readAddonStore('plugin.video.youtube', 'channels')), [{ id: 'UCprova', title: 'Canale di prova' }], 'not deleted on A');
    await b.goto(BASE + '#/favourites');
    await b.waitForSelector('#view :text("Secondo")');
    console.log('✓ a new device gets favourites, resume points, settings, add-on settings and saved YouTube channels and the start page (not the proxy)');

    // ---- changes go both ways; the Favourites page updates by itself
    await b.evaluate((f) => { window.salotto.store.toggleFavourite(f); window.salotto.addons.uninstall('plugin.video.archive'); }, fav('f1'));
    await syncNow(b);
    await a.goto(BASE + '#/favourites');
    await a.waitForSelector('#view :text("Primo")');
    await syncNow(a);
    await waitFor(async () => !(await a.textContent('#view')).includes('Primo'), 8000, 'A page refreshed');
    assert.deepEqual(await favKeys(a), ['f2']);
    assert.equal(await a.evaluate(() => !!window.salotto.addons.getInstalled('plugin.video.archive')), false, 'add-on removed on A too');
    console.log('✓ removing a favourite or an add-on on one device removes it on the others; open page refreshes');

    // ---- a device that joins with favourites of its own keeps them and shares them
    const c = await device(browser, 'C', { sync: { on: false, group: 'casa' } });
    await c.evaluate((f) => { window.salotto.store.toggleFavourite(f); return window.salotto.addons.writeAddonStore('plugin.video.youtube', 'channels', []); }, fav('c1', 'Di C'));
    await syncNow(c);
    assert.deepEqual(await favKeys(c), ['c1'], 'off: nothing arrives');
    assert.equal(await c.evaluate(() => window.salotto.addons.getAddonSettings('plugin.video.youtube').apiKey), '');
    await c.goto(BASE + '#/settings');
    assert.match(await c.textContent('#sync-status'), /non si sincronizza/);
    if (SHOTS) await c.screenshot({ path: path.join(SHOTS, 'sync-off.png') });
    await c.check('#sync-on');
    await waitFor(async () => (await favKeys(c)).length === 2, 10000, 'C joined');
    assert.deepEqual((await favKeys(c)).sort(), ['c1', 'f2']);
    await syncNow(c); await syncNow(a);
    assert.equal((await a.evaluate(() => window.salotto.addons.readAddonStore('plugin.video.youtube', 'channels'))).length, 1, "C's empty channel list did not wipe A's");
    assert.equal((await c.evaluate(() => window.salotto.addons.readAddonStore('plugin.video.youtube', 'channels'))).length, 1, 'C got the channels');
    await waitFor(() => c.textContent('#sync-status').then(t => /Sincronizzato alle/.test(t)), 8000, 'status');
    if (SHOTS) await c.screenshot({ path: path.join(SHOTS, 'sync-on.png') });
    await syncNow(a);
    assert.deepEqual((await favKeys(a)).sort(), ['c1', 'f2']);
    console.log('✓ a device switched off keeps its own; switching on takes the others\' and shares its own');

    // ---- unlinking a device: its changes stay there
    await c.uncheck('#sync-on');
    await c.evaluate(() => window.salotto.store.setSettings({ viewMode: 'grid' }));
    await syncNow(c);
    await syncNow(a);
    assert.equal(await a.evaluate(() => window.salotto.store.getSettings().viewMode), 'list');
    // newest change wins
    await a.evaluate(() => window.salotto.store.setSettings({ viewMode: 'auto' }));
    await new Promise(r => setTimeout(r, 20));
    await b.evaluate(() => window.salotto.store.setSettings({ viewMode: 'grid' }));
    await syncNow(a); await syncNow(b); await syncNow(a);
    assert.equal(await a.evaluate(() => window.salotto.store.getSettings().viewMode), 'grid');
    assert.equal(await b.evaluate(() => window.salotto.store.getSettings().viewMode), 'grid');
    console.log('✓ an unlinked device sends nothing; the newest change wins');

    // ---- changes are sent on their own a few seconds later; idle visits are cheap
    await b.evaluate((f) => window.salotto.store.toggleFavourite(f), fav('auto', 'Da solo'));
    await waitFor(async () => { await syncNow(a); return (await favKeys(a)).includes('auto'); }, 15000, 'auto push');
    console.log('✓ changes go out by themselves');
    // Giuseppe's case: an old deletion of the channels on the Worker, then channels added again here
    const CH = 'astore/plugin.video.youtube/channels';
    const st = await a.evaluate(() => JSON.parse(localStorage.getItem('salotto:sync-state')).rev);
    await send({ since: st, changes: [{ id: CH, v: null, t: Date.now() }] });
    await a.evaluate(() => caches.delete('salotto-addon-data'));
    await syncNow(a);
    await a.evaluate(() => window.salotto.addons.writeAddonStore('plugin.video.youtube', 'channels', [{ id: 'UCnuovo', title: 'Nuovo' }]));
    await syncNow(a); await syncNow(a);
    assert.deepEqual(await a.evaluate(() => window.salotto.addons.readAddonStore('plugin.video.youtube', 'channels')), [{ id: 'UCnuovo', title: 'Nuovo' }], 'channels added after an old deletion stay');
    await syncNow(b);
    assert.deepEqual(await b.evaluate(() => window.salotto.addons.readAddonStore('plugin.video.youtube', 'channels')), [{ id: 'UCnuovo', title: 'Nuovo' }], 'and reach the other devices');
    console.log('✓ channels added again after an old deletion stay and travel');
    // «Forza aggiornamento» keeps what add-ons saved
    await a.goto(BASE + '#/settings');
    await a.click('text=Forza aggiornamento');
    await a.waitForURL(/[?&]r=/);
    await a.waitForFunction(() => window.salotto?.addons);
    assert.equal((await a.evaluate(() => window.salotto.addons.readAddonStore('plugin.video.youtube', 'channels'))).length, 1, 'force update keeps add-on data');
    console.log('✓ «Forza aggiornamento» keeps the YouTube channels; lost add-on data comes back from the others');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.kill();
  }
}

await unit();
await ui();
console.log('sync: all good');
