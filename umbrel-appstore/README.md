# Gigio & Dany — store per umbrelOS

Il contenuto di questa cartella va nella **radice** di
[Gigio-dany-appstore](https://github.com/Gigiomiccio425/Gigio-dany-appstore), non dentro una
sottocartella:

```
Gigio-dany-appstore/
  umbrel-app-store.yml
  g-d-app-store-gd-angel2/
    umbrel-app.yml
    docker-compose.yml
```

Il nome della cartella dell'app **deve** cominciare con l'`id` dello store (`g-d-app-store`), ed è anche
il prefisso dei nomi dei container — quindi di `APP_HOST` dentro il compose. Rinominarla senza
cambiare `APP_HOST` produce un'app che si installa, parte, e mostra una pagina bianca.

## Installare

Su umbrelOS: **App Store → ⋯ → Community App Stores → Add**, e incolla

```
https://github.com/Gigiomiccio425/Gigio-dany-appstore
```

Compare «Gigio & Dany» con dentro ANGEL. Installa, e il pannello risponde su
`http://umbrel.local:780`.

Prima di aprirlo, su Discord in **OAuth2 → Redirects** deve esserci esattamente
`http://umbrel.local:780/api/auth/callback`. Se il tuo Umbrel non risponde a `umbrel.local`, usa il
suo indirizzo IP — nel compose, nel redirect e nel browser, tutti e tre uguali.

---

## I segreti: perché non sono qui dentro

Non è prudenza. **GitHub rifiuta il push.**

La protezione contro i segreti riconosce il formato di un token Discord e blocca con `GH013` prima
ancora che il file arrivi nella repository:

```
remote: - GITHUB PUSH PROTECTION
remote:     Push cannot contain secrets
remote:   —— Discord Bot Token ——
remote:      path: umbrel-appstore/g-d-app-store-gd-angel2/docker-compose.yml:70
```

Provato: rifiutato. E se anche si forzasse con il link di sblocco che GitHub offre, resterebbe il
problema vero: Discord analizza GitHub in cerca di token e revoca quelli che trova. Il bot
smetterebbe di collegarsi da solo, nel giro di ore, e la cura sarebbe rigenerare il token — cioè
riscrivere questo file.

Vale identico per `Gigio-dany-appstore`: la protezione è attiva su tutte le repository pubbliche.

### Quindi: una modifica, una volta

Dopo aver installato l'app da umbrelOS:

```bash
ssh umbrel@umbrel.local
nano ~/umbrel/app-data/g-d-app-store-gd-angel2/docker-compose.yml
```

Sostituisci i sei segnaposto:

| Segnaposto | Dove si prende |
|---|---|
| `METTI_QUI_IL_TOKEN` | Developer Portal → Bot → Reset Token |
| `METTI_QUI_IL_CLIENT_SECRET` | Developer Portal → OAuth2 → Client Secret |
| `METTI_QUI_openssl_rand_hex_32` | `openssl rand -hex 32` |
| `METTI_QUI_UN_ALTRO_openssl_rand_hex_32` | `openssl rand -hex 32` — **diverso dal precedente** |
| `METTI_QUI_UNA_PASSWORD` (×2) | inventala. Sta in **due punti** e devono coincidere |

Poi riavvia l'app dall'interfaccia di umbrelOS.

Finché i segnaposto sono lì il bot parte e non riesce a collegarsi: nei log compare un errore di
autenticazione di Discord, che è il modo giusto di dire «mancano le credenziali» invece di restare
in silenzio.

### E agli aggiornamenti?

umbrelOS riscrive quel file dalla repository quando aggiorni l'app, e i valori vanno rimessi. Sono
sei righe, e succede solo quando cambi versione — ma è la ragione per cui esiste anche l'altra
strada.

**Se la cosa ti dà fastidio, usa il compose a mano**: nessun segnaposto, i valori in un `.env`
accanto al file, nessuna sovrascrittura mai. Si perde la casella nell'elenco delle app, si guadagna
un'installazione che non si tocca più. Sta in [`umbrel/`](../umbrel/LEGGIMI.md).

---

## Cosa cambia rispetto alla VPS

| | ZimaOS | Umbrel |
|---|---|---|
| Pubblicazione | `ports: 780:8080` | `app_proxy` con `APP_HOST`/`APP_PORT` |
| Dati | `/DATA/AppData/Angel/…` | `${APP_DATA_DIR}/data/…` |
| Copie | `/DATA/angel-backup`, fuori dai volumi | dentro i dati dell'app — **sparisce se disinstalli** |
| Redis | `volatile-lru`, AOF acceso | `noeviction`, AOF spento |
| Nomi dei servizi | `aegis-postgres`, `aegis-redis` | `postgres`, `redis` |

Il cambio su Redis non è cosmetico. `volatile-lru` fa sfrattare le chiavi con scadenza quando la
memoria si riempie, e BullMQ lo scriveva a ogni avvio: sfrattare una chiave di coda significa
perdere un lavoro in attesa senza che nessuno se ne accorga. L'AOF acceso su un disco lento
produceva «fsync is taking too long» a ripetizione, per riguadagnare nel caso peggiore qualche
minuto di coda che i lavori periodici ricreano da soli.

Le copie sono l'altra differenza che conta. Su ZimaOS stavano fuori dai volumi apposta — perché
disinstallando l'app i volumi spariscono, e una copia che sparisce insieme a ciò che protegge non
protegge nulla. Su umbrelOS l'app scrive solo dentro `${APP_DATA_DIR}`, quindi quella garanzia non
c'è: **scarica il kit dal pannello ogni tanto** e tienilo su un'altra macchina.

---

## Aggiornare l'app

Cambia `version:` in `umbrel-app.yml` e il tag dell'immagine in `docker-compose.yml`, poi spingi.
umbrelOS se ne accorge e propone l'aggiornamento.

I due numeri vanno cambiati insieme: `version` è quello che umbrelOS mostra e confronta, il tag è
quello che scarica davvero. Cambiarne uno solo produce un aggiornamento che dice di aver funzionato
e non ha fatto niente — o il contrario, un'immagine nuova che si dichiara vecchia.
