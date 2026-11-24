// Generated subtitles (Whisper, see whisper-worker.js): capturing the sound of the <video>
// and talking to the worker. Only on computers: Mac/PC with WebGPU (recent Chrome, Edge,
// Safari 26). iPhone, iPad, Android and the Fire TV can't run it fast enough.
const UA = navigator.userAgent;
const TV_APP = /SalottoTV/.test(UA);
const TOUCH_MAC = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1; // iPad asking for the desktop site
const MOBILE = /iPad|iPhone|iPod|Android|Mobile|Silk|AFT/.test(UA) || TOUCH_MAC;

export const MODELS = {
  base: { id: 'onnx-community/whisper-base', label: 'Veloce', size: 'circa 150 MB', note: 'leggero, sbaglia più spesso' },
  small: { id: 'onnx-community/whisper-small', label: 'Bilanciata', size: 'circa 300 MB', note: 'consigliata' },
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', label: 'Massima', size: 'circa 1,2 GB', note: 'solo computer potenti' },
};

// Chrome and Edge copy the sound with captureStream(), which leaves the video alone. Elsewhere
// (Safari) the sound must go through Web Audio, and that only works when the video is fed by
// hls.js (Media Source): the player switches to hls.js for it (needsMse).
const CAN_CAPTURE_STREAM = typeof HTMLMediaElement !== 'undefined' && 'captureStream' in HTMLMediaElement.prototype;
export const needsMse = () => !CAN_CAPTURE_STREAM;

let support = null;
/** Can this device generate subtitles? → { ok, why, f16 } */
export function checkSupport() {
  if (support) return support;
  support = (async () => {
    if (TV_APP) return { ok: false, why: 'Sulla TV i sottotitoli generati non sono disponibili: servono un Mac o un PC.' };
    if (MOBILE) return { ok: false, why: 'I sottotitoli generati richiedono un Mac o un PC: su questo dispositivo sarebbero troppo pesanti.' };
    if (!navigator.gpu) return { ok: false, why: 'I sottotitoli generati richiedono WebGPU: usa Chrome o Edge aggiornati, oppure Safari 26 su Mac.' };
    if (typeof AudioWorkletNode === 'undefined') return { ok: false, why: 'Questo browser non permette di ascoltare l\'audio del video.' };
    try {
      const a = await navigator.gpu.requestAdapter();
      if (!a) return { ok: false, why: 'La scheda grafica di questo computer non è disponibile per WebGPU.' };
      return { ok: true, why: '', f16: a.features.has('shader-f16') };
    } catch {
      return { ok: false, why: 'La scheda grafica di questo computer non è disponibile per WebGPU.' };
    }
  })();
  return support;
}

// ---------------------------------------------------------------- the sound of the video
const TAP = `class T extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const len = ch[0].length, k = ch.length;
      for (let i = 0; i < len; i++) {
        let s = 0; for (let c = 0; c < k; c++) s += ch[c][i];
        this.buf[this.n++] = s / k;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(4096); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('salotto-tap', T);`;

let ctx = null, tap = null, src = null, srcTrack = '', elementSrc = null, sink = null;
let video = null;
let onAudio = null;

/** Create (or wake) the audio context. Call from a tap/click when possible. */
export function prime() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  } catch { /* ignore */ }
  return ctx;
}
const running = () => !!ctx && ctx.state === 'running';

async function ensureTap() {
  if (tap) return tap;
  const url = URL.createObjectURL(new Blob([TAP], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  tap = new AudioWorkletNode(ctx, 'salotto-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
  tap.port.onmessage = (e) => { if (onAudio) onAudio(e.data, ctx.sampleRate); };
  // a node only runs when connected to the speakers: through a silent gain
  sink = ctx.createGain(); sink.gain.value = 0;
  tap.connect(sink); sink.connect(ctx.destination);
  return tap;
}

/**
 * Start listening to the video (again: a new stream means new tracks).
 * Returns '' or why it can't (e.g. 'gesture' = the browser wants a tap first).
 */
export async function listen(v, cb) {
  video = v; onAudio = cb;
  prime();
  if (!ctx) return 'Questo browser non permette di ascoltare l\'audio del video.';
  if (!running()) {
    await new Promise(r => setTimeout(r, 300));
    if (!running()) return 'gesture';
  }
  await ensureTap();
  if (CAN_CAPTURE_STREAM) {
    let stream;
    try { stream = v.captureStream(); } catch { return 'Non riesco ad ascoltare l\'audio di questo canale.'; }
    const track = stream.getAudioTracks()[0];
    if (!track) return 'wait'; // no sound yet: try again when the video plays
    if (track.id === srcTrack && src) return '';
    try { src?.disconnect(); } catch { /* ignore */ }
    src = ctx.createMediaStreamSource(new MediaStream([track]));
    srcTrack = track.id;
    src.connect(tap);
    return '';
  }
  // Safari: the video's sound now goes through Web Audio for good (to the speakers as before)
  if (!elementSrc) {
    elementSrc = ctx.createMediaElementSource(v);
    elementSrc.connect(ctx.destination);
  }
  elementSrc.connect(tap);
  return '';
}

/** Safari: the video's sound now goes through Web Audio for the rest of the visit. From then on
 * a stream played by Safari's own player (not hls.js) may stay silent if its site doesn't allow
 * it (CORS), so the player keeps using hls.js. */
export const elementBound = () => !!elementSrc;

/** Stop listening (the video keeps its sound). */
export function stopListening() {
  onAudio = null;
  try { src?.disconnect(); } catch { /* ignore */ }
  src = null; srcTrack = '';
  if (elementSrc && tap) { try { elementSrc.disconnect(tap); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- the worker
let worker = null, workerModel = '';
let handlers = {};
/** Start Whisper (downloads the model the first time). Messages go to on(type, data). */
export async function start(modelKey, on) {
  handlers = on;
  const sup = await checkSupport();
  const model = MODELS[modelKey] || MODELS.small;
  if (worker && workerModel === model.id) return;
  endWorker();
  worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  workerModel = model.id;
  worker.onmessage = (e) => handlers[e.data.type]?.(e.data);
  worker.onerror = (e) => handlers.error?.({ fatal: true, message: e.message || 'errore del modulo' });
  worker.postMessage({ type: 'load', model: model.id, device: 'webgpu', dtype: { encoder_model: sup.f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' } });
}
export function feed(data, rate) { worker?.postMessage({ type: 'audio', data, rate }, [data.buffer]); }
export function reset() { worker?.postMessage({ type: 'reset' }); }
function endWorker() { if (worker) { worker.terminate(); worker = null; workerModel = ''; } }
/** Stop everything and free the graphics card's memory. */
export function stop() { stopListening(); endWorker(); }
export const isRunning = () => !!worker;
