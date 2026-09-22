import { describe, expect, it } from 'vitest';
import { richiestaBackupNotturno } from '../jobs/snapshot.js';

/*
 * La richiesta che il worker manda ogni notte deve dirsi notturna.
 *
 * Senza il tipo, il bot la registrava come manuale: il controllo «già fatto
 * nelle ultime dodici ore», che cerca proprio uno SCHEDULED, non trovava
 * mai niente. Il test del bot controlla che questa stessa forma venga letta
 * come SCHEDULED; questo, che il worker la mandi.
 */
describe('backup notturno', () => {
  it('si presenta come programmato, e a nome del sistema', () => {
    expect(richiestaBackupNotturno('g1')).toEqual({
      action: 'snapshot.create',
      guildId: 'g1',
      actorId: 'system',
      kind: 'SCHEDULED',
    });
  });
});
