// Full-screen media player: native HTML5 playback, HLS via native support
// (Safari / every iPad browser) or hls.js (desktop Chrome, Firefox, Android).
import { getResume, setResume, getSettings, isFavourite, toggleFavourite } from './storage.js';
import { getProxy, proxify } from './addons.js';
import * as cast from './cast.js';

const UA = navigator.userAgent;
const APPLE = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  (/Safari\//.test(UA) && !/Chrome|Chromium|CriOS|FxiOS|Edg|Android/.test(UA));
const hasMse = () => !!(window.MediaSource || window.ManagedMediaSource);

const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';

const $ = (id) => document.getElementById(id);
const el = {
  root: $('player'), video: $('video'), ui: $('player-ui'), title: $('pl-title'),
  close: $('pl-close'), fav: $('pl-fav'), play: $('pl-play'), rew: $('pl-rew'), fwd: $('pl-fwd'),
  seek: $('pl-seek'), cur: $('pl-cur'), dur: $('pl-dur'), vol: $('pl-vol'), fs: $('pl-fs'),
  msg: $('pl-msg'), art: $('audio-art'), artImg: $('audio-art-img'),
  cast: $('pl-cast'), chUp: $('pl-chup'), chDown: $('pl-chdown'), chList: $('pl-chlist'), osd: $('pl-osd'), osdNum: $('pl-osd-num'),
  osdName: $('pl-osd-name'), panel: $('pl-channels'), chNum: $('pl-chnum'), chItems: $('pl-chitems'), chClose: $('pl-chclose'),
};

let hls = null;
let current = null;       // { item, stream, key, favEntry }
let idleTimer = 0;
let seeking = false;
let lastSave = 0;
let onCloseCb = null;
let triedProxy = false;
let triedHls = false;
let casting = false;      // a Google Cast session is playing the current item
let localAttached = false; // the local <video> has the stream loaded
let airplayAvailable = false;
let channels = null;      // { list: [{ item, open() }], index } when zapping between live channels

export const isOpen = () => !el.root.hidden;

function fmt(t) {
  if (!isFinite(t) || t < 0) return '0:00';
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function isLive() { return !isFinite(el.video.duration) || (current && current.item.live); }

// Live rewind: how far back the stream lets us go. It is the broadcaster's window (the
// segments still listed in the HLS playlist), reported by the browser as the seekable range.
const MIN_WINDOW = 20; // seconds: shorter windows are not worth a seek bar
function liveWindow() {
  const s = el.video.seekable;
  if (!s || !s.length) return null;
  const start = s.start(0), end = s.end(s.length - 1);
  return isFinite(start) && isFinite(end) && end - start >= MIN_WINDOW ? { start, end } : null;
}

function goLive() {
  const w = liveWindow();
  if (!w) return;
  const edge = hls && isFinite(hls.liveSyncPosition) && hls.liveSyncPosition > 0 ? hls.liveSyncPosition : w.end - 3;
  el.video.currentTime = edge;
  if (el.video.paused) el.video.play().catch(() => {});
  wake();
}

/** Seek bar, ⟲10/30⟳ and the LIVE button: for live streams they follow the rewind window. */
function updateSeekUi() {
  const v = el.video;
  if (!current || casting) return;
  const live = isLive();
  const w = live ? liveWindow() : null;
  const canSeek = !live || !!w;
  if (el.seek.disabled === canSeek) el.seek.disabled = !canSeek;
  el.rew.disabled = el.fwd.disabled = !canSeek;
  el.rew.hidden = el.fwd.hidden = live && !w;
  if (!live) {
    el.dur.textContent = fmt(v.duration);
    el.dur.classList.remove('is-live', 'behind');
    el.dur.tabIndex = -1;
    if (!seeking && isFinite(v.duration) && v.duration > 0) el.seek.value = Math.round((v.currentTime / v.duration) * 1000);
    el.cur.textContent = fmt(v.currentTime);
    return;
  }
  if (!w) {
    el.dur.textContent = 'LIVE';
    el.dur.classList.add('is-live'); el.dur.classList.remove('behind');
    el.dur.tabIndex = -1;
    el.cur.textContent = '';
    return;
  }
  const behind = Math.max(0, w.end - v.currentTime);
  const atEdge = behind < 12;
  if (!seeking) el.seek.value = Math.round(((v.currentTime - w.start) / (w.end - w.start)) * 1000);
  el.cur.textContent = atEdge ? '' : '−' + fmt(behind);
  el.dur.textContent = atEdge ? 'LIVE' : 'LIVE ▶▶';
  el.dur.classList.toggle('is-live', atEdge);
  el.dur.classList.toggle('behind', !atEdge);
  el.dur.tabIndex = atEdge ? -1 : 0;
  el.seek.title = 'Puoi tornare indietro fino a ' + fmt(w.end - w.start);
}

function showMsg(text, ms = 0) {
  el.msg.textContent = text;
  el.msg.hidden = !text;
  if (ms) setTimeout(() => { if (el.msg.textContent === text) el.msg.hidden = true; }, ms);
}

function wake() {
  el.ui.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!el.video.paused && !current?.audio) el.ui.classList.add('idle'); }, 3500);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Hls) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error('Impossibile caricare il lettore HLS'));
    document.head.appendChild(s);
  });
}

