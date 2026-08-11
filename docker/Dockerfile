# ─────────────────────────────────────────────────────────────
#  Aegis — immagine unica per bot, api e worker.
#  Il servizio da avviare si sceglie con `command:` nel compose.
# ─────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/usr/local/bin
WORKDIR /app
# sharp e tesseract.js hanno binari precompilati ma servono le librerie di sistema.
# openssl serve a Prisma.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# ── Dipendenze ───────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/scanner/package.json packages/scanner/
COPY apps/bot/package.json apps/bot/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci --include=dev

# ── Build ────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN npm run db:generate \
	&& npm run build \
	&& npm prune --omit=dev

# ── Runtime ──────────────────────────────────────────────────
FROM base AS runner
# Versione dell'immagine, passata dalla CI (`v1.2.3` dal tag git). Serve al
# pannello per dire quale versione sta girando e se ne esiste una più recente:
# senza, l'unico modo di saperlo sarebbe confrontare a mano i digest.
#
# Il nome deve combaciare con quello passato in `build-args` dal workflow: se
# non combacia la build riesce lo stesso e la variabile resta vuota, quindi
# ogni immagine si dichiara «sviluppo» e il confronto fra versioni non ha più
# nulla da confrontare.
ARG ANGEL_VERSION=sviluppo
ENV ANGEL_VERSION=$ANGEL_VERSION
ENV NODE_ENV=production
# I dati persistenti (allegati archiviati, snapshot, cache OCR) vivono qui.
RUN mkdir -p /data/storage && chown -R node:node /data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
COPY --chown=node:node docker/avvio.mjs ./docker/avvio.mjs
USER node

# Un solo container fa partire tutto: migrazione, bot, worker e pannello.
# Con quattro container che condividono la stessa immagine basta che uno resti
# indietro durante un aggiornamento perché il sistema diventi incomprensibile.
# Chi preferisce separarli lo può ancora fare indicando `command:` nel compose.
CMD ["node", "docker/avvio.mjs"]
