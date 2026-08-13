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
      ['DISCRIMINAZIONE', 'AUTOLESIONISMO'].includes(voce.category),
    );
    expect(gravi.every((voce) => voce.severity === 'GRAVE')).toBe(true);
    expect(gravi.length).toBeGreaterThan(50);

    // Minacce e bestemmie hanno invece due livelli, e in entrambi i casi la
    // distinzione è reale: «ti ammazzo» e «stai attento a come parli» non sono
    // la stessa cosa, come non lo sono «dio santo» detto per stizza e le
    // formule pesanti. Nessuna delle due scende sotto il livello medio,
    // altrimenti non supererebbe mai la soglia della risposta.
    const minacce = DEFAULT_WORDLIST.filter((voce) => voce.category === 'MINACCIA');
    expect(minacce.every((voce) => voce.severity !== 'LIEVE')).toBe(true);
    expect(minacce.filter((voce) => voce.severity === 'GRAVE').length).toBeGreaterThan(40);

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
