# Proxy gratuito su Cloudflare

Il proxy serve per gli stream e i siti che il browser blocca (CORS), per
esempio i canali Rai in Chrome. Gira su Cloudflare Workers, è gratuito per
l'uso personale e funziona sempre, senza computer acceso.

Servono circa 5 minuti.

## 1. Crea l'account

Vai su https://dash.cloudflare.com/sign-up e registrati (basta un'email).
Non serve un dominio né una carta di credito.

## 2. Crea il Worker

1. Nel menu a sinistra apri **Compute (Workers)** → **Workers & Pages**.
2. Clicca **Create** → **Create Worker** (modello "Hello World").
3. Come nome scrivi `salotto-proxy` e clicca **Deploy**.
4. Clicca **Edit code**.
5. Cancella tutto il codice che vedi a sinistra e incolla al suo posto il
   contenuto del file
   [`cloudflare/worker.js`](https://raw.githubusercontent.com/gbagliesi/kodi-web/main/cloudflare/worker.js)
   (aprilo, seleziona tutto, copia).
6. Clicca **Deploy** in alto a destra.

In alto vedrai l'indirizzo del Worker, simile a
`https://salotto-proxy.tuonome.workers.dev`. Copialo.

## 3. Proteggilo con un token (obbligatorio)

Senza token chiunque conosca l'indirizzo potrebbe usare il tuo proxy, per
questo il Worker **rifiuta tutte le richieste finché non imposti `TOKEN`**.

1. Crea un token casuale tutto tuo. **Non usare parole di esempio prese da
   guide o siti**: il repository è pubblico e chiunque può leggerle. Un modo
   facile:
   - **Mac / Linux**: apri il Terminale e scrivi `openssl rand -hex 24`;
   - **qualsiasi browser**: apri la console (Mac: ⌥⌘J in Chrome, ⌥⌘C in Safari)
     e scrivi
     `[...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('')`.

   Ottieni 48 caratteri come `9f3c…`. Conservalo (per esempio nel portachiavi
   o nel gestore password) perché servirà su ogni dispositivo.
2. Torna alla pagina del Worker → **Settings** → **Variables and Secrets** → **Add**.
3. Tipo **Secret**, nome `TOKEN`, valore: il token del punto 1. Clicca **Deploy**.

Il vecchio esempio che compariva qui in passato viene rifiutato dal Worker: se
lo stavi usando, cambia `TOKEN` (punto 2–3: **Edit** sul secret esistente) e
inserisci il nuovo valore in Salotto su tutti i dispositivi.

Per cambiare token in futuro (per esempio se lo hai condiviso per sbaglio)
ripeti gli stessi passi: il vecchio smette subito di funzionare.

## 4. Collegalo a Salotto

1. Apri Salotto → **Impostazioni**.
2. In **Proxy per add-on e stream** incolla l'indirizzo del Worker.
3. In **Token del proxy** incolla il token del punto 3.
4. Clicca **Salva**: deve comparire "proxy raggiungibile ✓" (se il token è
   sbagliato Salotto lo dice).

Le impostazioni sono salvate nel browser: ripeti il punto 4 su ogni
dispositivo (Mac, iPad…).

## Aggiornare il Worker

### Automatico (consigliato)

Il repository pubblica da solo `cloudflare/worker.js` sul tuo Worker ogni
volta che cambia. Va configurato una volta sola:

1. **Token API Cloudflare.** Su dash.cloudflare.com clicca l'icona del
   profilo in alto a destra → **Profile** → **API Tokens** → **Create Token**
   → **Custom token** → **Get started**.
   - Nome: `salotto-github`.
   - Permissions: **Account** → **Workers Scripts** → **Edit**.
   - Account Resources: **Include** → il tuo account.
   - **Continue to summary** → **Create Token**, poi copia il token (si vede
     una volta sola).
2. **Account ID.** Nella home del tuo account Cloudflare (oppure in
   **Workers & Pages**), nella colonna a destra c'è **Account ID**: copialo.
3. **Secret su GitHub.** Nel repository → **Settings** → **Secrets and
   variables** → **Actions** → **New repository secret**, due volte:
   - `CLOUDFLARE_API_TOKEN` = il token del punto 1;
   - `CLOUDFLARE_ACCOUNT_ID` = l'Account ID del punto 2.
4. **Prima pubblicazione.** Nel repository → **Actions** → **Aggiorna il
   Worker Cloudflare** → **Run workflow**. Deve finire con la spunta verde.

Il Worker deve chiamarsi `salotto-proxy`. Se l'hai chiamato diversamente,
aggiungi in **Settings → Secrets and variables → Actions → Variables** la
variabile `CF_WORKER_NAME` con il suo nome. Il token `TOKEN` e le variabili
già impostate su Cloudflare restano come sono.

### A mano

Apri il Worker → **Edit code**, sostituisci tutto il codice con quello di
`cloudflare/worker.js` e clicca **Deploy**. Le variabili e il token restano.

## Il proxy per un amico (tutto da GitHub, si aggiorna da solo)

Chi vuole un proxy suo può farlo senza toccare il codice: un *fork* di
questo progetto su GitHub pubblica il Worker sul suo account Cloudflare e poi,
ogni notte, lo aggiorna all'ultima versione. Non serve mai fare «Sync fork».
Servono circa 15 minuti, una volta sola.

1. **Account.** Registrati su https://github.com/signup e su
   https://dash.cloudflare.com/sign-up (gratuiti, basta un'email).
2. **Sottodominio Cloudflare.** Su Cloudflare apri **Compute (Workers)** →
   **Workers & Pages**. Se chiede di scegliere il sottodominio `workers.dev`,
   scrivine uno (per esempio il tuo nome) e conferma.
3. **Token API e Account ID.** Segui i punti 1 e 2 di
   «Aggiornare il Worker → Automatico» qui sopra: alla fine hai il token API
   Cloudflare e l'Account ID.
4. **Token del proxy.** Crea un token casuale come al punto 3.1 della guida
   (`openssl rand -hex 24`). È la «password» del tuo proxy.
5. **Fork.** Apri https://github.com/gbagliesi/kodi-web, clicca **Fork** in
   alto a destra → **Create fork**.
6. **Secret.** Nel tuo fork → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**, tre volte:
   - `CLOUDFLARE_API_TOKEN` = il token API del punto 3;
   - `CLOUDFLARE_ACCOUNT_ID` = l'Account ID del punto 3;
   - `PROXY_TOKEN` = il token del punto 4.
7. **Prima pubblicazione.** Nel fork apri la scheda **Actions** → clicca
   **I understand my workflows, go ahead and enable them** → a sinistra
   **Aggiorna il Worker Cloudflare** → **Run workflow** → **Run workflow**.
   Dopo un minuto deve comparire la spunta verde.
8. **Salotto.** L'indirizzo è `https://salotto-proxy.<sottodominio>.workers.dev`
   (lo trovi anche su Cloudflare → **Workers & Pages** → `salotto-proxy`). In
   Salotto → **Impostazioni** incolla l'indirizzo e, come token, il
   `PROXY_TOKEN`. Deve comparire «proxy raggiungibile ✓».

Da quel momento il fork pubblica ogni notte il Worker più recente di questo
progetto. Nel fork non gira nient'altro (né il sito né l'app Fire TV).
Se per 60 giorni nessuno apre il fork, GitHub sospende l'aggiornamento
notturno e manda un'email: basta aprire **Actions** e riattivarlo.

