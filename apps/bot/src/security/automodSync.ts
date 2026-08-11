import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  PermissionFlagsBits,
  type AutoModerationRule,
  type Client,
  type Guild,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import type { GuildConfig } from '@angel/shared';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';

const log = childLogger('automodSync');

/* ═══════════════════════════════════════════════════════════════════════
   SINCRONIZZAZIONE CON L'AUTOMOD NATIVO

   AutoMod non sostituisce i moduli di ANGEL: fa una cosa che loro non possono
   fare, cioè bloccare il messaggio **prima che venga pubblicato**. Un bot vede
   il messaggio solo dopo che esiste; AutoMod lo intercetta durante l'invio.
   Per il contenuto testuale noto in anticipo — domini di phishing, termini
   vietati — quella manciata di millisecondi è la differenza fra «nessuno l'ha
   visto» e «l'hanno letto in trenta».

   Il caso più interessante è però la regola sul **profilo utente**: con
   l'azione `BlockMemberInteraction` Discord mette in quarantena chi ha un
   nickname vietato prima ancora che possa scrivere o entrare in vocale.
   Nessun bot può arrivare così presto.

   ANGEL gestisce solo le regole che ha creato lui, riconoscibili dal prefisso
   del nome: le regole scritte a mano dallo staff non vengono mai toccate.
   ═══════════════════════════════════════════════════════════════════════ */

const PREFIX = '[ANGEL]';
const RULE_DOMAINS = `${PREFIX} Domini bloccati`;
const RULE_TERMS = `${PREFIX} Termini vietati`;
const RULE_SPAM = `${PREFIX} Spam`;
const RULE_MENTIONS = `${PREFIX} Menzioni di massa`;
const RULE_PROFILE = `${PREFIX} Profili vietati`;

/** Limiti dell'API, non scelte nostre: superarli fa fallire l'intera regola. */
const MAX_KEYWORDS = 1000;
const MAX_KEYWORD_LENGTH = 60;

export interface SyncReport {
  created: string[];
  updated: string[];
  removed: string[];
  errors: string[];
}

