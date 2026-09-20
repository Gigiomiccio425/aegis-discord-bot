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

Da ANGEL 1.29.0 nel compose **non c'è più nessun valore sensibile**, e non deve
entrarcene. Due ragioni indipendenti, ognuna sufficiente.

**La prima: sparirebbero comunque.** umbrelOS riscrive il compose dal repository
a ogni aggiornamento. Quello che ci scrivi a mano dura fino al prossimo, poi
torna com'era — e il bot riparte senza token, senza dire perché.

**La seconda: GitHub rifiuta il push.** La protezione contro i segreti riconosce
il formato di un token Discord e blocca con `GH013` prima ancora che il file
arrivi nella repository:

```
remote: - GITHUB PUSH PROTECTION
remote:     Push cannot contain secrets
remote:   —— Discord Bot Token ——
remote:      path: umbrel-appstore/g-d-app-store-gd-angel/docker-compose.yml:70
```

Provato: rifiutato. E se anche si forzasse con il link di sblocco che GitHub
offre, resterebbe il problema vero: Discord analizza GitHub in cerca di token e
revoca quelli che trova. Il bot smetterebbe di collegarsi da solo, nel giro di
ore. Vale identico per `Gigio-dany-appstore`: la protezione è attiva su tutte le
repository pubbliche.

### Dove stanno invece

In una cartella loro, dentro i dati dell'app, che nessun aggiornamento tocca:

```
~/umbrel/app-data/g-d-app-store-gd-angel/data/segreti/
  segreti.env         i valori, una riga per valore
  postgres_password   la password del database, generata al primo avvio
```

La cartella è separata dai dati apposta: ha i permessi stretti, e il container di
Postgres la monta **in sola lettura**, perché a lui serve leggere un file, non
scriverci.

### Passo zero: la cartella deve essere tua

Le cartelle di bind-mount le crea Docker, e le crea di `root`. ANGEL gira con
un utente normale (uid 1000): se la cartella resta di `root` non ci scrive, e
la conseguenza non è piccola — senza `postgres_password` **Postgres non parte
proprio**.

Un comando, una volta sola, prima di aprire il pannello:

```bash
ssh umbrel@umbrel.local
mkdir -p ~/umbrel/app-data/g-d-app-store-gd-angel/data/segreti
sudo chown -R 1000:1000 ~/umbrel/app-data/g-d-app-store-gd-angel/data/segreti
```

Se te ne dimentichi non si rompe niente in silenzio: nei log ANGEL scrive
esattamente questo comando.

⚠️ **Solo `data/segreti`, non `data`.** Dentro `data` c'è anche `data/postgres`,
che appartiene all'utente del container di Postgres (uid 999). Cambiargli
proprietario fa rifiutare l'avvio a Postgres — «data directory has wrong
ownership» — cioè esattamente il guasto che questo comando serve a evitare.

### Cosa devi scrivere tu, e cosa no

Solo quello che nessuno può indovinare:

```bash
nano ~/umbrel/app-data/g-d-app-store-gd-angel/data/segreti/segreti.env
```

Una riga per valore, senza virgolette:

```
DISCORD_TOKEN=il.tuo.token
DISCORD_CLIENT_ID=il-tuo-client-id
DISCORD_CLIENT_SECRET=il-tuo-client-secret
PUBLIC_URL=http://il-tuo-umbrel:780
OWNER_IDS=il-tuo-id-discord
```

Poi chiudilo agli altri:

```bash
chmod 600 ~/umbrel/app-data/g-d-app-store-gd-angel/data/segreti/segreti.env
```

`SESSION_SECRET`, `ENCRYPTION_KEY`, la password del database e `DATABASE_URL`
**non servono**: sono numeri casuali, ANGEL se li genera al primo avvio e se li
salva lì dentro. Chiederteli sarebbe solo un modo di fartene sbagliare uno.

`PUBLIC_URL` segreto non è, ma va scritto lì lo stesso: è l'indirizzo di questa
macchina, e lasciato al compose tornerebbe a `umbrel.local` a ogni
aggiornamento — con l'accesso al pannello che smette di funzionare dando
«stato non valido», che non spiega niente. Stessa cosa per
`TWITCH_PUBLIC_URL=http://il-tuo-umbrel:781` se usi il bot Twitch.

### Cosa succede se manca qualcosa

Il container parte lo stesso, ma non fa partire il bot: **aspetta**.

| | |
|---|---|
| Cosa parte subito | Solo il pannello, così puoi leggere cosa manca |
| Ogni 15 secondi | Ricontrolla il file, e parte da solo appena i valori ci sono |
| Ogni 2 minuti | Ripete nei log l'elenco di quello che manca e dove prenderlo |
| Cosa finisce nei log | I **nomi**, mai i valori |

Non serve riavviare dopo aver scritto il file. Il supervisore se ne accorge.

Aspettare invece di partire è voluto: un bot senza token si riavvia in ciclo e
riempie i log di errori che assomigliano a un guasto diverso da quello vero.

### Il travaso dal vecchio container

Se i valori sono ancora nel compose — cioè **prima** di aggiornare — non serve
ricopiarli a mano:

```bash
curl -fsSL https://raw.githubusercontent.com/Gigiomiccio425/aegis-discord-bot/main/docker/segreti.sh -o segreti.sh
sh segreti.sh
```

Legge l'ambiente del container, scrive in `segreti.env` quello che trova, e dice
cosa manca. Non sovrascrive un valore già presente nel file, non copia i
segnaposto `METTI_QUI…`, e non stampa mai un valore — solo i nomi.

Eseguilo prima di aggiornare. Dopo, nel container nuovo quei valori non ci sono
più, e da lì non c'è più niente da prendere.

Se avevi già un `segreti.env` nella vecchia posizione (`data/storage`), ANGEL lo
legge lo stesso e ti dice nei log il comando per spostarlo. Nessun valore si
perde nel passaggio.

### Se la password del database è andata persa

Succede a chi aggiorna da una versione in cui la password stava nel compose:
il database esiste già con quella vecchia, e ANGEL ne genera una nuova che non
combacia. Non si recupera, ma si **cambia**, e non si perde niente — il database
resta dov'è con dentro tutto:

```bash
docker exec g-d-app-store-gd-angel_postgres_1 psql -U angel -d angel \
  -c "ALTER USER angel PASSWORD '$(cat ~/umbrel/app-data/g-d-app-store-gd-angel/data/segreti/postgres_password)'"
```

Cioè: dici a Postgres di accettare la password che ANGEL si è generato. Funziona
senza conoscere quella vecchia perché dal socket locale Postgres si fida — lo
dice lui stesso al primo avvio: «enabling trust authentication for local
connections».

`ENCRYPTION_KEY` invece non si cambia a cuor leggero: cifra i token salvati nel
database, e una chiave nuova li rende illeggibili — i canali Twitch collegati
vanno riautorizzati. Registro, provvedimenti, archivio e configurazione non sono
cifrati e non si toccano.

### E l'alternativa: ricopiare il compose vecchio?

Non serve più, e non funzionerebbe: nel compose nuovo quei campi non esistono.
Funzionava, ma andava rifatta a ogni versione ricordandosi quali righe. Il file
dei segreti si scrive una volta e basta.

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
