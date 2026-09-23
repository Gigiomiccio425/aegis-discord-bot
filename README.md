<div align="center">

<img src="docs/icon.svg" width="96" alt="">

# ANGEL

**Il custode del tuo server.**

Bot Discord di sicurezza e moderazione, con pannello web. Self-hosted: gira su una tua macchina,
i dati restano lì.

[![Immagine Docker](https://github.com/Gigiomiccio425/aegis-discord-bot/actions/workflows/docker.yml/badge.svg)](https://github.com/Gigiomiccio425/aegis-discord-bot/actions/workflows/docker.yml)
[![Licenza](https://img.shields.io/badge/licenza-AGPL--3.0-blue)](LICENSE)
![Node](https://img.shields.io/badge/node-22-green)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

[Installazione](#installazione) · [Cosa ferma](#cosa-ferma) · [Documentazione](#documentazione) · [Sicurezza](SECURITY.md)

</div>

---

## Cosa fa

Tre cose che i bot generalisti non fanno bene:

1. **Ferma gli attacchi al server** — raid, nuke, webhook e bot ostili.
2. **Riconosce le truffe che circolano adesso** — immagini con QR, ClickFix, inviti dirottati,
   account compromessi.
3. **Registra ogni azione in modo consultabile** — con le prove congelate, non solo una riga di log.

Dentro c'è anche un **bot di chat Twitch** completo, con un pannello suo pensato per essere dato
agli streamer.

Il bot parte con **tutti i moduli spenti**. Si accendono dal pannello, e conviene tenere la
modalità prova accesa per qualche giorno prima di far sanzionare qualcuno davvero.

---

## Cosa ferma

| Minaccia | Cosa succede nella realtà | Difesa |
|---|---|---|
| **QR di login Discord** | Un QR verso `discord.com/ra/…` è il flusso Remote Auth: chi lo inquadra consegna il token del proprio account. Nessuna password, nessun avviso | Ogni immagine viene decodificata; azione massima e avviso pubblico |
| **ClickFix / finta CAPTCHA** | «Premi Win+R, Ctrl+V, Invio»: negli appunti c'è già PowerShell offuscato | Rilevatore dedicato, sul testo e sull'OCR degli screenshot |
| **Raid** | Migliaia di account in pochi minuti; i primi 30 secondi decidono l'esito | Finestra scorrevole sui join, cluster simili, risposta graduata fino al lockdown |
| **Nuke** | Un admin compromesso cancella canali e ruoli in venti secondi | Soglie per singolo attore, rimozione immediata dei ruoli, snapshot d'emergenza |
| **Invite hijacking** | I codici invito liberati si possono rivendicare: i link pubblicati mesi prima portano altrove | Ogni invito viene risolto; i propri codici sorvegliati |
| **Webhook ostili** | Messaggi dall'aspetto ufficiale senza essere membri | Inventario, allowlist, eliminazione degli sconosciuti |
| **Impersonificazione dello staff** | Nickname e avatar copiati, spesso con omoglifi (`Мoderatore` con la M cirillica) | Confronto per similarità contro lo staff reale |
| **Adescamento di minori** | Il primo passo è quasi sempre pubblico | Schemi combinati, segnalazione allo staff con prove congelate, **nessuna sanzione automatica** |

L'elenco completo, con il ragionamento dietro ogni difesa: **[docs/sicurezza.md](docs/sicurezza.md)**.

---

## Il bot Twitch

Un secondo bot dentro lo stesso container. Non è l'integrazione che annuncia le dirette su
Discord: è un **bot di chat Twitch** completo, che modera la chat e fa quello che fa un bot di
chat.

**Cosa riconosce.** Venditori di visualizzatori (anche scritti `Ch̍eap Vi̇ewers` per aggirare i
filtri), link truffa, finte carte regalo Steam, wallet drainer, chi si spaccia per lo streamer,
ondate coordinate. E poi messaggi a tempo, comandi personalizzati, saluti.

**Cinque livelli invece di trenta soglie.** Osserva · Leggero · Normale · Alto · Blindato. Una
scelta sola imposta tutto; toccare un campo porta a «personalizzato» e nessun preset lo tocca più.
Cambiare livello non cancella timer, comandi e domini ammessi.

**Condivide con il bot Discord** la lista delle parole vietate — una parola aggiunta da una parte
vale anche dall'altra, perché non ci sono due liste — le blocklist dei domini aggiornate ogni sei
ore, la normalizzazione del testo e i modelli con i segnaposto. In direzione opposta, ogni azione
finisce in un canale Discord come embed colorato per gravità.

**Pannello su una porta separata** (781), fatto per essere esposto: sono gli streamer a doverlo
raggiungere per collegare il proprio canale da soli. Il pannello Discord contiene i dati di ogni
server e resta dietro Tailscale — due porte, due platee, e aprire la seconda non apre la prima.

**Funziona anche senza pannello.** `!angel livello alto`, `!angel scudo on`, `!angel permetti
discord.gg` si scrivono in chat. Se cade il database, il bot riparte da una copia su disco dei
canali e continua a moderare, rispondere e registrare su file.

Minacce, architettura, obblighi dei termini di servizio di Twitch, installazione:
**[docs/twitch.md](docs/twitch.md)**.

---

## Installazione

### umbrelOS — dallo store

**App Store → ⋯ → Community App Stores → Add**, e incolla:

```
https://github.com/Gigiomiccio425/Gigio-dany-appstore
```

Poi scrivi cinque righe nel file dei segreti. Guida completa:
**[docs/installazione-umbrel.md](docs/installazione-umbrel.md)**.

### ZimaOS, o qualunque Docker

```bash
git clone https://github.com/Gigiomiccio425/aegis-discord-bot.git
cd aegis-discord-bot
cp .env.example .env && nano .env
docker compose -f docker-compose.zimaos.yml up -d
```

Guida completa: **[docs/installazione-zimaos.md](docs/installazione-zimaos.md)**.

### Immagini pubblicate

```
ghcr.io/gigiomiccio425/aegis-discord-bot:latest
ghcr.io/gigiomiccio425/aegis-discord-bot:1.31
ghcr.io/gigiomiccio425/aegis-discord-bot:1.32.0
```

`1.31` segue l'ultima correzione di quella serie; la versione intera resta ferma. Nel compose
conviene la versione intera: un aggiornamento che non hai deciso tu è il modo più facile per non
capire cosa è cambiato.

---

## Documentazione

| | |
|---|---|
| **[Sicurezza](docs/sicurezza.md)** | Ogni minaccia riconosciuta, e come |
| **[Installazione su umbrelOS](docs/installazione-umbrel.md)** | Store, segreti, aggiornamenti |
| **[Installazione su ZimaOS](docs/installazione-zimaos.md)** | Compose, porte, HTTPS, Tailscale |
| **[Configurazione](docs/configurazione.md)** | Applicazione Discord, primo avvio, ruoli |
| **[Il pannello](docs/pannello.md)** | Cosa si fa dal web, e chi può entrare |
| **[Comandi](docs/comandi.md)** | Elenco completo, permessi, personas |
| **[Il registro](docs/registro.md)** | Cosa viene scritto, dove, per quanto |
| **[Backup e trasloco](docs/backup-e-trasloco.md)** | Copie, archivio messaggi, cambio macchina |
| **[Il bot Twitch](docs/twitch.md)** | Il secondo bot, e il suo pannello |
| **[Architettura](docs/architettura.md)** | Come è fatto dentro, e perché |
| **[Aggiornare](docs/aggiornare.md)** | Versioni, rollback, cosa resta |
| **[Sviluppo in locale](docs/sviluppo.md)** | Requisiti, stack di sviluppo |
| **[Altre funzioni](docs/funzioni.md)** | Notifiche esterne, bacheca, ticket |
| **[Privacy e limiti](docs/privacy.md)** | GDPR, e cosa ANGEL **non** sa fare |
| **[Risoluzione dei problemi](docs/risoluzione-problemi.md)** | Quando qualcosa non parte |

---

## Architettura in una riga

Un solo container fa girare cinque processi — migrazione, bot Discord, worker, pannello, bot
Twitch — con un supervisore che li tiene in vita. Accanto: Postgres e Redis.

```
┌─ angel ──────────────────────────────────┐
│  avvio.mjs                               │      ┌──────────┐
│  ├─ migrate   ├─ bot   ├─ worker         │─────▶│ Postgres │
│  ├─ api      (pannello, :780)            │      └──────────┘
│  └─ twitch   (pannello streamer, :781)   │      ┌──────────┐
└──────────────────────────────────────────┘─────▶│  Redis   │
                                                  └──────────┘
```

Perché uno solo e non cinque: **[docs/architettura.md](docs/architettura.md)**.

---

## Sul nome

Il progetto si chiamava Aegis. Restano `aegis` il nome del database, dei container, dei volumi e
dell'immagine su ghcr: rinominarli significherebbe ricreare il database e perdere tutto ciò che
contiene, per un guadagno puramente estetico. Sono nomi che nessuno digita e che nessun utente
vede.

---

## Contribuire

Segnalazioni e proposte: [issue](https://github.com/Gigiomiccio425/aegis-discord-bot/issues).
Prima di aprire una pull request, leggi **[CONTRIBUTING.md](CONTRIBUTING.md)**.

Hai trovato una vulnerabilità? **Non aprire una issue** — leggi **[SECURITY.md](SECURITY.md)**.

## Licenza

[AGPL-3.0](LICENSE). Se lo fai girare come servizio per altri, il codice modificato va reso
disponibile.
