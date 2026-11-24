// Subtitles in the player (CC button). Two sources:
//  • the channel's own subtitles, when the stream carries them: HLS subtitle tracks, TV closed
//    captions inside the video (CEA-608/708), the tracks Safari finds by itself, add-on files;
//  • otherwise subtitles generated on this computer by Whisper (whisper.js), a few seconds late.
// Everything is drawn by us in #pl-subs (same look everywhere, above the controls when shown).
import { load, save } from './storage.js';
import { focused } from './focus.js';
import * as whisper from './whisper.js';

const $ = (id) => document.getElementById(id);
const UA = navigator.userAgent;
const SAFARI_DRAWS = /iPad|iPhone|iPod/.test(UA) || (/Safari\//.test(UA) && !/Chrome|Chromium|CriOS|FxiOS|Edg|Android/.test(UA));
let el = null;
let opts = null;           // { reattach(), changed(), wake() }

// what the viewer chose, kept between videos: off | on (the channel's, else generated) | gen
let prefs = { mode: 'off', model: 'small', lang: 'it', ...load('subs', {}) };
const savePrefs = () => save('subs', prefs);

let support = { ok: false, why: '' };  // can this device generate subtitles (filled at start)
let hls = null;
let item = null;            // what is playing ({ audio, casting })
let tracks = [];            // [{ id, label, lang, kind: 'hls'|'cc'|'tt', ref }]
let active = null;          // id of the track shown, 'gen' for generated, or null
let cues = new Map();       // id → [{ start, end, text }] (hls.js tracks)
let decideTimer = 0;
let noMse = false;          // this channel only plays in the system player: no generated subtitles here
let genStatus = '';         // what the generated subtitles are doing (shown in the box)
let genText = null;         // { pieces, from, dur }
let lagShown = false;

export function init(o) {
  opts = o;
  el = {
    btn: $('pl-cc'), box: $('pl-ccbox'), list: $('pl-cclist'), note: $('pl-ccnote'), close: $('pl-ccclose'),
    models: $('pl-ccmodels'), overlay: $('pl-subs'), video: $('video'),
  };
  whisper.checkSupport().then((s) => { support = s; render(); });
  el.btn.addEventListener('click', () => { whisper.prime(); toggleBox(); });
  el.close.addEventListener('click', closeBox);
  const tt = el.video.textTracks;
  for (const ev of ['addtrack', 'removetrack']) tt.addEventListener?.(ev, () => { if (item) refreshTextTracks(); });
  el.video.addEventListener('playing', () => { if (item) onPlaying(); });
  el.video.addEventListener('seeking', () => { if (active === 'gen') { whisper.reset(); show(''); } });
  setInterval(tick, 250);
}

// ---------------------------------------------------------------- hls.js
/** Options for new Hls(): hls.js hands us the cues instead of drawing them itself. */
export const hlsConfig = () => ({
  renderTextTracksNatively: false, enableCEA708Captions: true,
  captionsTextTrack1Label: 'Sottotitoli TV', captionsTextTrack1LanguageCode: 'it',
  captionsTextTrack2Label: 'Sottotitoli TV (2)', captionsTextTrack2LanguageCode: 'it',
});
export function hookHls(h) {
  hls = h;
  const E = window.Hls.Events;
  h.on(E.SUBTITLE_TRACKS_UPDATED, () => refreshHlsTracks());
  h.on(E.MANIFEST_PARSED, () => { h.subtitleTrack = -1; refreshHlsTracks(); });
  h.on(E.NON_NATIVE_TEXT_TRACKS_FOUND, (_, d) => {
    for (const t of d.tracks || []) {
      if (t.kind !== 'captions' || !t._id || tracks.some(x => x.id === 'cc:' + t._id)) continue;
      tracks.push({ id: 'cc:' + t._id, label: t.label || 'Sottotitoli TV', lang: 'it', kind: 'cc', ref: t._id });
    }
    tracksChanged();
  });
  h.on(E.CUES_PARSED, (_, d) => {
    const id = d.type === 'captions' ? 'cc:' + d.track : 'hls:' + h.subtitleTrack;
    const list = cues.get(id) || [];
    for (const c of d.cues || []) list.push({ start: c.startTime, end: c.endTime, text: cueText(c.text) });
    cues.set(id, list);
  });
  h.on(E.DESTROYING, () => { if (hls === h) { hls = null; tracks = tracks.filter(t => t.kind === 'tt'); cues.clear(); } });
}
function refreshHlsTracks() {
  if (!hls) return;
  tracks = tracks.filter(t => t.kind !== 'hls');
  (hls.subtitleTracks || []).forEach((t, i) => tracks.push({ id: 'hls:' + i, label: t.name || langName(t.lang) || 'Sottotitoli ' + (i + 1), lang: t.lang || '', kind: 'hls', ref: i, def: t.default }));
  tracksChanged();
}
// tracks the browser found (Safari's own HLS player) and the add-ons' subtitle files
function refreshTextTracks() {
  tracks = tracks.filter(t => t.kind !== 'tt');
  [...el.video.textTracks].forEach((t, i) => {
    if (t.kind !== 'subtitles' && t.kind !== 'captions') return;
    tracks.push({ id: 'tt:' + i, label: t.label || langName(t.language) || 'Sottotitoli', lang: t.language || '', kind: 'tt', ref: t });
    if (!t.__salotto) { t.__salotto = true; t.addEventListener('cuechange', tick); }
  });
  tracksChanged();
}
function tracksChanged() {
  if (active && active !== 'gen' && !tracks.some(t => t.id === active)) setActive(null);
  // the channel's own subtitles turned up: they win over the generated ones
  if (prefs.mode === 'on' && usable().length && (active === null || active === 'gen')) autoPick();
  syncHls();
  render();
}
/** hls.js loads only the subtitle track we show (it may pick a default one by itself). */
function syncHls() {
  if (!hls) return;
  const t = tracks.find(x => x.id === active);
  const want = t?.kind === 'hls' ? t.ref : -1;
  if (hls.subtitleTrack !== want) { cues.delete('hls:' + hls.subtitleTrack); hls.subtitleTrack = want; }
}
// Safari announces a «Sottotitoli» track on many channels that never carries any text: a track
// picked automatically that stays empty for a while is set aside and the generated ones take over.
const EMPTY_AFTER = 20000;
let emptyIds = new Set(), emptyTimer = 0;
const usable = () => tracks.filter(t => !emptyIds.has(t.id));
function hasCues(t) {
  if (t.kind === 'tt') return !!t.ref.cues?.length;
  return !!cues.get(t.id)?.length;
}
function autoPick() {
  const t = bestTrack();
  if (!t) return;
  setActive(t.id);
  clearTimeout(emptyTimer);
  const check = () => {
    if (active !== t.id || !item) return;
    if (el.video.paused) { emptyTimer = setTimeout(check, 5000); return; }
    if (hasCues(t)) return;
    emptyIds.add(t.id);
    setActive(null);
    decide();
  };
  emptyTimer = setTimeout(check, EMPTY_AFTER);
}
function bestTrack() {
  const tracks = usable();
  const lang = prefs.lang || 'it';
  return tracks.find(t => t.lang?.toLowerCase().startsWith(lang) || new RegExp(langName(lang) || '^$', 'i').test(t.label))
    || tracks.find(t => t.def) || tracks[0];
}
const LANGS = { it: 'Italiano', en: 'Inglese', de: 'Tedesco', fr: 'Francese', es: 'Spagnolo', sl: 'Sloveno' };
function langName(code) { return LANGS[String(code || '').slice(0, 2).toLowerCase()] || ''; }
function cueText(t) {
  const d = document.createElement('div');
  d.innerHTML = String(t || '').replace(/<br\s*\/?>/gi, '\n');
  return d.textContent.trim();
}

// ---------------------------------------------------------------- choosing what to show
function setActive(id) {
  if (id === active) return;
  active = id;
  // Safari draws the tracks of its own HLS player itself (it may not load them while hidden)
  for (const t of tracks) if (t.kind === 'tt') t.ref.mode = t.id === id ? (SAFARI_DRAWS ? 'showing' : 'hidden') : 'disabled';
  syncHls();
  if (id === 'gen') startGen(); else stopGen();
  show('');
  tick();
  render();
  opts.changed();
}

/** A new video starts (or null when the player closes). */
export function newItem(it) {
  clearTimeout(decideTimer); clearTimeout(emptyTimer);
  emptyIds = new Set();
  item = it;
  tracks = []; cues.clear(); active = null; noMse = false; lagShown = false;
  show('');
  genText = null; quiet = 0;
  if (!it) { stopGen(true); closeBox(); render(); return; }
  whisper.stopListening();
  whisper.reset();
  if (genStatus && !whisper.isRunning()) genStatus = '';
  refreshTextTracks();
  render();
}
/** The player had to leave hls.js (stream refused it): no generated subtitles on this channel. */
export function mseFailed() { noMse = true; if (active === 'gen') setActive(null); render(); }
/** The cast/receiver or audio-only state changed. */
export function setCasting(on) { if (item) { item.casting = on; if (on && active === 'gen') setActive(null); render(); } }

/** On Safari the sound can only be heard through hls.js: ask the player to use it. */
// Only once generated subtitles are really needed (not for subtitles off, or the channel's own):
// the system player reaches many channels directly, hls.js may need the proxy for them.
let mseFor = null;
export const wantsMse = () => whisper.elementBound() || (!!item && mseFor === item && prefs.mode !== 'off' && support.ok && whisper.needsMse() && !noMse && !item.audio);
export const audioBound = () => whisper.elementBound();

const genPossible = () => support.ok && !noMse && item && !item.audio && !item.casting;
function genWhy() {
  if (!support.ok) return support.why;
  if (noMse) return 'Su questo canale serve il proxy (Impostazioni): senza, Safari lo riproduce solo con il suo lettore, che non lascia ascoltare l\'audio per la trascrizione.';
  if (item?.casting) return 'Durante la trasmissione alla TV i sottotitoli generati non sono disponibili.';
  if (item?.audio) return 'Solo per i video.';
  return '';
}

function onPlaying() {
  if (prefs.mode === 'off' || active !== null && active !== 'gen') { if (active === 'gen') listen(); return; }
  if (active === 'gen') { listen(); return; }
  if (prefs.mode === 'gen') { decide(); return; }
  // wait a little for the channel's own subtitles (TV captions turn up with the first pieces)
  clearTimeout(decideTimer);
  decideTimer = setTimeout(decide, 4000);
}
function decide() {
  if (!item || prefs.mode === 'off' || (active && active !== 'gen')) return;
  if (prefs.mode === 'on' && usable().length) { autoPick(); return; }
  if (genPossible()) needAudio();
  else render();
}

/** Choice in the box: 'off', 'on', 'gen' or a track id. */
function choose(id) {
  whisper.prime();
  if (id === 'off') { prefs.mode = 'off'; savePrefs(); setActive(null); return; }
  if (id === 'on') {
    prefs.mode = 'on'; savePrefs();
    if (usable().length) autoPick();
    else if (genPossible()) needAudio();
    else render();
    return;
  }
  if (id === 'gen') { prefs.mode = 'gen'; savePrefs(); needAudio(); return; }
  const t = tracks.find(x => x.id === id);
  if (!t) return;
  prefs.mode = 'on'; prefs.lang = (t.lang || 'it').slice(0, 2).toLowerCase(); savePrefs();
  setActive(id);
}
// generated subtitles: on Safari the player first switches to hls.js (then 'playing' decides)
function needAudio() {
  if (!genPossible()) { render(); return; }
  if (whisper.needsMse() && !hls) {
    mseFor = item;
    genStatus = 'Passo al lettore che permette di ascoltare l\'audio (per alcuni canali, come quelli Rai, passa dal proxy)…';
    render();
    opts.reattach();
    return;
  }
  setActive('gen');
}

/** The phone remote's CC button: off ↔ on. */
export function toggle() {
  if (prefs.mode === 'off') choose('on'); else choose('off');
}

// ---------------------------------------------------------------- generated subtitles
const GEN_LISTENING = 'In ascolto: le frasi compaiono qualche secondo dopo il parlato.';
let quiet = 0;
const GEN_HANDLERS = {
  progress: ({ loaded, total }) => {
    genStatus = 'Scarico il modello di trascrizione (solo la prima volta): ' + (total ? Math.round(loaded / total * 100) + '% di ' + mb(total) : mb(loaded)) + '…';
    render();
  },
  ready: () => { genStatus = GEN_LISTENING; render(); },
  text: ({ text, dur, took }) => {
    if (active !== 'gen') return;
    quiet = 0;
    if (genStatus.startsWith('Non sento')) { genStatus = GEN_LISTENING; render(); }
    showGen(text, dur);
    if (took > dur * 1.2 && !lagShown) {
      lagShown = true;
      genStatus = 'Il computer fatica a stare al passo: prova la qualità «Veloce».';
      render();
    }
  },
  // pieces with no sound at all for half a minute: the browser doesn't let us hear this channel
  quiet: () => {
    if (++quiet === 6 && active === 'gen' && !el.video.muted) {
      genStatus = 'Non sento l\'audio di questo canale: se lo senti anche tu, il sito del canale non permette di ascoltarlo (prova con il proxy attivo).';
      render();
    }
  },
  lag: () => { if (!lagShown) { lagShown = true; genStatus = 'Il computer non riesce a stare al passo: alcune frasi vengono saltate. Prova la qualità «Veloce».'; render(); } },
  error: ({ message, fatal }) => {
    console.warn('whisper:', message);
    if (!fatal) return;
    genStatus = 'I sottotitoli generati non sono partiti: ' + message;
    whisper.stop();
    if (active === 'gen') { active = null; show(''); opts.changed(); }
    render();
  },
};
const mb = (b) => (b / 1e6 >= 1000 ? (b / 1e9).toFixed(1).replace('.', ',') + ' GB' : Math.round(b / 1e6) + ' MB');

let stopTimer = 0;
function startGen() {
  clearTimeout(stopTimer);
  if (!whisper.isRunning()) genStatus = 'Avvio la trascrizione…';
  whisper.start(prefs.model, GEN_HANDLERS).catch(e => GEN_HANDLERS.error({ fatal: true, message: e.message }));
  listen();
}
/** Stop listening; the model stays loaded a couple of minutes (zapping, reopening a channel). */
function stopGen(soon = false) {
  whisper.stopListening();
  genText = null;
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => { if (active !== 'gen') whisper.stop(); }, soon ? 120000 : 600000);
}
let gestureWait = false;
async function listen() {
  if (active !== 'gen' || el.video.paused) return;
  const why = await whisper.listen(el.video, (data, rate) => { if (active === 'gen' && !el.video.paused) whisper.feed(data, rate); });
  if (why === 'gesture') {
    genStatus = 'Tocca lo schermo (o premi un tasto) per far partire i sottotitoli generati.';
    render();
    if (!gestureWait) {
      gestureWait = true;
      const go = () => { gestureWait = false; whisper.prime(); setTimeout(listen, 50); };
      document.addEventListener('pointerdown', go, { once: true, capture: true });
      document.addEventListener('keydown', (e) => { if (e.isTrusted) go(); }, { once: true, capture: true });
    }
  } else if (why === 'wait') setTimeout(listen, 1000);
  else if (why) { genStatus = why; render(); }
}
function showGen(text, dur) {
  // long text: in two or three parts, one after the other over the length of the piece
  const words = text.split(' '), pieces = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > 84) { pieces.push(line); line = w; } else line = line ? line + ' ' + w : w;
  }
  if (line) pieces.push(line);
  const group = [];
  for (let i = 0; i < pieces.length; i += 2) group.push(pieces.slice(i, i + 2).join('\n'));
  genText = { group, from: performance.now(), dur: Math.max(2.5, dur) * 1000 };
  tick();
}

