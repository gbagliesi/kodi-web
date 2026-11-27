// Detached windows («Stacca»): a video (or a radio) goes on in a small window over the page, so
// the rest of the app stays usable, and several can play together (multi-view).
// - drag by the title bar, resize from the corner (the video keeps 16:9); double-click = big player
// - the sound is on one only: the last chosen (🔊 here, or the big player)
// - Chrome: «fuori dal browser» moves the window to a system window always on top
//   (Document Picture-in-Picture; elsewhere the video's own picture-in-picture)
// - how many: computer 4, tablet 2, phone 1 (a mini player); none on the TV (body.tv)
// Each window plays its own copy of the stream: one through the proxy counts like a viewer more.
import * as player from './player.js';
import { setResume } from './storage.js';

const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
const coarse = () => matchMedia('(pointer: coarse)').matches;
const isPhone = () => coarse() && Math.min(screen.width, screen.height) < 600;
export const maxWindows = () => isPhone() ? 1 : coarse() ? 2 : 4;

const wins = [];
let seq = 0, zTop = 1;
let layer = null, dock = null;

function ensureLayer() {
  if (layer) return layer;
  layer = document.createElement('div');
  layer.id = 'fw-layer';
  layer.className = 'fw-layer';
  dock = document.createElement('div');
  dock.className = 'fw-dock';
  dock.hidden = true;
  dock.append(btn('▦ Affianca', 'Disponi le finestre una accanto all\'altra', tile), btn('✕ Chiudi tutte', 'Chiudi tutte le finestre staccate', closeAll));
  layer.append(dock);
  document.body.append(layer);
  return layer;
}

function btn(html, title, onClick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'fw-btn ' + cls;
  b.innerHTML = html;
  b.title = title; b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
  b.addEventListener('dblclick', (e) => e.stopPropagation());
  return b;
}

function loadHls() {
  if (window.Hls) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = HLS_CDN; s.onload = res; s.onerror = () => rej(new Error('hls.js non caricato'));
    document.head.append(s);
  });
}

const vw = () => document.documentElement.clientWidth, vh = () => window.innerHeight;
const bar = () => coarse() ? 40 : 34;

function place(w, x, y, width) {
  const minW = w.audio ? 220 : isPhone() ? 160 : 220;
  width = Math.max(minW, Math.min(width, vw() - 8));
  const height = w.audio ? bar() + 46 : Math.round(width * 9 / 16) + bar();
  x = Math.max(4 - width + 80, Math.min(x, vw() - 80));
  y = Math.max(4, Math.min(y, vh() - bar()));
  Object.assign(w.el.style, { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px' });
  w.x = x; w.y = y; w.w = width;
}

function defaultSpot(audio) {
  const width = audio ? 300 : isPhone() ? Math.round(vw() * 0.55) : coarse() ? 360 : 400;
  const height = audio ? bar() + 46 : Math.round(width * 9 / 16) + bar();
  // top right, under the app's bar and the big player's title (its controls are at the bottom);
  // the next ones beside them to the left, then a row lower
  const n = wins.length;
  const cols = Math.max(1, Math.floor((vw() - 200) / (width + 12)));
  const c = n % cols, r = Math.floor(n / cols) % 3;
  return { x: vw() - (c + 1) * (width + 12) - 4, y: 72 + r * (height + 12), width };
}

function focusWin(w) { w.el.style.zIndex = String(++zTop); }

function setAudio(w, on, claim = true) {
  w.video.muted = !on;
  w.audioBtn.innerHTML = on ? '&#128266;' : '&#128263;';
  w.audioBtn.title = on ? 'Audio attivo su questa finestra (tocca per toglierlo)' : 'Senti questa finestra (le altre si zittiscono)';
  w.el.classList.toggle('has-audio', on);
  if (on && claim) document.dispatchEvent(new CustomEvent('salotto-audio', { detail: { from: w.id, label: w.item.label } }));
}

// somebody else took the sound
document.addEventListener('salotto-audio', (e) => {
  for (const w of wins) if (w.id !== e.detail.from && !w.video.muted) setAudio(w, false, false);
});

function showMsg(w, text) { w.msg.textContent = text; w.msg.hidden = !text; }

async function attach(w, info) {
  const v = w.video;
  if (info.useHls) {
    try { await loadHls(); } catch (e) { showMsg(w, e.message); return; }
    if (window.Hls?.isSupported()) {
      w.hls = new window.Hls({ enableWorker: true, lowLatencyMode: !!info.live });
      w.hls.on(window.Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) { w.hls.recoverMediaError(); return; }
        showMsg(w, 'Errore di riproduzione: riporta il video nel lettore (⤢)');
      });
      w.hls.loadSource(info.url);
      w.hls.attachMedia(v);
    } else v.src = info.url;
  } else v.src = info.url;
  if (info.time > 1) v.addEventListener('loadedmetadata', () => { try { v.currentTime = info.time; } catch { /* ignore */ } }, { once: true });
  if (info.paused) return;
  try { await v.play(); } catch (err) {
    // the browser refuses the sound outside a tap: go on without it, 🔇 lets the viewer turn it on
    if (err?.name === 'NotAllowedError' && !v.muted) { setAudio(w, false, false); v.play().catch(() => showMsg(w, 'Tocca per avviare')); }
  }
}

