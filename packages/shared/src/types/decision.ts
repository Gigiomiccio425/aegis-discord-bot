import type { ActionKind, ActionLadder } from '../config/common.js';
import type { LogEventType } from './events.js';

/**
 * Interfaccia comune a tutti i moduli di sicurezza.
 *
 * Ogni modulo osserva un contesto e restituisce una decisione; l'esecutore
 * (`apps/bot/src/core/enforcer.ts`) somma i punteggi, sceglie l'azione più
 * grave e la applica una sola volta. Il vantaggio è che ogni modulo resta
 * testabile in isolamento e componibile con gli altri senza dipendenze incrociate.
 */
export interface Reason {
  /** Codice stabile, usato nei log e nelle statistiche del pannello. */
  code: string;
  /** Testo leggibile mostrato allo staff. */
  detail: string;
  /** Punti aggiunti al punteggio complessivo (0-100). */
  score: number;
  /** Dati grezzi utili all'indagine (URL trovato, hash, soglia superata…). */
  meta?: Record<string, unknown>;
}

export interface DecisionAction {
  kind: ActionKind;
  /** Durata in secondi per TIMEOUT / QUARANTINE / LOCKDOWN. 0 = permanente. */
  durationSec?: number;
  reason: string;
}

export interface Decision {
  module: string;
  triggered: boolean;
  /** Punteggio complessivo 0-100. */
  score: number;
  reasons: Reason[];
  actions: DecisionAction[];
  /** Evento da registrare. Se assente l'esecutore ne sceglie uno generico. */
  logEvent?: LogEventType;
}

export const noDecision = (module: string): Decision => ({
  module,
  triggered: false,
  score: 0,
  reasons: [],
  actions: [],
});

/** Crea una decisione a partire dalle motivazioni raccolte e da una scala di azioni. */
export function decide(
  module: string,
  reasons: Reason[],
  ladder: ActionLadder,
  logEvent?: LogEventType,
): Decision {
  const score = Math.min(
    100,
    reasons.reduce((sum, r) => sum + r.score, 0),
  );
  if (reasons.length === 0) return noDecision(module);

  // Si applica il gradino più alto raggiunto, non tutti quelli sotto:
  // sommare le sanzioni porterebbe a punire due volte lo stesso fatto.
  const step = [...ladder]
    .filter((s) => score >= s.atScore)
    .sort((a, b) => b.atScore - a.atScore)[0];

  return {
    module,
    triggered: true,
    score,
    reasons,
    actions: step
      ? [
          {
            kind: step.action,
            durationSec: step.durationSec,
            reason: reasons.map((r) => r.detail).join(' · '),
          },
        ]
      : [],
    logEvent,
  };
}

/** Ordine di gravità: serve a scegliere l'azione dominante fra più moduli. */
export const ACTION_SEVERITY: Record<ActionKind, number> = {
  NONE: 0,
  LOG_ONLY: 1,
  ALERT_STAFF: 2,
  DELETE_MESSAGE: 3,
  WARN: 4,
  REQUIRE_VERIFICATION: 5,
  PURGE_RECENT: 6,
  TIMEOUT: 7,
  QUARANTINE: 8,
  STRIP_ROLES: 9,
  KICK: 10,
  LOCKDOWN: 11,
  BAN: 12,
};

/** Fonde più decisioni in una sola: somma i punteggi, tiene l'azione più grave. */
export function mergeDecisions(decisions: Decision[]): Decision {
  const active = decisions.filter((d) => d.triggered);
  if (active.length === 0) return noDecision('merged');

  const reasons = active.flatMap((d) => d.reasons);
  const score = Math.min(
    100,
    reasons.reduce((sum, r) => sum + r.score, 0),
  );

  const allActions = active.flatMap((d) => d.actions);
  const strongest = allActions.sort(
    (a, b) => ACTION_SEVERITY[b.kind] - ACTION_SEVERITY[a.kind],
  )[0];

  // DELETE_MESSAGE va sempre eseguita se richiesta da qualcuno, anche quando
  // l'azione dominante è più grave: il contenuto deve comunque sparire.
  const mustDelete = allActions.some((a) => a.kind === 'DELETE_MESSAGE');
  const actions: DecisionAction[] = [];
  if (mustDelete && strongest?.kind !== 'DELETE_MESSAGE') {
    actions.push({ kind: 'DELETE_MESSAGE', reason: 'contenuto bloccato' });
  }
  if (strongest) actions.push(strongest);

  return {
    module: active.map((d) => d.module).join('+'),
    triggered: true,
    score,
    reasons,
    actions,
    logEvent: active.find((d) => d.logEvent)?.logEvent,
  };
}
