// Full-screen media player: native HTML5 playback, HLS via native support
// (Safari / every iPad browser) or hls.js (desktop Chrome, Firefox, Android).
import { getResume, setResume, getSettings, isFavourite, toggleFavourite } from './storage.js';
import { getProxy, proxify } from './addons.js';

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
};

let hls = null;
let current = null;       // { item, stream, key, favEntry }
let idleTimer = 0;
let seeking = false;
let lastSave = 0;
let onCloseCb = null;
let triedProxy = false;
let triedHls = false;

export const isOpen = () => !el.root.hidden;

function fmt(t) {
  if (!isFinite(t) || t < 0) return '0:00';
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function isLive() { return !isFinite(el.video.duration) || (current && current.item.live); }

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
  } catch { /* unsupported actions */ }
}

function skip(s) {
  const v = el.video;
  if (isLive()) return;
  v.currentTime = Math.max(0, Math.min((v.duration || 0) - 1, v.currentTime + s));
  wake();
}

function togglePlay() {
  const v = el.video;
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
 * @param opts   { favEntry?, onClose? }
 */
export async function play(item, stream, opts = {}) {
  triedProxy = false;
  triedHls = false;
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
  showMsg('Caricamento…');
  setupMediaSession(item);
  wake();
  try {
    await attach(stream);
    const resume = getSettings().autoResume && !item.live ? getResume(current.key) : 0;
    if (resume) {
      el.video.addEventListener('loadedmetadata', () => { el.video.currentTime = resume; showMsg('Ripresa da ' + fmt(resume), 2000); }, { once: true });
    }
    await el.video.play().catch(() => showMsg('Tocca ▶ per avviare'));
  } catch (e) {
    showMsg(e.message);
  }
  el.play.focus({ preventScroll: true });
}

export function close() {
  if (!isOpen()) return;
  saveResume(true);
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
  wake();
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

// ---------------------------------------------------------------- wiring
const v = el.video;
v.addEventListener('timeupdate', () => {
  if (!seeking && isFinite(v.duration) && v.duration > 0) el.seek.value = Math.round((v.currentTime / v.duration) * 1000);
  el.cur.textContent = fmt(v.currentTime);
  saveResume(false);
});
v.addEventListener('durationchange', () => {
  const live = isLive();
  el.dur.textContent = live ? 'LIVE' : fmt(v.duration);
  el.seek.disabled = live; el.rew.disabled = live; el.fwd.disabled = live;
});
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
  if (isFinite(v.duration)) el.cur.textContent = fmt((el.seek.value / 1000) * v.duration);
});
el.seek.addEventListener('change', () => {
  if (isFinite(v.duration)) v.currentTime = (el.seek.value / 1000) * v.duration;
  seeking = false;
});
el.root.addEventListener('pointermove', wake);
el.root.addEventListener('pointerdown', wake);
el.root.querySelector('.player-stage').addEventListener('click', () => {
  if (el.ui.classList.contains('idle')) wake(); else togglePlay();
});
el.ui.addEventListener('click', (e) => {
  if (e.target === el.ui) { if (el.ui.classList.contains('idle')) wake(); else togglePlay(); }
});
window.addEventListener('pagehide', () => saveResume(true));
