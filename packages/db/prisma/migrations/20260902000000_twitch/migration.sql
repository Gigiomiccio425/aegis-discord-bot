-- Bot di chat Twitch.
--
-- Cinque tabelle che non toccano nessuna di quelle esistenti: `TwitchChannel`
-- porta un `guildId` ma **senza chiave esterna** verso `Guild`, di proposito.
-- Uno streamer può usare il bot Twitch senza avere un server Discord, e un
-- vincolo qui lo renderebbe impossibile; in cambio, togliere il bot da un
-- server non porta via la configurazione del canale Twitch collegato.
--
-- Comandi e messaggi a tempo non hanno una tabella: stanno nel JSON di
-- `TwitchChannel.config`, che e quello che il motore legge davvero. Due
-- posti per lo stesso dato divergono sempre.
--
-- `TwitchViewer` ha per chiave (canale, utente) e non l'utente: la stessa
-- persona in due canali sono due righe che non si parlano. Costa qualche byte
-- e rende impossibile per costruzione il profilo fra canali che il Developer
-- Services Agreement di Twitch vieta.

-- CreateTable
CREATE TABLE "TwitchChannel" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "ownerDiscordId" TEXT,
    "guildId" TEXT,
    "tokenEnc" TEXT,
    "refreshEnc" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenExpiresAt" TIMESTAMP(3),
    "tokenFailedAt" TIMESTAMP(3),
    "config" JSONB NOT NULL DEFAULT '{}',
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwitchChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwitchEvent" (
    "id" BIGSERIAL NOT NULL,
    "channelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "module" TEXT,
    "severity" INTEGER NOT NULL DEFAULT 0,
    "actorId" TEXT,
    "actorLogin" TEXT,
    "messageId" TEXT,
    "text" TEXT,
    "textExpiresAt" TIMESTAMP(3),
    "action" TEXT,
    "durationSec" INTEGER,
    "reason" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "TwitchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwitchViewer" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "twitchUserId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "timeouts" INTEGER NOT NULL DEFAULT 0,
    "bans" INTEGER NOT NULL DEFAULT 0,
    "trust" INTEGER NOT NULL DEFAULT 50,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,

    CONSTRAINT "TwitchViewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwitchAccess" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "twitchUserId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MODERATORE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwitchAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwitchSession" (
    "id" TEXT NOT NULL,
    "twitchUserId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "tokenEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TwitchSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwitchChannel_login_key" ON "TwitchChannel"("login");
CREATE INDEX "TwitchChannel_guildId_idx" ON "TwitchChannel"("guildId");
CREATE INDEX "TwitchChannel_enabled_idx" ON "TwitchChannel"("enabled");


-- Gli indici del registro sono quelli che il pannello interroga davvero:
-- «cosa è successo su questo canale», «solo i bandi», «tutto di questa
-- persona». Il quarto serve alla pulizia periodica del testo scaduto, che
-- senza dovrebbe leggere l'intera tabella ogni notte.
CREATE INDEX "TwitchEvent_channelId_createdAt_idx" ON "TwitchEvent"("channelId", "createdAt");
CREATE INDEX "TwitchEvent_channelId_type_idx" ON "TwitchEvent"("channelId", "type");
CREATE INDEX "TwitchEvent_actorId_idx" ON "TwitchEvent"("actorId");
CREATE INDEX "TwitchEvent_textExpiresAt_idx" ON "TwitchEvent"("textExpiresAt");

CREATE UNIQUE INDEX "TwitchViewer_channelId_twitchUserId_key" ON "TwitchViewer"("channelId", "twitchUserId");
CREATE INDEX "TwitchViewer_channelId_lastSeenAt_idx" ON "TwitchViewer"("channelId", "lastSeenAt");

CREATE UNIQUE INDEX "TwitchAccess_channelId_twitchUserId_key" ON "TwitchAccess"("channelId", "twitchUserId");
CREATE INDEX "TwitchAccess_twitchUserId_idx" ON "TwitchAccess"("twitchUserId");

CREATE INDEX "TwitchSession_twitchUserId_idx" ON "TwitchSession"("twitchUserId");
CREATE INDEX "TwitchSession_expiresAt_idx" ON "TwitchSession"("expiresAt");

-- AddForeignKey
-- CASCADE su tutte: staccare un canale porta via il suo registro, i suoi
-- comandi e i suoi spettatori. È voluto — sono dati di quello streamer, e
-- conservarli dopo che ha tolto il bot sarebbe tenere quello che non serve.
ALTER TABLE "TwitchEvent" ADD CONSTRAINT "TwitchEvent_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TwitchChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TwitchViewer" ADD CONSTRAINT "TwitchViewer_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TwitchChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TwitchAccess" ADD CONSTRAINT "TwitchAccess_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "TwitchChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
