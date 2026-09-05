import { describe, expect, it } from 'vitest';
import { announceVersion, readServiceVersions } from '../version.js';

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

  /*
   * La diagnosi sbagliata che questo evita.
   *
   * Il bot dichiara la versione *prima* di collegarsi a Discord, apposta per
   * essere visibile quando il collegamento fallisce. Ma la scrittura partiva
   * senza essere attesa, e con un token rifiutato il processo chiama
   * process.exit poche centinaia di millisecondi dopo: la scrittura restava
   * per strada e il pannello mostrava «bot: non risponde».
   *
   * Quel messaggio dice «ricrea il container», che con un token sbagliato non
   * serve a niente. La versione presente accanto al bot fermo è l'indizio che
   * porta altrove — al token.
   */
  it('la prima dichiarazione è arrivata quando announceVersion finisce', async () => {
    const scritte: string[] = [];
    let sblocca: () => void = () => undefined;
    const lenta = new Promise<void>((r) => {
      sblocca = r;
    });

    const redis = {
      set: async (chiave: string) => {
        await lenta;
        scritte.push(chiave);
      },
      get: async () => null,
    };

    const finito = announceVersion(redis, 'bot');

    // La controprova: finché Redis non ha risposto, non deve risultare fatta.
    expect(scritte).toEqual([]);

    sblocca();
    await finito;
    expect(scritte).toEqual(['version:bot']);
  });

  /*
   * E il rovescio: con Redis irraggiungibile ioredis non fallisce, accoda. Un
   * avvio che aspetta senza tetto non ripartirebbe più — proprio nel caso in
   * cui conviene partire lo stesso per poter dire cosa non va.
   */
  it('non aspetta all’infinito se Redis non risponde mai', async () => {
    const redis = {
      set: () => new Promise<void>(() => undefined),
      get: async () => null,
    };

    await expect(
      Promise.race([
        announceVersion(redis, 'bot'),
        new Promise((_, ko) => setTimeout(() => ko(new Error('mai finito')), 4000)),
      ]),
    ).resolves.toBeUndefined();
  }, 6000);
});