function looksHls(url, mime) {
  return /mpegurl/i.test(mime || '') || /\.m3u8(\?|#|$)/i.test(url);
}

function buildUrl(stream) {
  if (stream.proxy || (stream.headers && Object.keys(stream.headers).length)) {
    if (!getProxy()) return stream.url; // best effort without proxy
    let u = proxify(stream.url);
    if (stream.headers) u += '&headers=' + encodeURIComponent(JSON.stringify(stream.headers));
    return u;
  }
  return stream.url;
}

async function attach(stream) {
  destroyHls();
  const v = el.video;
  const url = buildUrl(stream);
  // Apple devices play HLS natively (and without CORS limits); elsewhere hls.js
  // is more reliable than the browser's own support, when Media Source is available.
  const native = !!v.canPlayType('application/vnd.apple.mpegurl') && (APPLE || !hasMse());
  if (looksHls(stream.url, stream.mime) && !native) {
    await loadScript(HLS_CDN);
    if (!window.Hls || !window.Hls.isSupported()) {
      if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; return; }
      throw new Error('HLS non supportato da questo browser');
    }
    hls = new window.Hls({ enableWorker: true, lowLatencyMode: !!current?.item.live });
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && getProxy() && !triedProxy && !stream.proxy) {
        triedProxy = true;
        showMsg('Riprovo tramite proxy…', 2500);
        attach({ ...stream, proxy: true }).then(() => v.play().catch(() => {}));
        return;
      }
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
      const cors = data.type === window.Hls.ErrorTypes.NETWORK_ERROR && !getProxy();
      showMsg(cors
        ? 'Questo stream non permette la riproduzione da un sito web in questo browser (CORS). Su iPad e Safari di solito funziona; altrove serve il proxy (Impostazioni).'
        : 'Errore di riproduzione (' + data.details + '). Lo stream potrebbe essere offline.');
    });
    hls.loadSource(url);
    hls.attachMedia(v);
  } else {
    v.src = url;
  }
  if (stream.subtitles) {
    for (const t of [...v.querySelectorAll('track')]) t.remove();
    for (const s of stream.subtitles) {
      const tr = document.createElement('track');
      Object.assign(tr, { kind: 'subtitles', src: s.url, srclang: s.lang || 'it', label: s.label || s.lang || 'Sottotitoli' });
      v.appendChild(tr);
    }
  }
}

function destroyHls() {
  if (hls) { try { hls.destroy(); } catch { /* ignore */ } hls = null; }
}

function setupMediaSession(item) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.label,
      artist: item.subtitle || item.info?.artist || '',
      artwork: item.thumb ? [{ src: item.thumb, sizes: '512x512' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => el.video.play());
    navigator.mediaSession.setActionHandler('pause', () => el.video.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => skip(-10));
    navigator.mediaSession.setActionHandler('seekforward', () => skip(30));
    navigator.mediaSession.setActionHandler('nexttrack', channels ? () => zap(1) : null);
    navigator.mediaSession.setActionHandler('previoustrack', channels ? () => zap(-1) : null);
  } catch { /* unsupported actions */ }
}

function skip(s) {
  const v = el.video;
  if (casting) { if (!current?.item.live) cast.seek(cast.remoteTime() + s); wake(); return; }
  if (isLive()) {
    const w = liveWindow();
    if (!w) return;
    v.currentTime = Math.max(w.start + 1, Math.min(w.end - 3, v.currentTime + s));
    updateSeekUi();
    wake();
    return;
  }
  v.currentTime = Math.max(0, Math.min((v.duration || 0) - 1, v.currentTime + s));
  wake();
}

