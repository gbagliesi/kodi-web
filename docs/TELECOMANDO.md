# Telecomando dal cellulare

Il telefono diventa il telecomando di Salotto aperto su un altro schermo:
computer (Mac, Linux, Windows), iPad o Fire TV. Lo schermo e il telefono non
devono stare sulla stessa rete Wi-Fi, perché si parlano attraverso il tuo
Worker Cloudflare.

## Cosa serve

- Il **proxy Cloudflare** configurato in Salotto → Impostazioni, sullo schermo
  (guida: [CLOUDFLARE.md](CLOUDFLARE.md)).
- Il Worker aggiornato con il telecomando. Con l'aggiornamento automatico
  tramite GitHub Action succede da solo. Se Salotto dice che il Worker «non ha
  ancora il telecomando», nel repository apri **Actions** → **Aggiorna il
  Worker Cloudflare** → **Run workflow** (dettagli in
  [CLOUDFLARE.md](CLOUDFLARE.md#telecomando-dal-cellulare)).

## Collegare il telefono

1. Sullo schermo apri Salotto → **📱 Telecomando** nel menu. Sulla barra in
   basso dell'iPad in verticale si chiama «Remote». Sulla Fire TV la pagina è
   in Impostazioni → **Collega il cellulare**.
2. Inquadra il codice QR con la fotocamera del telefono e apri il link.
   Oppure copia il link e mandalo al telefono.
3. Sul telefono il pallino in alto diventa verde e sullo schermo compare
   «📱 Telecomando collegato».

Nella stessa pagina puoi dare un nome allo schermo (per esempio «Salotto Mac»
o «iPad cucina»), vedere quanti telefoni sono collegati e:

- **Spegni il telecomando**: lo schermo smette di ascoltare e resta spento
  finché non premi **Accendi il telecomando**;
- **Scollega tutti i cellulari**: crea una chiave nuova. I telefoni già
  collegati smettono di funzionare e serve un nuovo QR.

Il QR e il link contengono la chiave dello schermo e il token del proxy:
dalli solo a chi deve usare il telecomando.

## Installarlo come app

Il telecomando è un'app separata da Salotto (indirizzo `…/kodi-web/remote/`),
quindi sul telefono puoi avere installate tutte e due.

- **Android (Chrome)**: scheda **Schermi** → **📲 Installa il telecomando**,
  oppure menu ⋮ → «Installa app». L'app ritrova tutti gli schermi abbinati.
- **iPhone (Safari)**: scegli prima lo schermo, poi Condividi (□↑) →
  «Aggiungi alla schermata Home». Sull'iPhone l'app della schermata Home ha
  una memoria separata da Safari: per aggiungere altri schermi incolla il loro
  link nella scheda **Schermi**.

Se in passato avevi installato il telecomando quando stava in `remote.html` e
si confondeva con Salotto, disinstalla tutte e due le app e reinstallale. I
vecchi link e QR funzionano ancora.

## Le schede del telecomando

### 🎮 Telecomando

- In alto: canale e programma in onda, con la barra di avanzamento e il
  programma successivo.
- **■ Stop** chiude il video, **⏯** mette in pausa o riprende, **🔇** toglie o
  rimette l'audio, **⛶** entra o esce dallo schermo intero.
- **CH ▲▼** cambiano canale (tenendo premuto continuano), **＋ －** regolano il
  volume a passi del 5%.
- **Frecce e OK** funzionano come il telecomando della Fire TV:
  - nel video, con i comandi nascosti, ▲▼ cambiano canale e ◀▶ vanno indietro
    o avanti;
  - il primo **OK** apre il menu dei comandi e non mette mai in pausa;
  - con il menu aperto le frecce si muovono tra i pulsanti e OK preme quello
    scelto;
  - con l'elenco dei canali, l'info o la sincronia audio aperti sullo schermo,
    ▲▼ si muovono dentro l'elenco (la voce scelta è evidenziata) e OK la
    apre;
  - fuori dal video le frecce si muovono nei menu di Salotto e nella Guida TV.
- Tutto questo funziona anche se la finestra di Salotto non è in primo piano
  (per esempio sul Mac con un'altra app davanti): la voce scelta resta
  evidenziata e, quando torni alla finestra, il cursore è lì.
- **↩ Indietro** chiude l'elenco o l'info, poi il menu, poi il video. Fuori
  dal video torna alla pagina precedente.
- **⌂ Home**, **☰ Elenco** (l'elenco dei canali sullo schermo), **ⓘ Info**
  (il programma), **🗓 Guida** (la guida TV sullo schermo).
- **⏪ −10 s** e **⏩ +30 s**. Nei canali in diretta il secondo tasto diventa
  **LIVE** e torna alla diretta.
- **123**: un tastierino per scrivere il numero del canale.
- **Sottotitoli**: «Accendi»/«Spegni» (automatici: quelli del canale, altrimenti
  generati dal computer se lo schermo è un Mac o un PC) e «Scegli sullo
  schermo», che apre il riquadro CC del lettore.
- **Sincronia audio**: «Voce prima», «Voce dopo» e «Azzera», come il tasto A/V
  del lettore. Il valore resta salvato per quel canale.

### 📺 Canali

Le liste di canali dello schermo: le playlist dell'add-on «TV in diretta» e i
Preferiti. Mentre guardi un canale c'è anche «▶ In riproduzione». Per ogni
canale vedi il programma in onda e il successivo. Tocca un canale per
aprirlo sullo schermo, oppure **ⓘ** per vedere il programma della giornata.

### 🗓 Guida

Cosa c'è sui canali **adesso**, **dopo**, alle 13:30, 18:00, 20:30, 21:30 e
23:00, o domani alle 21:30. Tocca un programma per la descrizione e per
«Guarda» sullo schermo. **Mostra la guida sullo schermo** apre la Guida TV di
Salotto.

### 🖥 Schermi

Ogni schermo ha il suo link: il telefono li ricorda tutti.

- Il pallino è verde se Salotto è aperto su quello schermo, rosso se è spento.
- Tocca uno schermo per comandare quello. Puoi anche toccare il nome in alto.
- **▲ ▼** cambiano l'ordine dell'elenco.
- **✎** dà allo schermo un nome valido solo su questo telefono e permette di
  rimuoverlo.
- Si può aggiungere uno schermo incollando il suo link.
- In fondo ci sono la versione e **⟳ Forza aggiornamento**.

## Aggiornamenti

Il telecomando si aggiorna da solo: quando lo apri, o quando torna in primo
piano, controlla se è uscita una versione nuova di Salotto e si ricarica.
**⟳ Forza aggiornamento** svuota la cache e ricarica subito. GitHub Pages può
metterci fino a 10 minuti a mostrare una versione nuova.

## Limiti

- **Volume su iPad e iPhone**: Safari non lascia cambiare il volume a una
  pagina web, quindi funziona solo il muto. Il volume si regola con i tasti
  del dispositivo.
- **Audio bloccato**: se nessuno ha ancora toccato lo schermo, il browser può
  avviare il video senza audio. Basta un tocco sullo schermo o un tasto.
- **Schermo intero**: uscire funziona sempre. Per entrare i browser vogliono
  un tocco sullo schermo, a meno di usare la finestra a schermo intero di
  macOS o la regola di Chrome descritte in
  [CLOUDFLARE.md](CLOUDFLARE.md#schermo-intero-dal-telefono).
- **Chromecast**: mentre trasmetti alla TV, volume e sincronia audio li
  gestisce la TV.
- Lo schermo deve avere Salotto aperto. Se il computer va in stop, o l'iPad
  chiude la pagina in background, il telefono mostra lo schermo come spento.

## Come funziona (per chi sviluppa)

- `cloudflare/worker.js`: `GET /remote/ws?room=…&role=tv|remote` apre una
  WebSocket verso il Durable Object `RemoteRoom` della stanza, che passa i
  messaggi dello schermo ai telefoni e viceversa. `GET /remote/status` dice se
  lo schermo è acceso, `GET /remote/health` se il relay c'è. La stanza è un id
  casuale di 24 caratteri. Se il Worker ha `TOKEN`, serve anche `?token=`.
- `js/remote-host.js`: il lato schermo (pagina `#/remote`, comandi, stato).
- `remote/index.html`, `js/remote.js`, `css/remote.css`: il telecomando.
- Test: `node tests/remote.mjs`, con uno schermo e un telefono simulati
  collegati al relay del Worker.
