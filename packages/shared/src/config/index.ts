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

export const GeneralConfig = z
  .object({
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
