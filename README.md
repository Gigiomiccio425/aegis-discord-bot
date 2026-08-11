# Aegis

Bot Discord di sicurezza e moderazione con pannello di controllo web, pensato per essere
self-hosted su una VPS ZimaOS.

Fa tre cose che i bot generalisti non fanno bene: ferma gli attacchi al server (raid, nuke,
webhook e bot ostili), riconosce le campagne di truffa che circolano ora (immagini con QR,
ClickFix, inviti dirottati, account compromessi), e registra ogni azione in modo consultabile.

---

## Indice

- [Cosa protegge](#cosa-protegge)
- [Architettura](#architettura)
- [Requisiti](#requisiti)
- [Configurazione dell'applicazione Discord](#configurazione-dellapplicazione-discord)
- [Deploy su ZimaOS](#deploy-su-zimaos)
- [Aggiornare](#aggiornare)
- [Sviluppo in locale](#sviluppo-in-locale)
- [Primo avvio: cosa configurare](#primo-avvio-cosa-configurare)
- [Il pannello](#il-pannello)
- [Comandi](#comandi)
- [Comandi personalizzati e personas](#comandi-personalizzati-e-personas)
- [Il registro](#il-registro)
- [Backup, archivio e ruoli](#backup-archivio-e-ruoli)
- [Notifiche da fonti esterne](#notifiche-da-fonti-esterne)
- [Bacheca e ticket](#bacheca-e-ticket)
- [Server molto grandi: sharding](#server-molto-grandi-sharding)
- [Privacy e GDPR](#privacy-e-gdpr)
- [Limiti dichiarati](#limiti-dichiarati)
- [Risoluzione dei problemi](#risoluzione-dei-problemi)

---

## Cosa protegge

| Minaccia | Come funziona nella realtà | Difesa |
|---|---|---|
| **QR di login Discord** | Un QR che punta a `discord.com/ra/…` è il flusso Remote Auth: chi lo inquadra consegna il token del proprio account. Non serve la password, non compare alcun avviso — è Discord stessa a trasmetterlo | Ogni immagine viene decodificata; un QR di questo tipo fa scattare l'azione massima e un avviso pubblico |
| **ClickFix / finta CAPTCHA** | «Premi Win+R, Ctrl+V, Invio»: negli appunti c'è già PowerShell offuscato. +517% nel primo semestre 2025, allerta FTC di giugno 2026 | Rilevatore dedicato, attivo sia sul testo sia sull'OCR degli screenshot |
| **Ondata MrBeast / giveaway falsi** | Account veri, compromessi da infostealer, che pubblicano in massa immagini con link | Rilevamento del *cambio di comportamento* + hash percettivo delle immagini + OCR |
| **Invite hijacking** | Discord permette di rivendicare come vanity i codici invito scaduti o liberati: i link pubblicati mesi prima portano altrove | Ogni invito pubblicato viene risolto; i propri codici sono sorvegliati con allarme se si liberano |
| **Raid** | Reti di self-bot generano migliaia di account in pochi minuti; i primi 30 secondi decidono l'esito | Finestra scorrevole sui join + rilevamento di cluster simili + risposta graduata fino al lockdown |
| **Nuke** | Un amministratore compromesso o un insider cancella canali e ruoli in venti secondi | Soglie per singolo attore sul registro di controllo, rimozione immediata dei ruoli, snapshot d'emergenza |
| **Webhook ostili** | Consentono messaggi dall'aspetto ufficiale senza essere membri; usati come canale di esfiltrazione da pacchetti npm/PyPI compromessi | Inventario, allowlist, eliminazione automatica degli sconosciuti |
| **Bot di terze parti** | Un bot con Administrator equivale al server compromesso se la sua catena di fornitura viene colpita | Punteggio di rischio dei permessi, rimozione di Administrator, allarme sugli aumenti di permessi |
| **Impersonificazione dello staff** | Nickname e avatar copiati, spesso con omoglifi (`Мoderatore` con la M cirillica) | Confronto per similarità su nomi normalizzati contro lo staff reale |
| **File mascherati** | `foto.png.exe`, eseguibili rinominati, polyglot | Verifica dei magic bytes, estensione doppia, firme dentro le immagini |
| **Link raccolta IP** | Il bot non può ottenere IP, ma i link grabber postati in chat funzionano | Blocklist dei servizi noti |
| **Adescamento di minori** | Il primo passo è quasi sempre pubblico: richiesta di età, invito a spostarsi in privato, richiesta di segretezza | Rilevamento di schemi combinati, segnalazione allo staff con prove congelate, **nessuna sanzione automatica** |

Il resto — anti-spam, controllo account, verifica d'ingresso, ruoli appiccicosi — è configurabile
modulo per modulo dal pannello.

### AutoMod nativo: l'unica difesa che arriva prima del messaggio

Un bot vede un messaggio solo **dopo** che esiste; l'AutoMod di Discord lo intercetta durante
l'invio. Per il contenuto noto in anticipo — domini di phishing, termini vietati — quella manciata
di millisecondi è la differenza fra «nessuno l'ha visto» e «l'hanno letto in trenta».

Aegis tiene sincronizzate le regole native a partire dalle proprie blocklist (`/audit`, oppure dal
pannello). Gestisce solo le regole che ha creato lui, riconoscibili dal prefisso `[Aegis]`: quelle
scritte a mano dallo staff non vengono mai toccate.

Il caso più interessante è la regola sul **profilo utente** con azione `BlockMemberInteraction`:
Discord mette in quarantena chi ha un nickname vietato — «Discord Staff», «Moderatore ufficiale» —
prima ancora che possa scrivere o entrare in vocale. Nessun bot può arrivare così presto.

### Nota tecnica onesta sulle immagini

Un PNG o un JPG su Discord **non esegue codice**. Le immagini delle campagne scam sono contenitori
di *link*: testo sovrimpresso, QR, o il messaggio che le accompagna. Perciò lo scanner non cerca un
virus nei pixel — estrae ogni URL visibile o codificato, ne verifica la reputazione, e riconosce la
campagna con l'hash percettivo. Per gli **allegati non-immagine** il controllo è invece
sostanziale: magic bytes, estensione doppia, polyglot, eseguibili dentro gli archivi.

---

## Architettura

```
aegis/
├─ apps/
│  ├─ bot/       discord.js 14 — gateway, comandi, moduli di sicurezza
│  ├─ api/       Fastify 5 — REST + WebSocket + OAuth2, serve anche il pannello
│  ├─ web/       React 19 + Vite 8 + Tailwind 4 — pannello
│  └─ worker/    BullMQ 6 — OCR, backup, blocklist, retention, Twitch
├─ packages/
│  ├─ shared/    schemi Zod della configurazione, tipi, utilità di testo
│  ├─ db/        Prisma 7 (schema + client)
│  └─ scanner/   libreria pura: URL, QR, OCR, pHash, file, ClickFix
└─ docker/       Dockerfile e Caddyfile
```

Tre scelte che spiegano il resto:

- **Un solo processo parla con Discord.** Il pannello pubblica intenzioni su Redis e il bot le
  esegue. Rate limit gestiti in un punto solo, pannello riavviabile senza far cadere il gateway.
- **Gli schemi di configurazione stanno in un unico posto** (`packages/shared`). Il bot li usa per
  leggere, l'API per validare, il pannello per generare i form. Due copie divergono sempre, e la
  divergenza si scopre quando una difesa non parte.
- **Tutto ciò che è lento vive nel worker.** L'OCR costa fino a due secondi per immagine: eseguirlo
  nel processo del gateway ritarderebbe anche gli eventi dell'anti-raid, che non possono aspettare.

---

## Requisiti

- Docker e Docker Compose (inclusi in ZimaOS)
- Un'applicazione Discord con bot
- Facoltativi: chiave Google Safe Browsing (gratuita), credenziali Twitch, dominio con HTTPS

Per lo sviluppo in locale servono anche Node 22+ e istanze di PostgreSQL e Redis.

---

## Configurazione dell'applicazione Discord

1. Vai su <https://discord.com/developers/applications> e crea una nuova applicazione.
2. Sezione **Bot**: crea il bot, copia il token in `DISCORD_TOKEN`.
3. Sempre nella sezione **Bot**, attiva **tutti e tre** i *Privileged Gateway Intents*:
   - **Server Members Intent** — join, ruoli, profili
   - **Message Content Intent** — scanner dei contenuti
   - **Presence Intent** — rilevamento account compromessi

   > Devono essere accesi tutti e tre: il client li richiede in blocco e Discord, se anche uno
   > solo manca, non degrada ma chiude la connessione con `Used disallowed intents` (close code
   > 4014). Nei log compare come un riavvio in ciclo del servizio `bot`.
   >
   > Dal 10 giugno 2026 la soglia per l'approvazione non è più «100 server» ma **10.000 utenti
   > unici** raggiunti dall'app. Sotto quella soglia gli intent si attivano direttamente dal
   > Developer Portal. La verifica del bot a 100 server resta un procedimento separato, e
   > l'approvazione degli intent va rinnovata ogni anno.

4. Sezione **OAuth2**: copia *Client ID* e *Client Secret*. Aggiungi come redirect
   `https://tuodominio.it/api/auth/callback` (in locale: `http://localhost:8080/api/auth/callback`).
5. Invita il bot con questi permessi:

   ```
   https://discord.com/oauth2/authorize?client_id=IL_TUO_CLIENT_ID&scope=bot+applications.commands&permissions=1101390802102
   ```

   Corrispondono a: gestione ruoli, canali, webhook, server ed espressioni; ban, kick e timeout;
   gestione messaggi; lettura del registro di controllo; invio di messaggi, embed e allegati.
   Non è richiesto `Administrator`, e non va concesso: un bot con Administrator rende il server
   compromettibile attraverso la catena di fornitura del bot stesso.

6. **Posizione del ruolo**: sposta il ruolo del bot *sopra* tutti i ruoli su cui deve poter agire.
   Discord non consente di toccare chi ha un ruolo più alto — è il motivo più frequente per cui una
   difesa configurata correttamente non riesce ad applicare la sanzione.

---

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
[`docker-compose.zimaos.yml`](docker-compose.zimaos.yml).

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

## Aggiornare

Nel compose la versione compare **una volta sola**, in cima:

```yaml
x-image: &image 'ghcr.io/gigiomiccio425/aegis-discord-bot:latest'
```

Cambiare quella riga cambia tutti e quattro i servizi. `:latest` aggiorna a ogni ricreazione;
un tag preciso — `:1.4.0` — resta fermo finché non lo cambi tu, ed è la scelta giusta se preferisci
decidere quando aggiornare invece di scoprirlo dopo un riavvio.

### I dati restano

Nessun aggiornamento tocca i dati. Vivono nei volumi Docker, che sopravvivono alla ricreazione dei
container: registro eventi, configurazione, snapshot, archivio messaggi, casi, profili di rischio.

Lo schema del database lo allinea il servizio `aegis-migrate`, che riparte a ogni avvio ed esegue
`prisma migrate deploy`: applica solo le migrazioni mancanti e non fa nulla se sono già tutte
presenti. Bot, worker e API attendono che abbia finito prima di partire, quindi non esiste il
momento in cui il codice nuovo parla a uno schema vecchio.

### La procedura

Sulla VPS, una volta sola:

```bash
curl -O https://raw.githubusercontent.com/Gigiomiccio425/aegis-discord-bot/main/docker/aggiorna.sh
```

poi, a ogni aggiornamento:

```bash
sudo sh aggiorna.sh /DATA/aegis/docker-compose.yml
```

Lo script copia il database **prima** di toccare qualsiasi cosa, scarica l'immagine e ricrea i
container. La copia finisce in `/DATA/aegis-backup`, ne tiene le ultime dieci, e se il dump risulta
vuoto si ferma senza aggiornare: una migrazione non si annulla, e senza un dump valido tornare a
una versione precedente vorrebbe dire ripartire da zero.

A mano, se preferisci:

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d
```

### Sapere cosa sta girando

La versione è scritta nell'immagine dalla CI e compare in fondo alla colonna di sinistra del
pannello. Se su GitHub esiste una release più recente, al suo posto appare un avviso con il numero
della nuova versione e il link alle note. Il confronto lo fa l'API, con la risposta di GitHub in
cache per sei ore.

### Tornare indietro

Rimetti la versione precedente in `x-image`, `docker compose up -d`, e se quella versione aveva uno
schema diverso ripristina il dump corrispondente — il comando esatto lo stampa `aggiorna.sh` alla
fine di ogni esecuzione.

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

### Backup del database

```bash
docker compose exec postgres pg_dump -U aegis aegis | gzip > aegis-$(date +%F).sql.gz
```

Vale la pena metterlo in cron: gli snapshot del server Discord vivono dentro Postgres, quindi
perdere il database significa perdere anche i backup della struttura del server.

---

## Sviluppo in locale

```bash
npm install
npm run db:generate

# Postgres e Redis, senza il resto dello stack
docker compose up -d postgres redis

npm run db:push          # crea lo schema senza migrazioni
npm run commands:deploy  # registra i comandi slash

npm run dev:bot          # in tre terminali separati
npm run dev:api
npm run dev:web          # pannello su http://localhost:5173
npm run dev:worker
```

In sviluppo imposta `DEV_GUILD_ID`: i comandi vengono registrati solo su quella guild e sono
disponibili all'istante, invece di attendere fino a un'ora per la propagazione globale.

```bash
npm test         # 56 test su scanner e utilità di testo, senza rete né database
npm run typecheck
```

---

## Primo avvio: cosa configurare

Il bot parte con tutti i moduli **spenti**: nessuna sanzione viene applicata finché non si decide
cosa attivare. L'ordine consigliato:

1. **Registro eventi** — imposta un canale di log. Serve a vedere cosa succede prima di decidere
   cosa bloccare.
2. **Ruolo di quarantena** — crea un ruolo senza permessi, con l'accesso negato a tutti i canali,
   e indicalo nella configurazione generale. Senza, le difese non hanno dove isolare nessuno.
3. **Canale di allarme e ruolo da menzionare** — per gli eventi critici.
4. **Modalità prova** (`dryRun`) — attivala per qualche giorno: i moduli valutano e registrano tutto
   ma non sanzionano. È il modo per tarare le soglie guardando cosa *avrebbero* fatto.
5. Attiva i moduli, partendo da anti-nuke e scanner dei contenuti, che hanno pochissimi falsi
   positivi. Anti-spam e controllo account vogliono più taratura.
6. **Parola d'ordine dello staff** — impostala. Contro una voce clonata da tre secondi di audio non
   esiste rilevamento affidabile; una parola concordata in anticipo sì.
7. **Whitelist anti-nuke** — aggiungi i bot legittimi che riorganizzano canali o ruoli, altrimenti
   verranno disarmati al primo lavoro di manutenzione.

---

## Il pannello

Otto sezioni, raggiungibili da `PUBLIC_URL` dopo l'accesso con Discord:

| Sezione | Cosa contiene |
|---|---|
| **Dashboard** | Minacce bloccate, grafico degli ingressi per ora, feed live via WebSocket, incidenti recenti con riabilitazione di massa, azioni rapide (lockdown, backup) |
| **Registro eventi** | Ricerca e filtri su tutti gli eventi, paginazione a cursore, dettaglio JSON di ogni riga; ogni autore è un link alla sua scheda |
| **Scheda utente** | Profilo, rischio, provvedimenti, tempo in vocale e cronologia completa in una pagina, con il contenuto dei messaggi archiviati |
| **Provvedimenti** | Casi con filtro per stato, revoca, e **appelli in attesa** con accoglimento che revoca davvero la sanzione |
| **Sicurezza** | Inventario webhook e bot con punteggio di rischio, account a rischio, codici invito dirottabili, gestione delle firme di minaccia |
| **Backup** | Elenco snapshot con anteprima del diff prima del ripristino |
| **Archivio messaggi** | Quanto è archiviato per canale, download delle trascrizioni HTML |
| **Integrazioni** | Sondaggi con risultati in tempo reale, giveaway, menu dei ruoli |
| **Comandi e personas** | Builder delle sequenze e gestione delle personas |
| **Configurazione** | Tutti i moduli, con editor generato dagli schemi condivisi, **storico delle modifiche con ripristino** e gestione delle proprie sessioni attive |
| **Accessi al pannello** | Chi può entrare e con quale livello, con revoca che chiude anche le sessioni aperte |

I permessi del pannello sono **separati** da quelli Discord: `MANAGE_GUILD` è la condizione minima
per entrare, ma cosa si può fare dentro lo decide il ruolo assegnato (Owner / Admin / Mod / Viewer).
Amministrare un server non implica il diritto di scaricare l'archivio di tutte le conversazioni.

---

## Comandi

| Comando | Chi può usarlo | Cosa fa |
|---|---|---|
| `/ping` | tutti | Latenza e versioni |
| `/stato` | Gestisci server | Stato dei moduli e problemi da sistemare |
| `/pannello` | Gestisci server | Link al pannello |
| `/verifica-staff parola:` | tutti | Verifica se chi ti ha contattato è davvero dello staff |
| `/privacy` | tutti | Cosa registra il bot e per quanto |
| `/cancella-i-miei-dati` | tutti | Cancellazione dei propri dati (GDPR art. 17) |
| `/nota` | Modera membri | Annota un membro senza sanzionarlo, resta nella sua scheda |
| `/avverti` `/silenzia` `/rimuovi-silenzio` | Modera membri | Provvedimenti con apertura del caso |
| `/espelli` | Espelli membri | Espulsione con avviso in privato prima dell'esecuzione |
| `/bandisci` | Bandisci membri | Ban anche per ID di chi ha già lasciato · supporta ban **temporanei** (`durata: 7d`) |
| `/revoca-ban` | Bandisci membri | Revoca e chiude il caso corrispondente |
| `/pulisci` | Gestisci messaggi | Elimina messaggi recenti, con o senza filtro per utente |
| `/quarantena applica\|revoca` | Modera membri | Isola conservando i ruoli, oppure li restituisce |
| `/utente` | Modera membri | Scheda completa: rischio, storico, provvedimenti |
| `/appello invia\|miei` | tutti | Contesta un provvedimento che ti riguarda |
| `/appello elenca\|risolvi\|registra` | Modera membri | Gestione degli appelli ricevuti |
| `/scansiona contenuto:` | tutti | Analizza un link o un testo senza aprirlo |
| `/verifica pubblica\|stato` | Gestisci server | Pubblica il messaggio col pulsante di verifica |
| `/lockdown attiva\|revoca\|stato` | Gestisci server | Canali in sola lettura e inviti in pausa |
| `/panico motivo:` | Gestisci server | Blocca, salva un backup e avvisa lo staff |
| `/backup crea\|lista\|ripristina` | Amministratore | Backup della struttura del server |
| `/archivio esporta\|stato\|ricostruisci` | Gestisci messaggi | Trascrizioni HTML e ricostruzione dei messaggi |
| `/audit` | Gestisci server | Revisione di webhook, bot e inviti sorvegliati |
| `/evento crea\|lista\|annulla` | configurabile | Eventi programmati con promemoria e ruolo RSVP |
| `/sondaggio crea\|chiudi\|lista` | configurabile | Sondaggi persistenti, anche anonimi |
| `/giveaway crea\|estrai\|riestrai` | Gestisci messaggi | Giveaway con requisiti d'ingresso |
| `/ruoli-menu` | Gestisci ruoli | Menu di auto-assegnazione dei ruoli |
| `/ticket pannello\|chiudi\|aggiungi\|lista` | configurabile | Assistenza privata in canali dedicati |
| `/diagnostica` | proprietari del bot | Stato tecnico |

I ban temporanei vengono revocati davvero: un lavoro periodico controlla le scadenze ogni notte e
toglie il ban. Sondaggi, giveaway e promemoria degli eventi hanno invece un controllo al minuto —
un giveaway che dichiara «termina fra 24 ore» e si chiude con mezz'ora di ritardo è una promessa
non mantenuta.

Accogliere un appello **revoca davvero** il provvedimento (ban rimosso, silenziamento tolto,
quarantena revocata con ripristino dei ruoli), sia dal comando sia dal pannello. Un appello che
cambia solo lo stato nel registro sarebbe una formalità.

Limite dichiarato sugli appelli: chi è **bandito** non è più nel server e non può usare un comando
slash. Il suo appello deve arrivare per altra via e viene registrato dallo staff con
`/appello registra`.

---

## Comandi personalizzati e personas

Dal pannello si compongono sequenze del tipo: *questa persona dice questo, tre secondi dopo
quest'altra risponde, poi al destinatario viene assegnato un ruolo*. La sequenza diventa un comando
slash vero, utilizzabile solo da chi ha i ruoli indicati.

Il «finto utente» con nome e immagine propri è un **webhook** — è l'unico modo che Discord offre.
Aegis crea e riusa un webhook per canale, e lo registra automaticamente nella allowlist del modulo
di protezione webhook, così non viene eliminato da sé stesso.

Variabili disponibili nei testi: `{user}`, `{user.name}`, `{arg:nome}`, `{guild}`, `{channel}`,
`{count}`, `{random:a|b|c}`.

Tre vincoli, non aggirabili dal pannello:

- Una persona **non può** chiamarsi come Discord, lo staff, il supporto o un moderatore, né avere un
  nome troppo simile ai nickname reali dello staff. Sarebbe uno strumento di truffa confezionato.
- Ogni messaggio inviato da una persona resta registrato con l'ID dell'utente umano che ha lanciato
  il comando. Una persona non è mai anonimato.
- I ruoli con permessi amministrativi non sono assegnabili da un comando personalizzato: sarebbe una
  scalata di privilegi a disposizione di chiunque possa lanciarlo.

---

## Il registro

**140 tipi di evento**, tutti effettivamente emessi — un test di build lo verifica scandendo il
codice sorgente, così un tipo dichiarato non può restare muto e trasformarsi in un filtro
perennemente vuoto nel pannello.

| Categoria | Cosa viene registrato |
|---|---|
| **Messaggi** | Invio, modifica (con prima/dopo), eliminazione singola e di massa, fissaggio e rimozione dai fissati, allegati con nome e dimensione, voti nei sondaggi nativi di Discord |
| **Reazioni** | Aggiunta, rimozione, azzeramento |
| **Membri** | Ingresso e uscita, ban e revoche, espulsioni (anche quelle fatte dall'interfaccia Discord), nickname, **username e nome visualizzato**, **avatar globale e avatar specifico del server**, ruoli assegnati e rimossi uno per uno, silenziamenti, inizio e fine dei boost |
| **Voce** | Entrata, uscita, spostamento, microfono e cuffie (distinguendo la scelta dell'utente dall'imposizione del server), condivisione schermo, webcam, e un **riepilogo di fine sessione** con la durata effettiva |
| **Canali e thread** | Creazione, eliminazione, modifiche, permessi; thread creati, rinominati, bloccati, archiviati e riaperti, con entrate e uscite dei partecipanti |
| **Ruoli** | Creazione, eliminazione, modifiche, ed evidenza separata quando vengono **aggiunti permessi pericolosi** |
| **Server** | Impostazioni, emoji e sticker (creazione, rinomina, rimozione), eventi programmati con iscrizioni e disiscrizioni, stage |
| **Inviti** | Creazione, eliminazione, **quale invito ha usato chi entra**, inviti pubblicati in chat, codici a rischio dirottamento |
| **Webhook** | Creazione, **rinomina o spostamento**, eliminazione, webhook non autorizzati |
| **Moderazione** | Ogni provvedimento con il suo caso, note, pulizie, appelli aperti e decisi |
| **Sicurezza** | Raid, nuke, lockdown, quarantene, account compromessi, ogni tipo di contenuto bloccato |
| **Bot e pannello** | Comandi usati, comandi personalizzati, messaggi delle personas (con l'autore umano reale), modifiche alla configurazione, **accessi al pannello con IP**, cancellazioni GDPR |

Cosa **non** viene registrato, per scelta: `typingStart` e `presenceUpdate`. Sono decine di eventi
al minuto per membro, riempirebbero il database senza rispondere a nessuna domanda che qualcuno si
ponga davvero.

### Tre destinazioni, non una

| Destinazione | A cosa serve |
|---|---|
| **Postgres** | Ricerca e filtri del pannello, statistiche, timeline utente. Ha bisogno degli indici, quindi conviene tenerlo leggero |
| **Canali Discord** | Sorveglianza quotidiana. Gli eventi ad alta frequenza vengono accorpati (fino a 10 per messaggio); quelli critici saltano la coda |
| **File su disco** | Archivio a lungo termine. Append-only, rotazione giornaliera, `grep`-abile |

Il sink su file risolve un problema che il database non risolve bene. Con i file si può tenere
Postgres a qualche mese di retention — query veloci, backup piccoli — e conservare comunque **tutto
per anni** su disco, dove costa solo spazio. Un `grep` trova una riga di due anni fa senza che il
database si porti dietro quelle righe a ogni query.

```
storage/logs/<idServer>/2026-08-10/SECURITY.txt
storage/logs/<idServer>/2026-08-10/SECURITY.jsonl
```

TXT è leggibile a occhio e con `grep`; JSONL è analizzabile con `jq` o reimportabile. Con spazio
abbondante si tengono entrambi: sono la stessa informazione in due forme, e la scelta sbagliata si
paga anni dopo. La retention dei file è **separata** da quella del database, e `0` significa «per
sempre» — che è il valore sensato quando lo spazio non è il vincolo.

```bash
# Tutti gli eventi di sicurezza di agosto
grep -h "SECURITY_" storage/logs/*/2026-08-*/*.txt

# Cosa ha fatto un utente, in ordine
grep -rh "autore=.*(123456789012345678)" storage/logs/<idServer>/ | sort

# Con jq: i dieci eventi più gravi della settimana
cat storage/logs/<idServer>/2026-08-*/*.jsonl | jq -s 'sort_by(-.severity) | .[:10]'
```

Le scritture sono bufferizzate e svuotate a intervalli: una syscall per evento, su un server
attivo, sarebbe spreco puro. In caso di arresto improvviso si perdono al massimo gli ultimi
secondi, che sono comunque nel database.

Due note sul funzionamento:

- Alcune azioni **esistono solo nel registro di controllo** di Discord — fissare un messaggio,
  espellere qualcuno dall'interfaccia, eliminare un webhook. Il gateway non le riporta affatto, o le
  riporta senza dire chi le ha fatte. Senza il permesso `ViewAuditLog` quelle righe non compaiono.
- Gli eventi ad alta frequenza vengono accorpati prima di finire nel canale Discord (fino a 10 per
  messaggio), mentre nel database restano riga per riga. Gli eventi critici saltano la coda: durante
  un nuke i secondi contano.

---

## Backup, archivio e ruoli

Tre meccanismi distinti, che coprono cose diverse. Vale la pena tenerli separati in testa, perché
promettono cose diverse.

### 1. Struttura del server — `/backup`

Snapshot di ruoli (con permessi e posizione), canali (con gli overwrite), categorie, emoji,
sticker, impostazioni, regole AutoMod e ruoli di ogni membro. Automatico ogni notte, su richiesta,
e **d'emergenza** appena l'anti-nuke rileva qualcosa.

Il ripristino ricrea solo ciò che manca, confrontando per nome: dopo un nuke parziale, ripristinare
alla cieca farebbe più danni dell'attacco. Il pannello mostra l'anteprima prima di agire.

### 2. Ruoli dei membri — riassegnazione automatica

Due percorsi diversi:

- **Dopo un ripristino**: `/backup ripristina ruoli-membri:true` rimette ogni persona al proprio
  posto usando l'elenco salvato nello snapshot.
- **Al rientro di un singolo** (*ruoli appiccicosi*): chi esce e rientra ritrova i ruoli che aveva.
  Oltre alla comodità, chiude il trucco più banale della moderazione — uscire e rientrare per
  liberarsi di un silenziamento o di una quarantena.

In entrambi i casi i ruoli con permessi amministrativi **non** vengono mai riassegnati in
automatico, e nemmeno quelli più alti del ruolo del bot: restituire `ManageRoles` a chi rientra
sarebbe una scalata di privilegi gratuita.

### 3. Messaggi — `/archivio`

Qui va detto chiaramente: **Discord non consente di ripristinare i messaggi eliminati.** Non esiste
alcun endpoint per farlo e nessun bot può aggirarlo. Quello che Aegis può fare — e fa — è tenere
una copia mentre i messaggi passano, e poi:

- `/archivio esporta` produce una **trascrizione HTML autonoma**: nessun CSS o immagine remota,
  leggibile fra dieci anni, con i messaggi eliminati evidenziati e gli allegati elencati con il loro
  hash. Scaricabile anche dal pannello, dove non scade con la retention del canale.
- `/archivio ricostruisci` **ripubblica** i messaggi archiviati in un canale, tramite webhook.
- `/archivio stato` mostra quanto è stato archiviato, canale per canale.

La ricostruzione è dichiarata come tale e non finge di essere l'originale: un avviso in testa al
canale, il suffisso `(archivio)` sul nome di ogni autore, la data originale nel testo, e gli
allegati non ripubblicati. Una ricostruzione indistinguibile da una cronologia autentica sarebbe uno
strumento per fabbricare prove, non per conservarle.

Quanto viene archiviato dipende da `logging.messageContent`: in modalità `HASHED` o
`METADATA_ONLY` la trascrizione conterrà i metadati ma non il testo. È un compromesso deliberato fra
capacità investigativa e privacy, e va scelto consapevolmente.

---

## Notifiche da fonti esterne

Twitch, YouTube e qualunque feed RSS/Atom. Tutte funzionano leggendo un documento pubblico: niente
chiavi API, niente quote, niente token da rinnovare.

**Perché non ci sono TikTok, Instagram e X.** Non offrono un modo pubblico e stabile di leggere i
contenuti: le opzioni sarebbero scraping fragile o servizi a pagamento. Un'integrazione che si
rompe da sola dopo tre settimane è peggio della sua assenza, perché nel frattempo si smette di
controllare a mano. Dove esiste un feed RSS — e ne esistono per moltissime fonti — il modulo
generico copre già tutto.

Due protezioni che contano più della logica di pubblicazione:

- **Nessun diluvio alla prima lettura.** Un feed appena aggiunto contiene quindici elementi già
  vecchi: la prima volta si registra soltanto il più recente, senza annunciare nulla.
- **Le fonti morte si mettono in pausa da sole.** Dopo dieci errori consecutivi si smette di
  interrogarle: un feed inesistente letto ogni dieci minuti per mesi è traffico sprecato e rumore.

Il confronto per capire cosa è nuovo usa l'**identificativo**, non la data: i feed hanno date
inaffidabili — fusi sbagliati, aggiornamenti che ne cambiano il valore, elementi ripubblicati.

---

## Bacheca e ticket

**Bacheca** — i messaggi che raccolgono abbastanza reazioni finiscono in un canale dedicato.
Sembra una funzione frivola, ma sposta l'attenzione su ciò che il server vuole premiare invece che
solo su ciò che va punito. L'autovoto è disattivo per impostazione predefinita: altrimenti bastano
quattro amici e l'autore per arrivare a cinque, e la bacheca smette di dire qualcosa.

**Ticket** — assistenza privata in un canale creato al momento, non nei DM. La differenza non è di
comodità: nei DM non c'è registro, non c'è passaggio di consegne fra moderatori, e soprattutto
**nessuno può verificare chi sta scrivendo** — che è esattamente il terreno di chi si finge staff.

L'apertura passa da una finestra modale che chiede l'oggetto *prima* di creare il canale, così non
si accumula una fila di ticket vuoti intitolati «aiuto». I permessi del canale sono espliciti e non
ereditati dalla categoria: ereditarli renderebbe la riservatezza dipendente da una configurazione
altrove, che è il modo classico in cui un ticket privato smette di esserlo.

Alla chiusura viene generata la trascrizione HTML, inviata in privato a chi ha aperto il ticket e
allegata al registro; poi il canale viene eliminato dopo dieci secondi, il tempo di leggere il
messaggio di chiusura. I ticket senza attività si chiudono da soli: uno dimenticato aperto per
settimane è rumore che nasconde quelli veri.

---

## Server molto grandi: sharding

Sotto i 2500 server non serve e non va usato: una sola connessione basta, e lo sharding
aggiungerebbe solo processi da coordinare. Oltre quella soglia Discord lo impone.

È un punto d'ingresso separato, non una complicazione che pagano tutti:

```bash
node apps/bot/dist/shard.js     # invece di apps/bot/dist/index.js
```

Il numero di shard è `auto` per impostazione predefinita — dipende dal numero di server e cambia nel
tempo, sceglierlo a mano significa doverlo correggere prima o poi. Worker, API e database non
cambiano di una riga: le code e il database sono già condivisi.

---

## Privacy e GDPR

Il bot tratta dati personali: gli ID Discord sono identificatori univoci, il contenuto dei messaggi
lo è a maggior ragione. La Developer Policy di Discord richiede una privacy policy a prescindere.

Cosa offre Aegis:

- **Modalità di registrazione del contenuto** configurabile: `FULL`, `HASHED` (solo impronta, che
  riconosce i duplicati senza conservare il testo), `METADATA_ONLY`, o nessuna registrazione.
- **Retention per categoria**, applicata davvero da un lavoro notturno. Una retention dichiarata e
  non applicata è peggio di nessuna retention.
- **`/privacy`** mostra agli utenti esattamente cosa viene registrato e per quanto.
- **`/cancella-i-miei-dati`** cancella messaggi archiviati, eventi e profilo. I provvedimenti di
  moderazione restano, ma pseudonimizzati: cancellarli permetterebbe di azzerare la propria fedina
  uscendo e rientrando nel server.
- I token OAuth degli utenti del pannello sono cifrati a riposo con AES-256-GCM.

---

## Limiti dichiarati

Meglio saperli prima:

- **La cronologia dei messaggi non è ripristinabile come originale.** Discord non lo consente. Un
  backup ricostruisce ruoli, canali, permessi e impostazioni; i messaggi si possono esportare come
  trascrizione o ripubblicare come ricostruzione dichiarata (`/archivio`), ma non tornano a essere i
  messaggi originali — e l'archivio contiene solo ciò che il bot ha visto passare dopo la sua
  installazione.
- **Il bot non può leggere i messaggi privati fra utenti.** Phishing e adescamento si consumano
  soprattutto lì. Ciò che resta è intercettare il primo passo pubblico e riconoscere gli account già
  compromessi dal loro comportamento.
- **Il bot non può ottenere indirizzi IP.** L'API Discord non li espone ad alcun bot. Contro gli IP
  grabber si può solo bloccare il link postato.
- **Contro i deepfake vocali non esiste rilevamento affidabile.** Bastano tre secondi di audio per
  clonare una voce con precisione superiore al 95%. L'unica difesa pratica è la parola d'ordine.
- **L'OCR aggiunge latenza** (0,5-2s per immagine): gira nel worker, in asincrono. Un'immagine
  malevola può restare visibile qualche secondo prima di essere rimossa.
- **Google Safe Browsing ha un limite di quota** sul piano gratuito: mitigato con cache Redis e
  blocklist locali, ma su un server molto attivo può esaurirsi.
- **L'attribuzione degli inviti può sbagliare** se due persone entrano nello stesso istante: si
  basa sul confronto dei contatori, che è l'unico metodo disponibile.

---

## Risoluzione dei problemi

**Il bot è online ma non registra nulla**
Manca un canale di log. Configuralo dal pannello, sezione *Registro eventi*, oppure verifica con
`/stato` che non compaia l'avviso corrispondente.

**«Impossibile rimuovere i ruoli: il bersaglio ha una posizione superiore al bot»**
Sposta il ruolo del bot più in alto nell'elenco dei ruoli del server. È il problema numero uno.

**L'anti-nuke non scatta**
Serve il permesso *Visualizza registro di controllo*: senza, non c'è modo di sapere chi ha
cancellato cosa. Verifica con `/stato`.

**I comandi slash non compaiono**
Con `DEV_GUILD_ID` impostato sono registrati solo su quella guild. Senza, la propagazione globale
richiede fino a un'ora. Forza con `npm run commands:deploy`.

**L'accesso al pannello fallisce con «stato non valido»**
Il redirect OAuth non corrisponde. Deve essere esattamente `PUBLIC_URL` + `/api/auth/callback`,
anche per quanto riguarda `http`/`https` e la porta.

**Le notifiche Twitch non arrivano**
EventSub richiede un callback pubblico in **HTTPS**: con un `PUBLIC_URL` in http o su localhost la
sottoscrizione non viene creata e resta attivo solo il controllo periodico, più lento. Verifica
anche che `TWITCH_EVENTSUB_SECRET` sia impostato.

**Il worker consuma molta memoria**
È l'OCR: tesseract carica i modelli linguistici in memoria. Riduci le lingue in
`scanner.image.ocrLanguages` o disattiva `asyncDeepScan` se il server è piccolo.
