// Picture zoom in the player: spread two fingers to enlarge the video (crop the black bars of
// films with bars both above and at the sides), drag with one finger to move it, double tap to
// switch between "fill the screen" and the original size. Only the <video> is transformed: the
// controls, subtitles and panels are separate layers and stay where they are.
// The zoom lasts for the current video only (play() calls reset()).

const MAX = 4;
let video = null, root = null, badge = null;
let s = 1, tx = 0, ty = 0;        // current transform (scale around the centre + offset in px)
let mode = 'none';                // 'none' | 'fill' (double tap, kept on rotation) | 'free'
const pts = new Map();            // touch pointers on the picture: id → {x, y}
let pinch = null, pan = null;     // gesture start state
let moved = false;                // the current gesture zoomed or moved: not a tap
let swallowUntil = 0;             // the click after a pinch/pan is not a tap
let lastTap = null;               // for the double tap
let badgeTimer = 0;
let enabled = () => true;

const onPicture = (t) => !t.closest('.player-top, .player-bottom, .player-channels, .player-epg, .player-sync, .player-cc, .player-msg');

/** Size of the whole picture (bars included) as drawn with object-fit: contain. */
function frame() {
  const W = root.clientWidth, H = root.clientHeight;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || !W || !H) return null;
  const k = Math.min(W / vw, H / vh);
  return { W, H, vw, vh, k, fw: vw * k, fh: vh * k };
}

function apply(animate = false) {
  const f = frame();
  if (f) {
    // never drag the picture's edge inside the screen
    const mx = Math.max(0, (f.fw * s - f.W) / 2), my = Math.max(0, (f.fh * s - f.H) / 2);
    tx = Math.max(-mx, Math.min(mx, tx));
    ty = Math.max(-my, Math.min(my, ty));
  }
  if (s <= 1.001) { s = 1; tx = 0; ty = 0; }
  video.style.transition = animate ? 'transform .25s ease' : '';
  video.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
  root.classList.toggle('zoomed', s > 1);
}

function showBadge(text) {
  if (!badge) return;
  badge.textContent = text;
  badge.hidden = false;
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => { badge.hidden = true; }, 1300);
}
const pct = () => 'Zoom ' + Math.round(s * 100) + '%';

/**
 * Where the picture really is inside the video frame (films often have black bars burnt in,
 * above and at the sides). Reads a small copy of the current frame; returns null when the
 * browser doesn't allow it (cross-origin video) or nothing sensible is found.
 */
function contentBox() {
  try {
    const w = 96, h = Math.max(8, Math.round(w * video.videoHeight / video.videoWidth));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const lum = (x, y) => { const i = (y * w + x) * 4; return 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; };
    // a row/column is a bar when almost all of it is near black (a channel logo may sit in it)
    const darkRow = (y) => { let n = 0; for (let x = 0; x < w; x++) if (lum(x, y) > 36) n++; return n < w * 0.04; };
    const darkCol = (x, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) if (lum(x, y) > 36) n++; return n < (y1 - y0) * 0.04; };
    let top = 0, bottom = h;
    while (top < h && darkRow(top)) top++;
    while (bottom > top && darkRow(bottom - 1)) bottom--;
    let left = 0, right = w;
    while (left < w && darkCol(left, top, bottom)) left++;
    while (right > left && darkCol(right - 1, top, bottom)) right--;
    // a dark scene looks like a big bar: don't trust boxes that are too small
    if (bottom - top < h * 0.35 || right - left < w * 0.35) return null;
    // keep a pixel of margin (the scaled copy blurs the edge)
    return { x0: (left + 1) / w, y0: (top + 1) / h, x1: (right - 1) / w, y1: (bottom - 1) / h };
  } catch { return null; }
}

// At most this much of the real picture may be cut off by "fill": a film on a phone held
// upright must stay whole (filling the height would leave only its middle on screen).
const MAX_CROP = 0.12;

/**
 * Enlarges the picture to fill the screen sensibly: first the black bars burnt into the film
 * are removed (when they can be found), then the picture is enlarged a little more only if
 * that cuts off no more than MAX_CROP of it at the edges.
 */
function fill(announce = true) {
  const f = frame();
  if (!f) return false;
  const b = contentBox() || { x0: 0, y0: 0, x1: 1, y1: 1 };
  const cw = (b.x1 - b.x0) * f.fw, ch = (b.y1 - b.y0) * f.fh;
  const whole = Math.min(f.W / cw, f.H / ch);   // the whole picture, without the bars
  const cover = Math.max(f.W / cw, f.H / ch);   // no black left on screen
  let ns = 1 - whole / cover <= MAX_CROP ? cover : whole;
  if (ns < 1.04) {
    if (announce) showBadge(f.H > f.W ? 'Ruota il telefono per vederlo più grande' : 'L\'immagine riempie già lo schermo');
    return false;
  }
  const cx = ((b.x0 + b.x1) / 2 - 0.5) * f.fw, cy = ((b.y0 + b.y1) / 2 - 0.5) * f.fh;
  s = Math.min(MAX, ns); tx = -cx * s; ty = -cy * s;
  mode = 'fill';
  apply(true);
  if (announce) showBadge('Schermo pieno');
  return true;
}

