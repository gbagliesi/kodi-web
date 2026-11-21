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
  if (!player.hidden) {
    // the channel list covers part of the controls: while it has the focus, stay inside it
    const panel = document.getElementById('pl-channels');
    if (panel && !panel.hidden && panel.contains(document.activeElement)) return panel;
    const info = document.getElementById('pl-epg');
    if (info && !info.hidden && info.contains(document.activeElement)) return info;
    return player;
  }
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

// The side menu and the page are two columns: ▲▼ stay in the column you are in, and only
// ◀▶ cross between them (on phones the menu is a bottom bar, so there it is the other way round).
function sameRegion(cur, dir, list) {
  const side = document.getElementById('sidebar'), main = document.getElementById('main');
  if (!side || !main || !side.contains(cur) && !main.contains(cur)) return list;
  const s = side.getBoundingClientRect(), m = main.getBoundingClientRect();
  const besides = s.right <= m.left + 1 || m.right <= s.left + 1;
  const vertical = dir === 'up' || dir === 'down';
  if (besides !== vertical) return list;
  const region = side.contains(cur) ? side : main;
  return list.filter(el => region.contains(el));
}

export function move(dir, repeating = false) {
  const list = focusables();
  if (!list.length) return false;
  const cur = document.activeElement;
  if (!cur || !list.includes(cur)) {
    list[0].focus();
    return true;
  }
  const next = best(cur, dir, sameRegion(cur, dir, list));
  if (next) {
    next.focus({ preventScroll: true });
    // Instant scrolling: a smooth scroll restarted on every key repeat makes long lists stutter
    // while the remote's arrow is held down
    next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: repeating || document.body.classList.contains('tv') ? 'auto' : 'smooth' });
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
  return move(dir, e.repeat);
}

document.addEventListener('pointerdown', () => document.body.classList.remove('kbd-nav'), { passive: true });
