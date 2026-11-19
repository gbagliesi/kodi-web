// Podcasts from RSS feeds. Shows how to parse XML inside an add-on
// (ctx.xml) and how to work with user-provided settings.

function feedsFromSettings(ctx) {
  return String(ctx.settings.feeds || '')
    .split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .map(l => {
      const [a, b] = l.includes('|') ? l.split('|').map(s => s.trim()) : [l, l];
      return { name: b === a ? a.replace(/^https?:\/\//, '') : a, url: b };
    });
}

function parseDuration(s) {
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  return s.split(':').reduce((acc, n) => acc * 60 + Number(n || 0), 0);
}

async function episodes(url, ctx) {
  const src = await ctx.http.text(url);
  const x = ctx.xml;
  const imgBlock = (src.match(/<image>[\s\S]*?<\/image>/i) || [''])[0];
  const channelImg = x.attr(src, 'itunes:image', 'href') || x.text(imgBlock, 'url');
  const items = x.blocks(src, 'item').map(b => {
    const enc = x.attrs((b.inner.match(/<enclosure\s([^>]*)\/?>/i) || [])[1] || '');
    if (!enc.url) return null;
    const img = x.attr(b.inner, 'itunes:image', 'href') || channelImg;
    const date = x.text(b.inner, 'pubDate');
    return {
      label: x.text(b.inner, 'title') || 'Episodio',
      subtitle: date ? new Date(date).toLocaleDateString('it-IT') : '',
      url: enc.url,
      mime: enc.type || 'audio/mpeg',
      thumb: /^https:/.test(img) ? img : '',
      type: /video/.test(enc.type || '') ? 'video' : 'audio',
      playable: true,
      info: { plot: x.text(b.inner, 'itunes:summary') || x.text(b.inner, 'description').replace(/<[^>]+>/g, ' ').slice(0, 300), duration: parseDuration(x.text(b.inner, 'itunes:duration')) },
    };
  }).filter(Boolean);
  return { view: 'list', items };
}

addon.register({
  async list(path, ctx) {
    if (!path) {
      const feeds = feedsFromSettings(ctx);
      return {
        view: 'list',
        message: feeds.length ? '' : 'Nessun feed salvato: cerca un podcast oppure aggiungi i tuoi feed nelle impostazioni dell\'add-on.',
        items: [
          { label: 'Cerca un podcast…', action: 'search' },
          ...feeds.map(f => ({ label: f.name, subtitle: f.url, path: 'feed/' + encodeURIComponent(f.url) })),
          { label: 'Impostazioni dell\'add-on', action: 'settings' },
        ],
      };
    }
    if (path.startsWith('feed/')) return episodes(decodeURIComponent(path.slice(5)), ctx);
    return [];
  },

  async search(text, ctx) {
    const qs = new URLSearchParams({ media: 'podcast', term: text, limit: '40', country: ctx.settings.country || 'it' });
    const data = await ctx.http.json('https://itunes.apple.com/search?' + qs);
    return {
      view: 'grid',
      items: (data.results || []).filter(r => r.feedUrl).map(r => ({
        label: r.collectionName,
        subtitle: r.artistName,
        thumb: r.artworkUrl600 || r.artworkUrl100,
        path: 'feed/' + encodeURIComponent(r.feedUrl),
      })),
    };
  },
});
