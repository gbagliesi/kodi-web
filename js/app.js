import * as store from './storage.js';
import * as addons from './addons.js';
import * as player from './player.js';
import * as epg from './epg.js';
import { handleNavKey, focusables } from './nav.js';
import { versionLabel } from './version.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const crumbs = $('crumbs');
const backBtn = $('back-btn');
const searchBtn = $('search-btn');
const viewBtn = $('view-btn');
const pinBtn = $('pin-btn');

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
  // never start inside a text field: on a TV that opens the on-screen keyboard
  const f = focusables(container).find(x => !(x.tagName === 'INPUT' && !['checkbox', 'radio', 'range'].includes(x.type)) && x.tagName !== 'TEXTAREA');
  f?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- menu
const MENU = [
  { route: '', ico: '⌂', label: 'Home' },
  { route: 'video', ico: '🎬', label: 'Video' },
  { route: 'music', ico: '🎵', label: 'Musica' },
  { route: 'live', ico: '📺', label: 'TV' },
  { route: 'guide', ico: '🗓', label: 'Guida TV', short: 'Guida' },
  { route: 'files', ico: '📁', label: 'File' },
  { route: 'favourites', ico: '★', label: 'Preferiti' },
  { route: 'addons', ico: '🧩', label: 'Add-on' },
  { route: 'settings', ico: '⚙', label: 'Impostazioni', short: 'Opzioni' },
];

function renderMenu(active) {
  $('menu').replaceChildren(...MENU.map(m => h('button', {
    class: 'menu-item focusable' + (m.route === active ? ' active' : ''),
    onclick: () => go(m.route),
    'aria-label': m.label,
  }, h('span', { class: 'ico' }, m.ico), h('span', { class: 'lbl' }, m.label), h('span', { class: 'lbl-short' }, m.short || m.label))));
}

// Keep the page itself from ever scrolling: on Android, leaving full screen or the status
// bar appearing can leave the whole app shifted up, with the header under the status bar.
const pinPage = () => { if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0); };
for (const ev of ['resize', 'orientationchange', 'fullscreenchange', 'webkitfullscreenchange', 'scroll']) window.addEventListener(ev, pinPage, { passive: true });
document.addEventListener('fullscreenchange', () => setTimeout(pinPage, 300));

// ---------------------------------------------------------------- start page (📌)
function updatePinBtn() {
  const on = store.getSettings().startPage === location.hash;
  pinBtn.classList.toggle('active', on);
  pinBtn.title = on ? 'È la pagina iniziale (tocca per tornare a Home)' : 'Imposta come pagina iniziale';
  pinBtn.setAttribute('aria-label', pinBtn.title);
}
pinBtn.addEventListener('click', () => {
  if (store.getSettings().startPage === location.hash) {
    store.setSettings({ startPage: '', startLabel: '' });
    toast('Pagina iniziale: Home');
  } else {
    const label = [...crumbs.querySelectorAll('span:not(.sep)')].map(e => e.textContent).join(' › ');
    store.setSettings({ startPage: location.hash, startLabel: label });
    toast('Pagina iniziale: ' + label);
  }
  updatePinBtn();
});

