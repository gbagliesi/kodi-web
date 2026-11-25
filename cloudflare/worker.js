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
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
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

async function handle(request, env) {
  const u = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (u.pathname.endsWith('/proxy/health')) {
    // without ?token= it only says the Worker is there; with one it also checks it
    if (!env.TOKEN || PUBLISHED_EXAMPLES.has(String(env.TOKEN)) || u.searchParams.has('token')) return refuse(env, u) || text('ok');
    return text('ok');
  }
  if (/\/remote\/(health|ws|status)$/.test(u.pathname)) return handleRemote(request, env, u);
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
