// The sound of an hls.js stream, taken from the pieces hls.js hands to the browser (fragmented
// MP4 with AAC) instead of from the <video>. Safari gives Web Audio only silence for videos fed
// by Media Source, so there the generated subtitles listen here. The AAC frames are wrapped in
// ADTS headers, which every browser can decode with decodeAudioData (no tap or gesture needed),
// and handed out when the video reaches their time, as if heard live.

// ---- MP4 boxes
function boxes(d, from, to, cb) {
  let p = from;
  while (p + 8 <= to) {
    let size = readU32(d, p);
    const type = String.fromCharCode(d[p + 4], d[p + 5], d[p + 6], d[p + 7]);
    let head = 8;
    if (size === 1) { size = readU32(d, p + 8) * 2 ** 32 + readU32(d, p + 12); head = 16; } else if (size === 0) size = to - p;
    if (size < head || p + size > to) break;
    if (cb(type, p + head, p + size, p) === false) return;
    p += size;
  }
}
const readU32 = (d, p) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf']);
function find(d, from, to, path) {
  let out = null;
  boxes(d, from, to, (type, s, e) => {
    if (type !== path[0]) return true;
    if (path.length === 1) { out = [s, e]; return false; }
    out = find(d, s, e, path.slice(1));
    return !out;
  });
  return out;
}

