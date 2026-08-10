import { z } from 'zod';
import { Snowflake, SnowflakeList } from '../config/common.js';

/* ═══════════════════════════════════════════════════════════════════════
   COMANDI PERSONALIZZATI E "PERSONAS"

   Il "finto utente" che parla in chat con nome e immagine propri è un webhook:
   Discord permette di sovrascrivere username e avatar per singolo messaggio.
   Aegis crea (e riusa) un webhook per canale, poi lo pilota con le personas.

   Ogni messaggio inviato da una persona resta tracciato in `AuditEvent` con
   l'ID dell'utente umano che ha lanciato il comando: una persona non è mai un
   modo per parlare in forma anonima.
   ═══════════════════════════════════════════════════════════════════════ */

export const PersonaSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  /** URL dell'immagine del profilo. Deve essere raggiungibile da Discord. */
  avatarUrl: z.string().url().nullable().default(null),
  /** Colore usato negli embed della persona (esadecimale, es. #5865F2). */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  description: z.string().max(500).default(''),
});
export type Persona = z.infer<typeof PersonaSchema>;

/** Tipi di argomento accettati da un comando personalizzato. */
export const ArgType = z.enum(['STRING', 'USER', 'CHANNEL', 'ROLE', 'NUMBER', 'BOOLEAN', 'CHOICE']);
export type ArgType = z.infer<typeof ArgType>;

export const CommandArg = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_-]+$/, 'Solo minuscole, numeri, trattino e underscore'),
  description: z.string().min(1).max(100),
  type: ArgType.default('STRING'),
  required: z.boolean().default(false),
  /** Valori ammessi quando `type` è CHOICE. */
  choices: z.array(z.object({ name: z.string().max(100), value: z.string().max(100) })).default([]),
});
export type CommandArg = z.infer<typeof CommandArg>;

/* ── Passi eseguibili ──────────────────────────────────────────────────── */

const StepBase = z.object({
  /** Nota interna mostrata nel builder del pannello. */
  label: z.string().max(120).default(''),
});

export const CommandStep = z.discriminatedUnion('kind', [
  /** Una persona invia un messaggio. Il cuore della funzione. */
  StepBase.extend({
    kind: z.literal('PERSONA_MESSAGE'),
    personaId: z.string().uuid(),
    /**
     * Testo del messaggio. Variabili disponibili:
     *   {user}       menzione di chi ha lanciato il comando
     *   {user.name}  nome di chi ha lanciato il comando
     *   {arg:nome}   valore di un argomento
     *   {guild}      nome del server
     *   {channel}    menzione del canale
     *   {count}      numero di volte che il comando è stato usato
     *   {random:a|b|c}  sceglie una delle alternative
     */
    content: z.string().min(1).max(2000),
    /** Canale di destinazione. null = lo stesso in cui è stato lanciato il comando. */
    channelId: Snowflake.nullable().default(null),
    /** Invia come embed colorato invece che come testo semplice. */
    asEmbed: z.boolean().default(false),
    embedTitle: z.string().max(256).default(''),
    embedImageUrl: z.string().url().nullable().default(null),
    /** Consente al messaggio di menzionare ruoli e @everyone. Default: no. */
    allowMentions: z.boolean().default(false),
  }),

  /** Pausa fra un passo e l'altro: rende la sequenza credibile. */
  StepBase.extend({
    kind: z.literal('WAIT'),
    seconds: z.number().min(0.5).max(300),
  }),

  StepBase.extend({
    kind: z.literal('ADD_ROLE'),
    roleId: Snowflake,
    target: z.enum(['INVOKER', 'ARG_USER']).default('ARG_USER'),
    argName: z.string().max(32).default(''),
    /** Rimuove il ruolo dopo N secondi (0 = permanente). */
    durationSec: z.number().int().min(0).max(2592000).default(0),
  }),

  StepBase.extend({
    kind: z.literal('REMOVE_ROLE'),
    roleId: Snowflake,
    target: z.enum(['INVOKER', 'ARG_USER']).default('ARG_USER'),
    argName: z.string().max(32).default(''),
  }),

  StepBase.extend({
    kind: z.literal('REACT'),
    emoji: z.string().min(1).max(64),
  }),

  /** Messaggio privato all'utente. Fallisce silenziosamente se ha i DM chiusi. */
  StepBase.extend({
    kind: z.literal('DM_USER'),
    target: z.enum(['INVOKER', 'ARG_USER']).default('ARG_USER'),
    argName: z.string().max(32).default(''),
    content: z.string().min(1).max(2000),
  }),

  /**
   * Condizione: se non è soddisfatta salta i successivi `skipSteps` passi.
   * Tenuta volutamente semplice — il builder è per non programmatori.
   */
  StepBase.extend({
    kind: z.literal('CONDITION'),
    check: z.enum(['ARG_EQUALS', 'ARG_CONTAINS', 'INVOKER_HAS_ROLE', 'TARGET_HAS_ROLE', 'RANDOM_CHANCE']),
    argName: z.string().max(32).default(''),
    value: z.string().max(200).default(''),
    roleId: Snowflake.nullable().default(null),
    /** Probabilità 0-100 quando `check` è RANDOM_CHANCE. */
    chance: z.number().int().min(1).max(100).default(50),
    skipSteps: z.number().int().min(1).max(50).default(1),
  }),
]);
export type CommandStep = z.infer<typeof CommandStep>;

/* ── Comando ───────────────────────────────────────────────────────────── */

export const CustomCommandSchema = z.object({
  id: z.string().uuid().optional(),
  /** Nome del comando slash, senza la barra. */
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_-]+$/, 'Solo minuscole, numeri, trattino e underscore'),
  description: z.string().min(1).max(100),
  enabled: z.boolean().default(true),

  /** Ruoli abilitati a usarlo. Vuoto = tutti. */
  allowedRoleIds: SnowflakeList,
  /** Ruoli esplicitamente esclusi, hanno la precedenza sulla lista precedente. */
  deniedRoleIds: SnowflakeList,
  /** Canali in cui è utilizzabile. Vuoto = ovunque. */
  allowedChannelIds: SnowflakeList,

  args: z.array(CommandArg).max(25).default([]),
  steps: z.array(CommandStep).min(1).max(50),

  /** Attesa fra due usi dello stesso utente, in secondi. */
  cooldownSec: z.number().int().min(0).max(86400).default(3),
  /** Attesa globale per tutto il server, in secondi. */
  guildCooldownSec: z.number().int().min(0).max(86400).default(0),

  /** Risposta effimera al lancio (visibile solo a chi ha usato il comando). */
  ephemeralAck: z.boolean().default(true),
});
export type CustomCommand = z.infer<typeof CustomCommandSchema>;

/**
 * Nomi vietati per le personas: impedisce di creare un "Discord Staff" o un
 * clone del moderatore. Il controllo completo confronta anche la similarità con
 * i nickname reali dello staff (vedi `accountGuard`).
 */
export const FORBIDDEN_PERSONA_PATTERNS: readonly RegExp[] = [
  /discord/i,
  /\bstaff\b/i,
  /trust\s*&?\s*safety/i,
  /\bmoderator\b/i,
  /\bmoderatore\b/i,
  /\badmin(istrator)?\b/i,
  /\bsupport\b/i,
  /\bsupporto\b/i,
  /\bsystem\b/i,
  /\bnitro\b/i,
];
