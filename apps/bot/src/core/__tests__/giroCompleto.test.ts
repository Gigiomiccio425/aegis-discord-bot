import { describe, expect, it } from 'vitest';
import { attendiEsito, inviaAlBot, Posta, type Esito } from '@angel/shared';
import { consumaPosta, type DipendenzePosta } from '../posta.js';

/* ═══════════════════════════════════════════════════════════════════════
   DAL PANNELLO AL BOT, E RITORNO

   Il guasto che questo test esiste per trovare non l'ha trovato nessuno
   degli altri, e il motivo è preciso: gli altri partono da voci **già** nello
   stream, messe a mano. Verificano che il consumatore le legga.

   Non verificano che il produttore le scriva in un modo che il consumatore
   riesca a leggere. Se i due non sono d'accordo — sul nome dello stream, sul
   gruppo, sui campi, sull'ordine degli argomenti — ogni test passa e in
   produzione il pannello dice «ci sto lavorando» per sempre, senza un errore
   da nessuna parte.

   Qui sotto c'è un Redis finto con le semantiche vere degli stream: XADD che
   genera gli identificativi, XREADGROUP che distingue `'>'` dal recupero e
   tiene un vero elenco di voci in sospeso, XACK che le toglie. E sopra, le
   funzioni vere: `inviaAlBot` del pannello, `consumaPosta` del bot,
   `attendiEsito` che aspetta la risposta.
   ═══════════════════════════════════════════════════════════════════════ */

/** Redis finto, con gli stream come li fa Redis. */
function redisFinto() {
  /** Lo stream: identificativo → campi, in ordine di inserimento. */
  const stream = new Map<string, string[]>();
  /** Le voci consegnate e non ancora confermate, per gruppo. */
  const sospese = new Map<string, Set<string>>();
  /** Fin dove il gruppo ha consegnato. */
  let ultimoConsegnato = '0-0';
  let gruppoEsiste = false;
  let contatore = 0;

  const chiavi = new Map<string, string>();

  const prossimoId = (): string => {
    contatore += 1;
    return `1000-${contatore}`;
  };

  /** Confronto fra identificativi di stream, come lo fa Redis. */
  const maggiore = (a: string, b: string): boolean => {
    const [am, as] = a.split('-').map(Number);
    const [bm, bs] = b.split('-').map(Number);
    return am !== bm ? am! > bm! : as! > bs!;
  };

  const call = async (comando: string, ...args: (string | number)[]): Promise<unknown> => {
    const nome = comando.toUpperCase();
    const testo = args.map(String);

    if (nome === 'XGROUP') {
      if (gruppoEsiste) throw new Error('BUSYGROUP Consumer Group name already exists');
      gruppoEsiste = true;
      return 'OK';
    }

    if (nome === 'XADD') {
      // XADD <stream> MAXLEN ~ <n> * <campo> <valore> ...
      const stella = testo.indexOf('*');
      if (stella === -1) throw new Error('XADD finto: manca il *');
      const id = prossimoId();
      stream.set(id, testo.slice(stella + 1));
      return id;
    }

    if (nome === 'XACK') {
      const gruppo = testo[1]!;
      const id = testo[2]!;
      return sospese.get(gruppo)?.delete(id) ? 1 : 0;
    }

    if (nome === 'XDEL') {
      return stream.delete(testo[1]!) ? 1 : 0;
    }

    if (nome === 'XREADGROUP') {
      if (!gruppoEsiste) throw new Error('NOGROUP No such consumer group');

      const gruppo = testo[1]!;
      const cursore = testo[testo.length - 1]!;

      if (cursore === '>') {
        const nuove: [string, string[]][] = [];
        for (const [id, campi] of stream) {
          if (!maggiore(id, ultimoConsegnato)) continue;
          nuove.push([id, campi]);
          ultimoConsegnato = id;
          if (!sospese.has(gruppo)) sospese.set(gruppo, new Set());
          sospese.get(gruppo)!.add(id);
        }
        if (nuove.length === 0) {
          // BLOCK: Redis aspetta. Qui si aspetta poco, e si risponde vuoto.
          await new Promise((risolvi) => setTimeout(risolvi, 20));
          return null;
        }
        return [[Posta.stream, nuove]];
      }

      // Recupero: le voci in sospeso, dopo il cursore.
      const elenco = [...(sospese.get(gruppo) ?? [])]
        .filter((id) => maggiore(id, cursore))
        .map((id) => [id, stream.get(id) ?? []] as [string, string[]]);
      return [[Posta.stream, elenco]];
    }

    if (nome === 'SET') {
      // SET <chiave> <valore> [NX] [PX <ms>]
      const chiave = testo[0]!;
      const valore = testo[1]!;
      if (testo.includes('NX') && chiavi.has(chiave)) return null;
      chiavi.set(chiave, valore);
      return 'OK';
    }

    return null;
  };

  const redis = {
    call,
    set: async (chiave: string, valore: string) => {
      chiavi.set(chiave, valore);
      return 'OK';
    },
    get: async (chiave: string) => chiavi.get(chiave) ?? null,
    del: async (chiave: string) => (chiavi.delete(chiave) ? 1 : 0),
  };

  return { redis, stream, sospese, chiavi };
}

