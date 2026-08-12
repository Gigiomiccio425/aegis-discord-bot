-- Due colonne che nessuno ha mai scritto né letto.
--
-- `UserProfile.dormantSince` doveva registrare il momento in cui una persona
-- tornava attiva dopo un silenzio: il rilevatore di account compromessi calcola
-- quel dato dalla data dell'ultimo messaggio, e questa colonna è rimasta vuota
-- dal primo giorno.
--
-- `AttachmentArchive.scanResult` doveva conservare l'esito dell'analisi di un
-- allegato: l'esito sta in `verdict`, e questa colonna non è mai stata
-- popolata.
--
-- Una colonna che nessuno riempie non è neutra: chi legge lo schema conclude
-- che il dato esista e ci costruisce sopra una funzione che non può funzionare.
ALTER TABLE "UserProfile" DROP COLUMN IF EXISTS "dormantSince";
ALTER TABLE "AttachmentArchive" DROP COLUMN IF EXISTS "scanResult";
