// Live TV from M3U playlists + XMLTV programme guide.
// Paths: ""                  -> playlists
//        "p/<i>"             -> groups of playlist i (or channels)
//        "p/<i>/g/<group>"   -> channels of a group

const cache = new Map();          // url -> { at, data }
const TTL = 30 * 60 * 1000;

// Public playlists of Italian free-to-air channels, usable with no setup.
// Both projects list only streams that broadcasters make freely available.
const PRESETS = [
  { name: 'Digitale terrestre Italia (Free-TV)', url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_italy.m3u8', note: 'Solo canali gratuiti in chiaro, stream ufficiali' },
  { name: 'Canali italiani (iptv-org)', url: 'https://iptv-org.github.io/iptv/countries/it.m3u', note: 'Elenco più ampio, include canali regionali e locali' },
];

// ---------------------------------------------------------------- TGR (Rai regional news)
// Rai streams each region's Rai 3 on its own CDN (tgr<region>-live.akamaized.net). Checked
// 2026-11-25: Bolzano, Trento and Friuli Venezia Giulia (also the Slovenian «FJK» channel) are
// on all day; the other regions are switched on only around their newscasts (~19:00 for the
// 19:30 TG, carrying national Rai 3 until the regional edition starts) — the playlist stays,
// but its chunk list answers 404 in between. Lazio has no stream of its own (scanned).
// The past editions come from rainews.it (each region's «notiziari» page, through the proxy).
const TGR_REGIONS = [
  // [label, rainews slug, live stream name, Akamai id]
  ['Abruzzo', 'abruzzo', 'abruzzo', 2025558],
  ['Basilicata', 'basilicata', 'basilicata', 2025559],
  ['Bolzano (Alto Adige)', 'bolzano', 'bolzano', 2025560, true],
  ['Calabria', 'calabria', 'calabria', 2025561],
  ['Campania', 'campania', 'campania', 2025562],
  ['Emilia-Romagna', 'emiliaromagna', 'emiliaromagna', 2025563],
  ['Friuli Venezia Giulia', 'fvg', 'friuli', 2025564, true],
  ['FJK (in sloveno)', 'fjk', 'friulibis', 2025579, true],
  ['Lazio', 'lazio', '', 0],
  ['Liguria', 'liguria', 'liguria', 2025565],
  ['Lombardia', 'lombardia', 'lombardia', 2025566],
  ['Marche', 'marche', 'marche', 2025567],
  ['Molise', 'molise', 'molise', 2025568],
  ['Piemonte', 'piemonte', 'piemonte', 2025569],
  ['Puglia', 'puglia', 'puglia', 2025570],
  ['Sardegna', 'sardegna', 'sardegna', 2025572],
  ['Sicilia', 'sicilia', 'sicilia', 2025573],
  ['Toscana', 'toscana', 'toscana', 2025574],
  ['Trento', 'trento', 'trento', 2025575, true],
  ['Umbria', 'umbria', 'umbria', 2025576],
  ["Valle d'Aosta", 'vda', 'valdaosta', 2025577],
  ['Veneto', 'veneto', 'veneto', 2025578],
].map(([name, slug, live, id, allDay]) => ({ name, slug, live, id, allDay: !!allDay }));
const TGR_HOURS = 'alle 14:00 e alle 19:30, nei feriali anche Buongiorno Regione alle 7:40';
const tgrStream = (r) => `https://tgr${r.live}-live.akamaized.net/hls/live/${r.id}/tgr${r.live}/tgr${r.live}/playlist.m3u8`;
const tgrPage = (r) => 'https://www.rainews.it/tgr/' + r.slug;

/** Is the region's stream on air now? true / false / null (could not tell). Kept a minute. */
const onAirCache = new Map();
async function tgrOnAir(r, ctx) {
  const hit = onAirCache.get(r.live);
  if (hit && Date.now() - hit.at < 60e3) return hit.on;
  let on = null;
  try {
    const master = tgrStream(r);
    const text = await ctx.http.text(master, { timeout: 6000 });
    const line = text.split(/\r?\n/).find(l => l && !l.startsWith('#'));
    if (line) {
      try { await ctx.http.text(new URL(line, master).href, { timeout: 6000 }); on = true; }
      catch (e) { if (/HTTP 40[34]/.test(e.message)) on = false; }
    }
  } catch (e) { if (/HTTP 40[34]/.test(e.message)) on = false; }
  onAirCache.set(r.live, { on, at: Date.now() });
  return on;
}

function tgrLiveItem(r, on) {
  const sub = r.allDay ? (on === false ? 'Non risponde in questo momento' : 'Sempre acceso: Rai 3 con i programmi regionali')
    : on === true ? '● Acceso ora · trasmette Rai 3, il TG regionale va in onda ' + TGR_HOURS
      : on === false ? 'Spento ora · si accende durante il TG regionale (' + TGR_HOURS + ')'
        : 'Si accende durante il TG regionale (' + TGR_HOURS + ')';
  return {
    key: 'tgr:' + r.live,
    label: 'TGR ' + r.name + (on === true && !r.allDay ? ' ●' : ''),
    subtitle: sub,
    note: 'Solo dall\'Italia',
    url: tgrStream(r),
    mime: 'application/vnd.apple.mpegurl',
    playable: true, live: true, type: 'video', resolve: true,
    tgr: r.live,
  };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeHtml = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENT[e.toLowerCase()] ?? m)));

