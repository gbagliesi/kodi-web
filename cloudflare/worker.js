/*
 * Salotto – proxy for Cloudflare Workers (free plan is enough for personal use).
 *
 * Same API as the /proxy endpoint of server.js:
 *   GET /proxy/health                      -> "ok"
 *   GET /proxy?url=<enc>[&headers=<json>]  -> the resource, with CORS headers;
 *                                             HLS playlists are rewritten so
 *                                             every segment also goes through here.
 *
 * Settings (Worker → Settings → Variables and Secrets):
 *   TOKEN            secret, recommended: every call must carry ?token=<TOKEN>
 *   ALLOWED_ORIGINS  optional, comma separated, e.g. https://gbagliesi.github.io
 *                    (requests from other web sites are refused). Ignored when TOKEN
 *                    is set (the token already protects the proxy), and Chromecast
 *                    receivers (*.gstatic.com) are always allowed, since the TV
 *                    fetches the stream itself when casting.
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

async function handle(request, env) {
  const u = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (u.pathname.endsWith('/proxy/health')) return text('ok');
  if (!u.pathname.endsWith('/proxy')) return text('Salotto proxy: usa /proxy?url=…', 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('metodo non consentito', 405);

  const token = env.TOKEN || '';
  if (token && u.searchParams.get('token') !== token) return text('token mancante o errato', 401);

  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  const castReceiver = /^https:\/\/([a-z0-9-]+\.)*gstatic\.com$/i.test(origin || '');
  if (!token && allowed.length && origin && !allowed.includes(origin) && !castReceiver) return text('origine non consentita', 403);

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
