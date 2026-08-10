import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import type { FileAnalysis, Finding } from './types.js';

/* ═══════════════════════════════════════════════════════════════════════
   ANALISI DEI FILE

   Qui, a differenza delle immagini, il controllo è sostanziale: un allegato
   può davvero essere un eseguibile. I trucchi ricorrenti sono tre —
   estensione doppia (`foto.png.exe`), estensione mentita (un .exe rinominato
   .png) e file polyglot, validi in due formati contemporaneamente.
   ═══════════════════════════════════════════════════════════════════════ */

/** Estensioni che non hanno motivo di circolare come allegato in una chat. */
export const DEFAULT_BLOCKED_EXTENSIONS = [
  'exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'msi', 'msp', 'hta', 'cpl', 'jar', 'lnk', 'ps1', 'psm1',
  'reg', 'inf', 'apk', 'dll', 'sys', 'scf', 'chm', 'application', 'gadget',
];

/** Estensioni "innocue" usate come prima parte di un'estensione doppia. */
const DECOY_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx',
  'txt', 'mp4', 'mp3', 'zip', 'rar',
];

const ARCHIVE_EXTENSIONS = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'];

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function fileExtension(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
}

/**
 * Rileva l'estensione doppia. Windows nasconde le estensioni note per
 * impostazione predefinita, quindi `fattura.pdf.exe` compare all'utente come
 * `fattura.pdf` con l'icona che l'attaccante ha scelto.
 */
export function hasDoubleExtension(filename: string): { decoy: string; real: string } | null {
  const parts = filename.toLowerCase().split('.');
  if (parts.length < 3) return null;
  const real = parts[parts.length - 1] ?? '';
  const decoy = parts[parts.length - 2] ?? '';
  if (DECOY_EXTENSIONS.includes(decoy) && real !== decoy) {
    return { decoy, real };
  }
  return null;
}

/** Firme di file eseguibili, cercate anche in mezzo al contenuto (polyglot). */
const EXECUTABLE_SIGNATURES: { name: string; bytes: number[] }[] = [
  { name: 'PE/DOS (Windows .exe)', bytes: [0x4d, 0x5a] }, // MZ
  { name: 'ELF (Linux)', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'Mach-O', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Java class', bytes: [0xca, 0xfe, 0xba, 0xbe] },
];

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}

/**
 * File polyglot: valido come immagine e insieme come archivio o eseguibile.
 * Sono usati per far passare un payload attraverso i controlli che si fermano
 * ai primi byte.
 */
export function detectPolyglot(buffer: Buffer): { detail: string } | null {
  const isImageHeader =
    startsWith(buffer, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWith(buffer, [0xff, 0xd8, 0xff]) || // JPEG
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38]); // GIF

  if (!isImageHeader) return null;

  // Un archivio ZIP nascosto in coda a un'immagine: struttura classica del
  // polyglot, cerca la firma di fine archivio.
  const tail = buffer.subarray(Math.max(0, buffer.length - 66000));
  const eocd = tail.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd !== -1) {
    return { detail: 'Immagine con archivio ZIP incorporato (file polyglot)' };
  }

  for (const sig of EXECUTABLE_SIGNATURES) {
    const needle = Buffer.from(sig.bytes);
    const at = buffer.indexOf(needle, 512);
    if (at !== -1) {
      return { detail: `Immagine contenente la firma di un eseguibile ${sig.name} all'offset ${at}` };
    }
  }
  return null;
}

export interface FileScanOptions {
  blockedExtensions: string[];
  verifyMagicBytes: boolean;
  blockDoubleExtension: boolean;
  detectPolyglot: boolean;
}

