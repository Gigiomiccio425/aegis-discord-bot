-- Copia durevole dello stato di un lockdown in corso.
--
-- Lo stato vive in Redis, dove si reclama con SET NX. Dentro ci sono anche i
-- permessi di scrittura tolti ai ruoli per la durata del blocco, da rimettere
-- alla revoca: se Redis lo perde — uno spegnimento brusco prima che salvi su
-- disco — quei permessi non tornano più da soli. Questa tabella tiene la
-- stessa cosa in un posto che non si perde.
--
-- Una tabella nuova, che non tocca nessuna di quelle esistenti. Senza chiave
-- esterna verso "Guild", di proposito: la revoca deve poter ritrovare lo
-- stato anche se la riga del server non c'è.

-- CreateTable
CREATE TABLE "LockdownRecord" (
    "guildId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LockdownRecord_pkey" PRIMARY KEY ("guildId")
);