/** Address to open at launch, or '' for Home. */
function startPage() {
  const s = store.getSettings();
  const p = s.startPage === 'last' ? store.load('lastPage', '') : s.startPage;
  return p && p !== '#/' && p.startsWith('#/') ? p : '';
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
  // pages that can be the start page (📌): sections and add-on folders
  pinBtn.hidden = !['video', 'music', 'live', 'guide', 'files', 'favourites', 'browse'].includes(section);
  updatePinBtn();
  if (section !== 'settings') store.save('lastPage', location.hash);
  try {
    switch (section) {
      case '': renderHome(); break;
      case 'video': renderSection('video', 'Video'); break;
      case 'music': renderSection('audio', 'Musica'); break;
      case 'live': renderSection('live', 'TV in diretta'); break;
      case 'guide': await renderGuide(params); break;
      case 'files': renderFiles(); break;
      case 'favourites': await renderFavourites(); break;
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
      ...MENU.slice(1, 6).map(m => h('button', { class: 'tile focusable', onclick: () => go(m.route) },
        h('span', { class: 'tile-ico' }, m.ico), h('span', { class: 'tile-name' }, m.label))),
      h('button', { class: 'tile focusable', onclick: openUrlDialog },
        h('span', { class: 'tile-ico' }, '🔗'), h('span', { class: 'tile-name' }, 'Apri URL'), h('span', { class: 'tile-sub' }, 'MP4, WebM, MP3, HLS (.m3u8)'))),
    favs.length ? h('div', { class: 'section-title' }, 'Preferiti') : null,
    favs.length ? renderItems(favs.map(f => f.item), { onPick: (it, i) => openFavourite(favs[i], favs) }) : null,
    h('div', { class: 'section-title' }, 'Add-on'),
    installed.length
      ? h('div', { class: 'tiles' }, ...installed.map(a => addonTile(a, () => { location.hash = browseHash(a.manifest.id); })))
      : h('div', { class: 'empty' }, 'Nessun add-on installato. ', h('button', { class: 'btn focusable', onclick: () => go('addons/repo') }, 'Sfoglia il repository')),
    h('p', { class: 'hint', style: { textAlign: 'center', marginTop: '28px', color: 'var(--muted)', fontSize: '12px' } }, 'Salotto ' + versionLabel()),
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
const isLogoItem = (it) => !!(it.live || it.type === 'audio' || it.logo);

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
  // live channels show the number used to tune them in the player (CH ±, digits)
  const live = items.filter(x => x.live && x.playable && !x.external && !x.action);
  const numOf = new Map();
  if (live.length > 1) player.channelNumbers(live).forEach((n, i) => numOf.set(live[i], n));
  const num = (it) => numOf.has(it) ? h('span', { class: 'ch-num' }, String(numOf.get(it))) : null;
  if (viewMode === 'list') {
    return h('div', { class: 'list' }, ...items.map((it, i) => h('button', { class: 'row focusable', onclick: () => onPick(it, i) },
      h('span', { class: 'row-thumb' + (isLogoItem(it) ? ' logo' : ''), style: bg(it.thumb) }, safeImg(it.thumb) ? '' : itemIcon(it)),
      h('span', { class: 'row-main' },
        h('div', { class: 'row-label' }, num(it), it.label, it._new ? h('span', { class: 'new-badge' }, 'NUOVO') : null),
        (subOf(it) || it.info?.plot) && h('div', { class: 'row-sub' }, subOf(it) || it.info.plot)),
      h('span', { class: 'row-end' }, it.live ? 'LIVE' : it.info?.duration ? fmtDuration(it.info.duration) : it.playable ? '▶' : '›'))));
  }
  // Channel and station logos are shown whole on square tiles; posters and covers fill theirs.
  const logos = items.filter(isLogoItem).length > items.length / 2;
  const shape = viewMode === 'wide' ? ' wide' : (viewMode === 'square' || logos) ? ' square' : '';
  const cls = 'grid' + shape;
  return h('div', { class: cls }, ...items.map((it, i) => h('button', { class: 'card focusable', onclick: () => onPick(it, i), title: it.info?.plot || it.label },
    isLogoItem(it) && safeImg(it.thumb)
      ? h('span', { class: 'thumb logo' }, h('img', { class: 'thumb-img', src: safeImg(it.thumb), alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('span', { class: 'thumb-ico' }, itemIcon(it))) }))
      : h('span', { class: 'thumb', style: bg(it.thumb) }, safeImg(it.thumb) ? '' : h('span', { class: 'thumb-ico' }, itemIcon(it))),
    h('span', { class: 'label' }, num(it), it.label, it._new ? h('span', { class: 'new-badge' }, 'NUOVO') : null),
    (subOf(it) || it.info?.year) && h('span', { class: 'sub' }, subOf(it) || it.info.year))));
}

// Live channels show what is on now from the TV guide (unless the add-on already says it).
function subOf(it) {
  if (it.live && !/(^| · )Ora: /.test(it.subtitle || '')) { const line = epg.nowLine(it); if (line) return [it.note, line].filter(Boolean).join(' · '); }
  return it.subtitle;
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
  // Lists that say which playlist/group they are (listId) keep their order even if the
  // playlists are reordered in the settings; older saved orders are moved over once.
  const oldKey = id + '|' + (query != null ? 'q:' + query : path || '');
  const listKey = listing.listId ? id + '|' + listing.listId : oldKey;
  if (listKey !== oldKey) migrateSort(oldKey, listKey);
  const refresh = listing.updatedAt ? async () => {
    loading();
    try {
      listing = addons.normaliseListing(await addons.getHost(id).callWith({ refresh: true }, 'list', path));
      listingCache.set(cacheKey, listing);
    } catch (e) { toast(e.message, 5000); }
    if (location.hash === cacheKey) route();
  } : null;
  viewBtn.onclick = () => viewAndSortDialog(listKey, listing.items, { updatedAt: listing.updatedAt, refresh });

  if (listing.items.some(x => x.live)) { await epg.ready(); if (location.hash !== cacheKey) return; }
  numberLiveItems(listing.items);
  const cfg = getSort(listKey);
  trackSort(listKey, cfg, listing.items);
  const items = sortItems(listing.items, cfg);
  const channels = channelList(id, items);
  const onPick = (it) => pick(id, it, titleTrail, channels);
  const notice = listing.notice ? h('p', { class: 'list-notice' + (listing.noticeKind === 'warn' ? ' warn' : '') }, listing.notice) : null;
  if (listing.notice && listing.noticeOnce) { delete listing.notice; }
  fill(view,
    listing.message ? h('p', { class: 'empty' }, listing.message) : null,
    notice,
    sortBadge(cfg),
    items.length ? renderItems(items, { onPick, listing }) : h('div', { class: 'empty' }, 'Nessun elemento.'),
  );
  focusFirst();
}

// ---------------------------------------------------------------- list order (▦ button)
// Each list remembers its own order: { mode, order: [keys], seen: {key: time}, gone: {key: time}, newAtEnd }.
// The saved custom order stays even while another order is shown, until it is deleted.
// Items are recognised by a stable key from the add-on (tvg-id or channel name), falling back
// to address, path or label, so a channel that changes address keeps its place.
const DAY = 24 * 3600 * 1000;
const NEW_DAYS = 7, GONE_DAYS = 30;
const itemKeys = (it) => [it.key, it.url, it.external, it.path, it.id, it.label].filter(Boolean).map(String);
const itemKey = (it) => itemKeys(it)[0] || '';
const getSort = (listKey) => store.load('sort', {})[listKey] || { mode: 'source' };
function setSort(listKey, cfg) {
  const all = store.load('sort', {});
  if (!cfg || (cfg.mode === 'source' && !cfg.order)) delete all[listKey]; else all[listKey] = cfg;
  store.save('sort', all);
}
function migrateSort(oldKey, newKey) {
  const all = store.load('sort', {});
  if (all[oldKey] && !all[newKey]) { all[newKey] = all[oldKey]; delete all[oldKey]; store.save('sort', all); }
}

