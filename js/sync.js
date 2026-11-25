// Sync between devices: favourites, resume points, sync of audio and subtitles, list orders,
// some settings and the installed add-ons (with their settings and the saved data their
// manifest lists in "syncStore", e.g. YouTube's channels) travel through the Cloudflare
// Worker set as proxy (POST /sync, one store per group, see cloudflare/worker.js).
//
// The state is cut into small entries ("fav/<key>", "resume/<key>", "addon/<id>"…); each device
// remembers a fingerprint of what it last agreed with the Worker, so it sends only what changed
// here and receives only what changed elsewhere. The newest change of an entry wins.
// Device-only things never travel: proxy address and token, Android floating
// window, the phone remote's pairing, the last page visited.
import { load, save, onChange } from './storage.js';
import * as addons from './addons.js';

const CONF = 'sync';            // { on, group } – this device only
const STATE = 'sync-state';     // { rev, joined, snap: { id: "hash.t" }, pending: { id: v } }
const MAPS = ['resume', 'avsync', 'subsync'];
const SETTINGS_KEYS = ['autoResume', 'viewMode', 'repositories', 'startPage', 'startLabel'];
const WATCHED = new Set(['favourites', 'sort', 'settings', 'subs', 'addons', ...MAPS]);
const PUSH_DELAY = 8000;        // changes are sent together, a few seconds after the first one
const MAX_VALUE = 60000;        // per entry (the Worker takes up to 64 KB)
const POLL = 120000;            // while the app is on screen, look for changes of the others
export const GROUP_RE = /^[a-z0-9-]{1,40}$/;

let busy = null, again = false, pushTimer = 0, applying = false;
let status = { state: 'idle', at: 0, message: '' };
const listeners = new Set();

export function config() { return { on: true, group: 'casa', ...load(CONF, {}) }; }
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getStatus() { return status; }
function setStatus(s) {
  status = { ...status, ...s };
  for (const fn of listeners) { try { fn(status); } catch (e) { console.error(e); } }
}

/** Turn sync on/off or change group. Joining (again) means taking what the others have. */
export function configure(patch) {
  const before = config();
  const c = { ...before, ...patch };
  c.group = String(c.group || 'casa').trim().toLowerCase();
  save(CONF, c);
  if (c.on !== before.on || c.group !== before.group) save(STATE, { rev: 0, joined: false, snap: {}, pending: {} });
  if (c.on) syncNow(); else setStatus({ state: 'off', message: '' });
  return c;
}

/** Base address and token of the Worker set as proxy. */
function endpoint() {
  const p = addons.getProxy();
  if (!p || !/^https?:/i.test(p)) return null;
  try {
    const u = new URL(p);
    if (/^(127\.|localhost$)/.test(u.hostname) && u.origin === location.origin) return null; // server.js: no sync there
    return { base: u.origin + u.pathname.replace(/\/proxy(\/[\w.-]+)?$/, ''), token: u.searchParams.get('token') || '' };
  } catch { return null; }
}

// ---------------------------------------------------------------- entries
function hash(v) {
  const s = JSON.stringify(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
const split = (id) => { const i = id.indexOf('/'); return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)]; };

const syncedKeys = (rec) => (Array.isArray(rec?.manifest?.syncStore) ? rec.manifest.syncStore.filter(k => typeof k === 'string') : []);

/** Everything that travels, as { id: value }. */
export async function entries() {
  const out = {};
  for (const f of load('favourites', [])) if (f && f.key) out['fav/' + f.key] = f;
  for (const name of MAPS) for (const [k, v] of Object.entries(load(name, {}) || {})) out[name + '/' + k] = v;
  for (const [k, v] of Object.entries(load('sort', {}) || {})) {
    if (!v || typeof v !== 'object') continue;
    const { seen, gone, ...rest } = v; // what is new in a list is this device's own business
    out['sort/' + k] = rest;
  }
  const s = load('settings', {}) || {};
  for (const k of SETTINGS_KEYS) if (k in s) out['settings/' + k] = s[k];
  const subs = load('subs', null);
  if (subs) out.subs = subs;
  for (const [id, rec] of Object.entries(load('addons', {}) || {})) {
    // add-ons loaded from a file on this device can't be installed elsewhere
    if (rec && rec.manifestUrl) out['addon/' + id] = { u: rec.manifestUrl, s: rec.source || 'url', e: rec.enabled !== false, c: rec.settings || {} };
    // data an add-on keeps for the user (e.g. YouTube's saved channels), listed in its manifest
    for (const key of syncedKeys(rec)) {
      const v = await addons.readAddonStore(id, key);
      if (v != null) out['astore/' + id + '/' + key] = v;
    }
  }
  return out;
}

