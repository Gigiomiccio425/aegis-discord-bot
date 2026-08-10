import { describe, expect, it } from 'vitest';
import {
  capsRatio,
  contentFingerprint,
  generatedNameScore,
  hasHomoglyphs,
  hasInvisibleChars,
  jaroWinkler,
  nameSimilarity,
  normalize,
  zalgoRatio,
} from '../util/text.js';

describe('normalizzazione', () => {
  it('riconduce gli omoglifi cirillici al latino', () => {
    // "Мoderatore" con la M cirillica
    expect(normalize('Мoderatore')).toBe('moderatore');
  });

  it('rimuove i caratteri invisibili', () => {
    expect(normalize('disc​ord')).toBe('discord');
  });

  it('rimuove i diacritici', () => {
    expect(normalize('Città')).toBe('citta');
  });
});

describe('rilevamento omoglifi', () => {
  it('riconosce un nome con caratteri non latini mascherati', () => {
    expect(hasHomoglyphs('Мoderatore')).toBe(true);
    expect(hasHomoglyphs('discоrd')).toBe(true);
  });

  it('non segnala testo latino normale', () => {
    expect(hasHomoglyphs('Moderatore')).toBe(false);
    expect(hasHomoglyphs('mario_rossi')).toBe(false);
  });

  it('riconosce i caratteri a larghezza zero', () => {
    expect(hasInvisibleChars('ad​min')).toBe(true);
    expect(hasInvisibleChars('admin')).toBe(false);
  });
});

describe('similarità dei nomi', () => {
  it('assegna 1 a stringhe identiche', () => {
    expect(jaroWinkler('mario', 'mario')).toBe(1);
  });

  it('riconosce una imitazione con una cifra al posto di una lettera', () => {
    expect(nameSimilarity('Moderatore', 'Moderat0re')).toBeGreaterThan(0.9);
  });

  it('riconosce una imitazione con omoglifi', () => {
    expect(nameSimilarity('Мoderatore', 'Moderatore')).toBe(1);
  });

  it('tiene distinti nomi realmente diversi', () => {
    expect(nameSimilarity('mario_rossi', 'giovanni_bianchi')).toBeLessThan(0.7);
  });
});

describe('username generati a macchina', () => {
  it('riconosce i pattern tipici degli account usa e getta', () => {
    expect(generatedNameScore('user82736451')).toBeGreaterThanOrEqual(0.5);
    expect(generatedNameScore('xk2p9qwmzbrtvnhd')).toBeGreaterThanOrEqual(0.5);
  });

  it('non segnala nomi normali', () => {
    expect(generatedNameScore('mario_rossi')).toBeLessThan(0.5);
    expect(generatedNameScore('lucia')).toBeLessThan(0.5);
  });
});

describe('forma del messaggio', () => {
  it('misura le maiuscole ignorando la punteggiatura', () => {
    expect(capsRatio('CIAO A TUTTI!!!')).toBeGreaterThan(0.9);
    expect(capsRatio('ciao a tutti')).toBe(0);
  });

  it('riconosce lo zalgo', () => {
    expect(zalgoRatio('c̸̢̛̯̪ĩ̷̻a̶̡͛o̵̪͐')).toBeGreaterThan(0.25);
    expect(zalgoRatio('ciao')).toBe(0);
  });
});

describe('impronta del contenuto', () => {
  it('produce la stessa impronta per messaggi equivalenti', () => {
    // È ciò che permette di riconoscere lo stesso messaggio ripetuto in più
    // canali anche quando l'autore cambia spaziatura o maiuscole.
    expect(contentFingerprint('Free  NITRO qui!')).toBe(contentFingerprint('free nitro qui!'));
  });

  it('produce impronte diverse per contenuti diversi', () => {
    expect(contentFingerprint('ciao')).not.toBe(contentFingerprint('salve'));
  });
});
