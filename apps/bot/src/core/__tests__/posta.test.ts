import { describe, expect, it } from 'vitest';
import { Posta, type ComandoBot, type Esito } from '@angel/shared';
import { consumaPosta, type DipendenzePosta } from '../posta.js';

/* ═══════════════════════════════════════════════════════════════════════
   LO STESSO COMANDO, ALL'INFINITO

   Il guasto visto in produzione: nei log, uno snapshot creato ogni due
   secondi, una revisione di sicurezza ogni due secondi, tre promemoria
   «scaduto, non eseguito» ogni due secondi con il ritardo che cresceva.
   Sembrava uno scheduler impazzito. Non lo era: era **lo stesso comando**
   riconsegnato e rieseguito per sempre.

   La causa: il recupero delle voci in sospeso rileggeva sempre da `'0'`.
   Finché la pagina non tornava vuota, il cursore non passava a `'>'`. Basta
   **una** voce che non si riesce a confermare perché la pagina non sia mai
   vuota — e allora ogni altra voce in sospeso viene riletta, e rieseguita, a
   ogni giro. Su comandi che creano snapshot e scrivono su Discord.

   Qui sotto c'è un Redis finto con un vero elenco di voci in sospeso: è
   l'unico modo di far vedere il ciclo senza un Redis in piedi.
   ═══════════════════════════════════════════════════════════════════════ */

/** Una voce dello stream, come la scrive `inviaAlBot`. */
function voce(id: string, comando: ComandoBot, creatoIl = Date.now()): [string, string[]] {
  const campi = [
    'id',
    `uuid-${id}`,
    'c',
    JSON.stringify(comando),
    't',
    String(creatoIl),
    's',
    '3600000',
    'k',
    '',
  ];
  return [id, campi];
}

/**
 * Redis finto, con le sole semantiche che contano:
 * XREADGROUP con identificativo esplicito legge le voci **in sospeso**
 * successive a quell'identificativo; con `'>'` legge quelle nuove; XACK le
 * toglie dal sospeso; XDEL le toglie dallo stream.
 */
function redisFinto(iniziali: [string, string[]][], nonConfermabili = new Set<string>()) {
  const sospese = new Map(iniziali);
  const nuove: [string, string[]][] = [];
  const scritture = new Map<string, string>();
  let letture = 0;

  const call = async (comando: string, ...args: (string | number)[]): Promise<unknown> => {
    const nome = comando.toUpperCase();

    if (nome === 'XGROUP') return 'OK';

    if (nome === 'XACK') {
      const id = String(args[2]);
      if (nonConfermabili.has(id)) throw new Error('NOACK finto: conferma rifiutata');
      sospese.delete(id);
      return 1;
    }

    if (nome === 'XDEL') return 1;

    if (nome === 'XREADGROUP') {
      letture += 1;
      // Una lettura che non finisce mai vuol dire ciclo: si ferma il test
      // invece di aspettare il timeout, che direbbe molto meno.
      if (letture > 200) throw new Error('ciclo: troppe letture');

      const cursore = String(args[args.length - 1]);
      if (cursore === '>') {
        const pagina = nuove.splice(0, nuove.length);
        if (pagina.length) return [[Posta.stream, pagina]];
        // BLOCK: senza l'attesa il ciclo girerebbe a vuoto migliaia di volte e
        // il conteggio delle letture non direbbe più niente.
        await new Promise((risolvi) => setTimeout(risolvi, 50));
        return null;
      }

      const elenco = [...sospese.entries()].filter(([id]) => id > cursore);
      return [[Posta.stream, elenco]];
    }

    return null;
  };

  const dipendenze: DipendenzePosta = {
    redis: {
      call,
      set: async (chiave: string, valore: string) => {
        scritture.set(chiave, valore);
        return 'OK';
      },
      get: async () => null,
      del: async () => 1,
    },
    lettore: { call },
    esegui: async (): Promise<Esito> => ({ stato: 'fatto', messaggio: 'ok' }),
    pronto: () => true,
  };

  return { dipendenze, sospese, scritture, letture: () => letture };
}

/** Lascia girare il ciclo finché non si ferma da solo. */
async function lascia(millisecondi = 300): Promise<void> {
  await new Promise((risolvi) => setTimeout(risolvi, millisecondi));
}

