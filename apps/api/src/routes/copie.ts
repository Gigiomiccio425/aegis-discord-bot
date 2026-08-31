/* ═══════════════════════════════════════════════════════════════════════
   COPIE DELL'INSTALLAZIONE

   Le copie complete che il worker produce ogni notte in `BACKUP_DIR`: elenco,
   creazione su richiesta, e soprattutto **scaricamento**.

   Lo scaricamento è la parte che conta. Una copia che vive solo sul server di
   cui è la copia protegge da un volume cancellato per sbaglio e da nient'altro:
   non dal disco che muore, non dalla macchina che non si accende più, non dal
   fornitore che chiude. Poterla tirare giù dal browser significa che una
   seconda copia esiste da qualche altra parte senza dover aprire un terminale.

   Non sono i backup del *server Discord* — quelli sono gli snapshot di ruoli e
   canali, e stanno in `backups.ts`. Qui c'è l'installazione intera: database,
   configurazione, registro, archivio, trascrizioni.

   Rotte riservate a chi possiede il bot, non agli amministratori dei singoli
   server: questa copia contiene i dati di **tutti** i server dove il bot è
   presente, e chi amministra uno di essi non ha alcun titolo per leggere gli
   altri.
   ═══════════════════════════════════════════════════════════════════════ */

import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Queue } from 'bullmq';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Queues } from '@angel/shared';
import { ownerIds } from '../auth.js';
import { requireUser } from '../guard.js';
import { getRedis } from '../redis.js';
import { logger } from '../logger.js';

/** Nomi dei file dentro una cartella di copia. Duplicati dal worker di proposito:
 *  l'API non dipende dal worker, e sono quattro costanti che non cambiano. */
const SCARICABILI: Record<string, { file: string; tipo: string }> = {
  dati: { file: 'dati.tar.gz', tipo: 'application/gzip' },
  archivio: { file: 'archivio.tar.gz', tipo: 'application/gzip' },
  manifesto: { file: 'MANIFESTO.json', tipo: 'application/json' },
  istruzioni: { file: 'ISTRUZIONI.md', tipo: 'text/markdown; charset=utf-8' },
};

const PREFISSO = 'angel-';

/**
 * Nome di cartella accettabile.
 *
 * Il nome arriva dall'URL e viene concatenato a un percorso su disco: senza
 * questo, `../../etc/passwd` sarebbe un nome di copia perfettamente valido.
 * L'elenco dei caratteri ammessi è chiuso, non aperto — è l'unico modo di
 * scrivere un controllo del genere che regga anche alle codifiche che non si
 * erano previste.
 */
const NOME_VALIDO = /^angel-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}$/;

function radice(): string {
  return path.resolve(process.env.BACKUP_DIR ?? '/backup');
}

interface Riepilogo {
  nome: string;
  quando: string | null;
  versione: string | null;
  righe: number;
  tabelle: number;
  archivio: { incluso: boolean; file: number; byte: number; motivo?: string };
  byte: number;
  /** Vero se questa copia è già stata usata per un ripristino. */
  ripristinata: boolean;
  /** Parti scaricabili effettivamente presenti. */
  parti: string[];
  errori: string[];
}

/** Chi possiede il bot. Non basta amministrare un server. */
async function requireOwner(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const user = await requireUser(request, reply);
  if (!user) return false;

  if (!ownerIds().includes(user.id)) {
    await reply.code(403).send({
      error:
        'solo chi possiede il bot può vedere le copie complete: contengono i dati di tutti i server',
    });
    return false;
  }
  return true;
}

async function leggiRiepilogo(nome: string): Promise<Riepilogo | null> {
  const cartella = path.join(radice(), nome);
  const stato = await fs.stat(cartella).catch(() => null);
  if (!stato?.isDirectory()) return null;

  const riepilogo: Riepilogo = {
    nome,
    quando: null,
    versione: null,
    righe: 0,
    tabelle: 0,
    archivio: { incluso: false, file: 0, byte: 0 },
    byte: 0,
    ripristinata: false,
    parti: [],
    errori: [],
  };

  const manifesto = await fs
    .readFile(path.join(cartella, 'MANIFESTO.json'), 'utf8')
    .then((testo) => JSON.parse(testo) as Record<string, unknown>)
    .catch(() => null);

  if (manifesto) {
    riepilogo.quando = (manifesto.quando as string) ?? null;
    riepilogo.versione = (manifesto.versione as string) ?? null;
    riepilogo.righe = (manifesto.totaleRighe as number) ?? 0;
    riepilogo.tabelle = Object.keys((manifesto.righe as object) ?? {}).length;
    riepilogo.archivio = (manifesto.archivio as Riepilogo['archivio']) ?? riepilogo.archivio;
    riepilogo.errori = (manifesto.errori as string[]) ?? [];
  } else {
    // Senza manifesto la cartella non è ripristinabile. Compare lo stesso
    // nell'elenco, con zero righe: nasconderla significherebbe che chi la vede
    // sul disco e non nel pannello si chiede quale dei due sta mentendo.
    riepilogo.errori.push('MANIFESTO.json mancante o illeggibile');
  }

  for (const [chiave, { file }] of Object.entries(SCARICABILI)) {
    const info = await fs.stat(path.join(cartella, file)).catch(() => null);
    if (info) {
      riepilogo.parti.push(chiave);
      riepilogo.byte += info.size;
    }
  }

  riepilogo.ripristinata = await fs
    .access(path.join(cartella, 'RIPRISTINATO'))
    .then(() => true)
    .catch(() => false);

  return riepilogo;
}

