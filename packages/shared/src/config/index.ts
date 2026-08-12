import { z } from 'zod';
import { Snowflake, SnowflakeList } from './common.js';
import {
  AccountGuardConfig,
  AntiNukeConfig,
  AntiRaidConfig,
  AntiSpamConfig,
  AutoModSyncConfig,
  BotGuardConfig,
  CompromiseConfig,
  FlameConfig,
  InviteGuardConfig,
  LanguageConfig,
  LinkPolicyConfig,
  SafetyConfig,
  StickyRolesConfig,
  VerificationConfig,
  WebhookGuardConfig,
} from './security.js';
import { ScannerConfig } from './scanner.js';
import { LoggingConfig } from './logging.js';
import { IntegrationsConfig } from './integrations.js';

export * from './common.js';
export * from './security.js';
export * from './scanner.js';
export * from './logging.js';
export * from './integrations.js';
export * from './wordlist.js';
export * from './docs.js';

/* ═══════════════════════════════════════════════════════════════════════
   CONFIGURAZIONE DI UN SERVER
   Unica fonte di verità: il bot la legge, l'API la valida e il pannello ne
   genera i form. Se cambia qui, cambia ovunque — nessuna duplicazione.
   ═══════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════
   AVVISI PUBBLICI

   Quando il bot sanziona qualcuno, il DM può non arrivare: la maggioranza
   degli utenti tiene chiusi i messaggi privati dagli sconosciuti, e un bot lo
   è. Il risultato è una sanzione invisibile — chi la subisce non sa perché è
   stato zittito, e chi guarda non sa perché un messaggio è sparito.

   L'avviso in canale risolve entrambi i casi. Si cancella da solo dopo un po'
   per non lasciare la cronologia piena di cartellini.
   ═══════════════════════════════════════════════════════════════════════ */
export const ActionNoticeConfig = z
  .object({
    /** Scrive in chat l'azione applicata, oltre a tentare il DM. */
    enabled: z.boolean().default(true),
    /**
     * Dove scriverlo. Vuoto = nello stesso canale dove è avvenuto il fatto,
     * che è quasi sempre la scelta giusta: chi ha visto il messaggio vede
     * anche perché è stato rimosso.
     */
    channelId: Snowflake.nullable().default(null),
    /** Cancella l'avviso dopo N secondi. 0 = resta per sempre. */
    deleteAfterSec: z.number().int().min(0).max(3600).default(30),
    /** Menziona la persona sanzionata. Senza, l'avviso è più discreto. */
    mentionTarget: z.boolean().default(true),
    /** Include il motivo. Spegnerlo lascia solo «azione applicata». */
    showReason: z.boolean().default(true),
    /** Include il nome del modulo che ha deciso: utile per tarare le soglie. */
    showModule: z.boolean().default(false),
    /** Avvisa anche per le sole eliminazioni di messaggi. */
    announceDeletions: z.boolean().default(true),
    /** Avvisa anche quando la modalità prova è attiva, indicandolo. */
    announceDryRun: z.boolean().default(false),
  })
  .default({});
export type ActionNoticeConfig = z.infer<typeof ActionNoticeConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   RUOLO DEL PROPRIETARIO

   Un ruolo creato e mantenuto dal bot, assegnato a chi è elencato in
   `OWNER_IDS`. Serve a non restare mai chiusi fuori dal proprio server: se
   qualcuno rimuove i tuoi permessi, o un incidente ti lascia senza ruoli, il
   bot te li restituisce.

   Va detto chiaramente cosa comporta, perché è una scorciatoia che attraversa
   ogni difesa descritta altrove in questo file: **chiunque compaia in
   OWNER_IDS ottiene questo ruolo in ogni server dove il bot entra**, senza
   che il proprietario di quel server debba approvare. Su un bot personale è
   esattamente ciò che si vuole. Su un bot condiviso con altri sarebbe una
   porta di servizio, ed è il motivo per cui i permessi predefiniti sono
   nessuno e l'interruttore parte spento.

   Chi controlla `OWNER_IDS` controlla il bot in modo assoluto: quella
   variabile sta nel compose, non nel pannello, e non è modificabile da
   nessuna interfaccia. È una scelta deliberata — un pannello compromesso non
   deve poter creare nuovi proprietari.
   ═══════════════════════════════════════════════════════════════════════ */
