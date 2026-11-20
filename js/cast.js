// Google Cast (Chromecast, Google TV, Nest speakers) from Chrome on Android, Mac and PC.
// The Cast SDK only exists in Chrome-based browsers; AirPlay (Apple) is handled in player.js
// through WebKit's own picker.
const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

let ctx = null;            // cast.framework.CastContext
let player = null;         // cast.framework.RemotePlayer
let controller = null;     // cast.framework.RemotePlayerController
let state = 'NO_DEVICES_AVAILABLE';
const handlers = { state: () => {}, session: () => {}, progress: () => {} };

/** Load the Cast SDK (Chrome only). onState(available), onSession(active, deviceName), onProgress({time, duration, paused}). */
export function initCast({ onState, onSession, onProgress } = {}) {
  Object.assign(handlers, { state: onState || handlers.state, session: onSession || handlers.session, progress: onProgress || handlers.progress });
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
