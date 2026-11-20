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
