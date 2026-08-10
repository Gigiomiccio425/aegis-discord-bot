import { normalize, nameSimilarity, hasHomoglyphs } from '@aegis/shared';
import type { ExtractedUrl, Finding } from './types.js';

/* ═══════════════════════════════════════════════════════════════════════
   ESTRAZIONE E ANALISI DEGLI URL

   Chi diffonde link malevoli sa che i bot cercano `http`. Perciò scrive
   `hxxps://`, `esempio[.]com`, `esem pio.com`, o infila caratteri a larghezza
   zero in mezzo al dominio. Qui il testo viene prima riportato in chiaro e poi
   analizzato: cercare direttamente `https?://` lascerebbe passare la metà dei
   casi reali.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Caratteri a larghezza zero e marcatori direzionali usati per spezzare i
 * domini. Scritti con le sequenze di escape e non con i caratteri letterali:
 * altrimenti sarebbero invisibili anche nel codice sorgente, e nessuno potrebbe
 * verificare o modificare questo elenco.
 */
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Accorciatori: la destinazione va risolta prima di poter giudicare il link. */
const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'lnkd.in',
  's.id', 'v.gd', 'clck.ru', 'shorte.st', 'adf.ly', 'bl.ink', 'urlz.fr',
  'short.gy', 'tr.ee', 'linktr.ee', 'l.ink',
]);

/**
 * Domini che raccolgono l'indirizzo IP di chi clicca. Il bot non può ottenere
 * l'IP di nessuno tramite l'API Discord, ma questi link sì — ed è da lì che
 * partono le ritorsioni DDoS nate da litigi in chat.
 */
const IP_GRABBERS = new Set([
  'grabify.link', 'iplogger.org', 'iplogger.com', 'iplogger.ru', 'blasze.com',
  'blasze.tk', '2no.co', 'yip.su', 'iplis.ru', 'ipgrabber.ru', 'ps3cfw.com',
  'stopify.co', 'curiouscat.club', 'gyazo.nl', 'lovebird.guru', 'trulove.guru',
  'dogechat.net', 'catsnthing.com', 'catsnthings.fun', 'joinmy.site',
]);

/** Estensioni che non hanno alcuna ragione di essere scaricate da una chat. */
const EXECUTABLE_EXT = /\.(exe|scr|com|pif|bat|cmd|vbs|vbe|jse?|wsf|wsh|msi|msp|hta|cpl|jar|lnk|ps1|reg|apk|dll|sys|iso|img)($|\?)/i;

/** Host della CDN Discord, usati per distribuire payload con apparenza legittima. */
const DISCORD_CDN_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'cdn.discord.com',
]);

const URL_PATTERN =
  /\b((?:https?|hxxps?|ftp):\/\/|www\.)[^\s<>"'`]+|\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}(?:\/[^\s<>"'`]*)?/gi;

/**
 * Riporta in chiaro le forme di offuscamento più diffuse.
 * Restituisce anche se qualcosa è stato effettivamente modificato: un link
 * scritto in modo offuscato è già di per sé un segnale.
 */
export function deobfuscate(text: string): { text: string; changed: boolean } {
  const before = text;
  const out = text
    .replace(ZERO_WIDTH, '')
    .replace(/\bh(?:x{2}|X{2})p(s?)\b/gi, 'http$1')
    .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}/g, '.')
    .replace(/\s+\(?dot\)?\s+/gi, '.')
    .replace(/\s+punto\s+/gi, '.')
    .replace(/\[\s*:\s*\]/g, ':')
    .replace(/\[\s*\/\s*\]/g, '/')
    .replace(/(?<=\w)\s+\.\s+(?=\w)/g, '.');
  return { text: out, changed: out !== before };
}

/** Aggiunge lo schema mancante e taglia la punteggiatura finale incollata al link. */
function canonicalize(raw: string): string | null {
  let candidate = raw.trim().replace(/[.,;:!?)\]}'"]+$/, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Estrae tutti gli URL da un testo, comprese le forme offuscate. */
