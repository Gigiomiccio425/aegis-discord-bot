import { afterEach, describe, expect, it, vi } from 'vitest';
import { sorvegliaCicloEventi, type Ritardo } from '../sorveglia.js';

/* ═══════════════════════════════════════════════════════════════════════
   IL CRONOMETRO DEVE TACERE QUANDO VA TUTTO BENE

   Un sorvegliante che si lamenta anche quando non c'è niente che non va
   viene disattivato dopo tre giorni, e allora non sorveglia più niente. È
   il modo più comune in cui questi strumenti muoiono.

   Quindi prove opposte, e quelle che pretendono il silenzio contano quanto
   quella che pretende l'allarme: segnala quando il ciclo è stato fermo, e
   **non** segnala quando è stato libero — né quando è stato solo
   l'orologio di sistema a saltare.

   I timer sono finti, e l'orologio del cronometro è uno che avanzo a mano:
   un ciclo bloccato non si produce a comando, un orologio che va avanti più
   del timer sì. `performance` resta vero di proposito, fuori da `toFake`.
   ═══════════════════════════════════════════════════════════════════════ */

afterEach(() => {
  vi.useRealTimers();
});

/** Timer finti, e un orologio che avanza solo quando lo dico io. */
function preparaTempo() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  let adesso = 0;
  return {
    orologio: () => adesso,
    /** Il tempo passa, e i timer scattano come farebbero. */
    passa(ms: number) {
      adesso += ms;
      vi.advanceTimersByTime(ms);
    },
    /** Il ciclo resta occupato: il tempo passa, i timer no. */
    bloccato(ms: number) {
      adesso += ms;
    },
  };
}

describe('cronometro del ciclo degli eventi', () => {
  it('non dice niente quando i giri arrivano puntuali', () => {
    const tempo = preparaTempo();
    const visti: Ritardo[] = [];
    const ferma = sorvegliaCicloEventi((r) => visti.push(r), 1_000, 500, tempo.orologio);

    for (let giro = 0; giro < 10; giro++) tempo.passa(1_000);

    expect(visti, 'un sorvegliante rumoroso viene spento').toEqual([]);
    ferma();
  });

  /*
   * Il caso vero: il tempo è andato avanti molto più del timer. È quello
   * che succede quando il ciclo degli eventi resta occupato — i timer non
   * partono, e quando partono sono in ritardo.
   */
  it('dice di quanto il ciclo è rimasto fermo', () => {
    const tempo = preparaTempo();
    const visti: Ritardo[] = [];
    const ferma = sorvegliaCicloEventi((r) => visti.push(r), 1_000, 500, tempo.orologio);

    tempo.bloccato(9_000);
    tempo.passa(1_000);

    expect(visti).toHaveLength(1);
    expect(visti[0]!.ritardoMs).toBe(9_000);
    expect(visti[0]!.passoMs).toBe(1_000);
    ferma();
  });

  it('una volta fermato non parla più', () => {
    const tempo = preparaTempo();
    const visti: Ritardo[] = [];
    const ferma = sorvegliaCicloEventi((r) => visti.push(r), 1_000, 500, tempo.orologio);

    ferma();
    tempo.bloccato(60_000);
    tempo.passa(10_000);

    expect(visti).toEqual([]);
  });

  /*
   * IL FALSO ALLARME CHE HA FATTO CAMBIARE OROLOGIO
   *
   * Un'ora di salto dell'orologio di sistema — NTP che corregge una macchina
   * rimasta spenta — non è un ciclo bloccato. Con l'orologio predefinito non
   * deve dire niente.
   *
   * La controprova è nello stesso test: con `Date.now()`, lo stesso salto
   * viene preso per un'ora di blocco. Senza, il test passerebbe anche con un
   * cronometro che non segnala mai nulla.
   */
  it('un salto dell’orologio di sistema non è un ciclo bloccato', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

    const conPredefinito: Ritardo[] = [];
    const conDate: Ritardo[] = [];
    const fermaUno = sorvegliaCicloEventi((r) => conPredefinito.push(r), 1_000, 500);
    const fermaDue = sorvegliaCicloEventi((r) => conDate.push(r), 1_000, 500, () => Date.now());

    vi.setSystemTime(Date.now() + 3_600_000);
    vi.advanceTimersByTime(1_000);

    expect(conPredefinito, 'il salto dell’ora non è un blocco').toEqual([]);
    expect(conDate, 'controprova: con Date.now() sarebbe stato un allarme').toHaveLength(1);
    fermaUno();
    fermaDue();
  });
});
