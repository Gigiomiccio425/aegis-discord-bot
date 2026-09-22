/* ═══════════════════════════════════════════════════════════════════════
   IL CICLO DEGLI EVENTI È ANCORA LIBERO?

   Un processo Node con il ciclo degli eventi bloccato non sembra rotto.
   Non esce, non scrive niente, non dà errori: semplicemente smette di fare
   le cose a tempo. I timer non partono, le risposte non arrivano, e le
   chiavi che quel processo doveva riscrivere scadono.

   Il sintomo che ne esce è ingannevole. Il pannello legge `version:bot`, non
   la trova, e scrive «bot: fermo» — di un processo vivo, che risulta attivo
   a `docker ps`. Dai log, un ciclo bloccato e un Redis che rifiuta le
   scritture sono identici: in entrambi la chiave manca e basta.

   Qui c'è un cronometro che misura quanto tardi arriva rispetto a quando
   aveva chiesto di essere chiamato. Se un giro arriva con secondi di
   ritardo, il ciclo era occupato — e adesso si vede, con quanto.

   Costa un timer e una sottrazione. Non dice **chi** ha bloccato il ciclo,
   ma dice che è successo e quando: da lì i log intorno restringono il campo
   a pochi candidati, che è l'unica cosa che mancava.

   ── Perché `performance.now()` e non `Date.now()` ──────────────────────

   La prima versione misurava con l'orologio di sistema. Quello può saltare:
   NTP lo corregge dopo l'avvio, e su una macchina rimasta spenta la
   correzione è di minuti. Un salto in avanti sembrava un ciclo bloccato
   per tutto quel tempo, e il sorvegliante lo diceva — il falso allarme che
   fa spegnere un sorvegliante. `performance.now()` conta il tempo passato,
   non l'ora, e non salta.
   ═══════════════════════════════════════════════════════════════════════ */

export interface Ritardo {
  /** Di quanto è arrivato tardi il giro, in millisecondi. */
  ritardoMs: number;
  /** Ogni quanto dovrebbe arrivare. */
  passoMs: number;
}

/** Sotto questa soglia è normale: il ciclo fa sempre qualcosa. */
const SOGLIA_MS = 2_000;

/**
 * Avvia il cronometro. Restituisce la funzione che lo ferma.
 *
 * Il timer è `unref`: non deve tenere vivo il processo da solo, altrimenti un
 * processo che ha finito non si spegnerebbe più.
 *
 * `orologio` si cambia solo nei test: un ciclo bloccato non si può produrre
 * a comando, un orologio che avanza più del timer sì.
 */
export function sorvegliaCicloEventi(
  segnala: (ritardo: Ritardo) => void,
  passoMs = 5_000,
  sogliaMs = SOGLIA_MS,
  orologio: () => number = () => performance.now(),
): () => void {
  let atteso = orologio() + passoMs;

  const timer = setInterval(() => {
    const adesso = orologio();
    const ritardoMs = adesso - atteso;
    atteso = adesso + passoMs;

    if (ritardoMs > sogliaMs) segnala({ ritardoMs, passoMs });
  }, passoMs);

  timer.unref?.();

  return () => clearInterval(timer);
}
