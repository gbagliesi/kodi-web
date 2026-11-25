# Scrivere un add-on per Salotto

Un add-on è una cartella con due file, pubblicata su un qualsiasi server web
(GitHub Pages va benissimo):

```
plugin.video.esempio/
├── addon.json   ← manifest
├── main.js      ← codice
└── icon.svg     ← facoltativa
```

Si installa da **Add-on → Installa da URL** incollando l'indirizzo di
`addon.json`, oppure elencandolo in un `repository.json` (vedi sotto).

## Manifest (`addon.json`)

```json
{
  "id": "plugin.video.esempio",
  "name": "Esempio",
  "version": "1.0.0",
  "author": "Tu",
  "summary": "Una riga che compare sotto il nome",
  "description": "Descrizione più lunga",
  "provides": ["video"],
  "icon": "icon.svg",
  "main": "main.js",
  "proxy": "auto",
  "settings": [
    { "id": "lingua", "type": "select", "label": "Lingua", "default": "it", "options": ["it", "en"] },
    { "id": "hd", "type": "bool", "label": "Preferisci HD", "default": true },
    { "id": "feed", "type": "url", "label": "URL", "default": "", "hint": "Testo d'aiuto" }
  ]
}
```

| Campo | Significato |
|---|---|
| `id` | Identificatore unico, per convenzione `plugin.<tipo>.<nome>` |
| `provides` | Sezioni in cui compare: `video`, `audio`, `live` |
| `main` | Script da eseguire, relativo al manifest |
| `proxy` | `auto` (default): richiesta diretta, proxy solo se il browser la blocca. `always`: sempre tramite proxy |
| `settings` | Tipi: `text`, `url`, `number`, `bool`, `select`, `textarea`. L'utente li modifica dalla scheda dell'add-on |

## Codice (`main.js`)

Il codice gira in un **Web Worker isolato**: niente DOM, niente accesso ai dati
dell'app. Si registra con `addon.register()`:

```js
addon.register({
  // Obbligatorio. path === '' è la radice.
  async list(path, ctx) {
    if (!path) {
      return [
        { label: 'Cerca…', action: 'search' },
        { label: 'Novità', path: 'new' },
      ];
    }
    const data = await ctx.http.json('https://api.esempio.org/new');
    return {
      view: 'grid',            // grid | wide | square | list (facoltativo)
      items: data.map(v => ({
        id: v.id,
        label: v.title,
        thumb: v.poster,
        playable: true,
        type: 'video',          // video | audio
        info: { year: v.year, plot: v.plot, duration: v.seconds },
      })),
    };
  },

  // Facoltativo: abilita il pulsante di ricerca.
  async search(query, ctx) { /* restituisce come list() */ },

  // Facoltativo: chiamato quando l'utente apre un elemento riproducibile
  // senza url (o con resolve: true). Utile per ottenere link temporanei.
  async resolve(item, ctx) {
    const s = await ctx.http.json(`https://api.esempio.org/stream/${item.id}`);
    return { url: s.hls, mime: 'application/vnd.apple.mpegurl' };
  },
});
```

### Elementi

| Campo | |
|---|---|
| `label` | Titolo (obbligatorio) |
| `path` | Per le cartelle: il percorso passato a `list()` quando l'utente la apre |
| `url` | Per gli elementi riproducibili: indirizzo diretto dello stream |
| `playable` | `true` per gli elementi riproducibili (dedotto se c'è `url`) |
| `type` | `video` o `audio` |
| `live` | `true` per dirette (nasconde la barra di avanzamento) |
| `thumb`, `fanart` | Immagini |
| `subtitle` | Seconda riga di testo |
| `info` | `{ plot, year, duration (secondi), genre }` |
| `resolve` | `true` per forzare la chiamata a `resolve()` anche se c'è `url` |
| `action` | `search` apre la ricerca, `settings` apre le impostazioni dell'add-on |

### Stream restituito da `resolve()`

```js
{ url, mime?, headers?: { Referer, 'User-Agent' }, proxy?: true, subtitles?: [{ url, label, lang }] }
```

`subtitles`: file WebVTT o SRT (gli SRT li converte il lettore), mostrati con il pulsante CC.

`resolve()` può anche rispondere `{ external: 'https://…', message }` quando scopre solo allora che il contenuto si guarda sul suo sito: Salotto mostra il messaggio con un pulsante che apre il sito. Una lista ancora in costruzione può avere `noCache: true`, così Salotto la richiede quando la pagina viene riaperta.

Il browser non permette di impostare header come `Referer` sulle richieste
video: se li indichi, lo stream passa dal proxy (`node server.js`), che li
aggiunge e riscrive le playlist HLS.

### `ctx`

| | |
|---|---|
| `ctx.settings` | Valori correnti delle impostazioni |
| `ctx.http.json(url, opts)` / `.text()` / `.get()` | Richieste HTTP con fallback automatico al proxy. `opts`: `headers`, `timeout`, `viaProxy`, `type: 'response'` |
| `ctx.http.proxied(url)` | URL riscritto per passare dal proxy (se presente) |
| `ctx.xml` | Utility minime per XML/RSS: `blocks(src, tag)`, `text(src, tag)`, `attr(src, tag, name)`, `attrs(str)` |
| `ctx.log(...)` | Log nella console del browser |
| `ctx.notify(msg)` | Messaggio a comparsa per l'utente |

## Repository

Un repository è un file JSON che elenca più add-on:

```json
{
  "name": "Il mio repository",
  "addons": [
    { "id": "plugin.video.esempio", "name": "Esempio", "version": "1.0.0",
      "description": "…", "manifest": "plugin.video.esempio/addon.json",
      "icon": "plugin.video.esempio/icon.svg" }
  ]
}
```

Aggiungilo da **Add-on → Aggiungi repository**. Quando aumenti `version`,
l'app propone l'aggiornamento.

## CORS

Il browser blocca le richieste verso siti che non lo permettono esplicitamente.
Le API pubbliche moderne (archive.org, radio-browser.info, GitHub Pages…)
funzionano direttamente; per gli altri siti serve il proxy incluso
(`node server.js`). `ctx.http` prova prima la richiesta diretta e, se il
browser la blocca, ripete la richiesta tramite il proxy.

## Contenuti

Gli add-on devono usare fonti che l'utente ha il diritto di guardare. Il
repository ufficiale non include add-on che aggregano stream non autorizzati.