export async function analyzeFile(
  filename: string,
  buffer: Buffer,
  options: FileScanOptions,
): Promise<{ analysis: FileAnalysis; findings: Finding[] }> {
  const findings: Finding[] = [];
  const declared = fileExtension(filename);
  const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);

  const analysis: FileAnalysis = {
    filename,
    declaredExtension: declared,
    detectedMime: detected?.mime,
    detectedExtension: detected?.ext,
    sha256: sha256(buffer),
    sizeBytes: buffer.length,
  };

  const blocked = options.blockedExtensions.map((e) => e.toLowerCase());

  if (blocked.includes(declared)) {
    findings.push({
      code: 'FILE_BLOCKED_EXTENSION',
      detail: `Estensione non consentita: .${declared}`,
      score: 85,
      meta: { extension: declared },
    });
  }

  if (options.blockDoubleExtension) {
    const double = hasDoubleExtension(filename);
    if (double) {
      const dangerous = blocked.includes(double.real);
      findings.push({
        code: 'FILE_DOUBLE_EXTENSION',
        detail:
          `Estensione doppia: sembra .${double.decoy} ma è .${double.real}. ` +
          'Windows nasconde le estensioni note, quindi la vittima vede solo la prima.',
        score: dangerous ? 95 : 50,
        meta: double,
      });
    }
  }

  if (options.verifyMagicBytes && detected) {
    const declaredMatches =
      declared === detected.ext ||
      (declared === 'jpg' && detected.ext === 'jpeg') ||
      (declared === 'jpeg' && detected.ext === 'jpg') ||
      (declared === 'tgz' && detected.ext === 'gz');

    if (declared && !declaredMatches) {
      const realIsBlocked = blocked.includes(detected.ext);
      findings.push({
        code: 'FILE_MAGIC_MISMATCH',
        detail: `Il file dichiara .${declared} ma il contenuto è ${detected.ext} (${detected.mime})`,
        score: realIsBlocked ? 95 : 40,
        meta: { declared, detected: detected.ext, mime: detected.mime },
      });
    }
  }

  // Eseguibile mascherato: controllo diretto sui primi byte, indipendente da
  // `file-type`, perché è il caso più grave e deve essere rilevato sempre.
  for (const sig of EXECUTABLE_SIGNATURES) {
    if (startsWith(buffer, sig.bytes) && !blocked.includes(declared)) {
      findings.push({
        code: 'FILE_MAGIC_MISMATCH',
        detail: `Il file si presenta come .${declared} ma è un eseguibile ${sig.name}`,
        score: 95,
        meta: { signature: sig.name },
      });
      break;
    }
  }

  if (options.detectPolyglot) {
    const polyglot = detectPolyglot(buffer);
    if (polyglot) {
      findings.push({
        code: 'FILE_POLYGLOT',
        detail: polyglot.detail,
        score: 80,
      });
    }
  }

  if (ARCHIVE_EXTENSIONS.includes(declared) || ARCHIVE_EXTENSIONS.includes(detected?.ext ?? '')) {
    // L'ispezione completa degli archivi richiederebbe di estrarli, con il
    // rischio di zip bomb. Si cercano invece i nomi dei file nella tabella
    // centrale dello ZIP, che è testo in chiaro.
    const names = extractZipEntryNames(buffer);
    const suspicious = names.filter((n) => blocked.includes(fileExtension(n)));
    if (suspicious.length > 0) {
      findings.push({
        code: 'FILE_ARCHIVE_EXECUTABLE',
        detail: `Archivio contenente eseguibili: ${suspicious.slice(0, 5).join(', ')}`,
        score: 85,
        meta: { entries: suspicious.slice(0, 20) },
      });
    }
  }

  return { analysis, findings };
}

/**
 * Legge i nomi delle voci di un archivio ZIP senza decomprimerlo: si scorrono
 * le intestazioni locali, che contengono il nome in chiaro. Evita del tutto il
 * rischio di zip bomb.
 */
function extractZipEntryNames(buffer: Buffer, limit = 200): string[] {
  const names: string[] = [];
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let offset = 0;

  while (names.length < limit) {
    const at = buffer.indexOf(signature, offset);
    if (at === -1 || at + 30 > buffer.length) break;
    const nameLength = buffer.readUInt16LE(at + 26);
    const extraLength = buffer.readUInt16LE(at + 28);
    if (nameLength > 0 && at + 30 + nameLength <= buffer.length) {
      names.push(buffer.subarray(at + 30, at + 30 + nameLength).toString('utf8'));
    }
    offset = at + 30 + nameLength + extraLength;
  }
  return names;
}
