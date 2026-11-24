// Full-screen media player: native HTML5 playback, HLS via native support
// (Safari / every iPad browser) or hls.js (desktop Chrome, Firefox, Android).
import { getResume, setResume, getSettings, isFavourite, toggleFavourite, getAvSync, setAvSync } from './storage.js';
import { getProxy, proxify } from './addons.js';
import * as cast from './cast.js';
import * as epg from './epg.js';
import * as avsync from './avsync.js';

const UA = navigator.userAgent;
const APPLE = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
  (/Safari\//.test(UA) && !/Chrome|Chromium|CriOS|FxiOS|Edg|Android/.test(UA));
const hasMse = () => !!(window.MediaSource || window.ManagedMediaSource);

const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';

const $ = (id) => document.getElementById(id);
const el = {
  root: $('player'), video: $('video'), ui: $('player-ui'), title: $('pl-title'),
  close: $('pl-close'), fav: $('pl-fav'), play: $('pl-play'), rew: $('pl-rew'), fwd: $('pl-fwd'),
  seek: $('pl-seek'), cur: $('pl-cur'), dur: $('pl-dur'), vol: $('pl-vol'), fs: $('pl-fs'), pip: $('pl-pip'),
  msg: $('pl-msg'), art: $('audio-art'), artImg: $('audio-art-img'),
  cast: $('pl-cast'), route: $('pl-route'), stats: $('pl-stats'), chUp: $('pl-chup'), chDown: $('pl-chdown'), chList: $('pl-chlist'), osd: $('pl-osd'), osdNum: $('pl-osd-num'),
  osdName: $('pl-osd-name'), osdProg: $('pl-osd-prog'), prog: $('pl-prog'), info: $('pl-info'), epg: $('pl-epg'), epgCh: $('pl-epg-ch'), epgBody: $('pl-epg-body'), epgClose: $('pl-epgclose'), sync: $('pl-sync'), syncBadge: $('pl-syncbadge'), syncBox: $('pl-syncbox'), syncVal: $('pl-syncval'), syncNote: $('pl-syncnote'),
  syncEarlier: $('pl-syncearlier'), syncLater: $('pl-synclater'), syncReset: $('pl-syncreset'), syncClose: $('pl-syncclose'),
  panel: $('pl-channels'), chNum: $('pl-chnum'), chItems: $('pl-chitems'), chClose: $('pl-chclose'),
};

let hls = null;
let current = null;       // { item, stream, key, favEntry }
let idleTimer = 0;
let seeking = false;
let lastSave = 0;
let onCloseCb = null;
let triedProxy = false;
let triedHls = false;
// TV app: 0 = native HLS direct, 1 = native HLS through the proxy, 2 = hls.js (native failed)
let nativeStage = 0, nativeErr = 0;
const TV_APP = /SalottoTV/.test(navigator.userAgent);
let casting = false;      // a Google Cast session is playing the current item
let localAttached = false; // the local <video> has the stream loaded
let airplayAvailable = false;
let channels = null;      // { list: [{ item, open() }], index } when zapping between live channels
let avMs = 0;             // audio/video sync of the current channel, ms (> 0 = sound later)
let avNative = false;     // hls.js failed with the sync on: back to the native player, no sync

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

export function goLive() {
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
    // the WebView's native HLS player decides by the file extension (error 4 on ".../proxy?url=")
    if (stream.m3u8Name) u = u.replace(/\/proxy\?/, '/proxy/live.m3u8?');
    return u;
  }
  return stream.url;
}

// "Diretto" / "Proxy" badge next to the title: how the stream reaches this device (or the TV)
let localRoute = '', routeLabel = '';
const isProxied = (u) => { const p = getProxy(); return !!p && String(u).startsWith(p.split('?')[0]); };
function showRoute(proxied, where = '') {
  const label = (where ? where + ' · ' : '') + (proxied ? 'Proxy' : 'Diretto');
  el.route.textContent = label + ' ⓘ';
  routeLabel = label;
  el.route.classList.toggle('proxy', proxied);
  el.route.title = (proxied ? 'Lo stream passa dal tuo proxy (Cloudflare o server locale)' : 'Lo stream arriva direttamente dal sito del canale, senza proxy') + '. Tocca per i dettagli tecnici.';
  el.route.hidden = false;
}

async function attach(stream) {
  destroyHls();
  const v = el.video;
  const url = buildUrl(stream);
  localRoute = isProxied(url) ? 'proxy' : 'direct';
  if (!casting) showRoute(localRoute === 'proxy');
  // Apple devices play HLS natively (and without CORS limits); elsewhere hls.js
  // is more reliable than the browser's own support, when Media Source is available.
  // The Fire TV app tries the WebView's own HLS player first (Giuseppe's choice: lighter on the
  // Stick, about the same lip sync as hls.js), falling back to hls.js on error.
  // A channel with an audio/video sync needs hls.js (only Media Source can move the sound).
  const avShift = !!avMs && hasMse() && !avNative;
  const native = !!v.canPlayType('application/vnd.apple.mpegurl') && !avShift && (APPLE || !hasMse() || (TV_APP && nativeStage < 2));
  if (looksHls(stream.url, stream.mime) && !native) {
    await loadScript(HLS_CDN);
    if (!window.Hls || !window.Hls.isSupported()) {
      if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; return; }
      throw new Error('HLS non supportato da questo browser');
    }
    hls = new window.Hls({ enableWorker: true, lowLatencyMode: !!current?.item.live });
    avsync.hookHls(hls, () => avMs / 1000);
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && getProxy() && !triedProxy && !stream.proxy) {
        triedProxy = true;
        showMsg('Riprovo tramite proxy…', 2500);
        attach({ ...stream, proxy: true }).then(() => v.play().catch(() => {}));
        return;
      }
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
      // hls.js was used only for the audio sync and fails here: the native player still works
      if (avMs && !avNative && v.canPlayType('application/vnd.apple.mpegurl') && (APPLE || TV_APP || !hasMse())) {
        avNative = true;
        showMsg('Su questo dispositivo la sincronia audio non funziona con questo canale: lo riproduco senza.', 5000);
        renderSync();
        attach(stream).then(() => v.play().catch(() => {}));
        return;
      }
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
  // Chrome: lets the browser open the floating window by itself when the user leaves the app
  try { navigator.mediaSession.setActionHandler('enterpictureinpicture', () => enterPip()); } catch { /* older Chrome */ }
}