/** The editions listed on a region's «notiziari» page of rainews.it (newest first). */
const editionsCache = new Map();
async function tgrEditions(r, ctx) {
  const hit = editionsCache.get(r.slug);
  if (hit && Date.now() - hit.at < 15 * 60e3) return hit.list;
  if (!ctx.http.proxied('https://www.rainews.it/').includes('url=')) return null; // no proxy set
  const html = decodeHtml(await ctx.http.text(tgrPage(r) + '/notiziari', { viaProxy: true, timeout: 30000 }));
  const seen = new Set();
  const list = [];
  for (const chunk of html.split('{"uniquename":"ContentItem-').slice(1)) {
    const get = (k) => { const m = new RegExp('"' + k + '":"([^"]*)"').exec(chunk); return m ? m[1] : ''; };
    const url = (/"content_url":"(https:\/\/mediapolisvod\.rai\.it\/relinker\/[^"]+)"/.exec(chunk) || [])[1];
    const link = get('link');
    const kind = get('data_type');
    if (!url || !link.startsWith('/tgr/' + r.slug + '/notiziari/') || seen.has(link)) continue;
    seen.add(link);
    const show = (/"broadcast":\{"name":"([^"]*)"/.exec(chunk) || [])[1] || 'TGR';
    const hour = (/"hour":"([^"]*)"/.exec(chunk) || [])[1] || '';
    const iso = get('edizioneIso') || get('dateIso') || get('date');
    list.push({ show, hour, iso, url, kind, duration: get('duration'), page: 'https://www.rainews.it' + link });
  }
  list.sort((a, b) => String(b.iso).localeCompare(String(a.iso)));
  editionsCache.set(r.slug, { list, at: Date.now() });
  return list;
}

function editionItem(r, e) {
  const d = e.iso ? new Date(e.iso.replace(/\+0000$/, 'Z')) : null;
  const day = d && !isNaN(d) ? d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Rome' }) : '';
  const audio = e.kind === 'audio';
  return {
    label: (e.show === 'TGR' ? 'TGR ' + r.name : e.show) + (e.hour ? ' delle ' + e.hour : ''),
    subtitle: [day, e.duration && e.duration.replace(/^00:/, '') + (audio ? ' · solo audio' : '')].filter(Boolean).join(' · '),
    url: e.url,
    mime: audio ? undefined : 'application/vnd.apple.mpegurl',
    playable: true, type: audio ? 'audio' : 'video', resolve: false,
    info: { plot: 'Da rainews.it' },
  };
}