function togglePlay() {
  const v = el.video;
  if (casting) { cast.playOrPause(); wake(); return; }
  if (!localAttached && current) {
    localAttached = true;
    attach(current.stream).then(() => v.play()).catch(e => showMsg(e.message));
    wake();
    return;
  }
  if (v.paused) v.play().catch(err => showMsg('Tocca ▶ per avviare (' + err.message + ')', 3000));
  else v.pause();
  wake();
}

function saveResume(force) {
  if (!current || isLive()) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  setResume(current.key, el.video.currentTime, el.video.duration);
}

function updateFavBtn() {
  if (!current?.favEntry) { el.fav.hidden = true; return; }
  el.fav.hidden = false;
  const on = isFavourite(current.favEntry.key);
  el.fav.innerHTML = on ? '&#9733;' : '&#9734;';
  el.fav.style.color = on ? 'var(--accent-2)' : '';
}

/**
 * Open the player.
 * @param item   listing item (label, thumb, type, live...)
 * @param stream { url, mime?, headers?, subtitles?, proxy? }
 * @param opts   { favEntry?, onClose?, channels? }  channels = { list: [{ item, open }], index }
 *               lets the viewer switch live channel (CH +/−, swipe, arrows, number) without leaving.
 */
export async function play(item, stream, opts = {}) {
  triedProxy = false;
  triedHls = false;
  channels = opts.channels && opts.channels.list.length > 1 ? opts.channels : null;
  if (channels && !channels.numbers) channels.numbers = numberChannels(channels.list);
  pendingIndex = -1;
  updateChannelUi();
  const audio = item.type === 'audio' || /^audio\//.test(stream.mime || '');
  current = { item, stream, key: stream.url, audio, favEntry: opts.favEntry };
  onCloseCb = opts.onClose || null;
  el.root.hidden = false;
  el.root.classList.toggle('audio', audio);
  el.art.hidden = !audio;
  if (audio) el.artImg.src = item.thumb || 'icons/icon.svg';
  el.video.poster = !audio && (item.fanart || item.thumb) ? (item.fanart || item.thumb) : '';
  el.title.textContent = item.label;
  el.seek.value = 0; el.cur.textContent = '0:00'; el.dur.textContent = item.live ? 'LIVE' : '0:00';
  updateFavBtn();
  el.seek.disabled = el.rew.disabled = el.fwd.disabled = !!item.live;
  el.rew.hidden = el.fwd.hidden = !!item.live; // shown again if the stream has a rewind window
  el.dur.classList.toggle('is-live', !!item.live); el.dur.classList.remove('behind');
  el.seek.title = '';
  showMsg('Caricamento…');
  setupMediaSession(item);
  wake();
  localAttached = false;
  if (casting) {
    const resume = getSettings().autoResume && !item.live ? getResume(current.key) : 0;
    await sendToCast(resume);
    if (!opts.keepFocus || !el.root.contains(document.activeElement)) el.play.focus({ preventScroll: true });
    return;
  }
  try {
    localAttached = true;
    await attach(stream);
    const resume = getSettings().autoResume && !item.live ? getResume(current.key) : 0;
    if (resume) {
      el.video.addEventListener('loadedmetadata', () => { el.video.currentTime = resume; showMsg('Ripresa da ' + fmt(resume), 2000); }, { once: true });
    }
    await el.video.play().catch(() => showMsg('Tocca ▶ per avviare'));
  } catch (e) {
    showMsg(e.message);
  }
  if (!opts.keepFocus || !el.root.contains(document.activeElement)) el.play.focus({ preventScroll: true });
}

export function close() {
  if (!isOpen()) return;
  saveResume(true);
  if (casting) cast.stopMedia();
  const v = el.video;
  v.pause();
  destroyHls();
  v.removeAttribute('src');
  for (const t of [...v.querySelectorAll('track')]) t.remove();
  v.load();
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
  el.root.hidden = true;
  current = null;
  channels = null;
  clearTimeout(zapTimer); clearTimeout(digitTimer); digits = ''; zapToken++;
  el.osd.hidden = true; el.panel.hidden = true;
  const cb = onCloseCb; onCloseCb = null;
  if (cb) cb();
}