export function extractUrls(
  text: string,
  origin: ExtractedUrl['origin'] = 'TEXT',
): ExtractedUrl[] {
  if (!text) return [];
  const { text: clean, changed } = deobfuscate(text);
  const found = new Map<string, ExtractedUrl>();

  for (const match of clean.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const url = canonicalize(raw);
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (found.has(url)) continue;
    found.set(url, { raw, url, host, wasObfuscated: changed, origin });
  }
  return [...found.values()];
}

export function isShortener(host: string): boolean {
  return SHORTENERS.has(host.replace(/^www\./, ''));
}

export function isIpGrabber(host: string, extra: string[] = []): boolean {
  const h = host.replace(/^www\./, '');
  return IP_GRABBERS.has(h) || extra.includes(h);
}

/**
 * Flusso Remote Auth di Discord: `discord.com/ra/<token>`.
 *
 * È il meccanismo del login tramite QR. Chi inquadra un QR di questo tipo non
 * digita nulla e non vede alcuna schermata di conferma — è Discord stesso a
 * consegnare il token di sessione a chi ha generato il codice. Non esiste un
 * motivo legittimo per cui un simile link o QR compaia in una chat: la
 * risposta corretta è la rimozione immediata.
 */
export function isDiscordRemoteAuth(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'discord.com' && host !== 'discordapp.com') return false;
    return /^\/ra\/?/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Link alla CDN Discord che punta a un file eseguibile. */
export function isCdnExecutable(url: string): boolean {
  try {
    const u = new URL(url);
    if (!DISCORD_CDN_HOSTS.has(u.hostname.toLowerCase())) return false;
    return EXECUTABLE_EXT.test(u.pathname);
  } catch {
    return false;
  }
}

/** Estrae ID applicazione e scope da un link di autorizzazione OAuth2. */
export function parseOAuthLink(
  url: string,
): { clientId: string; scopes: string[]; permissions?: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'discord.com' && host !== 'discordapp.com') return null;
    if (!/\/(api\/)?oauth2\/authorize/.test(u.pathname)) return null;
    const clientId = u.searchParams.get('client_id');
    if (!clientId) return null;
    return {
      clientId,
      scopes: (u.searchParams.get('scope') ?? '').split(/[\s+]+/).filter(Boolean),
      permissions: u.searchParams.get('permissions') ?? undefined,
    };
  } catch {
    return null;
  }
}

/** Scope OAuth2 che consegnano il controllo dell'account o del server. */
const DANGEROUS_SCOPES = new Set([
  'bot',
  'applications.commands',
  'guilds.join',
  'gdm.join',
  'webhook.incoming',
  'relationships.read',
  'connections',
  'email',
]);

export function dangerousScopes(scopes: string[]): string[] {
  return scopes.filter((s) => DANGEROUS_SCOPES.has(s.toLowerCase()));
}

/**
 * Dominio che imita uno dei domini protetti.
 *
 * Copre due casi: il punycode (`xn--`, cioè caratteri non latini codificati) e
 * la somiglianza ortografica (`discrod.com`, `dlscord.com`). Entrambi passano
 * inosservati a un lettore distratto.
 */
export function detectImpersonation(
  host: string,
  protectedDomains: string[],
): { impersonates: string; kind: 'PUNYCODE' | 'HOMOGLYPH' | 'TYPOSQUAT'; similarity: number } | null {
  const clean = host.toLowerCase().replace(/^www\./, '');
  if (protectedDomains.some((d) => clean === d || clean.endsWith(`.${d}`))) return null;

  const isPunycode = clean.includes('xn--');
  const hasGlyphs = hasHomoglyphs(host);
  const normalized = normalize(clean);

  for (const domain of protectedDomains) {
    const similarity = nameSimilarity(normalized, domain);
    const normalizedMatches = normalized === domain || normalized.endsWith(`.${domain}`);

    if (normalizedMatches && (isPunycode || hasGlyphs)) {
      return { impersonates: domain, kind: isPunycode ? 'PUNYCODE' : 'HOMOGLYPH', similarity: 1 };
    }
    // Soglia alta: sotto 0,88 si finisce per segnalare domini legittimi.
    if (similarity >= 0.88 && normalized !== domain) {
      return { impersonates: domain, kind: 'TYPOSQUAT', similarity };
    }
  }
  return null;
}