/** Matches the saved order to the current items: Map item -> position in cfg.order. */
function matchOrder(items, order) {
  const pos = new Map();
  order.forEach((k, i) => { if (!pos.has(k)) pos.set(k, i); });
  const used = new Set(), placed = new Map();
  for (const it of items) {
    for (const k of itemKeys(it)) {
      if (pos.has(k) && !used.has(k)) { placed.set(it, pos.get(k)); used.add(k); break; }
    }
  }
  return { placed, used };
}

/** Keeps a saved custom order in step with the list: new keys, new channels, channels gone. */
function trackSort(listKey, cfg, items) {
  if (!cfg.order) return;
  const now = Date.now();
  const { placed } = matchOrder(items, cfg.order);
  let changed = false;
  const order = [...cfg.order], seen = { ...(cfg.seen || {}) }, gone = { ...(cfg.gone || {}) };
  for (const [it, i] of placed) {
    const k = itemKey(it);
    if (order[i] !== k) { order[i] = k; changed = true; } // e.g. saved by address, now by name
    if (gone[k]) { delete gone[k]; changed = true; }
  }
  for (const it of items) {
    if (placed.has(it)) continue;
    const k = itemKey(it);
    if (!seen[k]) { seen[k] = now; changed = true; }
  }
  const present = new Set(placed.values());
  const keep = [];
  for (const [i, k] of order.entries()) {
    if (present.has(i)) { keep.push(k); continue; }
    if (!gone[k]) { gone[k] = now; changed = true; }
    if (now - gone[k] > GONE_DAYS * DAY) { delete gone[k]; changed = true; continue; } // gone for good
    keep.push(k);
  }
  for (const k of Object.keys(seen)) if (now - seen[k] > NEW_DAYS * DAY) { delete seen[k]; changed = true; }
  if (changed) setSort(listKey, { ...cfg, order: keep, seen, gone });
}

/** A short line under the title saying which order is shown (only when it is not the original). */
function sortBadge(cfg) {
  const labels = { number: 'per numero di canale', name: 'per nome (A–Z)', custom: 'il tuo ordine personalizzato' };
  if (!labels[cfg.mode]) return null;
  return h('p', { class: 'list-notice' }, 'Ordine: ' + labels[cfg.mode] + ' · cambialo con ▦');
}

/** Fixes each live channel's number from the source order, so sorting never renumbers them. */
function numberLiveItems(items) {
  const live = items.filter(x => x.live && x.playable && !x.external && !x.action);
  if (live.length < 2 || live.every(x => x._numbered)) return;
  player.channelNumbers(live).forEach((n, i) => { live[i].number = String(n); live[i]._numbered = true; });
}

function sortItems(items, cfg) {
  for (const it of items) delete it._new; // set again below for the custom order
  const mode = cfg?.mode || 'source';
  if (mode === 'source') return items;
  if (mode === 'custom') return applyCustom(items, cfg);
  // folders stay first, in their order; playable entries are sorted
  const folders = items.filter(it => !it.playable), rest = items.filter(it => it.playable);
  const num = (it) => parseInt(it.number, 10) || Infinity;
  const byName = (a, b) => a.label.localeCompare(b.label, 'it', { numeric: true, sensitivity: 'base' });
  rest.sort(mode === 'number' ? (a, b) => (num(a) - num(b)) || byName(a, b) : byName);
  return [...folders, ...rest];
}

/** The saved order applied to the current list. Channels not in it (new ones) go next to the
 *  channel that precedes them in the source list, or at the end if the user prefers. */
function applyCustom(items, cfg) {
  const { placed } = matchOrder(items, cfg.order || []);
  const now = Date.now();
  const out = items.filter(it => placed.has(it)).sort((a, b) => placed.get(a) - placed.get(b));
  const fresh = items.filter(it => !placed.has(it));
  for (const it of fresh) {
    const t = cfg.seen?.[itemKey(it)];
    if (out.length && (!t || now - t < NEW_DAYS * DAY)) it._new = true;
  }
  if (cfg.newAtEnd) return [...out, ...fresh];
  for (const it of fresh) {
    let at = 0;
    for (let j = items.indexOf(it) - 1; j >= 0; j--) {
      const idx = out.indexOf(items[j]);
      if (idx >= 0) { at = idx + 1; break; }
    }
    out.splice(at, 0, it);
  }
  return out;
}

function fmtWhen(t) {
  const d = new Date(t), today = new Date();
  const hm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return 'oggi alle ' + hm;
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) + ' alle ' + hm;
}

