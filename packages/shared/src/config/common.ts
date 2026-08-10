import { z } from 'zod';

/** ID Discord: snowflake a 17-20 cifre. */
export const Snowflake = z
  .string()
  .regex(/^\d{17,20}$/, 'ID Discord non valido');

export const SnowflakeList = z.array(Snowflake).default([]);

/** Durata in secondi, con limiti sensati per evitare configurazioni assurde. */
export const Seconds = (min: number, max: number, def: number) =>
  z.number().int().min(min).max(max).default(def);

/**
 * Azioni che un modulo può richiedere. L'esecutore (`apps/bot/src/core/enforcer.ts`)
 * le applica in ordine di gravità crescente e le registra sempre in `AuditEvent`.
 */
export const ActionKind = z.enum([
  'NONE',
  'LOG_ONLY',
  'ALERT_STAFF',
  'DELETE_MESSAGE',
  /** Elimina tutti i messaggi recenti dell'autore: usata contro account compromessi. */
  'PURGE_RECENT',
  'WARN',
  /** Communication disabled (timeout nativo Discord), massimo 28 giorni. */
  'TIMEOUT',
  /** Assegna il ruolo di quarantena e rimuove gli altri ruoli. */
  'QUARANTINE',
  /** Rimuove tutti i ruoli con permessi pericolosi: risposta anti-nuke. */
  'STRIP_ROLES',
  'KICK',
  'BAN',
  /** Blocca il server: canali in sola lettura + pausa inviti. */
  'LOCKDOWN',
  /** Obbliga l'utente a superare la verifica prima di poter scrivere. */
  'REQUIRE_VERIFICATION',
]);
export type ActionKind = z.infer<typeof ActionKind>;

/**
 * Scala di risposta: a ogni soglia di punteggio corrisponde un'azione.
 * Ordinata per `atScore` crescente; si applica l'azione con soglia più alta raggiunta.
 */
export const ActionLadder = z
  .array(
    z.object({
      atScore: z.number().int().min(0).max(100),
      action: ActionKind,
      /** Durata in secondi per TIMEOUT / QUARANTINE / LOCKDOWN. 0 = permanente. */
      durationSec: z.number().int().min(0).max(2419200).default(0),
    }),
  )
  .default([]);
export type ActionLadder = z.infer<typeof ActionLadder>;

/** Chi è immune a un modulo. Gli owner del bot lo sono sempre. */
export const Exemptions = z
  .object({
    roleIds: SnowflakeList,
    userIds: SnowflakeList,
    channelIds: SnowflakeList,
    /** Esenta i bot verificati da Discord (badge ufficiale). */
    verifiedBots: z.boolean().default(false),
    /** Esenta chi ha il permesso Administrator. Sconsigliato: è il vettore dei nuke. */
    administrators: z.boolean().default(false),
  })
  .default({});
export type Exemptions = z.infer<typeof Exemptions>;

/** Blocco comune a ogni modulo: on/off, esenzioni, canale di alert dedicato. */
export const ModuleBase = z.object({
  enabled: z.boolean().default(false),
  exemptions: Exemptions,
  alertChannelId: Snowflake.nullable().default(null),
});

/**
 * Soglia "N eventi in T secondi". Usata da anti-raid, anti-nuke, anti-spam:
 * stessa forma ovunque, così il pannello genera un solo componente per tutte.
 */
export const RateThreshold = z.object({
  count: z.number().int().min(1).max(1000),
  windowSec: z.number().int().min(1).max(3600),
});
export type RateThreshold = z.infer<typeof RateThreshold>;
