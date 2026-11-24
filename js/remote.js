// Phone remote (remote.html). Talks to one Salotto screen through the relay of the Cloudflare
// Worker: see remote-host.js for the screen side and the messages.
import * as epg from './epg.js';

const $ = (id) => document.getElementById(id);
const KEY = 'salotto-remote:screens';
const LAST = 'salotto-remote:last';

// ---------------------------------------------------------------- paired screens
function loadScreens() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } }
function saveScreens(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ } }

/** The screen in a pairing address (#r=…&w=…&t=…&n=…), or null. */
function fromHash(hash = location.hash) {
  const p = new URLSearchParams(String(hash).replace(/^[^#]*#?/, ''));
  const room = p.get('r'), base = p.get('w');
  if (!room || !/^[A-Za-z0-9_-]{16,64}$/.test(room) || !/^https:\/\//.test(base || '') && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base || '')) return null;
  return { room, base: base.replace(/\/+$/, ''), token: p.get('t') || '', name: p.get('n') || 'Salotto' };
}

let screens = loadScreens();
let screen = null;
{
  const h = fromHash();
  if (h) {
    const old = screens.find(s => s.room === h.room);
    if (old) Object.assign(old, h); else screens.push(h);
    saveScreens(screens);
    screen = h;
  } else {
    const last = localStorage.getItem(LAST);
    screen = screens.find(s => s.room === last) || screens[0] || null;
  }
}

// ---------------------------------------------------------------- connection
let ws = null, wsOpen = false, tvOnline = false, retry = 0, retryTimer = 0, pingTimer = 0;
let state = null;           // last state of the screen
let list = { version: 0, items: [] }; // channels the player zaps through
let sources = [];           // [{ id, label }]
const chans = new Map();    // src -> items

function send(msg) {
  if (ws && wsOpen) { try { ws.send(JSON.stringify(msg)); return true; } catch { /* closing */ } }
  return false;
}

function cmd(c, extra = {}) {
  if (!tvOnline) { toast(wsOpen ? 'Lo schermo non è collegato: apri Salotto sullo schermo' : 'Collegamento in corso…'); connect(); return; }
  if (navigator.vibrate) navigator.vibrate(12);
  send({ t: 'cmd', c, ...extra });
}

function connect() {
  clearTimeout(retryTimer);
  if (!screen || ws) return;
  const u = new URL(screen.base.replace(/^http/, 'ws') + '/remote/ws');
  u.searchParams.set('room', screen.room);
  u.searchParams.set('role', 'remote');
  if (screen.token) u.searchParams.set('token', screen.token);
  let sock;
  try { sock = new WebSocket(u.href); } catch { scheduleRetry(); return; }
  ws = sock;
  setDot();
  sock.onopen = () => {
    wsOpen = true; retry = 0;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { sock.send('ping'); } catch { /* closing */ } }, 25000);
    send({ t: 'hello' });
    setDot();
  };
  sock.onmessage = (ev) => { if (ev.data !== 'pong') onMessage(ev.data); };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null; wsOpen = false; tvOnline = false;
    clearInterval(pingTimer);
    setDot();
    scheduleRetry();
  };
  sock.onerror = () => { /* onclose follows */ };
}

function scheduleRetry() {
  retry = Math.min(retry + 1, 6);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** (retry - 1)));
}

function reconnect() {
  if (ws) { const s = ws; ws = null; wsOpen = false; tvOnline = false; try { s.close(1000); } catch { /* ignore */ } }
  retry = 0;
  connect();
}

// phones drop sockets in the background: reconnect as soon as the page is back
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!ws) { retry = 0; connect(); } else if (wsOpen) send({ t: 'hello' });
});
window.addEventListener('online', () => { if (!ws) { retry = 0; connect(); } });