function saveResume(w) {
  if (w.live || !isFinite(w.video.duration)) return;
  setResume(w.key, w.video.currentTime, w.video.duration);
}

function destroy(w) {
  saveResume(w);
  if (w.pipWin) { try { w.pipWin.close(); } catch { /* ignore */ } }
  try { if (document.pictureInPictureElement === w.video) document.exitPictureInPicture().catch(() => {}); } catch { /* ignore */ }
  w.video.pause();
  if (w.hls) { w.hls.destroy(); w.hls = null; }
  w.video.removeAttribute('src'); w.video.load();
  w.el.remove();
  wins.splice(wins.indexOf(w), 1);
  updateDock();
}

export function closeAll() { for (const w of [...wins]) destroy(w); }
export const count = () => wins.length;
/** Some detached window is playing (counted as watching time in the access log). */
export const anyPlaying = () => wins.some(w => !w.video.paused && !w.video.ended && w.video.readyState > 2);
/** …and one of them comes through the proxy. */
export const anyProxyPlaying = () => wins.some(w => w.proxied && !w.video.paused && !w.video.ended && w.video.readyState > 2);

function updateDock() {
  if (!dock) return;
  dock.hidden = wins.length < 2 || isPhone();
}

/** Side by side over the whole window, as big as they fit. */
export function tile() {
  const vids = wins.filter(w => !w.audio && !w.pipWin);
  const radios = wins.filter(w => w.audio && !w.pipWin);
  const top = 8, bottom = radios.length ? bar() + 56 : 0;
  const n = vids.length;
  if (n) {
    const W = vw() - 16, H = vh() - top - bottom - 50;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const width = Math.min(W / cols - 8, ((H / rows) - 8 - bar()) * 16 / 9);
      if (!best || width > best.width) best = { cols, rows, width };
    }
    const cellW = W / best.cols, cellH = (vh() - top - bottom - 50) / best.rows;
    vids.forEach((w, i) => {
      const c = i % best.cols, r = Math.floor(i / best.cols);
      const width = Math.floor(best.width);
      const height = Math.round(width * 9 / 16) + bar();
      place(w, 8 + c * cellW + (cellW - width) / 2, top + r * cellH + (cellH - height) / 2, width);
    });
  }
  radios.forEach((w, i) => place(w, 8 + i * 316, vh() - bar() - 54, 300));
}

// ---------------------------------------------------------------- dragging and resizing
function dragger(w, handle, onMove) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.fw-btn') || w.pipWin) return;
    e.preventDefault();
    focusWin(w);
    const start = { px: e.clientX, py: e.clientY, x: w.x, y: w.y, w: w.w };
    handle.setPointerCapture(e.pointerId);
    w.el.classList.add('dragging');
    const move = (ev) => onMove(start, ev.clientX - start.px, ev.clientY - start.py);
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); w.el.classList.remove('dragging'); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

// ---------------------------------------------------------------- out of the browser
async function popOut(w) {
  if (w.pipWin) { w.pipWin.close(); return; }
  if (window.documentPictureInPicture?.requestWindow) {
    try {
      const height = w.audio ? bar() + 46 : Math.round(w.w * 9 / 16) + bar();
      const pw = await window.documentPictureInPicture.requestWindow({ width: Math.round(w.w), height });
      for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
        const l = pw.document.createElement('link'); l.rel = 'stylesheet'; l.href = link.href; pw.document.head.append(l);
      }
      pw.document.body.className = 'fw-pipbody';
      pw.document.title = w.item.label;
      w.pipWin = pw;
      w.el.classList.add('in-pip');
      pw.document.body.append(w.el);
      pw.addEventListener('pagehide', () => {
        w.pipWin = null;
        w.el.classList.remove('in-pip');
        if (wins.includes(w)) { ensureLayer().append(w.el); place(w, w.x, w.y, w.w); if (!w.video.paused) w.video.play().catch(() => {}); }
      }, { once: true });
      if (!w.video.paused) w.video.play().catch(() => {});
      return;
    } catch (e) { console.warn('document pip', e); }
  }
  try {
    if (document.pictureInPictureElement === w.video) await document.exitPictureInPicture();
    else if (w.video.requestPictureInPicture) await w.video.requestPictureInPicture();
    else if (w.video.webkitSetPresentationMode) w.video.webkitSetPresentationMode('picture-in-picture');
  } catch { showMsg(w, 'Finestra di sistema non disponibile qui'); setTimeout(() => showMsg(w, ''), 3000); }
}
const canPopOut = (audio) => !!window.documentPictureInPicture?.requestWindow || (!audio && (document.pictureInPictureEnabled || typeof HTMLVideoElement.prototype.webkitSetPresentationMode === 'function'));

