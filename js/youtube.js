// YouTube videos play in YouTube's official embedded player (IFrame Player API), as YouTube
// allows: ads, captions and quality are YouTube's own. Salotto only adds a thin bar (close,
// favourite, open on YouTube) and drives the player from the keyboard / TV remote:
// OK = play/pause, ◀▶ = −/+10 s, ▲ = bar, Back = close (first the bar on TV).
import { getResume, setResume, getSettings, isFavourite, toggleFavourite } from './storage.js';

const API_URL = 'https://www.youtube.com/iframe_api';
const ERRORS = {
  2: 'Indirizzo del video non valido.',
  5: 'Questo video non si riesce a riprodurre qui.',
  100: 'Video non trovato: forse è stato rimosso o è privato.',
  101: 'Chi l\'ha pubblicato non permette di guardarlo fuori da YouTube.',
  150: 'Chi l\'ha pubblicato non permette di guardarlo fuori da YouTube.',
  152: 'YouTube non accetta il lettore incorporato da qui.',
  153: 'YouTube non accetta il lettore incorporato da qui.',
};

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};

let root, bar, title, favBtn, extBtn, closeBtn, msg, stage;
let ctrl, playBtn, prevBtn, nextBtn, rewBtn, fwdBtn, rateBtn, ccBtn, seekFill, curTxt, durTxt, menu;
let player = null;     // YT.Player
let current = null;    // { item, yt, favEntry, key }
let apiPromise = null;
let barTimer = 0, saveTimer = 0, tickTimer = 0, peekTimer = 0, errorShown = false;
let seekTarget = null, seekAt = 0, seekRun = 0; // quick ◀▶ presses add up
let ccTrack = '';      // language code of the captions shown, '' = off
let returnFocus = null;
const TV = () => document.body.classList.contains('tv');

export const isOpen = () => !!root && !root.hidden;

function build() {
  if (root) return;
  closeBtn = h('button', { class: 'icon-btn focusable', id: 'yt-close', 'aria-label': 'Chiudi', onclick: () => close() }, '✕');
  title = h('div', { class: 'yt-title', id: 'yt-title' });
  favBtn = h('button', { class: 'icon-btn focusable', id: 'yt-fav', 'aria-label': 'Preferito', onclick: () => { if (current?.favEntry) { toggleFavourite(current.favEntry); updateFav(); } } }, '☆');
  extBtn = h('button', { class: 'btn focusable', id: 'yt-ext', 'aria-label': 'Apri su YouTube', onclick: () => openOnYoutube() }, h('span', { class: 'yt-ext-long' }, 'Apri su '), 'YouTube ↗');
  bar = h('div', { class: 'yt-bar', id: 'yt-bar' }, closeBtn, title, favBtn, extBtn);
  // TV: Salotto's own controls (the remote can't reach the buttons inside YouTube's frame)
  const btn = (id, label, text, fn) => h('button', { class: 'icon-btn focusable', id, 'aria-label': label, title: label, onclick: fn }, text);
  prevBtn = btn('yt-prev', 'Video precedente', '⏮', () => player?.previousVideo?.());
  rewBtn = btn('yt-rew', 'Indietro 10 secondi', '⟲', () => skip(-10, false));
  playBtn = btn('yt-play', 'Riproduci / pausa', '⏸', () => togglePlay());
  fwdBtn = btn('yt-fwd', 'Avanti 10 secondi', '⟳', () => skip(10, false));
  nextBtn = btn('yt-next', 'Video successivo', '⏭', () => player?.nextVideo?.());
  rateBtn = h('button', { class: 'btn focusable', id: 'yt-rate', onclick: () => rateMenu() }, 'Velocità 1×');
  ccBtn = h('button', { class: 'btn focusable', id: 'yt-cc', onclick: () => ccMenu() }, 'Sottotitoli');
  seekFill = h('div', { class: 'yt-seek-fill' });
  curTxt = h('span', { id: 'yt-cur' }, '0:00');
  durTxt = h('span', { id: 'yt-dur' }, '');
  ctrl = h('div', { class: 'yt-ctrl', id: 'yt-ctrl' },
    h('div', { class: 'yt-seek-row' }, curTxt, h('div', { class: 'yt-seek' }, seekFill), durTxt),
    h('div', { class: 'yt-btn-row' }, prevBtn, rewBtn, playBtn, fwdBtn, nextBtn, h('div', { class: 'spacer' }), ccBtn, rateBtn));
  menu = h('div', { class: 'yt-menu', id: 'yt-menu', hidden: true });
  stage = h('div', { class: 'yt-stage' }, h('div', { id: 'yt-frame' }));
  msg = h('div', { class: 'yt-msg', id: 'yt-msg', hidden: true });
  root = h('div', { class: 'yt-player', id: 'yt-player', tabindex: '-1', hidden: true }, bar, stage, ctrl, menu, msg);
  document.body.append(root);
  // a click on the video moves the focus into YouTube's frame: on TV the remote must keep
  // talking to Salotto, so take it back
  window.addEventListener('blur', () => {
    if (!isOpen() || !TV()) return;
    setTimeout(takeFocusBack, 0);
  });
}