// ---------------------------------------------------------------- drawing
let shown = '';
function show(text) {
  if (text === shown) return;
  shown = text;
  el.overlay.textContent = '';
  for (const l of text.split('\n').filter(Boolean)) {
    const s = document.createElement('span');
    s.textContent = l;
    el.overlay.appendChild(s);
  }
  el.overlay.hidden = !text;
}
function tick() {
  if (!el || !item || !active) { if (el && shown) show(''); return; }
  if (active === 'gen') {
    if (!genText) return;
    const { group, from, dur } = genText;
    const age = performance.now() - from;
    // the last part stays a little longer, until the next piece arrives (at most 3 s more)
    if (age > dur + 3000) { genText = null; show(''); return; }
    show(group[Math.min(group.length - 1, Math.floor(age / (dur / group.length)))]);
    return;
  }
  const t = tracks.find(x => x.id === active);
  if (!t) { show(''); return; }
  if (t.kind === 'tt') { if (SAFARI_DRAWS) { show(''); return; } show([...(t.ref.activeCues || [])].map(c => cueText(c.text)).join('\n')); return; }
  const now = el.video.currentTime, list = cues.get(active) || [];
  // old cues are not needed any more (live TV runs for hours)
  if (list.length > 400) cues.set(active, list.filter(c => c.end > now - 30));
  show(list.filter(c => c.start <= now && c.end > now).map(c => c.text).join('\n'));
}

