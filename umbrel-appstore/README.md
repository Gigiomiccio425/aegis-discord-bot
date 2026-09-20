# Gigio & Dany — store per umbrelOS

Il contenuto di questa cartella va nella **radice** di
[Gigio-dany-appstore](https://github.com/Gigiomiccio425/Gigio-dany-appstore), non dentro una
sottocartella:

```
Gigio-dany-appstore/
  umbrel-app-store.yml
  g-d-app-store-gd-angel/
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
remote:      path: umbrel-appstore/g-d-app-store-gd-angel/docker-compose.yml:70
```

Provato: rifiutato. E se anche si forzasse con il link di sblocco che GitHub offre, resterebbe il
problema vero: Discord analizza GitHub in cerca di token e revoca quelli che trova. Il bot
smetterebbe di collegarsi da solo, nel giro di ore, e la cura sarebbe rigenerare il token — cioè
riscrivere questo file.

Vale identico per `Gigio-dany-appstore`: la protezione è attiva su tutte le repository pubbliche.

### Quindi: un file dei segreti, scritto una volta sola

I valori **non vanno nel compose**: umbrelOS lo riscrive dal repository a ogni
aggiornamento dell'app, e quello che ci scrivi sparisce.

Vanno in un file dentro i dati dell'app, che nessun aggiornamento tocca:

```bash
ssh umbrel@umbrel.local
mkdir -p ~/umbrel/app-data/g-d-app-store-gd-angel/data/storage
nano ~/umbrel/app-data/g-d-app-store-gd-angel/data/storage/segreti.env
```

Una riga per valore, senza virgolette:

```
DISCORD_TOKEN=il.tuo.token
DISCORD_CLIENT_SECRET=il-tuo-client-secret
SESSION_SECRET=quello-di-openssl-rand-hex-32
ENCRYPTION_KEY=un-altro-di-openssl-rand-hex-32
DATABASE_URL=postgresql://angel:LA_TUA_PASSWORD@postgres:5432/angel?schema=public
```

Poi chiudilo agli altri, e riavvia l'app da umbrelOS:

```bash
chmod 600 ~/umbrel/app-data/g-d-app-store-gd-angel/data/storage/segreti.env
```

| | |
|---|---|
| Chi vince | Il file. Un valore che sta lì rende irrilevante il segnaposto nel compose |
| Cosa finisce nei log | I **nomi** letti, mai i valori, più l'elenco di quelli che mancano |
| Agli aggiornamenti | Niente da rifare: il compose cambia, il file resta |

Nello stesso file conviene mettere anche gli indirizzi, che segreti non sono ma
sono tuoi:

```
PUBLIC_URL=http://il-tuo-umbrel:780
TWITCH_PUBLIC_URL=http://il-tuo-umbrel:781
```

Senza, a ogni aggiornamento tornano a `umbrel.local` e l'accesso al pannello
smette di funzionare con un «stato non valido» che non spiega niente.

La password del database va scritta **solo** dentro `DATABASE_URL`.
`POSTGRES_PASSWORD` nel compose può restare un segnaposto per sempre: Postgres
la usa soltanto alla primissima inizializzazione del volume e poi la ignora,
quindi dopo la prima installazione conta solo quella con cui ANGEL si collega.

Finché manca qualcosa il bot parte lo stesso e lo dice: nei log compare
`ancora da compilare: DISCORD_TOKEN, …`, e il pannello resta raggiungibile per
poterlo leggere.

### E l'alternativa: ricopiare il compose vecchio?

Funziona, ma va rifatta ogni volta. umbrelOS sovrascrive il compose a ogni
aggiornamento, quindi «copio il vecchio e cambio la versione» significa
rifarlo a ogni versione, e ricordarsi quali righe. Il file dei segreti si
scrive una volta e basta.

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
