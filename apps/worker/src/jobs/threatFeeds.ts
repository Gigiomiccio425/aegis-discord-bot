import type { Job } from 'bullmq';
import { getPrisma } from '@angel/db';
import { defaultFeeds, fetchFeed } from '@angel/scanner';
import { childLogger } from '../logger.js';

const log = childLogger('threatFeeds');

/**
 * Aggiornamento delle blocklist pubbliche.
 *
 * Le voci vengono salvate con una scadenza e rinnovate a ogni sincronizzazione:
 * un dominio rimosso dalla fonte smette da solo di essere bloccato, senza
 * bisogno di cancellazioni manuali. Senza scadenza, dopo qualche mese la lista
 * conterrebbe soprattutto domini ormai innocui — e i falsi positivi
 * distruggono la fiducia nel sistema più di qualche mancato blocco.
 */
export async function threatFeedProcessor(_job: Job): Promise<void> {
  if (process.env.THREAT_FEEDS_ENABLED === 'false') return;

  const prisma = getPrisma();
  const feeds = defaultFeeds(process.env.ABUSECH_AUTH_KEY);
  const expiresAt = new Date(Date.now() + 7 * 86_400_000);

  for (const feed of feeds) {
    const result = await fetchFeed(feed);
    if (result.error) {
      log.warn({ feed: feed.name, error: result.error }, 'download blocklist fallito');
      continue;
    }
    if (result.entries.length === 0) continue;

    const kind = feed.kind === 'DOMAIN' ? 'DOMAIN' : 'URL';
    let written = 0;

    // Inserimento a lotti: le liste hanno decine di migliaia di voci e una
    // transazione unica bloccherebbe la tabella per minuti.
    const BATCH = 1000;
    for (let i = 0; i < result.entries.length; i += BATCH) {
      const batch = result.entries.slice(i, i + BATCH);
      await prisma.threatSignature
        .createMany({
          data: batch.map((value) => ({
            guildId: null,
            kind,
            value: value.slice(0, 2000),
            source: feed.name,
            severity: 85,
            expiresAt,
            enabled: true,
          })),
          skipDuplicates: true,
        })
        .then((created) => {
          written += created.count;
        })
        .catch((error) => log.debug({ err: error, feed: feed.name }, 'lotto non inserito'));
    }

    // Le voci già presenti vengono rinnovate, così non scadono finché la fonte
    // continua a segnalarle.
    await prisma.threatSignature
      .updateMany({
        where: { source: feed.name, kind },
        data: { expiresAt },
      })
      .catch(() => undefined);

    log.info(
      { feed: feed.name, total: result.entries.length, nuove: written },
      'blocklist aggiornata',
    );
  }

  // Pulizia delle firme scadute: comprende sia i feed sia le firme automatiche
  // a cui è stata data una durata.
  const removed = await prisma.threatSignature.deleteMany({
    where: { expiresAt: { not: null, lt: new Date() } },
  });
  if (removed.count > 0) {
    log.info({ removed: removed.count }, 'firme scadute rimosse');
  }
}