/** Indirizzi di wallet: un QR che ne contiene uno è quasi sempre un drainer. */
const CRYPTO_ADDRESS =
  /\b(?:(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}|0x[a-fA-F0-9]{40}|T[A-Za-z1-9]{33}|(?:ltc1|[LM])[a-zA-HJ-NP-Z0-9]{26,45})\b/;

export function containsCryptoAddress(text: string): boolean {
  return CRYPTO_ADDRESS.test(text);
}

/**
 * Valuta un singolo URL con le sole regole locali (nessuna rete).
 * La reputazione esterna viene aggiunta a parte dalla pipeline.
 */
export function analyzeUrl(
  entry: ExtractedUrl,
  options: {
    protectedDomains: string[];
    blockedDomains: string[];
    allowedDomains: string[];
    ipGrabberDomains: string[];
    flagOAuth: boolean;
    allowedOAuthAppIds: string[];
    blockCdnExecutables: boolean;
  },
): Finding[] {
  const findings: Finding[] = [];
  const host = (entry.finalHost ?? entry.host).replace(/^www\./, '');
  const url = entry.finalUrl ?? entry.url;

  if (options.allowedDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
    return findings;
  }

  // Il caso più grave per primo: un QR o un link Remote Auth significa furto
  // del token in corso, non un semplice link sospetto.
  if (isDiscordRemoteAuth(url)) {
    findings.push({
      code: 'URL_DISCORD_REMOTE_AUTH',
      detail:
        'Link di login Discord tramite QR (Remote Auth): chi lo apre consegna il token del proprio account.',
      score: 100,
      meta: { url },
    });
    return findings;
  }

  if (options.blockedDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
    findings.push({
      code: 'URL_BLOCKLIST',
      detail: `Dominio in blocklist del server: ${host}`,
      score: 80,
      meta: { host },
    });
  }

  if (isIpGrabber(host, options.ipGrabberDomains)) {
    findings.push({
      code: 'URL_IP_GRABBER',
      detail: `Servizio di raccolta indirizzi IP: ${host}`,
      score: 75,
      meta: { host },
    });
  }

  const impersonation = detectImpersonation(host, options.protectedDomains);
  if (impersonation) {
    findings.push({
      code: impersonation.kind === 'PUNYCODE' ? 'URL_PUNYCODE' : 'URL_HOMOGLYPH',
      detail: `Il dominio ${host} imita ${impersonation.impersonates} (${impersonation.kind.toLowerCase()})`,
      score: impersonation.kind === 'TYPOSQUAT' ? 60 : 85,
      meta: { host, ...impersonation },
    });
  }

  if (entry.wasObfuscated) {
    findings.push({
      code: 'URL_OBFUSCATED',
      detail: `Link scritto in forma offuscata per eludere i filtri: ${entry.raw}`,
      score: 25,
      meta: { raw: entry.raw },
    });
  }

  if (isShortener(entry.host) && !entry.finalUrl) {
    findings.push({
      code: 'URL_SHORTENER',
      detail: `Accorciatore non risolto: ${entry.host}`,
      score: 15,
      meta: { host: entry.host },
    });
  }

  if (options.blockCdnExecutables && isCdnExecutable(url)) {
    findings.push({
      code: 'URL_CDN_EXECUTABLE',
      detail:
        'File eseguibile ospitato sulla CDN Discord: vettore documentato di distribuzione infostealer.',
      score: 70,
      meta: { url },
    });
  }

  if (options.flagOAuth) {
    const oauth = parseOAuthLink(url);
    if (oauth && !options.allowedOAuthAppIds.includes(oauth.clientId)) {
      const risky = dangerousScopes(oauth.scopes);
      findings.push({
        code: 'URL_OAUTH_APP',
        detail:
          `Richiesta di autorizzazione a un'applicazione non approvata (${oauth.clientId})` +
          (risky.length ? ` con permessi sensibili: ${risky.join(', ')}` : ''),
        score: risky.length ? 55 : 30,
        meta: oauth,
      });
    }
  }

  return findings;
}
