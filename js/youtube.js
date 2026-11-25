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
let player = null;     // YT.Player
let current = null;    // { item, yt, favEntry, key }
let apiPromise = null;
let barTimer = 0, saveTimer = 0, errorShown = false;
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
  stage = h('div', { class: 'yt-stage' }, h('div', { id: 'yt-frame' }));
  msg = h('div', { class: 'yt-msg', id: 'yt-msg', hidden: true });
  root = h('div', { class: 'yt-player', id: 'yt-player', tabindex: '-1', hidden: true }, bar, stage, msg);
  document.body.append(root);
  // a click on the video moves the focus into YouTube's frame: on TV the remote must keep
  // talking to Salotto, so take it back
  window.addEventListener('blur', () => {
    if (!isOpen() || !TV()) return;
    setTimeout(() => { if (document.activeElement?.tagName === 'IFRAME') { document.activeElement.blur(); root.focus({ preventScroll: true }); } }, 0);
  });
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
  root.classList.remove('bar-hidden');
  clearTimeout(barTimer);
  if (TV()) barTimer = setTimeout(hideBar, 6000);
  if (focus) closeBtn.focus({ preventScroll: true });
}
function hideBar() {
  if (!TV()) return;
  clearTimeout(barTimer);
  root.classList.add('bar-hidden');
  if (bar.contains(document.activeElement)) root.focus({ preventScroll: true });
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
      onReady: (ev) => { try { ev.target.playVideo(); } catch { /* autoplay blocked: YouTube shows ▶ */ } },
      onError: (ev) => {
        if (errorShown) return;
        errorShown = true;
        showMsg((ERRORS[ev.data] || 'YouTube non riesce a riprodurre questo video (errore ' + ev.data + ').') + ' Puoi guardarlo su YouTube.', true);
      },
      onStateChange: (ev) => { if (ev.data === 2 || ev.data === 0) save(); },
    },
  });
  const iframe = stage.querySelector('iframe');
  if (iframe) { iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen'); iframe.setAttribute('tabindex', TV() ? '-1' : '0'); }
  clearInterval(saveTimer);
  saveTimer = setInterval(save, 10000);
}

function teardown() {
  save();
  clearInterval(saveTimer);
  clearTimeout(barTimer);
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
  if (TV() && !root.classList.contains('bar-hidden') && msg.hidden) { hideBar(); return; }
  close();
}

export function togglePlay() {
  if (!player?.getPlayerState) return;
  const st = player.getPlayerState();
  if (st === 1 || st === 3) player.pauseVideo(); else player.playVideo();
}

export function skip(s) {
  if (!player?.getCurrentTime || current?.yt.live) return;
  player.seekTo(Math.max(0, (player.getCurrentTime() || 0) + s), true);
}

/** Keys while the player is open. Returns true when handled. */
export function handleKey(e) {
  if (!isOpen()) return false;
  const k = e.key;
  const inBar = bar.contains(document.activeElement) && !root.classList.contains('bar-hidden');
  const inMsg = !msg.hidden && msg.contains(document.activeElement);
  if (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack' || k === 'GoBack') { back(); return true; }
  if (k === 'MediaPlayPause' || k === 'MediaPlay' || k === 'MediaPause' || (k === ' ' && !inBar)) { togglePlay(); return true; }
  if (k === 'MediaTrackNext' || k === 'MediaFastForward') { if (current?.yt.playlist) player?.nextVideo?.(); else skip(30); return true; }
  if (k === 'MediaTrackPrevious' || k === 'MediaRewind') { if (current?.yt.playlist) player?.previousVideo?.(); else skip(-30); return true; }
  if (inBar || inMsg) {
    if (TV()) showBar(false); // keep it up while moving in it
    if (k === 'ArrowDown' && inBar && TV()) { hideBar(); return true; }
    return false; // arrows move between the buttons (spatial navigation), Enter presses
  }
  if (k === 'Enter') { togglePlay(); return true; }
  if (k === 'ArrowLeft') { skip(-10); return true; }
  if (k === 'ArrowRight') { skip(10); return true; }
  if (k === 'ArrowUp') { showBar(true); return true; }
  if (k === 'ArrowDown') { if (TV()) hideBar(); return true; }
  return false;
}

/** For the spatial navigation: the part of the screen the arrows move in. */
export const navScope = () => (isOpen() ? (!msg.hidden ? msg : bar) : null);

/** Lets the app tell an item playable here from its fields (the add-on sets item.youtube). */
export const ytOf = (it) => (it && it.youtube && (it.youtube.video || it.youtube.playlist) ? it.youtube : null);