async function tgrList(path, ctx) {
  if (path === 'tgr') {
    const lives = TGR_REGIONS.filter(r => r.live);
    const states = await Promise.all(lives.map(r => Promise.race([tgrOnAir(r, ctx), new Promise(res => setTimeout(() => res(null), 7000))])));
    const n = states.filter((on, i) => on && !lives[i].allDay).length;
    return {
      view: 'list',
      message: n ? `Canali regionali accesi ora: ${n} (●). Rai li accende circa mezz'ora prima del TG: fino all'inizio trasmettono Rai 3 nazionale.` : 'I canali regionali si accendono solo durante i TG (' + TGR_HOURS + '); Bolzano, Trento e Friuli Venezia Giulia sono sempre accesi.',
      items: [
        { label: 'Ultime edizioni (on demand)', subtitle: 'I notiziari già andati in onda, regione per regione · da rainews.it', path: 'tgr/ed' },
        ...lives.map((r, i) => tgrLiveItem(r, states[i])),
      ],
    };
  }
  if (path === 'tgr/ed') {
    return { view: 'list', items: TGR_REGIONS.map(r => ({ label: 'TGR ' + r.name, subtitle: 'Ultime edizioni', path: 'tgr/ed/' + r.slug })) };
  }
  const r = TGR_REGIONS.find(x => 'tgr/ed/' + x.slug === path);
  if (!r) return { view: 'list', items: [] };
  let list = null, problem = '';
  try { list = await tgrEditions(r, ctx); } catch (e) { problem = e.message; }
  const site = { label: 'Apri la pagina su rainews.it', subtitle: tgrPage(r), external: tgrPage(r), playable: true, type: 'video' };
  if (list === null && !problem) {
    return { view: 'list', message: 'Per elencare le edizioni serve il proxy (Impostazioni › Proxy): rainews.it non si lascia leggere da altri siti.', items: [site] };
  }
  if (!list || !list.length) {
    return { view: 'list', message: problem ? 'rainews.it non ha risposto: ' + problem : 'Nessuna edizione trovata su rainews.it.', items: [site] };
  }
  return { view: 'list', items: [...list.slice(0, 40).map(e => editionItem(r, e)), site] };
}

function playlistsFromSettings(ctx) {
  const presets = ctx.settings.presets === false ? [] : PRESETS.map(p => ({ ...p, preset: true }));
  return [...presets, ...userPlaylists(ctx)];
}

function userPlaylists(ctx) {
  return String(ctx.settings.playlists || '')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map((l, i) => {
      const parts = l.split('|').map(s => s.trim());
      const url = parts.length > 1 ? parts.slice(1).join('|') : parts[0];
      const name = parts.length > 1 ? parts[0] : `La mia playlist ${i + 1}`;
      return { name, url };
    });
}

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}

function attrs(s) {
  const out = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** Parse an extended M3U playlist. */
function parseM3U(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = lines[0] && lines[0].startsWith('#EXTM3U') ? attrs(lines[0]) : {};
  const channels = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf(',');
      const meta = attrs(line.slice(0, comma > 0 ? comma : line.length));
      cur = {
        name: (comma > 0 ? line.slice(comma + 1) : '').trim() || meta['tvg-name'] || 'Canale',
        id: meta['tvg-id'] || '',
        logo: meta['tvg-logo'] || '',
        chno: meta['tvg-chno'] || meta['channel-number'] || '',
        group: meta['group-title'] || 'Altri',
        headers: {},
      };
    } else if (line.startsWith('#EXTVLCOPT:') && cur) {
      const [k, ...v] = line.slice(11).split('=');
      const val = v.join('=');
      if (/http-referr?er/i.test(k)) cur.headers.Referer = val;
      if (/http-user-agent/i.test(k)) cur.headers['User-Agent'] = val;
    } else if (line.startsWith('#EXTGRP:') && cur) {
      cur.group = line.slice(8).trim() || cur.group;
    } else if (!line.startsWith('#')) {
      const ch = cur || { name: line.split('/').pop(), id: '', logo: '', group: 'Altri', headers: {} };
      ch.url = line;
      channels.push(ch);
      cur = null;
    }
  }
  assignKeys(channels);
  return { epg: header['url-tvg'] || header['x-tvg-url'] || '', channels };
}

