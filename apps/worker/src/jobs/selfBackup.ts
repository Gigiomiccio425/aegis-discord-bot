/* ═══════════════════════════════════════════════════════════════════════
   COPIA DI SICUREZZA DEI PROPRI DATI

   Esporta l'intera installazione — database e file archiviati — in una
   cartella pensata per stare **fuori** dal volume dell'applicazione, e fatta
   per essere copiata su un'altra macchina così com'è.

   Il caso che risolve è preciso: disinstallando l'app da ZimaOS spariscono i
   container, e chi conferma la rimozione dei volumi perde tutto — registro di
   anni, configurazione, archivio dei messaggi, provvedimenti, trascrizioni dei
   ticket. Nessun errore avvisa prima, perché dal punto di vista di Docker non
   è un errore.

   Il formato del database è NDJSON: una riga per record, leggibile con `grep`,
   importabile con qualunque cosa. Un dump binario di Postgres sarebbe più
   compatto ma richiederebbe la stessa versione di Postgres per essere riletto,
   e fra due anni quella versione sarà un problema in più proprio nel momento
   peggiore. Per il trasloco vero e proprio, `docker/trasloco.sh` fa comunque
   anche un `pg_dump`: le due copie si coprono a vicenda.

   La copia è **completa e non incrementale**. Un backup incrementale che
   sbaglia un collegamento è peggio di nessun backup: sembra esserci e non si
   può usare.

   Struttura prodotta:

       /backup/angel-2026-08-31T04-15-00/
         MANIFESTO.json     leggibile senza estrarre nulla
         ISTRUZIONI.md      come rileggerla, per chi la ritrova fra un anno
         dati.tar.gz        tabelle/<tabella>.ndjson
         archivio.tar.gz    i file di STORAGE_DIR (allegati, trascrizioni)

   Due archivi e non uno perché hanno pesi diversi di due ordini di grandezza:
   così si può portare via il database in pochi megabyte senza trascinarsi
   dietro gigabyte di immagini, quando è il database che serve.
   ═══════════════════════════════════════════════════════════════════════ */

import { createWriteStream, promises as fs } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { getPrisma } from '@angel/db';
import { runningVersion } from '@angel/shared';
import { logger } from '../logger.js';
import {
  NOMI,
  PREFISSO,
  TABELLE,
  improntaChiave,
  riconosciTipi,
  serializza,
  type MappaTipi,
  type Manifesto,
} from '../backup/formato.js';

/** Righe lette per volta: tenere in memoria un'intera tabella di eventi non è un'opzione. */
const PAGINA = 1000;

/**
 * Spazio libero minimo per iniziare, in megabyte.
 *
 * Un backup interrotto a metà per disco pieno lascia una cartella incompleta
 * che sembra una copia valida — ed è successo davvero, su una eMMC da 17 GB
 * scambiata per il disco da due terabyte. Meglio non partire e dirlo.
 */
const SPAZIO_MINIMO_MB = 300;

export interface BackupResult {
  cartella: string;
  tabelle: number;
  righe: number;
  byte: number;
  archivio: { file: number; byte: number; incluso: boolean; motivo?: string };
  errori: string[];
}

function megabyte(valore: string | undefined, predefinito: number): number {
  const numero = Number(valore);
  return Number.isFinite(numero) && numero > 0 ? numero : predefinito;
}

export function radiceBackup(): string {
  return process.env.BACKUP_DIR ?? '/backup';
}

/**
 * Esegue la copia.
 *
 * `BACKUP_DIR` punta a una cartella che deve stare su un volume diverso da
 * quello dell'applicazione: se sta nello stesso, sparisce insieme a ciò che
 * dovrebbe proteggere, ed è esattamente il modo in cui i backup non servono.
 */
