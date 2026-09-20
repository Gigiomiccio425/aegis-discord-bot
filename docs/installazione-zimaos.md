# Installazione su ZimaOS

## Deploy su ZimaOS

### 1. Prendi il codice sulla VPS

```bash
git clone https://github.com/Gigiomiccio425/aegis-discord-bot.git aegis
cd aegis
cp .env.example .env
```

Gli aggiornamenti successivi sono `git pull` seguito da una ricostruzione:

```bash
git pull && docker compose up -d --build
```

Il file `.env` non è nella repository e non viene toccato da `git pull`: resta quello della tua
macchina. È voluto — i segreti non stanno in git, e un aggiornamento non deve poterli sovrascrivere.

Genera i due segreti:

```bash
openssl rand -hex 32   # → SESSION_SECRET
openssl rand -hex 32   # → ENCRYPTION_KEY
```

Compila `.env` con token Discord, client ID e secret, i tuoi `OWNER_IDS`, una password robusta per
Postgres, e `PUBLIC_URL` (il dominio da cui raggiungerai il pannello).

### Porte e HTTPS

Il reverse proxy pubblica **780** (HTTP) e **781** (HTTPS), non 80 e 443: sono fuori dagli standard,
non entrano in conflitto con ZimaOS (che occupa la 80) né con SSH, DNS, mail o database, e restano
sotto la 1024. Il binding a porte basse funziona perché è il demone Docker a legarle, non il
processo dentro al container.

```env
HTTP_PORT=780
HTTPS_PORT=781
```

Qui c'è però un vincolo che non dipende da questo progetto e va detto chiaro: **spostandosi da 80 e
443 si perde il certificato HTTPS automatico.** Let's Encrypt verifica il dominio contattando la
porta 80 o la 443; se lì non c'è nulla, il certificato non viene emesso. Tre soluzioni, in ordine di
praticità:

| Situazione | Configurazione | Risultato |
|---|---|---|
| **Accesso via IP**, rete locale o VPN | `SITE_ADDRESS=:80` · `TLS_DIRECTIVE=` vuoto | `http://IP:780`. Nessun certificato, nessun avviso. Va benissimo se il pannello non è esposto a internet |
| **Dominio, porte non standard** | `SITE_ADDRESS=https://aegis.tuodominio.it:781` · `TLS_DIRECTIVE=tls internal` | HTTPS con certificato autofirmato. Il browser avvisa la prima volta, poi si accetta l'eccezione. Il traffico è cifrato lo stesso |
| **Dominio con certificato valido** | `SITE_ADDRESS=aegis.tuodominio.it` · `HTTP_PORT=80` · `HTTPS_PORT=443` | Certificato Let's Encrypt automatico, nessun avviso. Richiede le porte standard libere |

### Con Tailscale: privato e in HTTPS, senza aprire nulla

Se la macchina è nel tuo tailnet, questa è la soluzione migliore su ogni fronte — e risolve anche
il problema del certificato.

Lega la porta alla sola interfaccia di loopback, così dall'esterno non esiste:

```yaml
ports:
  - target: 8080
    published: '780'
    host_ip: 127.0.0.1
    protocol: tcp
```

Poi, sulla macchina, una volta sola:

```bash
tailscale serve --bg 780
```

Il pannello diventa raggiungibile da qualunque tuo dispositivo collegato al tailnet, all'indirizzo
`https://nome-macchina.tuo-tailnet.ts.net`, **con un certificato valido** emesso da Tailscale. Da
internet resta invisibile: niente porte aperte, niente firewall da configurare, niente IP da
ricordare.

```bash
tailscale serve status   # cosa sta servendo
tailscale serve off      # smetti di servirlo
```

Poi in `PUBLIC_URL` metti quell'indirizzo **senza porta** — Tailscale serve sulla 443 — e registra
lo stesso indirizzo con `/api/auth/callback` fra i redirect OAuth2.

Un avvertimento: questo funziona se Tailscale gira **sulla macchina**, installato con il pacchetto
di sistema. Se lo esegui come container senza rete host, `tailscale serve` non vede il `127.0.0.1`
dell'host e non raggiunge il pannello.

Resta anche la via del tunnel SSH, che non richiede nulla:

```bash
ssh -L 780:127.0.0.1:780 utente@IP_VPS
```

E c'è una quarta strada per il certificato, la validazione DNS: è l'unica ACME a ignorare le porte,
ma richiede una build di Caddy con il modulo del tuo provider DNS e un token API. Con Tailscale non
serve.

**`PUBLIC_URL` deve combaciare esattamente** con l'indirizzo che digiti nel browser, porta compresa:
è l'indirizzo su cui Discord rimanda dopo l'accesso OAuth2. Una porta diversa lì significa accesso
al pannello che fallisce con «stato non valido».

```env
PUBLIC_URL=http://192.168.1.50:780
```

Ricorda di aggiungere lo stesso indirizzo con `/api/auth/callback` fra i redirect OAuth2
dell'applicazione Discord.

### 2. Installa come app personalizzata

Due strade, e la differenza sta in *chi* costruisce l'immagine.

#### A. Dall'interfaccia di ZimaOS — nessun terminale

**App Store → Install a Custom App**, incolla il contenuto di
[`docker-compose.zimaos.yml`](../docker-compose.zimaos.yml).

