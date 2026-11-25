// Radio Browser (https://www.radio-browser.info) – a free, community-run
// directory of internet radio stations with an open, CORS-enabled API.

function api(ctx, endpoint, params = {}) {
  const base = String(ctx.settings.server || 'https://de1.api.radio-browser.info').replace(/\/$/, '');
  const qs = new URLSearchParams({ hidebroken: 'true', ...params });
  return ctx.http.json(`${base}/json/${endpoint}?${qs}`);
}

// Hosts that serve the same stream over HTTPS when the catalogue lists the HTTP address
// (e.g. Rai Radio 3 is listed only as http://icestreaming.rai.it/3.mp3).
const HTTPS_HOSTS = /^(icestreaming\.rai\.it|[\w.-]+\.msvdn\.net|[\w.-]+\.unitedradio\.it|[\w.-]+\.fluidstream\.(net|eu)|[\w.-]+\.akamaized\.net)$/i;
function secure(url) {
  const m = /^http:\/\/([^/:]+)(\/.*)?$/i.exec(url || '');
  if (m && HTTPS_HOSTS.test(m[1])) return 'https://' + m[1] + (m[2] || '/');
  return url;
}
const urlKey = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();

function stations(list, ctx, max = Infinity) {
  const httpsOnly = ctx.settings.httpsOnly !== false;
  const seen = new Set();
  return list
    .map(s => ({ ...s, url_resolved: secure(s.url_resolved || s.url) }))
    .filter(s => s.url_resolved)
    .filter(s => !httpsOnly || /^https:/i.test(s.url_resolved))
    .filter(s => { const k = urlKey(s.url_resolved); if (seen.has(k)) return false; seen.add(k); return true; }) // same stream listed twice
    .slice(0, max)
    .map(s => ({
      id: s.stationuuid,
      label: s.name.trim() || 'Senza nome',
      subtitle: [s.country, s.tags && s.tags.split(',').slice(0, 3).join(', '), s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · '),
      thumb: /^https:/i.test(s.favicon || '') ? s.favicon : '',
      url: s.url_resolved,
      playable: true,
      live: true,
      type: 'audio',
      resolve: true,
    }));
}

const GENRES = ['pop', 'rock', 'jazz', 'classical', 'news', 'talk', 'dance', 'electronic', 'hits', 'oldies', 'lounge', 'chillout', 'italian', 'country', 'soul', 'hip hop', 'reggae', 'ambient'];

addon.register({
  async list(path, ctx) {
    const max = parseInt(ctx.settings.limit, 10) || 100;
    const limit = String(Math.min(max * 3, 1000)); // many entries are dropped (HTTP, duplicates): ask for more
    const country = String(ctx.settings.country || 'IT').toUpperCase();
    if (!path) {
      return {
        view: 'list',
        items: [
          { label: 'Cerca una radio…', action: 'search' },
          { label: `Le più ascoltate (${country})`, path: `country/${country}` },
          { label: 'Le più ascoltate nel mondo', path: 'top' },
          { label: 'Per genere', path: 'genres' },
          { label: 'Per paese', path: 'countries' },
        ],
      };
    }
    const [kind, arg] = path.split('/');
    if (kind === 'top') return { view: 'list', items: stations(await api(ctx, 'stations/topclick/' + limit), ctx, max) };
    if (kind === 'country') {
      return { view: 'list', items: stations(await api(ctx, 'stations/bycountrycodeexact/' + encodeURIComponent(arg), { order: 'clickcount', reverse: 'true', limit }), ctx, max) };
    }
    if (kind === 'genres') return { view: 'list', items: GENRES.map(g => ({ label: g[0].toUpperCase() + g.slice(1), path: 'tag/' + encodeURIComponent(g) })) };
    if (kind === 'tag') {
      return { view: 'list', items: stations(await api(ctx, 'stations/bytagexact/' + arg, { order: 'clickcount', reverse: 'true', limit }), ctx, max) };
    }
    if (kind === 'countries') {
      const list = await api(ctx, 'countries', { order: 'stationcount', reverse: 'true' });
      return {
        view: 'list',
        items: list.filter(c => c.stationcount > 20 && c.iso_3166_1).map(c => ({
          label: c.name, subtitle: c.stationcount + ' stazioni', path: 'country/' + c.iso_3166_1,
        })),
      };
    }
    return [];
  },

  async search(text, ctx) {
    const max = parseInt(ctx.settings.limit, 10) || 100;
    const list = await api(ctx, 'stations/search', { name: text, order: 'clickcount', reverse: 'true', limit: String(Math.min(max * 3, 1000)) });
    return { view: 'list', items: stations(list, ctx, max) };
  },

  // Registers a "click" (helps the community ranking) and returns the stream.
  async resolve(item, ctx) {
    try {
      const r = await api(ctx, 'url/' + encodeURIComponent(item.id));
      const url = r && secure(r.url);
      if (url && (/^https:/i.test(url) || ctx.settings.httpsOnly === false)) return { url };
    } catch (e) { ctx.log('click count failed', e.message); }
    return { url: item.url };
  },
});
