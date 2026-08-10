/* ═══════════════════════════════════════════════════════════════════════
   Normalizzazione del testo.

   Serve in due punti diversi ma per lo stesso motivo: un attaccante scrive
   `dіscord.com` con la "i" cirillica o `𝗠𝗿𝗕𝗲𝗮𝘀𝘁` in grassetto matematico, e
   qualunque confronto ingenuo fallisce. Qui il testo viene riportato a una
   forma canonica prima di essere confrontato con blocklist e nomi dello staff.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Caratteri che *sembrano* lettere latine ma non lo sono. Elenco mirato ai
 * caratteri effettivamente usati negli attacchi (cirillico, greco, cherokee,
 * matematici, fullwidth), non un mapping Unicode esaustivo.
 */
const HOMOGLYPHS: Record<string, string> = {
  // cirillico
  а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', о: 'o', р: 'p',
  ѕ: 's', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ԁ: 'd', ɡ: 'g', ν: 'v',
  А: 'a', В: 'b', С: 'c', Е: 'e', Н: 'h', К: 'k', М: 'm', О: 'o', Р: 'p',
  Ѕ: 's', Т: 't', У: 'y', Х: 'x', І: 'i', Ј: 'j',
  // greco
  ο: 'o', Ο: 'o', α: 'a', Α: 'a', β: 'b', Β: 'b', ε: 'e', Ε: 'e', ι: 'i',
  Ι: 'i', κ: 'k', Κ: 'k', μ: 'u', Μ: 'm', Ρ: 'p', τ: 't', Τ: 't', υ: 'u',
  Υ: 'y', χ: 'x', Χ: 'x', Ζ: 'z', Η: 'h', Ν: 'n',
  // altri
  ł: 'l', ø: 'o', đ: 'd', ƒ: 'f', ı: 'i', ǃ: '!', ᴏ: 'o', ᴠ: 'v',
};

/**
 * Caratteri invisibili usati per spezzare le parole ed eludere i filtri.
 * Scritti con le sequenze di escape: con i caratteri letterali questo elenco
 * sarebbe invisibile anche a chi legge il sorgente.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;

/**
 * Riporta il testo a una forma confrontabile: minuscolo, senza diacritici,
 * senza caratteri invisibili, con gli omoglifi ricondotti al latino.
 */
export function normalize(input: string): string {
  return input
    .normalize('NFKD')
    .replace(INVISIBLE, '')
    .replace(/[\u0300-\u036F]/g, "") // diacritici separati dalla NFKD
    .toLowerCase()
    .split('')
    .map((ch) => HOMOGLYPHS[ch] ?? ch)
    .join('');
}

/** true se il testo contiene caratteri che imitano lettere latine. */
export function hasHomoglyphs(input: string): boolean {
  const stripped = input.normalize('NFKD').replace(INVISIBLE, '');
  for (const ch of stripped) {
    if (HOMOGLYPHS[ch] !== undefined) return true;
  }
  return false;
}

/** true se il testo contiene caratteri invisibili o di controllo direzionale. */
export function hasInvisibleChars(input: string): boolean {
  INVISIBLE.lastIndex = 0;
  return INVISIBLE.test(input);
}

/**
 * Similarità Jaro-Winkler (0-1). Scelta rispetto alla distanza di Levenshtein
 * perché premia i prefissi comuni: `Moderatore` e `Moderat0re` risultano molto
 * più simili di quanto direbbe una semplice distanza di edit.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Confronto di nomi resistente agli omoglifi: normalizza e poi misura. */
export function nameSimilarity(a: string, b: string): number {
  return jaroWinkler(normalize(a), normalize(b));
}

/**
 * Entropia di Shannon per carattere. Un nome generato a macchina
 * (`x7k2p9qwm`) ha entropia alta; `mario_rossi` no.
 */
export function shannonEntropy(input: string): number {
  if (input.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of input) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / input.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Pattern tipici degli username creati in massa. */
const GENERATED_NAME_PATTERNS: RegExp[] = [
  /^[a-z]+\d{4,}$/i, // mario12345
  /^user\d+$/i,
  /^[a-z]{1,3}\d{6,}$/i,
  /^[a-z0-9]{16,}$/i, // stringa lunga senza separatori
  /^\w+_\w+_\d{3,}$/i,
];

/**
 * Euristica per username generati automaticamente. Restituisce 0-1: non è una
 * certezza, alimenta un punteggio di rischio insieme ad altri segnali.
 */
export function generatedNameScore(username: string): number {
  const name = username.toLowerCase();
  let score = 0;

  if (GENERATED_NAME_PATTERNS.some((p) => p.test(name))) score += 0.5;

  const digits = (name.match(/\d/g) ?? []).length;
  if (digits >= 4 && digits / name.length > 0.35) score += 0.2;

  // Molte consonanti di fila: tipico delle stringhe casuali.
  if (/[bcdfghjklmnpqrstvwxz]{5,}/.test(name)) score += 0.2;

  if (shannonEntropy(name) > 3.6) score += 0.2;

  if (hasHomoglyphs(username)) score += 0.3;

  return Math.min(1, score);
}

/** Zalgo: caratteri combinanti accumulati per rendere il testo illeggibile. */
export function zalgoRatio(input: string): number {
  if (input.length === 0) return 0;
  const combining = (input.match(/[\u0300-\u036F\u0483-\u0489\u1AB0-\u1AFF\u1DC0-\u1DFF]/gu) ?? [])
    .length;
  return combining / input.length;
}

/** Percentuale di maiuscole sulle sole lettere. */
export function capsRatio(input: string): number {
  const letters = input.replace(/[^a-zA-ZÀ-ÿ]/g, '');
  if (letters.length === 0) return 0;
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, '').length;
  return upper / letters.length;
}

/** Hash stabile e breve, usato per riconoscere messaggi duplicati. */
export function contentFingerprint(input: string): string {
  const canon = normalize(input).replace(/\s+/g, ' ').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canon.length; i++) {
    const c = canon.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, '0');
}
