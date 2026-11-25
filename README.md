# Salotto

Un media center leggero, ispirato ai media center da salotto, che gira
interamente nel browser: Chrome e Safari su iPad, desktop, Android, smart TV
con browser. Supporta gli **add-on**, scritti in JavaScript.

## Funzioni

- Interfaccia a schermo intero pensata per il touch, con navigazione da
  tastiera o telecomando (frecce, Invio, Esc/Backspace per tornare indietro)
- Su iPad in verticale il menu diventa una barra in basso
- Lettore video e audio con HLS (`.m3u8`): nativo su Safari e su tutti i
  browser iPad, tramite hls.js altrove. Riprende i video dal punto lasciato,
  controlli dalla schermata di blocco (Media Session)
- Sottotitoli (tasto CC o tasto S): quelli del canale quando lo stream li
  trasmette (tracce HLS, sottotitoli TV CEA-608, file degli add-on); altrimenti,
  su Mac e PC con WebGPU, sottotitoli generati in italiano dal computer stesso
  con Whisper (transformers.js), con qualche secondo di ritardo. Il modello si
  scarica una volta da Hugging Face e l'audio non lascia mai il computer. Non
  disponibili su iPad, iPhone, Android e Fire TV (troppo pesanti)
- Trasmissione a TV e altoparlanti: Google Cast (Chromecast, Google TV, Nest)
  da Chrome su Android, Mac e PC; AirPlay da iPad, iPhone e Safari sul Mac.
  Per i canali che richiedono il proxy, la TV riceve l'indirizzo del proxy
- Telecomando dal cellulare: inquadri un codice QR e il telefono cambia
  canale, regola volume e sincronia audio, mette in pausa, mostra canali e
  guida TV e muove le frecce dello schermo (passa dal Worker Cloudflare,
  guida in [docs/TELECOMANDO.md](docs/TELECOMANDO.md))
