// Mediaset Infinity (mediasetinfinity.mediaset.it): a "shop window". Mediaset protects full
// episodes with DRM and its catalogue API doesn't allow other sites, so this add-on reads the
// site's public pages (through the proxy of the Settings) and every video opens on the site.
// Salotto does not get around the DRM nor uses Mediaset's private services.
// Paths: ""                -> sections
//        "page:<path>"     -> a site page: its rows, or its cards when it has no rows
//        "row:<path>|<n>"  -> the cards of row n of that page
// Search looks through the programme names met in the sections (kept a day).
const BASE = 'https://mediasetinfinity.mediaset.it';
const SECTIONS = [
  ['/programmitv', 'Programmi TV', 'Prima serata, daytime, clip, TG, sport'],
  ['/fiction', 'Fiction e serie TV', 'Fiction italiane, soap, serie, TV movie'],
  ['/cinema', 'Cinema', 'I film del catalogo'],
  ['/documentari', 'Documentari', 'Focus, Infinity LAB e altri'],
  ['/kids', 'Kids', 'Boing, Cartoonito, cartoni di sempre'],
  ['/news-e-sport', 'News e sport', 'TG, informazione, highlights'],
];
const NOTE_VIDEO = 'Si apre su Mediaset Infinity';
const INDEX_KEY = 'progs-v1';
const INDEX_AGE = 86400e3;
const PAGE_AGE = 30 * 60e3;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENT[e.toLowerCase()] ?? m;
}).trim();
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

class NeedsProxy extends Error {}

/** The visible part of a site page (the page data that follows is not needed: stop reading there). */
const pages = new Map();
async function fetchPage(ctx, p) {
  const hit = pages.get(p);
  if (hit && Date.now() - hit.at < PAGE_AGE) return hit.html;
  if (!ctx.http.proxied(BASE).includes('url=')) throw new NeedsProxy();
  const res = await ctx.http.get(BASE + p, { type: 'response', viaProxy: true, timeout: 30000 });
  let html = '';
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      const i = html.indexOf('self.__next_f');
      if (i > 0) { html = html.slice(0, i); reader.cancel().catch(() => {}); break; }
    }
  } else {
    html = await res.text();
    const i = html.indexOf('self.__next_f');
    if (i > 0) html = html.slice(0, i);
  }
  pages.set(p, { html, at: Date.now() });
  if (pages.size > 30) pages.delete(pages.keys().next().value);
  return html;
}

const CARD = /<a [^>]*data-testid="((?:poster|keyframe|hero-billboard)-card-link)"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
/** Cards in a piece of page: { href, title, img, desc } */
function cards(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(CARD)) {
    const href = decode(m[2]);
    if (seen.has(href)) continue;
    const img = /<img [^>]*alt="([^"]*)"[^>]*src="([^"]+)"/.exec(m[3]) || /<img [^>]*src="([^"]+)"[^>]*alt="([^"]*)"/.exec(m[3]);
    let title = img ? decode(img[1].startsWith('http') ? img[2] : img[1]) : '';
    const src = img ? decode(img[1].startsWith('http') ? img[1] : img[2]) : '';
    const all = text(m[3]);
    if (!title) title = all.slice(0, 80);
    if (!title) continue;
    seen.add(href);
    let desc = all.replace(/La tua lista/g, '').trim();
    if (desc.startsWith(title)) desc = desc.slice(title.length).trim();
    out.push({ href, title, img: src, desc });
  }
  return out;
}

/** Rows of a page: { title, href, cards } */
function rows(html) {
  const parts = html.split('data-testid="carousel-title"');
  const out = [];
  for (let k = 1; k < parts.length; k++) {
    const s = parts[k];
    const href = decode((/^[^>]*href="([^"]+)"/.exec(s) || [])[1] || '');
    const title = text((/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(s) || [])[1] || '');
    const list = cards(s);
    if (!title || (!list.length && !href.startsWith('/'))) continue;
    out.push({ title, href, cards: list });
  }
  return out;
}

const isVideo = (href) => /^\/(video|movie|video-microdrama)\//.test(href);
const isFolder = (href) => href.startsWith('/') && href !== '/' && !isVideo(href) && !/^\/(news|diretta|noleggio|infinity-plus)(\/|$)/.test(href);

function item(c) {
  if (isVideo(c.href)) {
    return {
      id: c.href, label: c.title, subtitle: NOTE_VIDEO, thumb: c.img || undefined,
      info: c.desc ? { plot: c.desc.slice(0, 400) } : undefined,
      playable: true, type: 'video', external: BASE + c.href,
    };
  }
  if (!isFolder(c.href)) return null;
  return { id: c.href, label: c.title, thumb: c.img || undefined, info: c.desc ? { plot: c.desc.slice(0, 400) } : undefined, path: 'page:' + c.href };
}
const items = (list) => list.map(item).filter(Boolean);

