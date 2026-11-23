// Audio/video sync ("Sincronia audio", like Kodi's audio offset): moves the sound earlier or
// later than the picture. Browsers have no such control, but with hls.js the stream is fed to
// Media Source in separate audio and video buffers, so the audio buffer can be given its own
// timestampOffset: every audio sample is placed `offset` seconds later (or earlier) on the
// timeline. Native HLS players (Safari, the Fire TV WebView) and plain files can't do this,
// so the player switches to hls.js while a channel has an offset.

/** Patch one hls.js instance (1.5.x) so audio appends get the offset returned by getOffset(). */
export function hookHls(hls, getOffset) {
  const bc = hls.bufferController;
  const tracker = hls.streamController?.fragmentTracker;
  if (!bc || typeof bc.appendExecutor !== 'function' || bc.__avHooked) return false;
  bc.__avHooked = true;
  const basePadding = tracker ? tracker.bufferPadding : 0;
  const orig = bc.appendExecutor;
  bc.appendExecutor = function (data, type) {
    if (type === 'audio') {
      const sb = this.sourceBuffer && this.sourceBuffer.audio;
      if (sb) {
        try {
          const off = getOffset() || 0;
          // hls.js itself moves the audio offset for MPEG audio: keep its value as the base
          if (sb.__avSet === undefined || Math.abs(sb.timestampOffset - sb.__avSet) > 1e-6) sb.__avBase = sb.timestampOffset;
          const want = sb.__avBase + off;
          if (Math.abs(sb.timestampOffset - want) > 1e-6) sb.timestampOffset = want;
          sb.__avSet = sb.timestampOffset;
        } catch { /* buffer busy or removed: append without moving */ }
      }
    }
    return orig.call(this, data, type);
  };
  // hls.js checks that each segment's audio and video landed where expected; with the audio
  // moved, the edges are off by the offset. Widen its tolerance so it doesn't load them again.
  if (tracker) {
    let pad = basePadding;
    Object.defineProperty(tracker, 'bufferPadding', {
      configurable: true,
      get: () => pad + Math.abs(getOffset() || 0),
      set: (x) => { pad = x; },
    });
  }
  return true;
}

/** True when this hls.js instance plays audio from its own buffer (the offset can work). */
export const separateAudio = (hls) => !!hls?.bufferController?.sourceBuffer?.audio;

/** Apply a changed offset right away: drop what is buffered and load it again from here. */
export function reload(hls) {
  try { hls.streamController.immediateLevelSwitch(); return true; } catch { return false; }
}
