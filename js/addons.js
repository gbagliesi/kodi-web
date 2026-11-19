// Add-on manager: install / uninstall / settings / sandboxed execution.
import { load, save, getSettings } from './storage.js';

const RUNTIME_URL = new URL('./addon-runtime.js', import.meta.url).href;
const CALL_TIMEOUT = 60000;
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,80}$/i;

let proxyUrl = '';
const hosts = new Map(); // id -> AddonHost
const listeners = new Set();

export function onAddonsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } }

// ---------------------------------------------------------------- proxy
export async function detectProxy() {
  const configured = getSettings().proxyUrl.trim();
  if (configured) {
    proxyUrl = configured;
  } else {
    proxyUrl = '';
    try {
      const res = await fetch(new URL('proxy/health', location.href), { cache: 'no-store' });
      if (res.ok && (await res.text()).trim() === 'ok') proxyUrl = new URL('proxy?url=', location.href).href;
    } catch { /* static hosting: no proxy */ }
  }
  for (const h of hosts.values()) h.setProxy(proxyUrl);
  return proxyUrl;
}
export function getProxy() { return proxyUrl; }
export function proxify(url) { return proxyUrl ? proxyUrl + encodeURIComponent(url) : url; }

// ---------------------------------------------------------------- registry
function readInstalled() { return load('addons', {}); }
function writeInstalled(map) {
  if (!save('addons', map)) throw new Error('Spazio di archiviazione esaurito');
  emit();
}

export function listInstalled() {
  return Object.values(readInstalled()).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export function getInstalled(id) { return readInstalled()[id] || null; }

export function addonsProviding(kind) {
  return listInstalled().filter(a => a.enabled !== false && (a.manifest.provides || []).includes(kind));
}

export function validateManifest(m) {
  const errs = [];
  if (!m || typeof m !== 'object') return ['manifest non valido'];
  if (!ID_RE.test(m.id || '')) errs.push('id mancante o non valido');
  if (!m.name) errs.push('name mancante');
  if (!m.version) errs.push('version mancante');
  if (!m.main) errs.push('main mancante');
  if (!Array.isArray(m.provides) || !m.provides.length) errs.push('provides deve essere un elenco, es. ["video"]');
  return errs;
}

function absolutize(manifest, baseUrl) {
  const m = { ...manifest };
  if (m.icon) m.icon = new URL(m.icon, baseUrl).href;
  if (m.fanart) m.fanart = new URL(m.fanart, baseUrl).href;
  return m;
}

async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (e) {
    if (!proxyUrl) throw new Error(`Impossibile scaricare ${url} (rete o CORS)`);
    res = await fetch(proxify(url), { cache: 'no-cache' });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} scaricando ${url}`);
  return res.text();
}

/** Install (or update) an add-on from the URL of its addon.json. */
export async function installFromManifestUrl(manifestUrl, { source = 'url' } = {}) {
  const abs = new URL(manifestUrl, location.href).href;
  let manifest;
  try { manifest = JSON.parse(await fetchText(abs)); } catch (e) {
    throw new Error(e instanceof SyntaxError ? 'addon.json non è JSON valido' : e.message);
  }
  const errs = validateManifest(manifest);
  if (errs.length) throw new Error('Manifest non valido: ' + errs.join(', '));
  const codeUrl = new URL(manifest.main, abs).href;
  const code = await fetchText(codeUrl);
  return installRaw(absolutize(manifest, abs), code, { source, manifestUrl: abs });
}

export function installRaw(manifest, code, { source = 'local', manifestUrl = '' } = {}) {
  const errs = validateManifest(manifest);
  if (errs.length) throw new Error('Manifest non valido: ' + errs.join(', '));
  const map = readInstalled();
  const prev = map[manifest.id];
  map[manifest.id] = {
    manifest,
    code,
    source,
    manifestUrl,
    enabled: prev ? prev.enabled !== false : true,
    settings: prev ? prev.settings : {},
    installedAt: prev ? prev.installedAt : Date.now(),
    updatedAt: Date.now(),
  };
  stopHost(manifest.id);
  writeInstalled(map);
  return map[manifest.id];
}

export function uninstall(id) {
  const map = readInstalled();
  delete map[id];
  stopHost(id);
  writeInstalled(map);
}

export function setEnabled(id, enabled) {
  const map = readInstalled();
  if (!map[id]) return;
  map[id].enabled = enabled;
  if (!enabled) stopHost(id);
  writeInstalled(map);
}

export function getAddonSettings(id) {
  const a = getInstalled(id);
  if (!a) return {};
  const defs = a.manifest.settings || [];
  const out = {};
  for (const d of defs) out[d.id] = d.default !== undefined ? d.default : (d.type === 'bool' ? false : '');
  return { ...out, ...(a.settings || {}) };
}

export function setAddonSettings(id, values) {
  const map = readInstalled();
  if (!map[id]) return;
  map[id].settings = { ...(map[id].settings || {}), ...values };
  writeInstalled(map);
}

// ---------------------------------------------------------------- repositories
export async function fetchRepository(url) {
  const abs = new URL(url, location.href).href;
  let repo;
  try { repo = JSON.parse(await fetchText(abs)); } catch (e) {
    throw new Error(e instanceof SyntaxError ? 'Il repository non è JSON valido' : e.message);
  }
  const addons = (repo.addons || []).map(a => ({
    ...a,
    manifest: new URL(a.manifest, abs).href,
    icon: a.icon ? new URL(a.icon, abs).href : '',
  }));
  return { name: repo.name || abs, url: abs, addons };
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** First run: install the add-ons shipped with the app. */
export async function ensureBundledAddons() {
  if (load('bundled-installed', false)) return;
  try {
    const repo = await fetchRepository('addons/repository.json');
    for (const a of repo.addons) {
      try { await installFromManifestUrl(a.manifest, { source: 'repo' }); } catch (e) { console.warn('bundled add-on failed', a.id, e); }
    }
    save('bundled-installed', true);
  } catch (e) {
    console.warn('bundled repository unavailable', e);
  }
}

// ---------------------------------------------------------------- execution
class AddonHost {
  constructor(record) {
    this.id = record.manifest.id;
    this.record = record;
    this.seq = 0;
    this.pending = new Map();
    this.capabilities = {};
    this.onNotify = null;
    this.worker = new Worker(RUNTIME_URL);
    this.ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    this.worker.onmessage = (ev) => this._onMessage(ev.data);
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || "Errore nell'add-on");
      this._readyReject(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    this.worker.postMessage({ type: 'init', code: record.code, manifest: record.manifest, proxy: proxyUrl });
  }

  setProxy(p) { this.worker.postMessage({ type: 'proxy', proxy: p }); }

  _onMessage(msg) {
    switch (msg.type) {
      case 'ready': this.capabilities = msg.capabilities || {}; this._readyResolve(); break;
      case 'init-error': this._readyReject(new Error(msg.message)); break;
      case 'log': console[msg.level === 'error' ? 'error' : 'log'](`[${this.id}]`, ...msg.args); break;
      case 'notify': if (typeof notifyHandler === 'function') notifyHandler(msg.message, this.record.manifest); break;
      case 'result':
      case 'error': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === 'result') p.resolve(msg.result); else p.reject(new Error(msg.message));
        break;
      }
    }
  }

  async call(method, ...args) {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`L'add-on non ha risposto entro ${CALL_TIMEOUT / 1000} secondi`));
      }, CALL_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: 'call', id, method, args, settings: getAddonSettings(this.id) });
    });
  }

  terminate() {
    this.worker.terminate();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Add-on arrestato')); }
    this.pending.clear();
  }
}

