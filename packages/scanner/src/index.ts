import { normalize, type ScannerConfig } from '@angel/shared';
import { analyzeUrl, containsCryptoAddress, extractUrls, isDiscordRemoteAuth } from './url.js';
import { clickFixFindings } from './clickfix.js';
import { analyzeImage, phashDistance } from './image.js';
import { findImpersonationInText, runOcr } from './ocr.js';
import { analyzeFile } from './files.js';
import {
  type ExtractedUrl,
  type Finding,
  type ImageAnalysis,
  type ScanResult,
  type ScannerDeps,
  verdictFromScore,
} from './types.js';

export * from './types.js';
export * from './url.js';
export * from './clickfix.js';
export * from './image.js';
export * from './ocr.js';
export * from './files.js';
export * from './language.js';
export * from './reputation.js';

export interface ScanInput {
  /** Testo del messaggio. */
  text?: string;
  /** Testo estratto dagli embed (titoli, descrizioni, footer). */
  embedText?: string[];
  /** Immagini allegate, già scaricate. */
  images?: { filename: string; buffer: Buffer }[];
  /** Allegati non-immagine. */
  files?: { filename: string; buffer: Buffer }[];
  /**
   * Salta l'OCR. Il percorso sincrono del gateway lo salta sempre: l'analisi
   * profonda viene poi ripetuta nel worker, che può permettersi i secondi.
   */
  skipOcr?: boolean;
}

/**
 * Analisi completa di un messaggio.
 *
 * Ordine di esecuzione pensato per costare poco nel caso normale: prima le
 * verifiche puramente locali sul testo, poi le immagini, e solo alla fine le
 * chiamate di rete — che vengono saltate del tutto se il punteggio è già oltre
 * la soglia di certezza.
 */
