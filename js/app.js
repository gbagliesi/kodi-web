import * as store from './storage.js';
import * as addons from './addons.js';
import * as player from './player.js';
import { handleNavKey, focusables } from './nav.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const crumbs = $('crumbs');
const backBtn = $('back-btn');
const searchBtn = $('search-btn');
const viewBtn = $('view-btn');

// ---------------------------------------------------------------- helpers
function fill(el, ...nodes) {
  el.replaceChildren(...nodes.flat().filter(n => n != null && n !== false && n !== ''));
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function safeImg(url) {
  if (!url) return '';
  try { const u = new URL(url, location.href); return /^(https?|data|blob):$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
}
const bg = (url) => (safeImg(url) ? { backgroundImage: `url("${safeImg(url).replace(/"/g, '%22')}")` } : {});

let toastTimer = 0;
export function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function modal({ title, body, actions }) {
  return new Promise((resolve) => {
    const m = $('modal');
    const prevFocus = document.activeElement;
    $('modal-title').textContent = title;
    const b = $('modal-body'); fill(b, body || '');
    const a = $('modal-actions'); fill(a);
    const done = (val) => { m.hidden = true; m.onclick = null; prevFocus?.focus?.({ preventScroll: true }); resolve(val); };
    for (const act of actions) {
      a.append(h('button', { class: 'btn focusable ' + (act.primary ? 'primary' : act.danger ? 'danger' : ''), onclick: () => done(act.value) }, act.label));
    }
    m.onclick = (e) => { if (e.target === m) done(undefined); };
    m._close = done;
    m.hidden = false;
    const first = b.querySelector('input, textarea, select') || a.querySelector('.primary') || a.firstChild;
    setTimeout(() => first?.focus(), 30);
    b.querySelectorAll('input').forEach(i => i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(actions.find(x => x.primary)?.value); }
    }));
  });
}