export function skip(s) {
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

export function togglePlay() {
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
  nativeStage = 0; nativeErr = 0;
  channels = opts.channels && opts.channels.list.length > 1 ? opts.channels : null;
  if (channels && !channels.numbers) channels.numbers = numberChannels(channels.list);
  pendingIndex = -1;
  updateChannelUi();
  const audio = item.type === 'audio' || /^audio\//.test(stream.mime || '');
  current = { item, stream, key: stream.url, audio, favEntry: opts.favEntry };
  avMs = audio ? 0 : getAvSync(avKey());
  avNative = false;
  clearTimeout(avTimer);
  updateSyncBtn();
  el.route.hidden = true;
  onCloseCb = opts.onClose || null;
  el.root.hidden = false;
  autoFullscreen();
  el.root.classList.toggle('audio', audio);
  el.art.hidden = !audio;
  if (audio) el.artImg.src = item.thumb || 'icons/icon.svg';
  el.video.poster = !audio && (item.fanart || item.thumb) ? (item.fanart || item.thumb) : '';
  el.title.textContent = channels ? chNumber(item, channels.index) + '  ' + item.label : item.label;
  showProgramme();
  el.seek.value = 0; el.cur.textContent = '0:00'; el.dur.textContent = item.live ? 'LIVE' : '0:00';
  updateFavBtn();
  el.seek.disabled = el.rew.disabled = el.fwd.disabled = !!item.live;
  el.rew.hidden = el.fwd.hidden = !!item.live; // shown again if the stream has a rewind window
  el.dur.classList.toggle('is-live', !!item.live); el.dur.classList.remove('behind');
  el.seek.title = '';
  showMsg('Caricamento…');
  setupMediaSession(item);
  updatePipBtn();
  // TV remote zapping with the controls hidden: keep them hidden so ▲▼ keep changing channel
  if (!(opts.keepFocus && document.body.classList.contains('tv') && el.ui.classList.contains('idle'))) wake();
  localAttached = false;
  if (casting) {
    const resume = getSettings().autoResume && !item.live ? getResume(current.key) : 0;
    await sendToCast(resume);
    if (!opts.keepFocus || !el.root.contains(document.activeElement)) el.play.focus({ preventScroll: true });
    changed(true);
    return;
  }
  try {
    localAttached = true;
    await attach(stream);
    const resume = getSettings().autoResume && !item.live ? getResume(current.key) : 0;
    if (resume) {
      el.video.addEventListener('loadedmetadata', () => { el.video.currentTime = resume; showMsg('Ripresa da ' + fmt(resume), 2000); }, { once: true });
    }
    await el.video.play().catch((err) => { if (!casting && !mutedFallback(err)) showMsg('Tocca ▶ per avviare'); });
  } catch (e) {
    showMsg(e.message);
  }
  changed(true);
  if (!opts.keepFocus || !el.root.contains(document.activeElement)) el.play.focus({ preventScroll: true });
}

/** Remote "Back": channel list → controls (TV) → close the player. */
export function back(remote = false) {
  if (!el.syncBox.hidden) { closeSync(); return; }
  if (!el.panel.hidden) { closePanel(); return; }
  if (!el.epg.hidden) { closeInfo(); return; }
  if ((remote || document.body.classList.contains('tv')) && !el.ui.classList.contains('idle')) { hideControls(); return; }
  close();
}

export function close() {
  if (!isOpen()) return;
  saveResume(true);
  if (casting) cast.stopMedia();
  const v = el.video;
  exitPip();
  v.pause();
  destroyHls();
  v.removeAttribute('src');
  for (const t of [...v.querySelectorAll('track')]) t.remove();
  v.load();
  if ((wantsAutoFs() || remoteFs) && document.fullscreenElement === document.documentElement) {
    // automatic mode: the whole app stays full screen, so Chrome's "full screen" notice
    // appears once instead of at every video; just give the lists their orientation back
    autoFs = true;
    try { screen.orientation?.unlock(); } catch { /* ignore */ }
  } else if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
  el.root.hidden = true;
  current = null;
  channels = null;
  clearTimeout(zapTimer); clearTimeout(digitTimer); digits = ''; zapToken++;
  el.osd.hidden = true; el.panel.hidden = true; el.epg.hidden = true; el.syncBox.hidden = true;
  clearTimeout(avTimer);
  toggleStats(false);
  changed(true);
  const cb = onCloseCb; onCloseCb = null;
  if (cb) cb();
}

// Android/Chrome moves a video to the floating window by itself when the user leaves the app,
// but only if the video is full screen. So on Android videos open full screen (keeping the
// current orientation; the full screen button then turns to landscape). Needs the tap that
// opened the video, which is why it runs before anything is awaited.
let autoFs = false;
const wantsAutoFs = () => /Android/i.test(navigator.userAgent) && !/SalottoTV/.test(navigator.userAgent) && getSettings().autoPip && isOpen() && current && !current.audio && !casting;
function autoFullscreen() {
  const doc = document.documentElement;
  if (!wantsAutoFs() || document.fullscreenElement || !doc.requestFullscreen) return false;
  if (navigator.userActivation && !navigator.userActivation.isActive) return false;
  autoFs = true;
  // the whole page (not just the player) so it can stay full screen between videos
  doc.requestFullscreen({ navigationUI: 'hide' }).catch(() => { autoFs = false; });
  return true;
}

const FS_ICON = el.fs.innerHTML;
const ROTATE_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M16.5 2.5A10 10 0 0 1 22 11h1.5A11.5 11.5 0 0 0 12 0l-.66.03 3.81 3.81 1.35-1.34zM10.23 1.75a1.5 1.5 0 0 0-2.12 0L1.75 8.11a1.5 1.5 0 0 0 0 2.12l12.02 12.02a1.5 1.5 0 0 0 2.12 0l6.36-6.36a1.5 1.5 0 0 0 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zM7.5 21.5A10 10 0 0 1 2 13H.5A11.5 11.5 0 0 0 12 24l.66-.03-3.81-3.81-1.35 1.34z"/></svg>';
/** Phones in full screen: the button rotates (portrait ⇄ landscape) instead of leaving full screen. */
function updateFsBtn() {
  const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const rotate = fs && isPhone() && typeof screen.orientation?.lock === 'function';
  el.fs.innerHTML = rotate ? ROTATE_ICON : FS_ICON;
  el.fs.setAttribute('aria-label', rotate ? (autoFs ? 'Ruota in orizzontale' : 'Ruota in verticale') : 'Schermo intero');
  el.fs.title = el.fs.getAttribute('aria-label');
}

function toggleFullscreen() {
  const r = el.root;
  if (document.fullscreenElement && isPhone() && typeof screen.orientation?.lock === 'function') {
    // already full screen on a phone: switch between portrait (automatic mode) and landscape
    const want = autoFs ? 'landscape' : 'portrait';
    autoFs = want === 'portrait';
    updateFsBtn();
    // if the browser dropped full screen behind our back, the lock fails: enter full screen again
    const target = wantsAutoFs() ? document.documentElement : r;
    screen.orientation.lock(want).catch(() => target.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation.lock(want)).catch(() => {}));
    return;
  }
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
  if (!fs) { autoFs = false; remoteFs = false; }
  changed();
  updateFsBtn();
  const o = screen.orientation;
  if (!o) return;
  if (fs && !autoFs && current && !current.audio && isPhone() && typeof o.lock === 'function') {
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
  // the phone remote's arrows work like a TV remote's, whatever the screen
  if (document.body.classList.contains('tv') || e.salottoRemote === true) {
    // TV remote: with the controls hidden, ▲▼ change channel, ◀▶ skip, OK shows the controls;
    // with the controls shown, the arrows move between the buttons (top bar included).
    // The phone opens the menu only with its own OK: controls shown by a mouse move or a new
    // channel count as hidden, so its first OK never presses ⏯ by mistake.
    const idle = el.ui.classList.contains('idle') || (e.salottoRemote === true && !remoteMenu);
    const inPanel = inSidePanel(document.activeElement);
    if (e.salottoRemote === true && (inPanel || (!idle && (e.key === 'Enter' || e.key.startsWith('Arrow'))))) remoteMenu = true;
    if ((e.key === 'ContextMenu' || e.key === 'c') && channels) { togglePanel(); wake(); return true; }
    if (idle && !inPanel) {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && channels) { zap(e.key === 'ArrowUp' ? 1 : -1); return true; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { skip(e.key === 'ArrowLeft' ? -10 : 30); return true; }
      if (e.key === 'Enter') { wake(); el.play.focus({ preventScroll: true }); if (e.salottoRemote === true) remoteMenu = true; return true; }
    }
    // Position bar: ◀ goes back 10 s, ▶ jumps to the LIVE button on live TV (OK returns to the
    // live broadcast) or forward 30 s on a video; the bar's own 1/1000 steps are useless on a remote
    if (document.activeElement === el.seek && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      wake();
      if (e.key === 'ArrowRight' && isLive()) el.dur.focus({ preventScroll: true });
      else skip(e.key === 'ArrowLeft' ? -10 : 30);
      return true;
    }
    if (e.key.startsWith('Arrow')) { wake(); return false; } // spatial navigation among the controls
  }
  wake();
  if (channels) {
    if (/^[0-9]$/.test(e.key)) { typeDigit(e.key); return true; }
    if (e.key === 'Enter' && digits) { commitDigits(); return true; }
    const a = document.activeElement;
    const inPanel = inSidePanel(a);
    switch (e.key) {
      case 'ArrowUp': case 'ArrowDown':
        if (inPanel || a === el.vol) return false;
        zap(e.key === 'ArrowUp' ? 1 : -1); return true;
      case 'PageUp': case 'ChannelUp': case 'MediaTrackNext': zap(1); return true;
      case 'PageDown': case 'ChannelDown': case 'MediaTrackPrevious': zap(-1); return true;
      case 'Escape': case 'Backspace': case 'BrowserBack':
        if (!el.syncBox.hidden) { closeSync(); return true; }
        if (!el.panel.hidden) { closePanel(); return true; }
        if (!el.epg.hidden) { closeInfo(); return true; }
        break;
      case 'c': togglePanel(); return true;
      default: break;
    }
  }
  switch (e.key) {
    case ' ': case 'MediaPlayPause': case 'k': togglePlay(); return true;
    case 'Escape': case 'Backspace': case 'BrowserBack':
      if (!el.syncBox.hidden) { closeSync(); return true; }
      if (!el.epg.hidden) { closeInfo(); return true; }
      close(); return true;
    case 'i': toggleInfo(); return true;
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

// ---------------------------------------------------------------- stream details (tap the Diretto/Proxy badge)
let statsTimer = 0;
const kbps = (b) => !b ? '—' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' Mbit/s' : Math.round(b / 1e3) + ' kbit/s';
function statsRows() {
  const v = el.video, rows = [];
  if (current) rows.push(['Canale', channels ? chNumber(current.item, channels.index) + ' · ' + current.item.label : current.item.label]);
  rows.push(['Percorso', routeLabel || '—']);
  if (casting) { rows.push(['Riproduzione', 'sulla TV (' + cast.deviceName() + ')']); return rows; }
  rows.push(['Motore', hls ? 'hls.js' + (nativeErr ? ' (HLS nativo non riuscito, errore ' + nativeErr + ')' : '') : (looksHls(current?.stream.url || '', current?.stream.mime) ? 'HLS nativo del browser' : 'lettore del browser')]);
  if (avMs) rows.push(['Sincronia audio', fmtAv(avMs) + (avsync.separateAudio(hls) ? '' : ' (non applicata)')]);
  rows.push(['Risoluzione', v.videoWidth ? v.videoWidth + '×' + v.videoHeight : (current?.audio ? 'solo audio' : '—')]);
  if (hls && hls.levels?.length) {
    const lv = hls.levels[hls.currentLevel] || hls.levels[hls.loadLevel];
    if (lv) {
      rows.push(['Bitrate', kbps(lv.bitrate) + (lv.frameRate ? ' · ' + Math.round(lv.frameRate) + ' fps' : '')]);
      if (lv.videoCodec || lv.audioCodec) rows.push(['Codec', [lv.videoCodec, lv.audioCodec].filter(Boolean).join(' + ')]);
    }
    rows.push(['Qualità', (hls.currentLevel + 1) + ' di ' + hls.levels.length + (hls.autoLevelEnabled ? ' (automatica)' : '')]);
    if (hls.bandwidthEstimate) rows.push(['Banda stimata', kbps(hls.bandwidthEstimate)]);
  } else if (!current?.audio) {
    rows.push(['Bitrate', hls ? '—' : 'non disponibile in questo browser']);
  }
  const b = v.buffered;
  let ahead = 0;
  for (let i = 0; i < (b?.length || 0); i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) > v.currentTime) ahead = b.end(i) - v.currentTime;
  rows.push(['Buffer', ahead.toFixed(1) + ' s']);
  const w = isLive() ? liveWindow() : null;
  if (isLive()) rows.push(['Finestra diretta', w ? Math.round(w.end - w.start) + ' s' : 'nessuna']);
  const q = v.getVideoPlaybackQuality?.();
  if (q && q.totalVideoFrames) rows.push(['Fotogrammi persi', q.droppedVideoFrames + ' di ' + q.totalVideoFrames]);
  try { rows.push(['Server', new URL(current.stream.url).host]); } catch { /* ignore */ }
  return rows;
}
function renderStats() {
  if (el.stats.hidden || !current) return;
  el.stats.replaceChildren(...statsRows().map(([k, val]) => {
    const r = document.createElement('div');
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('b'); b.textContent = val;
    r.append(a, b); return r;
  }));
}
function toggleStats(show = el.stats.hidden) {
  el.stats.hidden = !show;
  clearInterval(statsTimer);
  if (show) { renderStats(); statsTimer = setInterval(renderStats, 1000); }
}

// ---------------------------------------------------------------- picture-in-picture (floating window)
const pipSupported = () => !!((document.pictureInPictureEnabled && !el.video.disablePictureInPicture)
  || (typeof el.video.webkitSupportsPresentationMode === 'function' && el.video.webkitSupportsPresentationMode('picture-in-picture')));
const inPip = () => document.pictureInPictureElement === el.video || el.video.webkitPresentationMode === 'picture-in-picture';

function updatePipBtn() { el.pip.hidden = !pipSupported() || !!current?.audio; }

async function enterPip(fromButton = false) {
  const v = el.video;
  if (inPip() || !current || current.audio) return;
  // Safari (iPad, iPhone) only opens the window straight inside the tap: nothing may be awaited
  // before the request, and its own presentation-mode API is the most reliable there.
  const webkitPip = typeof v.webkitSupportsPresentationMode === 'function' && v.webkitSupportsPresentationMode('picture-in-picture');
  // leave full screen only when asked with the button (a background attempt may fail and the
  // video must then stay full screen); not awaited, so the tap still counts for the request
  if (fromButton && (document.fullscreenElement || document.webkitFullscreenElement)) {
    try { (document.exitFullscreen || document.webkitExitFullscreen).call(document)?.catch?.(() => {}); } catch { /* ignore */ }
  }
  let err = null;
  try {
    if (webkitPip) {
      v.webkitSetPresentationMode('picture-in-picture');
      await new Promise(r => setTimeout(r, 600));
      if (inPip()) return;
    }
    if (v.requestPictureInPicture && document.pictureInPictureEnabled) { await v.requestPictureInPicture(); return; }
    if (!webkitPip) throw new Error('non supportata');
  } catch (e) { err = e; }
  if (inPip() || !fromButton) return;
  const why = v.readyState < 1 ? ': attendi che il video parta.'
    : (navigator.standalone || matchMedia('(display-mode: standalone)').matches) && APPLE
      ? ': nell\'app aggiunta alla Home l\'iPad non la permette, apri Salotto in Safari.'
      : '.';
  showMsg('Finestra mobile non disponibile' + why + (err?.name && why === '.' ? ' (' + err.name + ')' : ''), 5000);
}

function exitPip() {
  try {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else if (el.video.webkitPresentationMode === 'picture-in-picture') el.video.webkitSetPresentationMode('inline');
  } catch { /* ignore */ }
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
  showRoute(isProxied(castUrl(stream)), 'TV');
}

function updateCastBtn() {
  const wireless = !!el.video.webkitCurrentPlaybackTargetIsWireless;
  el.cast.hidden = !(cast.available() || airplayAvailable || casting || wireless);
  el.cast.classList.toggle('active', casting || wireless);
  el.root.classList.toggle('casting', casting);
}

cast.initCast({
  onState: updateCastBtn,
  onError: () => { if (isOpen()) showMsg('La TV non riesce a riprodurre questo stream. Se usi il proxy Cloudflare, aggiorna il codice del Worker (vedi guida) o prova un altro canale.', 7000); },
  onSession: (active) => {
    casting = active;
    updateCastBtn();
    updateSyncBtn();
    if (!isOpen() || !current) return;
    if (active) sendToCast(localAttached ? el.video.currentTime : 0);
    else {
      el.play.innerHTML = '&#9654;';
      try { if (hls) hls.startLoad(); } catch { /* ignore */ }
      showMsg('Trasmissione terminata. Tocca ▶ per continuare qui.', 4000);
      if (localRoute) showRoute(localRoute === 'proxy');
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
/** Channel numbers for a list of live items, the same ones the player uses (CH ±, digits). */
// What is on now on a live channel, under the title (from the TV guide, see epg.js).
function showProgramme() {
  const it = current?.item;
  const nn = it && it.live ? epg.nowNext(it) : null;
  el.prog.hidden = el.info.hidden = !nn;
  if (!el.epg.hidden) { if (nn) renderInfo(); else closeInfo(); }
  if (!nn) return;
  el.prog.textContent = nn.now
    ? `${epg.hhmm(nn.now.start)}–${epg.hhmm(nn.now.stop)}  ${nn.now.title}` + (nn.next ? `   ·   Poi: ${nn.next.title}` : '')
    : `Alle ${epg.hhmm(nn.next.start)}: ${nn.next.title}`;
}

// ⓘ: the whole description of what is on now and next, beside the video (it keeps playing).
function renderInfo() {
  const it = current?.item;
  if (!it) return;
  el.epgCh.textContent = (channels ? chNumber(it, channels.index) + '  ' : '') + it.label;
  const t = Date.now();
  const list = epg.programmes(it, t, t + 12 * 3600000).slice(0, 8);
  const mk = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; if (text != null) e.textContent = text; return e; };
  const nextIdx = list.findIndex(p => p.start > t);
  el.epgBody.replaceChildren(...list.map((p, i) => {
    const on = p.start <= t && p.stop > t;
    const box = mk('div', 'epg-prog focusable' + (on ? ' on' : ''));
    box.tabIndex = 0;
    const when = mk('div', 'ep-when', `${epg.hhmm(p.start)}–${epg.hhmm(p.stop)}` + (i === nextIdx ? ' · Dopo' : ''));
    if (on) when.append(mk('span', 'gi-live', 'IN ONDA'));
    box.append(when, mk('div', 'ep-title', p.title));
    if (on) { const bar = mk('div', 'gi-bar'); const f = mk('span', ''); f.style.width = Math.round(epg.progress(p, t) * 100) + '%'; bar.append(f); box.append(bar); }
    if (p.sub) box.append(mk('div', 'ep-sub', p.sub));
    if (p.desc || p.cat) box.append(mk('div', 'ep-desc', [p.cat, p.desc].filter(Boolean).join(' · ')));
    return box;
  }));
  if (!list.length) el.epgBody.replaceChildren(mk('div', 'ep-desc', 'Nessuna informazione sui programmi.'));
}

function openInfo() {
  if (!current) return;
  closePanel();
  el.syncBox.hidden = true;
  renderInfo();
  el.epg.hidden = false;
  el.epgBody.scrollTop = 0;
  (el.epgBody.querySelector('.epg-prog') || el.epgClose).focus({ preventScroll: true });
}

function closeInfo() {
  if (el.epg.hidden) return;
  el.epg.hidden = true;
  if (document.activeElement && el.epg.contains(document.activeElement)) document.activeElement.blur();
  if (!el.info.hidden) el.info.focus({ preventScroll: true });
  wake();
}

export function toggleInfo() { if (el.epg.hidden) openInfo(); else closeInfo(); }
const inSidePanel = (a) => (!el.panel.hidden && el.panel.contains(a)) || (!el.epg.hidden && el.epg.contains(a)) || (!el.syncBox.hidden && el.syncBox.contains(a));
el.info.addEventListener('click', toggleInfo);
el.prog.addEventListener('click', openInfo);
el.epgClose.addEventListener('click', closeInfo);

// ---------------------------------------------------------------- audio/video sync (A/V button)
// Moves the sound earlier or later than the picture, like Kodi's audio offset. Saved per channel
// (until "Azzera"). It works where the player uses hls.js (Media Source): see avsync.js.
const AV_STEP = 50, AV_MAX = 3000;
let avTimer = 0;
const avKey = () => current ? (current.favEntry?.key || current.key) : '';
const fmtAv = (ms) => (ms > 0 ? '+' : ms < 0 ? '−' : '') + Math.abs(ms) + ' ms';
/** Why the sync can't work for the current video, or '' if it can. */
function avBlocked() {
  if (!current || current.audio) return 'Solo per i video.';
  if (casting) return 'Durante la trasmissione alla TV la sincronia la regola la TV.';
  if (!hasMse()) return 'Questo dispositivo non permette di spostare l\'audio (serve Media Source, assente su iPhone).';
  if (!looksHls(current.stream.url, current.stream.mime)) return 'Disponibile per i canali in diretta e gli stream HLS, non per i file video semplici.';
  if (avNative) return 'Con questo canale su questo dispositivo funziona solo il lettore di sistema, che non permette di spostare l\'audio.';
  const sb = hls?.bufferController?.sourceBuffer;
  if (hls && sb && Object.keys(sb).length && !avsync.separateAudio(hls)) return 'Questo canale trasmette audio e video in un unico flusso: la sincronia non si può regolare.';
  return '';
}
function updateSyncBtn() {
  el.sync.hidden = !current || current.audio || casting;
  el.sync.classList.toggle('active', !!avMs);
  el.syncBadge.textContent = avMs ? fmtAv(avMs) : '';
  el.sync.title = 'Sincronia audio' + (avMs ? ': ' + fmtAv(avMs) + ' (salvata per questo canale)' : ': voce prima o dopo il video');
}
function renderSync() {
  updateSyncBtn();
  if (el.syncBox.hidden) return;
  const blocked = avBlocked();
  el.syncVal.textContent = fmtAv(avMs);
  el.syncEarlier.disabled = !!blocked || avMs <= -AV_MAX;
  el.syncLater.disabled = !!blocked || avMs >= AV_MAX;
  el.syncReset.disabled = !avMs;
  el.syncNote.textContent = blocked || (avMs
    ? `La voce esce ${Math.abs(avMs)} ms ${avMs > 0 ? 'dopo' : 'prima'} rispetto al canale originale. Resta salvato per questo canale finché non premi Azzera.`
    : 'Se senti la voce prima del movimento delle labbra premi «Voce dopo», se la senti in ritardo premi «Voce prima». Ogni tocco sposta di 50 ms e il valore resta salvato per questo canale.');
}
function setAv(ms) {
  if (!current) return;
  ms = Math.max(-AV_MAX, Math.min(AV_MAX, Math.round(ms / AV_STEP) * AV_STEP));
  if (ms === avMs) return;
  avMs = ms;
  setAvSync(avKey(), ms);
  renderSync();
  changed();
  clearTimeout(avTimer);
  avTimer = setTimeout(applyAv, 700); // wait for the last of a series of taps
}
/** Apply a changed sync to what is playing: reload the buffer, or move from the native player to hls.js. */
function applyAv() {
  if (!current || casting || !localAttached) return;
  if (hls) { avsync.reload(hls); renderSync(); return; }
  if (!avMs || avBlocked()) return;
  const v = el.video, t = v.currentTime, live = isLive();
  showMsg('Passo al lettore che permette la sincronia…', 2500);
  attach(current.stream).then(() => {
    if (!live && t > 1) v.addEventListener('loadedmetadata', () => { v.currentTime = t; }, { once: true });
    return v.play().catch(() => {});
  }).catch(e => showMsg(e.message)).then(renderSync);
}
function openSync() {
  if (!current) return;
  closePanel();
  if (!el.epg.hidden) el.epg.hidden = true;
  el.syncBox.hidden = false;
  renderSync();
  const first = [el.syncLater, el.syncEarlier, el.syncReset].find(b => !b.disabled) || el.syncClose;
  first.focus({ preventScroll: true });
}
function closeSync() {
  if (el.syncBox.hidden) return;
  el.syncBox.hidden = true;
  if (document.activeElement && el.syncBox.contains(document.activeElement)) document.activeElement.blur();
  if (!el.sync.hidden) el.sync.focus({ preventScroll: true });
  wake();
}
el.sync.addEventListener('click', () => { if (el.syncBox.hidden) openSync(); else closeSync(); });
el.syncClose.addEventListener('click', closeSync);
el.syncEarlier.addEventListener('click', () => setAv(avMs - AV_STEP));
el.syncLater.addEventListener('click', () => setAv(avMs + AV_STEP));
el.syncReset.addEventListener('click', () => { setAv(0); (el.syncLater.disabled ? el.syncClose : el.syncLater).focus({ preventScroll: true }); });

setInterval(() => { if (isOpen()) showProgramme(); }, 30000);
epg.onUpdate(() => { if (isOpen()) showProgramme(); });

export const channelNumbers = (items) => numberChannels(items.map(item => ({ item })));
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
  const nn = text == null && it ? epg.nowNext(it) : null;
  el.osdProg.textContent = nn?.now ? nn.now.title + ' · fino alle ' + epg.hhmm(nn.now.stop) : '';
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
  changed();
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
    const text = document.createElement('span'); text.className = 'ch-text'; text.append(name);
    const nn = epg.nowNext(c.item);
    if (nn?.now) { const pr = document.createElement('span'); pr.className = 'ch-prog'; pr.textContent = nn.now.title; text.append(pr); }
    b.append(num, text);
    b.addEventListener('click', () => { closePanel(); if (i !== channels.index) { pendingIndex = i; showOsd(i); tune(i); } });
    return b;
  }));
}

function openPanel() {
  if (!channels) return;
  if (!el.epg.hidden) { el.epg.hidden = true; }
  el.syncBox.hidden = true;
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

export function togglePanel() { if (el.panel.hidden) openPanel(); else closePanel(); }

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
// On the TV app the controls only come back when asked (OK), not when a new channel starts
const tvIdle = () => document.body.classList.contains('tv') && el.ui.classList.contains('idle');
v.addEventListener('playing', () => { showMsg(''); el.play.innerHTML = '&#10074;&#10074;'; if (!tvIdle()) wake(); });
v.addEventListener('pause', () => { el.play.innerHTML = '&#9654;'; if (!tvIdle()) wake(); saveResume(true); });
v.addEventListener('waiting', () => showMsg('Buffering…'));
for (const ev of ['play', 'pause', 'playing', 'volumechange']) v.addEventListener(ev, () => changed());
v.addEventListener('volumechange', () => { el.vol.value = Math.round(v.volume * 100); });
v.addEventListener('ended', () => { if (current) setResume(current.key, 0, 0); el.play.innerHTML = '&#9654;'; });
v.addEventListener('error', () => {
  if (hls || !current) return; // hls.js reports its own errors
  const code = v.error?.code;
  if (TV_APP && nativeStage < 2 && looksHls(current.stream.url, current.stream.mime)) {
    nativeErr = code || 0;
    // the proxy resolves redirectors and serves the playlist with the HLS type, which the
    // native player may need; if that fails too, use hls.js
    const viaProxy = nativeStage === 0 && getProxy() && !current.stream.proxy;
    nativeStage = viaProxy ? 1 : 2;
    const stream = viaProxy ? { ...current.stream, proxy: true, m3u8Name: true } : current.stream;
    attach(stream).then(() => v.play().catch(() => {})).catch(e => showMsg(e.message));
    return;
  }
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
el.route.addEventListener('click', () => { toggleStats(); wake(); });
el.stats.addEventListener('click', () => toggleStats(false));
el.pip.addEventListener('click', () => { (inPip() ? exitPip() : enterPip(true)); wake(); });
// Going back to the app from the floating window: some browsers pause the video on the way.
// If it was playing and the app is visible again (not closed with the window's ✕), carry on.
let pipLeftAt = 0, pausedAt = 0, wasInPip = false;
v.addEventListener('pause', () => { pausedAt = Date.now(); });
function resumeAfterPip() {
  const now = Date.now();
  if (document.visibilityState !== 'visible' || !isOpen() || casting || !v.paused) return;
  if (now - pipLeftAt < 2500 && now - pausedAt < 2500) v.play().catch(() => {});
}
function pipChanged() {
  const on = inPip();
  el.pip.classList.toggle('active', on);
  if (wasInPip && !on) { pipLeftAt = Date.now(); setTimeout(resumeAfterPip, 300); setTimeout(resumeAfterPip, 1200); }
  wasInPip = on;
}
v.addEventListener('enterpictureinpicture', pipChanged);
v.addEventListener('leavepictureinpicture', pipChanged);
v.addEventListener('webkitpresentationmodechanged', pipChanged);
// Leaving the app (home button, app switcher) while a video plays: try to keep it in a floating
// window. Safari does this by itself (autopictureinpicture); Chrome allows it only in some cases.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') setTimeout(resumeAfterPip, 200);
  if (document.visibilityState === 'hidden' && isOpen() && !casting && !current?.audio && !v.paused && !inPip()) enterPip();
});
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
  const onBackground = !e.target.closest('.player-top, .player-bottom, .player-channels, .player-epg, .player-sync');
  // Swipes that start near the screen edges are the system's (home bar, notifications, back): ignore them.
  const H = innerHeight, W = innerWidth, edgeY = Math.max(64, H * 0.15), edgeX = 32;
  const inEdge = e.clientY < edgeY || e.clientY > H - edgeY || e.clientX < edgeX || e.clientX > W - edgeX;
  swipe = channels && e.pointerType === 'touch' && onBackground && !inEdge ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
}, { capture: true, passive: true });
el.root.addEventListener('pointerup', (e) => {
  const s = swipe; swipe = null;
  if (!s || !channels || document.visibilityState !== 'visible') return;
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
  // automatic full screen got lost (back from the floating window, back gesture…): a tap restores it
  if (lastPointer === 'touch' && autoFullscreen()) { wake(); return; }
  if (!el.syncBox.hidden) { closeSync(); return; }
  if (!el.panel.hidden) { closePanel(); return; }
  if (!el.epg.hidden) { closeInfo(); return; }
  const hidden = el.ui.classList.contains('idle');
  if (lastPointer === 'mouse') { if (hidden) wake(); else togglePlay(); return; }
  if (hidden) wake(); else hideControls();
}
el.root.querySelector('.player-stage').addEventListener('click', onBackgroundTap);
el.ui.addEventListener('click', (e) => { if (e.target === el.ui) onBackgroundTap(); });
window.addEventListener('pagehide', () => saveResume(true));

// ---------------------------------------------------------------- phone remote (remote-host.js)
// What the phone shows and the commands it sends. The remote only calls these functions, so it
// behaves exactly like the buttons on screen.
const changeListeners = new Set();
let changeTimer = 0, listVersion = 0, lastList = null;
/** Calls fn when what the remote shows changes (list = the channel list changed too). */
export const onChange = (fn) => { changeListeners.add(fn); return () => changeListeners.delete(fn); };
function changed(soon = false) {
  if (!changeListeners.size) return;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const list = channels?.list || null;
    if (list !== lastList) { lastList = list; listVersion++; }
    for (const fn of changeListeners) { try { fn(); } catch (e) { console.warn(e); } }
  }, soon ? 0 : 120);
}