export async function syncAutoModRules(
  client: Client,
  guild: Guild,
  config: GuildConfig,
): Promise<SyncReport> {
  const report: SyncReport = { created: [], updated: [], removed: [], errors: [] };
  const settings = config.security.autoMod;

  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageGuild)) {
    report.errors.push('Permesso ManageGuild assente: AutoMod non è gestibile.');
    return report;
  }

  const existing = await guild.autoModerationRules.fetch().catch(() => null);
  if (!existing) {
    report.errors.push('Impossibile leggere le regole AutoMod esistenti.');
    return report;
  }

  const managed = new Map<string, AutoModerationRule>();
  for (const rule of existing.values()) {
    if (rule.name.startsWith(PREFIX)) managed.set(rule.name, rule);
  }

  const alertChannelId = config.general.alertChannelId ?? config.logging.defaultChannelId;
  const exemptRoles = config.general.staffRoleIds;

  /** Azione comune: blocca e, se c'è un canale di allarme, segnala. */
  const blockActions = (message: string) => [
    {
      type: AutoModerationActionType.BlockMessage as const,
      metadata: { customMessage: message.slice(0, 150) },
    },
    ...(alertChannelId
      ? [
          {
            type: AutoModerationActionType.SendAlertMessage as const,
            metadata: { channel: alertChannelId },
          },
        ]
      : []),
  ];

  const desired: {
    name: string;
    enabled: boolean;
    payload: Record<string, unknown>;
  }[] = [];

  /* ── Domini e termini bloccati ──────────────────────────────────────── */
  if (settings.syncBlockedTerms) {
    const prisma = getPrisma();

    // Solo le firme di questo server e quelle manuali: le blocklist pubbliche
    // contano centinaia di migliaia di voci, mentre AutoMod ne accetta 1000.
    const signatures = await prisma.threatSignature.findMany({
      where: {
        guildId: guild.id,
        enabled: true,
        kind: { in: ['DOMAIN', 'KEYWORD'] },
      },
      select: { kind: true, value: true },
      take: MAX_KEYWORDS,
    });

    const domains = [
      ...new Set(
        [
          ...config.scanner.url.blockedDomains,
          ...signatures.filter((s) => s.kind === 'DOMAIN').map((s) => s.value),
        ]
          .map((value) => value.trim().toLowerCase())
          .filter((value) => value.length > 0 && value.length <= MAX_KEYWORD_LENGTH),
      ),
    ].slice(0, MAX_KEYWORDS);

    if (domains.length > 0) {
      desired.push({
        name: RULE_DOMAINS,
        enabled: true,
        payload: {
          eventType: AutoModerationRuleEventType.MessageSend,
          triggerType: AutoModerationRuleTriggerType.Keyword,
          // `*dominio*` intercetta il dominio ovunque compaia nel messaggio,
          // anche dentro un URL più lungo.
          triggerMetadata: { keywordFilter: domains.map((domain) => `*${domain}*`) },
          actions: blockActions('Questo link è bloccato dai filtri di sicurezza del server.'),
          exemptRoles,
        },
      });
    }

    const keywords = [
      ...new Set(
        signatures
          .filter((s) => s.kind === 'KEYWORD')
          .map((s) => s.value.trim())
          .filter((value) => value.length > 0 && value.length <= MAX_KEYWORD_LENGTH),
      ),
    ].slice(0, MAX_KEYWORDS);

    if (keywords.length > 0) {
      desired.push({
        name: RULE_TERMS,
        enabled: true,
        payload: {
          eventType: AutoModerationRuleEventType.MessageSend,
          triggerType: AutoModerationRuleTriggerType.Keyword,
          triggerMetadata: { keywordFilter: keywords },
          actions: blockActions('Il messaggio contiene un termine non consentito.'),
          exemptRoles,
        },
      });
    }
  }

  /* ── Filtro spam nativo ─────────────────────────────────────────────── */
  if (settings.enableNativeSpamFilter) {
    desired.push({
      name: RULE_SPAM,
      enabled: true,
      payload: {
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.Spam,
        triggerMetadata: {},
        actions: blockActions('Messaggio riconosciuto come spam.'),
        exemptRoles,
      },
    });
  }

  /* ── Menzioni di massa ──────────────────────────────────────────────── */
  if (settings.enableMentionSpamFilter) {
    desired.push({
      name: RULE_MENTIONS,
      enabled: true,
      payload: {
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.MentionSpam,
        triggerMetadata: { mentionTotalLimit: settings.mentionSpamLimit },
        actions: blockActions('Troppe menzioni in un solo messaggio.'),
        exemptRoles,
      },
    });
  }

  /* ── Profilo utente ─────────────────────────────────────────────────── */
  if (settings.quarantineOnProfileMatch) {
    // Richiede MODERATE_MEMBERS: senza, Discord rifiuta la regola.
    if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      report.errors.push(
        'Permesso ModerateMembers assente: la regola sui profili non può usare la quarantena.',
      );
    } else {
      const forbidden = buildForbiddenProfileTerms(config);
      if (forbidden.length > 0) {
        desired.push({
          name: RULE_PROFILE,
          enabled: true,
          payload: {
            eventType: AutoModerationRuleEventType.MemberUpdate,
            triggerType: AutoModerationRuleTriggerType.MemberProfile,
            triggerMetadata: { keywordFilter: forbidden },
            // BlockMemberInteraction è la quarantena nativa: l'utente non può
            // scrivere né parlare finché non cambia il profilo.
            actions: [{ type: AutoModerationActionType.BlockMemberInteraction }],
            exemptRoles,
          },
        });
      }
    }
  }

  /* ── Applicazione ───────────────────────────────────────────────────── */
  for (const rule of desired) {
    const current = managed.get(rule.name);
    try {
      if (current) {
        await current.edit({ ...rule.payload, enabled: rule.enabled });
        report.updated.push(rule.name);
        managed.delete(rule.name);
      } else {
        await guild.autoModerationRules.create({
          name: rule.name,
          enabled: rule.enabled,
          reason: 'Sincronizzazione AutoMod di ANGEL',
          ...rule.payload,
        } as Parameters<typeof guild.autoModerationRules.create>[0]);
        report.created.push(rule.name);
      }
    } catch (error) {
      report.errors.push(`${rule.name}: ${(error as Error).message}`);
      log.warn({ err: error, rule: rule.name, guildId: guild.id }, 'regola AutoMod non applicata');
    }
  }

  // Ciò che resta in `managed` non è più desiderato: erano regole nostre di una
  // configurazione precedente e vanno rimosse, altrimenti continuerebbero a
  // bloccare messaggi secondo criteri che nessuno ha più in mente.
  for (const [name, rule] of managed) {
    await rule
      .delete('Regola non più prevista dalla configurazione di ANGEL')
      .then(() => report.removed.push(name))
      .catch((error: Error) => report.errors.push(`${name}: ${error.message}`));
  }

  if (report.created.length + report.updated.length + report.removed.length > 0) {
    await recordEvent(client, {
      guildId: guild.id,
      type: 'AUTOMOD_RULE_CHANGED',
      actorId: client.user?.id,
      automated: true,
      summary:
        'Regole AutoMod sincronizzate: ' +
        `${report.created.length} create, ${report.updated.length} aggiornate, ` +
        `${report.removed.length} rimosse` +
        (report.errors.length > 0 ? `\n⚠️ ${report.errors.length} errori` : ''),
      payload: report as unknown as Record<string, unknown>,
    });
  }

  return report;
}

/**
 * Termini vietati nei profili.
 *
 * Sono quelli che servono a impersonare lo staff o Discord: un nickname
 * «Discord Staff» o «Moderatore ufficiale» non ha usi legittimi, e chi lo
 * sceglie sta preparando una truffa in privato che il bot non potrà vedere.
 */
function buildForbiddenProfileTerms(config: GuildConfig): string[] {
  const base = [
    '*discord staff*',
    '*discord support*',
    '*trust and safety*',
    '*trust & safety*',
    '*staff ufficiale*',
    '*supporto ufficiale*',
    '*moderatore ufficiale*',
    '*admin ufficiale*',
    '*discord moderator*',
    '*free nitro*',
    '*nitro gratis*',
  ];

  // I termini personalizzati del server arrivano dalle frasi scam configurate,
  // limitate a quelle abbastanza corte da stare in un nickname.
  const custom = config.scanner.scamPhrases
    .filter((phrase) => phrase.length <= 30)
    .map((phrase) => `*${phrase.toLowerCase()}*`);

  return [...new Set([...base, ...custom])]
    .filter((term) => term.length <= MAX_KEYWORD_LENGTH)
    .slice(0, MAX_KEYWORDS);
}
