/* ═══════════════════════════════════════════════════════════════════════
   COPIA DI SICUREZZA DEI PROPRI DATI

   Esporta l'intero database e l'inventario dello storage in una cartella
   separata, pensata per stare **fuori** dal volume dell'applicazione.

   Il caso che risolve è preciso: disinstallando l'app da ZimaOS spariscono i
   container, e chi conferma la rimozione dei volumi perde tutto — registro di
   anni, configurazione, archivio dei messaggi, provvedimenti. Nessun errore
   avvisa prima, perché dal punto di vista di Docker non è un errore.

   Il formato è NDJSON: una riga per record, leggibile con `grep`, importabile
   con qualunque cosa. Un dump binario di Postgres sarebbe più compatto ma
   richiederebbe la stessa versione di Postgres per essere riletto, e fra due
   anni quella versione sarà un problema in più proprio nel momento peggiore.

   La copia è **completa e non incrementale**. Con qualche decina di migliaia
   di eventi occupa pochi megabyte, e un backup incrementale che sbaglia un
   collegamento è peggio di nessun backup: sembra esserci e non si può usare.
   ═══════════════════════════════════════════════════════════════════════ */

import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { getPrisma } from '@angel/db';
import { logger } from '../logger.js';

/**
 * Tabelle esportate, in ordine di dipendenza.
 *
 * L'ordine conta per chi rileggerà i file: `Guild` prima di tutto ciò che vi
 * si riferisce, così un ripristino sequenziale non incontra riferimenti a
 * righe non ancora inserite.
 */
const TABELLE = [
  'guild',
  'configHistory',
  'userProfile',
  'case',
  'incident',
  'auditEvent',
  'messageArchive',
  'attachmentArchive',
  'voiceSession',
  'snapshot',
  'threatSignature',
  'webhookRecord',
  'botRecord',
  'inviteRecord',
  'persona',
  'customCommand',
  'twitchSubscription',
  'socialSource',
  'poll',
  'pollVote',
  'giveaway',
  'giveawayEntry',
  'ticket',
  'starboardEntry',
  'reactionRoleSet',
  'panelAccess',
  'erasureRequest',
] as const;

/*
 * `panelSession` è esclusa di proposito.
 *
 * Contiene i token OAuth di chi ha fatto l'accesso al pannello, cifrati con
 * ENCRYPTION_KEY. Una copia che li porta fuori dal volume dell'applicazione è
 * una superficie d'attacco in più per dei dati che, di loro, scadono in pochi
 * giorni e si rigenerano con un nuovo accesso: non c'è nulla da recuperare e
 * c'è qualcosa da perdere.
 */

/** Righe lette per volta: tenere in memoria un'intera tabella di eventi non è un'opzione. */
const PAGINA = 1000;

export interface BackupResult {
  cartella: string;
  tabelle: number;
  righe: number;
  errori: string[];
}

/**
 * Esegue la copia.
 *
 * `BACKUP_DIR` punta a una cartella che deve stare su un volume diverso da
 * quello dell'applicazione: se sta nello stesso, sparisce insieme a ciò che
 * dovrebbe proteggere, ed è esattamente il modo in cui i backup non servono.
 */
export async function runSelfBackup(): Promise<BackupResult> {
  const radice = process.env.BACKUP_DIR ?? '/backup';
  const stampa = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cartella = path.join(radice, `angel-${stampa}`);

  const risultato: BackupResult = { cartella, tabelle: 0, righe: 0, errori: [] };

  await fs.mkdir(cartella, { recursive: true });

  const prisma = getPrisma() as unknown as Record<
    string,
    { findMany: (args: unknown) => Promise<Record<string, unknown>[]> }
  >;

  for (const tabella of TABELLE) {
    const modello = prisma[tabella];
    if (!modello?.findMany) continue;

    const file = path.join(cartella, `${tabella}.ndjson`);
    const flusso = createWriteStream(file, { encoding: 'utf8' });
    let scritte = 0;
    let salto = 0;

    try {
      for (;;) {
        const righe = await modello.findMany({ take: PAGINA, skip: salto });
        if (righe.length === 0) break;

        for (const riga of righe) {
          // `JSON.stringify` non sa serializzare BigInt e lancia: capita sui
          // contatori, ed è il tipo di errore che si scopre quando il backup
          // serve davvero.
          flusso.write(
            `${JSON.stringify(riga, (_chiave, valore) =>
              typeof valore === 'bigint' ? valore.toString() : valore,
            )}\n`,
          );
        }

        scritte += righe.length;
        salto += righe.length;
        if (righe.length < PAGINA) break;
      }

      risultato.tabelle += 1;
      risultato.righe += scritte;
    } catch (errore) {
      risultato.errori.push(tabella);
      logger.warn({ err: errore, tabella }, 'esportazione della tabella fallita');
    } finally {
      await new Promise<void>((risolvi) => flusso.end(risolvi));
    }

    // Una tabella vuota lascia un file vuoto: si toglie, così la cartella
    // mostra a colpo d'occhio cosa contiene davvero.
    if (scritte === 0) await fs.rm(file, { force: true }).catch(() => undefined);
  }

  await scriviManifesto(cartella, risultato);
  await potaVecchi(radice);

  logger.info(
    { cartella, tabelle: risultato.tabelle, righe: risultato.righe },
    'copia di sicurezza completata',
  );
  return risultato;
}

/**
 * Il manifesto serve a chi ritrova la cartella fra un anno senza ricordare
 * cosa sia. Contiene la versione che l'ha prodotta — indispensabile per
 * sapere quali migrazioni erano state applicate — e le istruzioni per
 * rileggerla.
 */
async function scriviManifesto(cartella: string, risultato: BackupResult): Promise<void> {
  const manifesto = {
    prodottoDa: 'ANGEL',
    versione: process.env.ANGEL_VERSION ?? 'sviluppo',
    quando: new Date().toISOString(),
    tabelle: risultato.tabelle,
    righe: risultato.righe,
    errori: risultato.errori,
    formato: 'NDJSON — una riga JSON per record',
    comeRileggere:
      'Ogni file è una tabella. Per contare le righe: wc -l tabella.ndjson. ' +
      'Per cercare: grep. Per reimportare serve uno schema compatibile con la ' +
      'versione indicata sopra.',
  };

  await fs.writeFile(
    path.join(cartella, 'MANIFESTO.json'),
    JSON.stringify(manifesto, null, 2),
    'utf8',
  );
}

/**
 * Tiene le ultime copie e rimuove le più vecchie.
 *
 * Non è una questione di spazio: è che trovare quella giusta fra trecento
 * cartelle è un problema che si presenta solo quando si ha fretta.
 */
async function potaVecchi(radice: string): Promise<void> {
  const daTenere = Number(process.env.BACKUP_KEEP ?? 14);
  const voci = await fs.readdir(radice, { withFileTypes: true }).catch(() => []);

  const cartelle = voci
    .filter((voce) => voce.isDirectory() && voce.name.startsWith('angel-'))
    .map((voce) => voce.name)
    .sort()
    .reverse();

  for (const vecchia of cartelle.slice(daTenere)) {
    await fs.rm(path.join(radice, vecchia), { recursive: true, force: true }).catch(() => undefined);
    logger.debug({ cartella: vecchia }, 'copia vecchia rimossa');
  }
}
