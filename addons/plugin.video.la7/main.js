// La7 on demand (www.la7play.it): the site's own public GraphQL API (persisted queries,
// GET /api/gql/<query>/<base64 variables>), which allows other sites (CORS). Search uses
// /api/gql-search, which does not: it goes through the proxy when there is one.
// Paths: ""                     -> sections
//        "page:<path>"          -> the rows of a site page (/programmi, /film, /documentari)
//        "row:<path>|<n>"       -> the cards of row n of that page
//        "prop:<path>"          -> a programme: episodes, its video sections
//        "ep:<name>"            -> a programme's episodes (puntate)
//        "clips:<name>|<sez>"   -> a programme's videos, all or one section
//        "free" / "free:<row>"  -> «Si guarda in Salotto»: programmes whose episodes play here
// Item ids: "R:/path" episode, "V:/path" video, "E:/path" film/documentary, "?:/path" not known.
// Protected videos (DRM: films, documentaries, some series) open on la7play.it: Salotto does
// not get around it. Free episodes are plain HLS on La7's CDN.
const BASE = 'https://www.la7play.it';
const CDN = 'https://awsvodpkg.iltrovatore.it';
const Q = {
  page: 'eed01397c9d98bba',     // {path}  a page with rows (contentSlots)
  prop: 'a49a4e9d0e8b3bde',     // {path: 'otto-e-mezzo'}  a programme
  episodes: 'e4ec45c8e38bb081', // {path: <name>, value: n}  its episodes, newest first
  clips: '6f384b6747f1a846',    // {path: <name>, sezione, sottosezione, value}  its videos
  replica: '64b0309c926cd9f8',  // {path}  an episode
  video: 'b207522d293262f1',    // {path}  a video
  evento: '7dcf9b94331a0879',   // {path}  a film / documentary
  search: '4da1e384f8a63808',   // {q, page, pageSize, filters}  (gql-search)
};
const SECTIONS = [
  ['/programmi', 'Programmi', 'Informazione, approfondimento, intrattenimento, teche'],
  ['/documentari', 'Documentari', 'Per lo più protetti: si aprono su la7play.it'],
  ['/film', 'Film', 'Protetti: si aprono su la7play.it'],
];
const MAX = 100; // the API refuses more per request
const NOTE_FREE = '▶ Si guarda in Salotto';
const NOTE_LOCKED = 'Si apre su la7play.it (video protetto)';
const NOTE_LOCKED_PROG = 'Su la7play.it (video protetti)';

