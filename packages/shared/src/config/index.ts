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
  InviteGuardConfig,
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
    timezone: z.string().default('Europe/Rome'),
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
