import { z } from 'zod';
import { ModuleBase, Snowflake, SnowflakeList } from './common.js';
import { LogCategory } from '../types/events.js';

/* ═══════════════════════════════════════════════════════════════════════
   LOGGING
   Doppia destinazione: Postgres (ricercabile dal pannello) e canali Discord
   per categoria. Il vincolo GDPR è di primo livello, non un ripensamento:
   gli ID Discord sono dati personali e il contenuto dei messaggi lo è ancora
   di più, quindi ogni categoria ha il suo interruttore e la sua retention.
   ═══════════════════════════════════════════════════════════════════════ */

/** Routing di una categoria verso un canale Discord. */
export const CategoryRoute = z.object({
  channelId: Snowflake.nullable().default(null),
  enabled: z.boolean().default(true),
  /** Eventi da escludere pur essendo la categoria attiva. */
  excludeTypes: z.array(z.string()).default([]),
});

export const PrivacyMode = z.enum([
  /** Salva il contenuto integrale. Massima utilità investigativa. */
  'FULL',
  /** Salva solo un hash del contenuto: permette di rilevare i duplicati senza conservare il testo. */
  'HASHED',
  /** Salva solo i metadati (chi, dove, quando, quanti allegati). */
  'METADATA_ONLY',
  /** Non salva nulla nel database, solo il canale Discord. */
  'CHANNEL_ONLY',
]);
export type PrivacyMode = z.infer<typeof PrivacyMode>;

/* ═══════════════════════════════════════════════════════════════════════
   REGISTRO SU FILE

   Terza destinazione, accanto a Postgres e ai canali Discord. Non sostituisce
   il database — la ricerca del pannello ha bisogno degli indici — ma risolve
   un problema che il database non risolve bene: **l'archivio a lungo termine**.

   Con i file si può tenere Postgres leggero (retention di qualche mese, query
   veloci) e conservare comunque tutto per anni su disco, dove costa solo
   spazio. Un `grep` su un file di testo trova una riga di due anni fa senza
   che il database debba portarsi dietro quelle righe a ogni query.

   I file sono append-only e ruotano per giorno: nessun rischio di corrompere
   uno storico riscrivendolo.
   ═══════════════════════════════════════════════════════════════════════ */
export const FileSinkConfig = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * TXT è leggibile a occhio e con `grep`; JSONL è analizzabile con `jq` o
     * reimportabile. Chi ha spazio tiene entrambi: sono la stessa informazione
     * in due forme, e la scelta sbagliata si paga anni dopo.
     */
    format: z.enum(['TXT', 'JSONL', 'BOTH']).default('BOTH'),
    /** Un file per categoria invece di uno solo con tutto dentro. */
    splitByCategory: z.boolean().default(true),
    /** Include il contenuto dei messaggi nel file, se il registro lo conserva. */
    includeContent: z.boolean().default(true),
    /**
     * Giorni di conservazione dei file. 0 = per sempre, ed è il valore che ha
     * senso quando lo spazio non è il vincolo: è tutto il punto di scrivere su
     * disco invece che tenere tutto nel database.
     */
    retentionDays: z.number().int().min(0).max(36500).default(0),
    /**
     * Millisecondi fra due svuotamenti del buffer. Scrivere a ogni evento
     * significa una syscall per messaggio; accumulare qualche centinaio di
     * millisecondi non cambia nulla in caso di crash e alleggerisce molto.
     */
    flushIntervalMs: z.number().int().min(100).max(60000).default(2000),
  })
  .default({});
export type FileSinkConfig = z.infer<typeof FileSinkConfig>;

export const LoggingConfig = ModuleBase.extend({
  /** Copia di ogni evento su file di testo, sul disco della macchina. */
  fileSink: FileSinkConfig,

  /**
   * Canale unico: tutto il registro finisce qui, e le rotte per categoria
   * vengono ignorate senza essere cancellate.
   *
   * È l'impostazione predefinita perché configurare quattordici canali prima di
   * vedere il primo log è il modo più efficace per non attivare mai il registro.
   * Chi vuole separare le categorie toglie la spunta e le rotte tornano valide
   * esattamente com'erano.
   */
  singleChannel: z.boolean().default(true),

  /**
   * Canale usato dal modo a canale unico, e ripiego per le categorie senza un
   * canale dedicato.
   */
  defaultChannelId: Snowflake.nullable().default(null),

  routes: z.record(LogCategory, CategoryRoute).default({}),

  /** Categorie da non registrare affatto. */
  disabledCategories: z.array(LogCategory).default([]),

  /** Canali completamente esclusi dal log (es. canali di test, o per policy). */
  ignoredChannelIds: SnowflakeList,
  /** Utenti esclusi dal log (es. bot rumorosi). Non vale per gli eventi di sicurezza. */
  ignoredUserIds: SnowflakeList,
  /** Se true non registra gli eventi generati dai bot, tranne quelli di sicurezza. */
  ignoreBots: z.boolean().default(false),

  // ── Contenuto e privacy ────────────────────────────────────
  messageContent: PrivacyMode.default('FULL'),
  /**
   * Archivia i file allegati sul volume locale, così restano consultabili anche
   * dopo che Discord ha eliminato il messaggio (indispensabile per le prove).
   */
  archiveAttachments: z.boolean().default(true),
  maxAttachmentSizeMb: z.number().int().min(1).max(100).default(25),

  /** Giorni di conservazione per categoria. 0 = per sempre. */
  retentionDays: z
    .record(LogCategory, z.number().int().min(0).max(3650))
    .default({
      MESSAGE: 90,
      REACTION: 30,
      MEMBER: 365,
      VOICE: 90,
      CHANNEL: 365,
      ROLE: 365,
      SERVER: 365,
      INVITE: 180,
      WEBHOOK: 365,
      MODERATION: 1095,
      SECURITY: 1095,
      AUTOMOD: 180,
      BOT: 180,
    }),

  /** Giorni di conservazione degli allegati archiviati. */
  attachmentRetentionDays: z.number().int().min(1).max(3650).default(90),

  /**
   * Permette a un utente di ottenere la cancellazione dei propri dati con
   * `/cancella-i-miei-dati` (GDPR art. 17). Gli eventi di moderazione restano
   * pseudonimizzati per legittimo interesse.
   */
  allowSelfErasure: z.boolean().default(true),

  // ── Presentazione ──────────────────────────────────────────
  /** Raggruppa gli eventi ad alta frequenza in un unico messaggio ogni N secondi. */
  batchSeconds: z.number().int().min(0).max(60).default(5),
  /** Mostra il contenuto testuale nel canale Discord (oltre che nel database). */
  showContentInChannel: z.boolean().default(true),
  /** Include l'ID utente in chiaro nei messaggi di log. */
  showUserIds: z.boolean().default(true),
  /** Traccia da quale invito è entrato ogni membro. */
  trackInviteAttribution: z.boolean().default(true),
}).default({});
export type LoggingConfig = z.infer<typeof LoggingConfig>;