// ---- programmes met so far, for the search
let index = null; // { progs: { href: { title, img } }, at }
async function loadIndex(ctx) {
  if (!index) index = (ctx.store && await ctx.store.get(INDEX_KEY).catch(() => null)) || { progs: {}, at: 0 };
  return index;
}
function remember(ctx, list) {
  if (!index) return;
  let added = false;
  for (const c of list) {
    if (!isFolder(c.href) || c.href.startsWith('/browse/') || index.progs[c.href]) continue;
    index.progs[c.href] = { title: c.title, img: c.img };
    added = true;
  }
  if (added && ctx.store) ctx.store.set(INDEX_KEY, index).catch(() => {});
}
async function fillIndex(ctx) {
  await loadIndex(ctx);
  if (Date.now() - index.at < INDEX_AGE && Object.keys(index.progs).length) return;
  await Promise.all(SECTIONS.map(async ([p]) => {
    try {
      const html = await fetchPage(ctx, p);
      remember(ctx, cards(html));
    } catch { /* the others */ }
  }));
  index.at = Date.now();
  if (ctx.store) await ctx.store.set(INDEX_KEY, index).catch(() => {});
}

const PROXY_ITEMS = [
  { label: 'Serve il proxy', subtitle: 'Mediaset non lascia leggere il suo catalogo ad altri siti: configura il proxy nelle Impostazioni di Salotto', path: '' },
  { label: 'Apri Mediaset Infinity', subtitle: 'mediasetinfinity.mediaset.it', external: BASE + '/', playable: true },
];

async function page(p, ctx) {
  const html = await fetchPage(ctx, p);
  // rows with something to show (e.g. live-channel rows are left out)
  const rs = rows(html).map((r, n) => ({ ...r, n, shown: items(r.cards).length })).filter(r => r.shown || isFolder(r.href));
  for (const r of rs) remember(ctx, r.cards);
  if (!rs.length) {
    const list = cards(html);
    remember(ctx, list);
    const out = items(list);
    return { view: 'grid', items: out.length ? out : [{ label: 'Niente da mostrare qui', subtitle: 'Apri la pagina sul sito', external: BASE + p, playable: true }] };
  }
  return {
    view: 'list',
    items: rs.map(r => ({
      label: r.title,
      subtitle: r.shown ? r.shown + ' titoli' : 'Apri l\'elenco',
      thumb: r.cards[0] && r.cards[0].img || undefined,
      path: r.shown ? `row:${p}|${r.n}` : 'page:' + r.href,
    })),
  };
}

async function row(p, n, ctx) {
  const r = rows(await fetchPage(ctx, p))[n];
  if (!r) return { view: 'list', items: [] };
  const out = items(r.cards);
  // the row's full list, when the site has one
  if (r.href && r.href.startsWith('/') && r.href !== p && isFolder(r.href)) out.unshift({ label: 'Tutti: ' + r.title, subtitle: 'L\'elenco completo', path: 'page:' + r.href });
  return { view: 'grid', items: out };
}

async function guard(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof NeedsProxy) return { view: 'list', noCache: true, items: PROXY_ITEMS };
    if (/HTTP 404/.test(e.message)) throw new Error('Mediaset non trova questa pagina (il sito potrebbe essere cambiato)');
    throw e;
  }
}

addon.register({
  async list(path, ctx) {
    if (!path) {
      return {
        view: 'list',
        items: [
          { label: 'Cerca un programma…', action: 'search' },
          ...SECTIONS.map(([p, label, sub]) => ({ label, subtitle: sub, path: 'page:' + p })),
          { label: 'Apri Mediaset Infinity', subtitle: 'Il sito, con le dirette e il resto', external: BASE + '/', playable: true },
        ],
      };
    }
    await loadIndex(ctx);
    const i = path.indexOf(':');
    const kind = path.slice(0, i), arg = path.slice(i + 1);
    if (kind === 'page') return guard(() => page(arg, ctx));
    if (kind === 'row') { const j = arg.lastIndexOf('|'); return guard(() => row(arg.slice(0, j), Number(arg.slice(j + 1)), ctx)); }
    return { view: 'list', items: [] };
  },

  async search(q, ctx) {
    return guard(async () => {
      await fillIndex(ctx);
      const words = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
      const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const found = Object.entries(index.progs)
        .filter(([href, v]) => { const t = norm(v.title + ' ' + href); return words.every(w => t.includes(w)); })
        .map(([href, v]) => item({ href, title: v.title, img: v.img }))
        .filter(Boolean);
      return {
        view: 'grid',
        items: [
          ...found,
          { label: 'Cerca «' + q + '» sul sito', subtitle: 'La ricerca completa (anche video e film) è su Mediaset Infinity', external: BASE + '/?search', playable: true },
        ],
      };
    });
  },
});