function toggleFullscreen() {
  const r = el.root;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if (r.requestFullscreen) {
    r.requestFullscreen().catch(() => el.video.webkitEnterFullscreen && el.video.webkitEnterFullscreen());
  } else if (r.webkitRequestFullscreen) {
    r.webkitRequestFullscreen();
  } else if (el.video.webkitEnterFullscreen) {
    el.video.webkitEnterFullscreen(); // iPhone
  }
}

// Phones: full screen video goes landscape, leaving full screen goes back to portrait.
// Screen Orientation lock works on Android (Chrome, Edge, Samsung Internet) while
// in full screen; on iPhone the system player rotates by itself.
const isPhone = () => matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;

function onFullscreenChange() {
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const o = screen.orientation;
  if (!o) return;
  if (fs && current && !current.audio && isPhone() && typeof o.lock === 'function') {
    o.lock('landscape').catch(() => { /* not supported (e.g. iOS): ignore */ });
  } else if (!fs && typeof o.unlock === 'function') {
    try { o.unlock(); } catch { /* ignore */ }
  }
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

/** Keyboard / remote handling while the player is open. Returns true if handled. */
export function handleKey(e) {
  if (!isOpen()) return false;
  if (document.activeElement === el.chNum) {
    if (e.key === 'Escape') { closePanel(); return true; }
    if (e.key === 'Enter') { const n = parseInt(el.chNum.value, 10); if (n) { closePanel(); jumpTo(n); } return true; }
    return false; // typing in the channel number box
  }
  wake();
  if (channels) {
    if (/^[0-9]$/.test(e.key)) { typeDigit(e.key); return true; }
    if (e.key === 'Enter' && digits) { commitDigits(); return true; }
    const a = document.activeElement;
    const inPanel = !el.panel.hidden && el.panel.contains(a);
    switch (e.key) {
      case 'ArrowUp': case 'ArrowDown':
        if (inPanel || a === el.vol) return false;
        zap(e.key === 'ArrowUp' ? 1 : -1); return true;
      case 'PageUp': case 'ChannelUp': case 'MediaTrackNext': zap(1); return true;
      case 'PageDown': case 'ChannelDown': case 'MediaTrackPrevious': zap(-1); return true;
      case 'Escape': case 'Backspace': case 'BrowserBack':
        if (!el.panel.hidden) { closePanel(); return true; }
        break;
      case 'c': togglePanel(); return true;
      default: break;
    }
  }
  switch (e.key) {
    case ' ': case 'MediaPlayPause': case 'k': togglePlay(); return true;
    case 'Escape': case 'Backspace': case 'BrowserBack': close(); return true;
    case 'f': toggleFullscreen(); return true;
    case 'ArrowLeft': case 'ArrowRight': {
      const a = document.activeElement;
      if (a && a !== el.seek && el.root.contains(a) && a.matches('button, input')) return false;
      skip(e.key === 'ArrowLeft' ? -10 : 30);
      return true;
    }
    case 'MediaTrackPrevious': skip(-10); return true;
    case 'MediaTrackNext': skip(30); return true;
    default: return false;
  }
}

// ---------------------------------------------------------------- casting (Google Cast, AirPlay)
// The TV/speaker fetches the stream itself, so it gets the proxied address when a proxy is
// configured (it adds the CORS headers Cast receivers require and the channel's headers).
function castUrl(stream) {
  const needsProxy = looksHls(stream.url, stream.mime) || stream.proxy || (stream.headers && Object.keys(stream.headers).length);
  if (!getProxy() || !needsProxy) return stream.url;
  let u = proxify(stream.url);
  if (stream.headers) u += '&headers=' + encodeURIComponent(JSON.stringify(stream.headers));
  return new URL(u, location.href).href;
}

async function sendToCast(startTime = 0) {
  if (!current) return;
  const { item, stream } = current;
  if (/^(blob|data):/.test(stream.url)) { showMsg('I file del dispositivo non si possono trasmettere: apri un contenuto online.', 4000); return; }
  showMsg('Invio a ' + cast.deviceName() + '…');
  try {
    await cast.load({
      url: castUrl(stream), mime: stream.mime, hls: looksHls(stream.url, stream.mime),
      title: item.label, subtitle: item.subtitle || '', thumb: item.thumb, live: !!item.live, audio: current.audio, startTime,
    });
  } catch (e) {
    showMsg('Trasmissione non riuscita' + (e && (e.description || e.code) ? ' (' + (e.description || e.code) + ')' : '') + '. Lo stream potrebbe non essere compatibile con il dispositivo.', 5000);
    return;
  }
  // the TV plays it now: stop playing (and downloading) here
  el.video.pause();
  try { if (hls) hls.stopLoad(); } catch { /* ignore */ }
  showMsg('In riproduzione su ' + cast.deviceName());
}

function updateCastBtn() {
  const wireless = !!el.video.webkitCurrentPlaybackTargetIsWireless;
  el.cast.hidden = !(cast.available() || airplayAvailable || casting || wireless);
  el.cast.classList.toggle('active', casting || wireless);
  el.root.classList.toggle('casting', casting);
}

cast.initCast({
  onState: updateCastBtn,
  onSession: (active) => {
    casting = active;
    updateCastBtn();
    if (!isOpen() || !current) return;
    if (active) sendToCast(localAttached ? el.video.currentTime : 0);
    else {
      el.play.innerHTML = '&#9654;';
      try { if (hls) hls.startLoad(); } catch { /* ignore */ }
      showMsg('Trasmissione terminata. Tocca ▶ per continuare qui.', 4000);
    }
  },
  onProgress: ({ time, duration, paused }) => {
    if (!casting || !isOpen()) return;
    el.play.innerHTML = paused ? '&#9654;' : '&#10074;&#10074;';
    el.cur.textContent = fmt(time);
    if (isFinite(duration) && duration > 0 && !current?.item.live) {
      el.dur.textContent = fmt(duration);
      if (!seeking) el.seek.value = Math.round((time / duration) * 1000);
    }
  },
});

// AirPlay (Safari and every browser on iPad/iPhone, Safari on the Mac)
if (window.WebKitPlaybackTargetAvailabilityEvent) {
  el.video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => { airplayAvailable = e.availability === 'available'; updateCastBtn(); });
  el.video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
    updateCastBtn();
    showMsg(el.video.webkitCurrentPlaybackTargetIsWireless ? 'In riproduzione su AirPlay' : '', 0);
  });
}