function onMessage(data) {
  let m;
  try { m = JSON.parse(data); } catch { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'peers': {
      const was = tvOnline;
      tvOnline = m.tv > 0;
      if (tvOnline && !was) send({ t: 'hello' });
      setDot();
      break;
    }
    case 'state':
      tvOnline = true;
      state = m.s || null;
      if (m.name && screen && m.name !== screen.name) { screen.name = m.name; saveScreens(screens); }
      setDot();
      renderState();
      break;
    case 'list':
      list = { version: m.version || 0, items: Array.isArray(m.items) ? m.items : [] };
      // a new list on the screen: show it; when the player closes go back to the first list
      if (list.items.length) curSrc = 'now';
      else if (curSrc === 'now' || !curSrc) { curSrc = sources[0]?.id || ''; needChannels(); }
      renderSources(); renderChannels(); renderGuide();
      break;
    case 'sources':
      sources = Array.isArray(m.items) ? m.items : [];
      if (!curSrc || (curSrc !== 'now' && !sources.some(s => s.id === curSrc))) curSrc = list.items.length ? 'now' : sources[0]?.id || '';
      renderSources();
      needChannels();
      break;
    case 'channels':
      chans.set(m.src, Array.isArray(m.items) ? m.items : []);
      renderChannels(); renderGuide();
      break;
    case 'toast':
      toast(String(m.text || ''), Math.min(10000, m.ms || 2500));
      break;
    default: break;
  }
}

// ---------------------------------------------------------------- header / now playing
function setDot() {
  const dot = $('r-dot');
  const st = !screen ? '' : tvOnline ? 'on' : wsOpen ? 'wait' : 'off';
  dot.className = 'r-dot ' + st;
  dot.title = st === 'on' ? 'Collegato' : st === 'wait' ? 'Lo schermo non risponde' : 'Non collegato';
  $('r-name').textContent = screen ? screen.name : 'Salotto';
  const msg = $('r-msg');
  if (screen && wsOpen && !tvOnline) { msg.textContent = 'Lo schermo «' + screen.name + '» non è collegato: apri Salotto sullo schermo e tienilo acceso.'; msg.hidden = false; }
  else if (screen && !wsOpen && retry > 1) { msg.textContent = 'Non riesco a raggiungere il server del telecomando, riprovo…'; msg.hidden = false; }
  else msg.hidden = true;
  if (tab === 'screens') renderScreens(false);
}

const fmtAv = (ms) => (ms > 0 ? '+' : ms < 0 ? '−' : '') + Math.abs(ms) + ' ms';
const pct = (p, t = Date.now()) => Math.round(epg.progress(p, t) * 100);
const asItem = (x) => x && { label: x.label, key: x.key, live: x.live !== false, guide: x.guide };

function renderState() {
  const s = state || { open: false };
  const now = $('r-now');
  now.hidden = !screen;
  if (!s.open) {
    $('r-num').textContent = '';
    $('r-num').hidden = true;
    $('r-title').textContent = state ? 'Nessun video in riproduzione' : 'In attesa dello schermo…';
    $('r-prog').textContent = state ? 'Scegli un canale da «Canali» o dalla «Guida»' : '';
    $('r-next').textContent = '';
    $('r-bar').hidden = true;
  } else {
    $('r-num').textContent = s.number || '';
    $('r-num').hidden = !s.number;
    $('r-title').textContent = s.label || '';
    const it = s.guide ? { label: s.label, key: s.guide.key, live: true, guide: s.guide.id || s.guide.name ? { id: s.guide.id, name: s.guide.name } : undefined } : null;
    const nn = it ? epg.nowNext(it) : null;
    if (nn?.now) {
      $('r-prog').textContent = nn.now.title + ' · ' + epg.hhmm(nn.now.start) + '–' + epg.hhmm(nn.now.stop);
      $('r-bar').hidden = false;
      $('r-barfill').style.width = pct(nn.now) + '%';
    } else {
      $('r-prog').textContent = s.live ? (s.pos < -5 ? 'In differita' : 'In diretta') : s.dur ? clock(s.pos) + ' / ' + clock(s.dur) : '';
      $('r-bar').hidden = true;
    }
    $('r-next').textContent = nn?.next ? 'Poi alle ' + epg.hhmm(nn.next.start) + ': ' + nn.next.title : '';
  }
  // buttons
  const play = $('r-play');
  play.firstChild.textContent = s.open && !s.paused ? '⏸' : '▶';
  play.querySelector('small').textContent = s.open && !s.paused ? 'Pausa' : 'Play';
  $('r-mute').classList.toggle('active', !!s.muted);
  $('r-mute').querySelector('small').textContent = s.muted ? 'Audio' : 'Muto';
  $('r-fs').classList.toggle('on', !!s.fs);
  $('r-fs').querySelector('small').textContent = s.fs ? 'Esci' : 'Intero';
  $('r-volrock').hidden = !!s.volFixed;
  $('r-volnote').hidden = !s.volFixed;
  $('r-vollbl').textContent = s.muted ? 'MUTO' : (s.volume ?? 100) + '%';
  $('r-fwd').querySelector('small').textContent = s.live ? 'LIVE' : '+30 s';
  $('r-fwd').dataset.cmd = s.live ? 'live' : 'skip';
  const av = $('r-av');
  av.hidden = !s.open || s.audio || s.casting;
  if (!av.hidden) {
    $('r-avval').textContent = fmtAv(s.av || 0);
    av.querySelectorAll('[data-cmd=av][data-d]').forEach(b => { b.disabled = !!s.avBlocked; });
    $('r-avreset').disabled = !s.av;
    $('r-avnote').textContent = s.avBlocked || '';
    $('r-avnote').hidden = !s.avBlocked;
  }
  renderChannels(); // the current channel is highlighted
}

