# Guida di Salotto

Questa guida spiega come usare Salotto passo per passo, dispositivo per
dispositivo. Salotto è all'indirizzo

**https://gbagliesi.github.io/kodi-web/**

e funziona da solo, senza computer acceso. Per i canali Rai in Chrome, il
telecomando dal cellulare e la sincronizzazione tra dispositivi serve anche il
proxy Cloudflare: si configura una volta sola ([CLOUDFLARE.md](CLOUDFLARE.md)).

Indice

1. [Installare Salotto su ogni dispositivo](#1-installare-salotto-su-ogni-dispositivo)
2. [Primo avvio: proxy e sincronizzazione](#2-primo-avvio-proxy-e-sincronizzazione)
3. [Muoversi nell'app](#3-muoversi-nellapp)
4. [Gli add-on](#4-gli-add-on)
5. [TV in diretta, TGR regionali e Guida TV](#5-tv-in-diretta-tgr-regionali-e-guida-tv)
6. [YouTube: la chiave API](#6-youtube-la-chiave-api)
7. [Preferiti](#7-preferiti)
8. [Ordinare elenchi e add-on](#8-ordinare-elenchi-e-add-on)
9. [Il lettore](#9-il-lettore)
10. [Sincronizzazione tra dispositivi](#10-sincronizzazione-tra-dispositivi)
11. [Se qualcosa non va](#11-se-qualcosa-non-va)

---

## 1. Installare Salotto su ogni dispositivo

Salotto si apre in qualsiasi browser, ma installato come app è a schermo
intero e parte con un tocco.

### iPad e iPhone (Safari)

1. Apri Safari e vai su `https://gbagliesi.github.io/kodi-web/`.
2. Tocca **Condividi** (□↑) → **Aggiungi alla schermata Home** → **Aggiungi**.
3. Apri Salotto dall'icona sulla schermata Home.

Su iPad e iPhone i canali Rai partono senza proxy, perché Safari riproduce
HLS da solo. La finestra mobile (PiP) funziona dall'app della schermata Home.

### Android (Chrome, per esempio un Pixel)

1. Apri Chrome e vai su `https://gbagliesi.github.io/kodi-web/`.
2. Menu **⋮** → **Installa app** (o **Aggiungi a schermata Home** →
   **Installa**).
3. Apri Salotto dall'icona.

Su Android c'è un'opzione in più, in **Impostazioni**: **Finestra mobile
automatica**. Se è attiva, i video si aprono a schermo intero e, quando esci
dall'app, continuano in una finestra mobile.

### Mac con Safari (consigliato sul Mac)

1. Apri Safari e vai su `https://gbagliesi.github.io/kodi-web/`.
2. Menu **File** → **Aggiungi al Dock** → **Aggiungi**.
3. Apri Salotto dal Dock.

Safari riproduce HLS da solo, quindi i canali Rai partono anche senza proxy.
AirPlay funziona; Chromecast invece solo da Chrome. Per restare a schermo
intero tra un canale e l'altro, metti la finestra a schermo intero di macOS
(pulsante verde o Ctrl+Cmd+F).

### Mac, PC e Linux con Chrome o Edge

1. Vai su `https://gbagliesi.github.io/kodi-web/`.
2. Nella barra degli indirizzi clicca l'icona **Installa** (oppure menu ⋮ →
   **Trasmetti, salva e condividi** → **Installa pagina come app**).

In Chrome i canali Rai e altri canali «solo Italia» passano dal proxy (vedi
il punto 2). Da Chrome funziona la trasmissione a Chromecast.

### Fire TV Stick

Si installa un'app con **Downloader**: istruzioni in [FIRETV.md](FIRETV.md).

### Smart TV con browser

Apri l'indirizzo nel browser della TV. Si usa con le frecce, OK e Indietro
del telecomando.

---

## 2. Primo avvio: proxy e sincronizzazione

Fai questi passi **su ogni dispositivo** (Mac, iPad, telefono, Fire TV).
Ti servono l'indirizzo e il token del tuo Worker Cloudflare: se non li hai
ancora, crea il Worker con [CLOUDFLARE.md](CLOUDFLARE.md) (circa 10 minuti,
una volta sola).

1. Apri Salotto → **⚙ Impostazioni** (sull'iPad in verticale e sul telefono:
   **Opzioni** nella barra in basso).
2. In **Proxy per add-on e stream** incolla l'indirizzo del tuo Worker
   (finisce con `.workers.dev`).
3. In **Token del proxy** incolla il tuo token.
4. Premi **Salva**. Deve comparire «Salvato · proxy raggiungibile ✓». Da
   questo momento compaiono anche gli add-on (punto 4), che senza token non
   sono disponibili.
   - «il token del proxy è sbagliato»: ricopialo (attenzione agli spazi).
   - «il proxy rifiuta tutto»: nel Worker manca il `TOKEN`
     ([CLOUDFLARE.md, punto 3](CLOUDFLARE.md#3-proteggilo-con-un-token-obbligatorio)).
   - «il proxy non risponde»: controlla l'indirizzo.
5. Più in basso, in **Sincronizzazione tra dispositivi**, lascia la spunta su
   **Sincronizza questo dispositivo con gli altri** e il gruppo `casa`. Dopo
   pochi secondi compare «Sincronizzato alle … ✓» e arrivano preferiti,
   add-on e impostazioni degli altri dispositivi.

Indirizzo e token del proxy **non** passano da un dispositivo all'altro, per
sicurezza: vanno scritti su ognuno. Tutto il resto arriva con la
sincronizzazione (dettagli al [punto 10](#10-sincronizzazione-tra-dispositivi)).

Il token non va mai scritto in messaggi, documenti o siti: chi lo conosce può
usare il tuo proxy e leggere i tuoi preferiti. Se lo hai condiviso per
sbaglio, cambialo ([CLOUDFLARE.md](CLOUDFLARE.md#cambiare-il-token)).

---

## 3. Muoversi nell'app

Il menu a sinistra (in basso su iPad in verticale e sul telefono) ha:

| Voce | Cosa contiene |
|---|---|
| ⌂ **Home** | Saluto, sezioni, i primi preferiti e tutti gli add-on |
| 🎬 **Video** | Gli add-on di video (RaiPlay, La7, Mediaset, YouTube, Internet Archive…) |
| 🎵 **Musica** | Radio e podcast |
| 📺 **TV** | TV in diretta e gli add-on con dirette |
| 🗓 **Guida TV** | La griglia dei programmi |
| 📁 **File** | Video e audio del dispositivo (app File, iCloud, chiavetta USB) |
| ★ **Preferiti** | I tuoi preferiti, nell'ordine che scegli |
| 📱 **Telecomando** | Abbinare il cellulare come telecomando ([TELECOMANDO.md](TELECOMANDO.md)) |
| 🧩 **Add-on** | Installare, aggiornare, riordinare e configurare gli add-on |
| ⚙ **Impostazioni** | Proxy, sincronizzazione, pagina iniziale, vista, versione |

I pulsanti in alto a destra compaiono quando servono:

- **🔍 Cerca** dentro l'add-on aperto;
- **▦ Vista e ordine**: griglia o elenco, ordine dell'elenco (punto 8);
- **📌 Imposta come pagina iniziale**: Salotto partirà sempre da questa pagina
  (per esempio l'elenco dei canali). Si cambia anche in **Impostazioni →
  Pagina iniziale**, dove c'è anche «L'ultima pagina aperta».

Con tastiera o telecomando: frecce per muoversi, **Invio/OK** per aprire,
**Esc/Backspace/Indietro** per tornare indietro.

Dalla Home, **🔗 Apri URL** apre direttamente l'indirizzo di uno stream (MP4,
WebM, MP3, HLS `.m3u8`).

---

## 4. Gli add-on

> **Gli add-on sono disponibili solo con il token del Worker Cloudflare.**
> Stanno in un repository privato e li distribuisce il Worker: si vedono solo
> con indirizzo e token del proxy impostati (punto 2), il tuo o quello
> personale che ti ha dato il proprietario del Worker. Senza token resta solo
> «Video di prova».
>
> Vuoi **costruire i tuoi add-on e un tuo repository**? Le istruzioni sono in
> [ADDON_API.md](ADDON_API.md).

In **🧩 Add-on** → **Sfoglia repository** scegli quali installare («Add-on
del Worker», in cima); quelli installati si aggiornano da soli quando esce una
versione nuova. Ecco cosa fa ciascuno:

| Add-on | Sezione | Cosa fa | Proxy |
|---|---|---|---|
| **TV in diretta** | TV | Canali italiani in chiaro (playlist Free-TV e iptv-org), TGR regionali Rai, le tue playlist M3U, guida TV | Per i canali Rai in Chrome / Fire TV |
| **RaiPlay** | Video | Catalogo e ricerca di RaiPlay; i video liberi si guardano in Salotto con i sottotitoli Rai, quelli che chiedono l'accesso si aprono su raiplay.it | Fuori da Safari sì |
| **La7** | Video | Programmi e puntate di la7play.it; film e serie protetti (DRM) si aprono sul sito | Per la ricerca completa |
| **Mediaset Infinity** | Video | Il catalogo da sfogliare (sezioni, programmi, puntate, clip); ogni video si apre su mediasetinfinity.mediaset.it perché è protetto (DRM) | Sempre |
| **YouTube** | Video, TV | Ricerca, tendenze, categorie, dirette, «I miei canali», playlist; i video si guardano con il lettore ufficiale di YouTube | Solo senza chiave API |
| **Internet Archive** | Video | Film di pubblico dominio, cartoni d'epoca, documentari | No |
| **Radio italiane** | Musica | Rai Radio 1, 2, 3 e gli altri canali Rai, le nazionali (RTL 102.5, Deejay, 105, RDS, Radio 24…) con gli stream ufficiali; catalogo per popolarità e per regione | No |
| **Radio dal mondo** | Musica | Migliaia di radio da radio-browser.info, per paese e genere | No |
| **Podcast** | Musica | Ricerca nel catalogo Apple Podcasts e feed RSS tuoi | A volte |
| **Video di prova** | Video | Cortometraggi open source e stream di test | No |

Nella pagina **🧩 Add-on**:

- tocca un add-on per aprirlo, **⚙** accanto per le sue **impostazioni**,
  **Disattiva/Attiva**, **Ricarica / aggiorna** e **Disinstalla**;
- **Sfoglia repository** mostra gli add-on disponibili, anche quelli che hai
  disinstallato;
- **Installa da URL** e **Aggiungi repository** servono per add-on tuoi o di
  altri (come costruire add-on e repository: [ADDON_API.md](ADDON_API.md));
- **Riordina** cambia l'ordine delle icone (punto 8).

---

## 5. TV in diretta, TGR regionali e Guida TV

### I canali

1. Apri **📺 TV** → **TV in diretta**.
2. Scegli una playlist (**Digitale terrestre Italia (Free-TV)**, solo
   stream ufficiali, o **Canali italiani (iptv-org)**, più ampia), poi un gruppo o **Tutti i
   canali**. **Cerca un canale…** trova un canale per nome.
3. Tocca un canale. Nel lettore puoi cambiare canale senza uscire (punto 9).

Simboli nei nomi: **Ⓖ** = solo dall'Italia; **Ⓨ** = diretta YouTube. Le liste
si aggiornano da sole all'avvio e ogni 6 ore; se il download non riesce resta
la copia precedente. I canali appena comparsi hanno l'etichetta **NUOVO** per
7 giorni.

Per aggiungere una tua playlist: **🧩 Add-on** → **⚙** su TV in diretta →
**Le mie playlist M3U**, una per riga, nella forma `Nome | https://…/lista.m3u`.
Qui puoi anche nascondere le playlist pubbliche o disattivare il
raggruppamento per categoria.

### TGR regionali (Rai)

Nell'elenco delle playlist c'è **TGR regionali (Rai)**:

- **le dirette** di tutte le regioni. Rai accende i canali regionali solo per
  i TG (alle 14:00 e alle 19:30, nei feriali anche Buongiorno Regione alle
  7:40), circa mezz'ora prima: fino all'inizio trasmettono Rai 3 nazionale.
  Il pallino **●** e «Acceso ora» indicano i canali accesi in quel momento.
  Bolzano, Trento e Friuli Venezia Giulia (anche in sloveno) sono sempre
  accesi. Solo dall'Italia;
- **Ultime edizioni (on demand)**: i notiziari già andati in onda, regione per
  regione, presi da rainews.it. Per elencarli serve il proxy.

### Guida TV

**🗓 Guida TV** è una griglia: canali in verticale, orari in orizzontale.
Si aggiorna ogni 4 ore. In alto scegli quale elenco di canali vedere: una
playlist di TV in diretta o **★ Preferiti** (se hai canali tra i preferiti). Tocca un programma per la descrizione e **Guarda** per aprire il
canale. Programma in onda e successivo compaiono anche negli elenchi dei
canali e nel lettore (**ⓘ** o tasto **I**).

---

## 6. YouTube: la chiave API

Senza chiave l'add-on YouTube sa solo aprire un link YouTube incollato nella
ricerca e mostrare gli ultimi video dei canali salvati (passando dal proxy).
Per cercare e sfogliare serve una chiave gratuita della **YouTube Data API
v3**. Servono circa 5 minuti, una volta sola.

1. Vai su https://console.cloud.google.com e accedi con un account Google.
2. In alto, accanto al logo, apri l'elenco dei progetti → **Nuovo progetto**
   → nome `salotto` → **Crea**. Controlla che in alto sia selezionato il
   progetto appena creato.
3. Menu ☰ → **API e servizi** → **Libreria**. Cerca **YouTube Data API v3**,
   aprila e premi **Abilita**.
4. Menu ☰ → **API e servizi** → **Credenziali** → **Crea credenziali** →
   **Chiave API**. Compare la chiave (inizia con `AIza`).
5. Proteggila: clicca sulla chiave (o **Modifica chiave API**):
   - **Restrizioni delle applicazioni** (*Application restrictions*) →
     **Siti web** (*Websites*) → **Aggiungi** → `https://gbagliesi.github.io/*`;
   - **Restrizioni delle API** (*API restrictions*) → **Limita chiave**
     (*Restrict key*) → scegli solo **YouTube Data API v3**;
   - **Salva**.
6. In Salotto: **🧩 Add-on** → **⚙** su **YouTube** → incolla la chiave in
   **Chiave API (YouTube Data API v3)** → **Salva**.

Con la sincronizzazione attiva la chiave arriva da sola sugli altri tuoi
dispositivi. Non serve inserire carte di credito: la quota gratuita è di
10.000 unità al giorno, e ogni ricerca ne usa 100 (circa 100 ricerche al
giorno); sfogliare tendenze, canali e playlist costa quasi niente.

Nell'add-on:

- **Cerca su YouTube…**: video, canali e playlist; si può anche incollare un
  link YouTube;
- **Di tendenza**, **Categorie**, **🔴 In diretta ora** (il paese si sceglie
  nelle impostazioni dell'add-on, insieme al filtro contenuti);
- dalla pagina di un canale **★ Aggiungi ai miei canali**: lo ritrovi in
  **I miei canali**, su tutti i dispositivi.

I video si guardano nel lettore ufficiale di YouTube incorporato, con la
pubblicità di YouTube. Con il telecomando: OK = pausa, ◀▶ = indietro/avanti
10 s, ▲ = barra, Indietro = chiudi. Alcuni video non si possono guardare
fuori da YouTube: Salotto lo dice e offre di aprirli su YouTube.

---

## 7. Preferiti

Un canale, un programma, una radio o un video si aggiunge ai preferiti in
uno di questi modi:

- tocca la stellina **☆** accanto alla riga o sull'immagine della tessera
  (diventa **★**);
- con il telecomando o la tastiera: seleziona l'elemento e premi **☰** (sulla
  tastiera il tasto Menu o **\***). Negli elenchi puoi anche premere **▶** per
  arrivare alla stellina;
- clic destro con il mouse, o pressione lunga sul touch;
- durante la riproduzione, **☆** in alto nel lettore.

Gli stessi gesti tolgono un preferito. Nella pagina **★ Preferiti** una
stellina tolta resta visibile (☆) finché non riapri la pagina, così puoi
rimetterla subito.

I primi 8 preferiti compaiono anche nella Home, nello stesso ordine della
pagina Preferiti. Per cambiarlo: **★ Preferiti** → **▦** (punto 8). I canali
preferiti formano anche un elenco nella Guida TV e nel telecomando, e nel
lettore si può fare zapping tra loro.

---

## 8. Ordinare elenchi e add-on

### Un elenco (canali, preferiti…)

1. Apri l'elenco e premi **▦** in alto.
2. **Vista**: Automatica, Elenco o Icone.
3. **Ordine di questo elenco**:
   - **Lista originale**: come la pubblica la sorgente;
   - **Per numero di canale**: come sul telecomando (1 Rai 1, 2 Rai 2…);
   - **Per nome (A–Z)**;
   - **Il mio ordine personalizzato**.
4. Per creare il tuo ordine premi **Riordina a mano** (o **Modifica il mio
   ordine**): sposta ogni riga con **▲ ▼** e premi **Fatto**.
5. **Cancella il mio ordine** torna alla lista originale.

Quando la lista si aggiorna, i canali del tuo ordine restano al loro posto e
quelli nuovi si inseriscono vicino alla loro posizione originale (oppure in
fondo, con **Metti i canali nuovi in fondo**). Nel lettore, CH ▲▼ seguono
l'ordine scelto.

Per le liste di TV in diretta lo stesso riquadro dice quando è stata
scaricata e ha **Aggiorna la lista adesso**.

### Gli add-on

- **🧩 Add-on** → **Riordina**, oppure **▦** nella Home o in una sezione
  (Video, Musica, TV).
- Sposta con **▲ ▼** e premi **Fatto**.

L'ordine è uno solo per tutte le sezioni: se riordini quelli di TV, si
spostano solo fra i loro posti. Passa agli altri dispositivi con la
sincronizzazione.

---

## 9. Il lettore

### Comandi sullo schermo

| Pulsante | Cosa fa |
|---|---|
| **✕** | Chiude il video |
| **Diretto / Proxy** | Come arriva lo stream; toccalo per i dettagli (risoluzione, bitrate, percorso) |
| **☆** | Preferito |
| **ⓘ** | Programma in onda e successivi |
| **☰** | Elenco dei canali, con il campo **Numero** |
| **Trasmetti** | Chromecast (da Chrome) o AirPlay (Safari, iPad, iPhone) |
| **⏪ ⏯ ⏩** | Indietro 10 s, pausa, avanti 30 s |
| **CH ▼ ▲** | Canale precedente / successivo |
| **CC** | Sottotitoli |
| **A/V** | Sincronia audio |
| **Volume**, **Finestra mobile**, **⛶** | Volume, picture-in-picture, schermo intero |

Nelle dirette **−m:ss** indica quanto sei indietro e **LIVE ▶▶** torna alla
diretta: si può tornare indietro fin dove lo permette l'emittente.

I video on demand riprendono dal punto in cui li hai lasciati (si può
spegnere in **Impostazioni**). Il punto di ripresa passa agli altri
dispositivi.

### Più video insieme: «Stacca»

Il pulsante «Stacca» (quadrato con la freccia, in basso a destra nel lettore) sposta il video, o la radio, in una finestra sopra la pagina: il lettore grande si chiude e puoi continuare a usare l'app, aprire un altro canale e staccare anche quello.

- **Quante finestre**: fino a 4 sul computer, 2 su iPad/tablet, 1 sul telefono (un mini‑lettore). Aprendone una in più, la più vecchia si chiude. Sulla Fire TV il pulsante non c'è.
- **Audio**: si sente un solo video alla volta. Tocca 🔊 su una finestra per sentire quella; le altre (e il lettore grande) si zittiscono. Il lettore grande mostra «Audio su …, tocca per sentire questo» per riprenderlo.
- **Spostare e ridimensionare**: trascina la barra del titolo; l'angolo in basso a destra cambia la grandezza (il video resta 16:9). Con due o più finestre compare in basso «▦ Affianca» (le dispone una accanto all'altra, grandi quanto possibile) e «✕ Chiudi tutte».
- **⤢** (o doppio clic sul video) riporta il video nel lettore grande; se nel lettore c'era già un video, i due si scambiano di posto.
- **Fuori dal browser**: in Chrome e Edge sul computer il pulsante con il riquadro sposta la finestra in una finestra di sistema sempre in primo piano, anche sopra altre app (una alla volta). Altrove usa la finestra mobile del sistema, se c'è.
- **Proxy**: ogni finestra scarica il proprio stream. Una finestra che passa dal proxy (bollino «Proxy») conta nella quota Cloudflare come uno spettatore in più. Nel registro degli accessi il tempo di visione conta una volta sola anche con più video insieme.
- Nelle finestre non ci sono sottotitoli, sincronia audio né cambio canale: riportale nel lettore grande per usarli.

### Cambiare canale

- **CH ▲ ▼**, oppure scorri in verticale con un dito (in su = canale
  successivo);
- scrivi il numero con la tastiera o con il campo **Numero** dell'elenco;
- **☰** (o tasto **C**) apre l'elenco dei canali.

### Gesti sull'immagine: zoom

- **Due dita** che si allargano ingrandiscono il video (per togliere le bande
  nere dei film); con **un dito** sposti l'immagine ingrandita.
- **Doppio tocco**: riempie lo schermo ⇄ dimensioni originali.
- Sul Mac: pizzico sul trackpad. Con la tastiera: tasto **Z**.

Lo zoom vale solo per il video in corso.

### Sottotitoli

Premi **CC** (o tasto **S**):

- quelli del canale, quando lo stream li ha (tracce HLS, sottotitoli TV,
  file .srt di RaiPlay);
- altrimenti, **su Mac e PC**, sottotitoli in italiano generati dal computer
  con Whisper, con qualche secondo di ritardo. Servono Chrome o Edge
  aggiornati, oppure Safari 26. Il modello si scarica una volta; l'audio non
  lascia mai il computer. Non disponibili su iPad, iPhone, Android e Fire TV.

Nel riquadro CC si sceglie la traccia, per quelli generati anche la lingua e
la qualità della trascrizione, e si regola la sincronia con il parlato
(mezzo secondo o 5 secondi prima/dopo). La scelta resta per i video
successivi.

### Sincronia audio

Se la voce non va a tempo con le labbra, premi **A/V**: **Voce prima** e
**Voce dopo** spostano l'audio di 50 ms, **Azzera** torna a zero. Il valore
resta salvato per quel canale.

### Tasti della tastiera

| Tasto | |
|---|---|
| Spazio, K | Pausa / riprendi |
| ◀ ▶ | −10 s / +30 s |
| ▲ ▼, PagSu/PagGiù | Cambia canale |
| 0–9 | Numero del canale |
| C | Elenco canali |
| I | Programma in onda |
| S | Sottotitoli |
| F | Schermo intero |
| Z | Zoom |
| Esc, Backspace | Chiude pannello, poi il video |

Sulla Fire TV e con il telecomando del cellulare i tasti cambiano un poco
(comandi nascosti: ▲▼ cambiano canale, ◀▶ si spostano, OK mostra i comandi):
vedi [FIRETV.md](FIRETV.md) e [TELECOMANDO.md](TELECOMANDO.md).

### Trasmettere alla TV

- **Chromecast / Google TV**: da Chrome su Mac, PC o Android, pulsante
  **Trasmetti** nel lettore. La TV scarica lo stream dal tuo Worker quando
  serve il proxy.
- **AirPlay**: da Safari sul Mac, iPad o iPhone.

Durante la trasmissione volume e sincronia audio li gestisce la TV.

---

## 10. Sincronizzazione tra dispositivi

Con il proxy Cloudflare impostato, i tuoi Salotto restano allineati da soli.

**Cosa passa da un dispositivo all'altro**: preferiti e il loro ordine, punti
di ripresa, ordine degli elenchi («Il mio ordine»), ordine degli add-on, add-on
installati e attivi con le loro impostazioni (chiave API di YouTube, playlist
M3U aggiunte), i canali salvati di YouTube, sincronia audio e dei sottotitoli,
scelta dei sottotitoli, pagina iniziale, vista degli elenchi, ripresa
automatica, repository aggiunti.

**Cosa resta su ogni dispositivo**: indirizzo e token del proxy, finestra
mobile di Android, telecomando abbinato, add-on caricati da file, l'ultima
pagina visitata.

Come funziona:

- i dati stanno in un Durable Object del **tuo** account Cloudflare, nello
  stesso Worker del proxy e protetti dallo **stesso TOKEN**: tutti i
  dispositivi devono avere lo stesso indirizzo e lo stesso token;
- una modifica parte dopo pochi secondi; gli altri dispositivi la ricevono
  quando tornano in primo piano o entro 2 minuti. **⟳ Sincronizza adesso**
  (in Impostazioni) per non aspettare;
- se lo stesso elemento cambia su due dispositivi vale la modifica più
  recente; i preferiti presenti solo su un dispositivo vengono uniti;
- il Worker tiene per **30 giorni** i valori sostituiti o cancellati, così un
  dato perso per errore si può ancora recuperare (serve chi sviluppa: non c'è
  ancora un pulsante nell'app).

### Gruppi

In **Impostazioni → Sincronizzazione tra dispositivi → Gruppo** (di serie
`casa`): i dispositivi con lo stesso gruppo condividono tutto. Un gruppo
diverso (per esempio `bambini`) ha preferiti e impostazioni separati, sullo
stesso Worker. Il nome può avere solo lettere minuscole, numeri e trattini;
dopo averlo scritto premi **Cambia**.

### Scollegare un dispositivo

Togli la spunta **Sincronizza questo dispositivo con gli altri**: tiene i
suoi dati ma non manda né riceve più nulla. Quando la rimetti prende i dati
degli altri e aggiunge i preferiti che aveva solo lui.

**Ripristina tutto** (in Impostazioni) cancella add-on, preferiti e
impostazioni del dispositivo; con la sincronizzazione attiva, quelli degli
altri tornano subito.

---

## 11. Se qualcosa non va

| Problema | Cosa fare |
|---|---|
| Un canale Rai non parte in Chrome o sulla Fire TV | Controlla il proxy in Impostazioni («proxy raggiungibile ✓»). Su iPad e Safari del Mac parte anche senza |
| Un canale Ⓖ non parte nemmeno con il proxy | Il proxy esce da un server Cloudflare, di solito in Italia ma non sempre: guardalo da iPad o Safari |
| Un TGR regionale non parte | Fuori dagli orari del TG il canale è spento (niente ●): riprova all'ora del TG |
| «Il Worker non ha ancora il telecomando / la sincronizzazione» | Nel repository: **Actions** → **Aggiorna il Worker Cloudflare** → **Run workflow** ([CLOUDFLARE.md](CLOUDFLARE.md#4-pubblica-il-worker-completo-con-github)) |
| Un preferito o un'impostazione non arriva su un altro dispositivo | Su entrambi: stesso indirizzo e token del proxy, stesso gruppo, spunta attiva; poi **⟳ Sincronizza adesso** |
| YouTube dice che la chiave non va | Controlla le restrizioni della chiave (punto 6, passo 5): sito `https://gbagliesi.github.io/*` e API YouTube Data v3 |
| Una correzione appena pubblicata non compare | **Impostazioni** → **Forza aggiornamento** (add-on, preferiti e impostazioni restano). GitHub Pages può metterci fino a 10 minuti |
| Il video parte senza audio | Il browser vuole un tocco o un tasto sullo schermo prima di far uscire l'audio |
| Volume dal telefono sull'iPad | Safari non lo permette: solo il muto, il volume si regola con i tasti dell'iPad |

In **Impostazioni → Informazioni** trovi la versione di Salotto e lo spazio
usato nella memoria del browser.