// ---------------------------------------------------------------- the CC box
export const boxOpen = () => !!el && !el.box.hidden;
export const box = () => el.box;
export function toggleBox() { if (el.box.hidden) openBox(); else closeBox(); }
export function openBox() {
  if (!item) return;
  opts.beforeOpen?.();
  el.box.hidden = false;
  render();
  (el.list.querySelector('.cc-opt.on') || el.list.querySelector('.cc-opt:not(:disabled)') || el.close).focus({ preventScroll: true });
}
export function closeBox() {
  if (!el || el.box.hidden) return;
  el.box.hidden = true;
  if (focused() && el.box.contains(focused())) focused().blur();
  if (!el.btn.hidden) el.btn.focus({ preventScroll: true });
  opts.wake?.();
}
/** Where the phone's highlight starts in the box. */
export const startItem = () => el.list.querySelector('.cc-opt.on') || el.list.querySelector('.cc-opt');

function option(id, label, desc, on, disabled = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cc-opt focusable' + (on ? ' on' : '');
  b.disabled = disabled;
  b.innerHTML = '<span class="cc-check">' + (on ? '✓' : '') + '</span><span class="cc-text"><b></b><small></small></span>';
  b.querySelector('b').textContent = label;
  b.querySelector('small').textContent = desc || '';
  b.addEventListener('click', () => choose(id));
  return b;
}

