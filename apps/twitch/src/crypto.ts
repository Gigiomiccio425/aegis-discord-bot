import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cifratura a riposo dei segreti salvati nel database (token OAuth degli
 * utenti del pannello).
 *
 * AES-256-GCM e non AES-CBC: GCM autentica il testo cifrato, quindi una riga
 * manomessa nel database fallisce la decifratura invece di produrre dati
 * plausibili ma falsi.
 *
 * La lezione dal caso Discord del 2025 — dati esposti attraverso un fornitore
 * terzo — è semplice: quello che non serve non va conservato, e quello che
 * serve va cifrato.
 */
function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'ENCRYPTION_KEY mancante o non valida: servono 64 caratteri esadecimali. ' +
        'Genera con: openssl rand -hex 32',
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Formato: iv.tag.ciphertext — tutto in base64url, una sola stringa da salvare.
  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decrypt(payload: string): string | null {
  try {
    const [ivPart, tagPart, dataPart] = payload.split('.');
    if (!ivPart || !tagPart || !dataPart) return null;

    const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

/** Confronto a tempo costante, per firme e token. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