export const OwnerRoleConfig = z
  .object({
    /**
     * Spento di default. Accenderlo è una decisione, non un'impostazione che
     * ci si ritrova addosso senza averla letta.
     */
    enabled: z.boolean().default(false),

    name: z.string().min(1).max(100).default('Angel Master'),

    /** Colore esadecimale del ruolo, es. `#d8b45f`. */
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Colore non valido: serve il formato #rrggbb')
      .default('#d8b45f'),

    /** Mostra chi lo possiede in una sezione separata della lista membri. */
    hoist: z.boolean().default(true),

    /**
     * Quali permessi porta con sé.
     *
     *   NESSUNO       solo un contrassegno: nessun potere, nessun rischio
     *   MODERAZIONE   espellere, bandire, silenziare, gestire i messaggi
     *   AMMINISTRATORE controllo totale del server
     *
     * `NESSUNO` è il default e per la maggior parte dei casi è la scelta
     * giusta: il ruolo serve a essere riconoscibile e a non sparire, mentre i
     * poteri li dà già l'essere proprietario del server. `AMMINISTRATORE`
     * significa che un token rubato del bot equivale al server perso, ed è la
     * ragione per cui non è predefinito.
     */
    permissions: z.enum(['NESSUNO', 'MODERAZIONE', 'AMMINISTRATORE']).default('NESSUNO'),

    /**
     * Riassegna il ruolo se viene tolto, e lo ricrea se viene eliminato.
     *
     * È il punto del modulo: senza, basta che qualcuno lo cancelli una volta
     * perché non torni mai più.
     */
    reapply: z.boolean().default(true),
  })
  .default({});
export type OwnerRoleConfig = z.infer<typeof OwnerRoleConfig>;

/* ═══════════════════════════════════════════════════════════════════════
   IDENTITÀ DEL BOT

   Ciò che Discord consente di cambiare via API, e nient'altro.

   **Nome e immagine sono globali**, non per server: il bot ha un solo nome e
   un solo avatar ovunque sia presente. Ciò che invece è per server è il
   soprannome, che si imposta separatamente.

   Discord accetta al massimo **due cambi di nome ogni ora** per le
   applicazioni. Superato il limite risponde con un errore che non spiega la
   causa, quindi il bot applica il nome solo quando è davvero diverso da
   quello attuale, e non a ogni riavvio.
   ═══════════════════════════════════════════════════════════════════════ */
export const BotIdentityConfig = z
  .object({
    /**
     * Nome globale del bot. Vuoto = non lo tocca.
     *
     * Attenzione: cambiandolo cambia in **tutti** i server dove il bot è
     * presente, non solo in questo.
     */
    username: z.string().max(32).default(''),

    /** Indirizzo https di un'immagine per l'avatar. Vuoto = non lo tocca. */
    avatarUrl: z.string().max(500).default(''),

    /** Banner del profilo. Richiede che l'applicazione lo supporti. */
    bannerUrl: z.string().max(500).default(''),

    /** Soprannome in questo server soltanto. Vuoto = usa il nome globale. */
    nickname: z.string().max(32).default(''),

    /** Pallino accanto al nome. */
    status: z.enum(['online', 'idle', 'dnd', 'invisible']).default('online'),

    /**
     * Come viene presentata l'attività.
     *
     * `CUSTOM` mostra solo il testo, senza verbo davanti — è l'unica che
     * permette una frase libera. Le altre antepongono «Sta giocando a»,
     * «Sta guardando», «Sta ascoltando», «In competizione in».
     */
    activityType: z
      .enum(['CUSTOM', 'PLAYING', 'WATCHING', 'LISTENING', 'COMPETING'])
      .default('WATCHING'),

    /** Testo dell'attività. Variabili: {server} {membri} */
    activityText: z.string().max(128).default('veglio su questo server'),
  })
  .default({});
export type BotIdentityConfig = z.infer<typeof BotIdentityConfig>;

