// Small persistence layer on top of localStorage (works in Safari/WebKit, Chrome, Firefox).
const PREFIX = 'salotto:';

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
    return true;
  } catch (e) {
    console.warn('storage full or unavailable', e);
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}

// ---- App settings ----
const DEFAULT_SETTINGS = {
  proxyUrl: '',          // proxy base (https://x.workers.dev) or full ...proxy?url= (empty = auto-detect)
  proxyToken: '',        // optional token required by the proxy
  autoResume: true,
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

export function toggleFavourite(entry) {
  const favs = getFavourites();
  const i = favs.findIndex(f => f.key === entry.key);
  if (i >= 0) favs.splice(i, 1); else favs.unshift(entry);
  save('favourites', favs);
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
