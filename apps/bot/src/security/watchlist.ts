/* ═══════════════════════════════════════════════════════════════════════
   UTENTI ATTENZIONATI

   Il caso che questo modulo copre è quello a metà: un moderatore ha un
   sospetto ma non prove. Sanzionare sarebbe ingiusto, lasciar perdere
   significa accorgersene quando il danno è fatto.

   Attenzionare non toglie nulla a nessuno — l'utente non se ne accorge, non
   perde permessi, non viene limitato. Cambia solo la visibilità: ogni sua
   azione finisce in evidenza nel registro e nel canale degli alert, così chi
   sorveglia legge dieci righe invece di cercarle fra diecimila.

   L'elenco è tenuto in un insieme Redis perché viene consultato a **ogni
   evento registrato**: una query al database per messaggio sarebbe il modo più
   rapido di rendere lento tutto il registro. Il database resta la fonte di
   verità, Redis è solo la copia da leggere in fretta.
   ═══════════════════════════════════════════════════════════════════════ */

import { getPrisma } from '@angel/db';
import { getRedis } from '../core/redis.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('watchlist');

const key = (guildId: string): string => `watch:${guildId}`;
/** L'insieme si ricostruisce da solo dopo la scadenza: nessun disallineamento permanente. */
const CACHE_TTL_SEC = 900;

export interface WatchEntry {
  userId: string;
  reason: string | null;
  since: Date;
  by: string | null;
  expiresAt: Date | null;
}

/** Mette un utente sotto sorveglianza. `hours` a 0 significa a tempo indeterminato. */
export async function watchUser(
  guildId: string,
  userId: string,
  actorId: string,
  reason: string,
  hours = 0,
): Promise<void> {
  const prisma = getPrisma();
  const data = {
    watchedAt: new Date(),
    watchedBy: actorId,
    watchReason: reason.slice(0, 500),
    watchExpiresAt: hours > 0 ? new Date(Date.now() + hours * 3600_000) : null,
  };

  await prisma.userProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, ...data },
    update: data,
  });

  await invalidate(guildId);
}

export async function unwatchUser(guildId: string, userId: string): Promise<boolean> {
  const prisma = getPrisma();
  const updated = await prisma.userProfile.updateMany({
    where: { guildId, userId, watchedAt: { not: null } },
    data: { watchedAt: null, watchedBy: null, watchReason: null, watchExpiresAt: null },
  });
  await invalidate(guildId);
  return updated.count > 0;
}

export async function listWatched(guildId: string): Promise<WatchEntry[]> {
  const prisma = getPrisma();
  const rows = await prisma.userProfile.findMany({
    where: { guildId, watchedAt: { not: null } },
    orderBy: { watchedAt: 'desc' },
    select: {
      userId: true,
      watchReason: true,
      watchedAt: true,
      watchedBy: true,
      watchExpiresAt: true,
    },
  });

  return rows
    .filter((row) => !row.watchExpiresAt || row.watchExpiresAt > new Date())
    .map((row) => ({
      userId: row.userId,
      reason: row.watchReason,
      since: row.watchedAt!,
      by: row.watchedBy,
      expiresAt: row.watchExpiresAt,
    }));
}

/**
 * L'utente è attenzionato?
 *
 * Chiamata a ogni evento registrato, quindi risponde da Redis. L'insieme vuoto
 * è memorizzato come un segnaposto: senza, un server senza attenzionati
 * interrogherebbe il database a ogni singolo messaggio, che è esattamente il
 * caso più frequente.
 */
export async function isWatched(guildId: string, userId: string): Promise<boolean> {
  const redis = getRedis();
  const set = key(guildId);

  try {
    if ((await redis.exists(set)) === 1) {
      return (await redis.sismember(set, userId)) === 1;
    }

    const watched = await listWatched(guildId);
    const members = watched.map((entry) => entry.userId);
    // Il segnaposto non è un ID valido — 20 cifre al massimo per uno snowflake —
    // quindi non può mai corrispondere a un utente vero.
    await redis.sadd(set, ...(members.length > 0 ? members : ['-']));
    await redis.expire(set, CACHE_TTL_SEC);
    return members.includes(userId);
  } catch (error) {
    log.debug({ err: error, guildId }, 'lettura della sorveglianza fallita');
    return false;
  }
}

async function invalidate(guildId: string): Promise<void> {
  await getRedis().del(key(guildId)).catch(() => undefined);
}