function takeFocusBack() {
  if (isOpen() && TV() && document.activeElement?.tagName === 'IFRAME') { document.activeElement.blur(); root.focus({ preventScroll: true }); }
}

const fmt = (t) => {
  t = Math.max(0, Math.floor(t || 0));
  const hh = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const rateLabel = (r) => String(r).replace('.', ',') + '×';

// Time, progress, play state: refreshed while the controls are on screen
function tick() {
  if (!isOpen()) return;
  takeFocusBack();
  if (!player?.getCurrentTime) return;
  let t = 0, d = 0, st = -1, r = 1;
  try { t = player.getCurrentTime() || 0; d = player.getDuration() || 0; st = player.getPlayerState(); r = player.getPlaybackRate?.() || 1; } catch { return; }
  if (seekTarget != null && Date.now() - seekAt < 1500) t = seekTarget;
  const live = !!current?.yt.live || !isFinite(d) || d <= 0;
  curTxt.textContent = live ? '' : fmt(t);
  durTxt.textContent = live ? (current?.yt.live ? 'LIVE' : '') : fmt(d);
  seekFill.style.width = live ? '0%' : Math.min(100, t / d * 100) + '%';
  playBtn.textContent = st === 1 || st === 3 ? '⏸' : '▶';
  rateBtn.textContent = 'Velocità ' + rateLabel(r);
  ccBtn.textContent = ccTrack ? 'Sottotitoli: ' + ccTrack.toUpperCase() : 'Sottotitoli';
}

function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = API_URL;
    s.async = true;
    s.onerror = () => { apiPromise = null; s.remove(); reject(new Error('Il lettore di YouTube non si carica: controlla la connessione.')); };
    document.head.append(s);
  });
  return apiPromise;
}

/**
 * Gets YouTube's player ready before a video is chosen (called when the YouTube add-on is
 * opened): connections and the IFrame API are then already there, and the video starts sooner.
 */
export function preload() {
  if (preload.done) return;
  preload.done = true;
  for (const href of ['https://www.youtube.com', 'https://www.google.com', 'https://i.ytimg.com', 'https://s.ytimg.com', 'https://yt3.ggpht.com']) {
    const l = document.createElement('link');
    l.rel = 'preconnect'; l.href = href; l.crossOrigin = '';
    document.head.append(l);
  }
  loadApi().catch(() => { preload.done = false; });
}

export const watchUrl = (yt) => yt.video ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(yt.video) + (yt.playlist ? '&list=' + encodeURIComponent(yt.playlist) : '')
  : yt.playlist ? 'https://www.youtube.com/playlist?list=' + encodeURIComponent(yt.playlist) : 'https://www.youtube.com/';

