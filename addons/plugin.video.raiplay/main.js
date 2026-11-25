// RaiPlay on demand (www.raiplay.it): the site's own public JSON pages.
// Paths: ""                 -> sections
//        "page:<json>"      -> the rows of a section page (e.g. /tipologia/film/index.json)
//        "block:<json>|<n>" -> the items of row n of a page
//        "prog:<json>"      -> a programme: its seasons / groups, or the episodes when only one
//        "set:<json>"       -> the episodes of a season
//        search             -> RaiPlay's own search
// Videos for which RaiPlay asks to sign in (most films and series) or that are protected (DRM)
// open on raiplay.it: Salotto does not sign in to RaiPlay and does not get around it.
const BASE = 'https://www.raiplay.it';
const SECTIONS = [
  ['/index.json', 'In evidenza', 'La prima pagina di RaiPlay'],
  ['/tipologia/film/index.json', 'Film', ''],
  ['/tipologia/serieitaliane/index.json', 'Serie italiane', ''],
  ['/tipologia/serieinternazionali/index.json', 'Serie internazionali', ''],
  ['/tipologia/programmi/index.json', 'Programmi', ''],
  ['/tipologia/documentari/index.json', 'Documentari', ''],
  ['/tipologia/musica-e-teatro/index.json', 'Musica e teatro', ''],
  ['/tipologia/bambini/index.json', 'Bambini', ''],
  ['/tipologia/teen/index.json', 'Teen', ''],
  ['/tipologia/sport/index.json', 'Sport', ''],
];
const SEARCH_URL = BASE + '/atomatic/raiplay-search-service/api/v1/msearch';
const SEARCH_TEMPLATES = { templateIn: '6470a982e4e0301afe1f81f1', templateOut: '6516ac5d40da6c377b151642' };

const abs = (p) => (!p ? '' : /^https?:/i.test(p) ? p : BASE + (p.startsWith('/') ? '' : '/') + p);
const img = (images) => abs(images && (images.landscape || images.landscape43 || images.square || images.portrait43));
const json = (ctx, p) => ctx.http.json(abs(p));
function seconds(d) {
  const m = /^(\d+):(\d\d):(\d\d)$/.exec(String(d || ''));
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : undefined;
}
function safeEncode(u) { try { return encodeURI(decodeURI(u)); } catch { return encodeURI(u); } }
const isVideo = (p) => /^\/video\//.test(p || '');
const isProg = (p) => /^\/programmi\//.test(p || '');
const locked = (v) => !!v && (v.login_required || hasDrm(v.rights_management));
function hasDrm(rm) { const d = rm && rm.rights && rm.rights.drm; return !!d && Object.values(d).some(Boolean); }
const webPage = (weblink, pathId) => abs(weblink || String(pathId || '').replace(/\.json$/, '.html'));
const NOTE_LOCKED = 'Si apre su raiplay.it (RaiPlay chiede l\'accesso)';

/** A card of a RaiPlay row (programme or video). */
function toItem(c, lockedProg = false) {
  const p = c.path_id || '';
  const label = c.episode_title && c.program_name ? c.episode_title : (c.name || c.titolo || c.toptitle || '');
  const sub = [c.season && c.episode ? `St ${c.season} Ep ${c.episode}` : '', c.program_name && c.episode_title ? c.program_name : (c.subtitle || '')].filter(Boolean).join(' · ');
  const base = { id: p, label, thumb: img(c.images) || abs(c.immagine), subtitle: sub || undefined, info: { plot: (c.description || c.sommario || '').slice(0, 400), duration: seconds(c.duration || c.durata) } };
  if (isProg(p)) return { ...base, path: 'prog:' + p };
  if (!isVideo(p)) return null;
  if (lockedProg || hasDrm(c.rights_management)) return { ...base, subtitle: NOTE_LOCKED, external: webPage(c.weblink || c.url, p), playable: true, type: 'video' };
  return { ...base, playable: true, type: 'video' };
}