export async function runSelfBackup(): Promise<BackupResult> {
  const radice = radiceBackup();
  const stampa = stampaOra();
  const cartella = path.join(radice, `${PREFISSO}${stampa}`);
  // Il lavoro sporco avviene in una cartella nascosta: se il processo muore a
  // metà, quello che resta non ha il nome di una copia valida e la potatura lo
  // porta via. Una cartella `angel-…` incompleta, invece, verrebbe scelta come
  // sorgente di un ripristino.
  const lavoro = path.join(radice, `.in-corso-${stampa}`);

  await fs.mkdir(radice, { recursive: true });
  await controllaSpazio(radice);

  let risultato: BackupResult;
  try {
    ({ risultato } = await scriviContenuto(lavoro, path.basename(cartella)));

    // Rinomina finale: da questo istante la copia esiste ed è completa. È
    // un'operazione atomica sullo stesso filesystem, quindi non esiste il
    // momento in cui una copia parziale porta il nome giusto.
    await fs.rename(lavoro, cartella);
    risultato.byte = await pesoCartella(cartella);
  } catch (errore) {
    await fs.rm(lavoro, { recursive: true, force: true }).catch(() => undefined);
    throw errore;
  }

  await potaVecchi(radice);

  logger.info(
    {
      cartella,
      tabelle: risultato.tabelle,
      righe: risultato.righe,
      megabyte: Math.round(risultato.byte / 1024 / 1024),
      archivio: risultato.archivio.incluso ? risultato.archivio.file : 'escluso',
    },
    'copia di sicurezza completata',
  );
  return risultato;
}

