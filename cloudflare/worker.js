/*
 * Salotto – proxy for Cloudflare Workers (free plan is enough for personal use).
 *
 * Same API as the /proxy endpoint of server.js:
 *   GET /proxy/health                      -> "ok"
 *   GET /proxy?url=<enc>[&headers=<json>]  -> the resource, with CORS headers;
 *   GET /proxy/live.m3u8?url=…             -> same, with a file name for players that need one;
 *                                             HLS playlists are rewritten so
 *                                             every segment also goes through here.
 *   GET /proxy?url=<enc>&resolve=1          -> {"url": where the redirects end, "status", "type"}:
 *                                             for redirectors without CORS (Rai relinker), so the
 *                                             browser can then fetch the real stream itself.
 *
 * Phone remote (only here, not in server.js):
 *   GET /remote/health                     -> "ok" when the remote relay is set up
 *   GET /remote/status?room=<id>            -> {"tv":1,"remotes":0}: is the screen on?
 *   GET /remote/ws?room=<id>&role=tv|remote -> WebSocket; the Durable Object of the room passes
 *                                             every message of the TV to its remotes and back.
 *   Needs the REMOTE Durable Object binding of wrangler.toml (the GitHub Action deploys it).
 *
 * Sync between devices (only here, not in server.js):
 *   GET  /sync/health                       -> "ok" when the sync store is set up
 *   POST /sync?token=…&group=<name>          -> body {since, changes:[{id, v, t}]}; answers
 *                                             {rev, full, entries:{id:{v,t}}}: what changed
 *                                             (change.weak: only if the entry is missing or deleted;
 *                                             want: [ids] also returned)
 *                                             after revision `since` (v null = deleted).
 *   One Durable Object (SyncStore, SQLite) per group; needs the SYNC binding of wrangler.toml.
 *
 * Settings (Worker → Settings → Variables and Secrets):
 *   TOKEN   secret, REQUIRED: every call must carry ?token=<TOKEN>. Without it the Worker
 *           refuses everything (503), so a fresh deploy is never an open proxy.
 *           Use a long random value of your own (docs/CLOUDFLARE.md shows how to make one);
 *           the example once printed in the docs is refused.
 *   GET /proxy/health?token=…  -> "ok", or 401 when the token is wrong, 503 when TOKEN is unset.
 *
 * Setup guide: docs/CLOUDFLARE.md
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
};

const FORWARD_HEADERS = /^(referer|user-agent|origin|cookie|authorization|accept-language)$/i;
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control'];
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// Values that were published as examples: whoever copied one must choose a new secret.
const PUBLISHED_EXAMPLES = new Set(['girasole-blu-42']);

/** Constant-time string comparison (no early exit on the first different character). */
function sameSecret(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/** null when the call carries the right token, otherwise the response refusing it. */
function refuse(env, u) {
  const token = String(env.TOKEN || '');
  if (!token) return text('proxy non protetto: imposta il secret TOKEN nel Worker (docs/CLOUDFLARE.md)', 503);
  if (PUBLISHED_EXAMPLES.has(token)) return text('il TOKEN del Worker è quello di esempio della guida: scegline uno nuovo (docs/CLOUDFLARE.md)', 503);
  if (!sameSecret(u.searchParams.get('token') || '', token)) return text('token mancante o errato', 401);
  return null;
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

function proxyLink(target, headersParam, token) {
  let s = 'proxy?url=' + encodeURIComponent(target);
  if (headersParam) s += '&headers=' + encodeURIComponent(headersParam);
  if (token) s += '&token=' + encodeURIComponent(token);
  return s;
}

export function rewritePlaylist(body, baseUrl, headersParam, token) {
  const abs = (ref) => { try { return new URL(ref, baseUrl).href; } catch { return ref; } };
  return body.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, ref) => `URI="${proxyLink(abs(ref), headersParam, token)}"`);
    return proxyLink(abs(t), headersParam, token);
  }).join('\n');
}

// ---------------------------------------------------------------- phone remote
// A room is one Salotto screen (computer, iPad, Fire TV) and the phones paired with it. Its
// name is a long random id shown only in the pairing QR code, so it works as the room's key.
const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_MSG = 512 * 1024;

export class RemoteRoom {
  constructor(ctx) {
    this.ctx = ctx;
    // keep-alive pings are answered without waking the object up
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch { /* older runtime */ }
  }

  peers() {
    return { tv: this.ctx.getWebSockets('tv').length, remotes: this.ctx.getWebSockets('remote').length };
  }