// A stable key for each channel, so the app can keep the user's order when the playlist is
// updated: the playlist's channel code (tvg-id) or else the name without quality marks;
// duplicates get #2, #3… in playlist order.
function normName(name) {
  return String(name).replace(/[ⒼⓎ]/g, '').replace(/\s*\((?:\d{3,4}p|hd|sd|fhd|uhd|4k)\)|\s+(?:hd|fhd|sd|uhd|4k)$/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function assignKeys(channels) {
  const seen = new Map();
  for (const c of channels) {
    const base = c.id ? 'id:' + c.id.toLowerCase() : 'n:' + normName(c.name);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    c.key = n > 1 ? base + '#' + n : base;
  }
}

// ---------------------------------------------------------------- playlist download
// The last good copy of each playlist is kept (ctx.store): if a download fails, or the new
// list looks broken (empty, or less than half the channels), the old one stays in use.
// Downloaded at the first use after start-up, then every 6 hours, or on request (ctx.refresh).
const REFRESH = 6 * 3600 * 1000;
const RETRY = 10 * 60 * 1000;
const lists = new Map(); // url -> { at, data, meta }

function diffLists(prev, next) {
  const before = new Map(prev.channels.map(c => [c.key, c.url]));
  const after = new Map(next.channels.map(c => [c.key, c.url]));
  let added = 0, removed = 0, moved = 0;
  for (const [k, u] of after) { if (!before.has(k)) added++; else if (before.get(k) !== u) moved++; }
  for (const k of before.keys()) if (!after.has(k)) removed++;
  return { added, removed, moved };
}

function when(t) {
  const d = new Date(t);
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) + ' alle ' + hhmm(t);
}

async function loadPlaylist(url, ctx) {
  const mem = lists.get(url);
  if (mem && !ctx.refresh && Date.now() - mem.at < REFRESH) return mem;
  let prev = mem ? { at: mem.savedAt, data: mem.data } : null;
  if (!prev && ctx.store) {
    const saved = await ctx.store.get('m3u:' + url).catch(() => null);
    if (saved && saved.text) prev = { at: saved.at, data: parseM3U(saved.text) };
  }
  let text = '', data = null, problem = '';
  try {
    text = await ctx.http.text(url, { timeout: 20000 });
    data = parseM3U(text);
    if (!data.channels.length) problem = 'la lista scaricata è vuota';
    else if (prev && data.channels.length < prev.data.channels.length / 2) problem = `la lista scaricata ha solo ${data.channels.length} canali invece di ${prev.data.channels.length}`;
  } catch (e) {
    problem = e.message || String(e);
  }
  if (problem) {
    if (!prev) throw new Error('Impossibile scaricare la playlist: ' + problem);
    const entry = { at: Date.now() - REFRESH + RETRY, savedAt: prev.at, data: prev.data,
      meta: { updatedAt: prev.at, notice: `Non ho potuto aggiornare la lista (${problem}): uso la copia del ${when(prev.at)}.`, warn: true } };
    lists.set(url, entry);
    return entry;
  }
  const now = Date.now();
  if (ctx.store) await ctx.store.set('m3u:' + url, { at: now, text }).catch(() => {});
  let notice = '';
  if (prev) {
    const d = diffLists(prev.data, data);
    const parts = [d.added && `${d.added} ${d.added === 1 ? 'nuovo' : 'nuovi'}`, d.removed && `${d.removed} ${d.removed === 1 ? 'rimosso' : 'rimossi'}`, d.moved && `${d.moved} con indirizzo cambiato`].filter(Boolean);
    if (parts.length) notice = 'Lista aggiornata: ' + parts.join(', ') + '.';
    else if (ctx.refresh) notice = 'Lista aggiornata: nessun cambiamento.';
  }
  const entry = { at: now, savedAt: now, data, meta: { updatedAt: now, notice, warn: false } };
  lists.set(url, entry);
  return entry;
}

// ---------------------------------------------------------------- EPG
const EPG_WAIT = 5000;

// url-tvg / x-tvg-url may hold a comma separated list (Free-TV lists ~100 guides, one per
// country): use one, preferring the Italian guide.
function pickEpgUrl(value) {
  const urls = String(value || '').split(/[,\s]+/).map(u => u.trim()).filter(u => /^https?:\/\//i.test(u));
  if (urls.length <= 1) return urls[0] || '';
  return urls.find(u => /(^|[_\-/.])it\d*\.xml/i.test(u.split('/').pop())) || urls.find(u => /ital/i.test(u)) || urls[0];
}

function xmltvDate(s) {
  // 20261119153000 +0100
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s || '');
  if (!m) return 0;
  const [, y, mo, d, h, mi, se = '00', tz = '+0000'] = m;
  const off = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3)));
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - off * 60000;
}