let notifyHandler = null;
export function setNotifyHandler(fn) { notifyHandler = fn; }

export function getHost(id) {
  let h = hosts.get(id);
  if (h) return h;
  const rec = getInstalled(id);
  if (!rec) throw new Error(`Add-on non installato: ${id}`);
  if (rec.enabled === false) throw new Error('Add-on disattivato');
  h = new AddonHost(rec);
  h.ready.catch(() => hosts.delete(id));
  hosts.set(id, h);
  return h;
}

export function stopHost(id) {
  const h = hosts.get(id);
  if (h) { h.terminate(); hosts.delete(id); }
}

/** Normalise whatever an add-on returns from list()/search(). */
export function normaliseListing(res) {
  const out = Array.isArray(res) ? { items: res } : { ...(res || {}) };
  out.items = (out.items || []).filter(Boolean).map((it, i) => {
    const item = typeof it === 'string' ? { label: it } : { ...it };
    item.label = String(item.label ?? item.title ?? `Elemento ${i + 1}`);
    if (item.playable === undefined) item.playable = !!item.url && !item.path;
    if (!item.type) item.type = item.playable ? 'video' : 'folder';
    return item;
  });
  return out;
}

/** Ask the add-on for the final stream of a playable item. */
export async function resolveItem(addonId, item) {
  const host = getHost(addonId);
  await host.ready;
  if (host.capabilities.resolve && (item.resolve !== false) && (!item.url || item.resolve === true)) {
    const r = await host.call('resolve', item);
    if (!r) throw new Error("L'add-on non ha trovato uno stream riproducibile");
    return typeof r === 'string' ? { url: r } : r;
  }
  if (!item.url) throw new Error('Elemento senza URL');
  return { url: item.url, mime: item.mime };
}
