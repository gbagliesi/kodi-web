// Builds the TV guide the app uses for Italian channels: downloads a public XMLTV guide,
// keeps the next hours of programmes and writes a compact JSON (a few hundred KB instead of
// a 13 MB XML that a Fire Stick would have to download through the proxy and parse).
// Run by the Pages workflow every few hours:  node tools/build-epg.mjs <out.json> [xmltv-url…]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = process.argv[2] || 'epg/it.json';
const SOURCES = process.argv.slice(3).length ? process.argv.slice(3) : [
  // TV listings published by epgshare01 (the guide the Free-TV playlist itself points to).
  'https://epgshare01.online/epgshare01/epg_ripper_IT1.xml.gz',
];
const BEFORE = 3 * 3600, AFTER = 30 * 3600, DESC = 900;

/** Same rule as the add-on (keep the two in sync): lower case, no accents, no quality or
 *  broadcast-number marks, letters and digits only. */
function norm(s) {
  return String(s || '')
    .replace(/\.(it|sm|va|ch|fr|de)$/i, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[ⒼⓎⓈ]/g, '')
    .replace(/(\s{2,}|\.\.)\d+$/, '')
    .replace(/[\s.]*\((?:\d{3,4}p|hd|sd|fhd|uhd|4k)\)$/i, '')
    .replace(/[\s.]+(?:hd|fhd|sd|uhd)$/i, '')
    .toLowerCase().replace(/[^a-z0-9+]/g, '');
}

const decode = (s) => String(s || '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tag = (src, t) => { const m = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i').exec(src); return m ? decode(m[1]) : ''; };
const attrs = (s) => { const o = {}; for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) o[m[1]] = decode(m[2]); return o; };

function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s || '');
  if (!m) return 0;
  const [, y, mo, d, h, mi, se = '00', tz = '+0000'] = m;
  const off = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3)));
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) / 1000 - off * 60;
}

async function download(url) {
  if (!/^https?:/.test(url)) return fs.readFileSync(url, 'utf8'); // local file, for tests
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      return buf.toString('utf8');
    } catch (e) {
      if (attempt >= 3) throw new Error(url + ': ' + e.message);
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
}

const now = Math.floor(Date.now() / 1000);
const ch = {};
for (const url of SOURCES) {
  const xml = await download(url);
  for (const m of xml.matchAll(/<channel\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g)) {
    const id = decode(m[1]);
    ch[id] = ch[id] || { n: tag(m[2], 'display-name') || id, p: [] };
  }
  for (const m of xml.matchAll(/<programme\s([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const a = attrs(m[1]);
    const start = xmltvTime(a.start), stop = xmltvTime(a.stop);
    if (!start || !stop || stop <= now - BEFORE || start >= now + AFTER) continue;
    const c = ch[a.channel] = ch[a.channel] || { n: a.channel, p: [] };
    let desc = tag(m[2], 'desc');
    if (desc.length > DESC) desc = desc.slice(0, DESC - 1).replace(/\s+\S*$/, '') + '…';
    const sub = tag(m[2], 'sub-title'), cat = tag(m[2], 'category');
    // [start, stop, title, description?, episode?, category?] (times in seconds)
    const row = [start, stop, tag(m[2], 'title') || 'Programma'];
    if (desc || sub || cat) row.push(desc);
    if (sub || cat) row.push(sub);
    if (cat) row.push(cat);
    c.p.push(row);
  }
}

// Drop empty channels, sort, remove the duplicates the source sometimes has.
for (const [id, c] of Object.entries(ch)) {
  c.p.sort((x, y) => x[0] - y[0]);
  c.p = c.p.filter((p, i, arr) => i === 0 || p[0] >= arr[i - 1][0] + 60);
  if (!c.p.length) delete ch[id];
}

// Aliases by normalised id and name; when several channels share one, keep the richest.
const alias = {};
const score = (id) => ch[id].p.length + ch[id].p.filter(p => p[3]).length;
for (const id of Object.keys(ch)) {
  for (const k of new Set([norm(id), norm(ch[id].n)])) {
    if (k && (!alias[k] || score(id) > score(alias[k]))) alias[k] = id;
  }
}

const total = Object.values(ch).reduce((n, c) => n + c.p.length, 0);
const min = Number(process.env.EPG_MIN_CHANNELS || 20);
if (Object.keys(ch).length < min) throw new Error(`Guida troppo piccola (${Object.keys(ch).length} canali, ${total} programmi): non la pubblico`);

fs.mkdirSync(path.dirname(out), { recursive: true });
const json = JSON.stringify({ v: 1, generated: now, from: now - BEFORE, to: now + AFTER, source: 'epgshare01', ch, alias });
fs.writeFileSync(out, json);
console.log(`Guida TV: ${Object.keys(ch).length} canali, ${total} programmi, ${(json.length / 1024).toFixed(0)} KB, gzip ${(zlib.gzipSync(json).length / 1024).toFixed(0)} KB`);
