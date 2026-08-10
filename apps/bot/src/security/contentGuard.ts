import type { Client, Message } from 'discord.js';
import { getPrisma } from '@aegis/db';
import {
  decide,
  noDecision,
  Queues,
  RedisKeys,
  type Decision,
  type GuildConfig,
  type Reason,
} from '@aegis/shared';
import {
  expandUrl,
  matchPhash,
  SafeBrowsingClient,
  scanContent,
  type ScanResult,
  type ScannerDeps,
} from '@aegis/scanner';
import { Queue } from 'bullmq';
import { getRedis } from '../core/redis.js';
import { isExempt } from '../core/permissions.js';
import { childLogger } from '../core/logger.js';
import type { LogEventType } from '@aegis/shared';

const log = childLogger('contentGuard');

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|tiff)$/i;
/** Limite di download: oltre, l'analisi costa più di quanto valga. */
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;

let safeBrowsing: SafeBrowsingClient | null = null;
let deepScanQueue: Queue | null = null;

function getSafeBrowsing(): SafeBrowsingClient | null {
  if (safeBrowsing) return safeBrowsing;
  const key = process.env.GOOGLE_SAFE_BROWSING_KEY;
  if (!key) return null;
  safeBrowsing = new SafeBrowsingClient(key);
  return safeBrowsing;
}

function getDeepScanQueue(): Queue {
  deepScanQueue ??= new Queue(Queues.deepScan, { connection: getRedis() });
  return deepScanQueue;
}

/**
 * Analisi dei contenuti di un messaggio.
 *
 * Il percorso qui è quello *sincrono*: deve concludersi in poche centinaia di
 * millisecondi, perché finché non decide il messaggio resta visibile. L'OCR,
 * che costa da mezzo secondo a due secondi per immagine, viene quindi rimandato
 * al worker: se il verdetto tardivo è negativo, il messaggio viene eliminato a
 * posteriori. Meglio due secondi di esposizione che due secondi di ritardo su
 * *ogni* messaggio del server.
 */
export async function evaluateContent(
  client: Client,
  message: Message,
  config: GuildConfig,
): Promise<Decision> {
  const settings = config.scanner;
  if (!settings.enabled || !message.guild || message.author.bot) return noDecision('scanner');
  if (isExempt(message.member, settings.exemptions, message.channelId)) {
    return noDecision('scanner');
  }

  const attachments = [...message.attachments.values()];
  const hasContent =
    Boolean(message.content?.trim()) || attachments.length > 0 || message.embeds.length > 0;
  if (!hasContent) return noDecision('scanner');

  const images: { filename: string; buffer: Buffer }[] = [];
  const files: { filename: string; buffer: Buffer }[] = [];

  for (const attachment of attachments) {
    if (attachment.size > MAX_DOWNLOAD_BYTES) continue;
    const isImage = IMAGE_TYPES.test(attachment.contentType ?? '');
    if (isImage && !settings.image.enabled) continue;
    if (!isImage && !settings.file.enabled) continue;

    const buffer = await download(attachment.url);
    if (!buffer) continue;
    (isImage ? images : files).push({ filename: attachment.name, buffer });
  }

  const embedText = message.embeds.flatMap((embed) =>
    [embed.title, embed.description, embed.footer?.text, embed.author?.name, embed.url].filter(
      (value): value is string => Boolean(value),
    ),
  );

  const result = await scanContent(
    {
      text: message.content ?? '',
      embedText,
      images,
      files,
      // OCR rimandato al worker quando è attiva l'analisi differita.
      skipOcr: settings.asyncDeepScan,
    },
    settings,
    buildDeps(message.guild.id, config),
  );

  // Se restano immagini da esaminare a fondo, si accoda il lavoro.
  if (settings.asyncDeepScan && images.length > 0 && result.score < 70) {
    await queueDeepScan(message, images).catch((error) =>
      log.debug({ err: error }, 'accodamento analisi differita fallito'),
    );
  }

  await persistImageSignatures(message.guild.id, result);

  if (result.findings.length === 0) return noDecision('scanner');

  const reasons: Reason[] = result.findings.map((finding) => ({
    code: finding.code,
    detail: finding.detail,
    score: finding.score,
    meta: finding.meta,
  }));

  return decide('scanner', reasons, settings.ladder, pickEvent(result));
}

/** Sceglie l'evento più rappresentativo per il registro. */
function pickEvent(result: ScanResult): LogEventType {
  const codes = new Set(result.findings.map((finding) => finding.code));
  if (codes.has('QR_REMOTE_AUTH') || codes.has('URL_DISCORD_REMOTE_AUTH')) {
    return 'SECURITY_REMOTE_AUTH_QR';
  }
  if (codes.has('TEXT_CLICKFIX') || codes.has('OCR_CLICKFIX')) return 'SECURITY_CLICKFIX_BLOCKED';
  if (codes.has('QR_MALICIOUS_URL') || codes.has('QR_CRYPTO_ADDRESS')) return 'SECURITY_MALICIOUS_QR';
  if (codes.has('URL_IP_GRABBER')) return 'SECURITY_IP_GRABBER';
  if (
    codes.has('FILE_BLOCKED_EXTENSION') ||
    codes.has('FILE_DOUBLE_EXTENSION') ||
    codes.has('FILE_MAGIC_MISMATCH') ||
    codes.has('FILE_POLYGLOT')
  ) {
    return 'SECURITY_MALICIOUS_FILE';
  }
  if (codes.has('URL_SAFE_BROWSING') || codes.has('URL_BLOCKLIST') || codes.has('URL_HOMOGLYPH')) {
    return 'SECURITY_MALICIOUS_URL';
  }
  return 'SECURITY_SCAM_BLOCKED';
}

