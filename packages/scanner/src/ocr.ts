import { createWorker, type Worker } from 'tesseract.js';
import sharp from 'sharp';

/* ═══════════════════════════════════════════════════════════════════════
   OCR

   Serve a leggere ciò che è scritto *dentro* l'immagine: l'URL dipinto sopra
   uno screenshot fasullo, la frase «premi Win+R», il finto avviso di Discord.
   Senza OCR tutta questa parte della campagna passa indisturbata, perché nel
   messaggio non c'è nulla da filtrare.

   Costo: 0,5-2 secondi per immagine. Per questo l'OCR gira nel worker e non
   sul percorso critico del gateway — il messaggio viene eventualmente
   eliminato a posteriori.
   ═══════════════════════════════════════════════════════════════════════ */

export interface OcrResult {
  text: string;
  confidence: number;
  elapsedMs: number;
}

let workerPromise: Promise<Worker> | null = null;
let currentLanguages = '';

/**
 * Un solo worker riusato per tutto il processo: inizializzarlo costa qualche
 * secondo e diversi megabyte, crearne uno per immagine sarebbe insostenibile.
 */
async function getWorker(languages: string[]): Promise<Worker> {
  const langKey = languages.join('+');
  if (workerPromise && langKey === currentLanguages) return workerPromise;

  if (workerPromise) {
    const old = await workerPromise;
    await old.terminate().catch(() => undefined);
  }

  currentLanguages = langKey;
  workerPromise = createWorker(languages, undefined, {
    // I log di tesseract sono molto verbosi: si tengono silenziati.
    logger: () => undefined,
    errorHandler: () => undefined,
  });
  return workerPromise;
}

export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return;
  const worker = await workerPromise;
  await worker.terminate().catch(() => undefined);
  workerPromise = null;
  currentLanguages = '';
}

/**
 * Prepara l'immagine per il riconoscimento.
 *
 * Il testo delle immagini scam è quasi sempre chiaro su fondo scuro e su
 * sfondi ricchi di dettagli. Scala di grigi, normalizzazione e un
 * ridimensionamento a larghezza fissa migliorano la resa in modo netto rispetto
 * al passaggio dell'immagine originale.
 */
async function preprocess(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: 1400, withoutEnlargement: true })
      .greyscale()
      .normalise()
      .sharpen()
      .toBuffer();
  } catch {
    return buffer;
  }
}

export async function runOcr(
  buffer: Buffer,
  options: { languages?: string[]; timeoutMs?: number } = {},
): Promise<OcrResult | null> {
  const languages = options.languages?.length ? options.languages : ['ita', 'eng'];
  const timeoutMs = options.timeoutMs ?? 20000;
  const started = Date.now();

  try {
    const prepared = await preprocess(buffer);
    const worker = await getWorker(languages);

    // Un'immagine malformata può bloccare il worker: senza limite di tempo la
    // coda si fermerebbe del tutto.
    const recognition = await Promise.race([
      worker.recognize(prepared),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (!recognition) return null;

    return {
      text: recognition.data.text ?? '',
      confidence: recognition.data.confidence ?? 0,
      elapsedMs: Date.now() - started,
    };
  } catch {
    return null;
  }
}

/**
 * Marchi imitati negli avvisi contraffatti. Il testo «Discord Trust & Safety»
 * dentro un'immagine, in un canale qualsiasi, non ha usi legittimi.
 */
const IMPERSONATION_PATTERNS: { re: RegExp; detail: string }[] = [
  { re: /discord\s*(?:trust\s*&?\s*safety|support|staff|system)/i, detail: 'Finto messaggio ufficiale Discord' },
  { re: /(?:your|il tuo)\s+account\s+(?:will be|sarà)\s+(?:deleted|disabled|eliminato|disabilitato)/i, detail: 'Minaccia di chiusura account' },
  { re: /(?:account|profilo)\s+(?:has been )?(?:reported|segnalato)/i, detail: 'Falsa segnalazione dell\'account' },
  { re: /steam\s+(?:gift|community)\s+(?:card|offer)/i, detail: 'Finta offerta Steam' },
  { re: /free\s+nitro|nitro\s+gratis/i, detail: 'Finto Nitro gratuito' },
  { re: /(?:connect|collega)\s+(?:your\s+)?wallet/i, detail: 'Richiesta di collegare un wallet' },
  { re: /scan\s+(?:the\s+)?qr|scansiona\s+(?:il\s+)?qr/i, detail: 'Invito a inquadrare un QR' },
];

export function findImpersonationInText(text: string): { detail: string }[] {
  return IMPERSONATION_PATTERNS.filter(({ re }) => re.test(text)).map(({ detail }) => ({ detail }));
}
