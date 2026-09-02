/* ═══════════════════════════════════════════════════════════════════════
   RIPRISTINO

   Rilegge una cartella prodotta da `runSelfBackup` e la riversa in
   un'installazione: le tabelle nel database, i file archiviati in
   `STORAGE_DIR`.

   È la metà che mancava. Fino alla 1.23 la copia si faceva ogni notte e non
   c'era modo di rileggerla se non a mano, riga per riga: un backup che nessuno
   sa ripristinare è un backup di cui ci si fida senza motivo — e il momento in
   cui si scopre che non si sa come usarlo è sempre lo stesso.

   Tre precauzioni, tutte per lo stesso motivo — un ripristino sbagliato
   distrugge dati che l'attacco aveva risparmiato:

   1. su un database che contiene già qualcosa non si scrive nulla senza che
      qualcuno lo abbia chiesto esplicitamente;
   2. se la chiave di cifratura non è quella con cui la copia è stata prodotta,
      ci si ferma e lo si dice, perché i segreti dentro il database tornerebbero
      illeggibili senza che nulla lo segnali;
   3. una riga che il database rifiuta non fa cadere le altre: si riprova una
      per una e alla fine si dice quante e quali non sono passate.
   ═══════════════════════════════════════════════════════════════════════ */

import { createInterface } from 'node:readline';
import { createReadStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { getPrisma } from '@angel/db';
import { logger } from '../logger.js';
import {
  NOMI,
  TABELLE,
  improntaChiave,
  ripristinaTipi,
  type Manifesto,
  type Tabella,
} from './formato.js';

/** Righe inserite per volta. */
const LOTTO = 500;

/** File che segna una cartella come già usata per un ripristino. */
export const SEGNO_RIPRISTINO = 'RIPRISTINATO';

export interface OpzioniRipristino {
  /** Cartella `angel-…` da rileggere. */
  cartella: string;
  /**
   * Svuota le tabelle prima di riempirle.
   *
   * Senza, un database che contiene già dati non viene toccato affatto. È la
   * differenza fra «porta qui i dati della vecchia macchina» e «cancella
   * quello che c'è e mettici questi».
   */
  sovrascrivi?: boolean;
  /** Salta `archivio.tar.gz`: utile quando servono solo i dati. */
  senzaArchivio?: boolean;
  /** Procede anche se la chiave di cifratura non combacia. */
  accettaChiaveDiversa?: boolean;
}

export interface EsitoRipristino {
  cartella: string;
  versioneCopia: string;
  quando: string;
  tabelle: Record<string, { lette: number; inserite: number; rifiutate: number }>;
  totaleInserite: number;
  totaleRifiutate: number;
  archivio: { estratti: number; saltato: boolean; motivo?: string };
  avvisi: string[];
}

/* ── Ingresso ─────────────────────────────────────────────────────────── */

export async function importaBackup(opzioni: OpzioniRipristino): Promise<EsitoRipristino> {
  const cartella = path.resolve(opzioni.cartella);
  const manifesto = await leggiManifesto(cartella);

  const esito: EsitoRipristino = {
    cartella,
    versioneCopia: manifesto.versione,
    quando: manifesto.quando,
    tabelle: {},
    totaleInserite: 0,
    totaleRifiutate: 0,
    archivio: { estratti: 0, saltato: true },
    avvisi: [],
  };

  controllaChiave(manifesto, opzioni, esito);
  await controllaDatabase(opzioni, esito);

  // I file NDJSON si estraggono in una cartella temporanea e non dentro la
  // copia: la copia deve restare esattamente com'era, perché se il ripristino
  // va male la si rilegge una seconda volta.
  const lavoro = await fs.mkdtemp(path.join(tmpdir(), 'angel-ripristino-'));

  try {
    await tar.extract({ file: path.join(cartella, NOMI.dati), cwd: lavoro });

    if (opzioni.sovrascrivi) await svuota(esito);

    for (const tabella of TABELLE) {
      const file = path.join(lavoro, 'tabelle', `${tabella}.ndjson`);
      const presente = await fs
        .access(file)
        .then(() => true)
        .catch(() => false);
      if (!presente) continue;

      const conteggio = await importaTabella(tabella, file, manifesto.tipi[tabella]);
      esito.tabelle[tabella] = conteggio;
      esito.totaleInserite += conteggio.inserite;
      esito.totaleRifiutate += conteggio.rifiutate;
    }

    await allineaSequenze(esito);
    await ripristinaArchivio(cartella, manifesto, opzioni, esito);
  } finally {
    await fs.rm(lavoro, { recursive: true, force: true }).catch(() => undefined);
  }

  await segnaFatto(cartella, esito);

  logger.info(
    {
      cartella,
      inserite: esito.totaleInserite,
      rifiutate: esito.totaleRifiutate,
      file: esito.archivio.estratti,
    },
    'ripristino completato',
  );
  return esito;
}

/* ── Controlli preliminari ────────────────────────────────────────────── */

async function leggiManifesto(cartella: string): Promise<Manifesto> {
  const percorso = path.join(cartella, NOMI.manifesto);
  const testo = await fs.readFile(percorso, 'utf8').catch(() => null);

  if (testo === null) {
    throw new Error(
      `${percorso} non trovato. RESTORE_FROM deve indicare una cartella \`angel-…\` ` +
        'prodotta dalla copia di sicurezza, non la cartella che le contiene tutte.',
    );
  }

  const manifesto = JSON.parse(testo) as Manifesto;
  if (manifesto.prodottoDa !== 'ANGEL') {
    throw new Error(`${percorso} non sembra una copia di ANGEL.`);
  }
  return manifesto;
}

/**
 * Confronto fra la chiave di questa macchina e quella della copia.
 *
 * Un ripristino con la chiave sbagliata riesce e sembra perfetto: tutte le
 * righe tornano, il pannello si apre, i conteggi combaciano. Poi le
 * integrazioni non funzionano più, e non c'è nessun messaggio che colleghi la
 * causa all'effetto. Fermarsi qui costa un riavvio; non fermarsi costa una
 * giornata di ricerca.
 */
function controllaChiave(
  manifesto: Manifesto,
  opzioni: OpzioniRipristino,
  esito: EsitoRipristino,
): void {
  const mia = improntaChiave();

  if (!manifesto.improntaChiave) {
    esito.avvisi.push('la copia non dichiara una chiave di cifratura: confronto impossibile');
    return;
  }
  if (mia === manifesto.improntaChiave) return;

  const messaggio =
    `ENCRYPTION_KEY diversa da quella con cui la copia è stata prodotta ` +
    `(copia: ${manifesto.improntaChiave}, questa macchina: ${mia ?? 'nessuna'}). ` +
    'I token delle integrazioni cifrati nel database resteranno illeggibili. ' +
    'Rimetti la chiave della vecchia macchina, oppure procedi con ' +
    'RESTORE_ACCEPT_KEY_MISMATCH=1 sapendo che le integrazioni andranno riconfigurate.';

  if (!opzioni.accettaChiaveDiversa) throw new Error(messaggio);
  esito.avvisi.push(messaggio);
}

/**
 * Verifica che il database sia raggiungibile e, se non è vuoto, che qualcuno
 * abbia chiesto esplicitamente di sovrascriverlo.
 */
async function controllaDatabase(
  opzioni: OpzioniRipristino,
  esito: EsitoRipristino,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.$queryRaw`SELECT 1`;

  const [server, eventi] = await Promise.all([
    prisma.guild.count(),
    prisma.auditEvent.count(),
  ]);

  if (server === 0 && eventi === 0) return;

  if (!opzioni.sovrascrivi) {
    throw new Error(
      `il database non è vuoto (${server} server, ${eventi} eventi): il ripristino si ferma ` +
        'per non mescolare due installazioni. Se è proprio questo che vuoi, ripeti con ' +
        'RESTORE_OVERWRITE=1: le tabelle verranno svuotate prima di essere riempite.',
    );
  }

  esito.avvisi.push(
    `database non vuoto (${server} server, ${eventi} eventi): verrà svuotato prima del ripristino`,
  );
}

/* ── Scrittura ────────────────────────────────────────────────────────── */

type ModelloPrisma = {
  createMany: (args: { data: unknown[]; skipDuplicates?: boolean }) => Promise<{ count: number }>;
  create: (args: { data: unknown }) => Promise<unknown>;
  deleteMany: (args?: unknown) => Promise<{ count: number }>;
};

function modelli(): Record<string, ModelloPrisma> {
  return getPrisma() as unknown as Record<string, ModelloPrisma>;
}

/**
 * Svuota le tabelle in ordine inverso di dipendenza.
 *
 * Al contrario, perché una riga non si può cancellare finché qualcosa la
 * riferisce: `pollVote` prima di `poll`, tutto prima di `guild`.
 */
async function svuota(esito: EsitoRipristino): Promise<void> {
  const client = modelli();
  for (const tabella of [...TABELLE].reverse()) {
    const modello = client[tabella];
    if (!modello?.deleteMany) continue;
    try {
      const { count } = await modello.deleteMany({});
      if (count > 0) logger.info({ tabella, righe: count }, 'tabella svuotata');
    } catch (errore) {
      esito.avvisi.push(`svuotamento di ${tabella} non riuscito`);
      logger.warn({ err: errore, tabella }, 'svuotamento non riuscito');
    }
  }
}

async function importaTabella(
  tabella: Tabella,
  file: string,
  tipi: Record<string, 'date' | 'bigint'> | undefined,
): Promise<{ lette: number; inserite: number; rifiutate: number }> {
  const modello = modelli()[tabella];
  const conteggio = { lette: 0, inserite: 0, rifiutate: 0 };
  if (!modello?.createMany) return conteggio;

  let lotto: Record<string, unknown>[] = [];

  const scarica = async (): Promise<void> => {
    if (lotto.length === 0) return;
    const corrente = lotto;
    lotto = [];
    conteggio.inserite += await inserisci(modello, corrente, tabella, conteggio);
  };

  // Lettura riga per riga e non `readFile`: un `auditEvent.ndjson` di un server
  // attivo da un anno supera facilmente il gigabyte, e caricarlo intero
  // significherebbe che il ripristino fallisce proprio nei casi in cui serve.
  const righe = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const riga of righe) {
    if (!riga.trim()) continue;
    conteggio.lette += 1;
    try {
      lotto.push(ripristinaTipi(JSON.parse(riga) as Record<string, unknown>, tipi));
    } catch {
      conteggio.rifiutate += 1;
      continue;
    }
    if (lotto.length >= LOTTO) await scarica();
  }
  await scarica();

  logger.info({ tabella, ...conteggio }, 'tabella importata');
  return conteggio;
}

