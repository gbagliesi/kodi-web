// Radio italiane – a curated list of Italian stations with the streams published by the
// broadcasters themselves (Rai's icestreaming.rai.it, the groups' own CDNs), plus the whole
// Italian part of the radio-browser.info catalogue (by popularity or by region).
// All curated streams are HTTPS and were checked to play in a browser (2026-11-25).

const RAI = 'https://icestreaming.rai.it/';
// [name, stream, extra words for the search]
const STATIONS = {
  rai: [
    ['Rai Radio 1', RAI + '1.mp3', 'radio1 radiouno uno gr1 giornale radio'],
    ['Rai Radio 2', RAI + '2.mp3', 'radio2 radiodue due'],
    ['Rai Radio 3', RAI + '3.mp3', 'radio3 radiotre tre'],
    ['Rai Radio 3 Classica (alta qualità)', 'https://radiotreclassica-live.akamaized.net/hls/live/2032595/radiotreclassica/radiotreclassica/playlist.m3u8', 'radio3 radiotre classica'],
    ['Rai Radio Classica', RAI + '5.mp3', 'filodiffusione classica'],
    ['Rai Radio Tutta Italiana', RAI + '4.mp3', 'filodiffusione musica italiana'],
    ['Rai Isoradio', RAI + '6.mp3', 'traffico autostrade'],
    ['Rai Radio 1 Sport', RAI + '13.mp3', 'radio1 sport calcio'],
    ['Rai GR Parlamento', RAI + '7.mp3', 'parlamento politica'],
    ['Rai Radio Techetè', RAI + '9.mp3', 'techete teche'],
    ['Rai Radio Live', RAI + '10.mp3', 'napoli'],
    ['Rai Radio Kids', RAI + '11.mp3', 'bambini ragazzi'],
    ['Rai No Name Radio', RAI + '15.mp3', 'giovani'],
  ],
  nazionali: [
    ['RTL 102.5', 'https://dd782ed59e2a4e86aabf6fc508674b59.msvdn.net/live/S97044836/tbbP8T1ZRPBL/playlist_audio.m3u8', 'rtl 1025'],
    ['Radio Deejay', 'https://4c4b867c89244861ac216426883d1ad0.msvdn.net/radiodeejay/radiodeejay/play1.m3u8', 'dj'],
    ['Radio 105', 'https://icecast.unitedradio.it/Radio105.mp3', '105'],
    ['RDS 100% Grandi Successi', 'https://stream.rds.radio/audio/rds.stream_aac/playlist.m3u8', 'rds radio dimensione suono'],
    ['Radio Italia Solo Musica Italiana', 'https://radioitaliasmi.akamaized.net/hls/live/2093120/RISMI/master.m3u8', 'radioitalia'],
    ['Virgin Radio', 'https://icy.unitedradio.it/Virgin.mp3', 'rock'],
    ['R101', 'https://icecast.unitedradio.it/r101', 'r 101 radio101'],
    ['Radio Monte Carlo', 'https://icy.unitedradio.it/RMC.mp3', 'rmc montecarlo'],
    ['Radio Capital', 'https://4c4b867c89244861ac216426883d1ad0.msvdn.net/radiocapital/radiocapital/master_ma.m3u8', ''],
    ['m2o', 'https://4c4b867c89244861ac216426883d1ad0.msvdn.net/radiom2o/radiom2o/master_ma.m3u8', 'radio m2o dance'],
    ['Radio Kiss Kiss', 'https://kk.fluidstream.eu/KissKiss.mp3', 'kisskiss'],
    ['Radio 24', 'https://ilsole24ore-radio.akamaized.net/hls/live/2035301/radio24/playlist.m3u8', 'radio24 sole 24 ore notizie'],
    ['Radiofreccia', 'https://dd782ed59e2a4e86aabf6fc508674b59.msvdn.net/live/S3160845/0tuSetc8UFkF/playlist_audio.m3u8', 'radio freccia rock'],
    ['Radio Zeta', 'https://streamingv2.shoutcast.com/radio-zeta_48.aac', 'zeta'],
    ['Radio Radicale', 'https://live.radioradicale.it/live.mp3', 'politica parlamento'],
    ['Radio Vaticana (Italiano)', 'https://radio.vaticannews.va/stream-it', 'vatican news vaticano'],
    ['Radio Sportiva', 'https://sportiva.inmystream.it/stream/sportiva', 'sport calcio'],
  ],
  altre: [
    ['Radio Subasio', 'https://icy.unitedradio.it/Subasio.mp3', 'umbria'],
    ['Radio Bruno', 'https://router.xdevel.com/audio4s975355-254/stream/icecast.audio', 'toscana emilia'],
    ['Radio Popolare', 'https://livex.radiopopolare.it/radiopop2', 'milano'],
    ['Radio Cusano Campus', 'https://stream5.xdevel.com/audio1s975363-1686/stream/icecast.audio', 'cusano roma'],
    ['Radio Marte', 'https://stream1.xdevel.com/audio0s975753-313/stream/icecast.audio', 'napoli'],
    ['Radio Company', 'https://sphera.fluidstream.eu/company.aac', 'veneto'],
    ['Radio Piterpan', 'https://ice02.fluidstream.net/piterpan.mp3', 'veneto'],
    ['Radio Italia Anni 60', 'https://str01.fluidstream.net/anni60.mp3', 'sessanta oldies'],
    ['Radio Globo', 'https://globo.newradio.it/globorm64', 'roma'],
    ['Radio Margherita', 'https://streaming.radiomargherita.com/stream/radiomargherita', 'palermo sicilia'],
    ['Radio Onda d\'Urto', 'https://hochimin.urtostream.org:8443/radiondadurto.mp3', 'onda durto brescia'],
    ['LifeGate Radio', 'https://router.xdevel.com/audio0s975809-345/stream/icecast.audio', 'lifegate'],
  ],
};
const GROUPS = [['rai', 'Rai Radio', 'Radio 1, 2, 3 e tutti i canali Rai'], ['nazionali', 'Radio nazionali', 'RTL 102.5, Deejay, 105, RDS, Radio 24…'], ['altre', 'Altre radio', 'Radio regionali e tematiche']];