function clock(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

// ---------------------------------------------------------------- buttons
let repeatTimer = 0;
function pressButton(b) {
  if (b.dataset.key != null) { cmd('key', { k: b.dataset.key }); return; }
  if (b.dataset.go != null) { cmd('go', { r: b.dataset.go }); return; }
  const c = b.dataset.cmd;
  if (!c) return;
  if (c === 'zap') cmd('zap', { d: +b.dataset.d });
  else if (c === 'vol') cmd('vol', { d: +b.dataset.d });
  else if (c === 'skip') cmd('skip', { s: +b.dataset.s });
  else if (c === 'av') cmd('av', b.dataset.reset ? { reset: true } : { d: +b.dataset.d });
  else cmd(c);
}
const stopRepeat = () => { clearTimeout(repeatTimer); repeatTimer = 0; };
document.querySelectorAll('#tab-remote .r-btn').forEach((b) => {
  if (b.id === 'r-keypad-btn') { b.addEventListener('click', openKeypad); return; }
  if (b.hasAttribute('data-repeat')) {
    // held down: repeat (volume, arrows, channel)
    let fired = false;
    b.addEventListener('pointerdown', (e) => {
      if (b.disabled) return;
      e.preventDefault();
      fired = true; pressButton(b);
      const again = (ms) => { repeatTimer = setTimeout(() => { pressButton(b); again(b.dataset.cmd === 'zap' ? 600 : 180); }, ms); };
      stopRepeat(); again(450);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, stopRepeat);
    b.addEventListener('click', () => { if (!fired) pressButton(b); fired = false; }); // keyboard
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  } else {
    b.addEventListener('click', () => pressButton(b));
  }
});

// ---------------------------------------------------------------- tabs
let tab = 'remote';
document.querySelectorAll('.r-tabbtn').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  tab = name;
  document.querySelectorAll('.r-tabbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of ['remote', 'channels', 'guide', 'screens']) $('tab-' + t).hidden = t !== name;
  if (name === 'screens') renderScreens();
  if (name !== 'remote') { epg.load().then(() => { renderChannels(); renderGuide(); }); needChannels(); }
  if (name === 'channels') { renderSources(); renderChannels(); }
  if (name === 'guide') { renderSources(); renderGuide(); }
}

// ---------------------------------------------------------------- channel lists
let curSrc = '';
const itemsOf = (src) => (src === 'now' ? list.items : chans.get(src) || null);
function needChannels() {
  if (curSrc && curSrc !== 'now' && !chans.has(curSrc)) send({ t: 'get', what: 'channels', src: curSrc });
}
function chip(label, on, onclick) {
  const b = document.createElement('button');
  b.className = 'r-chip' + (on ? ' on' : '');
  b.textContent = label;
  b.addEventListener('click', onclick);
  return b;
}
function renderSources() {
  const opts = [...(list.items.length ? [{ id: 'now', label: '▶ In riproduzione' }] : []), ...sources];
  for (const box of [$('r-sources'), $('r-gsources')]) {
    box.replaceChildren(...opts.map(o => chip(o.label, o.id === curSrc, () => { curSrc = o.id; needChannels(); renderSources(); renderChannels(); renderGuide(); })));
    box.hidden = opts.length < 2;
  }
}

function pickChannel(i) {
  if (curSrc === 'now') cmd('tune', { i });
  else cmd('open', { src: curSrc, i });
  showTab('remote');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function emptyList(box, text) { box.replaceChildren(el('div', 'r-empty-list', text)); }

function renderChannels() {
  if (tab !== 'channels') return;
  const box = $('r-chlist');
  if (!screen) { emptyList(box, 'Collega prima uno schermo.'); return; }
  const items = itemsOf(curSrc);
  if (!curSrc) { emptyList(box, tvOnline ? 'Sullo schermo non c\'è ancora un elenco di canali: installa l\'add-on «TV in diretta».' : 'In attesa dello schermo…'); return; }
  if (!items) { emptyList(box, 'Carico i canali…'); return; }
  if (!items.length) { emptyList(box, 'Nessun canale.'); return; }
  const curIdx = curSrc === 'now' && state?.open ? state.index : -1;
  const t = Date.now();
  box.replaceChildren(...items.map((x, i) => {
    const row = el('div', 'r-ch' + (i === curIdx ? ' current' : ''));
    const main = el('button', 'r-ch-main');
    main.append(el('span', 'r-ch-num', x.number || ''));
    const txt = el('span', 'r-ch-text');
    txt.append(el('span', 'r-ch-name', x.label));
    const nn = epg.nowNext(asItem(x), t);
    if (nn?.now) {
      txt.append(el('span', 'r-ch-prog', nn.now.title));
      const bar = el('span', 'r-bar small'); const f = el('span'); f.style.width = pct(nn.now, t) + '%'; bar.append(f); txt.append(bar);
    }
    if (nn?.next) txt.append(el('span', 'r-ch-next', epg.hhmm(nn.next.start) + ' ' + nn.next.title));
    main.append(txt);
    main.addEventListener('click', () => pickChannel(i));
    row.append(main);
    if (epg.channelOf(asItem(x))) {
      const info = el('button', 'r-ch-info', 'ⓘ');
      info.setAttribute('aria-label', 'Programmi di ' + x.label);
      info.addEventListener('click', () => openSchedule(x, i));
      row.append(info);
    }
    return row;
  }));
  if (curIdx >= 0) box.children[curIdx]?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- guide
let guideAt = 0; // 0 = now
function timeChoices() {
  const out = [{ label: 'Adesso', t: 0 }];
  const d = new Date();
  const at = (h, m = 0, plusDay = 0) => { const x = new Date(d); x.setDate(x.getDate() + plusDay); x.setHours(h, m, 0, 0); return x.getTime(); };
  const now = Date.now();
  const nextHalf = Math.ceil((now + 60000) / 1800000) * 1800000;
  out.push({ label: 'Dopo', t: nextHalf + 1800000 });
  for (const [h, m] of [[13, 30], [18, 0], [20, 30], [21, 30], [23, 0]]) { const t = at(h, m); if (t > now + 30 * 60000) out.push({ label: h + ':' + String(m).padStart(2, '0'), t }); }
  out.push({ label: 'Domani 21:30', t: at(21, 30, 1) });
  return out;
}
function renderTimes() {
  const box = $('r-times');
  box.replaceChildren(...timeChoices().map(c => chip(c.label, c.t === guideAt || (!c.t && !guideAt), () => { guideAt = c.t; renderGuide(); })));
}

function renderGuide() {
  if (tab !== 'guide') return;
  renderTimes();
  const box = $('r-glist');
  if (!screen) { emptyList(box, 'Collega prima uno schermo.'); return; }
  if (!epg.available()) { emptyList(box, 'Carico la guida TV…'); epg.load().then(ok => { if (!ok) emptyList(box, 'La guida TV non è disponibile in questo momento.'); else renderGuide(); }); return; }
  const items = itemsOf(curSrc);
  if (!items) { emptyList(box, curSrc ? 'Carico i canali…' : 'In attesa dello schermo…'); return; }
  const t = guideAt || Date.now();
  const seen = new Set();
  const rows = [];
  items.forEach((x, i) => {
    const it = asItem(x);
    const g = epg.channelOf(it);
    if (!g || seen.has(g.id)) return;
    seen.add(g.id);
    const p = epg.programmes(it, t, t + 1)[0];
    if (!p) return;
    const row = el('button', 'r-g');
    row.append(el('span', 'r-ch-num', x.number || ''));
    const txt = el('span', 'r-ch-text');
    txt.append(el('span', 'r-g-ch', x.label), el('span', 'r-g-title', p.title), el('span', 'r-g-time', epg.hhmm(p.start) + '–' + epg.hhmm(p.stop) + (p.cat ? ' · ' + p.cat : '')));
    if (!guideAt) { const bar = el('span', 'r-bar small'); const f = el('span'); f.style.width = pct(p) + '%'; bar.append(f); txt.append(bar); }
    row.append(txt);
    row.addEventListener('click', () => openProgramme(x, i, p));
    rows.push(row);
  });
  const tvBtn = el('button', 'r-wide', '🗓 Mostra la guida sullo schermo');
  tvBtn.addEventListener('click', () => cmd('go', { r: 'guide' }));
  if (!rows.length) { box.replaceChildren(el('div', 'r-empty-list', 'Nessun programma in guida per questi canali.'), tvBtn); return; }
  box.replaceChildren(...rows, tvBtn);
}

// ---------------------------------------------------------------- sheets
function openSheet(...nodes) {
  $('r-sheet-body').replaceChildren(...nodes);
  $('r-sheet').hidden = false;
}
function closeSheet() { $('r-sheet').hidden = true; }
$('r-sheet-close').addEventListener('click', closeSheet);
$('r-sheet').addEventListener('click', (e) => { if (e.target === $('r-sheet')) closeSheet(); });

const dayLabel = (t) => new Date(t).toDateString() === new Date().toDateString() ? 'Oggi'
  : new Date(t).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

function watchBtn(i, label = '▶ Guarda ora') {
  const b = el('button', 'r-wide primary', label);
  b.addEventListener('click', () => { closeSheet(); pickChannel(i); });
  return b;
}

function openProgramme(x, i, p) {
  const t = Date.now();
  const live = p.start <= t && p.stop > t;
  const nodes = [el('h2', '', p.title),
    el('p', 'r-hint', `${dayLabel(p.start)}, ${epg.hhmm(p.start)}–${epg.hhmm(p.stop)} su ${x.number ? x.number + ' ' : ''}${x.label}${live ? ' · IN ONDA' : ''}`)];
  if (p.sub) nodes.push(el('p', 'r-sub', p.sub));
  nodes.push(el('p', '', p.desc || 'Nessuna descrizione disponibile.'));
  if (p.cat) nodes.push(el('p', 'r-hint', p.cat));
  nodes.push(watchBtn(i, live ? '▶ Guarda ora' : '▶ Guarda il canale'));
  openSheet(...nodes);
}

function openSchedule(x, i) {
  const it = asItem(x);
  const t = Date.now();
  const progs = epg.programmes(it, t, t + 24 * 3600000);
  const nodes = [el('h2', '', (x.number ? x.number + '  ' : '') + x.label), watchBtn(i)];
  const ul = el('div', 'r-sched');
  for (const p of progs) {
    const live = p.start <= t && p.stop > t;
    const row = el('button', 'r-sched-row' + (live ? ' live' : ''));
    row.append(el('span', 'r-sched-time', epg.hhmm(p.start)), el('span', 'r-sched-title', p.title));
    row.addEventListener('click', () => openProgramme(x, i, p));
    ul.append(row);
  }
  if (!progs.length) ul.append(el('p', 'r-hint', 'Nessun programma in guida.'));
  nodes.push(ul);
  openSheet(...nodes);
}

// number pad
let typed = '';
function openKeypad() {
  typed = '';
  const disp = el('div', 'r-kp-disp', '–');
  const pad = el('div', 'r-kp');
  const upd = () => { disp.textContent = typed || '–'; };
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK']) {
    const b = el('button', 'r-btn' + (k === 'OK' ? ' ok' : ''), k);
    b.addEventListener('click', () => {
      if (navigator.vibrate) navigator.vibrate(8);
      if (k === '⌫') typed = typed.slice(0, -1);
      else if (k === 'OK') { if (typed) { cmd('number', { n: typed }); closeSheet(); } return; }
      else typed = (typed + k).slice(0, 4);
      upd();
    });
    pad.append(b);
  }
  openSheet(el('h2', '', 'Numero del canale'), disp, pad);
}

// ---------------------------------------------------------------- paired screens (tab)
// Every Salotto screen has its own pairing link (its own room): the phone keeps them all here.
function useScreen(s) {
  screen = s; localStorage.setItem(LAST, s.room);
  state = null; list = { version: 0, items: [] }; sources = []; chans.clear(); curSrc = '';
  setView(); reconnect();
}
const online = new Map(); // room -> true / false (null while asking)
async function probe(s) {
  if (s === screen) { online.set(s.room, tvOnline); return; }
  online.set(s.room, null);
  try {
    const u = new URL(s.base + '/remote/status');
    u.searchParams.set('room', s.room);
    if (s.token) u.searchParams.set('token', s.token);
    const r = await fetch(u, { cache: 'no-store' });
    online.set(s.room, r.ok ? (await r.json()).tv > 0 : false);
  } catch { online.set(s.room, false); }
  if (tab === 'screens') renderScreens(false);
}
function renderScreens(ask = true) {
  const box = $('r-scrlist');
  if (!screens.length) { emptyList(box, 'Nessuno schermo collegato.'); return; }
  box.replaceChildren(...screens.map((s) => {
    if (ask) probe(s);
    const cur = s === screen;
    const on = cur ? tvOnline : online.get(s.room);
    const row = el('div', 'r-ch r-scr' + (cur ? ' current' : ''));
    const pick = el('button', 'r-ch-main');
    pick.append(el('span', 'r-dot ' + (on ? 'on' : on === false ? 'off' : '')));
    const txt = el('span', 'r-ch-text');
    txt.append(el('span', 'r-ch-name', s.name), el('span', 'r-ch-next', (cur ? 'In uso · ' : '') + (on ? 'acceso' : on === false ? 'spento o Salotto chiuso' : 'controllo…')));
    pick.append(txt);
    pick.addEventListener('click', () => { if (!cur) useScreen(s); showTab('remote'); });
    const del = el('button', 'r-scr-del', 'Rimuovi');
    del.addEventListener('click', () => {
      if (!confirm('Rimuovere «' + s.name + '» da questo telefono?')) return;
      screens = screens.filter(x => x !== s); saveScreens(screens);
      if (cur) { if (screens[0]) useScreen(screens[0]); else { screen = null; reconnect(); setView(); } }
      renderScreens(false);
    });
    row.append(pick, del);
    return row;
  }));
}
function addFromLink(input) {
  const h = fromHash(input.value.trim());
  if (!h) { toast('Link non valido: copialo dalla pagina «Telecomando» di Salotto sullo schermo'); return; }
  const old = screens.find(s => s.room === h.room);
  if (old) Object.assign(old, h); else screens.push(h);
  saveScreens(screens);
  input.value = '';
  useScreen(old || h);
  toast('Schermo aggiunto');
  renderScreens();
}
$('r-addbtn').addEventListener('click', () => addFromLink($('r-addlink')));
$('r-addbtn0').addEventListener('click', () => addFromLink($('r-addlink0')));

// ---------------------------------------------------------------- install as an app
const APPLE = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installEvent = null;
function renderInstall() {
  const btn = $('r-installbtn'), hint = $('r-installhint');
  btn.hidden = !installEvent || standalone();
  hint.textContent = standalone() ? ''
    : APPLE ? 'Per averlo come app: in Safari tocca Condividi (□↑) → «Aggiungi alla schermata Home». Fallo dopo aver scelto lo schermo: l\'app si apre su quello.'
    : installEvent ? '' : 'Per averlo come app: nel menu ⋮ di Chrome tocca «Installa app» o «Aggiungi a schermata Home».';
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; renderInstall(); });
window.addEventListener('appinstalled', () => { installEvent = null; renderInstall(); toast('Telecomando installato'); });
$('r-installbtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  try { await installEvent.userChoice; } catch { /* ignore */ }
  installEvent = null; renderInstall();
});
renderInstall();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
// the name at the top opens the list as well
$('r-screen').addEventListener('click', () => showTab('screens'));

// ---------------------------------------------------------------- misc
let toastTimer = 0;
function toast(text, ms = 2500) {
  const t = $('r-toast');
  t.textContent = text; t.hidden = !text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function setView() {
  const paired = !!screen;
  $('r-unpaired').hidden = paired;
  $('r-main').hidden = !paired;
  $('r-tabs').hidden = !paired;
  $('r-screen').hidden = !paired;
  if (screen) localStorage.setItem(LAST, screen.room);
  // keep the pairing in the address, so "Add to Home screen" works even where the home-screen
  // app has its own storage (iPhone)
  if (screen) {
    const p = new URLSearchParams({ r: screen.room, w: screen.base, n: screen.name });
    if (screen.token) p.set('t', screen.token);
    history.replaceState(null, '', '#' + p.toString());
  }
  setDot();
  renderState();
}

setInterval(() => { renderState(); if (tab === 'guide') renderGuide(); }, 30000);
epg.onUpdate(() => { renderState(); renderChannels(); renderGuide(); });
setView();
epg.load().then(renderState);
connect();
window.salottoRemote = { get state() { return state; }, get list() { return list; }, get sources() { return sources; } };
