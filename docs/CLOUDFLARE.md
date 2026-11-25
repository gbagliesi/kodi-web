# Il Worker Cloudflare: proxy, telecomando e sincronizzazione

Un solo Worker gratuito su Cloudflare fa tre cose per Salotto:

- **proxy** per gli stream e i siti che il browser blocca (CORS), per esempio
  i canali Rai in Chrome e sulla Fire TV, il catalogo Mediaset, le edizioni
  TGR di rainews.it;
- **telecomando dal cellulare**: lo schermo e il telefono si parlano
  attraverso il Worker, anche su reti diverse ([TELECOMANDO.md](TELECOMANDO.md));
- **sincronizzazione** di preferiti, add-on e impostazioni tra i tuoi
  dispositivi ([GUIDA.md](GUIDA.md#10-sincronizzazione-tra-dispositivi)).

Gira sempre, senza computer acceso, ed è gratuito per l'uso personale. Tutto
è protetto da un solo segreto, il **TOKEN**, che scegli tu.

Servono circa 15 minuti, una volta sola: passi da 1 a 5. Per un amico che
vuole un proxy suo, la strada più semplice è
[più sotto](#il-proxy-per-un-amico-tutto-da-github-si-aggiorna-da-solo).

## 1. Crea l'account

Vai su https://dash.cloudflare.com/sign-up e registrati (basta un'email).
Non serve un dominio né una carta di credito.

## 2. Crea il Worker

1. Nel menu a sinistra apri **Compute (Workers)** → **Workers & Pages**. Se
   chiede di scegliere il sottodominio `workers.dev`, scrivine uno (per
   esempio il tuo nome) e conferma.
2. Clicca **Create** → **Create Worker** (modello «Hello World»).
3. Come nome scrivi **`salotto-proxy`** e clicca **Deploy**.

In alto vedrai l'indirizzo del Worker, simile a
`https://salotto-proxy.<tuo-sottodominio>.workers.dev`. Copialo: è
l'indirizzo da mettere in Salotto.

Il codice vero lo pubblica GitHub al passo 4; per ora il Worker contiene solo
«Hello World».

## 3. Proteggilo con un token (obbligatorio)

Senza token chiunque conosca l'indirizzo potrebbe usare il tuo proxy e
leggere i tuoi dati sincronizzati: per questo il Worker **rifiuta tutte le
richieste finché non imposti `TOKEN`**.

1. Crea un token casuale tutto tuo. **Non usare parole di esempio prese da
   guide, chat o siti**: il repository è pubblico e chiunque può leggerle. Un
   modo facile:
   - **Mac / Linux**: apri il Terminale e scrivi `openssl rand -hex 24`;
   - **qualsiasi browser**: apri la console (Mac: ⌥⌘J in Chrome, ⌥⌘C in Safari)
     e scrivi
     `[...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('')`.

   Ottieni 48 caratteri esadecimali. Conservalo nel portachiavi o nel gestore
   password: servirà su ogni dispositivo. Non mandarlo in chat o per email.
2. Torna alla pagina del Worker → **Settings** → **Variables and Secrets** → **Add**.
3. Tipo **Secret**, nome `TOKEN`, valore: il token del punto 1. Clicca **Deploy**.

## 4. Pubblica il Worker completo con GitHub

Il codice del Worker (`cloudflare/worker.js`) e i collegamenti ai Durable
Object del telecomando e della sincronizzazione (`cloudflare/wrangler.toml`)
li pubblica una GitHub Action del repository, ogni volta che cambiano. Va
configurata una volta sola.

1. **Token API Cloudflare.** Su dash.cloudflare.com clicca l'icona del
   profilo in alto a destra → **Profile** → **API Tokens** → **Create Token**
   → **Custom token** → **Get started**.
   - Nome: `salotto-github`.
   - Permissions: **Account** → **Workers Scripts** → **Edit**.
   - Account Resources: **Include** → il tuo account.
   - **Continue to summary** → **Create Token**, poi copia il token (si vede
     una volta sola). È diverso dal TOKEN del passo 3.
2. **Account ID.** Nella home del tuo account Cloudflare (oppure in
   **Workers & Pages**), nella colonna a destra c'è **Account ID**: copialo.
3. **Secret su GitHub.** Nel repository → **Settings** → **Secrets and
   variables** → **Actions** → **New repository secret**, due volte:
   - `CLOUDFLARE_API_TOKEN` = il token del punto 1;
   - `CLOUDFLARE_ACCOUNT_ID` = l'Account ID del punto 2.
4. **Prima pubblicazione.** Nel repository → **Actions** → **Aggiorna il
   Worker Cloudflare** → **Run workflow** → **Run workflow**. Dopo un minuto
   deve comparire la spunta verde.

Se il Worker ha un nome diverso da `salotto-proxy`, aggiungi in **Settings →
Secrets and variables → Actions → Variables** la variabile `CF_WORKER_NAME`
con il suo nome. Il `TOKEN` e le variabili già impostate su Cloudflare restano
come sono.

Senza i due secret l'Action finisce comunque in verde ma non pubblica nulla.

## 5. Collegalo a Salotto

Su **ogni** dispositivo (Mac, iPad, telefono, Fire TV):

1. Apri Salotto → **Impostazioni**.
2. In **Proxy per add-on e stream** incolla l'indirizzo del Worker (passo 2).
3. In **Token del proxy** incolla il TOKEN (passo 3).
4. Clicca **Salva**: deve comparire «Salvato · proxy raggiungibile ✓».
   - «il token del proxy è sbagliato»: ricopialo;
   - «il proxy rifiuta tutto»: manca il `TOKEN` nel Worker (passo 3);
   - «il proxy non risponde»: controlla l'indirizzo.
5. In **Sincronizzazione tra dispositivi** lascia la spunta attiva: deve
   comparire «Sincronizzato alle … ✓».

Indirizzo e token restano solo su quel dispositivo (non si sincronizzano), per
questo vanno inseriti su ognuno.

## Cambiare il token

Fallo subito se il token è finito in un messaggio, in uno screenshot o in un
documento condiviso.

1. Crea un token nuovo come al passo 3.1.
2. Cloudflare → Worker → **Settings** → **Variables and Secrets** → **Edit**
   sul secret `TOKEN` → incolla il nuovo valore → **Deploy**. Il vecchio smette
   subito di funzionare.
3. Se nel repository esiste il secret GitHub `PROXY_TOKEN` (lo usano i fork
   degli amici, vedi sotto), aggiornalo con lo stesso valore, altrimenti la
   prossima pubblicazione rimetterebbe quello vecchio.
4. In Salotto, su ogni dispositivo: **Impostazioni** → **Token del proxy** →
   nuovo valore → **Salva**.
5. Il telecomando: sullo schermo apri **📱 Telecomando** e fai inquadrare di
   nuovo il codice QR dai telefoni (il QR contiene il token).

I dati sincronizzati restano: sono legati al Worker e al gruppo, non al
token.

Il token d'esempio che compariva in passato in questa guida viene rifiutato
dal Worker.

## Aggiornare il Worker

Con l'Action del passo 4 non devi fare nulla: a ogni modifica di
`cloudflare/` il Worker si aggiorna da solo. Per forzare una pubblicazione:
**Actions** → **Aggiorna il Worker Cloudflare** → **Run workflow**.

Aggiornare **a mano** (Worker → **Edit code**, incollare `cloudflare/worker.js`,
**Deploy**) aggiorna il proxy ma non crea i collegamenti ai Durable Object:
telecomando e sincronizzazione non funzionerebbero. Meglio usare l'Action.

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
3. **Token API e Account ID.** Segui i punti 1 e 2 del
   [passo 4](#4-pubblica-il-worker-completo-con-github): alla fine hai il
   token API Cloudflare e l'Account ID.
4. **Token del proxy.** Crea un token casuale come al passo 3.1
   (`openssl rand -hex 24`). È la «password» del tuo proxy.
5. **Fork.** Apri https://github.com/gbagliesi/kodi-web, clicca **Fork** in
   alto a destra → **Create fork**.
6. **Secret.** Nel tuo fork → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**, tre volte:
   - `CLOUDFLARE_API_TOKEN` = il token API del punto 3;
   - `CLOUDFLARE_ACCOUNT_ID` = l'Account ID del punto 3;
   - `PROXY_TOKEN` = il token del punto 4 (l'Action lo imposta come `TOKEN`
     del Worker).
7. **Prima pubblicazione.** Nel fork apri la scheda **Actions** → clicca
   **I understand my workflows, go ahead and enable them** → a sinistra
   **Aggiorna il Worker Cloudflare** → **Run workflow** → **Run workflow**.
   Dopo un minuto deve comparire la spunta verde.
8. **Salotto.** L'indirizzo è `https://salotto-proxy.<sottodominio>.workers.dev`
   (lo trovi anche su Cloudflare → **Workers & Pages** → `salotto-proxy`). In
   Salotto → **Impostazioni** incolla l'indirizzo e, come token, il
   `PROXY_TOKEN`. Deve comparire «proxy raggiungibile ✓».

Da quel momento il fork pubblica ogni notte il Worker più recente di questo
progetto, con il telecomando e la sincronizzazione. Nel fork non gira
nient'altro (né il sito né l'app Fire TV). Se per 60 giorni nessuno apre il
fork, GitHub sospende l'aggiornamento notturno e manda un'email: basta aprire
**Actions** e riattivarlo.

L'aggiornamento automatico vuol dire fidarsi di chi modifica questo progetto:
il Worker gira sul tuo account.

## Add-on privati e token per gli amici

Gli add-on possono stare in un repository GitHub **privato**: il Worker li
legge con un token GitHub di sola lettura e li dà solo a chi ha un token del
proxy. Il sito pubblico resta un guscio vuoto.

1. **Repository.** Su GitHub crea un repository privato (per esempio
   `salotto-addons`) con `repository.json` e una cartella per add-on, come
   `addons/` di questo progetto.
2. **Token GitHub.** https://github.com/settings/personal-access-tokens/new →
   *Repository access*: **Only select repositories** → il repository degli
   add-on; *Permissions* → *Repository* → **Contents: Read-only**. Scegli la
   scadenza più lunga e copia il token.
3. **Worker.** Cloudflare → **Workers & Pages** → `salotto-proxy` →
   **Settings** → **Variables and Secrets** → **Add**:
   - tipo **Secret**, nome `ADDONS_GITHUB_TOKEN`, valore il token GitHub;
   - solo se il repository non è `gbagliesi/salotto-addons`: tipo **Text**,
     nome `ADDONS_REPO`, valore `proprietario/nome` (ramo: `ADDONS_REF`,
     di solito non serve).
4. **Prova.** `https://salotto-proxy.<sottodominio>.workers.dev/addons/health`
   risponde `ok`.

In Salotto → **🧩 Add-on** → **Sfoglia repository** compaiono per primi gli
«add-on del Worker»: si sceglie quali installare; poi si aggiornano da soli.
Gli add-on installati dal vecchio repository pubblico passano al Worker da
soli. Gli add-on non sono un segreto assoluto: chi ha un token li può
scaricare e leggere.

### Token per gli amici

Ogni amico ha un token suo, che si revoca da solo senza toccare il tuo.

1. Crea il token: nel Terminale `openssl rand -hex 24` (almeno 16 caratteri).
2. Cloudflare → `salotto-proxy` → **Settings** → **Variables and Secrets** →
   **Add** → tipo **Secret**, nome `TOKEN_` più il nome dell'amico (per esempio
   `TOKEN_MARCO`; lettere, cifre e `_`), valore il token → **Deploy**.
3. All'amico dai l'indirizzo del Worker e il token: lo mette in Salotto →
   **Impostazioni**. Ha proxy, telecomando, add-on e sincronizzazione, ma i
   suoi preferiti stanno separati dai tuoi (e da quelli degli altri amici).

Per revocare un amico cancella il suo secret. Un secret non si può rileggere:
se un amico perde il token, crea un token nuovo con **Rotate**.

In alternativa tutti in un secret `TOKENS`, una riga `nome=token` per amico
(ma per aggiungerne uno vanno riscritte tutte le righe).

I secret degli amici non sono toccati dalle pubblicazioni del Worker: l'Action riscrive
solo `TOKEN` (con il secret GitHub `PROXY_TOKEN`, se c'è). Tutto il traffico
degli amici conta sul tuo piano gratuito (100.000 richieste al giorno).

## Telecomando dal cellulare

Il telecomando (menu **📱 Telecomando** di Salotto) passa dallo stesso
Worker: lo schermo e il cellulare si collegano a una «stanza» del Worker (un
Durable Object `RemoteRoom`, incluso nel piano gratuito), così funzionano anche
se non sono sulla stessa rete Wi-Fi. Come si usa: [TELECOMANDO.md](TELECOMANDO.md).

Se Salotto dice che il Worker «non ha ancora il telecomando», nel repository
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

Cosa passa da un dispositivo all'altro, gruppi e come scollegare un
dispositivo: [GUIDA.md, punto 10](GUIDA.md#10-sincronizzazione-tra-dispositivi).
Qui i dettagli tecnici.

- I dati stanno in un Durable Object `SyncStore` (SQLite) del tuo account
  Cloudflare, uno per **gruppo** (di serie `casa`). Lo pubblica l'Action del
  passo 4 (collegamento `SYNC` di `cloudflare/wrangler.toml`).
- Ogni richiesta (`POST /sync?token=…&group=…`) deve avere il `TOKEN`: lo
  stesso del proxy, quindi tutti i dispositivi devono avere lo stesso
  indirizzo e lo stesso token.
- I dati sono divisi in voci piccole (un preferito, un punto di ripresa, un
  add-on…). Ogni dispositivo manda solo quello che è cambiato e riceve solo
  quello che è cambiato altrove; se una voce cambia su due dispositivi vale la
  modifica più recente. Un dato che il dispositivo non è riuscito a salvare
  non viene considerato allineato e si riprova.
- Il Worker tiene per **30 giorni** ogni valore sostituito o cancellato
  (tabella `history`), così un dato perso per errore si può recuperare. Le
  voci cancellate restano segnate per 90 giorni, perché anche un dispositivo
  rimasto spento a lungo sappia che sono state tolte.
- Se Salotto dice che il Worker «non ha ancora la sincronizzazione», apri
  **Actions** → **Aggiorna il Worker Cloudflare** → **Run workflow**.

## Da sapere

- **Chromecast**: la TV scarica lo stream passando dal tuo Worker. Se sulla
  TV compare solo il logo, aggiorna il Worker (**Run workflow**).
- Il piano gratuito include 100.000 richieste al giorno. Uno stream HLS fa
  circa una richiesta ogni 2-6 secondi, quindi bastano per molte ore di
  visione al giorno. Telecomando e sincronizzazione ne usano pochissime.
- Il proxy viene usato solo quando serve: se uno stream funziona
  direttamente, il video non passa da Cloudflare. Nel lettore l'etichetta
  **Diretto / Proxy** accanto al titolo dice quale strada sta usando.
- Alcuni canali con blocco geografico (Ⓖ) controllano l'indirizzo da cui
  arriva la richiesta, che con il proxy è quello di Cloudflare. Di solito è
  un server in Italia, ma non è garantito: se un canale Ⓖ non parte nemmeno
  con il proxy, guardalo dall'iPad o con Safari, che non hanno bisogno del proxy.
- In alternativa al Worker, `node server.js` su un computer o NAS fa da proxy
  (senza telecomando né sincronizzazione): vedi il [README](../README.md#proxy-locale-con-serverjs).
