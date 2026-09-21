import type { Client } from 'discord.js';
import type { Redis } from 'ioredis';
import { RedisKeys } from '@angel/shared';
import { describe, expect, it, vi } from 'vitest';
import { ascoltaComandiDalPannello } from '../ascoltoPannello.js';

/* ═══════════════════════════════════════════════════════════════════════
   IL GUASTO CHE QUESTI TEST ESISTONO PER FERMARE

   L'ascolto dei comandi stava nell'avvio, con un `await`, prima del
   collegamento a Discord. Su una connessione con `maxRetriesPerRequest:
   null` — quella che BullMQ impone — `subscribe` con Redis muto non
   fallisce: resta in coda. L'avvio si fermava lì. Il bot non compariva su
   Discord, il pannello diceva «bot fermo», e nei log non c'era niente,
   perché non era successo niente: era tutto ancora in attesa.

   Un guasto così non lo prende nessun test scritto dopo il fatto, a meno
   che non si riproduca la cosa che lo rende invisibile: una promessa che
   non si risolve **e** non fallisce. È quello che fa `maiRisponde` qui
   sotto.
   ═══════════════════════════════════════════════════════════════════════ */

/** Il client Discord non serve: viene solo passato a chi esegue il comando. */
const clientFinto = {} as Client;

/** Una promessa che non finisce mai: Redis che accoda invece di rifiutare. */
const maiRisponde = () => new Promise<never>(() => {});

interface RedisFinto {
  redis: Redis;
  /** Recapita un messaggio come farebbe Redis. */
  recapita: (canale: string, messaggio: string) => void;
  sottoscrizioni: string[];
}

function redisFinto(subscribe: (canale: string) => Promise<unknown>): RedisFinto {
  const ascoltatori: ((canale: string, messaggio: string) => void)[] = [];
  const sottoscrizioni: string[] = [];

  const redis = {
    on(evento: string, gestore: (canale: string, messaggio: string) => void) {
      if (evento === 'message') ascoltatori.push(gestore);
      return redis;
    },
    subscribe(canale: string) {
      sottoscrizioni.push(canale);
      return subscribe(canale);
    },
  } as unknown as Redis;

  return {
    redis,
    sottoscrizioni,
    recapita: (canale, messaggio) => {
      for (const gestore of ascoltatori) gestore(canale, messaggio);
    },
  };
}

describe('ascolto dei comandi dal pannello', () => {
  it('quando Redis risponde, si mette in ascolto al primo tentativo', async () => {
    const finto = redisFinto(async () => 1);

    const esito = await ascoltaComandiDalPannello(clientFinto, {
      subscriber: finto.redis,
      esegui: async () => undefined,
      tentativiMax: 1,
    });

    expect(esito).toBe(true);
    expect(finto.sottoscrizioni).toEqual([RedisKeys.commandChannel]);
  });

  /*
   * IL TEST CHE CONTA
   *
   * `subscribe` non risolve e non fallisce, esattamente come con Redis
   * irraggiungibile. Senza il tetto di tempo questa chiamata non tornerebbe
   * mai, e il test resterebbe appeso finché vitest non lo uccide — che è
   * poi quello che succedeva al bot, senza nessuno che lo uccidesse.
   */
  it('con Redis che non risponde, restituisce il controllo invece di restare appeso', async () => {
    const finto = redisFinto(maiRisponde);

    const esito = await ascoltaComandiDalPannello(clientFinto, {
      subscriber: finto.redis,
      esegui: async () => undefined,
      tettoMs: 5,
      attesaMs: 1,
      tentativiMax: 2,
    });

    expect(esito, 'nessuna sottoscrizione riuscita').toBe(false);
    expect(finto.sottoscrizioni, 'ha riprovato, non si è arreso al primo').toHaveLength(2);
  });

  it('dopo un tentativo andato male riprova, e il secondo vale', async () => {
    let chiamate = 0;
    const finto = redisFinto(async () => {
      chiamate += 1;
      if (chiamate === 1) throw new Error('Redis non pronto');
      return 1;
    });

    const esito = await ascoltaComandiDalPannello(clientFinto, {
      subscriber: finto.redis,
      esegui: async () => undefined,
      attesaMs: 1,
      tentativiMax: 5,
    });

    expect(esito).toBe(true);
    expect(chiamate).toBe(2);
  });

  it('un comando sul canale giusto arriva a chi lo esegue', async () => {
    const eseguiti: string[] = [];
    const finto = redisFinto(async () => 1);

    await ascoltaComandiDalPannello(clientFinto, {
      subscriber: finto.redis,
      esegui: async (_client, messaggio) => {
        eseguiti.push(messaggio);
      },
      tentativiMax: 1,
    });

    finto.recapita(RedisKeys.commandChannel, '{"action":"lockdown.enable"}');

    expect(eseguiti).toEqual(['{"action":"lockdown.enable"}']);
  });

  /*
   * La controprova. Senza, un gestore che esegue qualunque cosa arrivi su
   * qualunque canale passerebbe il test qui sopra — e il bot eseguirebbe
   * comandi presi da un canale che non è il suo.
   */
  it('un messaggio su un altro canale non viene eseguito', async () => {
    const eseguiti: string[] = [];
    const finto = redisFinto(async () => 1);

    await ascoltaComandiDalPannello(clientFinto, {
      subscriber: finto.redis,
      esegui: async (_client, messaggio) => {
        eseguiti.push(messaggio);
      },
      tentativiMax: 1,
    });

    finto.recapita('un:altro:canale', '{"action":"lockdown.enable"}');

    expect(eseguiti).toEqual([]);
  });

  /*
   * Il gestore si registra prima della sottoscrizione, di proposito: un
   * comando che arriva mentre la sottoscrizione è ancora in corso deve
   * trovare qualcuno. Se si registrasse dopo, andrebbe perso in silenzio —
   * che è la famiglia di guasti da cui nasce tutto questo file.
   */
  it('ascolta già mentre la sottoscrizione è ancora in corso', async () => {
    const eseguiti: string[] = [];
    let sblocca: (() => void) | undefined;
    const finto = redisFinto(
      () =>
        new Promise<number>((risolvi) => {
          sblocca = () => risolvi(1);
        }),
    );

    const inCorso = ascoltaComandiDalPannello(clientFinto, {
      subscriber: finto.redis,
      esegui: async (_client, messaggio) => {
        eseguiti.push(messaggio);
      },
      tentativiMax: 1,
    });

    finto.recapita(RedisKeys.commandChannel, '{"action":"snapshot.create"}');
    sblocca?.();
    await inCorso;

    expect(eseguiti).toEqual(['{"action":"snapshot.create"}']);
  });

  it('un comando che fallisce non ferma quelli dopo', async () => {
    const eseguiti: string[] = [];
    const finto = redisFinto(async () => 1);

    await ascoltaComandiDalPannello(clientFinto, {
      subscriber: finto.redis,
      esegui: async (_client, messaggio) => {
        eseguiti.push(messaggio);
        if (messaggio === 'rotto') throw new Error('comando fallito');
      },
      tentativiMax: 1,
    });

    finto.recapita(RedisKeys.commandChannel, 'rotto');
    finto.recapita(RedisKeys.commandChannel, 'buono');
    await vi.waitFor(() => expect(eseguiti).toEqual(['rotto', 'buono']));
  });
});
