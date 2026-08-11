import { PermissionFlagsBits, type Client, type Guild, type Webhook } from 'discord.js';
import { getPrisma } from '@angel/db';
import type { GuildConfig } from '@angel/shared';
import { recordEvent } from '../logging/auditLogger.js';
import { childLogger } from '../core/logger.js';
import { isBotOwner } from '../core/permissions.js';

const log = childLogger('webhookGuard');

/* ═══════════════════════════════════════════════════════════════════════
   PROTEZIONE WEBHOOK

   Un webhook è un URL che permette di scrivere in un canale senza alcun
   account, senza token del bot e senza comparire nell'elenco dei membri. Chi
   ne ottiene uno può pubblicare messaggi con nome e immagine arbitrari — cioè
   messaggi che sembrano provenire dallo staff o da Discord.

   Nella direzione opposta, i webhook sono anche un canale di uscita: pacchetti
   npm, PyPI e Ruby compromessi li usano come server di comando e controllo,
   perché sono gratuiti, immediati e il traffico verso discord.com non desta
   sospetti.

   Il modulo tiene un inventario e tratta come ostile tutto ciò che non è stato
   approvato.
   ═══════════════════════════════════════════════════════════════════════ */

export async function auditWebhooks(
  client: Client,
  guild: Guild,
  config: GuildConfig,
): Promise<{ total: number; unauthorized: number }> {
  const settings = config.security.webhookGuard;
  if (!settings.enabled) return { total: 0, unauthorized: 0 };

  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageWebhooks)) {
    log.warn({ guildId: guild.id }, 'permesso ManageWebhooks assente: audit non eseguibile');
    return { total: 0, unauthorized: 0 };
  }

  const webhooks = await guild.fetchWebhooks().catch(() => null);
  if (!webhooks) return { total: 0, unauthorized: 0 };

  const prisma = getPrisma();
  let unauthorized = 0;

  // I webhook gestiti da ANGEL per le personas sono legittimi per definizione.
  const managed = await prisma.webhookRecord.findMany({
    where: { guildId: guild.id, managed: true },
    select: { id: true },
  });
  const managedIds = new Set(managed.map((record) => record.id));

  for (const webhook of webhooks.values()) {
    // Stesso criterio della reazione immediata: se qui mancasse il controllo
    // sull'autore, un webhook legittimo sopravvivrebbe alla creazione e
    // verrebbe eliminato al primo audit periodico — un guasto che si
    // manifesta ore dopo, quando nessuno collega più le due cose.
    const approved =
      managedIds.has(webhook.id) ||
      settings.allowedWebhookIds.includes(webhook.id) ||
      (webhook.owner && settings.allowedCreatorIds.includes(webhook.owner.id)) ||
      (await creatoDaFidato(guild, config, webhook));

    await prisma.webhookRecord
      .upsert({
        where: { id: webhook.id },
        create: {
          id: webhook.id,
          guildId: guild.id,
          channelId: webhook.channelId,
          name: webhook.name,
          creatorId: webhook.owner?.id ?? null,
          managed: managedIds.has(webhook.id),
          approved: Boolean(approved),
        },
        update: {
          name: webhook.name,
          channelId: webhook.channelId,
          lastSeenAt: new Date(),
          approved: Boolean(approved),
          deletedAt: null,
        },
      })
      .catch(() => undefined);

    if (approved) continue;
    unauthorized++;

    await handleUnauthorized(client, guild, config, webhook);
  }

  // Webhook spariti dall'ultimo giro: marcati eliminati, restano nello storico.
  const seen = new Set(webhooks.map((webhook) => webhook.id));
  await prisma.webhookRecord
    .updateMany({
      where: { guildId: guild.id, deletedAt: null, id: { notIn: [...seen] } },
      data: { deletedAt: new Date() },
    })
    .catch(() => undefined);

  return { total: webhooks.size, unauthorized };
}

