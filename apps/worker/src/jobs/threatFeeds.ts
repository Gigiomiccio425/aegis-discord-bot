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
/**
 * Quante voci si tengono per fonte.
 *
 * Phishing.Database da sola ne pubblica oltre un milione. Tenerle tutte non
 * rende il bot più sicuro in proporzione — i domini che compaiono davvero in
 * una chat Discord sono nella parte alta di ogni lista — mentre costa spazio,
 * indici e, come si è visto, disco pieno.
 */
const MAX_VOCI = Number(process.env.THREAT_FEED_MAX ?? 150_000);

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
    const voci = result.entries.slice(0, MAX_VOCI);
    let written = 0;

    // Inserimento a lotti: le liste hanno decine di migliaia di voci e una
    // transazione unica bloccherebbe la tabella per minuti.
    const BATCH = 1000;
    for (let i = 0; i < voci.length; i += BATCH) {
      const batch = voci.slice(i, i + BATCH);
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

    /*
     * Rinnovo della scadenza **solo per ciò che sta per scadere**.
     *
     * Prima si rinnovava tutto a ogni giro. Con un milione di voci e un giro
     * all'ora significa un milione di righe riscritte ogni ora: Postgres non
     * modifica una riga, ne scrive una nuova e lascia la vecchia da ripulire.
     * Il risultato è stato una tabella cresciuta fino a riempire il disco, un
     * WAL da mezzo giga ogni tre secondi, e da lì Redis che non riusciva più a
     * salvare e bloccava le scritture di tutti.
     *
     * Con la scadenza a sette giorni e il controllo ogni sei ore, qui non
     * viene riscritto quasi mai nulla: solo la coda che sta per scadere.
     */
    const soglia = new Date(Date.now() + 2 * 86_400_000);
    const rinnovate = await prisma.threatSignature
      .updateMany({
        where: { source: feed.name, kind, expiresAt: { lt: soglia } },
        data: { expiresAt },
      })
      .catch(() => ({ count: 0 }));

    log.info(
      {
        feed: feed.name,
        total: result.entries.length,
        tenute: voci.length,
        nuove: written,
        rinnovate: rinnovate.count,
      },
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
