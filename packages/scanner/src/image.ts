import sharp from 'sharp';
import jsQRImport from 'jsqr';
import phashImport from 'sharp-phash';
import type { ImageAnalysis } from './types.js';

/*
 * `jsqr` e `sharp-phash` sono pacchetti CommonJS che fanno `module.exports = fn`.
 * Importati da un modulo ESM, Node consegna direttamente la funzione, ma i loro
 * file di dichiarazione usano `export default`: TypeScript vede un namespace e
 * non una funzione. Il cast riallinea i tipi al comportamento reale a runtime.
 */
type JsQRFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' },
) => { data: string; binaryData: number[] } | null;

const jsQR = jsQRImport as unknown as JsQRFn;
const phash = phashImport as unknown as (input: Buffer) => Promise<string>;

/* ═══════════════════════════════════════════════════════════════════════
   ANALISI DELLE IMMAGINI

   Va detto chiaramente: un PNG o un JPG su Discord non esegue codice. Le
   immagini delle campagne scam sono contenitori di *link* — testo sovrimpresso,
   codici QR, o il messaggio che le accompagna. Perciò qui non si cerca un virus
   dentro i pixel: si estrae tutto ciò che può portare l'utente altrove.

   Tre operazioni:
     1. decodifica dei QR (destinazione nascosta)
     2. hash percettivo (riconoscere la campagna anche se l'immagine cambia)
     3. OCR (in `ocr.ts`, più lento, eseguito nel worker)
   ═══════════════════════════════════════════════════════════════════════ */

export interface DecodedImage {
  width: number;
  height: number;
  /** Pixel RGBA, richiesti da jsQR. */
  data: Uint8ClampedArray;
}

/** Porta l'immagine in RGBA grezzo, ridimensionandola se troppo grande. */
async function toRaw(buffer: Buffer, maxSide = 1600): Promise<DecodedImage | null> {
  try {
    const image = sharp(buffer, { failOn: 'none' }).rotate();
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return null;

    const scale = Math.max(meta.width, meta.height) > maxSide
      ? maxSide / Math.max(meta.width, meta.height)
      : 1;

    const { data, info } = await image
      .resize(
        scale < 1
          ? { width: Math.round(meta.width * scale), height: Math.round(meta.height * scale) }
          : undefined,
      )
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    };
  } catch {
    return null;
  }
}

/**
 * Decodifica i QR presenti nell'immagine.
 *
 * Un solo tentativo non basta: i QR degli screenshot sono spesso piccoli,
 * a basso contrasto o su sfondo scuro. Si prova quindi in più modi, dal più
 * economico al più costoso, fermandosi al primo che riesce.
 */
export async function decodeQrCodes(buffer: Buffer): Promise<string[]> {
  const payloads = new Set<string>();

  const attempts: (() => Promise<DecodedImage | null>)[] = [
    () => toRaw(buffer, 1600),
    // Alto contrasto in scala di grigi: recupera i QR sbiaditi o compressi.
    async () => {
      try {
        const processed = await sharp(buffer, { failOn: 'none' })
          .rotate()
          .greyscale()
          .normalise()
          .toBuffer();
        return toRaw(processed, 1600);
      } catch {
        return null;
      }
    },
    // Inversione: i QR chiari su fondo scuro non vengono letti diversamente.
    async () => {
      try {
        const processed = await sharp(buffer, { failOn: 'none' })
          .rotate()
          .greyscale()
          .negate()
          .toBuffer();
        return toRaw(processed, 1600);
      } catch {
        return null;
      }
    },
    // Ingrandimento: i QR molto piccoli hanno bisogno di più pixel per modulo.
    async () => {
      try {
        const processed = await sharp(buffer, { failOn: 'none' })
          .rotate()
          .resize({ width: 2400, withoutEnlargement: false })
          .sharpen()
          .toBuffer();
        return toRaw(processed, 2400);
      } catch {
        return null;
      }
    },
  ];

  for (const attempt of attempts) {
    const raw = await attempt();
    if (!raw) continue;
    const result = jsQR(raw.data, raw.width, raw.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (result?.data) {
      payloads.add(result.data);
      break;
    }
  }

  return [...payloads];
}

/**
 * Hash percettivo a 64 bit.
 *
 * A differenza di uno SHA-256, resta stabile se l'immagine viene ricompressa,
 * ridimensionata o ritagliata leggermente. È ciò che permette di bloccare
 * un'intera campagna — l'ondata "MrBeast" ha prodotto milioni di immagini che
 * sono varianti della stessa manciata di originali — con poche firme.
 */
export async function computePhash(buffer: Buffer): Promise<string | undefined> {
  try {
    return await phash(buffer);
  } catch {
    return undefined;
  }
}

/** Distanza di Hamming fra due hash percettivi in forma binaria. */
export function phashDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) distance++;
  }
  return distance;
}

export interface ImageMeta {
  width?: number;
  height?: number;
  format?: string;
  /** Numero di fotogrammi: >1 significa GIF o WebP animata. */
  frames?: number;
}

export async function readImageMeta(buffer: Buffer): Promise<ImageMeta> {
  try {
    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    return {
      width: meta.width,
      height: meta.height,
      format: meta.format,
      frames: meta.pages ?? 1,
    };
  } catch {
    return {};
  }
}

/**
 * Analisi rapida: metadati, QR e hash percettivo. Non include l'OCR, che costa
 * 0,5-2 secondi e viene eseguito a parte nel worker.
 */
export async function analyzeImage(
  buffer: Buffer,
  options: { decodeQr: boolean; perceptualHash: boolean },
): Promise<ImageAnalysis> {
  const meta = await readImageMeta(buffer);
  const [qrPayloads, hash] = await Promise.all([
    options.decodeQr ? decodeQrCodes(buffer) : Promise.resolve([]),
    options.perceptualHash ? computePhash(buffer) : Promise.resolve(undefined),
  ]);

  return {
    width: meta.width,
    height: meta.height,
    qrPayloads,
    phash: hash,
  };
}