// iPhone/iPad: a web page can't change the volume (only the device buttons can)
const VOLUME_FIXED = (() => { try { const a = document.createElement('audio'); a.volume = 0.5; return a.volume !== 0.5; } catch { return true; } })();

let remoteActive = false;
let unmuteOnTouch = false;
/** The remote opened a channel while nobody touched this screen: the browser may refuse sound. */
function mutedFallback(err) {
  if (!remoteActive || !err || err.name !== 'NotAllowedError' || el.video.muted) return false;
  el.video.muted = true;
  unmuteOnTouch = true;
  el.video.play().then(() => showMsg('Il browser ha tolto l\'audio: tocca lo schermo una volta per riattivarlo', 6000)).catch(() => showMsg('Tocca ▶ per avviare'));
  changed();
  return true;
}
document.addEventListener('pointerdown', () => { if (unmuteOnTouch) { unmuteOnTouch = false; el.video.muted = false; } }, true);
document.addEventListener('keydown', (e) => { if (unmuteOnTouch && e.isTrusted) { unmuteOnTouch = false; el.video.muted = false; } }, true);
export function setRemoteActive(on) { remoteActive = !!on; }

/** The player as the remote shows it. */
export function remoteState() {
  if (!isOpen() || !current) return { open: false, volume: Math.round(el.video.volume * 100), muted: el.video.muted, volFixed: VOLUME_FIXED, fs: !!fsElement() };
  const v = el.video, it = current.item;
  const idx = pendingIndex >= 0 ? pendingIndex : channels ? channels.index : -1;
  const shown = idx >= 0 && channels ? channels.list[idx].item : it;
  const live = isLive();
  const w = live ? liveWindow() : null;
  return {
    open: true, label: shown.label, number: idx >= 0 && channels ? chNumber(shown, idx) : '', index: idx, listVersion: channels ? listVersion : 0,
    thumb: /^https:\/\//.test(shown.thumb || '') ? shown.thumb : '', live: !!live, audio: !!current.audio,
    guide: shown.live ? { id: shown.guide?.id || '', name: shown.guide?.name || '', key: shown.key || '' } : null,
    paused: casting ? false : v.paused, casting, volume: Math.round(v.volume * 100), muted: v.muted, volFixed: VOLUME_FIXED || casting,
    pos: live ? (w ? Math.round(v.currentTime - w.end) : 0) : Math.round(v.currentTime || 0), dur: live ? 0 : Math.round(v.duration || 0),
    canSeek: !live || !!w, av: avMs, avBlocked: current.audio ? 'Solo per i video.' : avBlocked(), fs: !!fsElement(),
  };
}