/** Stampa temporale usata nei nomi delle cartelle: ordinabile alfabeticamente. */
export function stampaOra(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Riempie una cartella di lavoro con il contenuto di una copia.
 *
 * Separata da `runSelfBackup` perché la usa anche il kit di trasloco, che
 * attorno allo stesso contenuto aggiunge le variabili d'ambiente. Ci sarebbe
 * stata la scorciatoia di far copiare al kit l'ultima cartella notturna: si è
 * evitata perché quell'ultima cartella può avere venti ore, e venti ore di
 * registro perse durante un trasloco sono precisamente i dati di cui poi si
 * sente la mancanza.
 */
export async function scriviContenuto(
  lavoro: string,
  nomeFinale: string,
): Promise<{ manifesto: Manifesto; risultato: BackupResult }> {
  const risultato: BackupResult = {
    cartella: nomeFinale,
    tabelle: 0,
    righe: 0,
    byte: 0,
    archivio: { file: 0, byte: 0, incluso: false },
    errori: [],
  };

  await fs.mkdir(path.join(lavoro, 'tabelle'), { recursive: true });

  const { tipi, righePerTabella } = await esportaTabelle(lavoro, risultato);

  await tar.create(
    { gzip: true, file: path.join(lavoro, NOMI.dati), cwd: lavoro, portable: true },
    ['tabelle'],
  );

  const archivio = await esportaArchivio(path.join(lavoro, NOMI.archivio));
  risultato.archivio = archivio;

  const manifesto: Manifesto = {
    prodottoDa: 'ANGEL',
    versione: runningVersion(),
    quando: new Date().toISOString(),
    righe: righePerTabella,
    totaleRighe: risultato.righe,
    errori: risultato.errori,
    tipi,
    archivio: {
      incluso: archivio.incluso,
      file: archivio.file,
      byte: archivio.byte,
      ...(archivio.motivo ? { motivo: archivio.motivo } : {}),
    },
    improntaChiave: improntaChiave(),
    schema: { tabelle: TABELLE.length },
  };

  await fs.writeFile(
    path.join(lavoro, NOMI.manifesto),
    JSON.stringify(manifesto, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(lavoro, NOMI.istruzioni),
    istruzioni(manifesto, nomeFinale),
    'utf8',
  );

  // I file NDJSON sono già dentro `dati.tar.gz`: tenerli anche fuori
  // raddoppierebbe lo spazio occupato da ogni copia.
  await fs.rm(path.join(lavoro, 'tabelle'), { recursive: true, force: true });

  return { manifesto, risultato };
}

/* ── Database ─────────────────────────────────────────────────────────── */

async function esportaTabelle(
  lavoro: string,
  risultato: BackupResult,
): Promise<{ tipi: MappaTipi; righePerTabella: Record<string, number> }> {
  const prisma = getPrisma() as unknown as Record<
    string,
    { findMany: (args: unknown) => Promise<Record<string, unknown>[]> }
  >;

  const tipi: MappaTipi = {};
  const righePerTabella: Record<string, number> = {};

  for (const tabella of TABELLE) {
    const modello = prisma[tabella];
    if (!modello?.findMany) continue;

    const file = path.join(lavoro, 'tabelle', `${tabella}.ndjson`);
    const flusso = createWriteStream(file, { encoding: 'utf8' });
    let scritte = 0;
    let salto = 0;

    try {
      for (;;) {
        const righe = await modello.findMany({ take: PAGINA, skip: salto });
        if (righe.length === 0) break;

        // I tipi si riconoscono dai valori veri, prima che JSON li appiattisca
        // in stringhe: è l'unico momento in cui l'informazione esiste ancora.
        tipi[tabella] = riconosciTipi(righe, tipi[tabella]);

        for (const riga of righe) {
          const testo = `${serializza(riga)}\n`;
          // `write` restituisce false quando il buffer interno è pieno: senza
          // attendere `drain`, una tabella da milioni di righe finirebbe tutta
          // in memoria prima di toccare il disco.
          if (!flusso.write(testo)) {
            await new Promise<void>((risolvi) => flusso.once('drain', risolvi));
          }
        }

        scritte += righe.length;
        salto += righe.length;
        if (righe.length < PAGINA) break;
      }

      risultato.tabelle += 1;
      risultato.righe += scritte;
      if (scritte > 0) righePerTabella[tabella] = scritte;
    } catch (errore) {
      risultato.errori.push(tabella);
      logger.warn({ err: errore, tabella }, 'esportazione della tabella fallita');
    } finally {
      await new Promise<void>((risolvi) => flusso.end(risolvi));
    }

    // Una tabella vuota lascia un file vuoto: si toglie, così l'archivio
    // mostra a colpo d'occhio cosa contiene davvero.
    if (scritte === 0) await fs.rm(file, { force: true }).catch(() => undefined);
  }

  return { tipi, righePerTabella };
}

/* ── File archiviati ──────────────────────────────────────────────────── */

/**
 * Comprime `STORAGE_DIR`: allegati archiviati e trascrizioni dei ticket.
 *
 * Sono i dati che il database non contiene e che nessun `pg_dump` porterebbe
 * via: nel database c'è il *percorso* dell'allegato, non l'allegato. Una copia
 * senza questa parte ripristina un archivio pieno di riferimenti a file che
 * non esistono più.
 */
async function esportaArchivio(
  destinazione: string,
): Promise<{ file: number; byte: number; incluso: boolean; motivo?: string }> {
  if (process.env.BACKUP_INCLUDE_STORAGE === 'false') {
    return { file: 0, byte: 0, incluso: false, motivo: 'escluso da BACKUP_INCLUDE_STORAGE' };
  }

  const radice = path.resolve(process.env.STORAGE_DIR ?? './storage');
  const voci = await fs.readdir(radice).catch(() => null);
  if (!voci) {
    return { file: 0, byte: 0, incluso: false, motivo: 'STORAGE_DIR non leggibile' };
  }
  if (voci.length === 0) {
    return { file: 0, byte: 0, incluso: false, motivo: 'nessun file archiviato' };
  }

  // Se qualcuno ha messo BACKUP_DIR dentro STORAGE_DIR, comprimere lo storage
  // significherebbe comprimere anche tutte le copie precedenti, e ogni notte
  // la copia raddoppierebbe di dimensione fino a riempire il disco. È una
  // configurazione sbagliata di suo — la copia non deve stare dove stanno i
  // dati che copia — ma qui costa due righe accorgersene invece di scoprirlo
  // a spazio esaurito.
  if (path.resolve(radiceBackup()).startsWith(radice + path.sep)) {
    return {
      file: 0,
      byte: 0,
      incluso: false,
      motivo: 'BACKUP_DIR sta dentro STORAGE_DIR: spostalo fuori, si copierebbe da sola',
    };
  }

  const { file, byte } = await misura(radice);
  const limite = megabyte(process.env.BACKUP_STORAGE_MAX_MB, 4096) * 1024 * 1024;

  if (byte > limite) {
    // Non si tronca e non si sceglie cosa salvare: un archivio a metà è la
    // cosa che sembra un backup e non lo è. Si dice quanto pesa e quale
    // variabile alzare.
    logger.warn(
      { megabyte: Math.round(byte / 1024 / 1024), limiteMegabyte: limite / 1024 / 1024 },
      'archivio dei file escluso dalla copia perché oltre il limite',
    );
    return {
      file,
      byte,
      incluso: false,
      motivo:
        `${Math.round(byte / 1024 / 1024)} MB oltre il limite di ` +
        `${Math.round(limite / 1024 / 1024)} MB — alza BACKUP_STORAGE_MAX_MB per includerlo`,
    };
  }

  await tar.create({ gzip: true, file: destinazione, cwd: radice, portable: true }, voci);
  return { file, byte, incluso: true };
}

/** Conta file e byte di un albero di cartelle. */
export async function misura(radice: string): Promise<{ file: number; byte: number }> {
  let file = 0;
  let byte = 0;

  const visita = async (cartella: string): Promise<void> => {
    const voci = await fs.readdir(cartella, { withFileTypes: true }).catch(() => []);
    for (const voce of voci) {
      const percorso = path.join(cartella, voce.name);
      if (voce.isDirectory()) {
        await visita(percorso);
      } else if (voce.isFile()) {
        const stato = await fs.stat(percorso).catch(() => null);
        if (stato) {
          file += 1;
          byte += stato.size;
        }
      }
    }
  };

  await visita(radice);
  return { file, byte };
}

export async function pesoCartella(cartella: string): Promise<number> {
  const { byte } = await misura(cartella);
  return byte;
}

/* ── Spazio e potatura ────────────────────────────────────────────────── */

export async function controllaSpazio(radice: string): Promise<void> {
  try {
    const stato = await statfs(radice);
    const liberiMb = (stato.bsize * stato.bavail) / 1024 / 1024;
    if (liberiMb < SPAZIO_MINIMO_MB) {
      throw new Error(
        `spazio insufficiente in ${radice}: ${Math.round(liberiMb)} MB liberi, ` +
          `ne servono almeno ${SPAZIO_MINIMO_MB}`,
      );
    }
  } catch (errore) {
    // `statfs` non esiste ovunque: se non si può misurare, si procede. È il
    // controllo a essere facoltativo, non la copia.
    if (errore instanceof Error && errore.message.startsWith('spazio insufficiente')) throw errore;
  }
}

/**
 * Tiene le ultime copie e rimuove le più vecchie.
 *
 * Non è solo una questione di spazio: è che trovare quella giusta fra trecento
 * cartelle è un problema che si presenta solo quando si ha fretta.
 */
async function potaVecchi(radice: string): Promise<void> {
  const daTenere = Number(process.env.BACKUP_KEEP ?? 14);
  const voci = await fs.readdir(radice, { withFileTypes: true }).catch(() => []);

  // Le cartelle di lavoro rimaste da un'esecuzione interrotta se ne vanno
  // subito: non sono copie e occupano quanto una copia.
  for (const voce of voci) {
    if (voce.isDirectory() && voce.name.startsWith('.in-corso-')) {
      await fs.rm(path.join(radice, voce.name), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  const cartelle = voci
    .filter((voce) => voce.isDirectory() && voce.name.startsWith(PREFISSO))
    .map((voce) => voce.name)
    .sort()
    .reverse();

  for (const vecchia of cartelle.slice(daTenere)) {
    await fs.rm(path.join(radice, vecchia), { recursive: true, force: true }).catch(() => undefined);
    logger.debug({ cartella: vecchia }, 'copia vecchia rimossa');
  }
}

/* ── Istruzioni ───────────────────────────────────────────────────────── */

/**
 * Il foglio di istruzioni dentro la copia.
 *
 * Serve a chi ritrova la cartella fra un anno senza ricordare cosa sia — che
 * di solito è la stessa persona che l'ha prodotta, in un giorno in cui ha
 * fretta. Sta dentro la copia e non nella documentazione perché la
 * documentazione, in quel momento, è sul server che non c'è più.
 */
function istruzioni(manifesto: Manifesto, nomeCartella: string): string {
  return `# Copia di sicurezza di ANGEL

Prodotta il ${manifesto.quando} dalla versione **${manifesto.versione}**.
${manifesto.totaleRighe} righe in ${Object.keys(manifesto.righe).length} tabelle.
${
  manifesto.archivio.incluso
    ? `Archivio dei file: ${manifesto.archivio.file} file, ${Math.round(manifesto.archivio.byte / 1024 / 1024)} MB.`
    : `Archivio dei file **non incluso**: ${manifesto.archivio.motivo}.`
}

## Cosa c'è dentro

- \`${NOMI.dati}\` — una cartella \`tabelle/\` con un file NDJSON per tabella:
  una riga JSON per record.
- \`${NOMI.archivio}\` — il contenuto di \`STORAGE_DIR\`: allegati archiviati e
  trascrizioni dei ticket. Va estratto dentro \`STORAGE_DIR\` sulla macchina
  nuova.
- \`${NOMI.manifesto}\` — questo, in forma leggibile da un programma.

## Guardarci dentro senza ripristinare nulla

    tar tzf ${NOMI.dati}
    tar xzf ${NOMI.dati} -O tabelle/case.ndjson | head
    tar xzf ${NOMI.dati} -O tabelle/auditEvent.ndjson | wc -l

## Ripristinare su un'altra macchina

1. Installa ANGEL sulla macchina nuova e **lasciala partire una volta**: serve
   che le migrazioni creino le tabelle. Non configurare nulla.
2. Copia questa cartella intera dentro \`BACKUP_DIR\` della macchina nuova
   (nel compose predefinito: \`/DATA/angel-backup\`).
3. Aggiungi al compose, nel blocco \`environment:\` di \`angel\`:

       RESTORE_FROM: /backup/${nomeCartella}

   — cioè il percorso di **questa cartella** vista da dentro il container.
4. Riavvia l'app. Il ripristino avviene una volta sola, prima che bot e
   pannello partano, e lascia un file \`RIPRISTINATO\` qui dentro perché non si
   ripeta al riavvio successivo.
5. Togli \`RESTORE_FROM\` dal compose.

## La chiave di cifratura

Impronta della \`ENCRYPTION_KEY\` con cui questa copia è stata prodotta:
**${manifesto.improntaChiave ?? 'nessuna chiave impostata'}**

Sulla macchina nuova la \`ENCRYPTION_KEY\` deve essere **la stessa stringa**.
I dati tornano comunque, ma i segreti cifrati dentro il database — i token
delle integrazioni — restano illeggibili, e il sintomo è un'integrazione che
smette di funzionare senza che nulla dica perché.

Vanno riportate identiche anche \`DISCORD_TOKEN\`, \`DISCORD_CLIENT_ID\`,
\`DISCORD_CLIENT_SECRET\` e \`OWNER_IDS\`. \`PUBLIC_URL\` invece cambia con la
macchina, e il nuovo indirizzo va aggiunto ai redirect OAuth2 nel Developer
Portal di Discord.
`;
}