export async function scanContent(
  input: ScanInput,
  config: ScannerConfig,
  deps: ScannerDeps = {},
): Promise<ScanResult> {
  const started = Date.now();
  const findings: Finding[] = [];
  const urls: ExtractedUrl[] = [];
  let imageAnalysis: ImageAnalysis | undefined;

  const fullText = [input.text ?? '', ...(input.embedText ?? [])].join('\n').trim();

  /* ── 1. Testo ──────────────────────────────────────────────────────── */

  if (config.clickfix.enabled && fullText) {
    findings.push(...clickFixFindings(fullText, 'TEXT', config.clickfix.patterns));
  }

  if (fullText) {
    const haystack = normalize(fullText);
    const matched = config.scamPhrases.filter((phrase) => haystack.includes(normalize(phrase)));
    if (matched.length > 0) {
      findings.push({
        code: 'TEXT_SCAM_PHRASE',
        detail: `Frasi tipiche delle campagne scam: ${matched.join(', ')}`,
        // Una frase sola può essere una citazione; tre insieme non lo sono.
        score: Math.min(60, 15 * matched.length),
        meta: { phrases: matched },
      });
    }
  }

  if (config.url.enabled && fullText) {
    urls.push(...extractUrls(fullText, 'TEXT'));
  }
  for (const embed of input.embedText ?? []) {
    if (config.url.enabled) urls.push(...extractUrls(embed, 'EMBED'));
  }

  /* ── 2. Immagini ───────────────────────────────────────────────────── */

  if (config.image.enabled) {
    for (const image of input.images ?? []) {
      if (image.buffer.length > config.image.maxSizeMb * 1024 * 1024) continue;

      const analysis = await analyzeImage(image.buffer, {
        decodeQr: config.image.decodeQr,
        perceptualHash: config.image.perceptualHash,
      });
      imageAnalysis = { ...analysis, ...(imageAnalysis ?? {}) };

      // 2a. QR code
      for (const payload of analysis.qrPayloads) {
        findings.push({
          code: 'QR_PRESENT',
          detail: `L'immagine contiene un QR code: ${payload.slice(0, 120)}`,
          score: 10,
          meta: { payload },
        });

        if (config.image.blockDiscordRemoteAuthQr && isDiscordRemoteAuth(payload)) {
          findings.push({
            code: 'QR_REMOTE_AUTH',
            detail:
              'QR di login Discord (Remote Auth). Chi lo inquadra consegna il token del proprio ' +
              'account: Discord stesso lo trasmette a chi ha generato il codice, senza password, ' +
              "senza schermata di conferma e senza alcun avviso. Non esiste un uso legittimo in chat.",
            score: 100,
            meta: { payload },
          });
        }

        if (containsCryptoAddress(payload)) {
          findings.push({
            code: 'QR_CRYPTO_ADDRESS',
            detail: 'Il QR contiene un indirizzo di wallet: schema tipico dei drainer.',
            score: 70,
            meta: { payload },
          });
        }

        urls.push(...extractUrls(payload, 'QR'));
      }

      // 2b. Hash percettivo contro le campagne note
      if (analysis.phash && deps.lookupPhash) {
        const match = await deps.lookupPhash(analysis.phash, config.image.phashMaxDistance);
        if (match) {
          findings.push({
            code: 'IMAGE_KNOWN_CAMPAIGN',
            detail:
              `Immagine riconosciuta come parte di una campagna già bloccata` +
              (match.campaign ? ` (${match.campaign})` : '') +
              `, distanza ${match.distance}.`,
            score: match.severity,
            meta: { phash: analysis.phash, ...match },
          });
        }
      }

      // 2c. OCR — costoso, quindi opzionale
      if (config.image.ocr && !input.skipOcr) {
        const ocr = await runOcr(image.buffer, { languages: config.image.ocrLanguages });
        if (ocr && ocr.confidence >= config.image.ocrMinConfidence && ocr.text.trim()) {
          imageAnalysis = {
            ...(imageAnalysis ?? { qrPayloads: [] }),
            ocrText: ocr.text,
            ocrConfidence: ocr.confidence,
          };

          const ocrUrls = extractUrls(ocr.text, 'OCR');
          if (ocrUrls.length > 0) {
            urls.push(...ocrUrls);
            findings.push({
              code: 'OCR_URL',
              detail: `Link scritto dentro l'immagine: ${ocrUrls.map((u) => u.host).join(', ')}`,
              score: 20,
              meta: { hosts: ocrUrls.map((u) => u.host) },
            });
          }

          if (config.clickfix.enabled) {
            findings.push(...clickFixFindings(ocr.text, 'OCR', config.clickfix.patterns));
          }

          const impersonation = findImpersonationInText(ocr.text);
          if (impersonation.length > 0) {
            findings.push({
              code: 'OCR_IMPERSONATION',
              detail: `Contenuto contraffatto nell'immagine: ${impersonation.map((i) => i.detail).join('; ')}`,
              score: 55,
              meta: { matches: impersonation },
            });
          }

          const ocrHaystack = normalize(ocr.text);
          const phrases = config.scamPhrases.filter((p) => ocrHaystack.includes(normalize(p)));
          if (phrases.length > 0) {
            findings.push({
              code: 'OCR_SCAM_PHRASE',
              detail: `Frasi scam nel testo dell'immagine: ${phrases.join(', ')}`,
              score: Math.min(65, 20 * phrases.length),
              meta: { phrases },
            });
          }
        }
      }
    }
  }

  /* ── 3. File ───────────────────────────────────────────────────────── */

  if (config.file.enabled) {
    for (const file of input.files ?? []) {
      const { analysis, findings: fileFindings } = await analyzeFile(file.filename, file.buffer, {
        blockedExtensions: config.file.blockedExtensions,
        verifyMagicBytes: config.file.verifyMagicBytes,
        blockDoubleExtension: config.file.blockDoubleExtension,
        detectPolyglot: config.file.detectPolyglot,
      });
      findings.push(...fileFindings);

      if (deps.lookupFileHash) {
        const known = await deps.lookupFileHash(analysis.sha256);
        if (known) {
          findings.push({
            code: 'FILE_KNOWN_HASH',
            detail: `File già segnalato${known.campaign ? ` (${known.campaign})` : ''}`,
            score: known.severity,
            meta: { sha256: analysis.sha256 },
          });
        }
      }
    }
  }

  /* ── 4. URL: analisi locale, poi rete ──────────────────────────────── */

  const uniqueUrls = dedupeUrls(urls);

  if (config.url.enabled && uniqueUrls.length > 0) {
    // Espansione degli accorciatori: senza, il verdetto riguarda il servizio e
    // non la destinazione reale.
    if (config.url.expandShorteners && deps.expandUrl) {
      await Promise.all(
        uniqueUrls.map(async (entry) => {
          const expanded = await deps.expandUrl?.(entry.url);
          if (expanded && expanded !== entry.url) {
            entry.finalUrl = expanded;
            try {
              entry.finalHost = new URL(expanded).hostname.toLowerCase();
            } catch {
              /* destinazione non interpretabile: si tiene l'originale */
            }
          }
        }),
      );
    }

    for (const entry of uniqueUrls) {
      findings.push(
        ...analyzeUrl(entry, {
          protectedDomains: config.url.protectedDomains,
          blockedDomains: config.url.blockedDomains,
          allowedDomains: config.url.allowedDomains,
          ipGrabberDomains: [],
          flagOAuth: config.url.flagOAuthLinks,
          allowedOAuthAppIds: config.url.allowedOAuthAppIds,
          blockCdnExecutables: config.url.blockCdnExecutables,
        }),
      );
    }

    // La chiamata remota si fa solo se serve ancora: se il punteggio è già
    // oltre la certezza, l'esito non cambierebbe la decisione.
    const currentScore = sumScore(findings);
    if (currentScore < 90 && deps.lookupUrl) {
      for (const entry of uniqueUrls) {
        const verdict = await deps.lookupUrl(entry.finalUrl ?? entry.url);
        if (verdict?.malicious) {
          findings.push({
            code: verdict.source === 'safebrowsing' ? 'URL_SAFE_BROWSING' : 'URL_BLOCKLIST',
            detail: verdict.detail ?? `URL segnalato da ${verdict.source}`,
            score: 90,
            meta: { url: entry.finalUrl ?? entry.url, source: verdict.source },
          });
        }
      }
    }
  }

  const score = sumScore(findings);
  return {
    verdict: verdictFromScore(score),
    score,
    findings,
    urls: uniqueUrls,
    image: imageAnalysis,
    elapsedMs: Date.now() - started,
  };
}

