import { describe, expect, it } from 'vitest';
import { archivioBlocchi, type DbBlocchi } from '../bloccoDurevole.js';
import type { LockdownState } from '../lockdown.js';

/* ═══════════════════════════════════════════════════════════════════════
   LA COPIA DELLO STATO DEL BLOCCO

   La copia esiste per un solo momento: la revoca di un blocco di cui Redis
   ha perso lo stato. In quel momento deve restituire l'elenco dei permessi
   di ruolo da rimettere, esattamente com'era.

   E deve restare un aiuto, mai un ostacolo: un database che non risponde
   non può fermare un lockdown, né far cadere il bot.
   ═══════════════════════════════════════════════════════════════════════ */

const stato: LockdownState = {
  versione: 2,
  reason: 'raid',
  channels: ['c1', 'c2'],
  startedAt: 1,
  expiresAt: 0,
  notices: [],
  dettagli: { c1: { bit: '2048', concessiPrima: '0', esisteva: true } },
  ruoli: [{ canaleId: 'c1', ruoloId: 'r1', bit: '2048' }],
  falliti: [],
};

/** Un database in memoria con la stessa forma di quella di Prisma. */
function dbInMemoria() {
  const righe = new Map<string, unknown>();
  const db: DbBlocchi = {
    lockdownRecord: {
      async upsert({ where, create, update }) {
        righe.set(where.guildId, righe.has(where.guildId) ? update.state : create.state);
        return {};
      },
      async findUnique({ where }) {
        return righe.has(where.guildId) ? { state: righe.get(where.guildId) as never } : null;
      },
      async deleteMany({ where }) {
        const presente = righe.delete(where.guildId);
        return { count: presente ? 1 : 0 };
      },
      async findMany() {
        return [...righe.keys()].map((guildId) => ({ guildId }));
      },
    },
  };
  return { db, righe };
}

/** Un database che fallisce a ogni domanda. */
const dbRotto: DbBlocchi = {
  lockdownRecord: {
    upsert: async () => {
      throw new Error('database irraggiungibile');
    },
    findUnique: async () => {
      throw new Error('database irraggiungibile');
    },
    deleteMany: async () => {
      throw new Error('database irraggiungibile');
    },
    findMany: async () => {
      throw new Error('database irraggiungibile');
    },
  },
};

describe('copia dello stato del blocco', () => {
  /*
   * IL TEST CHE CONTA
   *
   * Quello che si legge è quello che si è scritto, permessi di ruolo
   * compresi. È l'unica ragione per cui la copia esiste.
   */
  it('restituisce lo stato com’era, con i permessi di ruolo da rimettere', async () => {
    const { db } = dbInMemoria();
    const archivio = archivioBlocchi(db);

    await archivio.salva('g1', stato);
    const letto = await archivio.leggi('g1');

    expect(letto).toEqual(stato);
    expect(letto?.ruoli).toEqual([{ canaleId: 'c1', ruoloId: 'r1', bit: '2048' }]);
  });

  it('una seconda scrittura aggiorna la prima invece di affiancarla', async () => {
    const { db, righe } = dbInMemoria();
    const archivio = archivioBlocchi(db);

    await archivio.salva('g1', stato);
    await archivio.salva('g1', { ...stato, channels: ['c1', 'c2', 'c3'] });

    expect(righe.size).toBe(1);
    expect((await archivio.leggi('g1'))?.channels).toEqual(['c1', 'c2', 'c3']);
  });

  it('dopo la revoca non c’è più', async () => {
    const { db } = dbInMemoria();
    const archivio = archivioBlocchi(db);

    await archivio.salva('g1', stato);
    await archivio.cancella('g1');

    expect(await archivio.leggi('g1')).toBeNull();
    expect(await archivio.elenca()).toEqual(new Set());
  });

  it('elenca i server che hanno una copia, e solo quelli', async () => {
    const { db } = dbInMemoria();
    const archivio = archivioBlocchi(db);

    await archivio.salva('g1', stato);
    await archivio.salva('g2', stato);

    expect(await archivio.elenca()).toEqual(new Set(['g1', 'g2']));
  });

  /*
   * Una riga che non ha la forma di uno stato non è uno stato. Restituirla
   * significherebbe una revoca che rimette permessi da un elenco che non
   * c'è — meglio nessuna copia.
   */
  it('una riga con la forma sbagliata non è uno stato', async () => {
    const { db, righe } = dbInMemoria();
    righe.set('g1', { qualcosa: 'altro' });
    righe.set('g2', 'una stringa');
    righe.set('g3', null);

    const archivio = archivioBlocchi(db);

    expect(await archivio.leggi('g1')).toBeNull();
    expect(await archivio.leggi('g2')).toBeNull();
    expect(await archivio.leggi('g3')).toBeNull();
  });

  /*
   * La copia aiuta, non ostacola. Un lockdown non deve fallire perché
   * Postgres è lento: sarebbe peggio del rischio che la copia copre.
   */
  it('con il database rotto non lancia mai', async () => {
    const archivio = archivioBlocchi(dbRotto);

    await expect(archivio.salva('g1', stato)).resolves.toBeUndefined();
    await expect(archivio.leggi('g1')).resolves.toBeNull();
    await expect(archivio.cancella('g1')).resolves.toBeUndefined();
    await expect(archivio.elenca()).resolves.toEqual(new Set());
  });
});
