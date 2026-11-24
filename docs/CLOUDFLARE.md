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

## 3. Proteggilo con un token

Senza token chiunque conosca l'indirizzo potrebbe usare il tuo proxy.

1. Torna alla pagina del Worker → **Settings** → **Variables and Secrets** → **Add**.
2. Tipo **Secret**, nome `TOKEN`, valore: una parola segreta inventata da te
   (es. `girasole-blu-42`). Clicca **Deploy**.
3. Facoltativo, solo se **non** usi il token: una variabile di tipo **Text**
   chiamata `ALLOWED_ORIGINS` con valore `https://gbagliesi.github.io`.
   Con il token impostato viene ignorata, perché il Chromecast scarica lo
   stream da un indirizzo Google diverso dal sito di Salotto.

## 4. Collegalo a Salotto

1. Apri Salotto → **Impostazioni**.
2. In **Proxy per add-on e stream** incolla l'indirizzo del Worker.
3. In **Token del proxy** scrivi la parola segreta del punto 3.
4. Clicca **Salva**: deve comparire "proxy raggiungibile ✓".

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

## Telecomando dal cellulare

Il telecomando (Impostazioni → **Collega il cellulare**) passa dallo stesso
Worker: lo schermo e il cellulare si collegano a una "stanza" del Worker
(un Durable Object, incluso nel piano gratuito), così funzionano anche se non
sono sulla stessa rete Wi-Fi.

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
