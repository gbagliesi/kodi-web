// Generated subtitles: Whisper speech recognition running on this computer (WebGPU), in a
// worker so the player never stutters. The page sends the channel's sound as it plays; the
// worker cuts it into pieces of a few seconds at quiet moments, transcribes each one in Italian
// and sends the text back. Nothing leaves the computer except the one-time model download
// (from Hugging Face, then kept in the browser's cache).
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
const RATE = 16000;                 // what Whisper listens to
const MIN_CHUNK = 3.0 * RATE;       // a piece is cut at the quietest moment between 3 s…
const MAX_CHUNK = 5.5 * RATE;       // …and 5.5 s (shorter = less delay, longer = more context)
const FRAME = 0.05 * RATE;          // 50 ms frames to find the quiet moment
const SILENCE_RMS = 0.006;          // a piece this quiet is not sent to Whisper
const MAX_BACKLOG = 12 * RATE;      // more than this waiting: the computer can't keep up, drop the oldest

// Whisper's well-known inventions on silence, music and applause (it was trained on subtitled
// videos): never show them.
const HALLUCINATIONS = [
  /sottotitoli (creati|a cura|e revisione)/i, /amara\.org/i, /qtss/i, /grazie (a tutti )?per (la visione|l'attenzione|aver guardato)/i,
  /iscriviti al canale/i, /^\W*(grazie|musica|applausi|\.\.\.)\W*$/i, /^\W*$/,
];

let transcriber = null;
let loading = null;
let buf = new Float32Array(0);     // 16 kHz sound not transcribed yet
let queue = [];                    // pieces waiting for Whisper
let busy = false;
let generation = 0;                // bumped by reset: results of older pieces are dropped
let resample = { rate: 0, pos: 0, last: 0 };

const post = (m) => self.postMessage(m);

async function load({ model, device, dtype }) {
  const { pipeline, env } = await import(LIB);
  env.allowLocalModels = false;
  const progress = (p) => { if (p.status === 'progress_total') post({ type: 'progress', loaded: p.loaded, total: p.total }); };
  const make = (m, dev, dt) => pipeline('automatic-speech-recognition', m, { device: dev, dtype: dt, progress_callback: progress });
  const warm = (t) => t(new Float32Array(RATE), { language: 'italian', task: 'transcribe' });
  const attempts = [[model, device, dtype]];
  // half precision is not available on every graphics card: retry in full precision
  if (device === 'webgpu' && dtype?.encoder_model === 'fp16') attempts.push([model, device, { ...dtype, encoder_model: 'fp32' }]);
  // no usable WebGPU in this worker (it happens in Safari): the light model on the processor
  if (device === 'webgpu') attempts.push(['onnx-community/whisper-base', 'wasm', 'q8']);
  let lastErr = null;
  for (const [m, dev, dt] of attempts) {
    try {
      const t = await make(m, dev, dt);
      // first run compiles the graphics shaders: do it now on silence, not on the first sentence
      await warm(t);
      transcriber = t;
      if (dev !== device) post({ type: 'fallback', message: String(lastErr?.message || lastErr || '') });
      break;
    } catch (e) {
      lastErr = e;
      post({ type: 'error', message: dev + ': ' + String(e?.message || e) });
    }
  }
  if (!transcriber) throw lastErr;
  post({ type: 'ready' });
}

/** Any sample rate → 16 kHz (linear interpolation, continuous from one message to the next). */
function to16k(data, rate) {
  if (rate === RATE || !data.length) return data;
  // positions count in [last sample of the previous message, ...data]
  if (resample.rate !== rate) resample = { rate, pos: 1, last: data[0] };
  const step = rate / RATE, last = resample.last;
  const at = (i) => (i === 0 ? last : data[i - 1]);
  const out = new Float32Array(Math.ceil(data.length / step) + 1);
  let n = 0, pos = resample.pos;
  for (; pos < data.length; pos += step) {
    const i = Math.floor(pos), f = pos - i;
    out[n++] = at(i) + (at(i + 1) - at(i)) * f;
  }
  resample.pos = pos - data.length;
  resample.last = data[data.length - 1];
  return out.subarray(0, n);
}

function rms(a, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

function append(samples) {
  const next = new Float32Array(buf.length + samples.length);
  next.set(buf); next.set(samples, buf.length);
  buf = next;
  while (buf.length >= MAX_CHUNK) {
    // cut at the quietest 50 ms between MIN and MAX, so words are not split in two
    let cut = MAX_CHUNK, best = Infinity;
    for (let at = MIN_CHUNK; at + FRAME <= MAX_CHUNK; at += FRAME) {
      const e = rms(buf, at, at + FRAME);
      if (e < best) { best = e; cut = at + FRAME / 2; }
    }
    cut = Math.round(cut);
    const piece = buf.slice(0, cut);
    buf = buf.slice(cut);
    if (rms(piece) >= SILENCE_RMS) queue.push(piece);
    else post({ type: 'quiet' });
  }
  let waiting = queue.reduce((n, p) => n + p.length, 0);
  if (waiting > MAX_BACKLOG) {
    while (queue.length > 1 && waiting > MAX_BACKLOG / 2) waiting -= queue.shift().length;
    post({ type: 'lag' });
  }
  pump();
}

function clean(text) {
  text = String(text || '').replace(/\s+/g, ' ').replace(/\[[^\]]*\]|\([^)]*\)|♪/g, '').trim();
  return HALLUCINATIONS.some(r => r.test(text)) ? '' : text;
}

let lastText = '';
async function pump() {
  if (busy || !transcriber || !queue.length) return;
  busy = true;
  const gen = generation;
  const piece = queue.shift();
  const t0 = performance.now();
  try {
    const out = await transcriber(piece, { language: 'italian', task: 'transcribe', max_new_tokens: 96 });
    const text = clean(out?.text);
    // Whisper sometimes repeats the previous piece word for word on a pause
    if (gen === generation && text && text !== lastText) {
      lastText = text;
      post({ type: 'text', text, dur: piece.length / RATE, took: (performance.now() - t0) / 1000 });
    }
  } catch (e) {
    post({ type: 'error', message: String(e?.message || e) });
  }
  busy = false;
  pump();
}

self.onmessage = async ({ data: m }) => {
  if (m.type === 'load') {
    if (!loading) loading = load(m).catch((e) => { loading = null; post({ type: 'error', fatal: true, message: String(e?.message || e) }); });
    return;
  }
  if (m.type === 'audio') { append(to16k(m.data, m.rate)); return; }
  if (m.type === 'reset') {
    generation++;
    buf = new Float32Array(0); queue = []; lastText = '';
    resample = { rate: 0, pos: 0, last: 0 };
  }
};