async function viewAndSortDialog(listKey, sourceItems, { updatedAt, refresh, onSave, sourceLabel, sourceHint } = {}) {
  const s = store.getSettings();
  const cur = getSort(listKey);
  const hasOrder = !!cur.order?.length;
  const hasNumbers = sourceItems.some(it => it.live && it.number);
  const viewSel = h('select', { id: 'dlg-view' }, ...[['auto', 'Automatica'], ['list', 'Elenco'], ['grid', 'Icone']].map(([v, l]) => h('option', { value: v, selected: s.viewMode === v }, l)));
  const sorts = [
    ['source', sourceLabel || 'Lista originale (senza modifiche)', (sourceHint || 'Esattamente come la pubblica la sorgente.') + ' Il tuo ordine personalizzato, se c\'è, resta salvato.'],
    ...(hasNumbers ? [['number', 'Per numero di canale', 'Come sul telecomando: 1 Rai 1, 2 Rai 2, …']] : []),
    ['name', 'Per nome (A–Z)', 'In ordine alfabetico.'],
    ['custom', 'Il mio ordine personalizzato', hasOrder
      ? 'Il tuo ordine salvato.' + (sourceLabel ? '' : ' Quando la lista si aggiorna, i canali restano al loro posto; quelli nuovi sono segnati NUOVO.')
      : 'Non hai ancora un ordine tuo: premi OK e sposta i canali con ▲ ▼.'],
  ];
  const sortSel = h('select', { id: 'dlg-sort' }, ...sorts.map(([v, l]) => h('option', { value: v, selected: cur.mode === v }, l)));
  const hint = h('div', { class: 'hint' });
  const newEnd = h('input', { type: 'checkbox', id: 'dlg-newend', checked: !!cur.newAtEnd });
  const newEndRow = h('label', { class: 'check-row', for: 'dlg-newend' }, newEnd, ' Metti i canali nuovi in fondo (invece che vicino alla loro posizione originale)');
  const sync = () => {
    hint.textContent = (sorts.find(x => x[0] === sortSel.value) || [])[2] || '';
    newEndRow.hidden = sortSel.value !== 'custom' || !hasOrder;
  };
  sortSel.addEventListener('change', sync);
  sync();
  // List operations sit next to what they act on; the dialog's own buttons are only Annulla / OK
  const opBtn = (label, value, extra = '') => h('button', { type: 'button', class: 'btn focusable ' + extra, onclick: () => $('modal')._close(value) }, label);
  const body = h('div', {},
    h('div', { class: 'field' }, h('label', { for: 'dlg-view' }, 'Vista'), viewSel),
    h('div', { class: 'field' }, h('label', { for: 'dlg-sort' }, 'Ordine di questo elenco'), sortSel, hint, newEndRow,
      h('div', { class: 'dlg-ops' },
        opBtn(hasOrder ? 'Modifica il mio ordine' : 'Riordina a mano', 'reorder'),
        hasOrder ? opBtn('Cancella il mio ordine', 'reset', 'danger') : null)),
    refresh ? h('div', { class: 'field' }, h('label', {}, 'Aggiornamento della lista'),
      h('div', { class: 'hint' }, (updatedAt ? 'Scaricata ' + fmtWhen(updatedAt) + '. ' : '') + 'Si aggiorna da sola all\'avvio e ogni 6 ore; se il download non riesce resta la copia precedente.'),
      h('div', { class: 'dlg-ops' }, opBtn('Aggiorna la lista adesso', 'refresh'))) : null);
  const actions = [{ label: 'Annulla', value: false }, { label: 'OK', value: true, primary: true }];
  const res = await modal({ title: 'Vista e ordine', body, actions });
  if (!res) return;
  store.setSettings({ viewMode: viewSel.value });
  const save = (cfg) => { setSort(listKey, cfg); onSave ? onSave() : route(); };
  if (res === 'refresh') { setSort(listKey, { ...cur, mode: sortSel.value, newAtEnd: newEnd.checked }); refresh(); return; }
  if (res === 'reset') {
    const ok = await confirmBox('Cancellare il tuo ordine?', 'Il tuo ordine personalizzato di questo elenco verrà cancellato e la lista tornerà com\'è nella sorgente.', 'Cancella', true);
    if (ok) save({ mode: 'source' });
    return;
  }
  if (res === 'reorder' || (sortSel.value === 'custom' && !hasOrder)) {
    const start = sortItems(sourceItems, hasOrder ? { ...cur, mode: 'custom' } : { mode: sortSel.value === 'custom' ? 'source' : sortSel.value });
    reorderView(listKey, start, onSave);
    return;
  }
  save({ ...cur, mode: sortSel.value, newAtEnd: newEnd.checked });
}

/** Manual order: ▲ ▼ on each row (works with touch, mouse and TV remote). */
function reorderView(listKey, items, onSave) {
  const list = [...items];
  const done = h('button', { class: 'btn primary focusable', onclick: () => {
    const cur = getSort(listKey);
    setSort(listKey, { ...cur, mode: 'custom', order: list.map(itemKey), seen: {}, gone: {} });
    onSave ? onSave() : route();
  } }, 'Fatto');
  const cancel = h('button', { class: 'btn focusable', onclick: () => route() }, 'Annulla');
  const rowsBox = h('div', { class: 'list reorder' });
  const draw = (focusKey, dir) => {
    fill(rowsBox, ...list.map((it, i) => h('div', { class: 'row reorder-row' },
      h('span', { class: 'row-main' }, h('div', { class: 'row-label' }, it.live && it.number ? h('span', { class: 'ch-num' }, it.number) : null, it.label)),
      h('button', { class: 'icon-btn focusable', 'aria-label': 'Su', 'data-k': itemKey(it) + '|up', disabled: i === 0, onclick: () => move(i, -1) }, '▲'),
      h('button', { class: 'icon-btn focusable', 'aria-label': 'Giù', 'data-k': itemKey(it) + '|down', disabled: i === list.length - 1, onclick: () => move(i, 1) }, '▼'))));
    if (focusKey) {
      const b = [...rowsBox.querySelectorAll('button')].find(x => x.dataset.k === focusKey + '|' + dir);
      (b && !b.disabled ? b : rowsBox.querySelector(`button[data-k="${CSS.escape(focusKey + '|' + (dir === 'up' ? 'down' : 'up'))}"]`))?.focus({ preventScroll: false });
    }
  };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    draw(itemKey(list[j]), d < 0 ? 'up' : 'down');
  };
  draw();
  fill(view, h('div', { class: 'reorder-bar' }, h('span', { class: 'hint' }, 'Sposta con ▲ ▼'), h('div', { class: 'spacer' }), cancel, done), rowsBox);
  viewBtn.hidden = true; pinBtn.hidden = true; searchBtn.hidden = true;
}