async function fetchMaybeGz(url, ctx) {
  const res = await ctx.http.get(url, { type: 'response', timeout: 45000 });
  const gz = /\.gz(\?|$)/i.test(url);
  if (gz && typeof DecompressionStream === 'function') {
    return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
  }
  return res.text();
}

async function loadEpg(url, ctx) {
  if (!url) return null;
  return cached('epg:' + url, async () => {
    const src = await fetchMaybeGz(url, ctx);
    const now = Date.now();
    const horizon = now + 6 * 3600 * 1000;
    const byChannel = new Map();
    const re = /<programme\s([^>]*)>([\s\S]*?)<\/programme>/g;
    let m;
    while ((m = re.exec(src))) {
      const a = ctx.xml.attrs(m[1]);
      const stop = xmltvDate(a.stop);
      const start = xmltvDate(a.start);
      if (stop < now || start > horizon) continue;
      const list = byChannel.get(a.channel) || [];
      list.push({ start, stop, title: ctx.xml.text(m[2], 'title'), desc: ctx.xml.text(m[2], 'desc') });
      byChannel.set(a.channel, list);
    }
    for (const l of byChannel.values()) l.sort((x, y) => x.start - y.start);
    return byChannel;
  }).catch(e => { ctx.log('EPG non disponibile', e.message); return null; });
}

function hhmm(t) { return new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }); }

function nowNext(epg, id) {
  if (!epg || !id) return null;
  const list = epg.get(id);
  if (!list) return null;
  const now = Date.now();
  const i = list.findIndex(p => p.start <= now && p.stop > now);
  if (i < 0) return null;
  return { now: list[i], next: list[i + 1] };
}

// Italian DTT channel numbers (LCN), used when the playlist has no tvg-chno, so that
// "5" on the remote is Canale 5 as on a TV set.
const LCN = {
  'rai 1': 1, 'rai 2': 2, 'rai 3': 3, 'rete 4': 4, 'rete4': 4, 'canale 5': 5, 'canale5': 5, 'italia 1': 6, 'italia1': 6,
  'la7': 7, 'la 7': 7, 'tv8': 8, 'tv 8': 8, 'nove': 9, '20': 20, '20 mediaset': 20, 'mediaset 20': 20,
  'rai 4': 21, 'iris': 22, 'rai 5': 23, 'rai movie': 24, 'rai premium': 25, 'cielo': 26, 'twentyseven': 27, '27 twentyseven': 27,
  'tv2000': 28, 'tv 2000': 28, 'la7 cinema': 29, 'la7d': 29, 'la 5': 30, 'la5': 30, 'real time': 31, 'cine34': 34, 'cine 34': 34,
  'focus': 35, 'top crime': 39, 'boing': 40, 'rai gulp': 42, 'rai yoyo': 43, 'rai news 24': 48, 'rainews24': 48, 'rai news24': 48,
  'dmax': 52, 'rai storia': 54, 'rai scuola': 57, 'rai sport': 58,
};

