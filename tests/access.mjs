// Access log: the Worker's AccessLog (Durable Object with SQLite, run here on node:sqlite) joins
// the beats of each device into visits with who / where / how long; only the owner reads it.
// Then a Salotto page with a mocked Worker sends beats and shows Impostazioni → Chi si collega.
// Run: NODE_PATH=$(npm root -g) node tests/access.mjs   (SHOTS=dir saves a screenshot)
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import './addons-dir.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}/`;
const RELAY = 'https://relay.example';
const SHOTS = process.env.SHOTS || '';
const { default: worker, AccessLog } = await import(path.join(ROOT, 'cloudflare/worker.js'));

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(q, ...b) {
      const st = db.prepare(q);
      const rows = /^\s*SELECT/i.test(q) ? st.all(...b) : (st.run(...b), []);
      return { toArray: () => rows.map(r => ({ ...r })) };
    },
  };
  return { storage: { sql } };
}
let log;
const ACCESS = { idFromName: (n) => n, get: () => log };
const env = { TOKEN: 'owner-token-xyz', TOKEN_MARCO: 'marco-ama-il-mare-77', ACCESS };
const W = 'https://salotto-proxy.example.workers.dev';
const cfReq = (url, init, cf) => { const r = new Request(url, init); Object.defineProperty(r, 'cf', { value: cf }); return r; };
const beat = (token, body, cf = { country: 'IT', region: 'Tuscany', city: 'Pisa', asOrganization: 'Telecom Italia' }) =>
  worker.fetch(cfReq(W + '/access?token=' + token, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' } }, cf), env);
const read = async (token, q = '') => { const r = await worker.fetch(new Request(W + '/access?token=' + token + q), env); return { status: r.status, body: r.status === 200 && !q.includes('check') ? await r.json() : await r.text() }; };

async function unit() {
  log = new AccessLog(fakeCtx());
  assert.equal((await worker.fetch(new Request(W + '/access/health'), { TOKEN: 'owner-token-xyz' })).status, 501, 'no binding: 501');
  assert.equal(await (await worker.fetch(new Request(W + '/access/health'), env)).text(), 'ok');
  assert.equal((await beat('wrong', { device: 'devdevdev1' })).status, 401, 'token required');
  assert.equal((await beat(env.TOKEN, { device: 'x' })).status, 400, 'device id checked');

  assert.equal((await beat(env.TOKEN, { device: 'mac-0000001', name: 'Mac', platform: 'Mac Safari (app)', version: '0.28.0', watch: 30 })).status, 200);
  await beat(env.TOKEN, { device: 'mac-0000001', name: 'Mac', platform: 'Mac Safari (app)', version: '0.28.0', watch: 100 });
  await beat(env.TOKEN, { device: 'tv-00000001', name: 'TV', platform: 'Fire TV', version: '0.28.0' });
  await beat(env.TOKEN_MARCO, { device: 'marco-phone', name: 'Android', platform: 'Android Chrome', version: '0.27.8', watch: 9999 },
    { country: 'IT', region: 'Lazio', city: 'Roma', asOrganization: 'Vodafone Italia S.p.A.' });

  assert.equal((await read(env.TOKEN_MARCO)).status, 403, 'a friend cannot read the log');
  assert.equal((await read(env.TOKEN_MARCO, '&check=1')).status, 403);
  assert.equal((await read(env.TOKEN, '&check=1')).status, 200);
  let r = await read(env.TOKEN);
  assert.equal(r.status, 200);
  const s = r.body.sessions;
  assert.equal(s.length, 3, 'two beats of one device are one visit');
  const mac = s.find(v => v.device === 'mac-0000001');
  assert.equal(mac.beats, 2);
  assert.equal(mac.watch, 130);
  assert.equal(mac.who, '');
  assert.equal(mac.city, 'Pisa');
  assert.equal(mac.net, 'Telecom Italia');
  const marco = s.find(v => v.who === 'marco');
  assert.ok(marco, 'friend named from TOKEN_MARCO');
  assert.equal(marco.city, 'Roma');
  assert.equal(marco.watch, 600, 'watching time capped per beat');
  assert.ok(!JSON.stringify(r.body).includes('127.0.0.1'), 'no IP kept');

  // a beat after a long pause opens a new visit
  log.sql.exec('UPDATE visits SET last = last - 3600000, start = start - 3600000 WHERE device = ?', 'tv-00000001');
  await beat(env.TOKEN, { device: 'tv-00000001', name: 'TV', platform: 'Fire TV', version: '0.28.0' });
  r = await read(env.TOKEN);
  assert.equal(r.body.sessions.filter(v => v.device === 'tv-00000001').length, 2, 'new visit after a gap');
  console.log('✓ Worker: beats → visits, who/where from Cloudflare, owner only');
}

async function waitFor(fn, ms, what) {
  const t = Date.now();
  while (!(await fn())) {
    if (Date.now() - t > ms) throw new Error('timeout ' + what);
    await new Promise(r => setTimeout(r, 150));
  }
}

async function ui() {
  log = new AccessLog(fakeCtx());
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const errors = [];
  let beats = 0;
  try {
    await waitFor(() => fetch(BASE).then(r => r.ok).catch(() => false), 8000, 'server');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await ctx.route(/^https:\/\/(?!relay\.example)/, r => r.fulfill({ status: 404, body: '' }));
    await ctx.route(RELAY + '/proxy/health**', r => r.fulfill({ status: 200, body: 'ok', headers: { 'access-control-allow-origin': '*' } }));
    await ctx.route(RELAY + '/proxy?**', r => r.fulfill({ status: 404, body: '', headers: { 'access-control-allow-origin': '*' } }));
    await ctx.route(RELAY + '/sync**', r => r.fulfill({ status: 501, body: 'no', headers: { 'access-control-allow-origin': '*' } }));
    await ctx.route(RELAY + '/addons/**', r => r.fulfill({ status: 404, body: '', headers: { 'access-control-allow-origin': '*' } }));
    await ctx.route(RELAY + '/access**', async (r) => {
      const req = r.request();
      if (req.method() === 'POST') beats++;
      const res = await worker.fetch(cfReq(req.url(), { method: req.method(), body: req.postData() || undefined }, { country: 'IT', city: 'Pisa', region: 'Tuscany', asOrganization: 'Telecom Italia' }), env);
      r.fulfill({ status: res.status, contentType: res.headers.get('content-type') || 'text/plain', body: await res.text(), headers: { 'access-control-allow-origin': '*' } });
    });
    await ctx.addInitScript(([relay, token]) => {
      if (localStorage.getItem('salotto:settings')) return;
      localStorage.setItem('salotto:settings', JSON.stringify({ proxyUrl: relay, proxyToken: token }));
      localStorage.setItem('salotto:sync', JSON.stringify({ on: false, group: 'casa' }));
    }, [RELAY, env.TOKEN]);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE);
    await waitFor(async () => beats > 0, 10000, 'first beat');
    const dev = await page.evaluate(() => localStorage.getItem('salotto:device'));
    assert.match(JSON.parse(dev), /^[0-9a-f]{24}$/, 'random device id kept on the device');
    // a friend of the owner, elsewhere
    await beat(env.TOKEN_MARCO, { device: 'marco-phone', name: 'Android', platform: 'Android Chrome', version: '0.28.0' }, { country: 'IT', region: 'Lazio', city: 'Roma', asOrganization: 'Vodafone' });

    await page.goto(BASE + '#/settings');
    await page.waitForSelector('#access-btn', { state: 'visible' });
    await page.click('#access-btn');
    await page.waitForSelector('table.access');
    const txt = await page.textContent('#view');
    assert.match(txt, /Collegati adesso: 2/);
    assert.match(txt, /marco/);
    assert.match(txt, /Pisa, Tuscany, IT/);
    assert.match(txt, /Roma, Lazio, IT/);
    assert.match(txt, /Chromium|Linux/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'access.png'), fullPage: true });

    // with a friend's token the page explains it is the owner's
    await page.evaluate((t) => { const s = JSON.parse(localStorage.getItem('salotto:settings')); s.proxyToken = t; localStorage.setItem('salotto:settings', JSON.stringify(s)); }, env.TOKEN_MARCO);
    await page.goto(BASE + '#/settings');
    await page.reload();
    await page.waitForTimeout(1500);
    assert.equal(await page.isVisible('#access-btn'), false, 'friends do not see the button');
    await page.goto(BASE + '#/access');
    await page.waitForFunction(() => /solo il proprietario/.test(document.getElementById('view').textContent));
    console.log('✓ app: beats sent, «Chi si collega» lists visits, friends are refused');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.kill();
  }
}

await unit();
await ui();
console.log('access: all good');
