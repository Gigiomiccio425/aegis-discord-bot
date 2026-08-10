/**
 * Converte durate scritte a mano in secondi: `30m`, `2h`, `7d`, `1h30m`.
 *
 * Accetta anche le lettere italiane (`g` per giorni) perché è ciò che la gente
 * scrive senza pensarci, e un comando rifiutato per una lettera è attrito
 * inutile.
 */
export function parseDurationSeconds(input: string): number | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return null;

  const pattern = /(\d+)\s*(s|m|h|d|g|sec|min|ore|ora|giorni|giorno)/g;
  let total = 0;
  let matched = false;

  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    const unit = match[2] ?? '';
    matched = true;

    if (unit === 's' || unit === 'sec') total += value;
    else if (unit === 'm' || unit === 'min') total += value * 60;
    else if (unit === 'h' || unit === 'ore' || unit === 'ora') total += value * 3600;
    else total += value * 86400; // d, g, giorni, giorno
  }

  if (!matched || total <= 0) return null;
  return total;
}

/** Timestamp Discord relativo: `<t:…:R>` → «fra 2 ore», tradotto dal client. */
export function relativeTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

export function absoluteTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
}
