// Focus that keeps working when the window is not in front.
// The phone remote presses keys on a screen whose window may be in the background (another
// app in front on the Mac). There the browser can ignore focus(), so the arrows would lose their
// place and fall through to the video. Every focus() is remembered here: while the window is in
// the background, focused() returns the element the page last asked to focus, and that element
// shows the focus highlight (.vfocus). When the window comes back to the front, the real focus
// moves there.
const nativeFocus = HTMLElement.prototype.focus;
const nativeBlur = HTMLElement.prototype.blur;
export const hooks = { focus: nativeFocus, hasFocus: () => document.hasFocus() }; // tests replace them
let virt = null;

const usable = (el) => el && el.isConnected && !el.closest('[hidden]');

function paint() {
  for (const e of document.querySelectorAll('.vfocus')) if (e !== virt || hooks.hasFocus()) e.classList.remove('vfocus');
  if (virt && !hooks.hasFocus() && usable(virt)) virt.classList.add('vfocus');
}

HTMLElement.prototype.focus = function (opts) {
  virt = this;
  const r = hooks.focus.call(this, opts);
  paint();
  return r;
};
HTMLElement.prototype.blur = function () {
  if (virt === this) virt = null;
  const r = nativeBlur.call(this);
  paint();
  return r;
};
document.addEventListener('focusin', (e) => { if (e.target instanceof HTMLElement) { virt = e.target; paint(); } });
window.addEventListener('blur', () => { const a = document.activeElement; if (a && a !== document.body) virt = a; paint(); });
window.addEventListener('focus', () => {
  if (usable(virt) && document.activeElement !== virt) hooks.focus.call(virt, { preventScroll: true });
  paint();
});

/** The element that has the focus, or would have it if the window were in front. */
export function focused() {
  const a = document.activeElement;
  if (!hooks.hasFocus() && usable(virt)) return virt;
  return a;
}