/** Il bot, con il Redis finto e un esecutore che si può osservare. */
function avviaBot(
  finto: ReturnType<typeof redisFinto>,
  esegui: DipendenzePosta['esegui'],
): () => Promise<void> {
  return consumaPosta({
    redis: finto.redis,
    lettore: { call: finto.redis.call },
    esegui,
    pronto: () => true,
  });
}

const respira = (ms = 250): Promise<void> => new Promise((risolvi) => setTimeout(risolvi, ms));

describe('un comando dal pannello arriva al bot e torna indietro', () => {
  /*
   * Il caso visto in produzione, dal vivo.
   *
   * Il pannello manda un comando, aspetta l'esito, e riceve «ci sto
   * lavorando» per sempre. Da fuori sembra un bot lento; in realtà il comando
   * non gli è mai arrivato.
   */
  it('il bot lo esegue, e l’esito torna a chi l’ha chiesto', async () => {
    const finto = redisFinto();
    const eseguiti: string[] = [];

    const ferma = avviaBot(finto, async (comando): Promise<Esito> => {
      eseguiti.push(comando.action);
      return { stato: 'fatto', messaggio: 'copia creata' };
    });

    // Il bot deve prima finire il recupero e mettersi in ascolto.
    await respira(120);

    const consegna = await inviaAlBot(finto.redis, {
      action: 'snapshot.create',
      guildId: '1272925031034523698',
      actorId: '586922655349866536',
      kind: 'MANUAL',
    });

    const esito = await attendiEsito(finto.redis, consegna.id, 3_000);
    await ferma();

    expect(eseguiti, 'il comando non è mai arrivato al bot').toEqual(['snapshot.create']);
    expect(esito?.stato).toBe('fatto');
    expect(esito?.messaggio).toBe('copia creata');
  });

  it('più comandi di fila arrivano tutti', async () => {
    const finto = redisFinto();
    const eseguiti: string[] = [];

    const ferma = avviaBot(finto, async (comando): Promise<Esito> => {
      eseguiti.push(comando.action);
      return { stato: 'fatto', messaggio: 'ok' };
    });
    await respira(120);

    for (const action of ['lockdown.enable', 'snapshot.create', 'lockdown.disable']) {
      await inviaAlBot(finto.redis, {
        action,
        guildId: '1272925031034523698',
        actorId: '586922655349866536',
        reason: 'prova',
      });
    }

    await respira(500);
    await ferma();

    expect(eseguiti).toEqual(['lockdown.enable', 'snapshot.create', 'lockdown.disable']);
  });

  /*
   * Il comando mandato **mentre il bot è giù** non si perde: resta nello
   * stream e parte quando il bot torna. È la promessa che distingue questa
   * posta dal pub/sub che c'era prima, e senza una prova è solo un'intenzione.
   */
  it('un comando mandato a bot spento parte quando il bot torna', async () => {
    const finto = redisFinto();

    const consegna = await inviaAlBot(finto.redis, {
      action: 'snapshot.create',
      guildId: '1272925031034523698',
      actorId: '586922655349866536',
      kind: 'MANUAL',
    });

    const eseguiti: string[] = [];
    const ferma = avviaBot(finto, async (comando): Promise<Esito> => {
      eseguiti.push(comando.action);
      return { stato: 'fatto', messaggio: 'recuperato' };
    });

    const esito = await attendiEsito(finto.redis, consegna.id, 3_000);
    await ferma();

    expect(eseguiti).toEqual(['snapshot.create']);
    expect(esito?.messaggio).toBe('recuperato');
  });

  it('quando il bot ha finito, la voce non resta in sospeso', async () => {
    const finto = redisFinto();

    const ferma = avviaBot(
      finto,
      async (): Promise<Esito> => ({ stato: 'fatto', messaggio: 'ok' }),
    );
    await respira(120);

    await inviaAlBot(finto.redis, {
      action: 'snapshot.create',
      guildId: '1272925031034523698',
      actorId: '586922655349866536',
      kind: 'MANUAL',
    });
    await respira(500);
    await ferma();

    const inSospeso = [...(finto.sospese.get(Posta.gruppo) ?? [])];
    expect(inSospeso, 'una voce confermata non deve restare in sospeso').toEqual([]);
  });
});