L'aggiornamento automatico vuol dire fidarsi di chi modifica questo progetto:
il Worker gira sul tuo account. Chi preferisce controllare può non creare il
fork e aggiornare **a mano** (sezione sopra) quando vuole.

## Telecomando dal cellulare

Il telecomando (menu **📱 Telecomando** di Salotto) passa dallo stesso
Worker: lo schermo e il cellulare si collegano a una "stanza" del Worker
(un Durable Object, incluso nel piano gratuito), così funzionano anche se non
sono sulla stessa rete Wi-Fi.

Come si usa il telecomando: [TELECOMANDO.md](TELECOMANDO.md).

- Con l'aggiornamento **automatico** non devi fare nulla: la GitHub Action
  pubblica il Worker già pronto per il telecomando.
- Con l'aggiornamento **a mano** incollare il codice non basta, perché serve
  anche il collegamento al Durable Object descritto in
  `cloudflare/wrangler.toml`: conviene passare all'aggiornamento automatico
  (sezione sopra) e lanciare una volta **Run workflow**.

Se Salotto dice che il Worker "non ha ancora il telecomando", nel repository
apri **Actions** → **Aggiorna il Worker Cloudflare** → **Run workflow**.

### Schermo intero dal telefono

Il tasto ⛶ del telefono esce sempre dallo schermo intero, ma per entrarci i
browser vogliono un tocco (o un tasto) sullo schermo: se serve, sullo schermo
compare «Tocca lo schermo…» e al primo tocco va a schermo intero.

