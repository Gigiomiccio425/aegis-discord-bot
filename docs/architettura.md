# Architettura

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
### Perché un container solo

Fino alla 1.1.1 i servizi erano quattro container che condividevano la stessa immagine: bot,
worker, pannello e migrazione. Sembrava più ordinato ed è stato un errore.

Aggiornare significava aggiornarne quattro, e bastava che uno restasse indietro perché il sistema
diventasse incomprensibile: il pannello mostrava la versione nuova, il bot faceva quello che faceva
prima, e la conclusione naturale era che la correzione non funzionasse. Succedeva sul serio, perché
l'app store di ZimaOS espande le àncore YAML quando installa: nella sua copia le righe `image:`
erano quattro e distinte, e cambiarne una non cambiava le altre.

Ora è un container solo. Dentro, un supervisore ([`docker/avvio.mjs`](../docker/avvio.mjs)) applica le
migrazioni, avvia i tre processi e li riavvia se cadono, con attesa crescente fra i tentativi. Il
prezzo è quel file; il guadagno è che una classe intera di guasti non può più capitare.

Chi preferisce separarli lo può ancora fare: basta indicare `command:` nel compose, e l'immagine
avvia il singolo processo invece del supervisore.

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

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>