function b64(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '');
}
async function gql(ctx, query, vars, search = false) {
  const url = `${BASE}/api/${search ? 'gql-search' : 'gql'}/${Q[query]}/${b64(vars)}`;
  try {
    const r = await ctx.http.json(url);
    if (r && r.errors && !r.data) throw new Error(r.errors.map(e => e.message).join('; '));
    return r.data || {};
  } catch (e) {
    if (/HTTP 404/.test(e.message)) throw new Error('La7 ha cambiato il suo sito: serve un aggiornamento dell\'add-on La7');
    throw e;
  }
}
const entityOf = (d) => { const e = d && d.route && d.route.entity; return e && e.__typename ? e : null; };
const img = (o) => o && (o.url || o.mediaUrl) || '';
const vthumb = (u) => u ? img(u.thumbnailDefault) || u.cf_thumbnail_url || img(u.cf_thumbnail_scena) : '';
const webPage = (p) => BASE + p;
const fmtDate = (ts) => { if (!ts) return ''; const d = new Date(ts * 1000); return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`; };
const kindOf = (typename) => ({ NodeReplica: 'R', NodeVideo: 'V', NodeEventoSingolo: 'E' })[typename] || '?';
function guessKind(p) {
  if (/\/(puntate|episodi|rivedila7)\//.test(p)) return 'R';
  if (/\/video\//.test(p)) return 'V';
  if (/^\/(film|documentari)\//.test(p)) return 'E';
  return '?';
}

// ---- videos: is it protected? (asked once per visit)
const drmKnown = new Map();
async function entity(ctx, kind, p) {
  const order = kind === '?' ? ['R', 'V', 'E'] : [kind];
  for (const k of order) {
    const e = entityOf(await gql(ctx, k === 'R' ? 'replica' : k === 'V' ? 'video' : 'evento', { path: p }));
    if (e) { drmKnown.set(p, !!e.drm); return e; }
  }
  return null;
}
async function isDrm(ctx, kind, p) {
  if (drmKnown.has(p)) return drmKnown.get(p);
  if (kind === 'V') return false; // short videos are never protected
  const e = await entity(ctx, kind, p).catch(() => null);
  return e ? !!e.drm : undefined;
}

/** A video card (episode, video, film). */
function videoItem(n, kind, locked) {
  const p = n.path;
  const u = n.uploadVideo || {};
  const date = fmtDate((n.dataMessaInOnda && n.dataMessaInOnda.timestamp) || (n.created && n.created.timestamp));
  const prog = n.property && (n.property.titolo || n.property.name);
  const sub = [locked ? NOTE_LOCKED : '', prog && prog !== n.title ? prog : '', date].filter(Boolean).join(' · ');
  const item = {
    id: kind + ':' + p, label: (n.title || '').trim(), subtitle: sub || undefined, thumb: vthumb(u) || img(n.scenaImage),
    info: { plot: (n.sinossibreve || (n.descrizioneOverride && n.descrizioneOverride.plainValue) || '').slice(0, 400), duration: Number(u.cf_duration) || undefined },
    playable: true, type: 'video',
  };
  if (locked) item.external = webPage(p);
  return item;
}

// ---- programmes: «Si guarda in Salotto». A programme plays here when its latest episode is
// not protected (or it has only short videos); checked in the background, kept a week.
const FREE_KEY = 'free-v1';
const RECHECK = 7 * 86400e3;
const RESCAN = 86400e3;
let cache = null; // { progs: { path: { free, at } }, at }
let scan = null, scanDone = 0, scanTotal = 0;
async function loadCache(ctx) {
  if (!cache) cache = (ctx.store && await ctx.store.get(FREE_KEY).catch(() => null)) || { progs: {}, at: 0 };
  return cache;
}
const saveCache = (ctx) => (ctx.store ? ctx.store.set(FREE_KEY, cache).catch(() => {}) : null);
const progFree = (p) => cache && cache.progs[p] ? cache.progs[p].free : undefined;

async function checkProg(ctx, p) {
  const prop = entityOf(await gql(ctx, 'prop', { path: p.replace(/^\//, '') }));
  if (!prop) return undefined;
  const name = (prop.name || '').toLowerCase();
  const eps = (await gql(ctx, 'episodes', { path: name, value: 1 })).filteredNodeReplicas;
  const first = eps && eps.nodes && eps.nodes[0];
  let free;
  if (first) free = (await isDrm(ctx, 'R', first.path)) === false;
  else free = true; // only short videos
  cache.progs[p] = { free, at: Date.now() };
  return free;
}

async function pageRows(ctx, p) {
  const e = entityOf(await gql(ctx, 'page', { path: p }));
  return ((e && e.contentSlots) || []).filter(s => s.paginatedItems && (s.paginatedItems.items || []).length);
}
/** Every programme card of the Programmi page, with its row. */
async function catalogue(ctx) {
  const all = new Map();
  for (const s of await pageRows(ctx, '/programmi')) {
    for (const c of s.paginatedItems.items) if (c.__typename === 'TermProperty' && !all.has(c.path)) all.set(c.path, { c, row: s.titoloCarrello });
  }
  return all;
}
async function runScan(ctx, all) {
  const now = Date.now();
  const todo = [...all.keys()].filter(p => !(cache.progs[p] && now - cache.progs[p].at < RECHECK));
  scanDone = 0; scanTotal = todo.length;
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const p = todo[i++];
      try { await checkProg(ctx, p); } catch { /* next time */ }
      scanDone++;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  cache.at = Date.now();
  await saveCache(ctx);
}
async function freeList(arg, ctx) {
  await loadCache(ctx);
  const all = await catalogue(ctx);
  if (!scan && (ctx.refresh || Date.now() - cache.at > RESCAN)) scan = runScan(ctx, all).catch(() => {}).finally(() => { scan = null; });
  if (scan) await Promise.race([scan, new Promise(r => setTimeout(r, cache.at ? 0 : 9000))]);
  const byRow = new Map();
  for (const { c, row } of all.values()) {
    if (progFree(c.path) !== true) continue;
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(c);
  }
  const again = (arg ? 'free:' + arg : 'free') + '~' + scanDone;
  const progress = scan ? [{ label: `Sto ancora controllando il catalogo La7 (${scanDone} di ${scanTotal})`, subtitle: 'Tocca qui tra poco per vedere gli altri', path: again }] : [];
  const noCache = !!scan;
  if (!arg) {
    return {
      noCache, view: 'list',
      items: [
        ...progress,
        ...[...byRow].map(([row, list]) => ({ label: row, subtitle: list.length + ' programmi', path: 'free:' + row })),
        ...(!scan && !byRow.size ? [{ label: 'Nessun programma trovato: riprova più tardi', path: again }] : []),
      ],
    };
  }
  return { noCache, view: 'grid', items: [...progress, ...(byRow.get(arg) || []).map(progItem)] };
}

function progItem(c) {
  const free = progFree(c.path);
  const note = free === true ? NOTE_FREE : free === false ? NOTE_LOCKED_PROG : '';
  return { id: c.path, label: (c.titolo || c.title || '').trim(), subtitle: note || undefined, thumb: img(c.scenaImage) || img(c.programmaImage) || img(c.coverImage), path: 'prop:' + c.path };
}

async function rowItems(ctx, cards) {
  const items = await Promise.all(cards.map(async (c) => {
    if (c.__typename === 'TermProperty') return progItem(c);
    const kind = kindOf(c.__typename);
    if (!c.path || kind === '?') return null;
    const drm = await isDrm(ctx, kind, c.path);
    return videoItem({ ...c, title: c.title || (c.property && c.property.titolo) }, kind, drm === true);
  }));
  return items.filter(Boolean);
}

async function programme(p, ctx) {
  const prop = entityOf(await gql(ctx, 'prop', { path: p.replace(/^\//, '') }));
  if (!prop) throw new Error('La7 non trova questo programma');
  const name = (prop.name || '').toLowerCase();
  const thumb = img(prop.scenaImage) || img(prop.poster);
  const items = [];
  for (const v of prop.vociSottomenu || []) {
    if (v.linkMenu) continue; // podcast and other pages of the site
    const tipo = v.tipoDiContenuto && v.tipoDiContenuto.name;
    if (tipo === 'Replica') items.push({ label: v.titoloVoce || 'Puntate', subtitle: 'Le puntate intere', path: 'ep:' + name, thumb });
    else if (tipo === 'Video') items.push({ label: v.sezione ? v.titoloVoce : 'Tutti i video', path: 'clips:' + name + '|' + (v.sezione ? v.sezione.name : ''), thumb });
  }
  if (!items.length) items.push({ label: 'Puntate', path: 'ep:' + name, thumb }, { label: 'Tutti i video', path: 'clips:' + name + '|', thumb });
  // just the episodes: straight to them
  if (items.length === 1) return episodes(name, ctx, p);
  return { view: 'list', items };
}

async function episodes(name, ctx, progPath) {
  const r = (await gql(ctx, 'episodes', { path: name, value: MAX })).filteredNodeReplicas;
  const nodes = (r && r.nodes) || [];
  // a programme is protected as a whole or not at all: ask its latest episode
  let locked = false;
  if (nodes[0]) locked = (await isDrm(ctx, 'R', nodes[0].path)) === true;
  if (progPath && cache && nodes[0]) { cache.progs[progPath] = { free: !locked, at: Date.now() }; saveCache(ctx); }
  if (!nodes.length) return { view: 'list', items: [{ label: 'Nessuna puntata disponibile' }] };
  return { view: 'grid', items: nodes.map(n => videoItem(n, 'R', locked)) };
}

async function clips(name, sezione, ctx) {
  const r = (await gql(ctx, 'clips', { path: name, sezione, sottosezione: '', value: MAX })).filteredNodeVideos;
  const nodes = (r && r.nodes) || [];
  if (!nodes.length) return { view: 'list', items: [{ label: 'Nessun video disponibile' }] };
  return { view: 'grid', items: nodes.map(n => videoItem(n, 'V', false)) };
}

function hlsUrl(remote) {
  const files = String(remote || '').split(',').map(s => s.trim()).filter(Boolean).map(s => '/' + s.replace(/^\/+/, '').replace(/\.mp4$/i, ''));
  if (!files.length) return '';
  return `${CDN}/local/hls/,${files.join(',')},.mp4.urlset/master.m3u8`;
}

addon.register({
  async list(path, ctx) {
    if (!path) {
      return {
        view: 'list',
        items: [
          { label: 'Cerca su La7…', action: 'search' },
          { label: 'Si guarda in Salotto', subtitle: 'I programmi le cui puntate partono qui', path: 'free' },
          ...SECTIONS.map(([p, label, sub]) => ({ label, subtitle: sub, path: 'page:' + p })),
        ],
      };
    }
    await loadCache(ctx);
    if (/^free(:|~|$)/.test(path)) return freeList(path.replace(/~\d*$/, '').slice(5), ctx);
    const i = path.indexOf(':');
    const kind = path.slice(0, i), arg = path.slice(i + 1);
    if (kind === 'page') {
      const rows = await pageRows(ctx, arg);
      return { view: 'list', items: rows.map((s, n) => ({ label: s.titoloCarrello || 'Senza titolo', subtitle: s.paginatedItems.items.length + ' titoli', path: `row:${arg}|${n}` })) };
    }
    if (kind === 'row') {
      const [pagePath, n] = arg.split('|');
      const s = (await pageRows(ctx, pagePath))[Number(n)];
      return { view: 'grid', items: s ? await rowItems(ctx, s.paginatedItems.items) : [] };
    }
    if (kind === 'prop') return programme(arg, ctx);
    if (kind === 'ep') return episodes(arg, ctx);
    if (kind === 'clips') { const [name, sez] = arg.split('|'); return clips(name, sez || '', ctx); }
    return { view: 'list', items: [] };
  },

  async search(text, ctx) {
    await loadCache(ctx);
    let groups;
    try {
      const r = await gql(ctx, 'search', { filters: null, page: 1, pageSize: 40, q: text }, true);
      groups = (r.siteSearch && r.siteSearch.groups) || [];
    } catch (e) {
      // La7's search doesn't allow other sites: without a proxy, look through the programme names
      const all = await catalogue(ctx).catch(() => new Map());
      const t = text.toLowerCase();
      const found = [...all.values()].map(x => x.c).filter(c => (c.titolo || '').toLowerCase().includes(t)).map(progItem);
      return {
        view: 'grid',
        items: [
          { label: 'Ricerca completa: serve il proxy', subtitle: 'Senza il proxy (Impostazioni) cerco solo tra i nomi dei programmi', path: 'page:/programmi' },
          ...found,
        ],
      };
    }
    const items = [];
    for (const g of groups) {
      for (const h of g.hits || []) {
        if (!h.url) continue;
        if (g.contentType === 'property') { items.push(progItem({ path: h.url, titolo: h.title, scenaImage: { url: h.imageUrl } })); continue; }
        if (g.contentType !== 'video' && g.contentType !== 'film') continue;
        const kind = g.contentType === 'film' ? 'E' : guessKind(h.url);
        items.push({ h, kind });
      }
    }
    const out = await Promise.all(items.map(async (x) => {
      if (!x.h) return x;
      const { h, kind } = x;
      const drm = await isDrm(ctx, kind, h.url);
      return videoItem({
        path: h.url, title: h.title, property: h.propertyName ? { titolo: h.propertyName } : null, sinossibreve: h.excerpt,
        uploadVideo: { cf_thumbnail_url: h.imageUrl, cf_duration: h.duration }, created: h.publishedAt ? { timestamp: Date.parse(h.publishedAt) / 1000 } : null,
      }, kind, drm === true);
    }));
    return { view: 'grid', items: out };
  },

  async resolve(item, ctx) {
    const i = item.id.indexOf(':');
    const kind = item.id.slice(0, i), p = item.id.slice(i + 1);
    const e = await entity(ctx, kind, p);
    if (!e) throw new Error('La7 non trova questo video');
    if (e.drm) return { external: webPage(p), message: 'Questo video è protetto: si guarda su la7play.it.' };
    const u = e.uploadVideo || {};
    let url = hlsUrl(u.cf_remote_url);
    if (!url && e.urlVideo && /\.m3u8|\.mp4/.test(e.urlVideo)) url = e.urlVideo;
    if (!url) throw new Error('La7 non indica il video da riprodurre');
    return { url, mime: /\.mp4$/i.test(url) ? 'video/mp4' : 'application/vnd.apple.mpegurl', title: e.title };
  },
});
