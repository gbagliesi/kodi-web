// Radio Browser (https://www.radio-browser.info) – a free, community-run
// directory of internet radio stations with an open, CORS-enabled API.

function api(ctx, endpoint, params = {}) {
  const base = String(ctx.settings.server || 'https://de1.api.radio-browser.info').replace(/\/$/, '');
  const qs = new URLSearchParams({ hidebroken: 'true', ...params });
  return ctx.http.json(`${base}/json/${endpoint}?${qs}`);
}

function stations(list, ctx) {
  const httpsOnly = ctx.settings.httpsOnly !== false;
  return list
    .filter(s => s.url_resolved || s.url)
    .filter(s => !httpsOnly || /^https:/i.test(s.url_resolved || s.url))
    .map(s => ({
      id: s.stationuuid,
      label: s.name.trim() || 'Senza nome',
      subtitle: [s.country, s.tags && s.tags.split(',').slice(0, 3).join(', '), s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · '),
      thumb: /^https:/i.test(s.favicon || '') ? s.favicon : '',
      url: s.url_resolved || s.url,
      playable: true,
      live: true,
      type: 'audio',
      resolve: true,
    }));
}

const GENRES = ['pop', 'rock', 'jazz', 'classical', 'news', 'talk', 'dance', 'electronic', 'hits', 'oldies', 'lounge', 'chillout', 'italian', 'country', 'soul', 'hip hop', 'reggae', 'ambient'];

addon.register({
  async list(path, ctx) {
    const limit = String(ctx.settings.limit || 100);
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
    if (kind === 'top') return { view: 'list', items: stations(await api(ctx, 'stations/topclick/' + limit), ctx) };
    if (kind === 'country') {
      return { view: 'list', items: stations(await api(ctx, 'stations/bycountrycodeexact/' + encodeURIComponent(arg), { order: 'clickcount', reverse: 'true', limit }), ctx) };
    }
    if (kind === 'genres') return { view: 'list', items: GENRES.map(g => ({ label: g[0].toUpperCase() + g.slice(1), path: 'tag/' + encodeURIComponent(g) })) };
    if (kind === 'tag') {
      return { view: 'list', items: stations(await api(ctx, 'stations/bytagexact/' + arg, { order: 'clickcount', reverse: 'true', limit }), ctx) };
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
    const list = await api(ctx, 'stations/search', { name: text, order: 'clickcount', reverse: 'true', limit: String(ctx.settings.limit || 100) });
    return { view: 'list', items: stations(list, ctx) };
  },

  // Registers a "click" (helps the community ranking) and returns the stream.
  async resolve(item, ctx) {
    try {
      const r = await api(ctx, 'url/' + encodeURIComponent(item.id));
      if (r && r.url) return { url: r.url };
    } catch (e) { ctx.log('click count failed', e.message); }
    return { url: item.url };
  },
});
