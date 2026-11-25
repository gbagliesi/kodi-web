# Salotto

Un media center leggero, ispirato ai media center da salotto, che gira
interamente nel browser: iPad e iPhone, Android, Mac e PC, Fire TV Stick,
smart TV con browser. I contenuti arrivano dagli **add-on**, scritti in
JavaScript.

**Apri Salotto: https://gbagliesi.github.io/kodi-web/**

## Per iniziare

1. **Installa Salotto** sui tuoi dispositivi come app: iPad/iPhone con Safari
   (*Condividi → Aggiungi alla schermata Home*), Android con Chrome
   (*⋮ → Installa app*), Mac con Safari (*File → Aggiungi al Dock*), Fire TV
   con Downloader ([docs/FIRETV.md](docs/FIRETV.md)).
2. **Crea il Worker Cloudflare** (gratuito, 15 minuti, una volta sola): fa da
   proxy, da relay per il telecomando e da archivio per la sincronizzazione
   ([docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)).
3. **Su ogni dispositivo**: *Impostazioni* → indirizzo e token del Worker →
   *Salva* («proxy raggiungibile ✓»). Preferiti, add-on e impostazioni
   arrivano poi da soli dagli altri dispositivi.
4. Per YouTube crea una **chiave API** gratuita
   ([docs/GUIDA.md, punto 6](docs/GUIDA.md#6-youtube-la-chiave-api)).

## Le guide

| Guida | Contenuto |
|---|---|
| [docs/GUIDA.md](docs/GUIDA.md) | **Come si usa**: installazione per dispositivo, add-on, TV in diretta e TGR, YouTube, preferiti, ordinare elenchi e add-on, lettore (zoom, sottotitoli, sincronia audio, Chromecast/AirPlay), sincronizzazione, problemi comuni |
| [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) | Creare e aggiornare il Worker (proxy, telecomando, sincronizzazione), cambiare il token, il proxy per un amico |
| [docs/TELECOMANDO.md](docs/TELECOMANDO.md) | Il cellulare come telecomando: abbinamento con QR, schede, installazione come app |
| [docs/FIRETV.md](docs/FIRETV.md) | L'app per Fire TV Stick e l'uso con il telecomando |
| [docs/ADDON_API.md](docs/ADDON_API.md) | Scrivere un add-on |

## Funzioni

- Interfaccia a schermo intero per touch, mouse, tastiera e telecomando TV;
  su iPad in verticale e sul telefono il menu diventa una barra in basso
- Lettore video e audio con HLS (`.m3u8`): nativo su Safari, iPad e iPhone,
  tramite hls.js altrove. Riprende i video dal punto lasciato, controlli dalla
  schermata di blocco, finestra mobile (picture-in-picture)
- Dirette: zapping nel lettore (CH ▲▼, scorrimento verticale, numero del
  canale, elenco canali), ritorno indietro nella finestra dell'emittente e
  tasto LIVE, guida TV con programma in onda e successivo
- **Zoom con due dita** sull'immagine per togliere le bande nere, doppio tocco
  per riempire lo schermo (pizzico sul trackpad, tasto Z)
- **Sottotitoli** (CC o tasto S): quelli del canale (tracce HLS, sottotitoli
  TV, file di RaiPlay); su Mac e PC con WebGPU anche generati in italiano dal
  computer con Whisper, senza mandare l'audio da nessuna parte
- **Sincronia audio** (A/V) regolabile e salvata per ogni canale
- Trasmissione a TV e altoparlanti: Google Cast da Chrome, AirPlay da Safari,
  iPad e iPhone
- **Preferiti** da qualsiasi elenco: ☆ accanto a ogni riga e su ogni tessera,
  tasto ☰ del telecomando (Menu o \* sulla tastiera), clic destro o pressione
  lunga; ☆ anche nel lettore. I preferiti si ordinano e compaiono nella Home
  nello stesso ordine
- **Ordine degli elenchi** (▦): lista originale, per numero, per nome o un
  ordine tuo (▲▼), che resta anche quando la lista si aggiorna; canali nuovi
  segnati NUOVO
- **Ordine degli add-on**: *Add-on → Riordina* o ▦ nella Home e nelle sezioni
- **Pagina iniziale** a scelta (📌 su qualsiasi pagina)
- **Telecomando dal cellulare**: inquadri un codice QR (anche dall'app del
  telecomando, con la fotocamera o da una foto) e il telefono cambia canale,
  regola volume e sincronia audio, mostra canali e guida TV e muove le frecce
  dello schermo, anche da un'altra rete
- **Sincronizzazione tra dispositivi** attraverso il Worker Cloudflare:
  preferiti, punti di ripresa, ordini, add-on con le loro impostazioni (anche
  la chiave di YouTube), canali YouTube salvati e opzioni. Gruppi separati
  (per esempio `bambini`), possibilità di scollegare un dispositivo, storico
  di 30 giorni sul Worker
- File locali (app File di iPad, iCloud, chiavette USB) senza caricarli da
  nessuna parte, e URL diretti di stream
- Add-on con repository, aggiornamento automatico di quelli inclusi,
  installazione da URL, impostazioni per add-on ed esecuzione isolata in Web
  Worker

## Add-on inclusi

| Add-on | Contenuto |
|---|---|
| **TV in diretta** | Canali italiani in chiaro dalle playlist pubbliche [Free-TV/IPTV](https://github.com/Free-TV/IPTV) e [iptv-org](https://github.com/iptv-org/iptv), le tue playlist M3U, guida TV (XMLTV, anche `.gz`). Include **TGR regionali (Rai)**: la diretta di ogni regione quando il TG è in onda (● = acceso ora; Bolzano, Trento e Friuli Venezia Giulia sempre accesi) e le ultime edizioni da rainews.it |
| **RaiPlay** | Catalogo on demand e ricerca. I video liberi si guardano in Salotto con i sottotitoli ufficiali Rai; quelli per cui RaiPlay chiede l'accesso si aprono su raiplay.it. Molti solo dall'Italia; fuori da Safari serve il proxy |
| **La7** | Programmi e puntate di la7play.it, con ricerca. Le puntate libere si guardano in Salotto; film e serie protetti (DRM) si aprono sul sito |
| **Mediaset Infinity** | Il catalogo da sfogliare: sezioni, programmi, puntate e clip, ricerca. Le puntate sono protette (DRM): serve il proxy e ogni video si apre su mediasetinfinity.mediaset.it |
| **YouTube** | Ricerca, tendenze, categorie, dirette, «I miei canali» e playlist, con il lettore ufficiale di YouTube. Per cercare serve una chiave gratuita della YouTube Data API ([istruzioni](docs/GUIDA.md#6-youtube-la-chiave-api)) |
| **Radio italiane** | Rai Radio 1, 2, 3 e gli altri canali Rai, le nazionali (RTL 102.5, Deejay, 105, RDS, Radio 24…) con gli stream ufficiali; catalogo per popolarità e per regione |
| **Radio dal mondo** | Migliaia di radio da radio-browser.info, per paese e genere |
| **Internet Archive** | Film di pubblico dominio, noir, fantascienza, cartoni d'epoca, documentari da archive.org |
| **Podcast** | Ricerca nel catalogo Apple Podcasts e feed RSS personali |
| **Video di prova** | Cortometraggi open source e stream HLS di test; anche l'esempio più semplice di add-on |

## Pubblicazione e sviluppo

Non serve nessuna compilazione: sono file statici.

### GitHub Pages

Il workflow `.github/workflows/pages.yml` pubblica l'app a ogni push su
`main` (e ogni 4 ore aggiorna la guida TV `epg/it.json`). Va attivato una sola
volta: *Settings → Pages → Build and deployment → Source: GitHub Actions*.
L'app sarà su `https://<utente>.github.io/kodi-web/`. GitHub Pages può
metterci fino a 10 minuti a mostrare una versione nuova; in Salotto
*Impostazioni → Forza aggiornamento* scarica di nuovo l'app.

Altri workflow:

- `worker.yml` pubblica il Worker Cloudflare quando cambia `cloudflare/`
  ([docs/CLOUDFLARE.md](docs/CLOUDFLARE.md#4-pubblica-il-worker-completo-con-github));
- `firetv.yml` costruisce l'APK per Fire TV e lo pubblica nella release
  `firetv` ([docs/FIRETV.md](docs/FIRETV.md)).

### Proxy locale con server.js

In casa, al posto del Worker, si può usare un computer o un NAS:

```bash
node server.js            # http://localhost:8787 e indirizzo per la rete locale
```

Apri l'indirizzo mostrato (es. `http://192.168.1.20:8787`). `server.js` non
ha dipendenze e richiede Node.js 18 o superiore. Espone `/proxy?url=…`, usato
automaticamente dall'app quando il browser blocca una richiesta: aggiunge gli
header richiesti dagli stream (Referer, User-Agent) e riscrive le playlist HLS
in modo che anche i segmenti passino dal proxy. Telecomando e
sincronizzazione invece esistono solo nel Worker Cloudflare.

- Per sicurezza rifiuta gli indirizzi della rete locale (`ALLOW_PRIVATE=1`
  per abilitarli, ad esempio per un NAS).
- Se il server è raggiungibile da Internet imposta `PROXY_TOKEN` con un valore
  casuale tuo (per esempio quello di `openssl rand -hex 24`) e scrivilo in
  *Impostazioni → Token del proxy*.

Le pagine HTTPS (come GitHub Pages) non possono usare un proxy HTTP: con
l'app pubblicata online serve il Worker Cloudflare.

### Versioni

La versione è in `js/version.js` e si vede in *Impostazioni → Informazioni*.
Gli add-on inclusi si aggiornano da soli quando aumenta la loro `version` in
`addons/<id>/addon.json` e in `addons/repository.json`.

### Test

```bash
npm test     # richiede il pacchetto playwright
```

`npm test` lancia la prova generale (`smoke.mjs`: avvia `server.js`, apre
l'app in Chromium con dimensioni da iPad e simula le API esterne) e poi
`remote.mjs` (telecomando, con uno schermo e un cellulare collegati al relay
del Worker), `subtitles.mjs`, `raiplay.mjs`, `la7.mjs`, `storage.mjs` e
`sync.mjs` (tre Salotto e lo store del Worker). Altri test si lanciano a
parte con `node tests/<nome>.mjs`: `zoom.mjs`, `mediaset.mjs`, `youtube.mjs`.

## Perché add-on JavaScript e non quelli di Kodi?

Gli add-on Kodi sono script Python che usano le API interne di Kodi (`xbmc`,
`xbmcgui`, `xbmcplugin`), oltre a componenti nativi come inputstream e DRM.
Nel browser niente di tutto questo esiste: si potrebbe eseguire Python con
Pyodide (circa 10-15 MB da scaricare, lento su iPad) e simulare una parte delle
API, ma la maggior parte degli add-on reali continuerebbe a non funzionare.

L'API JavaScript di Salotto ricalca gli stessi concetti (cartelle, elementi,
risoluzione dello stream, impostazioni, repository), quindi portare un add-on
Python semplice è in genere una traduzione diretta.

## Limiti noti

- I formati riproducibili sono quelli del browser: su iPad MP4/H.264, HEVC,
  MOV, MP3, AAC, HLS. MKV e AVI dipendono dal browser.
- Niente DRM (Widevine/FairPlay): i contenuti protetti di RaiPlay, La7 e
  Mediaset si aprono sui loro siti.
- Le pagine HTTPS non possono riprodurre stream HTTP: usa il proxy.
- Alcuni canali Rai e i TGR sono disponibili solo da connessioni italiane.
- Su iPad e iPhone il telecomando non può cambiare il volume (solo il muto).

## Contenuti

Salotto non fornisce contenuti. Usa add-on e playlist di fonti che hai il
diritto di guardare: il repository ufficiale non include add-on che aggregano
stream non autorizzati.