function sumScore(findings: Finding[]): number {
  return Math.min(
    100,
    findings.reduce((total, f) => total + f.score, 0),
  );
}

function dedupeUrls(urls: ExtractedUrl[]): ExtractedUrl[] {
  const seen = new Map<string, ExtractedUrl>();
  for (const entry of urls) {
    const existing = seen.get(entry.url);
    // Un URL trovato in un QR è più significativo dello stesso URL nel testo:
    // in caso di duplicato si tiene l'origine più rilevante.
    if (!existing || priority(entry.origin) > priority(existing.origin)) {
      seen.set(entry.url, entry);
    }
  }
  return [...seen.values()];
}

function priority(origin: ExtractedUrl['origin']): number {
  switch (origin) {
    case 'QR':
      return 3;
    case 'OCR':
      return 2;
    case 'EMBED':
      return 1;
    default:
      return 0;
  }
}

/** Confronta un hash percettivo con un elenco di firme note. */
export function matchPhash(
  hash: string,
  signatures: { value: string; campaign?: string | null; severity: number }[],
  maxDistance: number,
): { campaign?: string; distance: number; severity: number } | undefined {
  let best: { campaign?: string; distance: number; severity: number } | undefined;
  for (const signature of signatures) {
    const distance = phashDistance(hash, signature.value);
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = {
        campaign: signature.campaign ?? undefined,
        distance,
        severity: signature.severity,
      };
    }
  }
  return best;
}
