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

/*
 * QUANDO LA DICHIARAZIONE NON ARRIVA
 *
 * Il pannello scriveva «bot: fermo» per un bot collegato e funzionante, e non
 * c’era una riga da nessuna parte che dicesse perché: la scrittura aveva
 * `() => undefined` su entrambi i rami, quindi un rifiuto di Redis spariva.
 *
 * Adesso ogni modo di fallire ha un nome. Non ripara la causa — che può
 * stare fuori dal processo — ma la rende leggibile, e senza questi tre casi
 * si torna a indovinare.
 */
describe('quando la versione non si dichiara', () => {
  it("dice quando Redis rifiuta la scrittura", async () => {
    const problemi: unknown[] = [];
    const redis = {
      set: async () => { throw new Error('READONLY finto'); },
      get: async () => null,
    };

    await announceVersion(redis, 'bot', (problema) => problemi.push(problema));

    expect(problemi.map((p) => (p as { tipo: string }).tipo)).toContain('scrittura');
  });

  /*
   * Il caso che inganna di più: con Redis irraggiungibile ioredis non
   * fallisce, accoda. La promessa non si risolve né si rifiuta, quindi
   * «nessun errore» non vuol dire «scritto».
   */
  it("dice quando Redis non risponde affatto", async () => {
    const problemi: unknown[] = [];
    const redis = {
      set: () => new Promise<void>(() => undefined),
      get: async () => null,
    };

    await announceVersion(redis, 'bot', (problema) => problemi.push(problema));

    expect(problemi.map((p) => (p as { tipo: string }).tipo)).toContain('lenta');
  }, 6000);

  /*
   * Il caso visto in produzione: la scrittura non dà errore, e la chiave non
   * c’è. Scritta su un altro Redis, scaduta subito, tolta da qualcuno: da
   * dentro il processo non si distinguono, e nessuno dei tre si vedeva.
   */
  it("dice quando la scrive senza errori e rileggendola non c’è", async () => {
    const problemi: unknown[] = [];
    const redis = {
      set: async () => 'OK',
      get: async () => null,
    };

    await announceVersion(redis, 'bot', (problema) => problemi.push(problema));

    const rilettura = problemi.find((p) => (p as { tipo: string }).tipo === "rilettura");
    expect(rilettura, 'una scrittura che non si rilegge deve essere segnalata').toBeTruthy();
    expect((rilettura as { letto: string | null }).letto).toBeNull();
  });

  it("quando tutto funziona non segnala niente", async () => {
    const problemi: unknown[] = [];
    const memoria = new Map<string, string>();
    const redis = {
      set: async (chiave: string, valore: string) => { memoria.set(chiave, valore); return 'OK'; },
      get: async (chiave: string) => memoria.get(chiave) ?? null,
    };

    await announceVersion(redis, 'bot', (problema) => problemi.push(problema));

    // La controprova: la chiave c’è davvero, quindi il silenzio è quello buono.
    expect(memoria.get('version:bot')).toBeTruthy();
    expect(problemi).toEqual([]);
  });
});
