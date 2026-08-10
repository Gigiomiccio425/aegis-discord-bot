import { describe, expect, it } from 'vitest';
import { ACTION_SEVERITY, decide, mergeDecisions, noDecision, type Reason } from '../types/decision.js';

/* ═══════════════════════════════════════════════════════════════════════
   SCALA DELLE AZIONI

   È il punto in cui un punteggio diventa una sanzione. Due regole che questi
   test proteggono:

   1. Si applica **un solo gradino**, quello più alto raggiunto. Sommare le
      sanzioni significherebbe punire due volte lo stesso fatto.
   2. Quando più moduli reagiscono allo stesso messaggio, l'azione applicata è
      la più grave — ma l'eliminazione del contenuto sopravvive sempre, perché
      bandire l'autore senza rimuovere il link malevolo lascia il danno in giro.
   ═══════════════════════════════════════════════════════════════════════ */

const ladder = [
  { atScore: 30, action: 'DELETE_MESSAGE' as const, durationSec: 0 },
  { atScore: 50, action: 'WARN' as const, durationSec: 0 },
  { atScore: 70, action: 'TIMEOUT' as const, durationSec: 600 },
  { atScore: 90, action: 'KICK' as const, durationSec: 0 },
];

const reason = (code: string, score: number): Reason => ({ code, detail: code, score });

describe('scala delle azioni', () => {
  it('non decide nulla senza motivazioni', () => {
    const decision = decide('test', [], ladder);
    expect(decision.triggered).toBe(false);
    expect(decision.actions).toEqual([]);
  });

  it('somma i punteggi delle motivazioni', () => {
    const decision = decide('test', [reason('A', 20), reason('B', 15)], ladder);
    expect(decision.score).toBe(35);
  });

  it('limita il punteggio a 100', () => {
    const decision = decide('test', [reason('A', 80), reason('B', 80)], ladder);
    expect(decision.score).toBe(100);
  });

  it('applica un solo gradino, il più alto raggiunto', () => {
    const decision = decide('test', [reason('A', 75)], ladder);
    expect(decision.actions).toHaveLength(1);
    expect(decision.actions[0]?.kind).toBe('TIMEOUT');
    expect(decision.actions[0]?.durationSec).toBe(600);
  });

  it('non agisce sotto il primo gradino', () => {
    const decision = decide('test', [reason('A', 10)], ladder);
    expect(decision.triggered).toBe(true); // registrato
    expect(decision.actions).toEqual([]); // ma non sanzionato
  });

  it('sceglie il gradino massimo con punteggio pieno', () => {
    const decision = decide('test', [reason('A', 100)], ladder);
    expect(decision.actions[0]?.kind).toBe('KICK');
  });
});

describe('fusione delle decisioni', () => {
  it('ignora i moduli che non hanno reagito', () => {
    const merged = mergeDecisions([noDecision('a'), noDecision('b')]);
    expect(merged.triggered).toBe(false);
  });

  it('somma i punteggi di moduli diversi', () => {
    const merged = mergeDecisions([
      decide('spam', [reason('SPAM', 20)], ladder),
      decide('scanner', [reason('URL', 25)], ladder),
    ]);
    expect(merged.score).toBe(45);
  });

  it('applica l\'azione più grave fra quelle richieste', () => {
    const merged = mergeDecisions([
      decide('spam', [reason('SPAM', 35)], ladder), // DELETE_MESSAGE
      decide('scanner', [reason('URL', 95)], ladder), // KICK
    ]);
    const kinds = merged.actions.map((action) => action.kind);
    expect(kinds).toContain('KICK');
  });

  it('conserva l\'eliminazione del messaggio anche con un\'azione più grave', () => {
    // Bandire l'autore senza rimuovere il link lascerebbe il danno in circolo.
    const merged = mergeDecisions([
      decide('spam', [reason('SPAM', 35)], ladder), // DELETE_MESSAGE
      decide('scanner', [reason('URL', 95)], ladder), // KICK
    ]);
    expect(merged.actions.map((action) => action.kind)).toContain('DELETE_MESSAGE');
  });

  it('non duplica l\'eliminazione se è già l\'azione dominante', () => {
    const merged = mergeDecisions([
      decide('spam', [reason('SPAM', 35)], ladder),
      decide('scanner', [reason('URL', 30)], ladder),
    ]);
    const deletes = merged.actions.filter((action) => action.kind === 'DELETE_MESSAGE');
    expect(deletes).toHaveLength(1);
  });

  it('elenca tutti i moduli che hanno contribuito', () => {
    const merged = mergeDecisions([
      decide('spam', [reason('SPAM', 35)], ladder),
      decide('scanner', [reason('URL', 40)], ladder),
    ]);
    expect(merged.module).toContain('spam');
    expect(merged.module).toContain('scanner');
  });
});

describe('ordine di gravità', () => {
  it('mette il ban sopra tutto e il solo log in fondo', () => {
    expect(ACTION_SEVERITY.BAN).toBeGreaterThan(ACTION_SEVERITY.KICK);
    expect(ACTION_SEVERITY.KICK).toBeGreaterThan(ACTION_SEVERITY.TIMEOUT);
    expect(ACTION_SEVERITY.TIMEOUT).toBeGreaterThan(ACTION_SEVERITY.DELETE_MESSAGE);
    expect(ACTION_SEVERITY.LOG_ONLY).toBeLessThan(ACTION_SEVERITY.DELETE_MESSAGE);
  });

  it('mette lo strip dei ruoli sopra la quarantena', () => {
    // L'anti-nuke deve prevalere: togliere i permessi ferma il danno in corso,
    // isolare la persona no.
    expect(ACTION_SEVERITY.STRIP_ROLES).toBeGreaterThan(ACTION_SEVERITY.QUARANTINE);
  });
});
