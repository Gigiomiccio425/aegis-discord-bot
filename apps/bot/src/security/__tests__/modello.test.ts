import { describe, expect, it } from 'vitest';
import { defaultGuildConfig } from '@angel/shared';
import { CANALI_PER_MODELLO, MODELLI, RUOLI_PER_MODELLO, type NomeModello } from '../modello.js';

/*
 * Il modello crea decine di canali e ne scrive gli ID nella configurazione.
 * Le cose che possono andare storte sono silenziose: un percorso di
 * configurazione che non esiste più — e il canale viene creato senza essere
 * collegato a niente — oppure due canali con lo stesso nome nella stessa
 * categoria, che al secondo avvio diventano quattro.
 */

function esiste(config: Record<string, unknown>, percorso: string): boolean {
  return (
    percorso.split('.').reduce<unknown>((valore, chiave) => {
      if (valore === null || typeof valore !== 'object') return undefined;
      return (valore as Record<string, unknown>)[chiave];
    }, config) !== undefined
  );
}

const MODELLI_CHIAVI = Object.keys(MODELLI) as NomeModello[];

/*
 * I controlli valgono per ogni modello: aggiungerne uno senza ripassare da
 * qui è esattamente il modo in cui il secondo prende un difetto che il primo
 * non aveva.
 */
describe.each(MODELLI_CHIAVI)('modello del server (%s)', (nome) => {
  const config = defaultGuildConfig() as unknown as Record<string, unknown>;
  const CANALI_MODELLO = CANALI_PER_MODELLO[nome];
  const RUOLI_MODELLO_NOMI = RUOLI_PER_MODELLO[nome];

  it('scrive solo su campi di configurazione che esistono', () => {
    const inventati = CANALI_MODELLO.flatMap((canale) => canale.percorsi ?? []).filter(
      (percorso) => !esiste(config, percorso),
    );
    expect(inventati).toEqual([]);
  });

  it('non ha due canali con lo stesso nome nella stessa categoria', () => {
    // Discord riscrive i nomi dei testuali in minuscolo con i trattini: due
    // nomi diversi possono diventare lo stesso canale, e la ricerca per nome
    // che rende il comando idempotente smetterebbe di funzionare.
    const perCategoria = new Map<string, string[]>();
    for (const canale of CANALI_MODELLO) {
      const normalizzato =
        canale.tipo === 'vocale' ? canale.nome.trim() : canale.nome.trim().toLowerCase().replace(/\s+/g, '-');
      const elenco = perCategoria.get(canale.categoria) ?? [];
      elenco.push(normalizzato);
      perCategoria.set(canale.categoria, elenco);
    }

    for (const [categoria, nomi] of perCategoria) {
      expect(new Set(nomi).size, `doppioni in ${categoria}`).toBe(nomi.length);
    }
  });

  it('i nomi dei ruoli non si ripetono', () => {
    expect(new Set(RUOLI_MODELLO_NOMI).size).toBe(RUOLI_MODELLO_NOMI.length);
  });

  it('esiste il canale del regolamento e quello degli aggiornamenti', () => {
    // Sono i due che Discord pretende per la modalità community: senza,
    // l'attivazione fallisce con un errore che parla d'altro.
    const nomi = CANALI_MODELLO.map((canale) => canale.nome);
    expect(nomi.some((nome) => nome.includes('regolamento'))).toBe(true);
    expect(nomi.some((nome) => nome.includes('aggiornamenti-server'))).toBe(true);
  });

  it('i canali di sola lettura non sono anche riservati', () => {
    // Sarebbero due permessi che si contraddicono: nascosto a tutti e insieme
    // leggibile da tutti.
    const confusi = CANALI_MODELLO.filter((canale) => canale.soloLettura && canale.riservato);
    expect(confusi.map((canale) => canale.nome)).toEqual([]);
  });
});
