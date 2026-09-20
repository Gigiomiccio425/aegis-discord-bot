# Installazione su umbrelOS

Due strade. La prima è quella normale e richiede qualche clic; la seconda serve se preferisci
tenere l'app fuori dallo store.

| | App Store | A mano, via SSH |
|---|---|---|
| Aggiornamenti | umbrelOS li propone da solo | `docker compose pull` quando vuoi tu |
| Dove stanno i dati | `app-data/g-d-app-store-gd-angel/` | la cartella che scegli |
| Disinstallando | spariscono anche i dati | resta tutto |
| Quando conviene | quasi sempre | se vuoi il controllo completo dei volumi |

---

## Strada A — dallo store (consigliata)

### 1. Aggiungi lo store

**App Store → ⋯ → Community App Stores → Add**, e incolla:

```
https://github.com/Gigiomiccio425/Gigio-dany-appstore
```

Compare «Gigio & Dany» con dentro ANGEL. Installa.

### 2. Scrivi i segreti

Il `docker-compose.yml` di un'app umbrelOS **appartiene allo store**: viene riscritto dal
repository a ogni aggiornamento. Qualunque valore messo lì dentro sparirebbe al primo
aggiornamento, e nel frattempo starebbe in chiaro in un file leggibile da chiunque abbia accesso
alla macchina.

I valori vivono quindi in una cartella che gli aggiornamenti non toccano:

```bash
ssh umbrel@umbrel.local
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

Dove prendere i primi tre: [configurazione dell'applicazione Discord](configurazione.md).

### 3. Non serve altro

`SESSION_SECRET`, `ENCRYPTION_KEY` e la password del database **non vanno scritti**. Sono numeri
casuali: ANGEL se li genera al primo avvio e se li salva nella stessa cartella. Chiederteli
sarebbe solo un modo per fartene sbagliare uno — e una `ENCRYPTION_KEY` sbagliata rende
illeggibili i token già salvati nel database.

`PUBLIC_URL` segreto non è, ma va scritto lì lo stesso: è l'indirizzo di questa macchina, e
lasciato al compose tornerebbe a `umbrel.local` a ogni aggiornamento. L'accesso al pannello
fallirebbe con «stato non valido», che non spiega niente. Lo stesso indirizzo, seguito da
`/api/auth/callback`, deve stare su Discord in **OAuth2 → Redirects**.

### Cosa succede se manca qualcosa

Il container parte, ma non fa partire il bot: **aspetta**.

| | |
|---|---|
| Cosa parte subito | Solo il pannello, così puoi leggere cosa manca |
| Ogni 15 secondi | Rilegge il file, e parte da solo appena i valori ci sono |
| Ogni 2 minuti | Ripete nei log l'elenco di quello che manca e dove prenderlo |
| Cosa finisce nei log | I **nomi**, mai i valori |

Non serve riavviare dopo aver scritto il file. Aspettare invece di partire è voluto: un bot senza
token si riavvia in ciclo e riempie i log di errori che assomigliano a un guasto diverso da quello
vero.

### Dove risponde

| | |
|---|---|
| Pannello Discord | `http://umbrel.local:780`, dietro l'autenticazione di umbrelOS |
| Pannello Twitch | `http://umbrel.local:781`, diretto — serve agli streamer, che un account su questa macchina non ce l'hanno |

---

## Aggiornare da una versione precedente

### Se i valori erano nel compose

Succede a chi viene da ANGEL 1.28.x o precedenti. Travasali **prima** di aggiornare, finché sono
ancora nell'ambiente del container vecchio:

```bash
curl -fsSL https://raw.githubusercontent.com/Gigiomiccio425/aegis-discord-bot/main/docker/segreti.sh -o segreti.sh
sh segreti.sh
```

Legge l'ambiente del container, scrive in `segreti.env` quello che trova, e dice cosa manca. Non
sovrascrive un valore già presente, non copia i segnaposto `METTI_QUI…`, e non stampa mai un
valore — solo i nomi.

Dopo l'aggiornamento è tardi: nel container nuovo quei valori non ci sono più.

### Se avevi già un `segreti.env` in `data/storage`

Viene letto lo stesso, e nei log compare il comando per spostarlo nella posizione nuova. Niente si
perde nel passaggio.

### Se Postgres rifiuta l'autenticazione

Il database esiste già con la sua password, e ANGEL ne ha generata una nuova che non combacia. Un
comando le allinea, senza perdere niente:

```bash
docker exec g-d-app-store-gd-angel_postgres_1 psql -U angel -d angel \
  -c "ALTER USER angel PASSWORD '$(cat ~/umbrel/app-data/g-d-app-store-gd-angel/data/segreti/postgres_password)'"
```

Funziona senza conoscere la password vecchia perché dal socket locale Postgres si fida — lo dice
lui stesso al primo avvio: «enabling trust authentication for local connections».

> **`ENCRYPTION_KEY` non si cambia a cuor leggero.** Cifra i token salvati nel database, e una
> chiave nuova li rende illeggibili: i canali Twitch collegati vanno riautorizzati. Registro,
> provvedimenti, archivio e configurazione non sono cifrati e non si toccano.

### Reinstallare per «ripartire puliti»: no

Disinstallando l'app, `app-data` sparisce — e con essa il database. Non serve mai: il file dei
segreti sopravvive agli aggiornamenti proprio per questo.

---

## Strada B — a mano, via SSH

Sotto, umbrelOS ha Docker normale. L'app resta fuori dallo store e nessun aggiornamento di
umbrelOS la tocca.

```bash
ssh umbrel@umbrel.local
mkdir -p ~/angel && cd ~/angel

curl -fsSLO https://raw.githubusercontent.com/Gigiomiccio425/aegis-discord-bot/main/umbrel/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/Gigiomiccio425/aegis-discord-bot/main/umbrel/.env.esempio -o .env

nano .env
docker compose up -d
```

Qui i segreti stanno in `.env`, accanto al compose: il compose si può leggere, copiare e
aggiornare senza pensarci.

Passaggi completi, cartelle, trasloco e diagnostica: **[umbrel/LEGGIMI.md](../umbrel/LEGGIMI.md)**.

---

## Se qualcosa non parte

Postgres che esce in ciclo con `/segreti/postgres_password: No such file or directory` significa
che la cartella dei segreti non è scrivibile da ANGEL. Dalla 1.29.2 un container la sistema da
solo al primo avvio; su un'installazione più vecchia, una volta sola:

```bash
sudo chown -R 1000:1000 ~/umbrel/app-data/g-d-app-store-gd-angel/data/segreti
```

Solo `data/segreti`. **Non** `data`: contiene anche `data/postgres`, che appartiene a un altro
utente e con il proprietario cambiato rifiuta di partire.

Il resto: [risoluzione dei problemi](risoluzione-problemi.md).

---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>