/** Chiamata dall'evento di creazione: reazione immediata, senza attendere l'audit. */
export async function onWebhookCreated(
  client: Client,
  guild: Guild,
  webhook: Webhook,
  config: GuildConfig,
): Promise<void> {
  const settings = config.security.webhookGuard;
  if (!settings.enabled) return;

  const prisma = getPrisma();
  const known = await prisma.webhookRecord.findUnique({ where: { id: webhook.id } });
  if (known?.managed || known?.approved) return;

  const approved =
    settings.allowedWebhookIds.includes(webhook.id) ||
    (webhook.owner && settings.allowedCreatorIds.includes(webhook.owner.id)) ||
    (await creatoDaFidato(guild, config, webhook));

  if (approved) return;
  await handleUnauthorized(client, guild, config, webhook);
}

/**
 * Il webhook è stato creato da chi ha titolo per farlo?
 *
 * Un webhook creato da un amministratore, dal proprietario del server o da un
 * membro dello staff non viene mai eliminato. È un'integrazione voluta —
 * GitHub, un servizio di annunci, un ponte con un altro servizio — e
 * cancellarla significa rompere qualcosa che qualcuno ha configurato di
 * proposito, senza preavviso e senza modo di sapere cosa fosse.
 *
 * Chi ha `ManageWebhooks` può ricrearlo in dieci secondi: eliminarlo non
 * impedisce nulla a chi è già autorizzato, e danneggia solo gli usi legittimi.
 * Se quell'account fosse davvero compromesso, il problema non si risolve
 * togliendo un webhook — si risolve con l'anti-nuke, che agisce sulla persona.
 *
 * Resta la segnalazione: il webhook viene registrato e annunciato comunque,
 * perché sapere che è comparso è utile in ogni caso.
 */
async function creatoDaFidato(
  guild: Guild,
  config: GuildConfig,
  webhook: Webhook,
): Promise<boolean> {
  const autoreId = webhook.owner?.id;
  if (!autoreId) return false;

  if (isBotOwner(autoreId)) return true;
  if (autoreId === guild.ownerId) return true;
  if (autoreId === guild.client.user?.id) return true;

  const membro = await guild.members.fetch(autoreId).catch(() => null);
  if (!membro) return false;

  if (membro.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return config.general.staffRoleIds.some((roleId) => membro.roles.cache.has(roleId));
}

async function handleUnauthorized(
  client: Client,
  guild: Guild,
  config: GuildConfig,
  webhook: Webhook,
): Promise<void> {
  const settings = config.security.webhookGuard;

  await recordEvent(client, {
    guildId: guild.id,
    type: 'WEBHOOK_UNAUTHORIZED',
    actorId: webhook.owner?.id ?? null,
    channelId: webhook.channelId,
    severity: 80,
    automated: true,
    summary:
      `🪝 **Webhook non autorizzato**: "${webhook.name}" in <#${webhook.channelId}>` +
      (webhook.owner ? `\nCreato da <@${webhook.owner.id}>` : '') +
      '\n\nUn webhook consente di pubblicare messaggi con nome e immagine arbitrari, senza ' +
      'essere membro del server, ed è usato anche come canale di esfiltrazione.' +
      (settings.autoDeleteUnknown ? '\nÈ stato eliminato automaticamente.' : ''),
    payload: { webhookId: webhook.id, name: webhook.name, ownerId: webhook.owner?.id },
  });

  if (settings.autoDeleteUnknown && !config.general.dryRun) {
    await webhook
      .delete('Webhook non presente nella allowlist di ANGEL')
      .catch((error) => log.warn({ err: error }, 'eliminazione webhook fallita'));

    const prisma = getPrisma();
    await prisma.webhookRecord
      .updateMany({
        where: { id: webhook.id },
        data: { deletedAt: new Date(), deletedBy: client.user?.id ?? null },
      })
      .catch(() => undefined);
  }
}

/** Registra un webhook creato da ANGEL per una persona: va in allowlist. */
export async function registerManagedWebhook(
  guildId: string,
  webhook: Webhook,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.webhookRecord.upsert({
    where: { id: webhook.id },
    create: {
      id: webhook.id,
      guildId,
      channelId: webhook.channelId,
      name: webhook.name,
      managed: true,
      approved: true,
    },
    update: { managed: true, approved: true, deletedAt: null, lastSeenAt: new Date() },
  });
}
