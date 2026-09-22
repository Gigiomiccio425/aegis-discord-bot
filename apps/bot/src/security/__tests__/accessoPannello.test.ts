import {
  Collection,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type PartialGuildMember,
} from 'discord.js';
import { describe, expect, it } from 'vitest';
import { devoRevocare, revocaAccessoAutomatico } from '../accessoPannello.js';

/* ═══════════════════════════════════════════════════════════════════════
   L'ACCESSO AL PANNELLO SEGUE DISCORD, MA SOLO QUELLO AUTOMATICO

   Due errori opposti, tutti e due gravi:

   • non revocare — il moderatore retrocesso resta ADMIN, con lockdown,
     configurazione e archivio dei messaggi in mano;
   • revocare troppo — sparisce anche l'accesso che un proprietario ha dato
     a mano, di proposito, a chi su Discord non ha «Gestisci server».

   Il database e Discord qui sono finti: in questo progetto le dipendenze si
   passano come parametri, non si sostituiscono i moduli.
   ═══════════════════════════════════════════════════════════════════════ */

const client = {} as Client;

/** Un membro con certi ruoli, che può o non può gestire il server. */
function membro(ruoli: string[], gestisce: boolean, partial = false) {
  return {
    partial,
    roles: { cache: new Collection(ruoli.map((id) => [id, {}])) },
    permissions: {
      has: (permesso: bigint) => gestisce && permesso === PermissionFlagsBits.ManageGuild,
    },
  } as unknown as GuildMember;
}

describe('quando un cambio di ruoli toglie l’accesso', () => {
  it('perso il ruolo che dava «Gestisci server», si revoca', () => {
    expect(devoRevocare(membro(['mod', 'utente'], true), membro(['utente'], false))).toBe(true);
  });

  // Le controprove: senza, una funzione che revoca sempre passerebbe.
  it('perso un ruolo ma il permesso resta da un altro, non si revoca', () => {
    expect(devoRevocare(membro(['mod', 'admin'], true), membro(['admin'], true))).toBe(false);
  });

  it('un cambio di soprannome non tocca niente', () => {
    // Stessi ruoli: nessuna scrittura nel database, anche senza permesso.
    expect(devoRevocare(membro(['utente'], false), membro(['utente'], false))).toBe(false);
  });

  it('senza la versione di prima in cache, decide il dopo', () => {
    const prima = membro([], false, true) as unknown as PartialGuildMember;
    expect(devoRevocare(prima, membro(['utente'], false))).toBe(true);
    expect(devoRevocare(prima, membro(['admin'], true))).toBe(false);
  });
});

describe('la revoca', () => {
  interface Riga {
    guildId: string;
    userId: string;
    grantedBy: string;
  }

  /** Un database in memoria che applica il filtro davvero, come Prisma. */
  function dbFinto(righe: Riga[]) {
    return {
      righe,
      panelAccess: {
        async deleteMany({ where }: { where: Riga }) {
          const prima = righe.length;
          const restano = righe.filter(
            (r) =>
              !(
                r.guildId === where.guildId &&
                r.userId === where.userId &&
                r.grantedBy === where.grantedBy
              ),
          );
          righe.splice(0, righe.length, ...restano);
          return { count: prima - restano.length };
        },
      },
    };
  }

  /*
   * IL TEST CHE CONTA
   *
   * La stessa persona ha due accessi: quello dato in automatico al primo
   * login, e quello che un proprietario le ha dato a mano. Perso il
   * permesso su Discord, se ne va solo il primo.
   */
  it('toglie l’accesso automatico e lascia quello dato a mano', async () => {
    const db = dbFinto([
      { guildId: 'g1', userId: 'u1', grantedBy: 'system' },
      { guildId: 'g1', userId: 'u1', grantedBy: 'proprietario-123' },
    ]);
    const registrati: unknown[] = [];

    const revocato = await revocaAccessoAutomatico(client, 'g1', 'u1', 'retrocesso', {
      db,
      registra: async (_client, evento) => {
        registrati.push(evento);
      },
    });

    expect(revocato).toBe(true);
    expect(db.righe).toEqual([{ guildId: 'g1', userId: 'u1', grantedBy: 'proprietario-123' }]);
    expect(registrati, 'la revoca finisce nel registro').toHaveLength(1);
  });

  it('senza niente da togliere non scrive nel registro', async () => {
    const db = dbFinto([{ guildId: 'g1', userId: 'u1', grantedBy: 'proprietario-123' }]);
    const registrati: unknown[] = [];

    const revocato = await revocaAccessoAutomatico(client, 'g1', 'u1', 'retrocesso', {
      db,
      registra: async (_client, evento) => {
        registrati.push(evento);
      },
    });

    expect(revocato).toBe(false);
    expect(registrati).toEqual([]);
  });

  it('un database che fallisce non fa cadere il bot', async () => {
    const db = {
      panelAccess: {
        deleteMany: async () => {
          throw new Error('database irraggiungibile');
        },
      },
    };

    await expect(
      revocaAccessoAutomatico(client, 'g1', 'u1', 'retrocesso', {
        db,
        registra: async () => undefined,
      }),
    ).resolves.toBe(false);
  });
});