function openOnYoutube() {
  if (!current) return;
  const url = watchUrl(current.yt);
  const t = player?.getCurrentTime ? Math.floor(player.getCurrentTime() || 0) : 0;
  try { player?.pauseVideo?.(); } catch { /* not ready */ }
  window.open(url + (t > 5 && current.yt.video ? '&t=' + t + 's' : ''), '_blank', 'noopener');
}

function showMsg(text, withLink) {
  msg.replaceChildren(h('div', {}, text));
  if (withLink) msg.append(h('div', { class: 'actions' }, h('button', { class: 'btn primary focusable', onclick: () => openOnYoutube() }, 'Apri su YouTube ↗'), h('button', { class: 'btn focusable', onclick: () => close() }, 'Chiudi')));
  msg.hidden = false;
  if (withLink) msg.querySelector('.btn.primary')?.focus({ preventScroll: true });
}

function updateFav() {
  const on = !!current?.favEntry && isFavourite(current.favEntry.key);
  favBtn.textContent = on ? '★' : '☆';
  favBtn.classList.toggle('active', on);
  favBtn.hidden = !current?.favEntry;
}

// The bar: always shown on phones and computers (it sits above the video, not over it); on TV
// the video fills the screen and ▲ shows the bar for a few seconds.
function showBar(focus = false) {
  root.classList.remove('bar-hidden', 'peek');
  clearTimeout(barTimer);
  if (TV()) barTimer = setTimeout(hideBar, 8000);
  tick();
  if (focus) (TV() ? playBtn : closeBtn).focus({ preventScroll: true });
}
function hideBar() {
  if (!TV()) return;
  clearTimeout(barTimer);
  closeMenu(false);
  root.classList.add('bar-hidden');
  if (root.contains(document.activeElement) && document.activeElement !== root) root.focus({ preventScroll: true });
}
// TV: after ◀▶ with the controls hidden, the progress bar shows up for a moment (no focus)
function peek() {
  if (!TV() || !root.classList.contains('bar-hidden')) return;
  root.classList.add('peek');
  tick();
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => root.classList.remove('peek'), 2500);
}

// ---------------------------------------------------------------- option menus
function openMenu(titleText, options, onPick, from) {
  menu.replaceChildren(h('div', { class: 'yt-menu-title' }, titleText),
    ...options.map(o => h('button', { class: 'row focusable' + (o.on ? ' on' : ''), onclick: () => { onPick(o.value); closeMenu(true, from); } }, (o.on ? '✓ ' : '') + o.label)));
  menu._from = from;
  menu.hidden = false;
  clearTimeout(barTimer);
  (menu.querySelector('.row.on') || menu.querySelector('.row'))?.focus({ preventScroll: true });
}
function closeMenu(refocus = true) {
  if (!menu || menu.hidden) return false;
  menu.hidden = true;
  if (refocus && menu._from?.isConnected) { menu._from.focus({ preventScroll: true }); showBar(false); }
  tick();
  return true;
}

function rateMenu() {
  if (!player?.getAvailablePlaybackRates) return;
  const cur = player.getPlaybackRate?.() || 1;
  const rates = player.getAvailablePlaybackRates() || [1];
  openMenu('Velocità di riproduzione', rates.map(r => ({ value: r, label: r === 1 ? 'Normale (1×)' : rateLabel(r), on: r === cur })), (r) => player.setPlaybackRate(r), rateBtn);
}

// Captions through the player's captions module (the tracks the video really has)
function ccTracks() {
  try { return player.getOption('captions', 'tracklist') || []; } catch { return []; }
}
async function ccMenu() {
  if (!player?.loadModule) return;
  try { player.loadModule('captions'); } catch { /* old player */ }
  let tracks = ccTracks();
  for (let i = 0; i < 10 && !tracks.length; i++) { await new Promise(r => setTimeout(r, 150)); tracks = ccTracks(); }
  if (!ccTrack) try { player.unloadModule('captions'); } catch { /* fine */ }
  const opts = [{ value: '', label: 'Spenti', on: !ccTrack },
    ...tracks.map(t => ({ value: t.languageCode, label: (t.displayName || t.languageName || t.languageCode) + (t.kind === 'asr' ? ' (automatici)' : ''), on: t.languageCode === ccTrack }))];
  if (!tracks.length) opts.push({ value: null, label: 'Questo video non ha sottotitoli' });
  openMenu('Sottotitoli', opts, setCaptions, ccBtn);
}
function setCaptions(code) {
  if (code == null) return;
  try {
    if (!code) { player.unloadModule('captions'); ccTrack = ''; return; }
    player.loadModule('captions');
    player.setOption('captions', 'track', { languageCode: code });
    ccTrack = code;
  } catch { /* the player refused */ }
}

