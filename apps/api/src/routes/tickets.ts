import path from 'node:path';
import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildTranscript, getPrisma } from '@angel/db';
import { requireGuild } from '../guard.js';

/* ═══════════════════════════════════════════════════════════════════════
   TICKET — elenco e trascrizioni dal pannello

   La trascrizione viene pubblicata anche in un canale Discord alla chiusura,
   ma quella copia condivide il destino del canale: chi ha i permessi può
   eliminarla, e la retention del server se la porta via. Questa invece sta
   su disco accanto al database, e sopravvive a entrambi.

   Serve il ruolo MOD sul pannello, non i permessi Discord: dentro un ticket
   la gente scrive cose che non scriverebbe in pubblico, e amministrare un
   server non è di per sé una ragione per rileggerle tutte.
   ═══════════════════════════════════════════════════════════════════════ */

/** Radice dei file salvati dal bot. Deve coincidere con quella del bot. */
function radiceArchivio(): string {
  return path.resolve(process.env.STORAGE_DIR ?? './storage');
}

/**
 * Risolve un percorso salvato nel database dentro la radice dell'archivio.
 *
 * `transcriptPath` viene dal database, non dalla richiesta, ma un percorso
 * che esce dalla radice resta un percorso che esce dalla radice: se un giorno
 * quel campo diventasse scrivibile da qualche altra strada, qui la lettura
 * arbitraria di file sarebbe già chiusa.
 */
function dentroArchivio(relativo: string): string | null {
  const radice = radiceArchivio();
  const assoluto = path.resolve(radice, relativo);
  const prefisso = radice.endsWith(path.sep) ? radice : radice + path.sep;
  return assoluto.startsWith(prefisso) ? assoluto : null;
}

export async function ticketRoutes(app: FastifyInstance): Promise<void> {
  /** Elenco dei ticket, con l'indicazione di chi ha una trascrizione. */
  app.get<{ Params: { guildId: string }; Querystring: Record<string, string> }>(
    '/api/guilds/:guildId/tickets',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const query = z
        .object({
          status: z.enum(['OPEN', 'CLOSED', 'ARCHIVED']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        })
        .safeParse(request.query);

      if (!query.success) return reply.code(400).send({ error: 'parametri non validi' });

      const prisma = getPrisma();
      const [tickets, aperti, chiusi] = await Promise.all([
        prisma.ticket.findMany({
          where: {
            guildId: context.guildId,
            ...(query.data.status ? { status: query.data.status } : {}),
          },
          orderBy: { number: 'desc' },
          take: query.data.limit,
        }),
        prisma.ticket.count({
          where: { guildId: context.guildId, status: 'OPEN' },
        }),
        prisma.ticket.count({ where: { guildId: context.guildId, status: 'CLOSED' } }),
      ]);

      return {
        tickets: tickets.map((ticket) => ({
          number: ticket.number,
          subject: ticket.subject,
          status: ticket.status,
          openerId: ticket.openerId,
          claimedBy: ticket.claimedBy,
          claimedAt: ticket.claimedAt,
          closedBy: ticket.closedBy,
          closedAt: ticket.closedAt,
          closeReason: ticket.closeReason,
          createdAt: ticket.createdAt,
          messageCount: ticket.messageCount,
          hasTranscript: ticket.transcriptPath !== null,
        })),
        open: aperti,
        closed: chiusi,
      };
    },
  );

  /** La trascrizione di un ticket, come file HTML. */
  app.get<{ Params: { guildId: string; number: string } }>(
    '/api/guilds/:guildId/tickets/:number/transcript',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'MOD');
      if (!context) return;

      const numero = Number.parseInt(request.params.number, 10);
      if (!Number.isInteger(numero)) {
        return reply.code(400).send({ error: 'numero non valido' });
      }

      const prisma = getPrisma();
      const ticket = await prisma.ticket.findUnique({
        where: { guildId_number: { guildId: context.guildId, number: numero } },
      });

      if (!ticket) return reply.code(404).send({ error: 'ticket inesistente' });

      const html = await leggiOppureRicostruisci(context.guildId, ticket);
      if (!html) {
        return reply.code(404).send({
          error:
            'trascrizione non disponibile: il ticket è stato chiuso prima che la funzione esistesse, ' +
            'e i suoi messaggi non sono più in archivio',
        });
      }

      await prisma.auditEvent
        .create({
          data: {
            guildId: context.guildId,
            type: 'ARCHIVE_EXPORTED',
            category: 'MODERATION',
            actorId: context.user.id,
            actorTag: context.user.tag,
            channelId: ticket.channelId,
            severity: 20,
            summary: `Trascrizione del ticket #${numero} scaricata dal pannello`,
            payload: { ticket: numero, subject: ticket.subject },
          },
        })
        .catch(() => undefined);

      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header(
          'content-disposition',
          `inline; filename="ticket-${String(numero).padStart(4, '0')}.html"`,
        )
        .send(html);
    },
  );
}

/**
 * Il file salvato alla chiusura, o una ricostruzione dall'archivio.
 *
 * La ricostruzione serve per i ticket ancora aperti — che una trascrizione
 * su disco non ce l'hanno ancora — e per quelli chiusi prima che la funzione
 * esistesse. Non è identica: mancano i dati di presa in carico e chiusura,
 * perché quelli li scrive la chiusura stessa.
 */
async function leggiOppureRicostruisci(
  guildId: string,
  ticket: {
    number: number;
    subject: string;
    channelId: string | null;
    transcriptPath: string | null;
  },
): Promise<string | null> {
  if (ticket.transcriptPath) {
    const assoluto = dentroArchivio(ticket.transcriptPath);
    if (assoluto) {
      const contenuto = await fs.readFile(assoluto, 'utf8').catch(() => null);
      if (contenuto) return contenuto;
    }
    // File sparito: si prosegue con la ricostruzione invece di rispondere
    // errore. Un disco ripulito non deve cancellare anche la possibilità di
    // leggere ciò che il database ha ancora.
  }

  if (!ticket.channelId) return null;

  const prisma = getPrisma();
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  const result = await buildTranscript({
    guildId,
    channelId: ticket.channelId,
    channelName: `ticket-${String(ticket.number).padStart(4, '0')}`,
    guildName: guild?.name ?? guildId,
    limit: 20_000,
    includeDeleted: true,
  });

  return result.messageCount > 0 ? result.html : null;
}