Per non doverlo fare mai:

- **Mac, app di Safari nel Dock**: metti la finestra a schermo intero di macOS
  (pulsante verde o Ctrl+Cmd+F) e lasciala così: resta a schermo intero tra
  un canale e l'altro.
- **Chrome / Chromium** (Mac e Linux): una regola di Chrome permette a Salotto
  di andare a schermo intero da solo. Poi riavvia Chrome (in
  `chrome://policy` deve comparire `AutomaticFullscreenAllowedForUrls`).
  - Mac, nel Terminale:
    `defaults write com.google.Chrome AutomaticFullscreenAllowedForUrls -array "https://gbagliesi.github.io"`
  - Linux: crea `/etc/opt/chrome/policies/managed/salotto.json` (Chromium:
    `/etc/chromium/policies/managed/salotto.json`) con
    `{"AutomaticFullscreenAllowedForUrls": ["https://gbagliesi.github.io"]}`
- **Fire TV**: l'app è già sempre a schermo intero.

Il codice QR contiene la chiave dello schermo e il token del proxy: mostralo
solo a chi deve usare il telecomando. **Scollega tutti i cellulari** crea una
chiave nuova.

## Sincronizzazione tra dispositivi

Preferiti, punti di ripresa dei video, ordine degli elenchi, sincronia audio
e dei sottotitoli, add-on installati con le loro impostazioni (per esempio la
chiave API di YouTube, le playlist M3U aggiunte a «TV in diretta») e i
canali YouTube salvati, «Il mio ordine» degli elenchi e alcune opzioni passano da un Salotto all'altro
attraverso lo stesso Worker. I dati stanno in un Durable Object del tuo
account Cloudflare (piano gratuito), protetto dal TOKEN come il proxy.

- Con l'aggiornamento **automatico** non devi fare nulla: la GitHub Action
  pubblica il Worker con il collegamento `SYNC` di `cloudflare/wrangler.toml`.
  Se Salotto dice che il Worker "non ha ancora la sincronizzazione", apri
  **Actions** → **Aggiorna il Worker Cloudflare** → **Run workflow**.
- In ogni Salotto: **Impostazioni** → **Sincronizzazione tra dispositivi**.
  È attiva di serie; togli la spunta per scollegare quel dispositivo (tiene i
  suoi dati e non manda più nulla). Quando la riattivi, prende i dati degli
  altri e aggiunge i preferiti che aveva solo lui.
- **Gruppo**: i dispositivi con lo stesso gruppo (di serie `casa`) condividono
  tutto; con un gruppo diverso (per esempio `bambini`) hanno preferiti e
  impostazioni separati, sullo stesso Worker.
- Anche la pagina iniziale (📌) è la stessa su tutti i dispositivi del gruppo.
- Restano su ogni dispositivo: indirizzo e token del proxy,
  finestra mobile su Android, telecomando abbinato, add-on caricati da file.
- Se lo stesso elemento cambia su due dispositivi, vale la modifica più
  recente. Le modifiche partono dopo pochi secondi; gli altri le vedono
  quando tornano in primo piano o entro un paio di minuti
  (**⟳ Sincronizza adesso** per non aspettare).

## Da sapere

- Chromecast: la TV scarica lo stream passando dal tuo Worker. Se sulla TV
  compare solo il logo, aggiorna il codice del Worker (sezione sopra).

- Il piano gratuito include 100.000 richieste al giorno. Uno stream HLS fa
  circa una richiesta ogni 2-6 secondi, quindi bastano per molte ore di
  visione al giorno.
- Il proxy viene usato solo quando serve: se uno stream funziona
  direttamente, il video non passa da Cloudflare.
- Alcuni canali con blocco geografico (Ⓖ) controllano l'indirizzo da cui
  arriva la richiesta, che con il proxy è quello di Cloudflare. Di solito è
  un server in Italia, ma non è garantito: se un canale Ⓖ non parte nemmeno
  con il proxy, guardalo dall'iPad o con Safari, che non hanno bisogno del proxy.