/** AudioSpecificConfig from the init segment's esds → { profile, freq, channels } */
function audioConfig(d) {
  const stsd = find(d, 0, d.length, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  if (!stsd) return null;
  // stsd: version/flags + count, then the sample entry (mp4a: 28 bytes of fields), then its boxes
  let cfg = null;
  boxes(d, stsd[0] + 8, stsd[1], (type, s, e) => {
    if (type !== 'mp4a') return true;
    const esds = find(d, s + 28, e, ['esds']);
    if (!esds) return false;
    // descriptors: 0x03 ES → 0x04 DecoderConfig → 0x05 DecoderSpecificInfo
    let p = esds[0] + 4;
    const end = esds[1];
    const readLen = () => { let n = 0; for (let i = 0; i < 4; i++) { const b = d[p++]; n = (n << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return n; };
    while (p < end) {
      const tag = d[p++], len = readLen();
      if (tag === 0x03) { const flags = d[p + 2]; p += 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x40 ? 1 + d[p + 3] : 0) + (flags & 0x20 ? 2 : 0); continue; }
      if (tag === 0x04) { p += 13; continue; }
      if (tag === 0x05) {
        const objectType = d[p] >> 3;
        const freq = ((d[p] & 7) << 1) | (d[p + 1] >> 7);
        const channels = (d[p + 1] >> 3) & 0xf;
        cfg = { profile: objectType >= 1 && objectType <= 4 ? objectType - 1 : 1, freq, channels: channels || 2 };
        break;
      }
      p += len;
    }
    return false;
  });
  // default sample size for fragments that don't repeat it (moov → mvex → trex)
  const trex = find(d, 0, d.length, ['moov', 'mvex', 'trex']);
  if (cfg && trex) cfg.defaultSize = readU32(d, trex[0] + 16);
  return cfg;
}

/** moof + mdat → the AAC frames as one ADTS stream */
function toAdts(d, cfg) {
  const frames = [];
  let moofStart = -1, sizes = [], dataOffset = null, mdat = null;
  boxes(d, 0, d.length, (type, s, e, start) => {
    if (type === 'moof') {
      moofStart = start;
      const tfhd = find(d, s, e, ['traf', 'tfhd']);
      let defSize = cfg.defaultSize || 0;
      if (tfhd) {
        const flags = readU32(d, tfhd[0]) & 0xffffff;
        let p = tfhd[0] + 8;
        if (flags & 0x01) p += 8;
        if (flags & 0x02) p += 4;
        if (flags & 0x08) p += 4;
        if (flags & 0x10) defSize = readU32(d, p);
      }
      const trun = find(d, s, e, ['traf', 'trun']);
      if (trun) {
        const flags = readU32(d, trun[0]) & 0xffffff;
        const count = readU32(d, trun[0] + 4);
        let p = trun[0] + 8;
        if (flags & 0x01) { dataOffset = readU32(d, p) | 0; p += 4; }
        if (flags & 0x04) p += 4;
        for (let i = 0; i < count; i++) {
          if (flags & 0x100) p += 4;
          let size = defSize;
          if (flags & 0x200) { size = readU32(d, p); p += 4; }
          if (flags & 0x400) p += 4;
          if (flags & 0x800) p += 4;
          sizes.push(size);
        }
      }
    } else if (type === 'mdat') {
      mdat = [s, e];
      let p = dataOffset != null && moofStart >= 0 ? moofStart + dataOffset : s;
      if (p < s || p >= e) p = s;
      for (const size of sizes) {
        if (!size || p + size > e) break;
        frames.push(d.subarray(p, p + size));
        p += size;
      }
      sizes = []; dataOffset = null;
    }
    return true;
  });
  if (!frames.length || !mdat) return null;
  const total = frames.reduce((n, f) => n + f.length + 7, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const f of frames) {
    const len = f.length + 7;
    out[o] = 0xff; out[o + 1] = 0xf1;
    out[o + 2] = (cfg.profile << 6) | (cfg.freq << 2) | (cfg.channels >> 2);
    out[o + 3] = ((cfg.channels & 3) << 6) | (len >> 11);
    out[o + 4] = (len >> 3) & 0xff;
    out[o + 5] = ((len & 7) << 5) | 0x1f;
    out[o + 6] = 0xfc;
    out.set(f, o + 7);
    o += len;
  }
  return out;
}

// ---- following an hls.js instance
/** Remember the audio init segment from the start (the tap may begin later). */
export function watchInit(hls) {
  hls.on(window.Hls.Events.BUFFER_APPENDING, (_, d) => {
    if (d.type === 'audio' && d.data?.length && find(d.data, 0, d.data.length, ['moov'])) hls.__audioInit = d.data;
  });
}

let decoder = null;
const decodeCtx = () => decoder || (decoder = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100));

/**
 * Listen to hls.js's audio. cb(Float32Array, sampleRate) is called as the video plays.
 * Returns a function that stops listening.
 */
export function tapHls(hls, video, cb) {
  const E = window.Hls.Events;
  let cfg = hls.__audioInit ? audioConfig(hls.__audioInit) : null;
  let queue = [];          // [{ start, end, pcm, rate }] decoded, waiting for the video to get there
  let generation = 0;
  const onAppend = (_, d) => {
    if (d.type !== 'audio' || !d.data?.length) return;
    try {
      if (find(d.data, 0, d.data.length, ['moov'])) {
        const c = audioConfig(d.data);
        if (c) cfg = c;
        return;
      }
      if (!cfg) return;
      const adts = toAdts(d.data, cfg);
      if (!adts) return;
      const start = (d.part || d.frag)?.start ?? video.currentTime;
      const gen = generation;
      decodeCtx().decodeAudioData(adts.buffer.slice(0)).then((buf) => {
        if (gen !== generation) return;
        const n = buf.length, ch = buf.numberOfChannels, pcm = new Float32Array(n);
        for (let c = 0; c < ch; c++) { const x = buf.getChannelData(c); for (let i = 0; i < n; i++) pcm[i] += x[i] / ch; }
        queue.push({ start, end: start + buf.duration, pcm, rate: buf.sampleRate });
        queue.sort((a, b) => a.start - b.start);
        if (queue.length > 60) queue = queue.slice(-60);
      }, (e) => console.warn('hls-audio decode', e));
    } catch (e) { console.warn('hls-audio', e); }
  };
  // hand out what the video has reached (a piece is given whole when its start is passed)
  const timer = setInterval(() => {
    if (video.paused) return;
    const t = video.currentTime;
    while (queue.length && queue[0].start <= t) {
      const q = queue.shift();
      if (q.end < t - 10) continue; // long gone (a jump forward)
      cb(q.pcm, q.rate);
    }
  }, 250);
  const onSeek = () => { generation++; queue = queue.filter(q => q.end > video.currentTime); };
  hls.on(E.BUFFER_APPENDING, onAppend);
  video.addEventListener('seeking', onSeek);
  return () => {
    generation++;
    clearInterval(timer);
    queue = [];
    try { hls.off(E.BUFFER_APPENDING, onAppend); } catch { /* destroyed */ }
    video.removeEventListener('seeking', onSeek);
  };
}
