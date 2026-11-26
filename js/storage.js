// Small persistence layer on top of localStorage (works in Safari/WebKit, Chrome, Firefox).
const PREFIX = 'salotto:';

// sync.js is told about every change, to send it to the other devices
let changeHook = null;
export function onChange(fn) { changeHook = fn; }
const changed = (key) => { try { changeHook?.(key); } catch (e) { console.warn(e); } };

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    changed(key);
    return true;
  } catch (e) {
    console.warn('storage full or unavailable', e);
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); changed(key); } catch { /* ignore */ }
}

// ---- App settings ----
const DEFAULT_SETTINGS = {
  proxyUrl: '',          // proxy base (https://x.workers.dev) or full ...proxy?url= (empty = auto-detect)
  proxyToken: '',        // optional token required by the proxy
  autoResume: true,
  autoPip: true,         // Android: videos open full screen so leaving the app moves them to a floating window
  startPage: '',         // '' = Home, 'last' = last page visited, or a page address ('#/live', '#/browse/…')
  startLabel: '',        // name of a page chosen with the 📌 button
  viewMode: 'auto',      // auto | grid | list
  repositories: ['addons/repository.json'],
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...load('settings', {}) };
}

export function setSettings(patch) {
  const s = { ...getSettings(), ...patch };
  save('settings', s);
  return s;
}

// ---- Favourites ----
export function getFavourites() { return load('favourites', []); }

export function isFavourite(key) { return getFavourites().some(f => f.key === key); }

/** Frees what Salotto can do without: memories of list changes, old resume points. */
export function trimStorage() {
  const sort = load('sort', null);
  if (sort) { for (const k of Object.keys(sort)) { delete sort[k].seen; delete sort[k].gone; } save('sort', sort); }
  const resume = load('resume', null);
  if (resume) { const keys = Object.keys(resume); for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete resume[k]; save('resume', resume); }
}

/** Saves; when the browser storage is full, makes room once and tries again. */
export function saveOrTrim(key, value) {
  if (save(key, value)) return true;
  trimStorage();
  return save(key, value);
}

/** Adds or removes a favourite: true = added, false = removed, null = could not be saved
 *  (browser storage full: the "salotto:storage-full" event says so to the app). */
export function toggleFavourite(entry) {
  const favs = getFavourites();
  const i = favs.findIndex(f => f.key === entry.key);
  if (i >= 0) favs.splice(i, 1); else favs.unshift(entry);
  if (!saveOrTrim('favourites', favs)) {
    try { window.dispatchEvent(new CustomEvent('salotto:storage-full', { detail: { key: 'favourites' } })); } catch { /* no window */ }
    return null;
  }
  // the ☆ in the lists follow what is done in the player (and the other way round)
  try { window.dispatchEvent(new CustomEvent('salotto:favourites', { detail: { key: entry.key, on: i < 0 } })); } catch { /* no window */ }
  return i < 0;
}

// ---- Resume points ----
export function getResume(key) {
  const all = load('resume', {});
  return all[key] || 0;
}

export function setResume(key, seconds, duration) {
  const all = load('resume', {});
  if (!seconds || !isFinite(duration) || seconds < 15 || duration - seconds < 20) delete all[key];
  else all[key] = Math.floor(seconds);
  // keep the map small
  const keys = Object.keys(all);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete all[k];
  save('resume', all);
}

// ---- Audio/video sync, per channel (ms: > 0 = sound later than the picture) ----
export function getAvSync(key) {
  const v = load('avsync', {})[key];
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

export function setAvSync(key, ms) {
  const all = load('avsync', {});
  if (ms) all[key] = ms; else delete all[key];
  save('avsync', all);
}
