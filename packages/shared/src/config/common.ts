import { z } from 'zod';

/** ID Discord: snowflake a 17-20 cifre. */
export const Snowflake = z
  .string({
    // Un ID Discord supera 2^53: scritto come numero perde le ultime cifre
    // prima ancora di arrivare qui. Il messaggio dice cosa fare, perché
    // «previsto testo, ricevuto numero» lascia a indovinare che servano le
    // virgolette.
    invalid_type_error: 'ID Discord: va scritto come testo, fra virgolette',
  })
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

    /**
     * Esenta chi ha il permesso Administrator.
     *
     * Acceso di default: chi amministra il server non deve trovarsi sanzionato
     * dal proprio bot mentre fa il proprio lavoro, e un moderatore silenziato
     * dalle sue stesse difese è il modo più rapido per farle spegnere tutte.
     *
     * Il prezzo va detto, perché è reale: **un account amministratore
     * compromesso è il vettore numero uno dei nuke**, e con questa esenzione
     * accesa l'anti-nuke non lo ferma. Chi preferisce la protezione alla
     * comodità la spegne sull'anti-nuke e la lascia altrove — è la
     * combinazione che raccomando, e si fa con una spunta sola.
     */
    administrators: z.boolean().default(true),
  })
  .default({});
export type Exemptions = z.infer<typeof Exemptions>;

/**
 * Blocco comune a ogni modulo: l'interruttore, e basta.
 *
 * Conteneva anche le esenzioni e un canale di avviso per modulo. Le esenzioni
 * le legge solo chi sanziona qualcuno — otto moduli su ventisei — e sugli altri
 * comparivano lo stesso: si potevano esentare degli utenti dagli annunci di
 * Twitch, e la spunta non faceva nulla. Il canale di avviso per modulo non lo
 * leggeva nessuno: gli avvisi vanno tutti su `general.alertChannelId`.
 *
 * Un'opzione che non fa niente è peggio di un'opzione assente: viene impostata,
 * dà per acquisito un comportamento che non esiste, e il tempo perso a
 * configurarla si scopre solo quando serviva davvero.
 */
export const ModuleBase = z.object({
  enabled: z.boolean().default(false),
});

/**
 * Come `ModuleBase`, ma acceso di partenza.
 *
 * Lo usano le difese e il registro. La ragione è che un bot di sicurezza che
 * arriva spento protegge esattamente da nulla, e il momento più esposto di un
 * server è proprio quello subito dopo l'installazione — quando chi lo ha
 * aggiunto sta ancora leggendo la documentazione.
 *
 * Le integrazioni restano spente perché non potrebbero funzionare comunque:
 * senza le chiavi di Twitch o un canale dove pubblicare, accenderle
 * produrrebbe solo errori nei log.
 */
export const ActiveModuleBase = ModuleBase.extend({
  enabled: z.boolean().default(true),
});

/**
 * Base dei moduli che possono sanzionare qualcuno.
 *
 * Sono gli unici in cui «chi è immune» significa qualcosa: anti-spam, scanner,
 * linguaggio, anti-flame, inviti, account compromessi, controllo account e
 * tutela utenti. Sono anche i soli otto che leggono davvero le esenzioni.
 */
export const GuardModuleBase = ActiveModuleBase.extend({
  exemptions: Exemptions,
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
