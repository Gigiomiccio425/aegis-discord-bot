import { describe, expect, it } from 'vitest';
import { normalizeForLanguage, scanLanguage, type LanguageConfig } from '../language.js';

const config: LanguageConfig = {
  terms: [
    { term: 'cazzo', severity: 'LIEVE', category: 'VOLGARITA' },
    { term: 'stronzo', severity: 'MEDIA', category: 'INSULTO' },
    { term: 'sei un idiota', severity: 'MEDIA', category: 'INSULTO' },
    { term: 'ammazzati', severity: 'GRAVE', category: 'AUTOLESIONISMO' },
  ],
  categories: {
    VOLGARITA: true,
    INSULTO: true,
    DISCRIMINAZIONE: true,
    MINACCIA: true,
    AUTOLESIONISMO: true,
    BESTEMMIA: true,
    SESSUALE: true,
  },
  allowlist: ['cazzuola', 'arsenale', 'Cagliari', 'scazzottata'],
  weights: { LIEVE: 20, MEDIA: 45, GRAVE: 80 },
  targetedBonus: 25,
};

describe('normalizzazione', () => {
  it('riconduce numeri e simboli alle lettere che imitano', () => {
    expect(normalizeForLanguage('c4zz0')).toBe('cazzo');
    expect(normalizeForLanguage('$tr0nz0')).toBe('stronzo');
  });

  it('comprime le ripetizioni senza rovinare le doppie', () => {
    expect(normalizeForLanguage('cazzooooo')).toBe('cazzoo');
    expect(normalizeForLanguage('bello')).toBe('bello');
  });

  it('trasforma i separatori in spazi', () => {
    expect(normalizeForLanguage('c-a-z-z-o')).toBe('c a z z o');
    expect(normalizeForLanguage('c.a.z.z.o')).toBe('c a z z o');
  });

  it('toglie gli accenti', () => {
    expect(normalizeForLanguage('perché')).toBe('perche');
  });
});

describe('riconoscimento', () => {
  it('trova la parola scritta in chiaro', () => {
    const esito = scanLanguage('ma che cazzo dici', config);
    expect(esito.matches).toHaveLength(1);
    expect(esito.score).toBe(20);
  });

  it('trova le forme elusive', () => {
    for (const testo of ['ma che c4zz0 dici', 'ma che c-a-z-z-o dici', 'ma che cazzooooo dici']) {
      expect(scanLanguage(testo, config).matches.length, testo).toBeGreaterThan(0);
    }
  });

  it('trova le lettere spaziate', () => {
    // Il caso che un confronto per parola intera non può cogliere: dopo la
    // normalizzazione «c a z z o» sono cinque parole di una lettera.
    expect(scanLanguage('sei un c a z z o di problema', config).matches).toHaveLength(1);
  });

  it('trova le espressioni di più parole', () => {
    const esito = scanLanguage('secondo me sei un idiota totale', config);
    expect(esito.matches.map((match) => match.term)).toContain('sei un idiota');
  });

  it('somma le gravità', () => {
    const esito = scanLanguage('cazzo stronzo', config);
    expect(esito.score).toBe(65);
  });

  it('pesa di più quando è rivolto a qualcuno', () => {
    const sfogo = scanLanguage('che stronzo di lavoro', config);
    const rivolto = scanLanguage('che stronzo di lavoro', config, { targeted: true });
    expect(rivolto.score).toBe(sfogo.score + 25);
  });

  it('non conta due volte la stessa parola', () => {
    expect(scanLanguage('cazzo cazzo cazzo', config).matches).toHaveLength(1);
  });
});

describe('falsi positivi', () => {
  /*
   * È la metà del lavoro, non un dettaglio. Un filtro che blocca chi parla di
   * edilizia insegna in un pomeriggio che il bot va ignorato, e da quel
   * momento non serve più a niente — nemmeno per gli insulti veri.
   */
  it('lascia passare le parole legittime che ne contengono un\'altra', () => {
    for (const testo of [
      'passami la cazzuola',
      'lavoro all arsenale',
      'vado a Cagliari',
      'è finita in una scazzottata',
    ]) {
      expect(scanLanguage(testo, config).matches, testo).toEqual([]);
    }
  });

  it('rispetta le eccezioni anche scritte in forma elusiva', () => {
    expect(scanLanguage('passami la c4zzuola', config).matches).toEqual([]);
  });

  it('non segnala un testo pulito', () => {
    expect(scanLanguage('buongiorno a tutti, come va?', config).score).toBe(0);
  });

  it('non segnala il vuoto', () => {
    expect(scanLanguage('', config).matches).toEqual([]);
    expect(scanLanguage('   ', config).matches).toEqual([]);
  });
});
