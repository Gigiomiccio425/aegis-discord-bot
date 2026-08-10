/* ═══════════════════════════════════════════════════════════════════════
   REPUTAZIONE DEGLI URL

   Tre livelli, in quest'ordine:
     1. cache locale        — istantanea, evita di ripetere le stesse domande
     2. blocklist scaricate — nessuna rete al momento del controllo
     3. Google Safe Browsing — chiamata remota, con limite sul piano gratuito

   L'ordine non è casuale: le prime due coprono la stragrande maggioranza dei
   casi e lasciano il credito API per ciò che è davvero nuovo.
   ═══════════════════════════════════════════════════════════════════════ */

export interface UrlVerdict {
  malicious: boolean;
  source: string;
  detail?: string;
  /** Tipo di minaccia riportato dalla fonte. */
  threatType?: string;
}

/* ── Google Safe Browsing v4 ─────────────────────────────────────────── */

const SAFE_BROWSING_ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';

export class SafeBrowsingClient {
  constructor(
    private readonly apiKey: string,
    private readonly clientId = 'aegis-discord-bot',
    private readonly clientVersion = '0.1.0',
  ) {}

  /**
   * Interroga Safe Browsing per un lotto di URL.
   * Restituisce una mappa url → verdetto, contenente solo gli URL segnalati.
   */
  async lookup(urls: string[]): Promise<Map<string, UrlVerdict>> {
    const result = new Map<string, UrlVerdict>();
    if (urls.length === 0 || !this.apiKey) return result;

    const body = {
      client: { clientId: this.clientId, clientVersion: this.clientVersion },
      threatInfo: {
        threatTypes: [
          'MALWARE',
          'SOCIAL_ENGINEERING',
          'UNWANTED_SOFTWARE',
          'POTENTIALLY_HARMFUL_APPLICATION',
        ],
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        // Il limite per richiesta è 500 URL.
        threatEntries: urls.slice(0, 500).map((url) => ({ url })),
      },
    };

    try {
      const response = await fetch(`${SAFE_BROWSING_ENDPOINT}?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(6000),
      });

      if (!response.ok) return result;
      const data = (await response.json()) as {
        matches?: { threat: { url: string }; threatType: string; platformType: string }[];
      };

      for (const match of data.matches ?? []) {
        result.set(match.threat.url, {
          malicious: true,
          source: 'safebrowsing',
          threatType: match.threatType,
          detail: `Google Safe Browsing: ${match.threatType}`,
        });
      }
    } catch {
      // Rete assente o quota esaurita: si prosegue con le sole blocklist locali.
      // Un errore qui non deve mai bloccare la moderazione.
    }
    return result;
  }
}

/* ── Blocklist pubbliche ─────────────────────────────────────────────── */

export interface FeedSource {
  name: string;
  url: string;
  /** URL completi oppure soli domini. */
  kind: 'URL' | 'DOMAIN';
  /** Header aggiuntivi, es. la chiave abuse.ch. */
  headers?: Record<string, string>;
}

/**
 * Fonti predefinite. abuse.ch richiede una Auth-Key gratuita per i download
 * massivi: senza chiave la voce viene semplicemente saltata, il resto funziona.
 */
export function defaultFeeds(abuseChKey?: string): FeedSource[] {
  const feeds: FeedSource[] = [
    {
      name: 'phishing.database',
      url: 'https://raw.githubusercontent.com/mitchellkrogza/Phishing.Database/master/phishing-domains-ACTIVE.txt',
      kind: 'DOMAIN',
    },
    {
      name: 'openphish',
      url: 'https://openphish.com/feed.txt',
      kind: 'URL',
    },
  ];

  if (abuseChKey) {
    feeds.unshift({
      name: 'urlhaus',
      url: 'https://urlhaus.abuse.ch/downloads/text_online/',
      kind: 'URL',
      headers: { 'Auth-Key': abuseChKey },
    });
  }
  return feeds;
}

export interface FeedResult {
  source: string;
  kind: 'URL' | 'DOMAIN';
  entries: string[];
  fetchedAt: Date;
  error?: string;
}

/**
 * Scarica una blocklist. Il chiamante (il worker) la trasforma in
 * `ThreatSignature` con scadenza, così le voci rimosse dalla fonte scompaiono
 * da sole invece di restare per sempre.
 */
export async function fetchFeed(feed: FeedSource, maxEntries = 200000): Promise<FeedResult> {
  try {
    const response = await fetch(feed.url, {
      headers: { 'user-agent': 'aegis-bot/0.1', ...feed.headers },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      return {
        source: feed.name,
        kind: feed.kind,
        entries: [],
        fetchedAt: new Date(),
        error: `HTTP ${response.status}`,
      };
    }

    const text = await response.text();
    const entries: string[] = [];
    for (const line of text.split('\n')) {
      const value = line.trim();
      if (!value || value.startsWith('#')) continue;
      entries.push(feed.kind === 'DOMAIN' ? value.toLowerCase() : value);
      if (entries.length >= maxEntries) break;
    }

    return { source: feed.name, kind: feed.kind, entries, fetchedAt: new Date() };
  } catch (error) {
    return {
      source: feed.name,
      kind: feed.kind,
      entries: [],
      fetchedAt: new Date(),
      error: error instanceof Error ? error.message : 'errore sconosciuto',
    };
  }
}

/* ── Espansione degli accorciatori ───────────────────────────────────── */

/**
 * Segue i redirect senza scaricare il corpo della pagina.
 *
 * Si usa `redirect: 'manual'` e si procede un passo alla volta: seguire i
 * redirect in automatico impedirebbe di vedere la catena, e la catena è essa
 * stessa un indizio (tre accorciatori in fila non sono mai un caso).
 */
export async function expandUrl(
  url: string,
  options: { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<{ finalUrl: string; chain: string[] } | undefined> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 4000;
  const chain: string[] = [url];
  let current = url;

  for (let i = 0; i < maxRedirects; i++) {
    try {
      const response = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; aegis-bot/0.1)' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      const location = response.headers.get('location');
      if (!location) break;

      const next = new URL(location, current).toString();
      if (chain.includes(next)) break; // ciclo di redirect
      chain.push(next);
      current = next;
    } catch {
      break;
    }
  }

  if (chain.length === 1) return undefined;
  return { finalUrl: current, chain };
}