Quel file non compila nulla: scarica immagini già pronte da GitHub Container Registry, costruite
automaticamente a ogni aggiornamento del progetto. Porta con sé anche i metadati `x-casaos`, quindi
l'app compare nella dashboard di ZimaOS con icona, nome e il collegamento al pannello.

Prima di premere installa vanno compilati i valori segnati `METTI_QUI` e `CAMBIA_QUESTA_PASSWORD`
direttamente nell'editor: l'interfaccia di ZimaOS non conosce i file `.env`, quindi le variabili
stanno inline. L'app store mostra l'elenco dei passaggi anche al momento dell'installazione.

Aggiornare significa ricreare l'app tirando di nuovo l'immagine `latest`.

#### B. Da terminale — se vuoi compilare tu

```bash
docker compose up -d --build
```

Serve il codice sul disco (il `git clone` del passaggio precedente) e qualche minuto per la prima
compilazione. È la via giusta se modifichi il codice, perché non dipende dalle immagini pubblicate.

I dati stanno in posti diversi nelle due strade: con il compose di ZimaOS finiscono in
`/DATA/AppData/aegis/`, con quello di sviluppo in volumi Docker gestiti. Non mescolare le due
installazioni sullo stesso server.

Il primo avvio compila l'immagine (qualche minuto) e applica le migrazioni del database. L'ordine è
gestito dal compose: Postgres e Redis devono essere sani, poi gira il servizio `migrate`, poi
partono bot, worker e API.

### 3. Verifica

```bash
docker compose ps          # tutti i servizi devono risultare healthy
docker compose logs -f bot # deve comparire "connesso al gateway"
curl http://localhost:8080/health
```

Apri il pannello all'indirizzo di `PUBLIC_URL` e accedi con Discord.

### Immagini pubblicate

Ogni push su `main` costruisce e pubblica l'immagine su GitHub Container Registry, per `amd64` e
`arm64`:

```
ghcr.io/gigiomiccio425/aegis-discord-bot:latest
```

È un'immagine sola per bot, API e worker: cambia solo il comando di avvio. Tre immagini identiche
al 99% sarebbero tre volte il tempo di build e tre volte lo spazio, per nessun guadagno.

Lo stesso workflow esegue controllo dei tipi, test e lint a ogni push: se qualcosa si rompe,
l'immagine non viene pubblicata.

Oltre a `latest`, ogni tag `vX.Y.Z` produce tre riferimenti:

| Tag immagine | Cosa segue |
|---|---|
| `:latest` | l'ultima build del ramo principale |
| `:1.2.3` | quella versione esatta, che non cambia mai |
| `:1.2` | l'ultima correzione della serie 1.2 |

---
### ZimaOS: `/DATA` non è il disco grande

Vale la pena saperlo **prima** di installare, perché il modo in cui si scopre è sempre lo stesso: il
bot smette di funzionare, i log dicono `No space left on device`, e l'interfaccia mostra centinaia di
giga liberi.

Su ZimaBoard e ZimaBlade `/DATA` è la **eMMC interna**. Dopo le partizioni di sistema — boot,
recovery, due slot RAUC, overlay, metadati — restano circa 17 GB utili, e lì dentro ZimaOS mette
sia le immagini Docker sia i dati delle app. Il disco da terabyte è montato altrove e resta vuoto
mentre quello si riempie: sono due filesystem diversi, e quello che si guarda non è quello che si
riempie.

Da qui la sequenza di sintomi tipica, tutti apparentemente scollegati: Postgres che non riesce a
scrivere il proprio file di lock, Redis che rifiuta ogni scrittura perché non riesce a salvare, il
pannello che risponde 500, l'App Store che non installa più niente.

**Prima di installare**, in ZimaOS: *Impostazioni → App → Migrating location*, e sposta sul disco
grande tutte e tre le voci — dati delle app, immagini Docker, database utente.

Per capire dove si è davvero:

```bash
df -h /DATA                  # se dice ~17 GB, è la eMMC
df -i /DATA                  # gli inode finiscono anche con spazio libero
findmnt -T /var/lib/docker   # dove vivono immagini e volumi
lsblk -f                     # dov'è montato il disco grande
```

Nota sul `df -h /` che mostra il 100%: su ZimaOS è normale e non è il problema. La radice è
immutabile e piccola per costruzione (circa 1,2 GB); ciò che conta è la partizione che ospita
`/var/lib/docker` e `/DATA`.

### Note specifiche di ZimaOS

- Il reverse proxy (Caddy) è **incluso nel compose**. Su ZimaOS i container avviati dall'interfaccia
  hanno nomi generati e non espongono label, il che rende scomodo un Traefik o un Nginx Proxy
  Manager esterni: farsi il proxy in casa evita il problema.
- Le porte pubblicate sono 780 e 781 proprio per non collidere con l'interfaccia di ZimaOS, che
  usa la 80. Se le vuoi cambiare, qualunque valore libero va bene: `HTTP_PORT` e `HTTPS_PORT`
  nel `.env`.
- I dati persistenti stanno nei volumi Docker `postgres_data`, `redis_data` e `app_storage`. In
  `app_storage` finiscono gli allegati archiviati: dimensionalo di conseguenza se attivi
  l'archiviazione con una retention lunga.

---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>