function render() {
  if (!el) return;
  el.btn.hidden = !item || !!item.audio;
  const on = !!active;
  el.btn.classList.toggle('active', on || prefs.mode !== 'off');
  el.btn.title = 'Sottotitoli' + (active === 'gen' ? ': generati dal computer' : on ? ': ' + (tracks.find(t => t.id === active)?.label || '') : prefs.mode !== 'off' ? ': attivi quando disponibili' : '');
  if (el.box.hidden) return;
  const keep = focused() && el.box.contains(focused()) ? [...el.box.querySelectorAll('button')].indexOf(focused()) : -1;
  el.list.textContent = '';
  const genOk = genPossible();
  el.list.append(option('off', 'Spenti', '', prefs.mode === 'off'));
  el.list.append(option('on', 'Automatici', genOk ? 'Quelli del canale se ci sono, altrimenti generati dal computer' : 'Quelli del canale, quando ci sono', prefs.mode === 'on'));
  for (const t of tracks) el.list.append(option(t.id, t.label, emptyIds.has(t.id) ? 'Finora vuoti: il canale non ci ha mandato nessun testo' : t.kind === 'cc' ? 'Sottotitoli trasmessi dal canale (televideo)' : 'Sottotitoli del canale', active === t.id));
  el.list.append(option('gen', 'Generati dal computer', genOk ? 'Trascrizione automatica dell\'audio in italiano, con qualche secondo di ritardo' : genWhy(), active === 'gen' || prefs.mode === 'gen', !genOk));
  // quality of the generated subtitles
  el.models.hidden = !support.ok;
  el.models.textContent = '';
  if (support.ok) {
    const h = document.createElement('div'); h.className = 'cc-mhead'; h.textContent = 'Qualità della trascrizione';
    el.models.append(h);
    const row = document.createElement('div'); row.className = 'cc-mrow';
    for (const [k, m] of Object.entries(whisper.MODELS)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn focusable cc-model' + (prefs.model === k ? ' on' : '');
      b.innerHTML = '<b></b><small></small>';
      b.querySelector('b').textContent = m.label;
      b.querySelector('small').textContent = m.size;
      b.title = m.note;
      b.addEventListener('click', () => {
        if (prefs.model === k) return;
        prefs.model = k; savePrefs();
        if (active === 'gen') startGen();
        render();
      });
      row.append(b);
    }
    el.models.append(row);
  }
  let note = '';
  if (active === 'gen' || (prefs.mode !== 'off' && genStatus)) note = genStatus;
  else if (prefs.mode === 'on' && !tracks.length && !genOk) note = 'Questo canale non trasmette sottotitoli. ' + genWhy();
  el.note.textContent = note;
  el.note.hidden = !note;
  if (keep >= 0) el.box.querySelectorAll('button')[keep]?.focus({ preventScroll: true });
}

/** For the phone remote and the stream details. */
export function state() {
  const t = tracks.find(x => x.id === active);
  return { on: prefs.mode !== 'off', active: active === 'gen' ? 'gen' : active ? 'track' : '', label: active === 'gen' ? 'Generati' : t ? t.label : '' };
}