async function programme(path, ctx) {
  const p = await json(ctx, path);
  // RaiPlay asks to sign in for the whole programme or for none of it: look at its first video
  let first = null;
  if (p.first_item_path) first = await json(ctx, p.first_item_path).catch(() => null);
  const lockedProg = locked(first);
  const sets = [];
  for (const b of p.blocks || []) for (const s of b.sets || []) sets.push({ block: b.name, set: s });
  if (sets.length === 1) return episodes(sets[0].set.path_id, ctx, lockedProg);
  if (!sets.length && first) return { view: 'grid', items: [toItem({ ...first, path_id: p.first_item_path }, lockedProg)].filter(Boolean) };
  const multiBlock = new Set(sets.map(x => x.block)).size > 1;
  return {
    view: 'list',
    items: sets.map(({ block, set }) => ({
      label: multiBlock ? `${block} · ${set.name}` : set.name,
      path: 'set:' + set.path_id + (lockedProg ? '|L' : ''),
      thumb: img(p.program_info && p.program_info.images),
    })),
  };
}

async function episodes(path, ctx, lockedProg) {
  const s = await json(ctx, path);
  return { view: 'grid', items: (s.items || []).map(c => toItem(c, lockedProg)).filter(Boolean) };
}

addon.register({
  async list(path, ctx) {
    if (!path) {
      return {
        view: 'list',
        items: [
          { label: 'Cerca su RaiPlay…', action: 'search' },
          ...SECTIONS.map(([p, label, sub]) => ({ label, subtitle: sub || undefined, path: 'page:' + p })),
        ],
      };
    }
    const i = path.indexOf(':');
    const kind = path.slice(0, i), arg = path.slice(i + 1);
    if (kind === 'page') {
      const page = await json(ctx, arg);
      const rows = (page.contents || page.blocks || []).map((b, n) => ({ b, n })).filter(({ b }) => (b.contents || []).length && !/Hero/i.test(b.type || ''));
      return { view: 'list', items: rows.map(({ b, n }) => ({ label: (b.header && b.header.label) || b.name, subtitle: (b.contents.length) + ' titoli', path: `block:${arg}|${n}` })) };
    }
    if (kind === 'block') {
      const [pagePath, n] = arg.split('|');
      const page = await json(ctx, pagePath);
      const b = (page.contents || page.blocks || [])[Number(n)] || {};
      return { view: 'grid', items: (b.contents || []).map(c => toItem(c)).filter(Boolean) };
    }
    if (kind === 'prog') return programme(arg, ctx);
    if (kind === 'set') {
      const [setPath, flag] = arg.split('|');
      return episodes(setPath, ctx, flag === 'L');
    }
    return { view: 'list', items: [] };
  },

  async search(text, ctx) {
    const body = { ...SEARCH_TEMPLATES, params: { param: text, from: null, sort: 'relevance', onlyVideoQuery: false } };
    const r = await ctx.http.post(SEARCH_URL, body, { headers: { 'Content-Type': 'application/json' }, type: 'json' });
    const agg = (r && r.agg) || {};
    const progs = ((agg.titoli && agg.titoli.cards) || []).map(c => ({ ...c, images: { landscape: c.immagine } }));
    const vids = ((agg.video && agg.video.cards) || []).map(c => ({ ...c, name: c.titolo, subtitle: c.programma, images: { landscape: c.immagine } }));
    return { view: 'grid', items: [...progs, ...vids].map(c => toItem(c)).filter(Boolean) };
  },

  async resolve(item, ctx) {
    const v = await json(ctx, item.id);
    if (locked(v)) {
      throw new Error((v.login_required ? 'RaiPlay chiede l\'accesso per questo video' : 'Questo video è protetto') + ': aprilo su raiplay.it (' + webPage(v.weblink, item.id) + ').');
    }
    const url = v.video && v.video.content_url;
    if (!url) throw new Error('RaiPlay non indica il video da riprodurre');
    const subtitles = ((v.video && v.video.subtitlesArray) || []).filter(s => s && s.url).map(s => ({
      url: abs(safeEncode(s.url)), lang: s.language || 'it', label: s.label || 'Italiano',
    }));
    return { url, mime: 'application/vnd.apple.mpegurl', subtitles };
  },
});
