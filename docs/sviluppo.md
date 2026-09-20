# Sviluppo in locale

## Requisiti

- Docker e Docker Compose (inclusi in ZimaOS)
- Un'applicazione Discord con bot
- Facoltativi: chiave Google Safe Browsing (gratuita), credenziali Twitch, dominio con HTTPS

Per lo sviluppo in locale servono anche Node 22+ e istanze di PostgreSQL e Redis.

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
npm test         # l'intera suite, senza rete né database
npm run typecheck
```


---

<sub>[← Tutta la documentazione](README.md) · [ANGEL](../README.md)</sub>