el.cast.addEventListener('click', () => {
  if (airplayAvailable && typeof el.video.webkitShowPlaybackTargetPicker === 'function') { el.video.webkitShowPlaybackTargetPicker(); return; }
  cast.requestSession().catch(() => { /* picker closed */ });
});

// ---------------------------------------------------------------- live channels
let pendingIndex = -1;   // channel shown on the OSD while the viewer is still pressing CH +/−
let zapTimer = 0, osdTimer = 0, digitTimer = 0, zapToken = 0;
let digits = '';

// Numbers shown and typed: the broadcast number when the add-on knows it (first copy wins),
// the others follow after the highest one; a list with no numbers at all is numbered 1, 2, 3…
function numberChannels(list) {
  const used = new Set();
  const out = list.map((c) => {
    const n = parseInt(c.item.number, 10);
    if (n > 0 && !used.has(n)) { used.add(n); return n; }
    return 0;
  });
  let next = used.size ? Math.max(...used) + 1 : 1;
  return out.map(n => n || next++);
}
const chNumber = (_it, i) => String(channels?.numbers?.[i] ?? i + 1);

function updateChannelUi() {
  const on = !!channels;
  el.chUp.hidden = el.chDown.hidden = el.chList.hidden = !on;
  if (!on) { el.panel.hidden = true; return; }
  if (!el.panel.hidden) renderPanel();
}

function showOsd(index, text) {
  const it = channels?.list[index]?.item;
  el.osdNum.textContent = text != null ? text : it ? chNumber(it, index) : '';
  el.osdName.textContent = text != null ? '' : it ? it.label : '';
  el.osd.hidden = false;
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => { el.osd.hidden = true; }, 2500);
}

/** Channel up (+1) / down (−1). Quick repeated presses only tune the last one. */
export function zap(delta) {
  if (!channels) return false;
  const n = channels.list.length;
  const from = pendingIndex >= 0 ? pendingIndex : channels.index;
  pendingIndex = ((from + delta) % n + n) % n;
  showOsd(pendingIndex);
  clearTimeout(zapTimer);
  zapTimer = setTimeout(() => tune(pendingIndex), 450);
  return true;
}