function channelNumber(ch) {
  const n = parseInt(ch.chno, 10);
  if (n > 0) return n;
  const key = ch.name.replace(/[ⒼⓎ]/g, '').replace(/\s*\((?:\d{3,4}p|hd|sd|fhd)\)|\s+(?:hd|fhd|sd)$/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return LCN[key] || undefined;
}

const YOUTUBE = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i;

function toItem(ch, epg) {
  const nn = nowNext(epg, ch.id);
  // Free-TV marks: Ⓖ = geo-blocked (Italy only), Ⓨ = YouTube live channel
  const geo = /Ⓖ/.test(ch.name);
  const youtube = /Ⓨ/.test(ch.name) || YOUTUBE.test(ch.url);
  const notes = [geo ? 'Solo dall\'Italia' : '', youtube ? 'Si apre in YouTube' : ''].filter(Boolean);
  const sub = [
    ...notes,
    nn ? `Ora: ${nn.now.title} (fino alle ${hhmm(nn.now.stop)})` + (nn.next ? ` · Poi: ${nn.next.title}` : '') : (notes.length ? '' : ch.group),
  ].filter(Boolean).join(' · ');
  if (youtube) {
    return { key: ch.key, guide: ch.id ? { id: ch.id } : undefined, note: notes.join(' · ') || undefined, label: ch.name.replace(/\s*[ⒼⓎ]/g, '').trim(), subtitle: sub, thumb: /^https:/.test(ch.logo) ? ch.logo : '', external: ch.url, playable: true, live: true, type: 'video' };
  }
  return {
    key: ch.key,
    guide: ch.id ? { id: ch.id } : undefined,
    note: notes.join(' · ') || undefined, // shown next to the TV guide line
    label: ch.name.replace(/\s*[ⒼⓎ]/g, '').trim(),
    number: channelNumber(ch),
    subtitle: sub,
    thumb: /^https:/.test(ch.logo) ? ch.logo : '',
    url: ch.url,
    headers: Object.keys(ch.headers).length ? ch.headers : undefined,
    playable: true,
    live: true,
    type: /\.(mp3|aac|ogg)(\?|$)/i.test(ch.url) ? 'audio' : 'video',
    // IPTV links without a media extension (e.g. broadcaster redirectors) are almost always HLS
    mime: /\.(mp4|m4v|webm|mp3|aac|ogg|ts)(\?|$)/i.test(ch.url) ? undefined : 'application/vnd.apple.mpegurl',
    info: { plot: nn ? nn.now.desc : '' },
    resolve: Object.keys(ch.headers).length > 0,
  };
}

async function context(i, ctx) {
  const pls = playlistsFromSettings(ctx);
  const pl = pls[i];
  if (!pl) throw new Error('Playlist non trovata');
  const entry = await loadPlaylist(pl.url, ctx);
  const data = entry.data;
  // The guide is a bonus: never keep the channel list waiting for it. If it is not
  // ready within a few seconds the list shows without it and the guide keeps loading
  // in the background for the next visit.
  // Salotto's own guide of Italian channels (epg/it.json, refreshed every few hours) is
  // applied by the app; an XMLTV file is only read here when the user sets one, or for
  // their own playlists that name one (the public playlists point to a 13 MB listing).
  const epgUrl = pickEpgUrl(ctx.settings.epg || (pl.preset ? '' : data.epg));
  const epg = await Promise.race([loadEpg(epgUrl, ctx), new Promise(r => setTimeout(() => r(null), EPG_WAIT))]);
  return { pl, data, epg, meta: entry.meta };
}

/** Update time, and the update summary or warning once (the first listing after it). */
function listMeta(meta, pl, group) {
  const out = { updatedAt: meta.updatedAt, listId: 'pl:' + pl.url + (group != null ? '|g:' + group : '') };
  if (meta.notice) { out.notice = meta.notice; out.noticeKind = meta.warn ? 'warn' : 'info'; out.noticeOnce = true; if (!meta.warn) meta.notice = ''; }
  return out;
}

addon.register({
  async list(path, ctx) {
    const pls = playlistsFromSettings(ctx);
    if (path === 'tgr' || path.startsWith('tgr/')) return tgrList(path, ctx);
    if (!path) {
      if (!pls.length) {
        return {
          view: 'list',
          message: 'Nessuna playlist configurata. Apri le impostazioni dell\'add-on e incolla l\'indirizzo di una playlist M3U.',
          items: [{ label: 'Impostazioni dell\'add-on', action: 'settings' }],
        };
      }
      if (pls.length === 1) path = 'p/0';
      else {
        return {
          view: 'list',
          items: [
            ...pls.map((p, i) => ({ label: p.name, subtitle: p.note || p.url, path: 'p/' + i })),
            ...(ctx.settings.presets === false ? [] : [{ label: 'TGR regionali (Rai)', subtitle: 'Il TG della tua regione in diretta quando va in onda, e le ultime edizioni', path: 'tgr' }]),
            { label: 'Aggiungi una playlist…', subtitle: 'Impostazioni dell\'add-on', action: 'settings' },
          ],
        };
      }
    }
    const parts = path.split('/');
    const i = Number(parts[1]);
    const { pl, data, epg, meta } = await context(i, ctx);
    const group = parts[2] === 'g' ? decodeURIComponent(parts.slice(3).join('/')) : null;
    if (group === null && ctx.settings.groups !== false) {
      const groups = new Map();
      for (const ch of data.channels) {
        for (const g of ch.group.split(';')) groups.set(g.trim() || 'Altri', (groups.get(g.trim() || 'Altri') || 0) + 1);
      }
      if (groups.size > 1) {
        return {
          view: 'list',
          ...listMeta(meta, pl, null),
          items: [
            { label: 'Cerca un canale…', action: 'search' },
            { label: 'Tutti i canali', subtitle: data.channels.length + ' canali', path: `p/${i}/g/*` },
            ...[...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([g, n]) => ({ label: g, subtitle: n + ' canali', path: `p/${i}/g/${encodeURIComponent(g)}` })),
          ],
        };
      }
    }
    const chans = group && group !== '*'
      ? data.channels.filter(c => c.group.split(';').map(s => s.trim() || 'Altri').includes(group))
      : data.channels;
    return { view: 'list', ...listMeta(meta, pl, group), items: chans.map(c => toItem(c, epg)) };
  },

  async search(text, ctx) {
    const q = text.toLowerCase();
    const pls = playlistsFromSettings(ctx);
    const out = [];
    for (let i = 0; i < pls.length; i++) {
      const { data, epg } = await context(i, ctx);
      for (const c of data.channels) if (c.name.toLowerCase().replace(/[ⒼⓎ]/g, '').includes(q)) out.push(toItem(c, epg));
    }
    return { view: 'list', items: out };
  },

  // Channels that need special headers (Referer, User-Agent) must go through the proxy.
  async resolve(item, ctx) {
    if (item.tgr) {
      const r = TGR_REGIONS.find(x => x.live === item.tgr);
      if (r && !r.allDay) {
        onAirCache.delete(r.live);
        if (await tgrOnAir(r, ctx) === false) {
          throw new Error(`TGR ${r.name} non è in onda adesso: Rai accende il canale regionale solo durante il TG (${TGR_HOURS}). Le edizioni già trasmesse sono in «Ultime edizioni».`);
        }
      }
      return { url: item.url, mime: item.mime };
    }
    return { url: item.url, mime: item.mime, headers: item.headers, proxy: !!item.headers };
  },
});