/**
 * Servizi esterni passati allo scanner.
 *
 * Tenerli qui, e non dentro la libreria, è ciò che permette di collaudare lo
 * scanner con file di esempio e senza rete.
 */
export function buildDeps(guildId: string, config: GuildConfig): ScannerDeps {
  const prisma = getPrisma();
  const redis = getRedis();

  return {
    async lookupUrl(url) {
      const cacheKey = RedisKeys.urlVerdict(url.slice(0, 200));
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) return JSON.parse(cached) as { malicious: boolean; source: string };

      // Prima le firme locali: nessuna rete, nessun consumo di quota.
      let host = '';
      try {
        host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      } catch {
        /* url non interpretabile */
      }

      const signature = await prisma.threatSignature.findFirst({
        where: {
          enabled: true,
          OR: [
            { kind: 'URL', value: url },
            ...(host ? [{ kind: 'DOMAIN' as const, value: host }] : []),
          ],
          AND: [{ OR: [{ guildId: null }, { guildId }] }],
        },
      });

      if (signature) {
        const verdict = {
          malicious: true,
          source: signature.source,
          detail: `Segnalato da ${signature.source}${signature.campaign ? ` (${signature.campaign})` : ''}`,
        };
        await redis.set(cacheKey, JSON.stringify(verdict), 'EX', 3600).catch(() => undefined);
        await prisma.threatSignature
          .update({
            where: { id: signature.id },
            data: { hitCount: { increment: 1 }, lastHitAt: new Date() },
          })
          .catch(() => undefined);
        return verdict;
      }

      if (!config.scanner.url.useSafeBrowsing) return undefined;
      const client = getSafeBrowsing();
      if (!client) return undefined;

      const matches = await client.lookup([url]);
      const match = matches.get(url);
      const verdict = match ?? { malicious: false, source: 'safebrowsing' };
      // Anche gli esiti negativi vanno in cache, altrimenti la quota gratuita
      // si esaurisce sui link legittimi che circolano tutto il giorno.
      await redis
        .set(cacheKey, JSON.stringify(verdict), 'EX', match ? 86400 : 21600)
        .catch(() => undefined);
      return verdict;
    },

    async lookupPhash(hash, maxDistance) {
      // Il confronto percettivo non è un'uguaglianza: non si può delegare al
      // database. Si caricano le firme attive e si misura la distanza qui.
      const signatures = await prisma.threatSignature.findMany({
        where: {
          kind: 'IMAGE_PHASH',
          enabled: true,
          OR: [{ guildId: null }, { guildId }],
        },
        select: { value: true, campaign: true, severity: true },
        take: 5000,
      });
      return matchPhash(hash, signatures, maxDistance);
    },

    async lookupFileHash(sha256) {
      const signature = await prisma.threatSignature.findFirst({
        where: {
          kind: 'FILE_SHA256',
          value: sha256,
          enabled: true,
          OR: [{ guildId: null }, { guildId }],
        },
      });
      if (!signature) return undefined;
      return { campaign: signature.campaign ?? undefined, severity: signature.severity };
    },

    async expandUrl(url) {
      if (!config.scanner.url.expandShorteners) return undefined;
      const expanded = await expandUrl(url, {
        maxRedirects: config.scanner.url.maxRedirects,
        timeoutMs: config.scanner.url.fetchTimeoutMs,
      });
      return expanded?.finalUrl;
    },

    logger: {
      debug: (message, meta) => log.debug(meta ?? {}, message),
      warn: (message, meta) => log.warn(meta ?? {}, message),
    },
  };
}

/**
 * Registra l'hash percettivo di un'immagine appena bloccata.
 *
 * È il meccanismo che fa crescere le difese con l'uso: la prima immagine di una
 * campagna costa un'analisi completa, tutte le successive — anche ricompresse o
 * ritagliate — vengono riconosciute all'istante.
 */
async function persistImageSignatures(guildId: string, result: ScanResult): Promise<void> {
  if (!result.image?.phash) return;
  if (result.score < 70) return;

  const prisma = getPrisma();
  await prisma.threatSignature
    .upsert({
      where: {
        kind_value_guildId: { kind: 'IMAGE_PHASH', value: result.image.phash, guildId },
      },
      create: {
        guildId,
        kind: 'IMAGE_PHASH',
        value: result.image.phash,
        source: 'auto',
        severity: Math.min(90, result.score),
        description: result.findings.map((finding) => finding.code).join(', '),
      },
      update: { hitCount: { increment: 1 }, lastHitAt: new Date() },
    })
    .catch(() => undefined);
}

async function queueDeepScan(
  message: Message,
  images: { filename: string; buffer: Buffer }[],
): Promise<void> {
  await getDeepScanQueue().add(
    'image',
    {
      guildId: message.guild!.id,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      text: message.content?.slice(0, 2000) ?? '',
      images: images.map((image) => ({
        filename: image.filename,
        // Base64: la coda non trasporta Buffer nativi.
        data: image.buffer.toString('base64'),
      })),
    },
    { removeOnComplete: 100, removeOnFail: 500, attempts: 2 },
  );
}

async function download(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_DOWNLOAD_BYTES) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}