// What the player needs to open an entry: the resolved stream plus the favourite key.
async function openEntry(addonId, it) {
  const stream = await addons.resolveItem(addonId, it);
  return { item: { ...it, ...(stream.item || {}) }, stream, favEntry: { key: addonId + '|' + (it.path || it.url || it.id || it.label), addonId, item: it } };
}

// Live channels of a listing, in order: the player zaps through them without closing.
function channelList(addonId, items) {
  return items.filter(x => x.live && x.playable && !x.external && !x.action).map(x => ({ item: x, open: () => openEntry(addonId, x) }));
}

function channelsFor(it, list) {
  if (!it.live || !list || list.length < 2) return undefined;
  const index = list.findIndex(c => c.item === it);
  return index >= 0 ? { list, index } : undefined;
}

async function pick(addonId, it, trail = [], channels) {
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
    const r = await openEntry(addonId, it);
    player.play(r.item, r.stream, { favEntry: r.favEntry, channels: channelsFor(it, channels) });
  } catch (e) {
    toast(e.message, 5000);
  }
}

function favouriteChannels(favs) {
  return favs.filter(f => f.item?.live && !f.item.external && (f.addonId ? addons.getInstalled(f.addonId) : f.item.url)).map(f => ({
    item: f.item,
    open: async () => f.addonId ? openEntry(f.addonId, f.item) : { item: f.item, stream: { url: f.item.url, mime: f.item.mime }, favEntry: f },
  }));
}

function openFavourite(f, favs = []) {
  const channels = favouriteChannels(favs);
  if (f.addonId) {
    if (!addons.getInstalled(f.addonId)) { toast('Add-on non più installato'); return; }
    pick(f.addonId, f.item, [], channels);
  } else {
    player.play(f.item, { url: f.item.url }, { favEntry: f, channels: channelsFor(f.item, channels) });
  }
}

async function renderFavourites() {
  setCrumbs(['Preferiti']);
  const favs = store.getFavourites();
  if (favs.some(f => f.item?.live)) { const at = location.hash; await epg.ready(); if (location.hash !== at) return; }
  if (!favs.length) {
    fill(view, h('div', { class: 'empty' }, 'Nessun preferito. Durante la riproduzione tocca ☆ per aggiungere un elemento.'));
    return;
  }
  // Favourites can be ordered like any list (by hand, by name, by number); "original" is the
  // order in which they were added.
  const all = favs.map(f => ({ ...f.item, key: f.key, _fav: f, subtitle: addons.getInstalled(f.addonId)?.manifest.name || f.item.subtitle }));
  const cfg = getSort('favs');
  trackSort('favs', cfg, all);
  const items = sortItems(all, cfg);
  for (const it of items) delete it._new; // no NUOVO badge on favourites
  const ordered = items.map(it => it._fav);
  viewBtn.hidden = false;
  viewBtn.onclick = () => viewAndSortDialog('favs', all, { sourceLabel: 'Ordine di aggiunta', sourceHint: 'Nell\'ordine in cui li hai aggiunti.' });
  fill(view, sortBadge(cfg), renderItems(items, {
    mode: 'list',
    onPick: (it, i) => openFavourite(ordered[i], ordered),
  }));
  focusFirst();
}

// ---------------------------------------------------------------- TV guide
// A grid like a TV set's guide: channels down, time across. ◀▶ move along a channel, ▲▼
// change channel keeping the time; OK on what is on now opens the channel, on a later
// programme shows its details.
const IPTV = 'plugin.video.iptv';
const GUIDE_HOURS = 12;
let guideTimer = 0;

async function guideSources() {
  const out = [];
  const rec = addons.getInstalled(IPTV);
  if (rec && rec.enabled !== false) {
    try {
      const top = addons.normaliseListing(await addons.getHost(IPTV).call('list', ''));
      const pls = top.items.filter(x => /^p\/\d+$/.test(x.path || ''));
      if (pls.length) pls.forEach(x => out.push({ id: x.path, label: x.label, path: x.path + '/g/*' }));
      else out.push({ id: 'p/0', label: 'Canali', path: 'p/0/g/*' });
    } catch (e) { console.warn('guida', e); }
  }
  if (store.getFavourites().some(f => f.item?.live && !f.item.external)) out.push({ id: 'favs', label: '★ Preferiti' });
  return out;
}

async function guideChannels(src) {
  if (src.id === 'favs') {
    const favs = store.getFavourites();
    const cfg = getSort('favs');
    const all = favs.map(f => ({ ...f.item, key: f.key, _fav: f }));
    const ordered = sortItems(all, cfg).filter(it => it.live && !it.external);
    for (const it of ordered) delete it._new;
    const chans = favouriteChannels(ordered.map(it => it._fav));
    return chans;
  }
  const listing = addons.normaliseListing(await addons.getHost(IPTV).call('list', src.path));
  const listKey = listing.listId ? IPTV + '|' + listing.listId : IPTV + '|' + src.path;
  numberLiveItems(listing.items);
  const items = sortItems(listing.items, getSort(listKey));
  for (const it of items) delete it._new;
  return channelList(IPTV, items);
}

