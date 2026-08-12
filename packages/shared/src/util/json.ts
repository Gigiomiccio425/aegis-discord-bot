/**
 * Mette fra virgolette gli ID Discord scritti come numeri.
 *
 * Un ID Discord supera 2^53, il limite oltre il quale i numeri JavaScript
 * smettono di essere esatti: `JSON.parse('[1272925031764328471]')` restituisce
 * `1272925031764328400`. Copiare un ID da Discord e incollarlo senza virgolette
 * non produce quindi un errore di formato — produce un ID diverso, che avrebbe
 * puntato al canale sbagliato se lo schema non pretendesse una stringa.
 *
 * La correzione deve avvenire sul testo, prima della lettura: dopo `JSON.parse`
 * le cifre perse non tornano più.
 */
export function virgoletteSugliId(testo: string): string {
  let risultato = '';
  let dentroStringa = false;

  for (let i = 0; i < testo.length; i += 1) {
    const carattere = testo[i]!;

    if (dentroStringa) {
      risultato += carattere;
      if (carattere === '\\') {
        // La sequenza di escape si copia intera: una virgoletta preceduta da
        // barra non chiude la stringa.
        i += 1;
        if (i < testo.length) risultato += testo[i]!;
      } else if (carattere === '"') {
        dentroStringa = false;
      }
      continue;
    }

    if (carattere === '"') {
      dentroStringa = true;
      risultato += carattere;
      continue;
    }

    // Fuori dalle stringhe, una sequenza lunga di cifre può essere solo un ID:
    // le opzioni numeriche della configurazione sono soglie e durate, ordini di
    // grandezza lontanissimi da diciassette cifre.
    if (carattere >= '0' && carattere <= '9') {
      let fine = i;
      while (fine < testo.length && testo[fine]! >= '0' && testo[fine]! <= '9') fine += 1;
      const cifre = testo.slice(i, fine);
      const decimale = testo[fine] === '.' || testo[fine] === 'e' || testo[fine] === 'E';
      risultato += cifre.length >= 17 && cifre.length <= 20 && !decimale ? `"${cifre}"` : cifre;
      i = fine - 1;
      continue;
    }

    risultato += carattere;
  }

  return risultato;
}