// Number typed by the viewer = the number shown in the channel list (broadcast number when known, else position).
function findByNumber(num) {
  return channels.list.findIndex((c, i) => chNumber(c.item, i) === String(num));
}

export function jumpTo(num) {
  if (!channels) return false;
  const i = findByNumber(num);
  if (i < 0) { showOsd(-1, String(num)); showMsg('Canale ' + num + ' non presente in questo elenco', 2500); return false; }
  pendingIndex = i;
  showOsd(i);
  clearTimeout(zapTimer);
  tune(i);
  return true;
}

function typeDigit(d) {
  digits = (digits + d).slice(-4);
  showOsd(-1, digits + '–');
  clearTimeout(digitTimer);
  digitTimer = setTimeout(commitDigits, 1500);
}

function commitDigits() {
  clearTimeout(digitTimer);
  const n = parseInt(digits, 10);
  digits = '';
  if (n) jumpTo(n);
}

async function tune(index) {
  if (!channels) return;
  const list = channels.list;
  const entry = list[index];
  const token = ++zapToken;
  const keepClose = onCloseCb;
  if (index === channels.index && current) { pendingIndex = -1; return; }
  showMsg('Sintonizzo ' + entry.item.label + '…');
  try {
    const r = await entry.open();
    if (token !== zapToken || !isOpen()) return;
    await play(r.item, r.stream, { favEntry: r.favEntry, onClose: keepClose, channels: { list, index, numbers: channels.numbers }, keepFocus: true });
    showOsd(index);
  } catch (e) {
    if (token !== zapToken) return;
    pendingIndex = -1;
    showMsg(e.message || String(e), 4000);
  }
}

function renderPanel() {
  const cur = channels.index;
  el.chItems.replaceChildren(...channels.list.map((c, i) => {
    const b = document.createElement('button');
    b.className = 'ch-row focusable' + (i === cur ? ' current' : '');
    const num = document.createElement('span'); num.className = 'ch-num'; num.textContent = chNumber(c.item, i);
    const name = document.createElement('span'); name.className = 'ch-name'; name.textContent = c.item.label;
    b.append(num, name);
    b.addEventListener('click', () => { closePanel(); if (i !== channels.index) { pendingIndex = i; showOsd(i); tune(i); } });
    return b;
  }));
}

function openPanel() {
  if (!channels) return;
  renderPanel();
  el.panel.hidden = false;
  el.chNum.value = '';
  const row = el.chItems.children[channels.index];
  if (row) { row.scrollIntoView({ block: 'center' }); row.focus({ preventScroll: true }); }
}

function closePanel() {
  if (el.panel.hidden) return;
  el.panel.hidden = true;
  if (document.activeElement && el.panel.contains(document.activeElement)) document.activeElement.blur();
  el.chList.focus({ preventScroll: true });
  wake();
}

function togglePanel() { if (el.panel.hidden) openPanel(); else closePanel(); }

el.chUp.addEventListener('click', () => zap(1));
el.chDown.addEventListener('click', () => zap(-1));
el.chList.addEventListener('click', togglePanel);
el.chClose.addEventListener('click', closePanel);
el.chNum.addEventListener('input', () => { el.chNum.value = el.chNum.value.replace(/\D/g, '').slice(0, 4); });

// ---------------------------------------------------------------- wiring
const v = el.video;
v.addEventListener('timeupdate', () => {
  updateSeekUi();
  saveResume(false);
});
v.addEventListener('durationchange', updateSeekUi);
v.addEventListener('progress', updateSeekUi);
v.addEventListener('loadedmetadata', updateSeekUi);
el.dur.addEventListener('click', () => { if (isLive() && el.dur.classList.contains('behind')) goLive(); });
v.addEventListener('playing', () => { showMsg(''); el.play.innerHTML = '&#10074;&#10074;'; wake(); });
v.addEventListener('pause', () => { el.play.innerHTML = '&#9654;'; wake(); saveResume(true); });
v.addEventListener('waiting', () => showMsg('Buffering…'));
v.addEventListener('ended', () => { if (current) setResume(current.key, 0, 0); el.play.innerHTML = '&#9654;'; });
v.addEventListener('error', () => {
  if (hls || !current) return; // hls.js reports its own errors
  const code = v.error?.code;
  // Many live URLs (redirectors, extension-less links) are HLS in disguise:
  // when the browser cannot play them natively, retry with the HLS engine.
  if (code === 4 && !triedHls && !looksHls(current.stream.url, current.stream.mime)) {
    triedHls = true;
    showMsg('Provo come stream HLS…');
    const stream = { ...current.stream, mime: 'application/vnd.apple.mpegurl' };
    current.stream = stream;
    attach(stream).then(() => v.play().catch(() => {})).catch(e => showMsg(e.message));
    return;
  }
  const reasons = { 1: 'interrotto', 2: 'errore di rete', 3: 'errore di decodifica', 4: 'formato non supportato o stream non raggiungibile' };
  showMsg('Impossibile riprodurre: ' + (reasons[code] || 'errore sconosciuto'));
});