async function renderGuide(params) {
  setCrumbs(['Guida TV']);
  clearInterval(guideTimer);
  loading('Carico la guida TV…');
  const at = location.hash;
  const [ok, sources] = await Promise.all([epg.load(), guideSources()]);
  if (location.hash !== at) return;
  if (!ok) {
    fill(view, h('div', { class: 'empty' }, 'La guida TV non è disponibile in questo momento. Riprova tra qualche minuto.'),
      h('button', { class: 'btn focusable', onclick: () => route() }, 'Riprova'));
    focusFirst();
    return;
  }
  if (!sources.length) {
    fill(view, h('div', { class: 'empty' }, 'Per la guida TV serve l\'add-on «TV in diretta» con una playlist di canali.'));
    return;
  }
  const want = params.get('s') || store.load('guideSource', '');
  const src = sources.find(s => s.id === want) || sources[0];
  let channels;
  try { channels = await guideChannels(src); } catch (e) { if (location.hash === at) fill(view, errorBox(e, () => route())); return; }
  if (location.hash !== at) return;

  const numbers = player.channelNumbers(channels.map(c => c.item));
  const rows = channels.map((c, i) => ({ c, i, num: numbers[i] ?? i + 1, g: epg.channelOf(c.item) })).filter(r => r.g);
  const missing = channels.length - rows.length;

  const now = Date.now();
  const HALF = 30 * 60000;
  const t0 = Math.floor(now / HALF) * HALF;
  const t1 = t0 + GUIDE_HOURS * 3600000;
  const narrow = window.innerWidth < 700;
  const PX = narrow ? 3 : 4;                 // pixels per minute
  const CHW = narrow ? 112 : 190;            // channel column
  const W = (t1 - t0) / 60000 * PX;
  const xOf = (t) => (Math.max(t0, Math.min(t1, t)) - t0) / 60000 * PX;

  const info = h('div', { class: 'guide-info' });
  const showInfo = (p, row) => {
    const live = p.start <= Date.now() && p.stop > Date.now();
    const day = new Date(p.start).toDateString() === new Date().toDateString() ? '' : new Date(p.start).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' }) + ' · ';
    fill(info,
      h('div', { class: 'gi-when' }, `${day}${epg.hhmm(p.start)}–${epg.hhmm(p.stop)} · ${row.num} ${row.c.item.label}`, live ? h('span', { class: 'gi-live' }, 'IN ONDA') : null),
      h('div', { class: 'gi-title' }, p.title, p.sub ? h('span', { class: 'gi-sub' }, ' · ' + p.sub) : null),
      p.desc || p.cat ? h('div', { class: 'gi-desc' }, [p.cat, p.desc].filter(Boolean).join(' · ')) : null,
      live ? h('div', { class: 'gi-bar' }, h('span', { style: { width: Math.round(epg.progress(p) * 100) + '%' } })) : null);
  };

  const play = (row) => {
    const entry = channels[row.i];
    toast('Apertura di «' + entry.item.label + '»…', 1500);
    entry.open().then(r => player.play(r.item, r.stream, { favEntry: r.favEntry, channels: channels.length > 1 ? { list: channels, index: row.i } : undefined }))
      .catch(e => toast(e.message, 5000));
  };
  // Tap / OK always shows the whole description first; watching is a separate button.
  const pickProg = async (p, row) => {
    const t = Date.now();
    const live = p.start <= t && p.stop > t;
    const when = (new Date(p.start).toDateString() === new Date().toDateString() ? 'Oggi' : new Date(p.start).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }))
      + `, ${epg.hhmm(p.start)}–${epg.hhmm(p.stop)} su ${row.num} ${row.c.item.label}`;
    const watch = await modal({
      title: p.title,
      body: h('div', { class: 'prog-detail' },
        h('p', { class: 'hint' }, when, live ? h('span', { class: 'gi-live' }, 'IN ONDA') : p.stop <= t ? ' · già trasmesso' : ''),
        live ? h('div', { class: 'gi-bar' }, h('span', { style: { width: Math.round(epg.progress(p) * 100) + '%' } })) : null,
        p.sub ? h('p', { class: 'pd-sub' }, p.sub) : null,
        h('p', {}, p.desc || 'Nessuna descrizione disponibile.'),
        p.cat ? h('p', { class: 'hint' }, p.cat) : null),
      actions: [{ label: 'Chiudi', value: false }, { label: live ? '▶ Guarda ' + row.c.item.label : 'Guarda ' + row.c.item.label + ' adesso', value: true, primary: true }],
    });
    if (watch) play(row);
  };

  const rowEls = rows.map(row => {
    const progs = epg.programmes(row.c.item, t0, t1);
    const cells = progs.length ? progs.map(p => {
      const x = xOf(p.start), w = Math.max(xOf(p.stop) - x, 2);
      const b = h('button', {
        class: 'gcell focusable' + (p.start <= now && p.stop > now ? ' on' : p.stop <= now ? ' past' : ''),
        style: { left: x + 'px', width: w + 'px' },
        title: `${epg.hhmm(p.start)} ${p.title}`,
        onclick: () => pickProg(p, row),
        onfocus: () => showInfo(p, row),
      }, h('span', { class: 'gc-t' }, p.title), w > 70 ? h('span', { class: 'gc-h' }, epg.hhmm(p.start)) : null);
      b._p = p;
      return b;
    }) : [h('button', { class: 'gcell focusable empty-cell', style: { left: '0px', width: W + 'px' }, onclick: () => play(row), onfocus: () => fill(info, h('div', { class: 'gi-title' }, row.c.item.label), h('div', { class: 'gi-desc' }, 'Nessun programma in guida per le prossime ore.')) }, 'Nessuna informazione')];
    const logo = safeImg(row.c.item.thumb);
    return h('div', { class: 'grow' },
      h('div', { class: 'gch', style: { width: CHW + 'px' }, title: row.c.item.label },
        h('span', { class: 'ch-num' }, String(row.num)),
        logo ? h('img', { class: 'gch-logo', src: logo, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : null,
        h('span', { class: 'gch-name' }, row.c.item.label)),
      h('div', { class: 'gprogs', style: { width: W + 'px' } }, ...cells));
  });

  const marks = [];
  for (let t = t0; t < t1; t += HALF) {
    const d = new Date(t);
    const label = (d.getHours() === 0 && d.getMinutes() === 0 ? d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' }) + ' ' : '') + epg.hhmm(t);
    marks.push(h('span', { class: 'gmark', style: { left: xOf(t) + 'px' } }, label));
  }
  const nowLine = h('div', { class: 'gnow', style: { left: CHW + xOf(now) + 'px' } });
  const grid = h('div', { class: 'gscroll' },
    h('div', { class: 'ghead' }, h('div', { class: 'gcorner', style: { width: CHW + 'px' } }, new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric' })), h('div', { class: 'gtimes', style: { width: W + 'px' } }, ...marks)),
    h('div', { class: 'gbody' }, nowLine, ...rowEls));

  const chips = sources.length > 1 ? h('div', { class: 'chips' }, ...sources.map(s => h('button', {
    class: 'chip focusable' + (s === src ? ' active' : ''),
    onclick: () => { store.save('guideSource', s.id); location.hash = '#/guide?s=' + encodeURIComponent(s.id); },
  }, s.label))) : null;
  const foot = h('p', { class: 'hint guide-foot' },
    `Guida aggiornata ${fmtWhen(epg.generatedAt())}.` + (missing ? ` ${missing} ${missing === 1 ? 'canale non ha' : 'canali non hanno'} la guida e non ${missing === 1 ? 'è mostrato' : 'sono mostrati'}.` : ''));

  if (!rows.length) {
    fill(view, chips, h('div', { class: 'empty' }, 'Nessuno di questi canali ha la guida TV.'), foot);
    focusFirst();
    return;
  }
  fill(view, h('div', { class: 'guide' }, chips, info, grid, foot));

  // The grid scrolls by itself (both ways) and fills the rest of the screen.
  const fit = () => {
    if (!grid.isConnected) { window.removeEventListener('resize', fit); return; }
    grid.style.height = Math.max(220, window.innerHeight - grid.getBoundingClientRect().top - foot.offsetHeight - 30) + 'px';
  };
  fit(); window.addEventListener('resize', fit);
  grid.scrollLeft = Math.max(0, xOf(now) - (narrow ? 20 : 90));

  // Remote / keyboard: keep a time cursor like a TV guide.
  let cursor = Math.max(now, t0);
  const reveal = (b) => {
    const row = b.closest('.grow');
    const headH = grid.querySelector('.ghead').offsetHeight;
    const top = headH + row.offsetTop; // rows are placed in .gbody, below the time header
    if (row.offsetTop < grid.scrollTop) grid.scrollTop = row.offsetTop;
    else if (top + row.offsetHeight > grid.scrollTop + grid.clientHeight) grid.scrollTop = top + row.offsetHeight - grid.clientHeight;
    const L = CHW + b.offsetLeft, R = L + b.offsetWidth;
    const viewL = grid.scrollLeft + CHW, viewR = grid.scrollLeft + grid.clientWidth;
    if (L < viewL && R < viewL + 120) grid.scrollLeft = Math.max(0, L - CHW - 40);
    else if (L > viewR - 120) grid.scrollLeft = L - CHW - 40;
  };
  const focusCell = (b) => { b.focus({ preventScroll: true }); reveal(b); };
  const cellAt = (rowEl, t) => {
    const cells = [...rowEl.querySelectorAll('.gcell')];
    return cells.find(c => !c._p || (c._p.start <= t && c._p.stop > t)) || cells.reduce((a, c) => (Math.abs(c._p.start - t) < Math.abs(a._p.start - t) ? c : a));
  };
  grid.addEventListener('keydown', (e) => {
    const b = e.target.closest('.gcell');
    if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    document.body.classList.add('kbd-nav');
    const rowEl = b.closest('.grow');
    let to = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      to = e.key === 'ArrowLeft' ? b.previousElementSibling : b.nextElementSibling;
      if (!to && e.key === 'ArrowLeft') return;           // leave the grid: side menu
      if (to) cursor = Math.max(to._p ? to._p.start : t0, t0);
    } else {
      const other = e.key === 'ArrowUp' ? rowEl.previousElementSibling : rowEl.nextElementSibling;
      if (!other || !other.classList.contains('grow')) { if (e.key === 'ArrowUp') return; } // up from the first row: the buttons above
      else to = cellAt(other, cursor);
    }
    e.preventDefault(); e.stopPropagation();
    if (to) focusCell(to);
  });
  grid.addEventListener('focusin', (e) => { const b = e.target.closest('.gcell'); if (b && !b.contains(e.relatedTarget) && !grid.contains(e.relatedTarget)) reveal(b); });

  // keep the "now" line and the on-air marks current
  guideTimer = setInterval(() => {
    if (!nowLine.isConnected) { clearInterval(guideTimer); return; }
    const t = Date.now();
    if (t >= t1 - HALF) { if (!player.isOpen()) route(); return; }
    nowLine.style.left = CHW + xOf(t) + 'px';
    grid.querySelectorAll('.gcell').forEach(c => { if (c._p) { c.classList.toggle('on', c._p.start <= t && c._p.stop > t); c.classList.toggle('past', c._p.stop <= t); } });
  }, 60000);

  // start on what is on now on the first channel
  const first = cellAt(rowEls[0], cursor);
  if (document.body.classList.contains('kbd-nav')) focusCell(first);
  else if (first._p) showInfo(first._p, rows[0]);
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
  const autoPip = h('input', { type: 'checkbox', id: 'autopip', checked: s.autoPip });
  const starts = [['', 'Home'], ['#/live', 'TV in diretta'], ['#/guide', 'Guida TV'], ['#/video', 'Video'], ['#/music', 'Musica'], ['#/favourites', 'Preferiti'], ['last', 'L\'ultima pagina aperta']];
  if (s.startPage && !starts.some(([v]) => v === s.startPage)) starts.push([s.startPage, s.startLabel || 'Pagina scelta con 📌']);
  const startSel = h('select', { id: 'startpage' }, ...starts.map(([v, l]) => h('option', { value: v, selected: s.startPage === v }, l)));
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
    /Android/i.test(navigator.userAgent) && !isTvApp ? h('div', { class: 'field check' }, autoPip, h('label', { for: 'autopip' }, 'Finestra mobile automatica: i video si aprono a schermo intero, così uscendo dall\'app continuano in una finestra mobile')) : null,
    h('div', { class: 'field' }, h('label', { for: 'startpage' }, 'Pagina iniziale'), startSel,
      h('div', { class: 'hint' }, 'Per partire da una pagina qualsiasi (per esempio un elenco di canali), aprila e tocca 📌 in alto.')),
    h('div', { class: 'field' }, h('label', { for: 'viewmode' }, 'Vista degli elenchi'), viewSel),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary focusable', onclick: async () => {
        store.setSettings({ proxyUrl: proxy.value.trim(), proxyToken: token.value.trim(), autoResume: resume.checked, autoPip: autoPip.checked, viewMode: viewSel.value, startPage: startSel.value,
          startLabel: startSel.value === s.startPage ? s.startLabel : '' });
        listingCache.clear();
        const p = await addons.detectProxy();
        if (!p) toast('Salvato');
        else toast((await addons.checkProxy(p)) ? 'Salvato · proxy raggiungibile ✓' : 'Salvato, ma il proxy non risponde: controlla l\'indirizzo', 5000);
        if (location.hash === '#/settings') renderSettings(); // not if the user already moved on
      } }, 'Salva'),
      h('button', { class: 'btn danger focusable', onclick: async () => {
        if (await confirmBox('Ripristina', 'Cancellare add-on, preferiti e impostazioni?', 'Cancella tutto', true)) {
          Object.keys(localStorage).filter(k => k.startsWith('salotto:')).forEach(k => localStorage.removeItem(k));
          location.hash = '#/'; location.reload();
        }
      } }, 'Ripristina tutto')),
    h('div', { class: 'section-title' }, 'Informazioni'),
    h('div', { class: 'field' },
      h('label', {}, 'Versione: ', h('span', { id: 'settings-version' }, versionLabel())),
      h('div', { class: 'actions' }, h('button', { class: 'btn focusable', onclick: forceUpdate }, 'Forza aggiornamento')),
      h('div', { class: 'hint' }, 'Scarica di nuovo l\'app ignorando la cache, se una correzione non compare. Add-on, preferiti e impostazioni restano.')),
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

