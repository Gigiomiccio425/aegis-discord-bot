import { describe, expect, it } from 'vitest';
import {
  announceVersion,
  readServiceVersions,
  segnalaNelLog,
  type ProblemaVersione,
} from '../version.js';

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
 * Il pannello scriveva «bot: fermo» per un bot collegato, e non c'era una
 * riga da nessuna parte che dicesse perché: la scrittura aveva
 * `() => undefined` su entrambi i rami, quindi un rifiuto di Redis spariva.
 *
 * Adesso ogni modo di fallire ha un nome. Non ripara la causa — che può
 * stare fuori dal processo — ma la rende leggibile.
 */
describe('quando la versione non si dichiara', () => {
  const tipi = (problemi: ProblemaVersione[]) => problemi.map((p) => p.tipo);

  it('dice quando Redis rifiuta la scrittura, e non prova a rileggere', async () => {
    const problemi: ProblemaVersione[] = [];
    const redis = {
      set: async () => {
        throw new Error('READONLY finto');
      },
      get: async () => null,
    };

    await announceVersion(redis, 'bot', (problema) => problemi.push(problema));

    // Rileggere una chiave che non si è riusciti a scrivere aggiungerebbe
    // solo una seconda riga che dice la stessa cosa peggio.
    expect(tipi(problemi)).toEqual(['scrittura']);
  });

  /*
   * Il caso che inganna di più: con Redis irraggiungibile ioredis non
   * fallisce, accoda. La promessa non si risolve né si rifiuta, quindi
   * «nessun errore» non vuol dire «scritto».
   */
  it('dice quando Redis non risponde affatto', async () => {
    const problemi: ProblemaVersione[] = [];
    let letture = 0;
    const redis = {
      set: () => new Promise<void>(() => undefined),
      get: async () => {
        letture += 1;
        return null;
      },
    };

    await announceVersion(redis, 'bot', (problema) => problemi.push(problema));

    expect(tipi(problemi)).toEqual(['lenta']);
    expect(letture, 'non si rilegge una scrittura che non è arrivata').toBe(0);
  }, 6000);

  it('dice quando la scrive senza errori e rileggendola non c’è', async () => {
    const problemi: ProblemaVersione[] = [];
    const redis = {
      set: async () => 'OK',
      get: async () => null,
    };

    await announceVersion(redis, 'bot', (problema) => problemi.push(problema));

    const rilettura = problemi.find((p) => p.tipo === 'rilettura');
    expect(rilettura, 'una scrittura che non si rilegge deve essere segnalata').toBeTruthy();
    expect(rilettura?.tipo === 'rilettura' && rilettura.letto).toBeNull();
  });

  /*
   * IL TETTO SULLA RILETTURA
   *
   * La prima versione di questo codice aspettava il GET senza limite. Con
   * Redis che risponde alla scrittura e poi si ammutolisce, l'attesa non
   * finiva — e nel bot questa funzione si aspetta **prima** del collegamento
   * a Discord. La diagnosi reintroduceva il blocco all'avvio che doveva
   * spiegare.
   */
  it('una rilettura che non risponde non trattiene l’avvio', async () => {
    const redis = {
      set: async () => 'OK',
      get: () => new Promise<string | null>(() => undefined),
    };

    await expect(
      Promise.race([
        announceVersion(redis, 'bot', () => undefined),
        new Promise((_, ko) => setTimeout(() => ko(new Error('mai finito')), 4000)),
      ]),
    ).resolves.toBeUndefined();
  }, 6000);

  it('quando tutto funziona non segnala niente', async () => {
    const problemi: ProblemaVersione[] = [];
    const memoria = new Map<string, string>();
    const redis = {
      set: async (chiave: string, valore: string) => {
        memoria.set(chiave, valore);
        return 'OK';
      },
      get: async (chiave: string) => memoria.get(chiave) ?? null,
    };

    await announceVersion(redis, 'bot', (problema) => problemi.push(problema));

    // La controprova: la chiave c'è davvero, quindi il silenzio è quello buono.
    expect(memoria.get('version:bot')).toBeTruthy();
    expect(problemi).toEqual([]);
  });

  it('nel log, i guasti sono errori e la lentezza è un avviso', () => {
    const righe: string[] = [];
    const logger = {
      error: (_: object, messaggio: string) => righe.push(`error ${messaggio}`),
      warn: (_: object, messaggio: string) => righe.push(`warn ${messaggio}`),
    };
    const segnala = segnalaNelLog(logger);

    segnala({ tipo: 'scrittura', errore: new Error('x') });
    segnala({ tipo: 'lenta', attesaMs: 2000 });
    segnala({ tipo: 'rilettura', letto: null, atteso: '1.0.0' });

    expect(righe.map((riga) => riga.split(' ')[0])).toEqual(['error', 'warn', 'error']);
  });
});