- File locali (dall'app File di iPad, iCloud, chiavette USB), senza caricarli
  da nessuna parte
- Apri URL diretti di stream
- Preferiti
- Installabile come app (PWA): in Safari *Condividi → Aggiungi alla schermata Home*
- Sistema di add-on con repository, installazione da URL, aggiornamenti,
  impostazioni per add-on ed esecuzione isolata in Web Worker

## Add-on inclusi

| Add-on | Contenuto |
|---|---|
| **TV in diretta** | Canali live da playlist M3U con guida TV XMLTV (anche `.gz`). Già pronte due playlist pubbliche di canali italiani in chiaro ([Free-TV/IPTV](https://github.com/Free-TV/IPTV) e [iptv-org](https://github.com/iptv-org/iptv)); se ne possono aggiungere altre |
| **RaiPlay** | Catalogo on demand e ricerca di RaiPlay. I video liberi si guardano in Salotto con i sottotitoli ufficiali Rai (file .srt) quando ci sono; quelli per cui RaiPlay chiede l'accesso (gran parte di film e fiction) si aprono su raiplay.it. Molti solo dall'Italia; fuori da Safari serve il proxy |
| **La7** | Programmi e puntate on demand di la7play.it, con ricerca. Le puntate libere si guardano in Salotto; film, documentari e serie protetti (DRM) si aprono su la7play.it |
| **Mediaset Infinity** | Vetrina del catalogo di Mediaset Infinity: sezioni, programmi, puntate e clip, ricerca tra i programmi. Mediaset protegge le puntate (DRM) e non apre il catalogo ad altri siti: serve il proxy e ogni video si apre su mediasetinfinity.mediaset.it |
| **Internet Archive** | Film di pubblico dominio, noir, fantascienza, cartoni d'epoca, documentari da archive.org |
| **Radio dal mondo** | Migliaia di radio da radio-browser.info, per paese e genere |
| **Podcast** | Ricerca nel catalogo Apple Podcasts e feed RSS personali |
| **Video di prova** | Cortometraggi open source e stream HLS di test; anche l'esempio più semplice di add-on |

Come scriverne uno nuovo: [docs/ADDON_API.md](docs/ADDON_API.md).

## Avvio

Non serve nessuna compilazione: sono file statici.

```bash
node server.js            # http://localhost:8787 e indirizzo per la rete locale
```

Apri l'indirizzo mostrato (es. `http://192.168.1.20:8787`) da Chrome o Safari
sull'iPad. `server.js` non ha dipendenze e richiede Node.js 18 o superiore.

### Online con GitHub Pages

Il workflow `.github/workflows/pages.yml` pubblica l'app a ogni push su
`main`. Va attivato una sola volta: *Settings → Pages → Build and deployment →
Source: GitHub Actions*. L'app sarà su `https://<utente>.github.io/kodi-web/`
e si può installare sull'iPad dalla schermata Home, senza nessun computer acceso.

Su GitHub Pages, come su qualsiasi hosting statico, l'app funziona ma senza
proxy: gli add-on che leggono siti senza CORS (molti feed RSS, alcune
playlist) e i canali che richiedono header particolari non funzioneranno,
finché non si indica un proxy in *Impostazioni*.

### Il proxy

Per l'app pubblicata online il modo più semplice è un proxy gratuito su
Cloudflare Workers: guida passo passo in [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).

Fire TV Stick: app da installare con Downloader, guida in [docs/FIRETV.md](docs/FIRETV.md).

Telecomando dal cellulare: abbinamento con QR, funzioni, installazione come app, guida in [docs/TELECOMANDO.md](docs/TELECOMANDO.md).

`server.js` espone `/proxy?url=…`, usato automaticamente dall'app quando il
browser blocca una richiesta. Aggiunge gli header richiesti dagli stream
(Referer, User-Agent) e riscrive le playlist HLS in modo che anche i segmenti
passino dal proxy.

- Per sicurezza rifiuta gli indirizzi della rete locale (`ALLOW_PRIVATE=1`
  per abilitarli, ad esempio per un NAS).
- Se il server è raggiungibile da Internet imposta `PROXY_TOKEN` con un valore
  casuale tuo (per esempio quello di `openssl rand -hex 24`) e scrivilo in
  *Impostazioni → Token del proxy*.

## Perché add-on JavaScript e non quelli di Kodi?

Gli add-on Kodi sono script Python che usano le API interne di Kodi (`xbmc`,
`xbmcgui`, `xbmcplugin`), oltre a componenti nativi come inputstream e DRM.
Nel browser niente di tutto questo esiste: si potrebbe eseguire Python con
Pyodide (circa 10-15 MB da scaricare, lento su iPad) e simulare una parte delle
API, ma la maggior parte degli add-on reali continuerebbe a non funzionare.

L'API JavaScript di Salotto ricalca gli stessi concetti (cartelle, elementi,
risoluzione dello stream, impostazioni, repository), quindi portare un add-on
Python semplice è in genere una traduzione diretta. Un livello di
compatibilità Python resta possibile in futuro.

## Limiti noti

- I formati riproducibili sono quelli del browser: su iPad MP4/H.264, HEVC,
  MOV, MP3, AAC, HLS. MKV e AVI dipendono dal browser.
- Niente DRM (Widevine/FairPlay) per gli add-on.
- Le pagine HTTPS non possono riprodurre stream HTTP: usa il proxy o un
  server locale in HTTP.
- Alcuni canali Rai sono disponibili solo da connessioni italiane.

## Test

```bash
npm test     # richiede il pacchetto playwright
```

Il test avvia `server.js`, apre l'app in Chromium con dimensioni da iPad e
simula le API esterne. `node tests/remote.mjs` prova il telecomando: uno
schermo e un cellulare simulati collegati al relay del Worker.

## Contenuti

Salotto non fornisce contenuti. Usa add-on e playlist di fonti che hai il
diritto di guardare.
