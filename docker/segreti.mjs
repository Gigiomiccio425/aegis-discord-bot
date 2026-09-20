import { promises as fs } from 'node:fs';
import path from 'node:path';
import { applicaSegreti, FILE_SEGRETI } from '@angel/shared';

/* ═══════════════════════════════════════════════════════════════════════
   IL FILE DEI SEGRETI, LETTO DAL DISCO

   Il perché sta in `packages/shared/src/segreti.ts`, insieme alla lettura
   del formato. Qui c'è solo la parte che tocca il disco.

   Una cosa che questo file non fa: scrivere i valori nei log. Solo i nomi.
   Un segreto che compare una volta in un registro è un segreto che vive
   quanto quel registro, e i log di un container finiscono in posti che
   nessuno ricorda.
   ═══════════════════════════════════════════════════════════════════════ */

export { FILE_SEGRETI };

export async function caricaSegreti(cartella, ambiente = process.env) {
  const percorso = path.join(cartella, FILE_SEGRETI);

  let testo;
  try {
    testo = await fs.readFile(percorso, 'utf8');
  } catch {
    // Nessun file: è il caso normale di chi tiene i valori nel compose.
    return { percorso, presente: false, nomi: [], mancanti: [], avvisi: [] };
  }

  const avvisi = [];
  try {
    const stato = await fs.stat(percorso);
    // Il bit di lettura per «gli altri»: se c'è, il file lo legge chiunque
    // abbia accesso alla cartella dei dati.
    if ((stato.mode & 0o004) !== 0) {
      avvisi.push(`${percorso} è leggibile da chiunque — chiudilo: chmod 600 ${percorso}`);
    }
  } catch {
    /* i permessi non si leggono su tutti i filesystem: non è un motivo per fermarsi */
  }

  const { nomi, mancanti } = applicaSegreti(testo, ambiente);
  return { percorso, presente: true, nomi, mancanti, avvisi };
}