export const GeneralConfig = z
  .object({
    /**
     * Interruttore generale. Spento, il bot registra e basta: nessun modulo
     * valuta, nessuna sanzione parte, nessuna integrazione pubblica nulla.
     *
     * Diverso dalla modalità prova: quella fa girare tutto e trattiene solo la
     * sanzione finale, utile per tarare. Questo ferma il lavoro a monte, ed è
     * quello che serve quando qualcosa va storto e va fermato subito senza
     * ricordarsi quali dodici moduli erano accesi.
     */
    masterEnabled: z.boolean().default(true),

    locale: z.enum(['it', 'en']).default('it'),
    /** Ruoli considerati staff: esenti dai moduli e destinatari degli alert. */
    staffRoleIds: SnowflakeList,
    /** Ruolo di quarantena creato/gestito dal bot. */
    quarantineRoleId: Snowflake.nullable().default(null),
    /** Canale per gli alert di sicurezza urgenti. */
    alertChannelId: Snowflake.nullable().default(null),
    /** Ruolo menzionato negli alert critici. */
    alertRoleId: Snowflake.nullable().default(null),
    /**
     * Modalità prova: i moduli valutano e registrano tutto ma non applicano
     * sanzioni. Indispensabile per tarare le soglie senza colpire i legittimi.
     */
    dryRun: z.boolean().default(false),

    /** Avviso in chat quando il bot sanziona qualcuno. */
    actionNotice: ActionNoticeConfig,

    /** Ruolo mantenuto dal bot per chi è elencato in OWNER_IDS. */
    ownerRole: OwnerRoleConfig,

    /**
     * Crea da solo ruoli e canali di servizio, e ne compila gli ID qui.
     *
     * Senza, un bot appena installato non protegge nulla — non per un difetto,
     * ma perché la quarantena ha bisogno di un ruolo che isoli e il registro di
     * un canale dove scrivere, e sono una dozzina di campi da riempire a mano.
     *
     * All'ingresso in un server nuovo crea tutto; agli avvii successivi riempie
     * solo i campi rimasti vuoti, senza ricreare ciò che è stato eliminato di
     * proposito.
     */
    autoProvision: z.boolean().default(true),

    /** Nome, immagine, stato e attività del bot. */
    identity: BotIdentityConfig,

    /**
     * Parola d'ordine dello staff, verificabile con `/verifica-staff`.
     * È la sola difesa pratica contro l'impersonificazione con voce clonata:
     * nessun software distingue un deepfake vocale, una parola concordata sì.
     */
    staffCodeword: z.string().max(64).default(''),
  })
  .default({});
export type GeneralConfig = z.infer<typeof GeneralConfig>;

export const SecurityConfig = z
  .object({
    antiRaid: AntiRaidConfig,
    antiNuke: AntiNukeConfig,
    antiSpam: AntiSpamConfig,
    compromise: CompromiseConfig,
    accountGuard: AccountGuardConfig,
    inviteGuard: InviteGuardConfig,
    webhookGuard: WebhookGuardConfig,
    botGuard: BotGuardConfig,
    language: LanguageConfig,
    flame: FlameConfig,
    links: LinkPolicyConfig,
    safety: SafetyConfig,
    verification: VerificationConfig,
    stickyRoles: StickyRolesConfig,
    autoMod: AutoModSyncConfig,
  })
  .default({});
export type SecurityConfig = z.infer<typeof SecurityConfig>;

export const GuildConfigSchema = z
  .object({
    /** Versione dello schema: serve alle migrazioni della configurazione. */
    version: z.literal(1).default(1),
    general: GeneralConfig,
    security: SecurityConfig,
    scanner: ScannerConfig,
    logging: LoggingConfig,
    integrations: IntegrationsConfig,
  })
  .default({});
export type GuildConfig = z.infer<typeof GuildConfigSchema>;

/** Configurazione di default per un server appena aggiunto. */
export function defaultGuildConfig(): GuildConfig {
  return GuildConfigSchema.parse({});
}

/**
 * Il ruolo di chi è entrato e non ha ancora verificato.
 *
 * Sta qui e non nei singoli chiamanti perché i punti che lo cercano sono
 * quattro — l'ingresso, il pulsante di verifica, l'isolamento dei canali e la
 * predisposizione — e una risoluzione ripetuta in quattro posti è una
 * risoluzione che prima o poi diverge in uno di essi.
 *
 * L'ordine tiene conto delle configurazioni salvate prima della 1.8, quando il
 * ruolo d'ingresso e quello di quarantena erano lo stesso campo.
 */
export function unverifiedRoleId(config: GuildConfig): string | null {
  return config.security.verification.unverifiedRoleId ?? config.security.verification.quarantineRoleId;
}

/**
 * Il ruolo di chi è stato messo in quarantena.
 *
 * Non ha ripieghi sul ruolo di verifica: se non è configurato la quarantena
 * non si applica, e nel registro compare l'avviso. Ripiegare sull'altro
 * ruolo significherebbe isolare un sanzionato con lo stesso ruolo che il bot
 * toglie a chiunque prema il pulsante di verifica — cioè lasciarlo uscire
 * dalla sanzione premendo un pulsante.
 */
export function quarantineRoleId(config: GuildConfig): string | null {
  return config.general.quarantineRoleId;
}

