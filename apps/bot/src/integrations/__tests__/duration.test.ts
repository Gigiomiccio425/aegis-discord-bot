import { describe, expect, it } from 'vitest';
import { parseDurationSeconds } from '../duration.js';

/**
 * Le durate le scrivono le persone, a mano, dentro un comando. Ogni formato
 * rifiutato senza motivo è un comando da riscrivere: meglio accettare le forme
 * plausibili e rifiutare solo ciò che è davvero ambiguo.
 */
describe('parsing delle durate', () => {
  it('interpreta le unità singole', () => {
    expect(parseDurationSeconds('30s')).toBe(30);
    expect(parseDurationSeconds('10m')).toBe(600);
    expect(parseDurationSeconds('2h')).toBe(7200);
    expect(parseDurationSeconds('7d')).toBe(604800);
  });

  it('accetta la "g" italiana per i giorni', () => {
    expect(parseDurationSeconds('3g')).toBe(259200);
    expect(parseDurationSeconds('3giorni')).toBe(259200);
  });

  it('somma le unità combinate', () => {
    expect(parseDurationSeconds('1h30m')).toBe(5400);
    expect(parseDurationSeconds('1d 12h')).toBe(129600);
  });

  it('ignora spazi e maiuscole', () => {
    expect(parseDurationSeconds('  2H  ')).toBe(7200);
    expect(parseDurationSeconds('2 ore')).toBe(7200);
  });

  it('rifiuta ciò che non è una durata', () => {
    expect(parseDurationSeconds('')).toBeNull();
    expect(parseDurationSeconds('domani')).toBeNull();
    expect(parseDurationSeconds('12')).toBeNull(); // unità mancante: 12 cosa?
    expect(parseDurationSeconds('0h')).toBeNull();
  });
});
