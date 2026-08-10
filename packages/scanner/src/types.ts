/**
 * Tipi dello scanner. Volutamente indipendenti da discord.js: questa libreria
 * riceve testo e byte, non oggetti Discord, così è collaudabile con file di
 * esempio e senza rete.
 */

export type Verdict = 'CLEAN' | 'SUSPICIOUS' | 'MALICIOUS';

export interface Finding {
  /** Codice stabile: usato nei log, nelle statistiche e nei test. */
  code: FindingCode;
  detail: string;
  /** Punti aggiunti al punteggio complessivo (0-100). */
  score: number;
  meta?: Record<string, unknown>;
}

export type FindingCode =
  // URL
  | 'URL_BLOCKLIST'
  | 'URL_SAFE_BROWSING'
  | 'URL_HOMOGLYPH'
  | 'URL_PUNYCODE'
  | 'URL_OBFUSCATED'
  | 'URL_SHORTENER'
  | 'URL_IP_GRABBER'
  | 'URL_OAUTH_APP'
  | 'URL_CDN_EXECUTABLE'
  | 'URL_DISCORD_REMOTE_AUTH'
  // QR
  | 'QR_PRESENT'
  | 'QR_REMOTE_AUTH'
  | 'QR_MALICIOUS_URL'
  | 'QR_CRYPTO_ADDRESS'
  // OCR e testo
  | 'TEXT_SCAM_PHRASE'
  | 'TEXT_CLICKFIX'
  | 'OCR_SCAM_PHRASE'
  | 'OCR_URL'
  | 'OCR_CLICKFIX'
  | 'OCR_IMPERSONATION'
  // immagini
  | 'IMAGE_KNOWN_CAMPAIGN'
  | 'IMAGE_PHASH_MATCH'
  // file
  | 'FILE_BLOCKED_EXTENSION'
  | 'FILE_DOUBLE_EXTENSION'
  | 'FILE_MAGIC_MISMATCH'
  | 'FILE_POLYGLOT'
  | 'FILE_KNOWN_HASH'
  | 'FILE_ARCHIVE_EXECUTABLE';

export interface ExtractedUrl {
  /** Come appariva nel testo, prima della pulizia. */
  raw: string;
  /** Forma normalizzata e navigabile. */
  url: string;
  host: string;
  /** Vera destinazione dopo aver seguito i redirect, se diversa. */
  finalUrl?: string;
  finalHost?: string;
  /** true se era scritto in forma offuscata (hxxp, dot, spazi, zero-width). */
  wasObfuscated: boolean;
  /** Da dove proviene: testo del messaggio, OCR dell'immagine, QR code. */
  origin: 'TEXT' | 'OCR' | 'QR' | 'EMBED';
}

export interface ImageAnalysis {
  width?: number;
  height?: number;
  phash?: string;
  qrPayloads: string[];
  ocrText?: string;
  ocrConfidence?: number;
}

export interface FileAnalysis {
  filename: string;
  declaredExtension: string;
  detectedMime?: string;
  detectedExtension?: string;
  sha256: string;
  sizeBytes: number;
}

export interface ScanResult {
  verdict: Verdict;
  /** 0-100. Le scale d'azione dei moduli lavorano su questo valore. */
  score: number;
  findings: Finding[];
  urls: ExtractedUrl[];
  image?: ImageAnalysis;
  file?: FileAnalysis;
  /** Millisecondi impiegati: utile per capire se l'OCR sta rallentando la coda. */
  elapsedMs: number;
}

/**
 * Servizi esterni iniettati dal chiamante. Tenerli fuori dalla libreria
 * significa che i test girano senza rete e senza Redis.
 */
export interface ScannerDeps {
  /** Verdetto sulla reputazione di un URL. undefined = nessuna informazione. */
  lookupUrl?: (url: string) => Promise<{ malicious: boolean; source: string; detail?: string } | undefined>;
  /** Cerca un hash percettivo fra le campagne già note. */
  lookupPhash?: (
    phash: string,
    maxDistance: number,
  ) => Promise<{ campaign?: string; distance: number; severity: number } | undefined>;
  /** Cerca un hash di file fra le firme note. */
  lookupFileHash?: (sha256: string) => Promise<{ campaign?: string; severity: number } | undefined>;
  /** Segue i redirect di un accorciatore. */
  expandUrl?: (url: string) => Promise<string | undefined>;
  logger?: { debug: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };
}

export function verdictFromScore(score: number): Verdict {
  if (score >= 70) return 'MALICIOUS';
  if (score >= 30) return 'SUSPICIOUS';
  return 'CLEAN';
}