// Hosts that serve the same stream over HTTPS when the catalogue lists the HTTP address
// (HTTP can't play inside an HTTPS page).
const HTTPS_HOSTS = /^(icestreaming\.rai\.it|[\w.-]+\.msvdn\.net|[\w.-]+\.unitedradio\.it|[\w.-]+\.fluidstream\.(net|eu)|[\w.-]+\.akamaized\.net)$/i;
function secure(url) {
  const m = /^http:\/\/([^/:]+)(\/.*)?$/i.exec(url || '');
  if (m && HTTPS_HOSTS.test(m[1])) return 'https://' + m[1] + (m[2] || '/');
  return url;
}

// "Rai Radio 3" ≈ "radio 3" ≈ "radio3" ≈ "RAI 3": lower case, no accents, digits split from letters
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/(\d)([a-z])|([a-z])(\d)/g, (_, a, b, c, d) => a ? a + ' ' + b : c + ' ' + d)
  .replace(/[^a-z0-9]+/g, ' ').trim();
const IGNORE = new Set(['radio', 'rai', 'fm', 'la', 'il']);
const words = (s) => norm(s).split(' ').filter(w => w && !IGNORE.has(w));

const all = () => GROUPS.flatMap(([g]) => STATIONS[g].map(s => [...s, g]));
const urlKey = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
const CURATED_URLS = new Set(all().map(s => urlKey(s[1])));

function curatedItem([name, url, , group]) {
  return {
    id: 'c:' + url,
    label: name,
    subtitle: group === 'rai' ? 'Rai · stream ufficiale' : 'Stream ufficiale',
    url, playable: true, live: true, type: 'audio',
    mime: /\.m3u8(\?|$)/i.test(url) ? 'application/x-mpegurl' : undefined,
  };
}

