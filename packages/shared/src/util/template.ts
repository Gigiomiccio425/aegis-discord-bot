/* ═══════════════════════════════════════════════════════════════════════
   SEGNAPOSTO NEI MESSAGGI

   `{titolo}`, `{streamer}`, `{url}`: la stessa sostituzione serviva agli
   annunci Twitch, a quelli YouTube e RSS, agli avvisi del filtro sui link e
   all'anteprima del pannello. Erano quattro implementazioni, e già divergevano
   — una sostituiva solo i nomi che conosceva, un'altra lasciava il segnaposto
   grezzo quando il valore mancava, una terza faceva `replaceAll` a mano voce
   per voce e quindi ignorava qualsiasi variabile aggiunta dopo.

   Il segnaposto sconosciuto resta com'è di proposito: chi scrive `{titolo}`
   dove la piattaforma non lo prevede deve vederlo nell'anteprima, non trovarsi
   un buco nel messaggio pubblicato.
   ═══════════════════════════════════════════════════════════════════════ */

export function applicaModello(testo: string, valori: Record<string, string | number>): string {
  return testo.replace(/\{(\w+)\}/g, (intero, chiave: string) => {
    const valore = valori[chiave];
    return valore === undefined ? intero : String(valore);
  });
}

/** I segnaposto usati in un testo: serve all'anteprima e alla diagnosi. */
export function segnapostiUsati(testo: string): string[] {
  const trovati = [...testo.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  return [...new Set(trovati)];
}