async function prompt(title, { placeholder = '', value = '', type = 'text', hint = '' } = {}) {
  const input = h('input', { type, placeholder, value, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const body = h('div', { class: 'field' }, input, hint && h('div', { class: 'hint' }, hint));
  const ok = await modal({ title, body, actions: [{ label: 'Annulla', value: false }, { label: 'OK', value: true, primary: true }] });
  return ok ? input.value.trim() : null;
}

function confirmBox(title, text, okLabel = 'Conferma', danger = false) {
  return modal({ title, body: h('p', {}, text), actions: [{ label: 'Annulla', value: false }, { label: okLabel, value: true, primary: !danger, danger }] });
}

function setCrumbs(parts) {
  fill(crumbs, ...parts.flatMap((p, i) => [i ? h('span', { class: 'sep' }, '›') : null, h('span', { class: i < parts.length - 1 ? 'dim' : '' }, p)]));
  document.title = parts[parts.length - 1] + ' · Salotto';
}

function loading(text = 'Caricamento…') {
  fill(view, h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text));
}

function errorBox(err, retry) {
  return h('div', { class: 'error-box' },
    h('p', {}, 'Si è verificato un errore'),
    h('pre', {}, err && err.message ? err.message : String(err)),
    retry && h('button', { class: 'btn focusable', onclick: retry }, 'Riprova'));
}

function focusFirst(container = view) {
  const kb = document.body.classList.contains('kbd-nav');
  if (!kb) return;
  const f = focusables(container)[0];
  f?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- menu
const MENU = [
  { route: '', ico: '⌂', label: 'Home' },
  { route: 'video', ico: '🎬', label: 'Video' },
  { route: 'music', ico: '🎵', label: 'Musica' },
  { route: 'live', ico: '📺', label: 'TV' },
  { route: 'files', ico: '📁', label: 'File' },
  { route: 'favourites', ico: '★', label: 'Preferiti' },
  { route: 'addons', ico: '🧩', label: 'Add-on' },
  { route: 'settings', ico: '⚙', label: 'Impostazioni' },
];

function renderMenu(active) {
  $('menu').replaceChildren(...MENU.map(m => h('button', {
    class: 'menu-item focusable' + (m.route === active ? ' active' : ''),
    onclick: () => go(m.route),
  }, h('span', { class: 'ico' }, m.ico), h('span', {}, m.label))));
}

// ---------------------------------------------------------------- router
function go(route) { location.hash = '#/' + route; }

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const parts = pathPart.split('/').map(decodeURIComponent);
  return { parts, params: new URLSearchParams(query) };
}

const scrollMemory = new Map();
let currentRouteKey = '';

async function route() {
  if (player.isOpen()) player.close();
  if (currentRouteKey) scrollMemory.set(currentRouteKey, view.scrollTop);
  const { parts, params } = parseRoute();
  currentRouteKey = location.hash;
  const [section = '', ...rest] = parts;
  renderMenu(section === 'browse' || section === 'addon' ? (rest[0] && sectionForAddon(rest[0])) : section);
  backBtn.hidden = !(section === 'browse' || section === 'addon' || (section === 'addons' && rest.length));
  searchBtn.hidden = true; viewBtn.hidden = true;
  searchBtn.onclick = null;
  try {
    switch (section) {
      case '': renderHome(); break;
      case 'video': renderSection('video', 'Video'); break;
      case 'music': renderSection('audio', 'Musica'); break;
      case 'live': renderSection('live', 'TV in diretta'); break;
      case 'files': renderFiles(); break;
      case 'favourites': renderFavourites(); break;
      case 'addons': rest[0] === 'repo' ? await renderRepo() : rest[0] ? renderAddonInfo(rest[0]) : renderAddons(); break;
      case 'settings': renderSettings(); break;
      case 'browse': await renderBrowse(rest[0], params.get('p') || '', params); break;
      default: renderHome();
    }
  } catch (e) {
    fill(view, errorBox(e, () => route()));
  }
  const y = scrollMemory.get(currentRouteKey);
  view.scrollTop = y || 0;
}

function sectionForAddon(id) {
  const a = addons.getInstalled(id);
  const p = a?.manifest.provides || [];
  if (p.includes('live')) return 'live';
  if (p.includes('video')) return 'video';
  if (p.includes('audio')) return 'music';
  return 'addons';
}

function browseHash(id, path = '', extra = {}) {
  const q = new URLSearchParams({ p: path, ...extra });
  return `#/browse/${encodeURIComponent(id)}?${q}`;
}

// ---------------------------------------------------------------- home
function addonTile(a, onclick) {
  const m = a.manifest;
  return h('button', { class: 'tile focusable', onclick },
    safeImg(m.icon) ? h('img', { class: 'tile-icon', src: safeImg(m.icon), alt: '' }) : h('span', { class: 'tile-ico' }, '🧩'),
    h('span', { class: 'tile-name' }, m.name),
    h('span', { class: 'tile-sub' }, m.summary || m.description || ''));
}

function renderHome() {
  setCrumbs(['Home']);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Buongiorno' : hour < 18 ? 'Buon pomeriggio' : 'Buonasera';
  const installed = addons.listInstalled().filter(a => a.enabled !== false);
  const favs = store.getFavourites().slice(0, 8);
  fill(view, 
    h('div', { class: 'hero' },
      h('h1', {}, greet),
      h('p', {}, 'Il tuo media center nel browser. Sfoglia gli add-on, apri un file o incolla l\'indirizzo di uno stream.')),
    h('div', { class: 'section-title' }, 'Sezioni'),
    h('div', { class: 'tiles' },
      ...MENU.slice(1, 5).map(m => h('button', { class: 'tile focusable', onclick: () => go(m.route) },
        h('span', { class: 'tile-ico' }, m.ico), h('span', { class: 'tile-name' }, m.label))),
      h('button', { class: 'tile focusable', onclick: openUrlDialog },
        h('span', { class: 'tile-ico' }, '🔗'), h('span', { class: 'tile-name' }, 'Apri URL'), h('span', { class: 'tile-sub' }, 'MP4, WebM, MP3, HLS (.m3u8)'))),
    favs.length ? h('div', { class: 'section-title' }, 'Preferiti') : null,
    favs.length ? renderItems(favs.map(f => f.item), { onPick: (it, i) => openFavourite(favs[i]) }) : null,
    h('div', { class: 'section-title' }, 'Add-on'),
    installed.length
      ? h('div', { class: 'tiles' }, ...installed.map(a => addonTile(a, () => { location.hash = browseHash(a.manifest.id); })))
      : h('div', { class: 'empty' }, 'Nessun add-on installato. ', h('button', { class: 'btn focusable', onclick: () => go('addons/repo') }, 'Sfoglia il repository')),
  );
  focusFirst();
}

function renderSection(kind, title) {
  setCrumbs([title]);
  const list = addons.addonsProviding(kind);
  fill(view, 
    h('div', { class: 'tiles' },
      ...list.map(a => addonTile(a, () => { location.hash = browseHash(a.manifest.id); })),
      kind !== 'live' && h('button', { class: 'tile focusable', onclick: openUrlDialog },
        h('span', { class: 'tile-ico' }, '🔗'), h('span', { class: 'tile-name' }, 'Apri URL'), h('span', { class: 'tile-sub' }, 'Riproduci un indirizzo diretto')),
      h('button', { class: 'tile focusable', onclick: () => go('addons/repo') },
        h('span', { class: 'tile-ico' }, '＋'), h('span', { class: 'tile-name' }, 'Altri add-on'), h('span', { class: 'tile-sub' }, 'Sfoglia il repository'))),
    !list.length ? h('div', { class: 'empty' }, 'Nessun add-on installato per questa sezione.') : null,
  );
  focusFirst();
}

async function openUrlDialog() {
  const url = await prompt('Apri URL', { type: 'url', placeholder: 'https://…/video.mp4 oppure .m3u8', hint: 'Il server deve permettere la riproduzione da altri siti; altrimenti configura un proxy nelle Impostazioni.' });
  if (!url) return;
  const label = decodeURIComponent(url.split('/').pop().split('?')[0] || url);
  const audio = /\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i.test(url);
  const item = { label, url, playable: true, type: audio ? 'audio' : 'video' };
  player.play(item, { url }, { favEntry: { key: 'url|' + url, item } });
}

// ---------------------------------------------------------------- listings
function itemIcon(it) {
  if (!it.playable) return '📁';
  if (it.type === 'audio') return '🎵';
  if (it.live) return '📺';
  return '🎬';
}

function chooseView(listing) {
  const pref = store.getSettings().viewMode;
  if (pref === 'list') return 'list';
  if (listing.view) return pref === 'grid' && listing.view === 'list' ? 'grid' : listing.view;
  if (pref === 'grid') return 'grid';
  const withThumb = listing.items.filter(i => i.thumb).length;
  return withThumb >= listing.items.length * 0.6 && listing.items.length ? 'grid' : 'list';
}

function renderItems(items, { mode = 'auto', onPick, listing } = {}) {
  const viewMode = mode === 'auto' ? chooseView(listing || { items }) : mode;
  if (viewMode === 'list') {
    return h('div', { class: 'list' }, ...items.map((it, i) => h('button', { class: 'row focusable', onclick: () => onPick(it, i) },
      h('span', { class: 'row-thumb', style: bg(it.thumb) }, safeImg(it.thumb) ? '' : itemIcon(it)),
      h('span', { class: 'row-main' },
        h('div', { class: 'row-label' }, it.label),
        (it.subtitle || it.info?.plot) && h('div', { class: 'row-sub' }, it.subtitle || it.info.plot)),
      h('span', { class: 'row-end' }, it.live ? 'LIVE' : it.info?.duration ? fmtDuration(it.info.duration) : it.playable ? '▶' : '›'))));
  }
  const cls = 'grid' + (viewMode === 'wide' ? ' wide' : viewMode === 'square' ? ' square' : '');
  return h('div', { class: cls }, ...items.map((it, i) => h('button', { class: 'card focusable', onclick: () => onPick(it, i), title: it.info?.plot || it.label },
    h('span', { class: 'thumb', style: bg(it.thumb) }, safeImg(it.thumb) ? '' : itemIcon(it)),
    h('span', { class: 'label' }, it.label),
    (it.subtitle || it.info?.year) && h('span', { class: 'sub' }, it.subtitle || it.info.year))));
}

function fmtDuration(s) {
  s = Number(s); if (!s) return '';
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

const listingCache = new Map();

async function renderBrowse(id, path, params) {
  const rec = addons.getInstalled(id);
  if (!rec) { fill(view, h('div', { class: 'empty' }, 'Add-on non installato.')); setCrumbs(['Add-on']); return; }
  const m = rec.manifest;
  const query = params.get('q');
  const titleTrail = (params.get('t') || '').split('␟').filter(Boolean);
  setCrumbs([m.name, ...titleTrail]);
  const cacheKey = location.hash;
  let listing = listingCache.get(cacheKey);
  if (!listing) {
    loading();
    try {
      const host = addons.getHost(id);
      listing = addons.normaliseListing(query != null ? await host.call('search', query) : await host.call('list', path));
      listingCache.set(cacheKey, listing);
      if (listingCache.size > 40) listingCache.delete(listingCache.keys().next().value);
    } catch (e) {
      if (location.hash !== cacheKey) return;
      fill(view, errorBox(e, () => route()));
      return;
    }
  }
  if (location.hash !== cacheKey) return; // user navigated away meanwhile

  const host = addons.getHost(id);
  if (host.capabilities.search) {
    searchBtn.hidden = false;
    searchBtn.onclick = async () => {
      const q = await prompt('Cerca in ' + m.name, { placeholder: 'Titolo, artista, canale…' });
      if (q) location.hash = browseHash(id, '', { q, t: 'Ricerca: ' + q });
    };
  }
  viewBtn.hidden = false;
  viewBtn.onclick = () => {
    const cur = store.getSettings().viewMode;
    store.setSettings({ viewMode: cur === 'list' ? 'grid' : 'list' });
    route();
  };

  const onPick = (it) => pick(id, it, titleTrail);
  fill(view, 
    listing.message ? h('p', { class: 'empty' }, listing.message) : null,
    listing.items.length ? renderItems(listing.items, { onPick, listing }) : h('div', { class: 'empty' }, 'Nessun elemento.'),
  );
  focusFirst();
}

async function pick(addonId, it, trail = []) {
  if (it.action === 'search') {
    const q = await prompt(it.label, { placeholder: 'Cerca…' });
    if (q) location.hash = browseHash(addonId, '', { q, t: [...trail, 'Ricerca: ' + q].join('␟') });
    return;
  }
  if (it.action === 'settings') { go('addons/' + addonId); return; }
  if (it.external) {
    // Content that only plays on its own site (e.g. YouTube live channels)
    if (/^https:\/\//i.test(it.external)) window.open(it.external, '_blank', 'noopener');
    return;
  }
  if (!it.playable) {
    location.hash = browseHash(addonId, it.path ?? '', { t: [...trail, it.label].join('␟') });
    return;
  }
  toast('Apertura di «' + it.label + '»…', 1500);
  try {
    const stream = await addons.resolveItem(addonId, it);
    const merged = { ...it, ...(stream.item || {}) };
    player.play(merged, stream, { favEntry: { key: addonId + '|' + (it.path || it.url || it.id || it.label), addonId, item: it } });
  } catch (e) {
    toast(e.message, 5000);
  }
}

function openFavourite(f) {
  if (f.addonId) {
    if (!addons.getInstalled(f.addonId)) { toast('Add-on non più installato'); return; }
    pick(f.addonId, f.item);
  } else {
    player.play(f.item, { url: f.item.url }, { favEntry: f });
  }
}

function renderFavourites() {
  setCrumbs(['Preferiti']);
  const favs = store.getFavourites();
  if (!favs.length) {
    fill(view, h('div', { class: 'empty' }, 'Nessun preferito. Durante la riproduzione tocca ☆ per aggiungere un elemento.'));
    return;
  }
  fill(view, renderItems(favs.map(f => ({ ...f.item, subtitle: addons.getInstalled(f.addonId)?.manifest.name || f.item.subtitle })), {
    mode: 'list',
    onPick: (it, i) => openFavourite(favs[i]),
  }));
  focusFirst();
}

// ---------------------------------------------------------------- local files
const localFiles = [];

function renderFiles() {
  setCrumbs(['File locali']);
  const input = h('input', { type: 'file', accept: 'video/*,audio/*,.mkv,.m4v,.mov,.mp3,.m4a,.flac,.ogg,.opus,.webm', multiple: true, hidden: true });
  input.addEventListener('change', () => {
    for (const f of input.files) localFiles.push({ file: f, url: URL.createObjectURL(f) });
    renderFiles();
  });
  const items = localFiles.map(({ file, url }) => ({
    label: file.name, url, playable: true,
    type: file.type.startsWith('audio') ? 'audio' : 'video',
    subtitle: (file.size / 1048576).toFixed(1) + ' MB',
    mime: file.type,
  }));
  fill(view, 
    h('div', { class: 'actions' },
      input,
      h('button', { class: 'btn primary focusable', onclick: () => input.click() }, 'Scegli file…'),
      localFiles.length ? h('button', { class: 'btn focusable', onclick: () => { localFiles.forEach(f => URL.revokeObjectURL(f.url)); localFiles.length = 0; renderFiles(); } }, 'Svuota elenco') : null),
    h('p', { class: 'empty', style: { padding: '16px 4px', textAlign: 'left' } },
      'Su iPad puoi scegliere file da "File", iCloud Drive o da un disco USB. I file restano sul dispositivo: non vengono caricati da nessuna parte. Formati: MP4/H.264, HEVC, MOV, MP3, AAC; MKV e AVI dipendono dal browser.'),
    items.length ? renderItems(items, { mode: 'list', onPick: (it) => player.play(it, { url: it.url, mime: it.mime }) }) : null,
  );
  focusFirst();
}

// ---------------------------------------------------------------- add-on manager
function renderAddons() {
  setCrumbs(['Add-on']);
  const list = addons.listInstalled();
  fill(view, 
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary focusable', onclick: () => go('addons/repo') }, 'Sfoglia repository'),
      h('button', { class: 'btn focusable', onclick: installFromUrlDialog }, 'Installa da URL'),
      h('button', { class: 'btn focusable', onclick: addRepoDialog }, 'Aggiungi repository')),
    h('div', { class: 'section-title' }, `Installati (${list.length})`),
    list.length ? h('div', { class: 'list' }, ...list.map(a => h('button', { class: 'row focusable', onclick: () => go('addons/' + encodeURIComponent(a.manifest.id)) },
      h('span', { class: 'row-thumb', style: bg(a.manifest.icon) }, safeImg(a.manifest.icon) ? '' : '🧩'),
      h('span', { class: 'row-main' },
        h('div', { class: 'row-label' }, a.manifest.name),
        h('div', { class: 'row-sub' }, `${a.manifest.id} · v${a.manifest.version}${a.enabled === false ? ' · disattivato' : ''}`)),
      h('span', { class: 'row-end' }, '›')))) : h('div', { class: 'empty' }, 'Nessun add-on installato.'),
  );
  focusFirst();
}

async function installFromUrlDialog() {
  const url = await prompt('Installa add-on da URL', { type: 'url', placeholder: 'https://…/addon.json', hint: "Indirizzo del file addon.json dell'add-on." });
  if (!url) return;
  toast('Installazione…');
  try {
    const rec = await addons.installFromManifestUrl(url);
    toast(`Installato: ${rec.manifest.name} v${rec.manifest.version}`);
    renderAddons();
  } catch (e) { toast(e.message, 6000); }
}

async function addRepoDialog() {
  const url = await prompt('Aggiungi repository', { type: 'url', placeholder: 'https://…/repository.json' });
  if (!url) return;
  try {
    await addons.fetchRepository(url);
    const s = store.getSettings();
    if (!s.repositories.includes(url)) store.setSettings({ repositories: [...s.repositories, url] });
    toast('Repository aggiunto');
    go('addons/repo');
  } catch (e) { toast(e.message, 6000); }
}

async function renderRepo() {
  setCrumbs(['Add-on', 'Repository']);
  loading('Lettura dei repository…');
  const repos = store.getSettings().repositories;
  const results = await Promise.all(repos.map(u => addons.fetchRepository(u).catch(e => ({ url: u, error: e }))));
  if (!location.hash.startsWith('#/addons/repo')) return;
  const sections = [];
  for (const r of results) {
    sections.push(h('div', { class: 'section-title' }, r.name || r.url));
    if (r.error) {
      sections.push(h('div', { class: 'error-box' }, r.error.message,
        repos.indexOf(r.url) > 0 && h('div', {}, h('button', { class: 'btn danger focusable', onclick: () => { store.setSettings({ repositories: repos.filter(x => x !== r.url) }); renderRepo(); } }, 'Rimuovi repository'))));
      continue;
    }
    sections.push(h('div', { class: 'list' }, ...r.addons.map(a => {
      const inst = addons.getInstalled(a.id);
      const status = !inst ? 'Installa' : addons.compareVersions(a.version, inst.manifest.version) > 0 ? 'Aggiorna' : 'Installato';
      return h('button', {
        class: 'row focusable',
        onclick: async () => {
          if (status === 'Installato') { go('addons/' + encodeURIComponent(a.id)); return; }
          toast('Installazione di ' + a.name + '…');
          try { await addons.installFromManifestUrl(a.manifest, { source: 'repo' }); toast(a.name + ' installato'); renderRepo(); } catch (e) { toast(e.message, 6000); }
        },
      },
      h('span', { class: 'row-thumb', style: bg(a.icon) }, safeImg(a.icon) ? '' : '🧩'),
      h('span', { class: 'row-main' }, h('div', { class: 'row-label' }, `${a.name}  v${a.version}`), h('div', { class: 'row-sub' }, a.description || a.id)),
      h('span', { class: 'row-end' }, status));
    })));
  }
  fill(view, ...sections);
  focusFirst();
}

function settingField(def, value) {
  const id = 'set-' + def.id;
  let input;
  switch (def.type) {
    case 'bool':
      input = h('input', { type: 'checkbox', id, checked: !!value });
      return { node: h('div', { class: 'field check' }, input, h('label', { for: id }, def.label || def.id)), get: () => input.checked };
    case 'select':
      input = h('select', { id }, ...(def.options || []).map(o => {
        const val = typeof o === 'object' ? o.value : o;
        const lab = typeof o === 'object' ? o.label : o;
        return h('option', { value: val, selected: String(val) === String(value) }, lab);
      }));
      break;
    case 'textarea':
      input = h('textarea', { id, placeholder: def.placeholder || '', spellcheck: 'false' });
      input.value = value ?? '';
      break;
    case 'number':
      input = h('input', { type: 'number', id, value: value ?? '' });
      break;
    default:
      input = h('input', { type: def.type === 'url' ? 'url' : 'text', id, value: value ?? '', placeholder: def.placeholder || '', autocapitalize: 'off', spellcheck: 'false' });
  }
  return {
    node: h('div', { class: 'field' }, h('label', { for: id }, def.label || def.id), input, def.hint && h('div', { class: 'hint' }, def.hint)),
    get: () => def.type === 'number' ? Number(input.value) : input.value,
  };
}

function renderAddonInfo(id) {
  const rec = addons.getInstalled(id);
  if (!rec) { go('addons'); return; }
  const m = rec.manifest;
  setCrumbs(['Add-on', m.name]);
  const values = addons.getAddonSettings(id);
  const fields = (m.settings || []).map(d => ({ def: d, ...settingField(d, values[d.id]) }));
  fill(view, 
    h('div', { class: 'addon-detail' },
      h('div', { class: 'big-icon', style: bg(m.icon) }, safeImg(m.icon) ? '' : '🧩'),
      h('div', { class: 'meta' },
        h('h2', {}, m.name),
        h('div', {}, h('span', { class: 'pill' }, 'v' + m.version), ...(m.provides || []).map(p => h('span', { class: 'pill ok' }, p)), h('span', { class: 'pill' }, m.id)),
        m.author && h('div', { class: 'hint' }, 'Autore: ' + m.author),
        h('p', {}, m.description || ''),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary focusable', disabled: rec.enabled === false, onclick: () => { location.hash = browseHash(id); } }, 'Apri'),
          h('button', { class: 'btn focusable', onclick: () => { addons.setEnabled(id, rec.enabled === false); renderAddonInfo(id); } }, rec.enabled === false ? 'Attiva' : 'Disattiva'),
          rec.manifestUrl && h('button', { class: 'btn focusable', onclick: async () => {
            try { await addons.installFromManifestUrl(rec.manifestUrl, { source: rec.source }); toast('Add-on aggiornato'); listingCache.clear(); renderAddonInfo(id); } catch (e) { toast(e.message, 6000); }
          } }, 'Ricarica / aggiorna'),
          h('button', { class: 'btn danger focusable', onclick: async () => {
            if (await confirmBox('Disinstalla', `Rimuovere ${m.name}?`, 'Disinstalla', true)) { addons.uninstall(id); listingCache.clear(); go('addons'); }
          } }, 'Disinstalla')))),
    fields.length ? h('div', { class: 'section-title' }, 'Impostazioni add-on') : null,
    fields.length ? h('div', { class: 'form' }, ...fields.map(f => f.node),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary focusable', onclick: () => {
        const vals = {}; for (const f of fields) vals[f.def.id] = f.get();
        addons.setAddonSettings(id, vals);
        listingCache.clear();
        toast('Impostazioni salvate');
      } }, 'Salva'))) : null,
  );
  focusFirst();
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  setCrumbs(['Impostazioni']);
  const s = store.getSettings();
  const proxy = h('input', { type: 'url', id: 'proxy', value: s.proxyUrl, placeholder: 'es. https://salotto-proxy.tuonome.workers.dev', autocapitalize: 'off', spellcheck: 'false' });
  const token = h('input', { type: 'text', id: 'proxy-token', value: s.proxyToken, placeholder: 'facoltativo', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
  const resume = h('input', { type: 'checkbox', id: 'resume', checked: s.autoResume });
  const viewSel = h('select', { id: 'viewmode' }, ...[['auto', 'Automatica'], ['grid', 'Griglia'], ['list', 'Elenco']].map(([v, l]) => h('option', { value: v, selected: s.viewMode === v }, l)));
  const active = addons.getProxy();
  fill(view, h('div', { class: 'form' },
    h('div', { class: 'field' }, h('label', { for: 'proxy' }, 'Proxy per add-on e stream'), proxy,
      h('div', { class: 'hint' }, 'Molti siti bloccano le richieste dirette dal browser (CORS). Incolla l\'indirizzo del tuo proxy Cloudflare (vedi la guida docs/CLOUDFLARE.md) oppure di "node server.js" su un PC o NAS. Lascia vuoto per rilevarlo automaticamente.'),
      location.protocol === 'https:' && /^http:/i.test(s.proxyUrl) ? h('div', { class: 'hint', style: { color: 'var(--danger)' } }, 'Questa pagina è in HTTPS: il browser bloccherà un proxy in HTTP. Usa un proxy HTTPS, come quello su Cloudflare.') : null,
      h('div', { class: 'hint' }, 'Proxy attivo: ', active ? active.replace(/token=[^&]+/, 'token=•••') : 'nessuno')),
    h('div', { class: 'field' }, h('label', { for: 'proxy-token' }, 'Token del proxy'), token,
      h('div', { class: 'hint' }, 'Lo stesso valore impostato come TOKEN nel proxy. Impedisce ad altri di usarlo.')),
    h('div', { class: 'field check' }, resume, h('label', { for: 'resume' }, 'Riprendi i video dal punto in cui li hai lasciati')),
    h('div', { class: 'field' }, h('label', { for: 'viewmode' }, 'Vista degli elenchi'), viewSel),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary focusable', onclick: async () => {
        store.setSettings({ proxyUrl: proxy.value.trim(), proxyToken: token.value.trim(), autoResume: resume.checked, viewMode: viewSel.value });
        listingCache.clear();
        const p = await addons.detectProxy();
        if (!p) toast('Salvato');
        else toast((await addons.checkProxy(p)) ? 'Salvato · proxy raggiungibile ✓' : 'Salvato, ma il proxy non risponde: controlla l\'indirizzo', 5000);
        renderSettings();
      } }, 'Salva'),
      h('button', { class: 'btn danger focusable', onclick: async () => {
        if (await confirmBox('Ripristina', 'Cancellare add-on, preferiti e impostazioni?', 'Cancella tutto', true)) {
          Object.keys(localStorage).filter(k => k.startsWith('salotto:')).forEach(k => localStorage.removeItem(k));
          location.hash = '#/'; location.reload();
        }
      } }, 'Ripristina tutto')),
    h('div', { class: 'section-title' }, 'Informazioni'),
    h('p', { class: 'hint' }, 'Salotto è un media center leggero ispirato ai media center da salotto, che gira interamente nel browser. Gli add-on sono script JavaScript eseguiti in isolamento (Web Worker). Usa solo fonti di cui hai i diritti.'),
  ));
  focusFirst();
}

// ---------------------------------------------------------------- global keys
document.addEventListener('keydown', (e) => {
  const modalEl = $('modal');
  if (!modalEl.hidden && e.key === 'Escape') { modalEl._close?.(undefined); e.preventDefault(); return; }
  if (player.handleKey(e)) { e.preventDefault(); return; }
  const a = document.activeElement;
  const typing = a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'range', 'button'].includes(a.type)));
  if ((e.key === 'Backspace' || e.key === 'Escape' || e.key === 'BrowserBack') && !typing && modalEl.hidden) {
    if (location.hash && location.hash !== '#/') { history.back(); e.preventDefault(); }
    return;
  }
  if (handleNavKey(e)) e.preventDefault();
});

backBtn.addEventListener('click', () => history.back());
window.addEventListener('hashchange', route);

addons.setNotifyHandler((msg, m) => toast(`${m.name}: ${msg}`, 4000));
addons.onAddonsChanged(() => { /* listings may depend on installed set */ });

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 15000); tickClock();

// ---------------------------------------------------------------- boot
(async function boot() {
  renderMenu('');
  loading('Avvio…');
  await addons.detectProxy();
  await addons.ensureBundledAddons();
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
})();

// exposed for debugging / tests
window.salotto = { addons, store, player };
