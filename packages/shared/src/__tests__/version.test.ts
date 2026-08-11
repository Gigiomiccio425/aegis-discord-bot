import { describe, expect, it } from 'vitest';
import { readServiceVersions } from '../version.js';

/** Redis finto: risponde da una mappa, senza rete né server. */
function fakeRedis(values: Record<string, string>) {
  return {
    set: async () => undefined,
    get: async (key: string) => values[key] ?? null,
  };
}

describe('versioni dei servizi', () => {
  /*
   * Il guasto che questo controllo intercetta non assomiglia a un guasto: il
   * pannello mostra la versione nuova, il bot continua a comportarsi come
   * prima, e la conclusione naturale è che la correzione non funzioni. Senza
   * il confronto, l'unico modo di accorgersene è ispezionare i container a
   * mano — cioè sapere già cosa cercare.
   */
  it('riconosce quando tutti girano la stessa versione', async () => {
    const redis = fakeRedis({
      'version:bot': '1.1.0',
      'version:worker': '1.1.0',
      'version:api': '1.1.0',
    });
    const result = await readServiceVersions(redis, '1.1.0');
    expect(result.aligned).toBe(true);
    expect(result.stale).toEqual([]);
  });

  it('segnala il servizio rimasto alla versione precedente', async () => {
    const redis = fakeRedis({
      'version:bot': '1.0.0',
      'version:worker': '1.1.0',
      'version:api': '1.1.0',
    });
    const result = await readServiceVersions(redis, '1.1.0');
    expect(result.aligned).toBe(false);
    expect(result.stale).toEqual(['bot']);
    expect(result.services.bot).toBe('1.0.0');
  });

  it('tratta chi non risponde come rimasto indietro', async () => {
    // Un container fermo e un container vecchio sono lo stesso problema: in
    // entrambi i casi non sta girando ciò che dovrebbe.
    const redis = fakeRedis({ 'version:api': '1.1.0' });
    const result = await readServiceVersions(redis, '1.1.0');
    expect(result.stale).toEqual(['bot', 'worker']);
    expect(result.services.worker).toBeNull();
  });
});