describe('recupero dei comandi in sospeso', () => {
  it('esegue una sola volta quello che trova in sospeso', async () => {
    const eseguiti: string[] = [];
    const finto = redisFinto([
      voce('1-0', { action: 'snapshot.create', guildId: 'g1' }),
      voce('2-0', { action: 'security.audit', guildId: 'g1' }),
    ]);
    finto.dipendenze.esegui = async (comando) => {
      eseguiti.push(comando.action);
      return { stato: 'fatto', messaggio: 'ok' };
    };

    const ferma = consumaPosta(finto.dipendenze);
    await lascia();
    await ferma();

    expect(eseguiti).toEqual(['snapshot.create', 'security.audit']);
    expect(finto.sospese.size, 'voci rimaste in sospeso').toBe(0);
  });

  /*
   * Il test che descrive il guasto vero.
   *
   * Una voce che non si riesce a confermare resta in sospeso: è inevitabile e
   * va bene. Quello che non deve succedere è che trascini con sé le altre.
   * Prima, con il cursore fermo a `'0'`, `security.audit` e `message.send`
   * venivano rieseguiti a ogni giro — per sempre.
   */
  it('una voce che non si conferma non fa rieseguire le altre', async () => {
    const eseguiti: string[] = [];
    const finto = redisFinto(
      [
        voce('1-0', { action: 'snapshot.create', guildId: 'g1' }),
        voce('2-0', { action: 'security.audit', guildId: 'g1' }),
        voce('3-0', { action: 'message.send', guildId: 'g2' }),
      ],
      new Set(['1-0']), // questa non si lascia confermare
    );
    finto.dipendenze.esegui = async (comando) => {
      eseguiti.push(comando.action);
      return { stato: 'fatto', messaggio: 'ok' };
    };

    const ferma = consumaPosta(finto.dipendenze);
    await lascia();
    await ferma();

    // Ognuna una volta sola, compresa quella che non si è confermata.
    expect(eseguiti.filter((a) => a === 'snapshot.create')).toHaveLength(1);
    expect(eseguiti.filter((a) => a === 'security.audit')).toHaveLength(1);
    expect(eseguiti.filter((a) => a === 'message.send')).toHaveLength(1);

    // La controprova che il guasto sarebbe stato visibile: la voce ostinata è
    // ancora lì. Se fosse sparita, il test passerebbe anche senza la correzione.
    expect(finto.sospese.has('1-0'), 'la voce non confermabile deve restare').toBe(true);
  });

  it('un comando illeggibile non blocca la coda', async () => {
    const eseguiti: string[] = [];
    const finto = redisFinto([
      ['1-0', ['id', 'uuid-1', 'c', 'questo non è JSON', 't', String(Date.now()), 's', '3600000']],
      voce('2-0', { action: 'poll.close', guildId: 'g1' }),
    ]);
    finto.dipendenze.esegui = async (comando) => {
      eseguiti.push(comando.action);
      return { stato: 'fatto', messaggio: 'ok' };
    };

    const ferma = consumaPosta(finto.dipendenze);
    await lascia();
    await ferma();

    expect(eseguiti).toEqual(['poll.close']);
    expect(finto.sospese.size, 'anche l’illeggibile va confermata e scartata').toBe(0);
  });

  /*
   * Un comando oltre la sua scadenza non si esegue — ma si conferma lo stesso.
   * Prima veniva rifiutato e lasciato in sospeso: i tre «scaduto, non
   * eseguito» che tornavano ogni due secondi nei log erano questi.
   */
  it('un comando scaduto si rifiuta una volta sola', async () => {
    const eseguiti: string[] = [];
    const vecchio = Date.now() - 10 * 60_000;
    const campi = [
      'id',
      'uuid-1',
      'c',
      JSON.stringify({ action: 'events.reminders', guildId: 'g1' }),
      't',
      String(vecchio),
      's',
      '120000',
      'k',
      '',
    ];
    const finto = redisFinto([['1-0', campi]]);
    finto.dipendenze.esegui = async (comando) => {
      eseguiti.push(comando.action);
      return { stato: 'fatto', messaggio: 'ok' };
    };

    const ferma = consumaPosta(finto.dipendenze);
    await lascia();
    await ferma();

    expect(eseguiti, 'un comando scaduto non si esegue').toEqual([]);
    expect(finto.sospese.size, 'ma si conferma, o torna per sempre').toBe(0);

    const salvato = finto.scritture.get(Posta.esito('uuid-1'));
    expect(salvato, 'il mittente deve poter leggere perché').toBeTruthy();
    expect((JSON.parse(salvato!) as { stato: string }).stato).toBe('scaduto');
  });

  it('anche se l’esecuzione lancia, la voce viene confermata', async () => {
    const finto = redisFinto([voce('1-0', { action: 'lockdown.enable', guildId: 'g1' })]);
    finto.dipendenze.esegui = async () => {
      throw new Error('Discord ha detto di no');
    };

    const ferma = consumaPosta(finto.dipendenze);
    await lascia();
    await ferma();

    expect(finto.sospese.size, 'un errore non deve lasciare la voce in sospeso').toBe(0);
  });
});
