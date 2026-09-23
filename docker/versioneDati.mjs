import { promises as fs } from 'node:fs';
import path from 'node:path';

/* ═══════════════════════════════════════════════════════════════════════
   CON QUALE VERSIONE SONO STATI USATI I DATI L'ULTIMA VOLTA

   All'avvio ANGEL scrive in `BACKUP_DIR/VERSIONE` la versione che sta
   girando. Serve a due cose: accorgersi che c'è appena stato un
   aggiornamento — e chiedere subito una copia dei dati — e lasciare accanto
   ai backup una traccia di quale codice li ha scritti.

   ── Il primo avvio dopo un aggiornamento ────────────────────────────────

   Su umbrelOS la cartella dei backup la crea Docker, di root, e la sistema
   il container `preparasegreti` prima di finire. Ma parte **insieme** ad
   ANGEL, non prima: al primo avvio ANGEL arrivava alla cartella mentre era
   ancora di root, diceva «EACCES», e non si accorgeva dell'aggiornamento —
   quindi saltava proprio la copia che doveva fare in quel momento.

   Qui si riprova qualche volta, a qualche secondo di distanza. Costa
   un'attesa solo quando la cartella non è ancora pronta; Postgres, nello
   stesso istante, sta aspettando lo stesso container per la sua password.
   ═══════════════════════════════════════════════════════════════════════ */

export const FILE_VERSIONE = 'VERSIONE';

const attendi = (ms) => new Promise((risolvi) => setTimeout(risolvi, ms));

/** Errori che il container dei permessi può ancora risolvere. */
const diPermessi = (errore) => errore?.code === 'EACCES' || errore?.code === 'EPERM';

/**
 * Scrive la versione attuale, e dice se prima ce n'era un'altra.
 *
 * Non lancia mai: una cartella di backup inaccessibile non è un motivo per
 * non partire. Restituisce l'errore, e chi chiama decide cosa dire.
 */
export async function registraVersione(
  cartella,
  attuale,
  { tentativi = 6, attesaMs = 2000, dormi = attendi, disco = fs } = {},
) {
  const segnale = path.join(cartella, FILE_VERSIONE);

  for (let tentativo = 1; ; tentativo++) {
    try {
      await disco.mkdir(cartella, { recursive: true });
      const precedente = await disco.readFile(segnale, 'utf8').catch(() => null);
      await disco.writeFile(segnale, `${attuale}\n${new Date().toISOString()}\n`, 'utf8');

      const prima = precedente?.split('\n')[0]?.trim() || null;
      return { aggiornato: Boolean(prima && prima !== attuale), prima, errore: null, tentativo };
    } catch (errore) {
      if (diPermessi(errore) && tentativo < tentativi) {
        await dormi(attesaMs);
        continue;
      }
      return { aggiornato: false, prima: null, errore, tentativo };
    }
  }
}

/**
 * Cosa fare quando la cartella resta di qualcun altro.
 *
 * Il consiglio di prima era `chown -R` sulla «cartella dei dati dell'app»:
 * dentro c'è anche `postgres`, che appartiene a un altro utente e con il
 * proprietario cambiato rifiuta di partire. Chi lo seguiva scambiava un
 * backup mancante con un database fermo. Qui si indica solo la cartella dei
 * backup, e si dice perché non tutta `data`.
 */
export function consiglioPermessi(cartella) {
  return (
    `la cartella ${cartella} appartiene a un altro utente e ANGEL non ci può scrivere: ` +
    'le copie su disco non verranno fatte. Su umbrelOS la sistema il container ' +
    '«preparasegreti» a ogni avvio — se sei qui, non ha finito o non è partito: ' +
    '`sudo docker ps -a | grep preparasegreti`. A mano, una volta sola e SOLO quella ' +
    'cartella: sudo chown -R 1000:1000 ~/umbrel/app-data/g-d-app-store-gd-angel/data/backup. ' +
    'Non tutta `data`: dentro c\'è anche postgres, che con un altro proprietario non parte.'
  );
}