/** Back to the original size. */
export function reset(animate = false) {
  s = 1; tx = 0; ty = 0; mode = 'none';
  pinch = pan = null; pts.clear(); lastTap = null;
  if (video) apply(animate);
}

/** Double tap / Z key: fill the screen ⇄ original size. */
export function toggle() {
  if (!enabled()) return;
  if (s > 1) { reset(true); showBadge('Dimensioni originali'); } else fill();
}

export const zoomed = () => s > 1;
/** True right after a pinch or a drag of the picture: the following click is not a tap. */
export const swallowClick = () => Date.now() < swallowUntil;
/** A gesture with two fingers, or with one finger on an enlarged picture, belongs to the zoom. */
export const busy = () => !!pinch || !!pan || pts.size > 1 || s > 1 || swallowClick();

function startPinch() {
  const [a, b] = [...pts.values()];
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s, tx, ty };
  pan = null;
}

function centre() { const r = root.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }

export function init(opts) {
  video = opts.video; root = opts.root;
  enabled = opts.enabled || enabled;
  badge = document.createElement('div');
  badge.className = 'player-zoom';
  badge.hidden = true;
  root.appendChild(badge);

  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !enabled() || !onPicture(e.target)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { moved = false; pan = s > 1 ? { x: e.clientX, y: e.clientY, tx, ty } : null; pinch = null; }
    if (pts.size === 2) { startPinch(); moved = true; }
  }, { capture: true, passive: true });

  root.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const { cx, cy } = centre();
      const ns = Math.max(1, Math.min(MAX, pinch.s * d / pinch.d));
      // the point under the fingers stays under the fingers (and follows them)
      const ux = (pinch.mx - cx - pinch.tx) / pinch.s, uy = (pinch.my - cy - pinch.ty) / pinch.s;
      s = ns; tx = mx - cx - ns * ux; ty = my - cy - ns * uy;
      mode = 'free';
      apply();
      showBadge(pct());
    } else if (pan) {
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (!moved && Math.hypot(dx, dy) < 10) return;
      moved = true;
      tx = pan.tx + dx; ty = pan.ty + dy;
      apply();
    }
  }, { passive: true });

  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    const start = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (moved) swallowUntil = Date.now() + 400;
    if (pinch && pts.size < 2) {
      pinch = null;
      // nearly back to normal: snap to the original size
      if (s < 1.08) { reset(true); showBadge('Dimensioni originali'); }
      // one finger still down: it goes on moving the picture
      const [rest] = [...pts.values()];
      pan = rest && s > 1 ? { x: rest.x, y: rest.y, tx, ty } : null;
      lastTap = null;
      return;
    }
    if (pts.size) return;
    pan = null;
    if (moved || e.type === 'pointercancel') { lastTap = null; return; }
    // double tap
    const now = Date.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(start.x - lastTap.x, start.y - lastTap.y) < 50) {
      lastTap = null;
      toggle();
    } else lastTap = { t: now, x: start.x, y: start.y };
  };
  root.addEventListener('pointerup', up, { passive: true });
  root.addEventListener('pointercancel', up, { passive: true });

  // trackpad pinch (Chrome sends ctrl + wheel) and Safari's gesture events on the Mac
  root.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !enabled() || !onPicture(e.target)) return;
    e.preventDefault();
    const { cx, cy } = centre();
    const ns = Math.max(1, Math.min(MAX, s * Math.exp(-e.deltaY / 100)));
    const ux = (e.clientX - cx - tx) / s, uy = (e.clientY - cy - ty) / s;
    s = ns; tx = e.clientX - cx - ns * ux; ty = e.clientY - cy - ns * uy; mode = 'free';
    apply(); showBadge(pct());
  }, { passive: false });
  let g0 = 1;
  // (on iPhone/iPad the same pinch also arrives as touches, handled above: only stop the page zoom)
  root.addEventListener('gesturestart', (e) => { if (enabled()) { e.preventDefault(); g0 = s; } });
  root.addEventListener('gesturechange', (e) => {
    if (!enabled()) return;
    e.preventDefault();
    if (pts.size) return;
    s = Math.max(1, Math.min(MAX, g0 * e.scale)); mode = 'free';
    apply(); showBadge(pct());
  });

  // rotation / window resize: "fill" is recomputed, a free zoom is kept inside the screen
  addEventListener('resize', () => { if (s > 1) { if (mode === 'fill') fill(false); else apply(); } });
  // new resolution of the same video (adaptive streaming): keep within bounds
  video.addEventListener('resize', () => { if (s > 1) apply(); });
}