export async function copieRoutes(app: FastifyInstance): Promise<void> {
  /** Elenco delle copie presenti, dalla più recente. */
  app.get('/api/copie', async (request, reply) => {
    if (!(await requireOwner(request, reply))) return;

    const cartella = radice();
    const voci = await fs.readdir(cartella, { withFileTypes: true }).catch(() => null);

    if (!voci) {
      // Non è un errore del pannello: è che la cartella non è montata. Dirlo
      // è più utile di un elenco vuoto, che si legge come «non ci sono copie»
      // — la conclusione sbagliata, e la più tranquillizzante.
      return reply.code(200).send({
        cartella,
        montata: false,
        copie: [],
        avviso:
          `${cartella} non esiste o non è leggibile. Nel compose deve esserci un volume ` +
          'che la monta da una cartella dell’host, fuori dai volumi dell’applicazione.',
      });
    }

    const nomi = voci
      .filter((voce) => voce.isDirectory() && voce.name.startsWith(PREFISSO))
      .map((voce) => voce.name)
      .sort()
      .reverse();

    const copie = (await Promise.all(nomi.map((nome) => leggiRiepilogo(nome)))).filter(
      (copia): copia is Riepilogo => copia !== null,
    );

    return { cartella, montata: true, copie };
  });

  /**
   * Chiede una copia adesso.
   *
   * Il lavoro vero lo fa il worker: l'API non ha il client Prisma aperto sulle
   * ventisette tabelle né la voglia di tenere in vita una richiesta HTTP per i
   * minuti che un'esportazione può richiedere. Qui si mette in coda e si
   * risponde; il risultato compare nell'elenco quando è pronto.
   */
  app.post('/api/copie', async (request, reply) => {
    if (!(await requireOwner(request, reply))) return;

    try {
      const coda = new Queue(Queues.selfBackup, { connection: getRedis() });
      await coda.add('manuale', {}, { removeOnComplete: 10, removeOnFail: 20 });
      await coda.close();
      return { accodata: true };
    } catch (errore) {
      logger.error({ err: errore }, 'copia manuale non accodata');
      return reply.code(503).send({
        error: 'Redis non risponde: la copia non è stata messa in coda',
      });
    }
  });

  /**
   * Scarica una parte di una copia.
   *
   * `dati` sono pochi megabyte, `archivio` può essere gigabyte: si mandano in
   * streaming, senza passare per la memoria del processo. Un `readFile` di un
   * archivio da due giga farebbe morire il pannello proprio mentre si cerca di
   * salvare i dati.
   */
  app.get<{ Params: { nome: string; parte: string } }>(
    '/api/copie/:nome/:parte',
    async (request, reply) => {
      if (!(await requireOwner(request, reply))) return;

      const { nome, parte } = request.params;
      if (!NOME_VALIDO.test(nome)) {
        return reply.code(400).send({ error: 'nome di copia non valido' });
      }

      const scaricabile = SCARICABILI[parte];
      if (!scaricabile) {
        return reply.code(404).send({
          error: `parte sconosciuta: ammesse ${Object.keys(SCARICABILI).join(', ')}`,
        });
      }

      const percorso = path.join(radice(), nome, scaricabile.file);
      // Cintura oltre alle bretelle: anche se la regex sopra dovesse un giorno
      // allentarsi, il percorso risolto deve restare dentro la cartella delle
      // copie.
      if (!percorso.startsWith(radice() + path.sep)) {
        return reply.code(400).send({ error: 'percorso non valido' });
      }

      const stato = await fs.stat(percorso).catch(() => null);
      if (!stato?.isFile()) {
        return reply.code(404).send({ error: `${scaricabile.file} non presente in questa copia` });
      }

      return reply
        .type(scaricabile.tipo)
        .header('content-length', String(stato.size))
        .header('content-disposition', `attachment; filename="${nome}-${scaricabile.file}"`)
        .send(createReadStream(percorso));
    },
  );
}
