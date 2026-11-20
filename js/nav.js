// Spatial navigation for keyboard, TV remotes and game pads (arrow keys + Enter).
// Touch and mouse work natively; this only kicks in on key presses.

const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

function visible(el) {
  if (el.disabled || el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function scope() {
  const modal = document.getElementById('modal');
  if (!modal.hidden) return modal;
  const player = document.getElementById('player');
  if (!player.hidden) return player;
  return document.getElementById('app');
}

export function focusables(root = scope()) {
  return [...root.querySelectorAll('.focusable, input:not([type=hidden]), select, textarea')].filter(visible);
}

function centre(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

function best(from, dir, candidates) {
  const a = from.getBoundingClientRect();
  const ca = centre(a);
  let bestEl = null, bestScore = Infinity;
  for (const el of candidates) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const cb = centre(b);
    const dx = cb.x - ca.x, dy = cb.y - ca.y;
    let main, cross;
    switch (dir) {
      case 'up': if (b.bottom > a.top + 2) continue; main = -dy; cross = Math.abs(dx); break;
      case 'down': if (b.top < a.bottom - 2) continue; main = dy; cross = Math.abs(dx); break;
      case 'left': if (b.right > a.left + 2) continue; main = -dx; cross = Math.abs(dy); break;
      case 'right': if (b.left < a.right - 2) continue; main = dx; cross = Math.abs(dy); break;
    }
    const score = main + cross * 2.5;
    if (score < bestScore) { bestScore = score; bestEl = el; }
  }
  return bestEl;
}

export function move(dir) {
  const list = focusables();
  if (!list.length) return false;
  const cur = document.activeElement;
  if (!cur || !list.includes(cur)) {
    list[0].focus();
    return true;
  }
  const next = best(cur, dir, list);
  if (next) {
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return true;
  }
  return false;
}

/** Returns true when the key was consumed. */
export function handleNavKey(e) {
  const dir = DIRS[e.key];
  if (!dir) return false;
  const a = document.activeElement;
  // Let text fields and sliders keep their own horizontal arrow behaviour.
  // Text fields keep left/right for the cursor, but the arrow leaves the field at its ends
  // (otherwise a TV remote gets stuck in it); sliders keep left/right for their value.
  if (a && a.tagName === 'TEXTAREA') return false;
  if (a && a.tagName === 'INPUT' && a.type !== 'checkbox') {
    if (a.type === 'range' && (dir === 'left' || dir === 'right')) return false;
    if (dir === 'left' || dir === 'right') {
      let atEdge = true;
      try {
        if (a.selectionStart != null) atEdge = dir === 'left' ? a.selectionStart === 0 && a.selectionEnd === 0 : a.selectionEnd === a.value.length;
      } catch { /* types without a cursor position */ }
      if (!atEdge) return false;
    }
  }
  // Drop-down lists: up/down choose the value with a keyboard, except on the TV app where
  // OK opens the list and the arrows move between fields
  if (a && a.tagName === 'SELECT' && (dir === 'up' || dir === 'down') && !document.body.classList.contains('tv')) return false;
  document.body.classList.add('kbd-nav');
  return move(dir);
}

document.addEventListener('pointerdown', () => document.body.classList.remove('kbd-nav'), { passive: true });
