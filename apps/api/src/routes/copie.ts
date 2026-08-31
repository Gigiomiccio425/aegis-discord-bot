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
import { ownerIds, type SessionUser } from '../auth.js';
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
  // Solo nei kit di trasloco. Contiene i segreti in chiaro: viene servito
  // come allegato e mai mostrato nel browser, così non finisce nella
  // cronologia come pagina visitata.
  trasloco: { file: 'TRASLOCO.txt', tipo: 'text/plain; charset=utf-8' },
};

const PREFISSO = 'angel-';
const PREFISSO_TRASLOCO = 'trasloco-';

/**
 * Nome di cartella accettabile.
 *
 * Il nome arriva dall'URL e viene concatenato a un percorso su disco: senza
 * questo, `../../etc/passwd` sarebbe un nome di copia perfettamente valido.
 * L'elenco dei caratteri ammessi è chiuso, non aperto — è l'unico modo di
 * scrivere un controllo del genere che regga anche alle codifiche che non si
 * erano previste.
 */
const NOME_VALIDO =
  /^(angel|trasloco)-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}$/;

function radice(): string {
  return path.resolve(process.env.BACKUP_DIR ?? '/backup');
}

interface Riepilogo {
  nome: string;
  /** `copia` è il backup notturno, `trasloco` è il kit con dentro le variabili. */
  tipo: 'copia' | 'trasloco';
  quando: string | null;
  versione: string | null;
  righe: number;
  tabelle: number;
  archivio: { incluso: boolean; file: number; byte: number; motivo?: string };
  byte: number;
  /** Vero se questa copia è già stata usata per un ripristino. */
  ripristinata: boolean;
  /**
   * Vero se la cartella contiene TRASLOCO.txt, cioè segreti in chiaro.
   *
   * Il pannello lo usa per dirlo a chi guarda: una cartella che contiene il
   * token del bot non deve essere indistinguibile da una che non lo contiene.
   */
  conSegreti: boolean;
  /** Parti scaricabili effettivamente presenti. */
  parti: string[];
  errori: string[];
}

/**
 * Chi possiede il bot. Non basta amministrare un server.
 *
 * Restituisce l'utente e non un booleano perché chi registra un'azione delicata
 * — preparare un kit con i segreti, cancellare una copia — deve poter scrivere
 * *chi* l'ha fatta senza rileggersi la sessione una seconda volta.
 */
async function requireOwner(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionUser | null> {
  const user = await requireUser(request, reply);
  if (!user) return null;

  if (!ownerIds().includes(user.id)) {
    await reply.code(403).send({
      error:
        'solo chi possiede il bot può vedere le copie complete: contengono i dati di tutti i server',
    });
    return null;
  }
  return user;
}

async function leggiRiepilogo(nome: string): Promise<Riepilogo | null> {
  const cartella = path.join(radice(), nome);
  const stato = await fs.stat(cartella).catch(() => null);
  if (!stato?.isDirectory()) return null;

  const riepilogo: Riepilogo = {
    nome,
    tipo: nome.startsWith(PREFISSO_TRASLOCO) ? 'trasloco' : 'copia',
    quando: null,
    versione: null,
    righe: 0,
    tabelle: 0,
    archivio: { incluso: false, file: 0, byte: 0 },
    byte: 0,
    ripristinata: false,
    conSegreti: false,
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
      if (chiave === 'trasloco') riepilogo.conSegreti = true;
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
      .filter(
        (voce) =>
          voce.isDirectory() &&
          (voce.name.startsWith(PREFISSO) || voce.name.startsWith(PREFISSO_TRASLOCO)),
      )
      .map((voce) => voce.name)
      // Ordinate per data e non per nome: ordinando per nome tutti i kit
      // finirebbero da una parte e tutte le copie dall'altra, e la domanda a
      // cui questo elenco deve rispondere — «qual è la più recente?» — non
      // avrebbe più una risposta a colpo d'occhio.
      .sort((a, b) => b.slice(b.indexOf('-') + 1).localeCompare(a.slice(a.indexOf('-') + 1)));

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
   * Prepara il kit di trasloco.
   *
   * Una copia come le altre, più un `TRASLOCO.txt` con dentro **i valori** da
   * riportare sulla macchina nuova: token, chiavi, identificativi. Senza quelli
   * i dati da soli non fanno ripartire nulla, e stanno nel compose della
   * macchina vecchia — cioè nella cosa che durante un trasloco potrebbe non
   * esserci più.
   *
   * Non è programmato e non gira di notte: scrivere segreti su disco è una
   * decisione, e le decisioni si prendono una volta, non ogni ventiquattro ore.
   */
  app.post<{ Body?: { conSegreti?: boolean } }>('/api/copie/trasloco', async (request, reply) => {
    const utente = await requireOwner(request, reply);
    if (!utente) return;

    const conSegreti = request.body?.conSegreti ?? true;

    try {
      const coda = new Queue(Queues.selfBackup, { connection: getRedis() });
      await coda.add(
        'trasloco',
        { trasloco: true, conSegreti },
        { removeOnComplete: 5, removeOnFail: 20 },
      );
      await coda.close();

      // A livello `warn` di proposito: scrivere il token del bot su disco è
      // un'azione che deve lasciare una traccia visibile anche a chi guarda i
      // log distrattamente.
      logger.warn({ utente: utente.id, conSegreti }, 'kit di trasloco richiesto dal pannello');
      return { accodata: true, conSegreti };
    } catch (errore) {
      logger.error({ err: errore }, 'kit di trasloco non accodato');
      return reply.code(503).send({
        error: 'Redis non risponde: il kit non è stato messo in coda',
      });
    }
  });

  /**
   * Elimina una copia o un kit.
   *
   * Esiste soprattutto per i kit: contengono il token del bot in chiaro, e
   * l'unico modo perché vengano cancellati davvero è che cancellarli costi un
   * clic. Un'istruzione in fondo a un file di testo, letta a trasloco finito
   * quando tutto funziona, non la esegue nessuno.
   */
  app.delete<{ Params: { nome: string } }>('/api/copie/:nome', async (request, reply) => {
    const utente = await requireOwner(request, reply);
    if (!utente) return;

    const { nome } = request.params;
    if (!NOME_VALIDO.test(nome)) {
      return reply.code(400).send({ error: 'nome di copia non valido' });
    }

    const percorso = path.join(radice(), nome);
    if (!percorso.startsWith(radice() + path.sep)) {
      return reply.code(400).send({ error: 'percorso non valido' });
    }

    const stato = await fs.stat(percorso).catch(() => null);
    if (!stato?.isDirectory()) {
      return reply.code(404).send({ error: 'copia non trovata' });
    }

    await fs.rm(percorso, { recursive: true, force: true });
    logger.warn({ cartella: nome, utente: utente.id }, 'copia eliminata dal pannello');
    return { eliminata: nome };
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
