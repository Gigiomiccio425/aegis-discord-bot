/* ═══════════════════════════════════════════════════════════════════════
   Versione in esecuzione e disponibilità di aggiornamenti.

   L'immagine porta la propria versione in `ANGEL_VERSION`, scritta dalla CI
   a partire dal tag git. Il confronto con l'ultima release pubblicata su
   GitHub avviene qui e non nel browser: il pannello è raggiungibile solo dal
   tailnet, quindi una chiamata dal browser verso api.github.com funzionerebbe
   comunque, ma passando dal server la risposta si può mettere in cache una
   volta per tutti e non una volta per ogni scheda aperta.

   Se GitHub non risponde — rete assente, rate limit, repository privata — la
   rotta restituisce comunque la versione locale con `latest: null`. Sapere
   cosa sta girando è utile anche quando il confronto non è possibile.
   ═══════════════════════════════════════════════════════════════════════ */

import type { FastifyInstance } from 'fastify';
import { getSessionUser } from '../auth.js';
import { getRedis } from '../redis.js';
import { readServiceVersions, runningVersion } from '@angel/shared';
import { logger } from '../logger.js';

const REPO = 'Gigiomiccio425/aegis-discord-bot';
const CACHE_KEY = 'panel:ultima-release';
/** Sei ore: le release sono rare e il rate limit anonimo di GitHub è 60/ora. */
const CACHE_TTL = 6 * 3600;

interface Release {
  tag: string;
  publishedAt: string | null;
  url: string;
  notes: string | null;
}

/**
 * Confronto semver fra due tag, indulgente su ciò che non è un numero.
 *
 * Restituisce true se `candidate` è più recente di `current`. Un confronto
 * fra stringhe non basterebbe: `1.10.0` verrebbe considerato precedente a
 * `1.9.0`, e l'aggiornamento più importante sarebbe proprio quello nascosto.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isNaN(part) ? 0 : part));

  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

async function fetchLatestRelease(): Promise<Release | null> {
  const redis = getRedis();
  const cached = await redis.get(CACHE_KEY);
  if (cached) return JSON.parse(cached) as Release;

  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'aegis-panel' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      tag_name: string;
      published_at: string | null;
      html_url: string;
      body: string | null;
    };
    const release: Release = {
      tag: body.tag_name,
      publishedAt: body.published_at,
      url: body.html_url,
      // Le note complete di una release possono essere lunghissime: nel
      // pannello ne serve un estratto, il resto sta dietro il link.
      notes: body.body?.slice(0, 4000) ?? null,
    };
    await redis.set(CACHE_KEY, JSON.stringify(release), 'EX', CACHE_TTL);
    return release;
  } catch (error) {
    logger.warn({ err: error }, 'controllo aggiornamenti non riuscito');
    return null;
  }
}

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/version', async (request, reply) => {
    const session = await getSessionUser(request);
    if (!session) return reply.code(401).send({ error: 'non autenticato' });

    const running = runningVersion();
    const [latest, services] = await Promise.all([
      fetchLatestRelease(),
      readServiceVersions(getRedis(), running),
    ]);

    return {
      running,
      // Versione di ciascun processo. Un aggiornamento può ricrearne tre su
      // quattro: da fuori sembra riuscito, mentre un pezzo continua a girare
      // con il codice di prima e la correzione appena installata sembra non
      // funzionare.
      services: services.services,
      aligned: services.aligned,
      stale: services.stale,
      latest: latest?.tag ?? null,
      publishedAt: latest?.publishedAt ?? null,
      url: latest?.url ?? `https://github.com/${REPO}/releases`,
      notes: latest?.notes ?? null,
      // Su un'immagine costruita dal ramo principale la versione è `main` o un
      // hash: non è confrontabile con un tag, e segnalare un aggiornamento
      // sarebbe fuorviante. Il confronto si fa solo fra versioni numerate.
      updateAvailable: Boolean(latest && /^v?\d/.test(running) && isNewer(latest.tag, running)),
    };
  });
}