/**
 * Inserisce un lotto, e se il lotto non passa riprova riga per riga.
 *
 * Un `createMany` è una transazione sola: una riga malformata su cinquecento
 * ne fa perdere cinquecento. Il secondo passaggio è lento ma serve solo quando
 * qualcosa è andato storto, e trasforma «cinquecento righe perse» in «una riga
 * persa, e so quale».
 */
async function inserisci(
  modello: ModelloPrisma,
  righe: Record<string, unknown>[],
  tabella: string,
  conteggio: { rifiutate: number },
): Promise<number> {
  try {
    const { count } = await modello.createMany({ data: righe, skipDuplicates: true });
    return count;
  } catch (errore) {
    logger.warn(
      { err: errore, tabella, righe: righe.length },
      'lotto rifiutato, riprovo riga per riga',
    );

    let inserite = 0;
    for (const riga of righe) {
      try {
        await modello.create({ data: riga });
        inserite += 1;
      } catch {
        conteggio.rifiutate += 1;
      }
    }
    return inserite;
  }
}

/**
 * Rimette i contatori automatici dopo l'ultimo identificatore inserito.
 *
 * `AuditEvent.id` è una sequenza Postgres. Inserendo righe con l'id già
 * scritto dentro, la sequenza resta a zero: il primo evento registrato dopo il
 * ripristino chiederebbe l'id 1, che esiste già, e ogni scrittura sul registro
 * fallirebbe con un errore di chiave duplicata. Il bot sembrerebbe ripristinato
 * e non riuscirebbe a registrare più nulla.
 */
