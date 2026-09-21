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

/* ═══════════════════════════════════════════════════════════════════════
   CHI SCRIVE IN CHAT NON DEVE POTER DECIDERE CHE COSA CONTATTA IL BOT

   `expandUrl` parte da un URL che ha scritto una persona qualsiasi su
   Discord, e fa una richiesta verso quell'indirizzo. Senza controlli è un
   SSRF completo: il bot gira dentro la rete dell'Umbrel, dove rispondono
   `postgres`, `redis`, il pannello, il router, e su molti host anche
   `169.254.169.254`. Un messaggio basta per farli raggiungere da fuori —
   e la risposta non serve nemmeno: il tempo che ci mette dice già se una
   porta è aperta.

   Due dettagli che rendono inutile il controllo fatto a metà:

   • **non basta guardare il primo indirizzo.** Un host esterno, del tutto
     legittimo all'apparenza, può rispondere `Location: http://127.0.0.1:6379/`.
     Il controllo va rifatto a ogni salto, e qui il ciclo lo rifà;

   • **non basta guardare il nome.** `http://2130706433/` è `127.0.0.1`, e un
     dominio normalissimo può puntare a un indirizzo interno. Perciò si
     risolve il nome e si guardano gli indirizzi veri.

   Resta una finestra nota: fra la risoluzione e la connessione il DNS può
   cambiare risposta (rebinding). Chiuderla richiede di fissare l'indirizzo
   IP dentro la connessione, che con `fetch` non si fa. Per ridurla, qui
   basta **un solo** indirizzo privato fra quelli restituiti per rifiutare
   tutto: chi volesse passare dovrebbe controllare il DNS al millisecondo.
   ═══════════════════════════════════════════════════════════════════════ */

/** Quello che il bot non deve contattare, qualunque cosa scriva qualcuno. */
export function indirizzoPrivato(ip: string): boolean {
  const pulito = ip.replace(/^\[|\]$/g, '').toLowerCase();

  if (pulito.includes(':')) {
    // Un IPv6 che contiene un IPv4 vale quanto quell'IPv4: `::ffff:127.0.0.1`
    // e `64:ff9b::127.0.0.1` arrivano esattamente dove arriverebbe lui.
    const dentro = pulito.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dentro?.[1]) return indirizzoPrivato(dentro[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(pulito)) {
      const parti = pulito.split(':');
      const alto = parseInt(parti[3] ?? '0', 16);
      const basso = parseInt(parti[4] ?? '0', 16);
      return indirizzoPrivato(`${alto >> 8}.${alto & 255}.${basso >> 8}.${basso & 255}`);
    }

    if (pulito === '::' || pulito === '::1') return true;
    if (/^f[cd]/.test(pulito)) return true; // fc00::/7 — rete locale
    if (/^fe[89ab]/.test(pulito)) return true; // fe80::/10 — link-local
    if (pulito.startsWith('ff')) return true; // ff00::/8 — multicast
    if (pulito.startsWith('2001:db8')) return true; // documentazione
    return false;
  }

  const ottetti = pulito.split('.').map(Number);
  if (ottetti.length !== 4 || ottetti.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Non è un indirizzo che sappiamo leggere: non si contatta.
    return true;
  }
  const [a = 0, b = 0, c = 0] = ottetti;

  if (a === 0 || a === 127) return true; // questa macchina
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true; // anche le reti Docker
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local, metadati cloud
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast e riservati, fino a 255.255.255.255

  return false;
}

/** Come si risolve un nome. Separato perché i test non tocchino il DNS. */
export type Risolutore = (host: string) => Promise<string[]>;

const risolutorePredefinito: Risolutore = async (host) => {
  const { lookup } = await import('node:dns/promises');
  const trovati = await lookup(host, { all: true });
  return trovati.map((voce) => voce.address);
};

/**
 * Si può contattare questo indirizzo?
 *
 * Fallisce chiuso: se il nome non si risolve, la risposta è no. Un errore
 * qui non deve diventare il modo per aggirare il controllo.
 */
export async function destinazioneAmmessa(
  url: string,
  risolvi: Risolutore = risolutorePredefinito,
): Promise<boolean> {
  let indirizzo: URL;
  try {
    indirizzo = new URL(url);
  } catch {
    return false;
  }

  // Solo http e https. Gli altri schemi non portano da nessuna parte di
  // utile, e alcuni leggono file locali.
  if (indirizzo.protocol !== 'http:' && indirizzo.protocol !== 'https:') return false;

  const host = indirizzo.hostname.replace(/^\[|\]$/g, '');
  if (!host) return false;

  const { isIP } = await import('node:net');
  if (isIP(host) !== 0) return !indirizzoPrivato(host);

  try {
    const indirizzi = await risolvi(host);
    if (indirizzi.length === 0) return false;
    // Uno solo privato basta a rifiutare: vedi il commento sul rebinding.
    return !indirizzi.some((ip) => indirizzoPrivato(ip));
  } catch {
    return false;
  }
}

/**
 * Segue i redirect senza scaricare il corpo della pagina.
 *
 * Si usa `redirect: 'manual'` e si procede un passo alla volta: seguire i
 * redirect in automatico impedirebbe di vedere la catena, e la catena è essa
 * stessa un indizio (tre accorciatori in fila non sono mai un caso). Seguirli
 * a mano serve anche a un'altra cosa: ogni salto passa dal controllo su dove
 * sta andando, e un redirect verso la rete interna si ferma lì.
 */
export async function expandUrl(
  url: string,
  options: { maxRedirects?: number; timeoutMs?: number; risolvi?: Risolutore } = {},
): Promise<{ finalUrl: string; chain: string[] } | undefined> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 4000;
  const risolvi = options.risolvi ?? risolutorePredefinito;
  const chain: string[] = [url];
  let current = url;

  if (!(await destinazioneAmmessa(current, risolvi))) return undefined;

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
      // Il salto si controlla **prima** di farlo: è il modo con cui un host
      // esterno proverebbe a portare il bot dentro la rete di casa.
      if (!(await destinazioneAmmessa(next, risolvi))) break;
      chain.push(next);
      current = next;
    } catch {
      break;
    }
  }

  if (chain.length === 1) return undefined;
  return { finalUrl: current, chain };
}