  announce(except) {
    const msg = JSON.stringify({ t: 'peers', ...this.peers() });
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) { try { ws.send(msg); } catch { /* closing */ } }
  }

  async fetch(request) {
    // is the screen on? (the phone's list of screens) – no WebSocket, nobody is told
    if (new URL(request.url).pathname.endsWith('/remote/status')) {
      return new Response(JSON.stringify(this.peers()), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (request.headers.get('Upgrade') !== 'websocket') return text('serve una WebSocket', 426);
    const role = new URL(request.url).searchParams.get('role') === 'tv' ? 'tv' : 'remote';
    // one screen per room: a newer TV connection (page reloaded) replaces the old one
    if (role === 'tv') for (const old of this.ctx.getWebSockets('tv')) { try { old.close(4000, 'sostituita'); } catch { /* gone */ } }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    server.send(JSON.stringify({ t: 'peers', ...this.peers() }));
    this.announce(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) return;
    const to = this.ctx.getTags(ws).includes('tv') ? 'remote' : 'tv';
    for (const peer of this.ctx.getWebSockets(to)) { try { peer.send(msg); } catch { /* closing */ } }
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'chiusa'); } catch { /* already closed */ }
    this.announce(ws);
  }

  webSocketError(ws) { this.webSocketClose(ws, 1011); }
}

function handleRemote(request, env, u) {
  if (!env.REMOTE) return text('telecomando non configurato: pubblica il Worker con wrangler (docs/CLOUDFLARE.md)', 501);
  if (u.pathname.endsWith('/remote/health')) return text('ok');
  const no = refuse(env, u);
  if (no) return no;
  const room = u.searchParams.get('room') || '';
  if (!ROOM_RE.test(room)) return text('stanza non valida', 400);
  return env.REMOTE.get(env.REMOTE.idFromName(room)).fetch(request);
}

// ---------------------------------------------------------------- sync between devices
// Favourites, resume points, settings and add-ons of every Salotto of a group. Each entry
// (e.g. "fav/<key>") keeps its last value and when it was changed: the newest change wins.
// Every write gets a new revision number, so a device asks only for what changed since its last
// visit. Deleted entries stay as tombstones for TOMBSTONE_DAYS, then a device that was away
// longer than that gets the whole state again (full: true).
const GROUP_RE = /^[a-z0-9-]{1,40}$/;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_CHANGES = 3000;
const MAX_VALUE = 64 * 1024;
const ID_MAX = 600;
const TOMBSTONE_DAYS = 90;
const HISTORY_DAYS = 30;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export class SyncStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, v TEXT, t INTEGER NOT NULL, r INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS entries_r ON entries (r)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, n INTEGER NOT NULL)');
    // every value replaced or deleted, kept HISTORY_DAYS: lets a lost value be found again
    this.sql.exec('CREATE TABLE IF NOT EXISTS history (id TEXT NOT NULL, v TEXT NOT NULL, t INTEGER NOT NULL, replaced INTEGER NOT NULL)');
  }

  meta(k) { return this.sql.exec('SELECT n FROM meta WHERE k = ?', k).toArray()[0]?.n || 0; }
  setMeta(k, n) { this.sql.exec('INSERT INTO meta (k, n) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET n = excluded.n', k, n); }

  async fetch(request) {
    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return text('troppi dati', 413);
      body = JSON.parse(raw || '{}');
    } catch { return text('JSON non valido', 400); }
    const since = Math.max(0, Math.floor(+body.since || 0));
    const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_CHANGES) : [];
    const want = Array.isArray(body.want) ? body.want.filter(id => typeof id === 'string').slice(0, 200) : [];
    const now = Date.now();
    let rev = this.meta('rev');
    // nothing new on either side: the usual visit, one row read
    if (!changes.length && !want.length && since === rev) return json({ rev, full: false, entries: {} });

    const touched = new Set();
    const write = () => {
      for (const c of changes) {
        if (!c || typeof c.id !== 'string' || !c.id || c.id.length > ID_MAX) continue;
        const v = c.v === null || c.v === undefined ? null : JSON.stringify(c.v);
        if (v && v.length > MAX_VALUE) continue;
        const t = Math.min(Math.floor(+c.t) || now, now); // a clock in the future must not win forever
        touched.add(c.id);
        const cur = this.sql.exec('SELECT v, t FROM entries WHERE id = ?', c.id).toArray()[0];
        // weak: data a device sends for the first time fills a gap, never replaces a shared value
        const loses = c.weak ? cur && cur.v != null : cur && cur.t > t;
        if (loses) {
          // kept anyway, so a value that lost can still be found again
          if (v != null && v !== cur.v) this.sql.exec('INSERT INTO history (id, v, t, replaced) VALUES (?, ?, ?, ?)', c.id, v, t, now);
          continue; // a newer change from another device is already here
        }
        if (cur && cur.v != null && cur.v !== v) this.sql.exec('INSERT INTO history (id, v, t, replaced) VALUES (?, ?, ?, ?)', c.id, cur.v, cur.t, now);
        rev++;
        this.sql.exec('INSERT INTO entries (id, v, t, r) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET v = excluded.v, t = excluded.t, r = excluded.r', c.id, v, t, rev);
      }
      this.setMeta('rev', rev);
      // forget old tombstones now and then
      if (rev - this.meta('pruneAt') > 500) {
        const old = now - TOMBSTONE_DAYS * 86400000;
        const max = this.sql.exec('SELECT MAX(r) AS m FROM entries WHERE v IS NULL AND t < ?', old).toArray()[0]?.m;
        if (max) { this.sql.exec('DELETE FROM entries WHERE v IS NULL AND t < ?', old); this.setMeta('pruned', Math.max(max, this.meta('pruned'))); }
        this.sql.exec('DELETE FROM history WHERE replaced < ?', now - HISTORY_DAYS * 86400000);
        this.setMeta('pruneAt', rev);
      }
    };
    if (this.ctx.storage.transactionSync) this.ctx.storage.transactionSync(write); else write();

    // a device away for longer than the tombstones last (or from before a reset) gets everything
    const full = since < this.meta('pruned') || since > rev;
    const rows = full ? this.sql.exec('SELECT id, v, t FROM entries').toArray()
      : this.sql.exec('SELECT id, v, t FROM entries WHERE r > ?', since).toArray();
    const entries = {};
    for (const row of rows) entries[row.id] = { v: row.v == null ? null : JSON.parse(row.v), t: row.t };
    // the device's own changes that lost against a newer one: tell it what won
    for (const id of [...touched, ...want]) {
      if (entries[id]) continue;
      const row = this.sql.exec('SELECT v, t FROM entries WHERE id = ?', id).toArray()[0];
      if (row) entries[id] = { v: row.v == null ? null : JSON.parse(row.v), t: row.t };
    }
    return json({ rev, full, entries });
  }
}

