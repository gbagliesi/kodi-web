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
/** Turn what the user typed (base address or full URL) into "<…>/proxy?[token=…&]url=". */
export function buildProxyUrl(configured, token = '') {
  configured = String(configured || '').trim();
  if (!configured) return '';
  const tok = String(token || '').trim();
  if (/[?&]url=$/.test(configured)) {
    if (tok && !/[?&]token=/.test(configured)) return configured.replace(/url=$/, 'token=' + encodeURIComponent(tok) + '&url=');
    return configured;
  }
  let base = configured.split('?')[0].replace(/\/+$/, '');
  if (!/\/proxy$/.test(base)) base += '/proxy';
  return base + '?' + (tok ? 'token=' + encodeURIComponent(tok) + '&' : '') + 'url=';
}

/** Ask the proxy's health endpoint: 'ok', 'token' (wrong/missing token), 'unprotected'
 *  (the Worker has no TOKEN, or the guide's old example) or 'down'. */
export async function proxyStatus(url = proxyUrl) {
  if (!url) return 'down';
  try {
    const tok = new URL(url, location.href).searchParams.get('token');
    const res = await fetch(url.split('?')[0] + '/health' + (tok ? '?token=' + encodeURIComponent(tok) : ''), { cache: 'no-store' });
    if (res.status === 401) return 'token';
    if (res.status === 503) return 'unprotected';
    return res.ok && (await res.text()).trim() === 'ok' ? 'ok' : 'down';
  } catch { return 'down'; }
}
export async function checkProxy(url = proxyUrl) { return (await proxyStatus(url)) === 'ok'; }

export async function detectProxy() {
  const s = getSettings();
  const configured = buildProxyUrl(s.proxyUrl, s.proxyToken);
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
// The list of add-ons lives in localStorage; their code in Cache Storage (localStorage holds only
// 5 MB for the whole site, shared with any other page on the same address).
const CODE_CACHE = 'salotto-addon-data';
const codeUrl = (id) => new URL('__addon-code/' + encodeURIComponent(id), location.href).href;
async function putCode(id, code) {
  try {
    if (!self.caches) return false;
    await (await caches.open(CODE_CACHE)).put(codeUrl(id), new Response(code, { headers: { 'Content-Type': 'text/javascript' } }));
    return true;
  } catch { return false; }
}
async function dropCode(id) { try { if (self.caches) await (await caches.open(CODE_CACHE)).delete(codeUrl(id)); } catch { /* ignore */ } }
async function getCode(rec) {
  if (rec.code) return rec.code;
  try {
    const r = self.caches && await (await caches.open(CODE_CACHE)).match(codeUrl(rec.manifest.id));
    if (r) return await r.text();
  } catch { /* fetched again below */ }
  // the browser cleared it: download it again from where it came from
  if (rec.manifestUrl) {
    const m = JSON.parse(await fetchText(rec.manifestUrl));
    const code = await fetchText(new URL(m.main, rec.manifestUrl).href);
    putCode(rec.manifest.id, code);
    return code;
  }
  throw new Error("Il codice dell'add-on non c'è più: reinstallalo");
}

/** How much of localStorage this site uses: { salotto, other, biggest: [[key, bytes]] }. */
export function storageUsage() {
  let salotto = 0, other = 0;
  const all = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const n = (k.length + (localStorage.getItem(k) || '').length) * 2;
      all.push([k, n]);
      if (k.startsWith('salotto:')) salotto += n; else other += n;
    }
  } catch { /* unavailable */ }
  return { salotto, other, biggest: all.sort((a, b) => b[1] - a[1]).slice(0, 5) };
}
const kb = (n) => Math.round(n / 1024) + ' KB';
export function storageFullMessage() {
  const u = storageUsage();
  return `Spazio di archiviazione del browser esaurito (Salotto ${kb(u.salotto)}, altre pagine dello stesso sito ${kb(u.other)}). Più grandi: ` +
    u.biggest.map(([k, n]) => k + ' ' + kb(n)).join(', ');
}

/** Frees what Salotto can do without: memories of list changes, old resume points. */
function trimStorage() {
  const sort = load('sort', null);
  if (sort) { for (const k of Object.keys(sort)) { delete sort[k].seen; delete sort[k].gone; } save('sort', sort); }
  const resume = load('resume', null);
  if (resume) { const keys = Object.keys(resume); for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete resume[k]; save('resume', resume); }
}

function readInstalled() { return load('addons', {}); }
function writeInstalled(map) {
  if (!save('addons', map)) {
    trimStorage();
    if (!save('addons', map)) {
      console.warn(storageFullMessage());
      throw new Error(storageFullMessage());
    }
  }
  emit();
}

/** Moves the code of add-ons installed by older versions out of localStorage. */
async function migrateCode() {
  const map = readInstalled();
  let changed = false;
  for (const rec of Object.values(map)) {
    if (rec.code && await putCode(rec.manifest.id, rec.code)) { delete rec.code; changed = true; }
  }
  if (changed) save('addons', map);
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

export async function installRaw(manifest, code, { source = 'local', manifestUrl = '' } = {}) {
  const errs = validateManifest(manifest);
  if (errs.length) throw new Error('Manifest non valido: ' + errs.join(', '));
  const map = readInstalled();
  const prev = map[manifest.id];
  const stored = await putCode(manifest.id, code);
  map[manifest.id] = {
    manifest,
    ...(stored ? {} : { code }),
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
  dropCode(id);
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

/** Sync: enabled state and settings exactly as another device has them. */
export function setSyncedState(id, enabled, settings) {
  const map = readInstalled();
  if (!map[id]) return;
  map[id].enabled = enabled;
  map[id].settings = settings || {};
  if (!enabled) stopHost(id);
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

/**
 * Installs the add-ons shipped with the app on first run, and on later runs
 * updates any add-on from the official repository that has a newer version.
 */
const BUNDLED_BEFORE_0_15 = ['plugin.video.demo', 'plugin.video.archive', 'plugin.video.iptv', 'plugin.audio.radiobrowser', 'plugin.audio.podcast'];
export async function ensureBundledAddons() {
  const firstRun = !load('bundled-installed', false);
  await migrateCode().catch(() => {});
  try {
    const repo = await fetchRepository('addons/repository.json');
    // add-ons added to the app later are installed once too (one removed by the user stays removed)
    const seen = new Set(load('bundled-seen', null) || (firstRun ? [] : BUNDLED_BEFORE_0_15));
    for (const a of repo.addons) {
      const inst = getInstalled(a.id);
      const install = firstRun || !seen.has(a.id) ? !inst : inst && inst.source === 'repo' && compareVersions(a.version, inst.manifest.version) > 0;
      seen.add(a.id);
      if (!install) continue;
      try { await installFromManifestUrl(a.manifest, { source: 'repo' }); } catch (e) { console.warn('bundled add-on failed', a.id, e); }
    }
    save('bundled-installed', true);
    save('bundled-seen', [...seen]);
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
    getCode(record).then(
      code => this.worker.postMessage({ type: 'init', code, manifest: record.manifest, proxy: proxyUrl }),
      err => this._readyReject(err));
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

  call(method, ...args) { return this.callWith({}, method, ...args); }

  /** Like call(), with options for the add-on (ctx.refresh: download fresh data). */
  async callWith(opts, method, ...args) {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`L'add-on non ha risposto entro ${CALL_TIMEOUT / 1000} secondi`));
      }, CALL_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: 'call', id, method, args, opts, settings: getAddonSettings(this.id) });
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