// ---------------------------------------------------------------- back into the big player
function expand(w) {
  const info = { item: w.item, stream: w.stream, favEntry: w.favEntry, channels: w.channels };
  saveResume(w);
  const spot = { x: w.x, y: w.y, width: w.w };
  // the big player has something on: it takes this window's place (a swap)
  const other = player.detachInfo();
  destroy(w);
  if (other) open(other, spot, false);
  player.play(info.item, info.stream, { favEntry: info.favEntry, channels: info.channels || undefined });
}

/** A new window for this video (from player.detachInfo()). */
export function open(info, spot = null, withAudio = !info.muted) {
  ensureLayer();
  while (wins.length >= maxWindows()) destroy(wins[0]); // the oldest gives way
  const id = 'fw' + (++seq);
  const root = document.createElement('div');
  root.className = 'fw' + (info.audio ? ' fw-audio' : '');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Finestra: ' + info.item.label);
  const bar = document.createElement('div'); bar.className = 'fw-bar';
  const title = document.createElement('span'); title.className = 'fw-title'; title.textContent = info.item.label; title.title = info.item.label;
  const stage = document.createElement('div'); stage.className = 'fw-stage';
  const video = document.createElement('video');
  video.playsInline = true; video.setAttribute('webkit-playsinline', ''); video.preload = 'auto';
  if (!info.audio && (info.item.fanart || info.item.thumb)) video.poster = info.item.fanart || info.item.thumb;
  const msg = document.createElement('div'); msg.className = 'fw-msg'; msg.hidden = true;
  const w = { id, el: root, video, msg, item: info.item, stream: info.stream, favEntry: info.favEntry, channels: info.channels, key: info.key,
    live: info.live, audio: !!info.audio, proxied: !!info.proxied, hls: null, pipWin: null, x: 0, y: 0, w: 0 };
  w.audioBtn = btn('&#128266;', '', () => setAudio(w, w.video.muted), 'fw-sound');
  const playBtn = btn('&#10074;&#10074;', 'Pausa / riproduci', () => (video.paused ? video.play().catch(() => {}) : video.pause()), 'fw-play');
  video.addEventListener('play', () => { playBtn.innerHTML = '&#10074;&#10074;'; });
  video.addEventListener('pause', () => { playBtn.innerHTML = '&#9654;'; saveResume(w); });
  video.addEventListener('playing', () => showMsg(w, ''));
  video.addEventListener('waiting', () => showMsg(w, '…'));
  if (info.proxied) { const b = document.createElement('span'); b.className = 'fw-proxy'; b.textContent = 'Proxy'; b.title = 'Questa finestra passa dal tuo proxy: conta nella quota'; bar.append(b); }
  bar.prepend(title);
  bar.append(playBtn, w.audioBtn);
  if (canPopOut(w.audio)) bar.append(btn('<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 11h-8v6h8v-6zm4 8V5a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2zm-2 0H3V5h18v14z"/></svg>', 'Fuori dal browser (finestra sempre in primo piano)', () => popOut(w), 'fw-pop'));
  bar.append(btn('&#10530;', 'Riporta nel lettore grande', () => expand(w), 'fw-expand'), btn('&#10005;', 'Chiudi', () => destroy(w), 'fw-close'));
  stage.append(video, msg);
  if (info.audio) {
    const art = document.createElement('img'); art.className = 'fw-art'; art.alt = ''; art.src = info.item.thumb || 'icons/icon.svg';
    stage.prepend(art);
  }
  const grip = document.createElement('div'); grip.className = 'fw-grip'; grip.title = 'Trascina per ridimensionare';
  root.append(bar, stage, grip);
  layer.append(root);
  wins.push(w);
  focusWin(w);
  const s = spot || defaultSpot(w.audio);
  place(w, s.x, s.y, s.width);
  dragger(w, bar, (st, dx, dy) => place(w, st.x + dx, st.y + dy, st.w));
  dragger(w, grip, (st, dx) => place(w, st.x, st.y, st.w + dx));
  root.addEventListener('pointerdown', () => focusWin(w));
  stage.addEventListener('click', () => { if (video.paused) video.play().catch(() => {}); else if (video.muted && !w.audio) setAudio(w, true); });
  stage.addEventListener('dblclick', () => expand(w));
  setAudio(w, withAudio, withAudio);
  updateDock();
  attach(w, info);
  return w;
}

/** «Stacca» in the big player: the video goes on in a window, the player closes. */
export function detachCurrent() {
  const info = player.detachInfo();
  if (!info) return;
  player.close();
  open(info);
}

// keep the windows on screen when the browser window changes size; with the big player full
// screen (only that element is shown) the windows move inside it, so they stay visible
addEventListener('resize', () => { for (const w of wins) if (!w.pipWin) place(w, w.x, w.y, w.w); });
function onFs() {
  if (!layer) return;
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const host = fs && fs !== document.documentElement && fs !== document.body ? fs : document.body;
  if (layer.parentNode !== host) host.append(layer);
}
document.addEventListener('fullscreenchange', onFs);
document.addEventListener('webkitfullscreenchange', onFs);

document.getElementById('pl-detach')?.addEventListener('click', (e) => { e.stopPropagation(); detachCurrent(); });
