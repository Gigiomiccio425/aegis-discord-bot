import { describe, expect, it } from 'vitest';
import { PanelCommand } from '../panelCommands.js';

/* ═══════════════════════════════════════════════════════════════════════
   IL TIPO DI BACKUP LO DICE CHI LO CHIEDE

   Il backup notturno arrivava al bot senza tipo, e il bot scriveva sempre
   MANUAL. Il worker, che salta il giro se trova uno SCHEDULED delle ultime
   dodici ore, non ne trovava mai uno; e il registro diceva «creato dal
   pannello» di un backup che nessuno aveva chiesto.
   ═══════════════════════════════════════════════════════════════════════ */

describe('richiesta di backup', () => {
  it('dal pannello, senza tipo, è manuale', () => {
    const comando = PanelCommand.parse({
      action: 'snapshot.create',
      guildId: 'g1',
      actorId: 'u1',
    });

    expect(comando.action === 'snapshot.create' && comando.kind).toBe('MANUAL');
  });

  // La stessa forma che manda il worker: `richiestaBackupNotturno`.
  it('dal worker è notturno', () => {
    const comando = PanelCommand.parse({
      action: 'snapshot.create',
      guildId: 'g1',
      actorId: 'system',
      kind: 'SCHEDULED',
    });

    expect(comando.action === 'snapshot.create' && comando.kind).toBe('SCHEDULED');
  });

  /*
   * La controprova, e non è un dettaglio: gli snapshot di emergenza non si
   * cancellano mai, perché sono quelli scattati durante un attacco. Chi
   * potesse chiederne dall'esterno potrebbe riempire il database di copie
   * che nessuna pulizia toglie.
   */
  it('un backup d’emergenza non si può chiedere da fuori', () => {
    expect(() =>
      PanelCommand.parse({
        action: 'snapshot.create',
        guildId: 'g1',
        actorId: 'u1',
        kind: 'EMERGENCY',
      }),
    ).toThrow();
  });
});
