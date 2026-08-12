import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWLIST, DEFAULT_WORDLIST } from '../config/wordlist.js';

describe('elenco predefinito', () => {
  it('non ripete la stessa voce due volte', () => {
    const termini = DEFAULT_WORDLIST.map((voce) => voce.term.toLowerCase());
    const doppioni = termini.filter((termine, indice) => termini.indexOf(termine) !== indice);
    expect(doppioni).toEqual([]);
  });

  it('non usa la ricerca dentro le parole', () => {
    /*
     * `substring` è l'opzione che produce i falsi positivi: cercando «cazzo»
     * dentro le altre parole si blocca chi nomina una cazzuola. Nell'elenco
     * predefinito non c'è una sola voce per cui il guadagno superi il rischio,
     * e questo test impedisce che ne compaia una per distrazione.
     */
    expect(DEFAULT_WORDLIST.filter((voce) => voce.substring)).toEqual([]);
  });

  it('assegna gravità coerente con la categoria', () => {
    // Un attacco all'identità, una minaccia o un'incitazione
    // all'autolesionismo non possono essere «lievi»: se lo fossero, non
    // supererebbero mai la soglia della risposta e la categoria sarebbe
    // decorativa.
    const gravi = DEFAULT_WORDLIST.filter((voce) =>
      ['DISCRIMINAZIONE', 'MINACCIA', 'AUTOLESIONISMO'].includes(voce.category),
    );
    expect(gravi.every((voce) => voce.severity === 'GRAVE')).toBe(true);
    expect(gravi.length).toBeGreaterThan(50);

    // Le bestemmie fanno eccezione, e la differenza è reale: fra «dio santo»
    // detto per stizza e le formule pesanti c'è la stessa distanza che passa
    // fra imprecare e insultare. Restano comunque sopra il livello lieve,
    // altrimenti non supererebbero mai la soglia della risposta.
    const bestemmie = DEFAULT_WORDLIST.filter((voce) => voce.category === 'BESTEMMIA');
    expect(bestemmie.every((voce) => voce.severity !== 'LIEVE')).toBe(true);
    expect(bestemmie.filter((voce) => voce.severity === 'GRAVE').length).toBeGreaterThan(50);
  });

  it('copre tutte le categorie', () => {
    const presenti = new Set(DEFAULT_WORDLIST.map((voce) => voce.category));
    for (const categoria of [
      'VOLGARITA',
      'INSULTO',
      'DISCRIMINAZIONE',
      'MINACCIA',
      'AUTOLESIONISMO',
      'BESTEMMIA',
      'SESSUALE',
    ]) {
      expect(presenti.has(categoria as never), categoria).toBe(true);
    }
  });

  it('non contiene voci troppo corte per essere sicure', () => {
    // Sotto le tre lettere una sequenza compare ovunque per caso.
    const corte = DEFAULT_WORDLIST.filter((voce) => voce.term.length < 3);
    expect(corte).toEqual([]);
  });
});

describe('eccezioni', () => {
  it('non ripete la stessa eccezione', () => {
    const normalizzate = DEFAULT_ALLOWLIST.map((voce) => voce.toLowerCase());
    expect(new Set(normalizzate).size).toBe(normalizzate.length);
  });

  it('nessuna eccezione coincide con una voce vietata', () => {
    /*
     * Sarebbe una contraddizione silenziosa: la parola risulterebbe insieme
     * vietata e ammessa, e quale delle due vince dipenderebbe dall'ordine in
     * cui il codice le confronta — cioè da un dettaglio che nessuno ha deciso.
     */
    const vietate = new Set(DEFAULT_WORDLIST.map((voce) => voce.term.toLowerCase()));
    const contraddizioni = DEFAULT_ALLOWLIST.filter((voce) => vietate.has(voce.toLowerCase()));
    expect(contraddizioni).toEqual([]);
  });
});