function catalogItems(list, seen = new Set()) {
  const out = [];
  for (const s of list) {
    const url = secure(s.url_resolved || s.url);
    if (!/^https:/i.test(url || '')) continue;
    const key = urlKey(url);
    const nameKey = norm(s.name);
    if (seen.has(key) || seen.has('n:' + nameKey)) continue; // same stream or same name listed twice
    seen.add(key); seen.add('n:' + nameKey);
    out.push({
      id: s.stationuuid,
      label: (s.name || '').trim() || 'Senza nome',
      subtitle: [s.state, s.tags && s.tags.split(',').slice(0, 3).join(', '), s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · '),
      thumb: /^https:/i.test(s.favicon || '') ? s.favicon : '',
      url, playable: true, live: true, type: 'audio', resolve: true,
    });
  }
  return out;
}

function api(ctx, endpoint, params = {}) {
  const base = String(ctx.settings.server || 'https://de1.api.radio-browser.info').replace(/\/$/, '');
  const qs = new URLSearchParams({ hidebroken: 'true', ...params });
  return ctx.http.json(`${base}/json/${endpoint}?${qs}`);
}
const pageSize = (ctx) => Math.max(20, Math.min(500, parseInt(ctx.settings.limit, 10) || 150));

addon.register({
  async list(path, ctx) {
    if (!path) {
      return {
        view: 'list',
        items: [
          { label: 'Cerca una radio…', action: 'search' },
          ...GROUPS.map(([g, label, sub]) => ({ label, subtitle: sub, path: 'g/' + g })),
          { label: 'Tutte le radio italiane', subtitle: 'Catalogo radio-browser.info, dalle più ascoltate', path: 'all/0' },
          { label: 'Per regione', subtitle: 'Catalogo radio-browser.info', path: 'regions' },
        ],
      };
    }
    const [kind, arg, arg2] = path.split('/');
    if (kind === 'g' && STATIONS[arg]) return { view: 'list', items: STATIONS[arg].map(s => curatedItem([...s, arg])) };
    if (kind === 'all' || kind === 'region') {
      const n = pageSize(ctx);
      const offset = parseInt(kind === 'all' ? arg : arg2, 10) || 0;
      const params = { countrycode: 'IT', order: 'clickcount', reverse: 'true', limit: String(n), offset: String(offset) };
      if (kind === 'region') Object.assign(params, { state: decodeURIComponent(arg), stateExact: 'true' });
      const list = await api(ctx, 'stations/search', params);
      const seen = new Set(offset ? [] : CURATED_URLS);
      const items = catalogItems(list, seen);
      if (list.length >= n) items.push({ label: 'Altre stazioni…', path: kind === 'all' ? 'all/' + (offset + n) : `region/${arg}/${offset + n}` });
      return { view: 'list', items };
    }
    if (kind === 'regions') {
      const list = await api(ctx, 'states/Italy', { order: 'stationcount', reverse: 'true' });
      return {
        view: 'list',
        items: list.filter(s => s.stationcount >= 3 && s.name).map(s => ({
          label: s.name, subtitle: s.stationcount + ' stazioni', path: 'region/' + encodeURIComponent(s.name) + '/0',
        })),
      };
    }
    return [];
  },

  async search(text, ctx) {
    const q = words(text);
    const curated = all().filter(s => {
      const hay = new Set(words(s[0] + ' ' + s[2]));
      return q.length ? q.every(w => hay.has(w) || [...hay].some(h => h.startsWith(w) && w.length > 2)) : norm(s[0]).includes(norm(text));
    }).map(curatedItem);
    let catalog = [];
    try {
      const list = await api(ctx, 'stations/search', { name: text, countrycode: 'IT', order: 'clickcount', reverse: 'true', limit: '200' });
      catalog = catalogItems(list, new Set([...CURATED_URLS, ...curated.map(i => 'n:' + norm(i.label))]));
    } catch (e) { ctx.log('catalogue search failed', e.message); }
    return { view: 'list', items: [...curated, ...catalog] };
  },

  // Catalogue stations: register a "click" (helps the community ranking) and play.
  async resolve(item, ctx) {
    if (!item.resolve) return { url: item.url, mime: item.mime };
    try {
      const r = await api(ctx, 'url/' + encodeURIComponent(item.id));
      if (r && r.url) {
        const url = secure(r.url);
        if (/^https:/i.test(url)) return { url };
      }
    } catch (e) { ctx.log('click count failed', e.message); }
    return { url: item.url };
  },
});