/** Write what came from the other devices. Returns the ids that could not be applied yet. */
async function apply(got, snapT) {
  const by = {};
  for (const [id, v] of Object.entries(got)) { const [ns, k] = split(id); (by[ns] ||= []).push([k, v, id]); }
  const failed = new Set();
  applying = true;
  try {
    if (by.fav) {
      const cur = new Map(load('favourites', []).filter(f => f && f.key).map(f => [f.key, f]));
      for (const [k, v] of by.fav) { if (v == null) cur.delete(k); else cur.set(k, v); }
      // newest first, like a favourite just added here; ones not agreed yet stay on top
      const t = (k) => snapT('fav/' + k) ?? Infinity;
      save('favourites', [...cur.values()].sort((a, b) => t(b.key) - t(a.key)));
    }
    for (const name of MAPS) {
      if (!by[name]) continue;
      const m = load(name, {}) || {};
      for (const [k, v] of by[name]) { if (v == null) delete m[k]; else m[k] = v; }
      save(name, m);
    }
    if (by.sort) {
      const m = load('sort', {}) || {};
      for (const [k, v] of by.sort) {
        if (v == null) { delete m[k]; continue; }
        const keep = {};
        if (m[k]?.seen) keep.seen = m[k].seen;
        if (m[k]?.gone) keep.gone = m[k].gone;
        m[k] = { ...v, ...keep };
      }
      save('sort', m);
    }
    if (by.settings) {
      const s = load('settings', {}) || {};
      for (const [k, v] of by.settings) { if (!SETTINGS_KEYS.includes(k)) continue; if (v == null) delete s[k]; else s[k] = v; }
      save('settings', s);
    }
    if (by.subs) { const [, v] = by.subs[0]; if (v == null) save('subs', {}); else save('subs', v); }
  } finally { applying = false; }
  for (const [k, v, id] of by.astore || []) {
    const i = k.indexOf('/');
    if (v == null) continue; // add-on data is never deleted from another device (old tombstones)
    try { await addons.writeAddonStore(k.slice(0, i), k.slice(i + 1), v); } catch (e) { console.warn('sync: add-on data', k, e); failed.add(id); }
  }
  for (const [k, v, id] of by.addon || []) {
    try {
      const inst = addons.getInstalled(k);
      if (v == null) { if (inst) addons.uninstall(k); continue; }
      if (!inst) await addons.installFromManifestUrl(v.u, { source: v.s || 'url' });
      addons.setSyncedState(k, v.e !== false, v.c || {});
    } catch (e) {
      console.warn('sync: add-on', k, e);
      failed.add(id);
    }
  }
  return failed;
}

// ---------------------------------------------------------------- talking to the Worker
async function post(ep, group, body, keepalive) {
  const url = ep.base + '/sync?group=' + encodeURIComponent(group) + (ep.token ? '&token=' + encodeURIComponent(ep.token) : '');
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', keepalive: !!keepalive });
  if (res.status === 501 || res.status === 404) throw Object.assign(new Error('Il Worker Cloudflare non ha ancora la sincronizzazione: va aggiornato (guida Cloudflare)'), { kind: 'old' });
  if (res.status === 401) throw Object.assign(new Error('Il token del proxy è sbagliato'), { kind: 'token' });
  if (!res.ok) throw new Error('Il Worker risponde ' + res.status + ': ' + (await res.text()).slice(0, 120));
  return res.json();
}