el.play.addEventListener('click', togglePlay);
el.rew.addEventListener('click', () => skip(-10));
el.fwd.addEventListener('click', () => skip(30));
el.close.addEventListener('click', close);
el.fs.addEventListener('click', toggleFullscreen);
el.fav.addEventListener('click', () => {
  if (!current?.favEntry) return;
  toggleFavourite(current.favEntry);
  updateFavBtn();
});
el.vol.addEventListener('input', () => { v.volume = el.vol.value / 100; });
el.seek.addEventListener('input', () => {
  seeking = true;
  const w = isLive() ? liveWindow() : null;
  if (w) { el.cur.textContent = '−' + fmt(w.end - (w.start + (el.seek.value / 1000) * (w.end - w.start))); return; }
  if (isFinite(v.duration)) el.cur.textContent = fmt((el.seek.value / 1000) * v.duration);
});
el.seek.addEventListener('change', () => {
  if (casting) {
    const d = cast.remoteDuration();
    if (d > 0 && !current?.item.live) cast.seek((el.seek.value / 1000) * d);
    seeking = false;
    return;
  }
  const w = isLive() ? liveWindow() : null;
  if (w) {
    v.currentTime = Math.min(w.end - 3, w.start + (el.seek.value / 1000) * (w.end - w.start));
    seeking = false;
    updateSeekUi();
    return;
  }
  if (isFinite(v.duration)) v.currentTime = (el.seek.value / 1000) * v.duration;
  seeking = false;
});
// Tapping the picture: on touch screens it shows/hides the controls (like a TV
// remote overlay); with a mouse a click toggles play/pause as on desktop players.
let lastPointer = 'mouse';
let swipe = null;          // touch start, for vertical swipes = channel up/down
let swallowClick = false;
el.root.addEventListener('pointerdown', (e) => {
  lastPointer = e.pointerType || 'mouse';
  const onBackground = !e.target.closest('.player-top, .player-bottom, .player-channels');
  swipe = channels && e.pointerType === 'touch' && onBackground ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
}, { capture: true, passive: true });
el.root.addEventListener('pointerup', (e) => {
  const s = swipe; swipe = null;
  if (!s || !channels) return;
  const dx = e.clientX - s.x, dy = e.clientY - s.y;
  if (Math.abs(dy) > 60 && Math.abs(dy) > 1.5 * Math.abs(dx) && Date.now() - s.t < 1000) {
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 400);
    zap(dy < 0 ? 1 : -1); // swipe up = next channel
  }
}, { passive: true });
el.root.addEventListener('pointercancel', () => { swipe = null; }, { passive: true });
el.root.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') wake(); }, { passive: true });
for (const bar of el.ui.querySelectorAll('.player-top, .player-bottom')) bar.addEventListener('pointerdown', wake, { passive: true });

function hideControls() {
  clearTimeout(idleTimer);
  el.ui.classList.add('idle');
  if (el.ui.contains(document.activeElement)) document.activeElement.blur();
}

function onBackgroundTap() {
  if (swallowClick) { swallowClick = false; return; }
  if (!el.panel.hidden) { closePanel(); return; }
  const hidden = el.ui.classList.contains('idle');
  if (lastPointer === 'mouse') { if (hidden) wake(); else togglePlay(); return; }
  if (hidden) wake(); else hideControls();
}
el.root.querySelector('.player-stage').addEventListener('click', onBackgroundTap);
el.ui.addEventListener('click', (e) => { if (e.target === el.ui) onBackgroundTap(); });
window.addEventListener('pagehide', () => saveResume(true));
