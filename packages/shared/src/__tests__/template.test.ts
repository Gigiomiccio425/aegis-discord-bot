import { describe, expect, it } from 'vitest';
import { applicaModello, segnapostiUsati } from '../util/template.js';

/*
 * Erano quattro implementazioni della stessa sostituzione — annunci Twitch,
 * YouTube, RSS, avvisi sui link — e già divergevano. Ora è una sola, quindi il
 * comportamento va fissato qui: è l'unico posto in cui può cambiare.
 */
describe('segnaposto nei messaggi', () => {
  it('sostituisce ciò che conosce', () => {
    expect(applicaModello('{streamer} è in diretta con {game}', { streamer: 'tizio', game: 'Rust' }))
      .toBe('tizio è in diretta con Rust');
  });

  it('accetta anche i numeri', () => {
    expect(applicaModello('{viewers} spettatori', { viewers: 128 })).toBe('128 spettatori');
  });

  it('lascia intatto il segnaposto che non conosce', () => {
    // Chi scrive {titolo} dove la piattaforma non lo prevede deve vederlo
    // nell'anteprima, non trovarsi un buco nel messaggio pubblicato.
    expect(applicaModello('{titolo} — {mancante}', { titolo: 'Ciao' })).toBe('Ciao — {mancante}');
  });

  it('sostituisce tutte le occorrenze, non solo la prima', () => {
    expect(applicaModello('{a} e ancora {a}', { a: 'x' })).toBe('x e ancora x');
  });

  it('un valore vuoto resta vuoto invece di ricomparire come segnaposto', () => {
    expect(applicaModello('gioco: {game}', { game: '' })).toBe('gioco: ');
  });

  it('elenca i segnaposto usati, senza ripetizioni', () => {
    expect(segnapostiUsati('{a} {b} {a}')).toEqual(['a', 'b']);
  });
});