/** The channels the player can zap through (for the phone's list), or null. */
export function remoteChannels() {
  if (!channels || !isOpen()) return null;
  return { version: listVersion, items: channels.list.map((c, i) => remoteItem(c.item, chNumber(c.item, i))) };
}
export const remoteItem = (it, number) => ({ label: it.label, number: String(number ?? ''), key: it.key || '', live: !!it.live, guide: it.guide ? { id: it.guide.id || '', name: it.guide.name || '' } : undefined });

/** The remote picked channel i of the player's list. */
export function tuneTo(i) {
  if (!channels || !(i >= 0 && i < channels.list.length)) return false;
  closePanel();
  if (i === channels.index && pendingIndex < 0) return true;
  pendingIndex = i; showOsd(i); clearTimeout(zapTimer); tune(i); changed();
  return true;
}
export function setVolume(pct) {
  if (casting) return;
  const v = el.video;
  v.volume = Math.max(0, Math.min(100, Math.round(pct))) / 100;
  if (v.volume > 0 && v.muted) { v.muted = false; unmuteOnTouch = false; }
  if (isOpen()) wake();
}
export function toggleMute() { el.video.muted = !el.video.muted; unmuteOnTouch = false; }
export function avStep(dir) { if (current && !avBlocked()) setAv(avMs + Math.sign(dir) * AV_STEP); }
export function avReset() { setAv(0); }
export function toggleSync() { if (el.syncBox.hidden) openSync(); else closeSync(); }
export function typeNumber(num) { return jumpTo(parseInt(num, 10)); }

