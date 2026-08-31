#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   RIPRISTINO — riga di comando

       node apps/worker/dist/ripristina.js /backup/angel-2026-08-31T04-15-00

   Opzioni (o le variabili d'ambiente equivalenti, che è come le usa il
   supervisore quando `docker exec` non è disponibile — su ZimaOS non lo è):

     --sovrascrivi              RESTORE_OVERWRITE=1
        Svuota le tabelle prima di riempirle. Senza, un database che contiene
        già qualcosa non viene toccato affatto.

     --senza-archivio           RESTORE_SKIP_STORAGE=1
        Solo il database: niente allegati né trascrizioni dei ticket.

     --accetta-chiave-diversa   RESTORE_ACCEPT_KEY_MISMATCH=1
        Procede anche se ENCRYPTION_KEY non è quella con cui la copia è stata
        prodotta. I dati tornano, i token delle integrazioni no.

   Esce con codice 0 se il ripristino è andato a buon fine, 1 altrimenti. Il
   supervisore ci conta: un ripristino fallito non deve far partire un bot che
   crede di avere i dati e non li ha.
   ═══════════════════════════════════════════════════════════════════════ */

import 'dotenv/config';
import { disconnectPrisma } from '@angel/db';
import { importaBackup } from './backup/importa.js';
import { logger } from './logger.js';

function flag(nome: string, variabile: string): boolean {
  return process.argv.includes(`--${nome}`) || process.env[variabile] === '1';
}

async function main(): Promise<void> {
  const cartella = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? process.env.RESTORE_FROM;

  if (!cartella) {
    console.error(
      'Manca la cartella da ripristinare.\n' +
        '  node apps/worker/dist/ripristina.js /backup/angel-2026-08-31T04-15-00\n' +
        'Deve essere una cartella `angel-…`, non quella che le contiene tutte.',
    );
    process.exit(1);
  }

  const esito = await importaBackup({
    cartella,
    sovrascrivi: flag('sovrascrivi', 'RESTORE_OVERWRITE'),
    senzaArchivio: flag('senza-archivio', 'RESTORE_SKIP_STORAGE'),
    accettaChiaveDiversa: flag('accetta-chiave-diversa', 'RESTORE_ACCEPT_KEY_MISMATCH'),
  });

  // Il riepilogo va su stdout e non nel logger: chi lancia il comando a mano
  // lo sta guardando, e il JSON strutturato in quel momento è rumore.
  console.log(`\nRipristinata la copia del ${esito.quando} (versione ${esito.versioneCopia})\n`);
  for (const [tabella, conteggio] of Object.entries(esito.tabelle)) {
    const scarti = conteggio.rifiutate > 0 ? `  ⚠️ ${conteggio.rifiutate} rifiutate` : '';
    console.log(`  ${tabella.padEnd(22)} ${String(conteggio.inserite).padStart(8)}${scarti}`);
  }
  console.log(`\n  Totale: ${esito.totaleInserite} righe`);
  console.log(
    esito.archivio.saltato
      ? `  File archiviati: nessuno (${esito.archivio.motivo ?? 'saltati'})`
      : `  File archiviati: ${esito.archivio.estratti}`,
  );

  if (esito.avvisi.length > 0) {
    console.log('\nDa sapere:');
    for (const avviso of esito.avvisi) console.log(`  • ${avviso}`);
  }
  if (esito.totaleRifiutate > 0) {
    console.log(
      `\n⚠️  ${esito.totaleRifiutate} righe non sono passate. Le altre sì: il ripristino è ` +
        'parziale, non fallito. I motivi sono nei log qui sopra.',
    );
  }
}

void main()
  .then(async () => {
    await disconnectPrisma();
    process.exit(0);
  })
  .catch(async (errore: unknown) => {
    logger.fatal({ err: errore }, 'ripristino fallito');
    console.error(`\n❌ ${(errore as Error).message}`);
    await disconnectPrisma().catch(() => undefined);
    process.exit(1);
  });
