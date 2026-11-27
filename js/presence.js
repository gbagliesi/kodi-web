// Access log: while Salotto is on screen (or playing in a floating window) it tells the Worker set
// as proxy "this device is here" every couple of minutes (POST /access, see cloudflare/worker.js).
// The Worker adds who carries the token (owner or a friend) and where the request comes from
// (country, region, city, network); beats a few minutes apart make one visit, so the owner sees
// who used Salotto, from where, on how many devices and for how long.
// Sent: a random id of this device (made here, never synced), its screen name and kind, the app
// version and how many seconds of video were watched since the last beat. No titles, no IP.
import { load, save } from './storage.js';
import * as addons from './addons.js';
import { VERSION } from './version.js';

const BEAT = 120000;     // the Worker joins beats less than 6 minutes apart into one visit
const TICK = 10000;      // how often the watching time is counted
let started = false, watch = 0, lastBeat = 0;

/** Base address and token of the Worker set as proxy, or null. */
export function endpoint() {
  const p = addons.getProxy();
  if (!p || !/^https?:/i.test(p)) return null;
  try {
    const u = new URL(p);
    if (/^(127\.|localhost$)/.test(u.hostname) && u.origin === location.origin) return null; // server.js
    const token = u.searchParams.get('token') || '';
    return token ? { base: u.origin + u.pathname.replace(/\/proxy(\/[\w.-]+)?$/, ''), token } : null;
  } catch { return null; }
}

function deviceId() {
  let id = load('device', '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    const b = crypto.getRandomValues(new Uint8Array(12));
    id = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    save('device', id);
  }
  return id;
}

export function platform() {
  const ua = navigator.userAgent;
  if (/SalottoTV/.test(ua)) return 'Fire TV';
  const ipad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const os = ipad ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'altro';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const app = matchMedia('(display-mode: standalone)').matches || navigator.standalone ? ' (app)' : '';
  return os + (br ? ' ' + br : '') + app;
}

const active = () => document.visibilityState === 'visible' || !!document.pictureInPictureElement || watching();
function watching() {
  const v = document.getElementById('video');
  if (v && !v.paused && !v.ended && v.readyState > 2) return true;
  const y = document.getElementById('yt-player');
  return !!y && !y.hidden;
}

function body() {
  const name = (load('remote', null) || {}).name || '';
  const b = JSON.stringify({ device: deviceId(), name, platform: platform(), version: VERSION, watch: Math.round(watch) });
  watch = 0;
  return b;
}

/** Send a beat now. leaving: the page is being hidden (sendBeacon survives it). */
export function beat(leaving = false) {
  const ep = endpoint();
  if (!ep) return;
  lastBeat = Date.now();
  const url = ep.base + '/access?token=' + encodeURIComponent(ep.token);
  const data = body();
  // text/plain: a "simple" request, no CORS preflight
  if (leaving && navigator.sendBeacon) { try { if (navigator.sendBeacon(url, new Blob([data], { type: 'text/plain' }))) return; } catch { /* fall back */ } }
  fetch(url, { method: 'POST', body: data, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(() => {});
}

export function start() {
  if (started) return;
  started = true;
  setInterval(() => {
    if (watching()) watch += TICK / 1000;
    if (active() && Date.now() - lastBeat >= BEAT) beat();
  }, TICK);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if (Date.now() - lastBeat > 30000) beat(); }
    else if (!active()) beat(true);
  });
  setTimeout(() => beat(), 3000); // after the proxy has been found
}

/** The owner's view: visits of the last days, or throws with a message to show. */
export async function visits(days = 30) {
  const ep = endpoint();
  if (!ep) throw new Error('Serve il tuo Worker Cloudflare come proxy, con il token, in Impostazioni.');
  const res = await fetch(ep.base + '/access?days=' + days + '&token=' + encodeURIComponent(ep.token), { cache: 'no-store' });
  if (res.status === 403) throw new Error('Gli accessi li vede solo il proprietario del Worker (con il suo token, non quello di un amico).');
  if (res.status === 404 || res.status === 501) throw new Error('Il Worker non ha ancora il registro degli accessi: va aggiornato (si aggiorna da solo dopo il prossimo rilascio).');
  if (!res.ok) throw new Error('Il Worker risponde: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}
