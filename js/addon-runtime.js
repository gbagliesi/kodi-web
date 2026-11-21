/*
 * Add-on runtime: runs inside a dedicated Web Worker, one per add-on.
 * The add-on has no access to the page (DOM, cookies, app storage); it only
 * talks to the host through the small API exposed as the global `addon`.
 */
'use strict';

let impl = null;
let manifest = null;
let proxy = '';
let currentSettings = {};

function post(msg) { self.postMessage(msg); }

function log(level, ...args) {
  post({ type: 'log', level, args: args.map(a => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }) });
}

function proxied(url) {
  if (!proxy) return null;
  return proxy + encodeURIComponent(url);
}

async function rawFetch(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * HTTP helper. Tries a direct request first; when the browser blocks it
 * (CORS, mixed content -> TypeError) and a proxy is configured, retries
 * through the proxy. `opts.viaProxy: true` forces the proxy.
 */
async function request(url, opts = {}) {
  const { type = 'text', headers, method = 'GET', body, viaProxy, timeout = 20000 } = opts;
  const init = { method, headers, body };
  const forceProxy = viaProxy || (manifest && manifest.proxy === 'always');
  let res;
  if (forceProxy && proxy) {
    res = await rawFetch(proxied(url), init, timeout);
  } else {
    try {
      res = await rawFetch(url, init, timeout);
    } catch (e) {
      if (!proxy) {
        throw new Error(`Richiesta bloccata dal browser (probabilmente CORS): ${url}. Configura un proxy nelle Impostazioni.`);
      }
      log('info', 'direct fetch failed, retrying via proxy', url);
      res = await rawFetch(proxied(url), init, timeout);
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} per ${url}`);
  if (type === 'json') return res.json();
  if (type === 'response') return res;
  if (type === 'arraybuffer') return res.arrayBuffer();
  return res.text();
}

const http = {
  get: (url, opts) => request(url, opts),
  json: (url, opts = {}) => request(url, { ...opts, type: 'json' }),
  text: (url, opts = {}) => request(url, { ...opts, type: 'text' }),
  post: (url, body, opts = {}) => request(url, { ...opts, method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
  proxied: (url) => proxied(url) || url,
};

// Minimal XML helpers (DOMParser is not available inside workers).
const xml = {
  decode(s) {
    if (s == null) return '';
    return String(s)
      .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&amp;/g, '&').trim();
  },
  /** All blocks <tag ...>...</tag> as strings. */
  blocks(src, tag) {
    const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(src))) out.push({ attrs: xml.attrs(m[1] || ''), inner: m[2], raw: m[0] });
    return out;
  },
  /** Text content of the first <tag>. */
  text(src, tag) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
    const m = re.exec(src);
    return m ? xml.decode(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')) : '';
  },
  /** Attributes of the first <tag .../> (self-closing or not). */
  attr(src, tag, name) {
    const re = new RegExp(`<${tag}\\s([^>]*?)/?>`, 'i');
    const m = re.exec(src);
    if (!m) return '';
    return xml.attrs(m[1])[name] || '';
  },
  attrs(s) {
    const out = {};
    const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = xml.decode(m[3] != null ? m[3] : m[4]);
    return out;
  },
};

// Small persistent storage for the add-on (survives restarts): Cache Storage, else memory.
const memStore = new Map();
const storeUrl = (key) => new URL('__addon-store/' + encodeURIComponent(manifest.id) + '/' + encodeURIComponent(key), self.location.href).href;
const store = {
  async get(key) {
    try {
      if (self.caches) { const r = await (await caches.open('salotto-addon-data')).match(storeUrl(key)); return r ? r.json() : null; }
    } catch { /* fall back to memory */ }
    return memStore.has(key) ? memStore.get(key) : null;
  },
  async set(key, value) {
    memStore.set(key, value);
    try {
      if (self.caches) await (await caches.open('salotto-addon-data')).put(storeUrl(key), new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));
    } catch { /* memory only */ }
  },
};

function makeCtx(opts = {}) {
  return {
    refresh: !!opts.refresh,
    store,
    addon: { id: manifest.id, name: manifest.name, version: manifest.version },
    settings: { ...currentSettings },
    http,
    xml,
    log: (...a) => log('info', ...a),
    notify: (message) => post({ type: 'notify', message: String(message) }),
  };
}

self.addon = {
  register(def) {
    if (!def || typeof def !== 'object') throw new Error('addon.register() richiede un oggetto');
    impl = def;
  },
};

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'init') {
    manifest = msg.manifest;
    proxy = msg.proxy || '';
    try {
      const url = URL.createObjectURL(new Blob([msg.code], { type: 'text/javascript' }));
      importScripts(url);
      URL.revokeObjectURL(url);
      if (!impl) throw new Error("L'add-on non ha chiamato addon.register()");
      post({ type: 'ready', capabilities: { search: typeof impl.search === 'function', resolve: typeof impl.resolve === 'function' } });
    } catch (e) {
      post({ type: 'init-error', message: e && e.message ? e.message : String(e) });
    }
    return;
  }
  if (msg.type === 'proxy') { proxy = msg.proxy || ''; return; }
  if (msg.type === 'call') {
    const { id, method, args = [], settings = {}, opts = {} } = msg;
    currentSettings = settings;
    try {
      const fn = impl && impl[method];
      if (typeof fn !== 'function') throw new Error(`Metodo non supportato dall'add-on: ${method}`);
      const result = await fn.call(impl, ...args, makeCtx(opts));
      post({ type: 'result', id, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
    } catch (e) {
      post({ type: 'error', id, message: e && e.message ? e.message : String(e) });
    }
  }
};