function handleSync(request, env, u) {
  if (!env.SYNC) return text('sincronizzazione non configurata: pubblica il Worker con wrangler (docs/CLOUDFLARE.md)', 501);
  if (u.pathname.endsWith('/sync/health')) return text('ok');
  const no = refuse(env, u);
  if (no) return no;
  if (request.method !== 'POST') return text('metodo non consentito', 405);
  const group = (u.searchParams.get('group') || 'casa').toLowerCase();
  if (!GROUP_RE.test(group)) return text('gruppo non valido', 400);
  return env.SYNC.get(env.SYNC.idFromName('sync:' + group)).fetch(request);
}

async function handle(request, env) {
  const u = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (u.pathname.endsWith('/proxy/health')) {
    // without ?token= it only says the Worker is there; with one it also checks it
    if (!env.TOKEN || PUBLISHED_EXAMPLES.has(String(env.TOKEN)) || u.searchParams.has('token')) return refuse(env, u) || text('ok');
    return text('ok');
  }
  if (/\/remote\/(health|ws|status)$/.test(u.pathname)) return handleRemote(request, env, u);
  if (/\/sync(\/health)?$/.test(u.pathname)) return handleSync(request, env, u);
  // /proxy/<name> (e.g. /proxy/live.m3u8) works too: some native players pick the format from the extension
  if (!/\/proxy(\/[\w.-]+)?$/.test(u.pathname)) return text('Salotto proxy: usa /proxy?url=…', 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('metodo non consentito', 405);

  // The token is the only protection: Origin headers are trivial to fake, and the Chromecast
  // fetches streams from a Google address anyway.
  const no = refuse(env, u);
  if (no) return no;
  const token = String(env.TOKEN);

  let target;
  try { target = new URL(u.searchParams.get('url') || ''); } catch { return text('url mancante o non valido', 400); }
  if (!/^https?:$/.test(target.protocol)) return text('solo http/https', 400);
  if (target.host === u.host) return text('richiesta circolare', 400);

  const headersParam = u.searchParams.get('headers') || '';
  const headers = new Headers({ 'User-Agent': DEFAULT_UA, Accept: '*/*' });
  if (headersParam) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(headersParam))) if (FORWARD_HEADERS.test(k)) headers.set(k, String(v));
    } catch { /* ignore malformed headers */ }
  }
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);

  let upstream;
  try {
    upstream = await fetch(target.href, { method: request.method, headers, redirect: 'follow' });
  } catch (e) {
    return text('proxy: ' + (e && e.message ? e.message : e), 502);
  }

  const type = upstream.headers.get('content-type') || '';
  if (u.searchParams.get('resolve') === '1') {
    try { await upstream.body?.cancel(); } catch { /* ignore */ }
    return new Response(JSON.stringify({ url: upstream.url, status: upstream.status, type }), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  const isPlaylist = /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(upstream.url);
  if (isPlaylist && upstream.ok && request.method === 'GET') {
    const body = rewritePlaylist(await upstream.text(), upstream.url, headersParam, token);
    return new Response(body, { status: 200, headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' } });
  }

  const out = new Headers(CORS);
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  fetch(request, env) { return handle(request, env || {}); },
};
