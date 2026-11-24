// TV guide for live channels. The Pages workflow publishes epg/it.json every few hours
// (built by tools/build-epg.mjs from a public XMLTV listing of Italian channels); here we
// load it and find the programmes of a channel by its playlist code (tvg-id) or name.

const URL_ = new URL('../epg/it.json', import.meta.url).href; // also from remote/
const MAX_AGE = 30 * 60 * 1000;
let data = null, loadedAt = 0, pending = null;
const listeners = new Set();

/** Same rule as tools/build-epg.mjs (keep the two in sync). */
export function norm(s) {
  return String(s || '')
    .replace(/\.(it|sm|va|ch|fr|de)$/i, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[ⒼⓎⓈ]/g, '')
    .replace(/(\s{2,}|\.\.)\d+$/, '')
    .replace(/[\s.]*\((?:\d{3,4}p|hd|sd|fhd|uhd|4k)\)$/i, '')
    .replace(/[\s.]+(?:hd|fhd|sd|uhd)$/i, '')
    .toLowerCase().replace(/[^a-z0-9+]/g, '');
}

/** Loads (or refreshes) the guide; resolves to true when there is one. Never throws. */
export function load() {
  if (data && Date.now() - loadedAt < MAX_AGE) return Promise.resolve(true);
  if (pending) return pending;
  pending = fetch(URL_, { cache: 'no-cache' })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      if (j && j.ch) { data = j; loadedAt = Date.now(); byItem = new WeakMap(); listeners.forEach(f => { try { f(); } catch { /* ignore */ } }); }
      return !!data;
    })
    .catch(() => !!data)
    .finally(() => { pending = null; });
  return pending;
}

/** Waits for the guide at most ms milliseconds (the page never waits longer for it). */
export function ready(ms = 2500) {
  return Promise.race([load(), new Promise(r => setTimeout(() => r(!!data), ms))]);
}

export const onUpdate = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const available = () => !!data;
export const generatedAt = () => (data ? data.generated * 1000 : 0);

let byItem = new WeakMap();

/** The guide channel of a playlist item: { id, name, p: [[start, stop, title, desc, sub, cat]] } or null. */
export function channelOf(item) {
  if (!data || !item || !item.live) return null;
  if (byItem.has(item)) return byItem.get(item);
  const g = item.guide || {};
  const keys = [g.id, String(item.key || '').replace(/^(id|n):/, '').replace(/#\d+$/, ''), g.name, item.label].filter(Boolean);
  let id = null;
  for (const k of keys) { if (data.ch[k]) { id = k; break; } }
  if (!id) for (const k of keys) { const a = data.alias[norm(k)]; if (a) { id = a; break; } }
  const res = id ? { id, name: data.ch[id].n, p: data.ch[id].p } : null;
  byItem.set(item, res);
  return res;
}

const prog = (p) => p && { start: p[0] * 1000, stop: p[1] * 1000, title: p[2], desc: p[3] || '', sub: p[4] || '', cat: p[5] || '' };

/** Programmes of a channel overlapping [from, to) (ms). */
export function programmes(item, from, to) {
  const c = channelOf(item);
  if (!c) return [];
  return c.p.filter(p => p[1] * 1000 > from && p[0] * 1000 < to).map(prog);
}

/** { now, next } for a channel at time t (ms), or null. */
export function nowNext(item, t = Date.now()) {
  const c = channelOf(item);
  if (!c) return null;
  const s = t / 1000;
  const i = c.p.findIndex(p => p[0] <= s && p[1] > s);
  if (i < 0) {
    const n = c.p.find(p => p[0] > s);
    return n ? { now: null, next: prog(n) } : null;
  }
  return { now: prog(c.p[i]), next: prog(c.p[i + 1]) };
}

export const hhmm = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

/** One line for lists: "Ora: Tg1 (fino alle 20:30) · Poi: Affari tuoi". */
export function nowLine(item) {
  const nn = nowNext(item);
  if (!nn) return '';
  if (!nn.now) return `Alle ${hhmm(nn.next.start)}: ${nn.next.title}`;
  return `Ora: ${nn.now.title} (fino alle ${hhmm(nn.now.stop)})` + (nn.next ? ` · Poi: ${nn.next.title}` : '');
}

/** 0–1, how much of the programme has gone. */
export const progress = (p, t = Date.now()) => Math.min(1, Math.max(0, (t - p.start) / (p.stop - p.start)));
