# ANGEL su Umbrel

Umbrel non ha il «incolla un compose» di ZimaOS. Le app si installano dallo store, e lo store
prende i file da una repository git — che per un bot con dentro un token Discord e una chiave di
cifratura è la strada sbagliata: i segreti finirebbero in git, oppure in file che Umbrel riscrive a
ogni aggiornamento dell'app.

Quindi si installa **a mano via SSH**, in una cartella propria. Sotto, Umbrel ha Docker normale:
`docker compose up -d` funziona, l'app resta fuori dallo store e nessun aggiornamento di umbrelOS la
tocca.

---

## Prima di cominciare

Accendi SSH: nell'interfaccia di Umbrel, **Settings → Advanced Settings → SSH**. Poi dal tuo PC:

```bash
ssh umbrel@umbrel.local
```

Verifica che le due porte siano libere — se qualcosa risponde, cambiale nel compose e in `.env`:

```bash
sudo ss -lntp | grep -E ':(780|781)\b' || echo "libere"
```

---

## Installazione

```bash
mkdir -p ~/angel && cd ~/angel

curl -fsSLO https://raw.githubusercontent.com/Gigiomiccio425/aegis-discord-bot/main/umbrel/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/Gigiomiccio425/aegis-discord-bot/main/umbrel/.env.esempio -o .env

nano .env          # compila: le istruzioni sono dentro il file
docker compose up -d
```

La prima partenza scarica le immagini e applica le migrazioni del database: un paio di minuti.
Per guardarla:

```bash
docker compose logs -f angel
```

Quando compare `API avviata`, il pannello risponde su **http://umbrel.local:780**.

---

## Prima di aprirlo

Su Discord, in **OAuth2 → Redirects**, aggiungi esattamente:

```
http://umbrel.local:780/api/auth/callback
```

Deve combaciare **carattere per carattere** con `PUBLIC_URL`, porta compresa. Se non combacia
l'accesso fallisce con «stato non valido», e non c'è nient'altro che lo spieghi.

Se `umbrel.local` non risolve dal tuo PC, usa l'indirizzo IP — in `.env`, nel redirect e nel
browser, tutti e tre uguali.

Poi invita il bot e **sposta il suo ruolo in cima alla lista dei ruoli**: Discord non consente di
agire su chi sta più in alto, ed è il motivo più frequente per cui una difesa non riesce a
sanzionare.

---

## Dove finiscono i dati

```
~/angel/
  docker-compose.yml
  .env               ← i segreti. Non copiarlo in giro
  dati/
    postgres/        il database
    redis/           code e cache
    storage/         allegati archiviati, trascrizioni dei ticket
  copie/             le copie notturne, e i kit di trasloco
```

`copie/` sta **fuori** da `dati/` di proposito: cancellando la cartella dei dati per rifare
l'installazione, le copie restano. Su Umbrel non è una precauzione teorica — è la cartella che si
tocca per prima quando qualcosa non parte.

Metti `~/angel` sul disco grande se ne hai uno: su Umbrel la scheda SD o il disco di sistema si
riempie in fretta, e Postgres che non riesce a scrivere il proprio file di lock è un guasto che
sembra tutt'altro.

---

## Aggiornare

Una riga sola, in `docker-compose.yml`:

```bash
cd ~/angel
nano docker-compose.yml       # cambia il numero dopo aegis-discord-bot:
docker compose pull && docker compose up -d
```

Il bot fa una copia di sicurezza da solo appena si accorge che la versione è cambiata. Per una
copia *prima* che le migrazioni tocchino lo schema — che è quella che serve per tornare indietro —
usa lo script:

```bash
sudo sh docker/aggiorna.sh ~/angel/docker-compose.yml 1.27.2
```

---

## Traslocare qui da un'altra macchina

Sulla macchina vecchia, pannello → **Backup** → **Prepara il trasloco**. Poi:

```bash
# dal tuo PC
scp -r utente@vecchia:/DATA/angel-backup/trasloco-* umbrel@umbrel.local:~/angel/copie/
```

Su Umbrel, in `.env`: riporta i valori di `TRASLOCO.txt` — **`ENCRYPTION_KEY` identica**, altrimenti
i token delle integrazioni restano illeggibili — cambia `PUBLIC_URL` e `TWITCH_PUBLIC_URL` con i
nuovi indirizzi, poi togli il cancelletto a:

```
RESTORE_FROM=/backup/trasloco-2026-09-02T22-40-00
```

`docker compose up -d`, e quando ha finito rimetti il cancelletto.

**Spegni il bot sulla macchina vecchia prima di accenderlo qui.** Due processi collegati allo stesso
token si contendono il gateway: Discord ne fa cadere uno di continuo, e ogni sanzione rischia di
essere applicata due volte.

I dettagli completi stanno in [TRASLOCO nel README](../README.md#traslocare-su-unaltra-macchina).

---

## Il pannello Twitch

Il pannello Discord contiene i dati di ogni server dove il bot è presente: resta sulla rete di casa.
Quello Twitch è il contrario — sono gli streamer a doverlo raggiungere per collegare il proprio
canale, quindi va esposto.

La strada pulita è un **tunnel Cloudflare** su un sottodominio: dà HTTPS senza aprire porte sul
router, e `TWITCH_PUBLIC_URL` diventa `https://twitch.tuodominio.it`. Umbrel ha l'app *Cloudflare
Tunnel* nello store; in alternativa `cloudflared` gira come container accanto a questo.

Aprire la 781 sul router funziona ma serve HTTP in chiaro, e un pannello che chiede un accesso
Twitch senza HTTPS insegna agli streamer un'abitudine pericolosa.

---

## Se qualcosa non va

```bash
docker compose ps                    # chi è vivo
docker compose logs --tail 80 angel  # perché non lo è
```

| Sintomo | Causa quasi sempre |
|---|---|
| Il bot riparte in ciclo, «Used disallowed intents» | Mancano i tre Privileged Gateway Intents nel Developer Portal |
| Il pannello dice «stato non valido» | `PUBLIC_URL` e il redirect OAuth2 non combaciano — controlla la porta e `http` contro `https` |
| Postgres non parte, «No space left on device» | Disco pieno **o inode finiti**: `df -h ~/angel` e `df -i ~/angel` dicono cose diverse |
| Il pannello si apre ma dice che il database non risponde | Postgres è morto: i suoi log lo spiegano. Il pannello parte lo stesso apposta, per poter dire cosa non va |
| Il bot Twitch resta spento | Mancano `TWITCH_BOT_*` — sono le credenziali dell'account, non dell'applicazione |

`/salute` in Discord risponde con database, Redis, spazio libero, inode e versione di ciascun
processo: è il primo posto dove guardare, e funziona anche quando il pannello no.

---

## Perché non un'app dello store

Si potrebbe fare — serve una *Community App Store*, cioè una repository git con `umbrel-app.yml` e
un `docker-compose.yml` che parli con `app_proxy`. Il problema non è tecnico: è che le variabili di
un'app dello store vivono in file che Umbrel rigenera dalla repository a ogni aggiornamento, e
`DISCORD_TOKEN` e `ENCRYPTION_KEY` finirebbero o in git o in un file destinato a essere
sovrascritto.

Il giorno in cui ANGEL saprà configurarsi dal proprio pannello dopo il primo avvio, l'app dello
store diventa la strada giusta. Finché il token serve *per partire*, non lo è.
