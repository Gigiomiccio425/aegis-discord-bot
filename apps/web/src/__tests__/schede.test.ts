import { describe, expect, it } from 'vitest';
import { defaultGuildConfig, describeField } from '@angel/shared';
import { PRINCIPALI, gruppoGrande, gruppoPiccolo, schedaDelCampo, schedeDi } from '../schede.js';

/* ═══════════════════════════════════════════════════════════════════════
   LE SCHEDE DI UN MODULO

   Provate sulla configurazione predefinita: la divisione si ricava dalla
   forma dei dati, e sono i dati veri a dire se viene sensata.
   ═══════════════════════════════════════════════════════════════════════ */

const config = defaultGuildConfig() as unknown as Record<string, unknown>;
const etichetta = (percorso: string, chiave: string) => describeField(percorso)?.label ?? chiave;
const sezione = (chiave: string): Record<string, unknown> =>
  chiave.split('.').reduce<Record<string, unknown>>(
    (valore, parte) => valore[parte] as Record<string, unknown>,
    config,
  );

describe('gruppi piccoli e grandi', () => {
  it('tiene insieme quantità e finestra di tempo', () => {
    expect(gruppoPiccolo({ count: 5, windowSec: 30 })).toBe(true);
    expect(gruppoGrande({ count: 5, windowSec: 30 })).toBe(false);
  });

  it('fa scheda di un gruppo con molte opzioni o con gruppi dentro', () => {
    expect(gruppoGrande({ a: 1, b: 2, c: 3, d: 4 })).toBe(true);
    expect(gruppoGrande({ enabled: true, threshold: { count: 1 } })).toBe(true);
  });

  it('non prende per gruppo un elenco o un valore semplice', () => {
    expect(gruppoGrande([])).toBe(false);
    expect(gruppoGrande(null)).toBe(false);
    expect(gruppoPiccolo('testo')).toBe(false);
  });
});

describe('schedeDi', () => {
  it('divide l’anti-raid in principali e gruppi di account simili', () => {
    const schede = schedeDi(sezione('security.antiRaid'), 'security.antiRaid', etichetta);
    expect(schede.map((scheda) => scheda.id)).toEqual([PRINCIPALI, 'clustering']);
    expect(schede[1]).toEqual({
      id: 'clustering',
      titolo: 'Gruppi di account simili',
      percorso: 'security.antiRaid.clustering',
    });
  });

  it('lascia fra le principali i gruppi piccoli', () => {
    const schede = schedeDi(sezione('security.antiRaid'), 'security.antiRaid', etichetta);
    expect(schede.map((scheda) => scheda.id)).not.toContain('joinBurst');
  });

  it('dà una scheda sola alle regole dell’anti-nuke, non una per regola', () => {
    const ids = schedeDi(sezione('security.antiNuke'), 'security.antiNuke', etichetta).map((s) => s.id);
    expect(ids).toContain('rules');
    expect(ids).not.toContain('channelDelete');
  });

  it('non crea schede per un modulo che sta in una pagina', () => {
    expect(schedeDi({ enabled: true, soglia: 3, canale: null }, 'x', etichetta)).toEqual([]);
  });

  // L'interruttore del modulo sta sopra le schede: una scheda «Principali»
  // che contenesse solo quello sarebbe vuota.
  it('non crea «Principali» se l’unica opzione sciolta è l’interruttore', () => {
    const schede = schedeDi({ enabled: true, gruppo: { a: 1, b: 2, c: 3, d: 4 } }, 'x', etichetta);
    expect(schede.map((scheda) => scheda.id)).toEqual(['gruppo']);
  });
});

describe('schedaDelCampo', () => {
  const schede = schedeDi(sezione('security.antiRaid'), 'security.antiRaid', etichetta);

  it('apre la scheda del gruppo che contiene il campo', () => {
    expect(schedaDelCampo('security.antiRaid.clustering.windowSec', 'security.antiRaid', schede)).toBe(
      'clustering',
    );
  });

  it('apre le principali per un campo sciolto o in un gruppo piccolo', () => {
    expect(schedaDelCampo('security.antiRaid.pauseInvites', 'security.antiRaid', schede)).toBe(PRINCIPALI);
    expect(schedaDelCampo('security.antiRaid.joinBurst.count', 'security.antiRaid', schede)).toBe(PRINCIPALI);
  });

  it('non indovina per un campo di un’altra sezione', () => {
    expect(schedaDelCampo('security.antiNuke.enabled', 'security.antiRaid', schede)).toBeNull();
  });
});
