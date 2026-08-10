import { childLogger } from './logger.js';

const log = childLogger('feeds');

/* ═══════════════════════════════════════════════════════════════════════
   LETTURA DEI FEED

   RSS e Atom sono XML, ma i feed reali sono spesso XML *approssimativo*:
   prologhi mancanti, entità non dichiarate, namespace incoerenti. Un parser
   rigoroso fallirebbe su una parte consistente dei feed veri.

   Qui si estraggono i campi che servono con espressioni regolari mirate,
   tolleranti su ciò che sta intorno. È una scelta consapevole: per estrarre
   cinque campi da un formato semplice, la robustezza pratica conta più della
   correttezza formale, e non si porta in casa una dipendenza che va aggiornata.
   ═══════════════════════════════════════════════════════════════════════ */

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  author?: string;
  publishedAt?: Date;
  description?: string;
}

export interface Feed {
  title: string;
  items: FeedItem[];
}

/** Entità XML e HTML più comuni nei titoli. */
function decodeEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // `&amp;` per ultimo: altrimenti trasformerebbe `&amp;lt;` in `<`.
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return match?.[1] ? decodeEntities(match[1]) : undefined;
}

function attr(block: string, tagName: string, attribute: string): string | undefined {
  const match = new RegExp(`<${tagName}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, 'i').exec(block);
  return match?.[1];
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function parseFeed(xml: string): Feed {
  const isAtom = /<feed[\s>]/i.test(xml);
  const feedTitle = tag(xml.slice(0, 4000), 'title') ?? 'Feed';

  const blocks = isAtom
    ? [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0])
    : [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);

  const items: FeedItem[] = [];

  for (const block of blocks) {
    const title = tag(block, 'title') ?? '(senza titolo)';

    // Atom mette il collegamento in un attributo, RSS nel corpo del tag.
    const link = isAtom
      ? (attr(block, 'link', 'href') ?? tag(block, 'link') ?? '')
      : (tag(block, 'link') ?? attr(block, 'link', 'href') ?? '');

    // L'identificativo stabile evita i doppioni: si preferisce sempre quello
    // dichiarato dal feed, e solo in mancanza si ripiega sul collegamento.
    const id =
      tag(block, 'yt:videoId') ?? tag(block, 'id') ?? tag(block, 'guid') ?? (link || title);

    const author =
      tag(block, 'author')?.replace(/<[\s\S]*?>/g, ' ').trim() ??
      tag(block, 'dc:creator') ??
      undefined;

    const description = tag(block, 'media:description') ?? tag(block, 'description') ?? undefined;

    items.push({
      id: id.trim(),
      title,
      link: link.trim(),
      author: author?.slice(0, 100),
      publishedAt:
        parseDate(tag(block, 'published')) ??
        parseDate(tag(block, 'updated')) ??
        parseDate(tag(block, 'pubDate')),
      description: description?.replace(/<[\s\S]*?>/g, ' ').slice(0, 500),
    });
  }

  return { title: feedTitle, items };
}

export async function fetchFeed(url: string, timeoutMs = 12000): Promise<Feed | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'aegis-bot/0.1 (+https://github.com)',
        accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      log.debug({ url, status: response.status }, 'feed non raggiungibile');
      return null;
    }

    const text = await response.text();
    // Un feed enorme è quasi sempre una pagina HTML servita per errore.
    if (text.length > 5_000_000) return null;
    return parseFeed(text);
  } catch (error) {
    log.debug({ err: error, url }, 'lettura del feed fallita');
    return null;
  }
}

/* ── YouTube ──────────────────────────────────────────────────────────── */

export function youtubeFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

/**
 * Risolve un riferimento a un canale nel suo ID `UC…`.
 *
 * Accetta l'ID diretto, un `@handle`, o un URL in una qualsiasi delle quattro
 * forme che YouTube ha usato negli anni. Per handle e nomi personalizzati non
 * esiste un endpoint pubblico senza chiave API: si legge la pagina del canale,
 * dove l'ID è comunque presente nei metadati.
 */
export async function resolveYouTubeChannelId(reference: string): Promise<string | null> {
  const trimmed = reference.trim();

  if (/^UC[\w-]{20,}$/.test(trimmed)) return trimmed;

  const fromUrl = /youtube\.com\/channel\/(UC[\w-]{20,})/.exec(trimmed);
  if (fromUrl?.[1]) return fromUrl[1];

  const pageUrl = trimmed.startsWith('http')
    ? trimmed
    : `https://www.youtube.com/${trimmed.startsWith('@') ? trimmed : `@${trimmed}`}`;

  try {
    const response = await fetch(pageUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; aegis-bot/0.1)' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return null;

    const html = await response.text();
    const match =
      /"channelId":"(UC[\w-]{20,})"/.exec(html) ??
      /<meta itemprop="identifier" content="(UC[\w-]{20,})"/.exec(html) ??
      /channel\/(UC[\w-]{20,})/.exec(html);

    return match?.[1] ?? null;
  } catch (error) {
    log.debug({ err: error, reference }, 'risoluzione del canale YouTube fallita');
    return null;
  }
}

/**
 * Una diretta si riconosce dal feed solo per indizi: YouTube non espone un
 * campo dedicato. Il titolo è il segnale più affidabile, e il costo di
 * sbagliare è basso — un video annunciato come diretta, non un annuncio mancato.
 */
export function looksLive(item: FeedItem): boolean {
  return /\b(live|in diretta|streaming ora|🔴)\b/i.test(item.title);
}
