// Phone remote, screen side. The screen (computer, iPad, Fire TV) keeps a WebSocket open to the
// relay of the Cloudflare Worker (cloudflare/worker.js, RemoteRoom); the phones paired with it
// (remote/) connect to the same room. The room id is random and travels only in the QR code.
// Messages are small JSON objects: the phone sends {t:'cmd'|'hello'|'get'}, the screen answers
// with {t:'state'|'list'|'sources'|'channels'|'toast'}.
import { focused } from './focus.js';
import { load, save, getSettings } from './storage.js';
import { buildProxyUrl } from './addons.js';
import * as player from './player.js';
import * as yt from './youtube.js';

const KEY = 'remote';
let handlers = null;       // set by app.js: sources(), channels(src), openChannel(src, i), navigate(route), back()
let ws = null, wsOpen = false, retry = 0, retryTimer = 0, pingTimer = 0, stopped = true;
let remotes = 0;
let sentList = -1;
const listeners = new Set();
const srcCache = new Map(); // src id -> [{ item, open }]

const randomId = () => {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function defaultName() {
  const ua = navigator.userAgent;
  if (/SalottoTV/.test(ua)) return 'TV';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'PC';
  if (/Linux|CrOS/.test(ua)) return 'Linux';
  return 'Salotto';
}

/** { room, name, enabled } of this screen (the room is created the first time). */
export function config() {
  let c = load(KEY, null);
  if (!c || !c.room) { c = { room: randomId(), name: defaultName(), enabled: false }; save(KEY, c); }
  return c;
}
function setConfig(patch) { const c = { ...config(), ...patch }; save(KEY, c); return c; }

/** Base address and token of the relay: the Worker set as proxy in Settings. */
export function relay() {
  const s = getSettings();
  const full = buildProxyUrl(s.proxyUrl, s.proxyToken);
  if (!full) return null;
  try {
    const u = new URL(full);
    return { base: u.origin, token: u.searchParams.get('token') || '' };
  } catch { return null; }
}

/** Does the Worker have the remote relay? Resolves to 'ok' | 'noproxy' | 'old' | 'down'. */
export async function check() {
  const r = relay();
  if (!r) return 'noproxy';
  try {
    const res = await fetch(r.base + '/remote/health', { cache: 'no-store' });
    if (res.ok && (await res.text()).trim() === 'ok') return 'ok';
    return 'old'; // 404 (old Worker) or 501 (no Durable Object binding)
  } catch { return 'down'; }
}

/** Address the phone opens (in the QR code). */
export function pairUrl() {
  const r = relay(), c = config();
  const u = new URL('remote/', location.href);
  u.search = '';
  const p = new URLSearchParams({ r: c.room, w: r ? r.base : '', n: c.name });
  if (r?.token) p.set('t', r.token);
  u.hash = p.toString();
  return u.href;
}

export const status = () => ({ connected: wsOpen, remotes, enabled: config().enabled });
export const onStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emitStatus = () => { for (const fn of listeners) { try { fn(status()); } catch { /* ignore */ } } };

function send(msg) {
  if (ws && wsOpen) { try { ws.send(JSON.stringify(msg)); } catch { /* closing */ } }
}

function sendState() {
  if (!remotes) return;
  send({ t: 'state', name: config().name, page: location.hash || '#/', s: player.remoteState() });
  const list = player.remoteChannels();
  const ver = list ? list.version : 0;
  if (ver !== sentList) { sentList = ver; send({ t: 'list', ...(list || { version: 0, items: [] }) }); }
}

async function sendSources() {
  if (!handlers) return;
  try { send({ t: 'sources', items: await handlers.sources() }); } catch (e) { console.warn('telecomando', e); }
}

async function channelsOf(src) {
  const list = await handlers.channels(src);
  srcCache.set(src, list);
  return list;
}

async function sendChannels(src) {
  try {
    const list = await channelsOf(src);
    const nums = player.channelNumbers(list.map(c => c.item));
    send({ t: 'channels', src, items: list.map((c, i) => player.remoteItem(c.item, nums[i] ?? i + 1)) });
  } catch (e) {
    send({ t: 'toast', text: 'Elenco non disponibile: ' + (e.message || e) });
  }
}

// Keys from the phone's arrows: they go through the same handlers as a keyboard or TV remote.
function pressKey(key) {
  if (key === 'Back') {
    // in the player: list / info → controls → close, like a TV remote
    if (yt.isOpen()) yt.back();
    else if (player.isOpen() && document.getElementById('modal')?.hidden !== false) player.back(true);
    else handlers?.back();
    return;
  }
  document.body.classList.add('kbd-nav');
  const target = focused() && focused() !== document.body ? focused() : document;
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  ev.salottoRemote = true; // the player then treats the arrows like a TV remote's
  target.dispatchEvent(ev);
  if (ev.defaultPrevented || key !== 'Enter') return;
  // a synthetic Enter doesn't press the focused button by itself
  const a = focused();
  if (a && a !== document.body && typeof a.click === 'function' && !(a.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(a.type))) a.click();
}

async function onCommand(m) {
  const st = player.remoteState();
  // a YouTube video: YouTube's player takes play/pause, skip and stop
  if (yt.isOpen()) {
    if (m.c === 'play') { yt.togglePlay(); return; }
    if (m.c === 'skip') { yt.skip(m.s); return; }
    if (m.c === 'stop') { yt.close(); return; }
  }
  switch (m.c) {
    case 'zap': if (!player.zap(m.d > 0 ? 1 : -1)) send({ t: 'toast', text: 'Apri prima un canale' }); break;
    case 'tune': player.tuneTo(m.i); break;
    case 'number': if (!player.typeNumber(m.n)) send({ t: 'toast', text: st.open ? 'Canale ' + m.n + ' non presente' : 'Apri prima un canale' }); break;
    case 'play': if (st.open) player.togglePlay(); break;
    case 'vol': player.setVolume(m.v != null ? m.v : st.volume + (m.d || 0)); break;
    case 'mute': player.toggleMute(); break;
    case 'av': if (m.reset) player.avReset(); else player.avStep(m.d); break;
    case 'skip': if (st.open) player.skip(m.s); break;
    case 'live': if (st.open) player.goLive(); break;
    case 'panel': if (st.open) { player.togglePanel(); player.remoteMarkBox(); } break;
    case 'info': if (st.open) { player.toggleInfo(); player.remoteMarkBox(); } break;
    case 'sync': if (st.open) { player.toggleSync(); player.remoteMarkBox(); } break;
    case 'subs': if (st.open) player.toggleSubs(); break;
    case 'ccbox': if (st.open) { player.toggleSubsBox(); player.remoteMarkBox(); } break;
    case 'stop': player.close(); break;
    case 'fs': {
      const r = await player.remoteFullscreen();
      if (r === 'blocked') send({ t: 'toast', text: 'Il browser chiede un tocco sullo schermo: tocca lo schermo (o premi un tasto) e va a schermo intero', ms: 6000 });
      break;
    }
    case 'key': pressKey(String(m.k || '')); break;
    case 'go': handlers?.navigate(String(m.r || '')); break;
    case 'open': {
      // a channel picked from a list on the phone
      try {
        const list = srcCache.get(m.src) || await channelsOf(m.src);
        await handlers.openChannel(list, m.i);
      } catch (e) { send({ t: 'toast', text: e.message || String(e) }); }
      break;
    }
    default: break;
  }
}

function onMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (!m || typeof m !== 'object') return;
  if (m.t === 'peers') {
    const before = remotes;
    remotes = m.remotes | 0;
    if (remotes > before) { sentList = -1; sendState(); }
    player.setRemoteActive(remotes > 0);
    emitStatus();
    return;
  }
  if (m.t === 'hello') { sentList = -1; sendState(); sendSources(); return; }
  if (m.t === 'get' && m.what === 'channels') { sendChannels(String(m.src || '')); return; }
  if (m.t === 'get' && m.what === 'list') { sentList = -1; sendState(); return; }
  if (m.t === 'cmd') onCommand(m).finally(() => setTimeout(sendState, 150));
}

