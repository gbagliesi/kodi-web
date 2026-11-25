// YouTube for Salotto: search, trending, live, channels and playlists through the official
// YouTube Data API v3 (the user's own free key), played with YouTube's official embedded
// player (ads included). Nothing is downloaded or extracted: items carry only the video id.
// Without a key: open a YouTube link, and the latest videos of saved channels (official RSS
// feeds, through the proxy).
'use strict';

const API = 'https://www.googleapis.com/youtube/v3/';
const NEED_KEY = 'Per questa sezione serve la chiave API di YouTube: aprila dalle impostazioni dell\'add-on (⚙).';
const CATEGORIES = [['10', 'Musica'], ['20', 'Videogiochi'], ['17', 'Sport'], ['25', 'Notizie'], ['24', 'Intrattenimento'], ['1', 'Film e animazione'], ['23', 'Comici'], ['28', 'Scienza e tecnologia']];

const key = (ctx) => String(ctx.settings.apiKey || '').trim();
const region = (ctx) => ctx.settings.region || 'IT';

// Calls the Data API directly (it allows other sites): the key never goes through the proxy,
// and errors are told in plain Italian without showing the address (it contains the key).
async function api(ctx, endpoint, params) {
  const k = key(ctx);
  if (!k) throw new Error(NEED_KEY);
  const qs = new URLSearchParams({ ...params, key: k });
  let res;
  try {
    res = await fetch(API + endpoint + '?' + qs);
  } catch {
    throw new Error('YouTube non risponde: controlla la connessione.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data.error?.errors?.[0]?.reason || '';
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') throw new Error('Hai finito le unità gratuite di oggi della chiave YouTube (si azzerano alle 9 del mattino, ora italiana). Intanto puoi aprire i tuoi canali salvati.');
    if (res.status === 400 && /key/i.test(reason + (data.error?.message || ''))) throw new Error('La chiave API di YouTube non è valida: ricontrollala nelle impostazioni dell\'add-on.');
    if (res.status === 403) throw new Error('YouTube ha rifiutato la chiave API (' + (reason || 'accesso negato') + '). Controlla che «YouTube Data API v3» sia abilitata e che le restrizioni della chiave includano https://gbagliesi.github.io/*.');
    if (res.status === 404) throw new Error('Non trovato su YouTube.');
    throw new Error('Errore di YouTube (' + res.status + (reason ? ', ' + reason : '') + ').');
  }
  return data;
}

// ---------------------------------------------------------------- formatting
const thumbOf = (t) => (t && (t.maxres || t.standard || t.high || t.medium || t.default) || {}).url || '';

function isoSeconds(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

function count(n) {
  n = Number(n);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',').replace(',0', '') + ' Mrd';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' Mln';
  if (n >= 1e3) return Math.round(n / 1e3) + ' mila';
  return String(n);
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const d = (Date.now() - t) / 86400000;
  if (d < 1 / 24) return 'pochi minuti fa';
  if (d < 1) return Math.floor(d * 24) === 1 ? '1 ora fa' : Math.floor(d * 24) + ' ore fa';
  if (d < 2) return 'ieri';
  if (d < 30) return Math.floor(d) + ' giorni fa';
  if (d < 365) return Math.floor(d / 30) === 1 ? '1 mese fa' : Math.floor(d / 30) + ' mesi fa';
  return Math.floor(d / 365) === 1 ? '1 anno fa' : Math.floor(d / 365) + ' anni fa';
}

const decode = (s) => String(s || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function videoItem(id, sn = {}, extra = {}) {
  const live = sn.liveBroadcastContent === 'live';
  const upcoming = sn.liveBroadcastContent === 'upcoming';
  const views = extra.views ? count(extra.views) + ' visualizzazioni' : '';
  const sub = [live ? '🔴 In diretta' : upcoming ? 'Diretta in arrivo' : '', decode(sn.channelTitle), live ? '' : views, live || upcoming ? '' : ago(sn.publishedAt)].filter(Boolean).join(' · ');
  return {
    id: 'v:' + id,
    label: decode(sn.title) || 'Video',
    subtitle: sub,
    thumb: thumbOf(sn.thumbnails) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    playable: true,
    type: 'video',
    youtube: { video: id, live },
    info: { plot: decode(sn.description), duration: extra.duration || undefined, year: sn.publishedAt ? +sn.publishedAt.slice(0, 4) : undefined },
  };
}

const channelItem = (id, sn = {}) => ({
  id: 'c:' + id, label: decode(sn.title || sn.channelTitle) || 'Canale', subtitle: 'Canale', thumb: thumbOf(sn.thumbnails),
  path: 'ch:' + id, info: { plot: decode(sn.description) },
});

const playlistItem = (id, sn = {}, n) => ({
  id: 'p:' + id, label: decode(sn.title) || 'Playlist', subtitle: ['Playlist', decode(sn.channelTitle), n ? n + ' video' : ''].filter(Boolean).join(' · '),
  thumb: thumbOf(sn.thumbnails), path: 'pl:' + id, info: { plot: decode(sn.description) },
});

const more = (path, token) => token ? [{ label: 'Altri risultati…', path: path + '|' + token, subtitle: 'Pagina successiva' }] : [];

// Durations and views for a page of videos: one cheap call (1 unit for up to 50 videos).
async function details(ctx, ids) {
  if (!ids.length) return new Map();
  const d = await api(ctx, 'videos', { part: 'contentDetails,statistics,snippet', id: ids.join(','), maxResults: 50 });
  return new Map((d.items || []).map(v => [v.id, v]));
}

async function videosById(ctx, ids, fallback = new Map()) {
  const det = await details(ctx, ids).catch(() => new Map());
  return ids.map(id => {
    const v = det.get(id);
    if (!v && !fallback.get(id)) return null; // private or deleted
    return videoItem(id, v?.snippet || fallback.get(id), { duration: isoSeconds(v?.contentDetails?.duration), views: v?.statistics?.viewCount });
  }).filter(Boolean);
}

// ---------------------------------------------------------------- links
// A YouTube address (or a bare id / @handle) typed in the search box.
function parseLink(q) {
  q = q.trim();
  if (/^[\w-]{11}$/.test(q) && /[A-Z]/.test(q) && /[a-z]/.test(q) && /[\d_-]/.test(q)) return { video: q };
  if (/^@[\w.-]{3,}$/.test(q)) return { handle: q };
  if (/^UC[\w-]{22}$/.test(q)) return { channel: q };
  let u;
  try { u = new URL(/^https?:\/\//i.test(q) ? q : 'https://' + q); } catch { return null; }
  if (!/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (/youtu\.be$/i.test(u.hostname) && /^[\w-]{11}$/.test(parts[0] || '')) return { video: parts[0] };
  if (u.searchParams.get('v')) return { video: u.searchParams.get('v') };
  if (['embed', 'shorts', 'live', 'v'].includes(parts[0]) && /^[\w-]{11}$/.test(parts[1] || '')) return { video: parts[1] };
  if (u.searchParams.get('list')) return { playlist: u.searchParams.get('list') };
  if (parts[0] === 'channel' && /^UC[\w-]{22}$/.test(parts[1] || '')) return { channel: parts[1] };
  if (/^@/.test(parts[0] || '')) return { handle: decodeURIComponent(parts[0]) };
  if (parts[0] === 'user' && parts[1]) return { user: parts[1] };
  return null;
}

async function openLink(link, ctx) {
  if (link.video) {
    if (!key(ctx)) return [videoItem(link.video, { title: 'Video YouTube ' + link.video })];
    const items = await videosById(ctx, [link.video]);
    if (!items.length) throw new Error('Video non trovato (forse privato o rimosso).');
    return items;
  }
  if (link.playlist) {
    if (!key(ctx)) return [{ label: '▶ Guarda la playlist', subtitle: 'Playlist YouTube', playable: true, type: 'video', id: 'p:' + link.playlist, youtube: { playlist: link.playlist } }];
    return listPlaylist(link.playlist, '', ctx);
  }
  let channel = link.channel;
  if (!channel) {
    const d = await api(ctx, 'channels', { part: 'snippet', ...(link.handle ? { forHandle: link.handle } : { forUsername: link.user }) });
    if (!d.items?.length) throw new Error('Canale non trovato.');
    channel = d.items[0].id;
  }
  return listChannel(channel, ctx);
}

// ---------------------------------------------------------------- saved channels
async function savedChannels(ctx) { return (await ctx.store.get('channels')) || []; }

async function follow(id, ctx) {
  const list = await savedChannels(ctx);
  if (!list.some(c => c.id === id)) {
    let sn = {};
    try { sn = (await api(ctx, 'channels', { part: 'snippet', id })).items?.[0]?.snippet || {}; } catch { /* keyless: saved by id */ }
    list.push({ id, title: decode(sn.title) || id, thumb: thumbOf(sn.thumbnails) });
    list.sort((a, b) => a.title.localeCompare(b.title, 'it'));
    await ctx.store.set('channels', list);
  }
  return list.find(c => c.id === id);
}

async function unfollow(id, ctx) {
  const list = await savedChannels(ctx);
  await ctx.store.set('channels', list.filter(c => c.id !== id));
}

// Latest videos of a channel without the API: its official RSS feed (no CORS: via the proxy).
async function feedVideos(id, ctx) {
  const xml = await ctx.http.text('https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(id));
  const title = ctx.xml.text(xml, 'title');
  return ctx.xml.blocks(xml, 'entry').map(e => {
    const vid = ctx.xml.text(e.inner, 'yt:videoId');
    if (!vid) return null;
    const views = ctx.xml.attr(e.inner, 'media:statistics', 'views');
    return videoItem(vid, {
      title: ctx.xml.text(e.inner, 'title'), channelTitle: title, publishedAt: ctx.xml.text(e.inner, 'published'),
      description: ctx.xml.text(e.inner, 'media:description'), thumbnails: { high: { url: ctx.xml.attr(e.inner, 'media:thumbnail', 'url') } },
    }, { views });
  }).filter(Boolean);
}

// ---------------------------------------------------------------- lists
async function listChannel(id, ctx, token = '') {
  const saved = (await savedChannels(ctx)).some(c => c.id === id);
  const head = token ? [] : [
    saved ? { label: '✕ Togli dai miei canali', path: 'unfollow:' + id, subtitle: 'È tra i tuoi canali' }
      : { label: '★ Aggiungi ai miei canali', path: 'follow:' + id, subtitle: 'Lo ritrovi in «I miei canali»' },
  ];
  if (!key(ctx)) {
    const items = await feedVideos(id, ctx);
    return { view: 'wide', noCache: true, items: [...head, ...items] };
  }
  const uploads = 'UU' + id.slice(2);
  const page = await api(ctx, 'playlistItems', { part: 'snippet', playlistId: uploads, maxResults: 30, ...(token ? { pageToken: token } : {}) }).catch(e => {
    if (/Non trovato/.test(e.message)) return { items: [] };
    throw e;
  });
  const fallback = new Map((page.items || []).map(p => [p.snippet.resourceId?.videoId, p.snippet]));
  const videos = await videosById(ctx, [...fallback.keys()].filter(Boolean), fallback);
  if (!token) {
    head.push({ label: 'Playlist del canale', path: 'chpl:' + id, subtitle: 'Le raccolte di video' });
    head.push({ label: '🔴 Dirette del canale', path: 'chlive:' + id, subtitle: 'In onda adesso' });
  }
  return { view: 'wide', noCache: !token, items: [...head, ...videos, ...more('ch:' + id, page.nextPageToken)] };
}

async function listPlaylist(id, token, ctx) {
  const page = await api(ctx, 'playlistItems', { part: 'snippet', playlistId: id, maxResults: 30, ...(token ? { pageToken: token } : {}) });
  const fallback = new Map((page.items || []).map(p => [p.snippet.resourceId?.videoId, p.snippet]));
  const videos = await videosById(ctx, [...fallback.keys()].filter(Boolean), fallback);
  const all = token ? [] : [{ label: '▶ Guarda tutta la playlist', subtitle: 'Un video dopo l\'altro', playable: true, type: 'video', id: 'p:' + id, youtube: { playlist: id }, thumb: videos[0]?.thumb }];
  return { view: 'wide', items: [...all, ...videos, ...more('pl:' + id, page.nextPageToken)] };
}

async function listSearch(q, token, ctx, extra = {}, base = 'q:' + encodeURIComponent(q)) {
  const page = await api(ctx, 'search', {
    part: 'snippet', ...(q ? { q } : {}), maxResults: 25, type: 'video,channel,playlist', regionCode: region(ctx), relevanceLanguage: 'it',
    safeSearch: ctx.settings.safeSearch || 'moderate', ...extra, ...(token ? { pageToken: token } : {}),
  });
  const hits = page.items || [];
  const vids = hits.filter(h => h.id.videoId).map(h => h.id.videoId);
  const det = await details(ctx, vids).catch(() => new Map());
  const items = hits.map(h => {
    if (h.id.channelId && h.id.kind === 'youtube#channel') return channelItem(h.id.channelId, h.snippet);
    if (h.id.playlistId) return playlistItem(h.id.playlistId, h.snippet);
    if (h.id.videoId) {
      const v = det.get(h.id.videoId);
      return videoItem(h.id.videoId, v?.snippet || h.snippet, { duration: isoSeconds(v?.contentDetails?.duration), views: v?.statistics?.viewCount });
    }
    return null;
  }).filter(Boolean);
  return { view: 'wide', items: [...items, ...more(base, page.nextPageToken)] };
}

async function listChart(cat, token, ctx) {
  const page = await api(ctx, 'videos', {
    part: 'snippet,contentDetails,statistics', chart: 'mostPopular', regionCode: region(ctx), maxResults: 30, hl: 'it',
    ...(cat !== '0' ? { videoCategoryId: cat } : {}), ...(token ? { pageToken: token } : {}),
  }).catch(e => { if (/Non trovato/.test(e.message)) return { items: [] }; throw e; });
  const items = (page.items || []).map(v => videoItem(v.id, v.snippet, { duration: isoSeconds(v.contentDetails?.duration), views: v.statistics?.viewCount }));
  if (!items.length && !token) return [{ label: 'Nessun video di tendenza in questa categoria per il paese scelto.', path: '' }];
  return { view: 'wide', items: [...items, ...more('chart:' + cat, page.nextPageToken)] };
}

async function root(ctx) {
  const hasKey = !!key(ctx);
  const saved = await savedChannels(ctx);
  return {
    noCache: true,
    items: [
      ...(hasKey ? [] : [{ label: '🔑 Imposta la chiave API di YouTube', subtitle: 'Gratuita, serve per cercare e sfogliare: le istruzioni sono nelle impostazioni', action: 'settings' }]),
      { label: 'Cerca su YouTube…', action: 'search', subtitle: hasKey ? 'Video, canali e playlist (puoi anche incollare un link)' : 'Senza chiave: incolla un link YouTube' },
      { label: 'Di tendenza', path: 'chart:0', subtitle: 'I video più visti del momento' },
      { label: 'Categorie', path: 'cats', subtitle: 'Musica, sport, notizie…' },
      { label: '🔴 In diretta ora', path: 'live', subtitle: 'Dirette in corso' },
      { label: 'I miei canali', path: 'mine', subtitle: saved.length ? saved.length + (saved.length === 1 ? ' canale' : ' canali') : 'Aggiungili con ★ dalla pagina di un canale' },
    ],
  };
}

async function mine(ctx) {
  const saved = await savedChannels(ctx);
  if (!saved.length) return { noCache: true, items: [{ label: 'Nessun canale salvato: cerca un canale e premi «★ Aggiungi ai miei canali».', action: 'search' }] };
  return { noCache: true, items: saved.map(c => ({ id: 'c:' + c.id, label: c.title, thumb: c.thumb, path: 'ch:' + c.id, subtitle: 'Canale' })) };
}

addon.register({
  async list(path, ctx) {
    if (!path) return root(ctx);
    const [p, token = ''] = path.split('|');
    const [kind, ...rest] = p.split(':');
    const arg = rest.join(':');
    switch (kind) {
      case 'cats': return [{ label: 'Tutto', path: 'chart:0' }, ...CATEGORIES.map(([id, label]) => ({ label, path: 'chart:' + id }))];
      case 'chart': return listChart(arg || '0', token, ctx);
      case 'live': return listSearch('', token, ctx, { type: 'video', eventType: 'live', order: 'viewCount' }, 'live');
      case 'mine': return mine(ctx);
      case 'ch': return listChannel(arg, ctx, token);
      case 'chpl': {
        const page = await api(ctx, 'playlists', { part: 'snippet,contentDetails', channelId: arg, maxResults: 30, ...(token ? { pageToken: token } : {}) });
        const items = (page.items || []).map(pl => playlistItem(pl.id, pl.snippet, pl.contentDetails?.itemCount));
        if (!items.length) return [{ label: 'Questo canale non ha playlist pubbliche.', path: 'ch:' + arg }];
        return { view: 'wide', items: [...items, ...more('chpl:' + arg, page.nextPageToken)] };
      }
      case 'chlive': {
        const r = await listSearch('', token, ctx, { type: 'video', eventType: 'live', channelId: arg }, 'chlive:' + arg);
        return r.items.length ? r : [{ label: 'Nessuna diretta in corso su questo canale.', path: 'ch:' + arg }];
      }
      case 'pl': return listPlaylist(arg, token, ctx);
      case 'q': return listSearch(decodeURIComponent(arg), token, ctx);
      case 'follow': {
        const c = await follow(arg, ctx);
        return { noCache: true, items: [{ label: '✓ «' + c.title + '» è nei tuoi canali', path: 'mine', subtitle: 'Apri «I miei canali»' }, { label: 'Torna al canale', path: 'ch:' + arg }] };
      }
      case 'unfollow': {
        await unfollow(arg, ctx);
        return { noCache: true, items: [{ label: '✓ Canale tolto dai tuoi canali', path: 'mine', subtitle: 'Apri «I miei canali»' }] };
      }
      default: return [];
    }
  },

  async search(query, ctx) {
    const link = parseLink(query);
    if (link) return openLink(link, ctx);
    if (!key(ctx)) throw new Error('Per cercare su YouTube serve la chiave API (impostazioni dell\'add-on, ⚙). Senza chiave puoi incollare un link YouTube.');
    return listSearch(query, '', ctx);
  },

  // Items already carry the video id: the app opens them in YouTube's own player.
  async resolve(item) {
    if (item.youtube) return { youtube: item.youtube };
    return null;
  },
});
