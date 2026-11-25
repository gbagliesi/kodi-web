#!/usr/bin/env node
/*
 * Salotto – optional companion server (Node.js 18+, no dependencies).
 *
 *  - serves the web app (so you can open http://<this-pc>:8787 on the iPad)
 *  - /proxy?url=…  fetches resources that browsers block because of CORS,
 *    adds optional headers (Referer, User-Agent) and rewrites HLS playlists
 *    so that every segment also goes through the proxy.
 *
 * Usage:  node server.js [--port 8787] [--host 0.0.0.0]
 * Env:    PROXY_TOKEN=secret   require ?token=secret on every proxy call
 *         ADDONS_DIR=dir       serve /addons/ from this folder (a checkout of the private add-on
 *                              repository); default ../salotto-addons when it exists, otherwise
 *                              the public addons/ folder of this project
 *         ALLOW_PRIVATE=1      allow proxying to LAN addresses (off by default)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const { Readable } = require('node:stream');

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(arg('port', process.env.PORT || 8787));
const HOST = arg('host', process.env.HOST || '0.0.0.0');
const ROOT = __dirname;
const TOKEN = process.env.PROXY_TOKEN || '';
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';
const ADDONS_DIR = (() => {
  const dir = path.resolve(process.env.ADDONS_DIR || path.join(ROOT, '..', 'salotto-addons'));
  return fs.existsSync(path.join(dir, 'repository.json')) ? dir : '';
})();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m3u8': 'application/vnd.apple.mpegurl',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
};

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && isPrivateIp(v.slice(7));
}

async function checkTarget(u) {
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('solo http/https'), { status: 400 });
  if (ALLOW_PRIVATE) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some(a => isPrivateIp(a.address))) throw Object.assign(new Error('indirizzo privato non consentito (ALLOW_PRIVATE=1 per abilitarlo)'), { status: 403 });
}

function proxyLink(target, headersParam) {
  let s = 'proxy?url=' + encodeURIComponent(target);
  if (headersParam) s += '&headers=' + encodeURIComponent(headersParam);
  if (TOKEN) s += '&token=' + encodeURIComponent(TOKEN);
  return s;
}

function rewritePlaylist(text, baseUrl, headersParam) {
  const abs = (ref) => { try { return new URL(ref, baseUrl).href; } catch { return ref; } };
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, ref) => `URI="${proxyLink(abs(ref), headersParam)}"`);
    }
    return proxyLink(abs(t), headersParam);
  }).join('\n');
}

async function handleProxy(req, res, q) {
  if (TOKEN && q.get('token') !== TOKEN) { res.writeHead(401, CORS).end('token mancante o errato'); return; }
  const raw = q.get('url');
  if (!raw) { res.writeHead(400, CORS).end('parametro url mancante'); return; }
  let target;
  try { target = new URL(raw); } catch { res.writeHead(400, CORS).end('url non valido'); return; }
  await checkTarget(target);

  const headersParam = q.get('headers') || '';
  let extra = {};
  if (headersParam) { try { extra = JSON.parse(headersParam); } catch { /* ignore */ } }
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    Accept: '*/*',
  };
  for (const [k, v] of Object.entries(extra)) if (/^(referer|user-agent|origin|cookie|authorization|accept-language)$/i.test(k)) headers[k] = String(v);
  if (req.headers.range) headers.Range = req.headers.range;

  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const upstream = await fetch(target, { headers, redirect: 'follow', signal: ctrl.signal });
  // re-check after redirects
  await checkTarget(new URL(upstream.url));

  const type = upstream.headers.get('content-type') || '';
  if (q.get('resolve') === '1') { // where a redirector (Rai relinker) ends up, see cloudflare/worker.js
    try { await upstream.body?.cancel(); } catch { /* ignore */ }
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ url: upstream.url, status: upstream.status, type }));
    return;
  }
  const isPlaylist = /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(upstream.url);
  if (isPlaylist && upstream.ok) {
    const body = rewritePlaylist(await upstream.text(), upstream.url, headersParam);
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
    res.end(body);
    return;
  }
  const out = { ...CORS };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  // fetch() already decompressed the body
  if (upstream.headers.get('content-encoding')) delete out['content-length'];
  res.writeHead(upstream.status, out);
  if (!upstream.body) { res.end(); return; }
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  // the private add-ons, when their repository is checked out next to this one
  const base = ADDONS_DIR && rel.startsWith('/addons/') ? ADDONS_DIR : ROOT;
  if (base !== ROOT) rel = rel.slice('/addons'.length);
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep) || /[\\/]\.|node_modules|[\\/]tests[\\/]/.test(file.slice(base.length))) {
    res.writeHead(404).end('not found'); return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' }).end(); return; }
    if (u.pathname.endsWith('/proxy/health')) { res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' }).end('ok'); return; }
    if (/\/proxy(\/[\w.-]+)?$/.test(u.pathname) && !u.pathname.endsWith('/proxy/health')) { await handleProxy(req, res, u.searchParams); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    serveStatic(req, res, u.pathname);
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(e.status || 502, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' }).end('proxy: ' + (e.message || e));
  }
});

server.listen(PORT, HOST, () => {
  const os = require('node:os');
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`Salotto in ascolto su http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  dalla rete locale (es. iPad): http://${ip}:${PORT}`);
  if (!TOKEN) console.log('  Suggerimento: imposta PROXY_TOKEN se esponi il server fuori dalla rete di casa.');
});
