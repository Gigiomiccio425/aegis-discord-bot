import type { FastifyInstance } from 'fastify';
import { getPrisma } from '@angel/db';
import { parseGuildConfig } from '@angel/shared';
import { requireGuild } from '../guard.js';
import { botNonInAscolto, sendBotCommand } from '../redis.js';

/**
 * Perché la copia leggera non si può pubblicare, o `null` se si può.
 *
 * Una configurazione che non si legge vale come spenta: meglio dire «è
 * spenta» che mandare al bot un comando che poi scarta in silenzio.
 */
export function motivoCopiaFerma(config: unknown): string | null {
  const parsed = parseGuildConfig(config);
  const copia = parsed.ok ? parsed.value.general.copiaLeggera : null;
  if (!copia?.enabled) {
    return 'La copia leggera è spenta: accendila in Generale → «Copia leggera su Discord».';
  }
  if (!copia.channelId) {
    return 'Manca il canale dove pubblicare la copia leggera: sceglilo in Generale.';
  }
  return null;
}

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/backups',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const snapshots = await prisma.snapshot.findMany({
        where: { guildId: context.guildId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        // I contenuti completi pesano megabyte: nell'elenco servono solo i
        // metadati, il dettaglio si carica su richiesta.
        select: {
          id: true,
          kind: true,
          createdAt: true,
          createdBy: true,
          sizeBytes: true,
          restoredAt: true,
          restoredBy: true,
        },
      });
      return snapshots;
    },
  );

  app.get<{ Params: { guildId: string; snapshotId: string } }>(
    '/api/guilds/:guildId/backups/:snapshotId',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const snapshot = await prisma.snapshot.findUnique({
        where: { id: request.params.snapshotId },
      });
      if (!snapshot || snapshot.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'backup non trovato' });
      }
      return snapshot;
    },
  );

  /**
   * Anteprima del ripristino.
   *
   * Mostra cosa verrebbe ricreato *prima* di agire: dopo un nuke parziale,
   * ripristinare alla cieca può fare più danni dell'attacco, ricreando canali
   * che erano stati eliminati di proposito.
   */
  app.get<{ Params: { guildId: string; snapshotId: string } }>(
    '/api/guilds/:guildId/backups/:snapshotId/diff',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const prisma = getPrisma();
      const snapshot = await prisma.snapshot.findUnique({
        where: { id: request.params.snapshotId },
      });
      if (!snapshot || snapshot.guildId !== context.guildId) {
        return reply.code(404).send({ error: 'backup non trovato' });
      }

      const current = await prisma.snapshot.findFirst({
        where: { guildId: context.guildId },
        orderBy: { createdAt: 'desc' },
      });

      const snapshotRoles = (snapshot.roles as unknown as { id: string; name: string }[]) ?? [];
      const snapshotChannels = (snapshot.channels as unknown as { id: string; name: string }[]) ?? [];
      const currentRoles = (current?.roles as unknown as { id: string; name: string }[]) ?? [];
      const currentChannels = (current?.channels as unknown as { id: string; name: string }[]) ?? [];

      return {
        missingRoles: snapshotRoles.filter(
          (role) => !currentRoles.some((entry) => entry.name === role.name),
        ),
        missingChannels: snapshotChannels.filter(
          (channel) => !currentChannels.some((entry) => entry.name === channel.name),
        ),
        addedSince: {
          roles: currentRoles.filter(
            (role) => !snapshotRoles.some((entry) => entry.name === role.name),
          ),
          channels: currentChannels.filter(
            (channel) => !snapshotChannels.some((entry) => entry.name === channel.name),
          ),
        },
        note:
          'Il ripristino ricrea solo ciò che manca, confrontando per nome. ' +
          'La cronologia dei messaggi non è ripristinabile: Discord non lo consente. ' +
          'I messaggi archiviati dal bot restano consultabili nel registro.',
      };
    },
  );

  app.post<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/backups',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const ricevuto = await sendBotCommand({
        action: 'snapshot.create',
        guildId: context.guildId,
        actorId: context.user.id,
      });
      if (!ricevuto) return botNonInAscolto(reply);
      return { ok: true, note: 'Backup richiesto: comparirà nell\'elenco fra qualche secondo.' };
    },
  );

  /*
   * La copia leggera, pubblicata adesso nel suo canale.
   *
   * Se la copia è spenta, il bot lo scrive solo nei log, a livello debug: è
   * il caso normale del giro notturno, che la chiede a tutti i server. Da un
   * pulsante no — chi l'ha premuto deve sapere perché nel canale non è
   * comparso niente. Per questo il controllo si fa qui, prima di mandare il
   * comando, e la risposta dice cosa manca.
   */
  app.post<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/copia-leggera',
    async (request, reply) => {
      const context = await requireGuild(request, reply, request.params.guildId, 'ADMIN');
      if (!context) return;

      const guild = await getPrisma().guild.findUnique({
        where: { id: context.guildId },
        select: { config: true },
      });
      const motivo = motivoCopiaFerma(guild?.config ?? {});
      if (motivo) return reply.code(409).send({ error: motivo });

      const ricevuto = await sendBotCommand({ action: 'copia.leggera', guildId: context.guildId });
      if (!ricevuto) return botNonInAscolto(reply);
      return { ok: true, note: 'Richiesta inviata: la copia comparirà nel canale fra qualche secondo.' };
    },
  );
}
