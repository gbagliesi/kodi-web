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

// Regional news (TGR) has no open feed: these open the edition page on rainews.it.
const TGR = [
  { label: 'TGR Toscana', url: 'https://www.rainews.it/tgr/toscana' },
  { label: 'TGR Puglia', url: 'https://www.rainews.it/tgr/puglia' },
];

function playlistsFromSettings(ctx) {
  const presets = ctx.settings.presets === false ? [] : PRESETS;
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
  return { epg: header['url-tvg'] || header['x-tvg-url'] || '', channels };
}

async function loadPlaylist(url, ctx) {
  return cached('m3u:' + url, async () => parseM3U(await ctx.http.text(url)));
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
    return { label: ch.name.replace(/\s*[ⒼⓎ]/g, '').trim(), subtitle: sub, thumb: /^https:/.test(ch.logo) ? ch.logo : '', external: ch.url, playable: true, live: true, type: 'video' };
  }
  return {
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
  const data = await loadPlaylist(pl.url, ctx);
  // The guide is a bonus: never keep the channel list waiting for it. If it is not
  // ready within a few seconds the list shows without it and the guide keeps loading
  // in the background for the next visit.
  const epgUrl = pickEpgUrl(ctx.settings.epg || data.epg);
  const epg = await Promise.race([loadEpg(epgUrl, ctx), new Promise(r => setTimeout(() => r(null), EPG_WAIT))]);
  return { pl, data, epg };
}

addon.register({
  async list(path, ctx) {
    const pls = playlistsFromSettings(ctx);
    if (path === 'tgr') {
      return { view: 'list', items: TGR.map(t => ({ label: t.label, subtitle: 'Ultima edizione · si apre su rainews.it', external: t.url, playable: true, type: 'video' })) };
    }
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
            ...(ctx.settings.presets === false ? [] : [{ label: 'TGR regionali (Rai)', subtitle: TGR.map(t => t.label.replace('TGR ', '')).join(', ') + ' · ultime edizioni', path: 'tgr' }]),
            { label: 'Aggiungi una playlist…', subtitle: 'Impostazioni dell\'add-on', action: 'settings' },
          ],
        };
      }
    }
    const parts = path.split('/');
    const i = Number(parts[1]);
    const { data, epg } = await context(i, ctx);
    const group = parts[2] === 'g' ? decodeURIComponent(parts.slice(3).join('/')) : null;
    if (group === null && ctx.settings.groups !== false) {
      const groups = new Map();
      for (const ch of data.channels) {
        for (const g of ch.group.split(';')) groups.set(g.trim() || 'Altri', (groups.get(g.trim() || 'Altri') || 0) + 1);
      }
      if (groups.size > 1) {
        return {
          view: 'list',
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
    return { view: 'list', items: chans.map(c => toItem(c, epg)) };
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
  async resolve(item) {
    return { url: item.url, mime: item.mime, headers: item.headers, proxy: !!item.headers };
  },
});
