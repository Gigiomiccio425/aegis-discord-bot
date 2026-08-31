/* ═══════════════════════════════════════════════════════════════════════
   FORMATO DELLA COPIA

   Quello che sanno in comune chi scrive la copia e chi la rilegge. Sta in un
   file solo perché l'unico modo di sbagliare un ripristino in silenzio è
   avere due elenchi di tabelle che nel tempo divergono: uno esporta, l'altro
   importa, e la differenza si scopre quando i dati servono.
   ═══════════════════════════════════════════════════════════════════════ */

import { createHash } from 'node:crypto';

/**
 * Tabelle esportate, in ordine di dipendenza.
 *
 * L'ordine non è estetico: `guild` prima di tutto ciò che vi si riferisce, e
 * `poll` prima di `pollVote`. Un ripristino sequenziale che seguisse un ordine
 * qualsiasi incontrerebbe riferimenti a righe non ancora inserite, e ogni
 * chiave esterna del database lo rifiuterebbe.
 *
 * Per **cancellare** si percorre lo stesso elenco al contrario, per lo stesso
 * motivo visto dall'altro lato.
 */
export const TABELLE = [
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

export type Tabella = (typeof TABELLE)[number];

/*
 * `panelSession` è esclusa di proposito.
 *
 * Contiene i token OAuth di chi ha fatto l'accesso al pannello, cifrati con
 * ENCRYPTION_KEY. Una copia che li porta fuori dal volume dell'applicazione è
 * una superficie d'attacco in più per dei dati che, di loro, scadono in pochi
 * giorni e si rigenerano con un nuovo accesso: non c'è nulla da recuperare e
 * c'è qualcosa da perdere.
 */

/** Nomi dei file dentro una cartella di copia. */
export const NOMI = {
  manifesto: 'MANIFESTO.json',
  istruzioni: 'ISTRUZIONI.md',
  dati: 'dati.tar.gz',
  archivio: 'archivio.tar.gz',
} as const;

/** Prefisso delle cartelle di copia dentro `BACKUP_DIR`. */
export const PREFISSO = 'angel-';

/**
 * Tipi che JSON non sa rappresentare e che vanno ricostruiti al ripristino.
 *
 * `date` e `bigint` diventano stringhe nel file: reinserirle così com'è
 * significa che Prisma rifiuta l'intera tabella, oppure — peggio — che un
 * timestamp finisce nel database come testo e ogni filtro per data smette di
 * trovarlo.
 */
export type TipoSpeciale = 'date' | 'bigint';

/** Per ogni tabella, i campi che richiedono una conversione al ripristino. */
export type MappaTipi = Record<string, Record<string, TipoSpeciale>>;

export interface Manifesto {
  prodottoDa: 'ANGEL';
  /** Versione dell'immagine che ha prodotto la copia: dice quali migrazioni erano applicate. */
  versione: string;
  quando: string;
  /** Numero di righe esportate per tabella. Le tabelle vuote non compaiono. */
  righe: Record<string, number>;
  totaleRighe: number;
  /** Tabelle che hanno dato errore durante l'esportazione. */
  errori: string[];
  tipi: MappaTipi;
  archivio: {
    incluso: boolean;
    file: number;
    byte: number;
    /** Perché è stato escluso, quando lo è stato. */
    motivo?: string;
  };
  /**
   * Impronta della chiave di cifratura, non la chiave.
   *
   * Serve a una cosa sola ma decisiva: accorgersi al ripristino che la nuova
   * macchina ha una ENCRYPTION_KEY diversa. In quel caso i dati tornano tutti,
   * ma i segreti cifrati dentro il database — i token delle integrazioni —
   * diventano illeggibili, e il sintomo sarebbe un'integrazione che smette di
   * funzionare senza che nulla dica perché.
   */
  improntaChiave: string | null;
  schema: {
    tabelle: number;
  };
}

/**
 * Impronta di ENCRYPTION_KEY.
 *
 * SHA-256 troncato a sedici caratteri: abbastanza per riconoscere se due
 * macchine hanno la stessa chiave, inutile per ricostruirla.
 */
export function improntaChiave(chiave = process.env.ENCRYPTION_KEY): string | null {
  if (!chiave) return null;
  return createHash('sha256').update(chiave).digest('hex').slice(0, 16);
}

/**
 * Riconosce i campi che JSON non sa rappresentare, guardando i valori veri.
 *
 * L'alternativa sarebbe leggere lo schema Prisma e dedurne i tipi. Lo si è
 * evitato apposta: lo schema cambia, il client generato cambia con lui, e un
 * elenco di campi ricavato altrove è un elenco che un giorno sarà sbagliato.
 * I valori appena letti dal database, invece, sono per definizione quelli che
 * finiranno nel file.
 *
 * Un campo sempre nullo non compare: resta nullo anche al ritorno, e non c'è
 * nulla da convertire.
 */
export function riconosciTipi(
  righe: Record<string, unknown>[],
  accumulatore: Record<string, TipoSpeciale> = {},
): Record<string, TipoSpeciale> {
  for (const riga of righe) {
    for (const [campo, valore] of Object.entries(riga)) {
      if (accumulatore[campo]) continue;
      if (valore instanceof Date) accumulatore[campo] = 'date';
      else if (typeof valore === 'bigint') accumulatore[campo] = 'bigint';
    }
  }
  return accumulatore;
}

/**
 * Rimette i tipi che JSON ha appiattito in stringhe.
 *
 * Tocca solo i campi elencati nel manifesto della copia che si sta leggendo:
 * un campo assente da quell'elenco passa così com'è, e un manifesto vecchio
 * non fa esplodere un ripristino, lo fa solo più conservativo.
 */
export function ripristinaTipi(
  riga: Record<string, unknown>,
  tipi: Record<string, TipoSpeciale> | undefined,
): Record<string, unknown> {
  if (!tipi) return riga;

  for (const [campo, tipo] of Object.entries(tipi)) {
    const valore = riga[campo];
    if (valore === null || valore === undefined) continue;

    if (tipo === 'date') {
      const data = new Date(valore as string);
      // Una data non interpretabile lascia il campo com'era: meglio una riga
      // rifiutata dal database, che si vede, di una data sbagliata che non si
      // vede.
      if (!Number.isNaN(data.getTime())) riga[campo] = data;
    } else if (tipo === 'bigint') {
      try {
        riga[campo] = BigInt(valore as string);
      } catch {
        /* valore non convertibile: lasciato com'era */
      }
    }
  }
  return riga;
}

/** Serializzatore che non si ferma davanti a BigInt e Date. */
export function serializza(riga: Record<string, unknown>): string {
  return JSON.stringify(riga, (_chiave, valore) =>
    typeof valore === 'bigint' ? valore.toString() : valore,
  );
}
