// Google Cast (Chromecast, Google TV, Nest speakers) from Chrome on Android, Mac and PC.
// The Cast SDK only exists in Chrome-based browsers; AirPlay (Apple) is handled in player.js
// through WebKit's own picker.
const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

let ctx = null;            // cast.framework.CastContext
let player = null;         // cast.framework.RemotePlayer
let controller = null;     // cast.framework.RemotePlayerController
let state = 'NO_DEVICES_AVAILABLE';
const handlers = { state: () => {}, session: () => {}, progress: () => {}, error: () => {} };

/** Load the Cast SDK (Chrome only). onState(available), onSession(active, deviceName), onProgress({time, duration, paused}). */
export function initCast({ onState, onSession, onProgress, onError } = {}) {
  Object.assign(handlers, { state: onState || handlers.state, session: onSession || handlers.session, progress: onProgress || handlers.progress, error: onError || handlers.error });
  const ua = navigator.userAgent;
  if (!window.chrome || /iPad|iPhone|iPod|CriOS/.test(ua)) return; // no Cast SDK outside Chrome
  window.__onGCastApiAvailable = (ok) => { if (ok) setup(); };
  const s = document.createElement('script');
  s.src = SDK; s.async = true;
  s.onerror = () => { /* offline or blocked: casting simply stays hidden */ };
  document.head.appendChild(s);
}

function setup() {
  const { framework } = window.cast;
  ctx = framework.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  ctx.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, (e) => {
    state = e.castState;
    handlers.state(available());
  });
  ctx.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, (e) => {
    const S = framework.SessionState;
    if (e.sessionState === S.SESSION_STARTED || e.sessionState === S.SESSION_RESUMED) handlers.session(true, deviceName());
    else if (e.sessionState === S.SESSION_ENDED) handlers.session(false, '');
  });
  player = new framework.RemotePlayer();
  controller = new framework.RemotePlayerController(player);
  const E = framework.RemotePlayerEventType;
  const report = () => handlers.progress({ time: player.currentTime, duration: player.duration, paused: player.isPaused });
  controller.addEventListener(E.CURRENT_TIME_CHANGED, report);
  controller.addEventListener(E.IS_PAUSED_CHANGED, report);
  controller.addEventListener(E.DURATION_CHANGED, report);
  // The receiver gives up silently (logo stays on the TV): report it to the app.
  controller.addEventListener(E.PLAYER_STATE_CHANGED, () => {
    const m = session()?.getMediaSession();
    if (player.playerState === 'IDLE' && m && m.idleReason === 'ERROR') handlers.error();
  });
  state = ctx.getCastState();
  handlers.state(available());
}

export const available = () => !!ctx && state !== 'NO_DEVICES_AVAILABLE';
export const session = () => (ctx ? ctx.getCurrentSession() : null);
export const isCasting = () => !!session();
export const deviceName = () => session()?.getCastDevice()?.friendlyName || 'TV';

/** Opens Chrome's device picker (it also offers "stop casting" when a session is active). */
export function requestSession() {
  if (!ctx) return Promise.reject(new Error('Trasmissione non disponibile'));
  return ctx.requestSession();
}

/** Plays a media on the connected receiver. */
export async function load({ url, mime, hls, title, subtitle, thumb, live, audio, startTime = 0 }) {
  const s = session();
  if (!s) throw new Error('Nessun dispositivo collegato');
  const { media } = window.chrome.cast;
  const type = hls ? 'application/x-mpegurl' : (mime || (audio ? 'audio/mpeg' : 'video/mp4'));
  const info = new media.MediaInfo(url, type);
  if (hls) await setSegmentFormat(info, url);
  info.streamType = live ? media.StreamType.LIVE : media.StreamType.BUFFERED;
  const meta = audio ? new media.MusicTrackMediaMetadata() : new media.GenericMediaMetadata();
  meta.title = title || '';
  if (audio) meta.artist = subtitle || ''; else meta.subtitle = subtitle || '';
  if (thumb && /^https:/.test(thumb)) meta.images = [new window.chrome.cast.Image(thumb)];
  info.metadata = meta;
  const req = new media.LoadRequest(info);
  req.autoplay = true;
  if (!live && startTime > 0) req.currentTime = startTime;
  await s.loadMedia(req);
}

// The Default Media Receiver assumes MPEG-TS segments; fMP4/CMAF or packed-audio streams
// only play if told so. Peek at the playlist (through the same proxied URL the TV will use).
async function setSegmentFormat(info, url) {
  const { media } = window.chrome.cast;
  if (!media.HlsSegmentFormat) return;
  try {
    const get = async (u) => { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
      try { const r = await fetch(u, { signal: ctl.signal }); return r.ok ? await r.text() : ''; } finally { clearTimeout(t); } };
    let text = await get(url);
    const variant = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#') && /#EXT-X-STREAM-INF/.test(text));
    if (variant) text = await get(new URL(variant, url).href);
    if (!text) return;
    const map = /#EXT-X-MAP:/.test(text);
    const seg = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) || '';
    // segment names may be proxied (proxy?url=<encoded>): decode before looking at the extension
    const ext = (decodeURIComponent(seg).match(/\.(ts|m4s|mp4|m4a|m4v|cmfv|cmfa|aac|mp3|ac3)(?:[?&#]|$)/i) || [])[1]?.toLowerCase() || '';
    if (map || ['m4s', 'mp4', 'm4v', 'm4a', 'cmfv', 'cmfa'].includes(ext)) {
      info.hlsSegmentFormat = media.HlsSegmentFormat.FMP4;
      if (media.HlsVideoSegmentFormat) info.hlsVideoSegmentFormat = media.HlsVideoSegmentFormat.FMP4;
    } else if (ext === 'aac') info.hlsSegmentFormat = media.HlsSegmentFormat.AAC;
    else if (ext === 'mp3') info.hlsSegmentFormat = media.HlsSegmentFormat.MP3;
    else if (ext === 'ac3') info.hlsSegmentFormat = media.HlsSegmentFormat.AC3;
    else if (ext === 'ts') {
      info.hlsSegmentFormat = media.HlsSegmentFormat.TS;
      if (media.HlsVideoSegmentFormat) info.hlsVideoSegmentFormat = media.HlsVideoSegmentFormat.MPEG2_TS;
    }
  } catch { /* unreachable from here: let the receiver guess */ }
}

export function playOrPause() { if (controller && isCasting()) controller.playOrPause(); }

export function seek(seconds) {
  if (!controller || !isCasting()) return;
  player.currentTime = Math.max(0, seconds);
  controller.seek();
}

export const remoteTime = () => (player ? player.currentTime : 0);
export const remoteDuration = () => (player && isFinite(player.duration) ? player.duration : 0);

/** Stops what is playing on the receiver but keeps the device connected. */
export function stopMedia() {
  const m = session()?.getMediaSession();
  if (m) m.stop(null, () => {}, () => {});
}