// Full screen from the phone. Browsers only allow entering full screen right after a tap or a
// key on this screen (leaving is always allowed), so when the request is refused the next tap
// or key here enters it. The whole page goes full screen, so it stays so between videos.
let remoteFs = false, fsArmed = false;
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function enterPageFs() {
  const d = document.documentElement;
  const req = d.requestFullscreen ? d.requestFullscreen({ navigationUI: 'hide' }) : d.webkitRequestFullscreen ? Promise.resolve(d.webkitRequestFullscreen()) : Promise.reject(new Error('no'));
  return req.then(() => { remoteFs = true; });
}
function armFs(on) {
  fsArmed = on;
  const box = document.getElementById('fs-hint');
  if (box) box.hidden = !on;
}
function fsOnTouch(e) {
  if (!fsArmed || !e.isTrusted) return;
  armFs(false);
  if (!fsElement()) enterPageFs().catch(() => {});
}
document.addEventListener('pointerdown', fsOnTouch, true);
document.addEventListener('keydown', fsOnTouch, true);
/** Resolves to 'on', 'off' or 'blocked' (the browser wants a tap on this screen first). */
export async function remoteFullscreen() {
  if (fsElement()) {
    armFs(false);
    await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return 'off';
  }
  if (fsArmed) { armFs(false); return 'off'; } // second press: cancel the pending request
  try { await enterPageFs(); return 'on'; } catch { armFs(true); setTimeout(() => armFs(false), 20000); return 'blocked'; }
}
export const isFullscreen = () => !!fsElement();

// the phone's OK opened the controls ("menu"); cleared when they hide again
let remoteMenu = false;
new MutationObserver(() => { if (el.ui.classList.contains('idle')) remoteMenu = false; }).observe(el.ui, { attributes: true, attributeFilter: ['class'] });