const CONTATORI: { tabella: string; colonna: string }[] = [
  { tabella: 'AuditEvent', colonna: 'id' },
  { tabella: 'TwitchEvent', colonna: 'id' },
];

async function allineaSequenze(esito: EsitoRipristino): Promise<void> {
  const prisma = getPrisma();

  for (const { tabella, colonna } of CONTATORI) {
    try {
      await prisma.$executeRawUnsafe(
        `SELECT setval(
           pg_get_serial_sequence('"${tabella}"', '${colonna}'),
           GREATEST(COALESCE((SELECT MAX("${colonna}") FROM "${tabella}"), 0), 1)
         )`,
      );
    } catch (errore) {
      esito.avvisi.push(
        `contatore di ${tabella} non riallineato: potrebbe rifiutare le nuove righe`,
      );
      logger.warn({ err: errore, tabella }, 'riallineamento della sequenza non riuscito');
    }
  }
}

/* ── File archiviati ──────────────────────────────────────────────────── */

async function ripristinaArchivio(
  cartella: string,
  manifesto: Manifesto,
  opzioni: OpzioniRipristino,
  esito: EsitoRipristino,
): Promise<void> {
  if (opzioni.senzaArchivio) {
    esito.archivio = { estratti: 0, saltato: true, motivo: 'saltato su richiesta' };
    return;
  }
  if (!manifesto.archivio.incluso) {
    esito.archivio = {
      estratti: 0,
      saltato: true,
      motivo: manifesto.archivio.motivo ?? 'non incluso nella copia',
    };
    return;
  }

  const sorgente = path.join(cartella, NOMI.archivio);
  const presente = await fs
    .access(sorgente)
    .then(() => true)
    .catch(() => false);
  if (!presente) {
    esito.archivio = { estratti: 0, saltato: true, motivo: `${NOMI.archivio} mancante` };
    esito.avvisi.push(
      'il manifesto dichiara un archivio dei file che nella cartella non c’è: ' +
        'gli allegati e le trascrizioni non verranno ripristinati',
    );
    return;
  }

  const destinazione = path.resolve(process.env.STORAGE_DIR ?? './storage');
  await fs.mkdir(destinazione, { recursive: true });

  let estratti = 0;
  await tar.extract({
    file: sorgente,
    cwd: destinazione,
    onReadEntry: (voce) => {
      if (voce.type === 'File') estratti += 1;
    },
  });

  esito.archivio = { estratti, saltato: false };
  logger.info({ file: estratti, destinazione }, 'archivio dei file ripristinato');
}

/* ── Marcatura ────────────────────────────────────────────────────────── */

/**
 * Lascia dentro la copia il verbale di quello che è appena successo.
 *
 * Serve a due cose. La prima è impedire che il ripristino automatico si
 * ripeta a ogni riavvio, raddoppiando i dati o cancellandoli daccapo. La
 * seconda è che fra sei mesi, guardando quella cartella, si sappia che è già
 * stata usata e come è andata.
 */
async function segnaFatto(cartella: string, esito: EsitoRipristino): Promise<void> {
  await fs
    .writeFile(
      path.join(cartella, SEGNO_RIPRISTINO),
      JSON.stringify({ ripristinatoIl: new Date().toISOString(), ...esito }, null, 2),
      'utf8',
    )
    .catch((errore: unknown) =>
      logger.warn({ err: errore }, 'segno di ripristino non scritto: la cartella è sola lettura?'),
    );
}

/** Vero se questa copia è già stata usata per un ripristino. */
export async function giaRipristinata(cartella: string): Promise<boolean> {
  return fs
    .access(path.join(cartella, SEGNO_RIPRISTINO))
    .then(() => true)
    .catch(() => false);
}