async function round(keepalive) {
  const c = config();
  if (!c.on) { setStatus({ state: 'off', message: '' }); return; }
  const ep = endpoint();
  if (!ep) { setStatus({ state: 'noproxy', message: 'Serve il proxy Cloudflare (Impostazioni → Proxy)' }); return; }
  const st = { rev: 0, joined: false, snap: {}, pending: {}, ...load(STATE, {}) };
  const local = await entries();
  const now = Date.now();
  const changes = [];
  const want = [];
  if (st.joined) {
    for (const [id, v] of Object.entries(local)) {
      if (st.pending[id] !== undefined) continue; // still waiting to be applied here
      const s = st.snap[id];
      if (JSON.stringify(v).length > MAX_VALUE) continue; // the Worker would refuse it
      // add-on data seen here for the first time (e.g. just made syncable) never beats a copy
      // the other devices already share: it only fills a gap (nothing there, or a deletion)
      if (!s) changes.push(id.startsWith('astore/') ? { id, v, t: now, weak: true } : { id, v, t: now });
      else if (s.split('.')[0] !== hash(v)) changes.push({ id, v, t: now });
    }
    for (const id of Object.keys(st.snap)) {
      if (id in local || st.pending[id] !== undefined) continue;
      // add-on data is never deleted by the user, only lost with the browser's storage:
      // ask the others' copy back instead of deleting it everywhere
      if (id.startsWith('astore/')) { want.push(id); continue; }
      changes.push({ id, v: null, t: now });
    }
  }
  if (keepalive && !changes.length) return;
  for (const id of want) delete st.snap[id]; // so the copy that comes back gets written
  setStatus({ state: 'busy' });
  // first time in the group: take what the others have, then add what only this device has
  const res = await post(ep, c.group, { since: st.joined ? st.rev : 0, changes, want }, keepalive);
  if (JSON.stringify(config()) !== JSON.stringify(c)) return; // switched off or moved meanwhile

  const got = {};
  const wins = {};
  for (const [id, e] of Object.entries(res.entries || {})) { got[id] = e.v; wins[id] = e; }
  if (res.full) for (const id of Object.keys(st.snap)) if (!(id in got)) { got[id] = null; wins[id] = { v: null, t: 0 }; }
  for (const [id, v] of Object.entries(st.pending)) if (!(id in got)) { got[id] = v; wins[id] = { v, t: +(st.snap[id] || '').split('.')[1] || now }; }

  // something changed here while the answer travelled: keep it, it goes next time
  const cur = await entries();
  for (const id of Object.keys(got)) {
    if (hash(cur[id] ?? null) !== hash(local[id] ?? null)) { delete got[id]; delete wins[id]; again = true; }
  }
  // what this device already has needs no writing
  const toApply = {};
  for (const [id, v] of Object.entries(got)) if (hash(cur[id] ?? null) !== hash(v ?? null)) toApply[id] = v;
  for (const [id, e] of Object.entries(wins)) {
    if (e.v == null) delete st.snap[id];
    else st.snap[id] = hash(e.v) + '.' + e.t;
  }
  const snapT = (id) => { const s = st.snap[id]; return s ? +s.split('.')[1] : undefined; };
  const failed = await apply(toApply, snapT);
  st.pending = {};
  for (const id of failed) st.pending[id] = got[id];
  st.rev = res.rev;
  const first = !st.joined;
  st.joined = true;
  save(STATE, st);
  const n = Object.keys(toApply).length;
  setStatus({ state: failed.size ? 'partial' : 'ok', at: Date.now(), message: failed.size ? `${failed.size} add-on non ancora installati, riprovo più tardi` : '' });
  if (n) window.dispatchEvent(new CustomEvent('salotto:synced', { detail: { ids: Object.keys(toApply) } }));
  if (first) again = true; // now send what only this device had
}

/** One sync round now (or right after the one running). */
export function syncNow(keepalive = false) {
  clearTimeout(pushTimer); pushTimer = 0;
  if (busy) { again = true; return busy; }
  busy = (async () => {
    try {
      do { again = false; await round(keepalive); } while (again && !keepalive);
    } catch (e) {
      console.warn('sync', e);
      setStatus({ state: 'error', message: e.kind ? e.message : 'Non riesco a raggiungere il Worker: riprovo più tardi' });
    } finally { busy = null; }
  })();
  return busy;
}

function scheduled() {
  if (applying || pushTimer || !config().on) return;
  pushTimer = setTimeout(() => { pushTimer = 0; syncNow(); }, PUSH_DELAY);
}

let started = false;
export function start() {
  if (started) return;
  started = true;
  onChange((key) => { if (WATCHED.has(key)) scheduled(); });
  addons.onAddonStored((id, key) => { if (syncedKeys(addons.getInstalled(id)).includes(key)) scheduled(); });
  setInterval(() => { if (document.visibilityState === 'visible' && config().on) syncNow(); }, POLL);
  document.addEventListener('visibilitychange', () => {
    if (!config().on) return;
    if (document.visibilityState === 'visible') syncNow();
    else if (pushTimer) syncNow(true); // leaving: send what is waiting
  });
  if (config().on) syncNow(); else setStatus({ state: 'off' });
}