function connect() {
  clearTimeout(retryTimer);
  if (stopped || ws) return;
  const r = relay();
  if (!r) return;
  const c = config();
  const u = new URL(r.base.replace(/^http/, 'ws') + '/remote/ws');
  u.searchParams.set('room', c.room);
  u.searchParams.set('role', 'tv');
  if (r.token) u.searchParams.set('token', r.token);
  let sock;
  try { sock = new WebSocket(u.href); } catch { scheduleRetry(); return; }
  ws = sock;
  sock.onopen = () => {
    wsOpen = true; retry = 0;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { sock.send('ping'); } catch { /* closing */ } }, 25000);
    emitStatus();
  };
  sock.onmessage = (ev) => { if (ev.data !== 'pong') onMessage(ev); };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null; wsOpen = false; remotes = 0;
    clearInterval(pingTimer);
    player.setRemoteActive(false);
    emitStatus();
    if (ev.code !== 4000) scheduleRetry(); // 4000: the same screen connected again elsewhere
  };
  sock.onerror = () => { /* onclose follows */ };
}

function scheduleRetry() {
  if (stopped) return;
  retry = Math.min(retry + 1, 6);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, Math.min(60000, 1500 * 2 ** (retry - 1)));
}

/** Starts listening for phones (remembered: after a restart it listens again). */
export function start() {
  setConfig({ enabled: true, off: false });
  stopped = false;
  connect();
}

/** Stops listening; with forget the room changes, so paired phones stop working. */
export function stop(forget = false) {
  stopped = true;
  clearTimeout(retryTimer);
  if (ws) { const s = ws; ws = null; wsOpen = false; remotes = 0; try { s.close(1000); } catch { /* ignore */ } }
  clearInterval(pingTimer);
  player.setRemoteActive(false);
  setConfig(forget ? { enabled: false, room: randomId() } : { enabled: false, off: true });
  emitStatus();
}

/** Restart the connection (after the proxy or the name changed). */
export function restart() {
  if (ws) { const s = ws; ws = null; wsOpen = false; try { s.close(1000); } catch { /* ignore */ } }
  if (config().enabled) { stopped = false; connect(); }
  emitStatus();
}

export function setName(name) {
  setConfig({ name: String(name || '').trim().slice(0, 40) || defaultName() });
  sendState();
}

export function init(h) {
  handlers = h;
  player.onChange(sendState);
  window.addEventListener('hashchange', () => setTimeout(sendState, 300));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !ws) { retry = 0; connect(); } });
  window.addEventListener('online', () => { if (!ws) { retry = 0; connect(); } });
  if (config().enabled) { stopped = false; connect(); }
}
