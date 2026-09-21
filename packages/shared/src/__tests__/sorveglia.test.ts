import { afterEach, describe, expect, it, vi } from 'vitest';
import { sorvegliaCicloEventi, type Ritardo } from '../sorveglia.js';

/* ═══════════════════════════════════════════════════════════════════════
   IL CRONOMETRO DEVE TACERE QUANDO VA TUTTO BENE

   Un sorvegliante che si lamenta anche quando non c'è niente che non va
   viene disattivato dopo tre giorni, e allora non sorveglia più niente. È
   il modo più comune in cui questi strumenti muoiono.

   Quindi due prove opposte, e la seconda conta quanto la prima: segnala
   quando il ciclo è stato fermo, e **non** segnala quando è stato libero.
   ═══════════════════════════════════════════════════════════════════════ */

afterEach(() => {
  vi.useRealTimers();
});

describe('cronometro del ciclo degli eventi', () => {
  it('non dice niente quando i giri arrivano puntuali', () => {
    vi.useFakeTimers();
    const visti: Ritardo[] = [];
    const ferma = sorvegliaCicloEventi((r) => visti.push(r), 1_000, 500);

    // Dieci giri puntuali: il tempo finto avanza esattamente quanto serve.
    vi.advanceTimersByTime(10_000);

    expect(visti, 'un sorvegliante rumoroso viene spento').toEqual([]);
    ferma();
  });

  /*
   * Il caso vero: l'orologio è andato avanti molto più del timer. È quello
   * che succede quando il ciclo degli eventi resta occupato — i timer non
   * partono, e quando partono sono in ritardo.
   */
  it('dice di quanto il ciclo è rimasto fermo', () => {
    vi.useFakeTimers();
    const visti: Ritardo[] = [];
    const ferma = sorvegliaCicloEventi((r) => visti.push(r), 1_000, 500);

    vi.setSystemTime(Date.now() + 9_000);
    vi.advanceTimersByTime(1_000);

    expect(visti).toHaveLength(1);
    expect(visti[0]!.ritardoMs).toBeGreaterThan(7_000);
    expect(visti[0]!.passoMs).toBe(1_000);
    ferma();
  });

  it('una volta fermato non parla più', () => {
    vi.useFakeTimers();
    const visti: Ritardo[] = [];
    const ferma = sorvegliaCicloEventi((r) => visti.push(r), 1_000, 500);

    ferma();
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(10_000);

    expect(visti).toEqual([]);
  });
});
