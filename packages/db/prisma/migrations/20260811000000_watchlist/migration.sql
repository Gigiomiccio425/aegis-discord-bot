-- Utenti attenzionati: sorveglianza rafforzata senza alcuna sanzione.
--
-- Solo aggiunte, tutte annullabili: le colonne sono opzionali e l'indice è
-- parziale. Una migrazione applicata su un database con dati non deve mai
-- poter fallire a metà, ed è il motivo per cui non c'è nessun NOT NULL qui.
ALTER TABLE "UserProfile" ADD COLUMN "watchedAt" TIMESTAMP(3);
ALTER TABLE "UserProfile" ADD COLUMN "watchedBy" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "watchReason" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "watchExpiresAt" TIMESTAMP(3);

CREATE INDEX "UserProfile_guildId_watchedAt_idx" ON "UserProfile"("guildId", "watchedAt");