function save() {
  if (!current || !player?.getCurrentTime || current.yt.live || !current.key) return;
  try { setResume(current.key, player.getCurrentTime(), player.getDuration()); } catch { /* not ready */ }
}

/**
 * Opens a YouTube video or playlist. yt = { video?, playlist?, live? }.
 * opts.favEntry: the favourite this item is saved as.
 */
export async function play(item, yt, opts = {}) {
  build();
  if (isOpen()) teardown();
  else returnFocus = document.activeElement;
  current = { item, yt, favEntry: opts.favEntry, key: yt.video && !yt.playlist ? 'yt:' + yt.video : '' };
  errorShown = false;
  seekTarget = null; ccTrack = '';
  menu.hidden = true;
  root.classList.remove('peek');
  root.classList.toggle('is-playlist', !!yt.playlist);
  root.classList.toggle('is-live', !!yt.live);
  title.textContent = item.label || 'YouTube';
  updateFav();
  msg.hidden = true;
  root.hidden = false;
  root.classList.toggle('bar-hidden', false);
  showBar(false);
  // the focus waits on the player itself: OK = play/pause, ▲ = the bar's buttons
  root.focus({ preventScroll: true });
  if (TV()) hideBar();
  document.body.classList.add('yt-open');
  stage.replaceChildren(h('div', { id: 'yt-frame' }));
  stage.append(h('div', { class: 'yt-loading', id: 'yt-loading' }, h('span', { class: 'spinner' }), 'Caricamento del video…'));
  const start = getSettings().autoResume && current.key ? getResume(current.key) : 0;
  let YT;
  try {
    YT = await loadApi();
  } catch (e) {
    if (isOpen()) showMsg(e.message, true);
    return;
  }
  if (!isOpen() || current?.yt !== yt) return;
  const vars = { autoplay: 1, playsinline: 1, rel: 0, hl: 'it', cc_lang_pref: 'it', origin: location.origin, enablejsapi: 1 };
  if (start) vars.start = Math.floor(start);
  if (yt.playlist) { vars.listType = 'playlist'; vars.list = yt.playlist; }
  player = new YT.Player('yt-frame', {
    width: '100%', height: '100%',
    ...(yt.video ? { videoId: yt.video } : {}),
    playerVars: vars,
    events: {
      onReady: (ev) => {
        try { ev.target.playVideo(); } catch { /* autoplay blocked: YouTube shows ▶ */ }
        // autoplay refused (iPhone, iPad): YouTube's own ▶ must be visible
        setTimeout(() => stage.querySelector('#yt-loading')?.remove(), 3000);
      },
      onError: (ev) => {
        if (errorShown) return;
        errorShown = true;
        stage.querySelector('#yt-loading')?.remove();
        showMsg((ERRORS[ev.data] || 'YouTube non riesce a riprodurre questo video (errore ' + ev.data + ').') + ' Puoi guardarlo su YouTube.', true);
      },
      onStateChange: (ev) => { if (ev.data === 1 || ev.data === 2) stage.querySelector('#yt-loading')?.remove(); if (ev.data === 2 || ev.data === 0) save(); tick(); },
    },
  });
  const iframe = stage.querySelector('iframe');
  if (iframe) { iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen'); iframe.setAttribute('tabindex', TV() ? '-1' : '0'); }
  clearInterval(saveTimer);
  saveTimer = setInterval(save, 10000);
  clearInterval(tickTimer);
  tickTimer = setInterval(() => { if (TV() && (!root.classList.contains('bar-hidden') || root.classList.contains('peek'))) tick(); else takeFocusBack(); }, 500);
}

function teardown() {
  save();
  clearInterval(saveTimer);
  clearInterval(tickTimer);
  clearTimeout(barTimer);
  clearTimeout(peekTimer);
  try { player?.destroy?.(); } catch { /* already gone */ }
  player = null;
  stage?.replaceChildren();
}

export function close() {
  if (!isOpen()) return;
  teardown();
  current = null;
  root.hidden = true;
  msg.hidden = true;
  document.body.classList.remove('yt-open');
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
  onCloseCb?.();
}

let onCloseCb = null;
export const onClose = (fn) => { onCloseCb = fn; };

/** Back (TV remote, phone remote, Esc): the error box or the bar first on TV, then close. */
export function back() {
  if (closeMenu()) return;
  if (TV() && !root.classList.contains('bar-hidden') && msg.hidden) { hideBar(); return; }
  close();
}

export function togglePlay() {
  if (!player?.getPlayerState) return;
  const st = player.getPlayerState();
  if (st === 1 || st === 3) player.pauseVideo(); else player.playVideo();
  setTimeout(tick, 100);
}

/** −/+ seconds. Quick presses add up from where the last one aimed (YouTube is still seeking). */
export function skip(s, show = true) {
  if (!player?.getCurrentTime || current?.yt.live) return;
  const now = Date.now();
  const recent = seekTarget != null && now - seekAt < 1500;
  const base = recent ? seekTarget : (player.getCurrentTime() || 0);
  const d = player.getDuration?.() || 0;
  seekTarget = Math.max(0, d > 0 ? Math.min(d - 1, base + s) : base + s);
  seekAt = now;
  player.seekTo(seekTarget, true);
  if (show) peek(); else tick();
}

/** Keys while the player is open. Returns true when handled. */
export function handleKey(e) {
  if (!isOpen()) return false;
  const k = e.key;
  const a = document.activeElement;
  const inBar = (bar.contains(a) || ctrl.contains(a)) && !root.classList.contains('bar-hidden');
  const inMsg = (!msg.hidden && msg.contains(a)) || (!menu.hidden && menu.contains(a));
  if (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack' || k === 'GoBack') { back(); return true; }
  if (k === 'MediaPlayPause' || k === 'MediaPlay' || k === 'MediaPause' || (k === ' ' && !inBar)) { togglePlay(); return true; }
  if (k === 'MediaTrackNext' || k === 'MediaFastForward') { if (current?.yt.playlist) player?.nextVideo?.(); else skip(30); return true; }
  if (k === 'MediaTrackPrevious' || k === 'MediaRewind') { if (current?.yt.playlist) player?.previousVideo?.(); else skip(-30); return true; }
  if (inBar || inMsg) {
    if (TV()) showBar(false); // keep it up while moving in it
    if (TV() && !menu.hidden) clearTimeout(barTimer); // no hiding while choosing
    return false; // arrows move between the buttons (spatial navigation), Enter presses
  }
  if (k === 'Enter') { togglePlay(); return true; }
  // held down or pressed quickly: bigger steps
  const now = Date.now();
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    seekRun = e.repeat || now - seekAt < 700 ? seekRun + 1 : 0;
    const step = seekRun >= 8 ? 60 : seekRun >= 3 ? 30 : 10;
    skip(k === 'ArrowLeft' ? -step : step);
    return true;
  }
  if (k === 'ArrowUp') { showBar(true); return true; }
  if (k === 'ArrowDown') { if (TV()) hideBar(); return true; }
  return false;
}

/** For the spatial navigation: the part of the screen the arrows move in. */
export const navScope = () => (isOpen() ? (!msg.hidden ? msg : !menu.hidden ? menu : root) : null);

/** Lets the app tell an item playable here from its fields (the add-on sets item.youtube). */
export const ytOf = (it) => (it && it.youtube && (it.youtube.video || it.youtube.playlist) ? it.youtube : null);