/**
 * Applica l'interruttore generale.
 *
 * Con `masterEnabled` spento restituisce una copia in cui ogni modulo risulta
 * disattivato, **senza toccare quanto è salvato**: riaccendendo l'interruttore
 * si ritrova esattamente la configurazione di prima, spunta per spunta.
 *
 * Il registro resta acceso di proposito. Chi spegne tutto lo fa per fermare le
 * sanzioni, non per smettere di vedere cosa succede — e un server che nessuno
 * sta più proteggendo è il momento in cui serve di più sapere chi fa cosa.
 *
 * Va applicata dove la configurazione viene *letta* dal bot, non dove viene
 * salvata: il pannello continua a mostrare e modificare i valori veri.
 */
export function withMasterSwitch(config: GuildConfig): GuildConfig {
  if (config.general.masterEnabled) return config;

  const off = <T extends { enabled: boolean }>(module: T): T => ({ ...module, enabled: false });

  return {
    ...config,
    security: Object.fromEntries(
      Object.entries(config.security).map(([key, module]) => [key, off(module)]),
    ) as SecurityConfig,
    scanner: off(config.scanner),
    integrations: Object.fromEntries(
      Object.entries(config.integrations).map(([key, module]) => [key, off(module)]),
    ) as IntegrationsConfig,
  };
}

/**
 * Valida una configurazione arrivata dal pannello, riempiendo i campi mancanti
 * con i default. Restituisce gli errori in forma leggibile per la UI.
 */
export function parseGuildConfig(
  input: unknown,
): { ok: true; value: GuildConfig } | { ok: false; errors: { path: string; message: string }[] } {
  const result = GuildConfigSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}

/**
 * Elenco dei moduli, usato dal pannello per costruire il menu e dallo stato
 * della dashboard. La chiave corrisponde al percorso dentro `GuildConfig`.
 */
export const MODULE_REGISTRY = [
  { key: 'security.antiRaid', label: 'Anti-Raid', group: 'Sicurezza' },
  { key: 'security.antiNuke', label: 'Anti-Nuke', group: 'Sicurezza' },
  { key: 'security.antiSpam', label: 'Anti-Spam', group: 'Sicurezza' },
  { key: 'security.compromise', label: 'Account compromessi', group: 'Sicurezza' },
  { key: 'security.accountGuard', label: 'Controllo account', group: 'Sicurezza' },
  { key: 'security.inviteGuard', label: 'Protezione inviti', group: 'Sicurezza' },
  { key: 'security.webhookGuard', label: 'Protezione webhook', group: 'Sicurezza' },
  { key: 'security.botGuard', label: 'Controllo bot', group: 'Sicurezza' },
  { key: 'security.language', label: 'Linguaggio', group: 'Sicurezza' },
  { key: 'security.flame', label: 'Anti-flame', group: 'Sicurezza' },
  { key: 'security.links', label: 'Link e GIF', group: 'Sicurezza' },
  { key: 'security.safety', label: 'Tutela utenti', group: 'Sicurezza' },
  { key: 'security.verification', label: 'Verifica ingresso', group: 'Sicurezza' },
  { key: 'security.stickyRoles', label: 'Ruoli appiccicosi', group: 'Sicurezza' },
  { key: 'security.autoMod', label: 'AutoMod Discord', group: 'Sicurezza' },
  { key: 'scanner', label: 'Scanner contenuti', group: 'Sicurezza' },
  { key: 'logging', label: 'Registro eventi', group: 'Registro' },
  { key: 'integrations.twitch', label: 'Twitch', group: 'Integrazioni' },
  { key: 'integrations.polls', label: 'Sondaggi', group: 'Integrazioni' },
  { key: 'integrations.events', label: 'Eventi', group: 'Integrazioni' },
  { key: 'integrations.giveaways', label: 'Giveaway', group: 'Integrazioni' },
  { key: 'integrations.reactionRoles', label: 'Ruoli con reazione', group: 'Integrazioni' },
  { key: 'integrations.youtube', label: 'YouTube', group: 'Integrazioni' },
  { key: 'integrations.rss', label: 'Feed RSS', group: 'Integrazioni' },
  { key: 'integrations.starboard', label: 'Bacheca', group: 'Integrazioni' },
  { key: 'integrations.tickets', label: 'Ticket', group: 'Integrazioni' },
] as const;
export type ModuleKey = (typeof MODULE_REGISTRY)[number]['key'];

// In fondo: importa GuildConfigSchema, definito sopra in questo file.
export * from "./shapes.js";
export * from "./coerenza.js";