async function forceUpdate() {
  toast('Aggiornamento…');
  try {
    if ('serviceWorker' in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  } catch (e) { console.warn(e); }
  const u = new URL(location.href);
  u.searchParams.set('r', Date.now());
  location.replace(u.href);
}

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 15000); tickClock();
$('app-version').textContent = versionLabel();
console.info('Salotto', versionLabel());

// ---------------------------------------------------------------- boot
(async function boot() {
  renderMenu('');
  loading('Avvio…');
  await addons.detectProxy();
  await addons.ensureBundledAddons();
  // launched on Home: go to the chosen start page, with Home behind it (so ← goes back to Home)
  const start = (!location.hash || location.hash === '#/') ? startPage() : '';
  if (start) { history.replaceState(null, '', '#/'); history.pushState(null, '', start); }
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
})();

// exposed for debugging / tests
window.salotto = { addons, store, player };

// ---------------------------------------------------------------- Fire TV / Android TV app
// The TV app (android/) is a window on this site: its user agent ends with "SalottoTV".
// The remote's Back key asks the page first: close a dialog or the player, go back a page;
// on Home the app exits.
export const isTvApp = /SalottoTV/.test(navigator.userAgent);
if (isTvApp) document.body.classList.add('tv', 'kbd-nav');
window.salottoBack = () => {
  const m = $('modal');
  if (!m.hidden) { m._close?.(undefined); return true; }
  if (player.isOpen()) { player.back(); return true; }
  if (location.hash && location.hash !== '#/') { history.back(); return true; }
  return false;
};
