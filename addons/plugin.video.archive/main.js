// Internet Archive (archive.org) video collections.
// Paths: ""                     -> collections
//        "c/<collection>/<page>" -> items of a collection
//        "s/<query>/<page>"      -> search results
const API = 'https://archive.org/advancedsearch.php';

const COLLECTIONS = [
  ['feature_films', 'Lungometraggi', 'Film completi di pubblico dominio'],
  ['film_noir', 'Film noir', 'Gialli e noir classici'],
  ['SciFi_Horror', 'Fantascienza e horror', 'B-movie e classici del genere'],
  ['classic_cartoons', 'Cartoni classici', 'Animazione d\'epoca'],
  ['silent_films', 'Cinema muto', 'Le origini del cinema'],
  ['comedy_films', 'Commedie', 'Commedie classiche'],
  ['documentaries', 'Documentari', ''],
  ['newsandpublicaffairs', 'Cinegiornali e attualità', ''],
];

function thumb(id) { return `https://archive.org/services/img/${encodeURIComponent(id)}`; }

async function query(q, page, ctx) {
  const rows = Number(ctx.settings.rows) || 48;
  const params = new URLSearchParams({ q, rows: String(rows), page: String(page), output: 'json' });
  for (const f of ['identifier', 'title', 'year', 'description', 'runtime']) params.append('fl[]', f);
  params.append('sort[]', ctx.settings.sort || 'downloads desc');
  const data = await ctx.http.json(`${API}?${params}`);
  const docs = (data.response && data.response.docs) || [];
  const total = (data.response && data.response.numFound) || 0;
  return { docs, more: page * rows < total, total };
}

function strip(s) {
  s = Array.isArray(s) ? s[0] : s;
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

function toItems(docs) {
  return docs.map(d => ({
    id: d.identifier,
    label: strip(d.title) || d.identifier,
    thumb: thumb(d.identifier),
    playable: true,
    type: 'video',
    info: { year: d.year, plot: strip(d.description) },
  }));
}

function pick(files) {
  // Prefer browser-friendly MP4 derivatives, then any MP4/WebM/OGV.
  const video = files.filter(f => /\.(mp4|m4v|webm|ogv)$/i.test(f.name));
  const score = (f) => {
    let s = 0;
    if (/h\.264|mpeg4/i.test(f.format || '')) s += 4;
    if (/\.mp4$/i.test(f.name)) s += 3;
    if (/512kb/i.test(f.name)) s += 1;          // small but reliable derivative
    if (f.source === 'derivative') s += 1;
    return s;
  };
  video.sort((a, b) => score(b) - score(a) || (Number(b.size) || 0) - (Number(a.size) || 0));
  return video[0];
}

addon.register({
  async list(path, ctx) {
    if (!path) {
      return {
        view: 'list',
        items: [
          { label: 'Cerca nell\'archivio…', action: 'search' },
          ...COLLECTIONS.map(([id, label, sub]) => ({ label, subtitle: sub, path: `c/${id}/1`, thumb: thumb(id) })),
        ],
      };
    }
    const [kind, key, pageStr] = path.split('/');
    const page = Number(pageStr) || 1;
    const q = kind === 'c'
      ? `collection:(${key}) AND mediatype:(movies)`
      : `(${decodeURIComponent(key)}) AND mediatype:(movies)`;
    const { docs, more } = await query(q, page, ctx);
    const items = toItems(docs);
    if (more) items.push({ label: 'Pagina successiva ›', path: `${kind}/${key}/${page + 1}` });
    return { view: 'grid', items };
  },

  async search(text, ctx) {
    const safe = text.replace(/[()]/g, ' ');
    const { docs, more } = await query(`(${safe}) AND mediatype:(movies)`, 1, ctx);
    const items = toItems(docs);
    if (more) items.push({ label: 'Pagina successiva ›', path: `s/${encodeURIComponent(safe)}/2` });
    return { view: 'grid', items };
  },

  async resolve(item, ctx) {
    const meta = await ctx.http.json(`https://archive.org/metadata/${encodeURIComponent(item.id)}`);
    const f = pick(meta.files || []);
    if (!f) throw new Error('Nessun file video compatibile con il browser');
    const host = meta.d1 || meta.server;
    const url = host && meta.dir
      ? `https://${host}${meta.dir}/${encodeURIComponent(f.name).replace(/%2F/g, '/')}`
      : `https://archive.org/download/${encodeURIComponent(item.id)}/${encodeURIComponent(f.name).replace(/%2F/g, '/')}`;
    return { url, mime: 'video/mp4' };
  },
});
