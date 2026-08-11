import type { Job } from 'bullmq';
import { getPrisma } from '@angel/db';
import { RedisKeys } from '@angel/shared';
import { getRedis } from '../redis.js';
import { childLogger } from '../logger.js';

const log = childLogger('snapshot');

/**
 * Backup programmati.
 *
 * Il worker non li esegue direttamente: pubblica la richiesta e il bot la
 * raccoglie. Il motivo è pratico — uno snapshot ha bisogno di ruoli, canali,
 * permessi e ruoli dei membri, cioè esattamente ciò che il bot tiene già in
 * cache dal gateway. Ricostruire tutto via REST significherebbe centinaia di
 * chiamate e una seconda implementazione da tenere allineata.
 */
export async function snapshotProcessor(_job: Job): Promise<void> {
  const prisma = getPrisma();
  const redis = getRedis();

  const guilds = await prisma.guild.findMany({
    where: { active: true },
    select: { id: true },
  });

  for (const guild of guilds) {
    // Se esiste già uno snapshot delle ultime 12 ore si salta: un riavvio del
    // worker non deve produrre backup a raffica.
    const recent = await prisma.snapshot.findFirst({
      where: {
        guildId: guild.id,
        kind: 'SCHEDULED',
        createdAt: { gte: new Date(Date.now() - 12 * 3_600_000) },
      },
      select: { id: true },
    });
    if (recent) continue;

    await redis.publish(
      RedisKeys.commandChannel,
      JSON.stringify({ action: 'snapshot.create', guildId: guild.id, actorId: 'system' }),
    );
  }

  log.info({ guilds: guilds.length }, 'backup programmati richiesti');

  await pruneOldSnapshots();
}

/**
 * Conserva gli ultimi 30 backup per server.
 *
 * Uno snapshot con i ruoli dei membri di un server grande pesa parecchi
 * megabyte: senza potatura il database cresce senza limite, e i backup più
 * vecchi di un mese non servono comunque a nulla — la struttura del server nel
 * frattempo è cambiata.
 */
async function pruneOldSnapshots(): Promise<void> {
  const prisma = getPrisma();
  const guilds = await prisma.guild.findMany({ where: { active: true }, select: { id: true } });

  for (const guild of guilds) {
    const keep = await prisma.snapshot.findMany({
      where: { guildId: guild.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true },
    });
    if (keep.length < 30) continue;

    const removed = await prisma.snapshot.deleteMany({
      where: {
        guildId: guild.id,
        id: { notIn: keep.map((entry) => entry.id) },
        // I backup d'emergenza restano: sono quelli scattati durante un
        // attacco, cioè i più preziosi in assoluto.
        kind: { notIn: ['EMERGENCY'] },
      },
    });
    if (removed.count > 0) {
      log.debug({ guildId: guild.id, removed: removed.count }, 'backup vecchi rimossi');
    }
  }
}
