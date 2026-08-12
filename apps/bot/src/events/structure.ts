import {
  Events,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
  type GuildChannel,
  type NonThreadGuildBasedChannel,
  type Role,
} from 'discord.js';
import { getGuildConfig } from '../core/config.js';
import { unverifiedRoleId } from '@angel/shared';
import { recordEvent } from '../logging/auditLogger.js';
import { onWebhookCreated } from '../security/webhookGuard.js';
import { onEventInterest } from '../integrations/events.js';
import { closeTicket } from '../integrations/tickets.js';
import { getPrisma } from '@angel/db';

/**
 * Struttura del server: canali, ruoli, emoji, thread, impostazioni, webhook,
 * regole AutoMod ed eventi programmati.
 *
 * Il gateway consegna questi eventi senza l'autore: `channelDelete` dice cosa è
 * sparito, non chi l'ha fatto sparire. L'attribuzione arriva dal registro di
 * controllo, gestito in `auditLog.ts` — qui si registra il fatto, lì il
 * responsabile, e i due si ricongiungono nel pannello.
 */
export function registerStructureEvents(client: Client): void {
  /* ── Canali ───────────────────────────────────────────────────────── */
  client.on(Events.ChannelCreate, (channel) => {
    void recordEvent(client, {
      guildId: channel.guild.id,
      type: 'CHANNEL_CREATED',
      channelId: channel.id,
      summary: `Canale **${channel.name}** creato`,
      payload: { type: channel.type, parentId: channel.parentId },
    });

    // Un canale creato dopo la predisposizione sarebbe visibile a chi non ha
    // ancora verificato: il filtro d'ingresso si aprirebbe da solo, in
    // silenzio, il giorno in cui qualcuno aggiunge un canale.
    void isolaCanaleNuovo(channel);
  });

  client.on(Events.ChannelDelete, (channel) => {
    if (!('guild' in channel)) return;
    void recordEvent(client, {
      guildId: channel.guild.id,
      type: 'CHANNEL_DELETED',
      channelId: channel.id,
      severity: 40,
      summary: `Canale **${(channel as GuildChannel).name}** eliminato`,
      payload: { type: channel.type },
    });

    // Se il canale eliminato era un ticket ancora aperto, la trascrizione va
    // prodotta adesso. Chi elimina un canale a mano non pensa al ticket che
    // conteneva, e senza questo la conversazione sparirebbe senza lasciare
    // traccia — proprio nei casi in cui qualcuno voleva farla sparire.
    void chiudiTicketDelCanale(client, channel as GuildChannel);
  });

  client.on(Events.ChannelUpdate, (oldChannel, newChannel) => {
    if (!('guild' in newChannel)) return;
    const before = oldChannel as NonThreadGuildBasedChannel;
    const after = newChannel as NonThreadGuildBasedChannel;

    // Le due differenze restano separate perché distinguono il tipo di evento:
    // rinominare un canale e ridarne i permessi a un ruolo non si cercano allo
    // stesso modo nel registro, e finire nella stessa categoria li confonde.
    const changes = diffChannel(before, after);
    const permissions = diffOverwrites(before, after);
    if (changes.length === 0 && permissions.length === 0) return;

    void recordEvent(client, {
      guildId: newChannel.guild.id,
      type: permissions.length > 0 ? 'CHANNEL_PERMISSIONS_UPDATED' : 'CHANNEL_UPDATED',
      channelId: newChannel.id,
      summary: [...changes, ...permissions].join('\n'),
      payload: { changes, permissions },
    });
  });

  /* ── Ruoli ────────────────────────────────────────────────────────── */
  client.on(Events.GuildRoleCreate, (role) => {
    void recordEvent(client, {
      guildId: role.guild.id,
      type: 'ROLE_CREATED',
      roleId: role.id,
      summary: `Ruolo **${role.name}** creato`,
      payload: { permissions: role.permissions.bitfield.toString() },
    });
  });

  client.on(Events.GuildRoleDelete, (role) => {
    void recordEvent(client, {
      guildId: role.guild.id,
      type: 'ROLE_DELETED',
      roleId: role.id,
      severity: 40,
      summary: `Ruolo **${role.name}** eliminato`,
      payload: { permissions: role.permissions.bitfield.toString() },
    });
  });

  client.on(Events.GuildRoleUpdate, (oldRole, newRole) => {
    void handleRoleUpdate(client, oldRole, newRole);
  });

  /* ── Espressioni ──────────────────────────────────────────────────── */
  client.on(Events.GuildEmojiCreate, (emoji) => {
    void recordEvent(client, {
      guildId: emoji.guild.id,
      type: 'EMOJI_CREATED',
      summary: `Emoji **${emoji.name}** aggiunta`,
    });
  });

  client.on(Events.GuildEmojiDelete, (emoji) => {
    void recordEvent(client, {
      guildId: emoji.guild.id,
      type: 'EMOJI_DELETED',
      summary: `Emoji **${emoji.name}** rimossa`,
      severity: 20,
    });
  });

  client.on(Events.GuildEmojiUpdate, (oldEmoji, newEmoji) => {
    if (oldEmoji.name === newEmoji.name) return;
    void recordEvent(client, {
      guildId: newEmoji.guild.id,
      type: 'EMOJI_UPDATED',
      summary: `Emoji rinominata: \`${oldEmoji.name}\` → \`${newEmoji.name}\``,
      payload: { before: oldEmoji.name, after: newEmoji.name },
    });
  });

  client.on(Events.GuildStickerUpdate, (oldSticker, newSticker) => {
    const changes: string[] = [];
    if (oldSticker.name !== newSticker.name) {
      changes.push(`Nome: \`${oldSticker.name}\` → \`${newSticker.name}\``);
    }
    if (oldSticker.description !== newSticker.description) changes.push('Descrizione modificata');
    if (oldSticker.tags !== newSticker.tags) changes.push('Tag modificati');
    if (changes.length === 0) return;

    void recordEvent(client, {
      guildId: newSticker.guild!.id,
      type: 'STICKER_UPDATED',
      summary: changes.join('\n'),
      payload: { changes },
    });
  });

  client.on(Events.GuildStickerCreate, (sticker) => {
    void recordEvent(client, {
      guildId: sticker.guild!.id,
      type: 'STICKER_CREATED',
      summary: `Sticker **${sticker.name}** aggiunto`,
    });
  });

  client.on(Events.GuildStickerDelete, (sticker) => {
    void recordEvent(client, {
      guildId: sticker.guild!.id,
      type: 'STICKER_DELETED',
      summary: `Sticker **${sticker.name}** rimosso`,
    });
  });

  /* ── Server ───────────────────────────────────────────────────────── */
  client.on(Events.GuildUpdate, (oldGuild, newGuild) => {
    const changes: string[] = [];
    if (oldGuild.name !== newGuild.name) changes.push(`Nome: \`${oldGuild.name}\` → \`${newGuild.name}\``);
    if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
      changes.push(
        `Livello di verifica: ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`,
      );
    }
    if (oldGuild.mfaLevel !== newGuild.mfaLevel) {
      // Disattivare la 2FA obbligatoria per i moderatori è un downgrade di
      // sicurezza che va notato subito.
      changes.push(
        `⚠️ 2FA obbligatoria per i moderatori: ${oldGuild.mfaLevel ? 'attiva' : 'disattivata'} → ` +
          `${newGuild.mfaLevel ? 'attiva' : 'disattivata'}`,
      );
    }
    if (oldGuild.ownerId !== newGuild.ownerId) {
      changes.push(`🚨 Proprietario: <@${oldGuild.ownerId}> → <@${newGuild.ownerId}>`);
    }
    if (changes.length === 0) return;

    void recordEvent(client, {
      guildId: newGuild.id,
      type: 'GUILD_UPDATED',
      severity: oldGuild.ownerId !== newGuild.ownerId || oldGuild.mfaLevel !== newGuild.mfaLevel ? 80 : 20,
      summary: changes.join('\n'),
      payload: { changes },
    });
  });

  /* ── Thread ───────────────────────────────────────────────────────── */
  client.on(Events.ThreadCreate, (thread) => {
    void recordEvent(client, {
      guildId: thread.guild.id,
      type: 'THREAD_CREATED',
      channelId: thread.parentId,
      actorId: thread.ownerId,
      summary: `Thread **${thread.name}** creato`,
    });
  });

  client.on(Events.ThreadDelete, (thread) => {
    void recordEvent(client, {
      guildId: thread.guild.id,
      type: 'THREAD_DELETED',
      channelId: thread.parentId,
      summary: `Thread **${thread.name}** eliminato`,
    });
  });

  client.on(Events.ThreadUpdate, (oldThread, newThread) => {
    // L'archiviazione ha un evento proprio: un thread archiviato sparisce dalla
    // vista, ed è una forma di rimozione del contenuto che va tracciata come
    // tale, non confusa con una modifica qualunque.
    if (oldThread.archived !== newThread.archived) {
      void recordEvent(client, {
        guildId: newThread.guild.id,
        type: newThread.archived ? 'THREAD_ARCHIVED' : 'THREAD_UNARCHIVED',
        channelId: newThread.parentId,
        summary: `Thread **${newThread.name}** ${newThread.archived ? 'archiviato' : 'riaperto'}`,
        payload: { threadId: newThread.id, locked: newThread.locked },
      });
      return;
    }

    const changes: string[] = [];
    if (oldThread.name !== newThread.name) {
      changes.push(`Nome: \`${oldThread.name}\` → \`${newThread.name}\``);
    }
    if (oldThread.locked !== newThread.locked) {
      changes.push(newThread.locked ? 'Thread bloccato' : 'Thread sbloccato');
    }
    if (oldThread.rateLimitPerUser !== newThread.rateLimitPerUser) {
      changes.push(`Modalità lenta: ${newThread.rateLimitPerUser ?? 0}s`);
    }
    if (changes.length === 0) return;

    void recordEvent(client, {
      guildId: newThread.guild.id,
      type: 'THREAD_UPDATED',
      channelId: newThread.parentId,
      summary: `Thread **${newThread.name}**\n${changes.join('\n')}`,
      payload: { changes, threadId: newThread.id },
    });
  });

  client.on(Events.ThreadMembersUpdate, (added, removed, thread) => {
    for (const member of added.values()) {
      void recordEvent(client, {
        guildId: thread.guild.id,
        type: 'THREAD_MEMBER_JOINED',
        actorId: member.id,
        channelId: thread.parentId,
        summary: `<@${member.id}> è entrato nel thread **${thread.name}**`,
        payload: { threadId: thread.id },
      });
    }
    for (const member of removed.values()) {
      void recordEvent(client, {
        guildId: thread.guild.id,
        type: 'THREAD_MEMBER_LEFT',
        actorId: member.id,
        channelId: thread.parentId,
        summary: `<@${member.id}> ha lasciato il thread **${thread.name}**`,
        payload: { threadId: thread.id },
      });
    }
  });

  /* ── Stage ────────────────────────────────────────────────────────── */
  client.on(Events.StageInstanceCreate, (stage) => {
    void recordEvent(client, {
      guildId: stage.guild!.id,
      type: 'STAGE_STARTED',
      channelId: stage.channelId,
      summary: `Stage avviato: **${stage.topic}**`,
      payload: { privacyLevel: stage.privacyLevel },
    });
  });

  client.on(Events.StageInstanceUpdate, (oldStage, newStage) => {
    if (oldStage?.topic === newStage.topic) return;
    void recordEvent(client, {
      guildId: newStage.guild!.id,
      type: 'STAGE_UPDATED',
      channelId: newStage.channelId,
      summary: `Argomento dello stage: \`${oldStage?.topic ?? '—'}\` → \`${newStage.topic}\``,
    });
  });

  client.on(Events.StageInstanceDelete, (stage) => {
    void recordEvent(client, {
      guildId: stage.guild!.id,
      type: 'STAGE_ENDED',
      channelId: stage.channelId,
      summary: `Stage terminato: **${stage.topic}**`,
    });
  });

  /* ── Webhook ──────────────────────────────────────────────────────── */
  client.on(Events.WebhooksUpdate, (channel) => {
    void handleWebhooksUpdate(client, channel as GuildChannel);
  });

  /* ── AutoMod nativo ───────────────────────────────────────────────── */
  client.on(Events.AutoModerationActionExecution, (execution) => {
    void recordEvent(client, {
      guildId: execution.guild.id,
      type: 'AUTOMOD_TRIGGERED',
      actorId: execution.userId,
      channelId: execution.channelId,
      severity: 30,
      summary:
        `Regola AutoMod **${execution.autoModerationRule?.name ?? execution.ruleTriggerType}** attivata` +
        (execution.matchedKeyword ? `\nParola: \`${execution.matchedKeyword}\`` : ''),
      payload: {
        ruleId: execution.ruleId,
        action: execution.action.type,
        matchedContent: execution.matchedContent,
      },
    });
  });

  client.on(Events.AutoModerationRuleCreate, (rule) => {
    void recordEvent(client, {
      guildId: rule.guild.id,
      type: 'AUTOMOD_RULE_CHANGED',
      summary: `Regola AutoMod **${rule.name}** creata`,
    });
  });

  client.on(Events.AutoModerationRuleDelete, (rule) => {
    void recordEvent(client, {
      guildId: rule.guild.id,
      type: 'AUTOMOD_RULE_CHANGED',
      severity: 50,
      summary: `⚠️ Regola AutoMod **${rule.name}** eliminata`,
    });
  });

  /* ── Eventi programmati ───────────────────────────────────────────── */
  client.on(Events.GuildScheduledEventCreate, (event) => {
    void recordEvent(client, {
      guildId: event.guild!.id,
      type: 'EVENT_CREATED',
      actorId: event.creatorId,
      summary: `Evento **${event.name}** programmato per <t:${Math.floor((event.scheduledStartTimestamp ?? 0) / 1000)}:f>`,
    });
  });

  client.on(Events.GuildScheduledEventDelete, (event) => {
    void recordEvent(client, {
      guildId: event.guild!.id,
      type: 'EVENT_DELETED',
      summary: `Evento **${event.name}** annullato`,
    });
  });

  client.on(Events.GuildScheduledEventUpdate, (oldEvent, newEvent) => {
    if (!newEvent.guild) return;
    if (oldEvent?.scheduledStartTimestamp === newEvent.scheduledStartTimestamp) return;
    void recordEvent(client, {
      guildId: newEvent.guild.id,
      type: 'EVENT_UPDATED',
      summary:
        `Evento **${newEvent.name}** spostato a ` +
        `<t:${Math.floor((newEvent.scheduledStartTimestamp ?? 0) / 1000)}:f>`,
    });
  });

  // Iscrizione e disiscrizione da un evento: gestiscono il ruolo RSVP, che
  // serve a poter avvisare i partecipanti senza menzionare tutto il server.
  client.on(Events.GuildScheduledEventUserAdd, (event, user) => {
    void (async () => {
      if (!event.guild) return;
      const config = await getGuildConfig(event.guild.id);
      await recordEvent(client, {
        guildId: event.guild.id,
        type: 'EVENT_RSVP_ADDED',
        actorId: user.id,
        actorTag: user.tag,
        summary: `<@${user.id}> si è iscritto all'evento **${event.name}**`,
        payload: { eventId: event.id },
      });
      await onEventInterest(client, event.guild, user.id, config, true);
    })();
  });

  client.on(Events.GuildScheduledEventUserRemove, (event, user) => {
    void (async () => {
      if (!event.guild) return;
      const config = await getGuildConfig(event.guild.id);
      await recordEvent(client, {
        guildId: event.guild.id,
        type: 'EVENT_RSVP_REMOVED',
        actorId: user.id,
        actorTag: user.tag,
        summary: `<@${user.id}> si è disiscritto dall'evento **${event.name}**`,
        payload: { eventId: event.id },
      });
      await onEventInterest(client, event.guild, user.id, config, false);
    })();
  });

  /**
   * `guildIntegrationsUpdate` non dice cosa è cambiato: l'evento dettagliato
   * (chi ha aggiunto o rimosso cosa) arriva dal registro di controllo, dove è
   * già mappato su `INTEGRATION_CREATED` / `INTEGRATION_DELETED`. Qui resta
   * solo la traccia che qualcosa si è mosso, utile quando il bot non ha il
   * permesso di leggere il registro.
   */
  client.on(Events.GuildIntegrationsUpdate, (guild) => {
    void recordEvent(client, {
      guildId: guild.id,
      type: 'INTEGRATION_CREATED',
      severity: 30,
      summary:
        'Le integrazioni del server sono cambiate. ' +
        'Il dettaglio con l\'autore compare nel registro di controllo, se il bot può leggerlo.',
      payload: { source: 'gateway' },
    });
  });
}

/**
 * Modifica di un ruolo.
 *
 * Il caso importante è uno solo: l'aggiunta di permessi pericolosi. È il passo
 * che precede il nuke — l'attaccante si dà i permessi *prima* di usarli — ed è
 * anche il modo in cui un moderatore ottiene per errore più potere del dovuto.
 */
/**
 * Chiude il ticket il cui canale è appena stato eliminato.
 *
 * La trascrizione si costruisce dall'archivio dei messaggi, non dal canale:
 * il canale a questo punto non esiste più, ma le righe archiviate sì. È il
 * motivo per cui l'archiviazione dei messaggi vale la pena anche quando
 * sembra ridondante.
 */
async function chiudiTicketDelCanale(client: Client, channel: GuildChannel): Promise<void> {
  const prisma = getPrisma();
  const ticket = await prisma.ticket
    .findFirst({
      where: { guildId: channel.guild.id, channelId: channel.id, status: 'OPEN' },
      select: { number: true },
    })
    .catch(() => null);

  if (!ticket) return;

  const config = await getGuildConfig(channel.guild.id).catch(() => null);
  if (!config) return;

  await closeTicket(
    client,
    channel.guild,
    ticket.number,
    client.user?.id ?? 'system',
    'Canale eliminato: chiusura automatica con trascrizione',
    config,
    channel,
  ).catch(() => undefined);
}

/**
 * Nega il canale appena creato a chi non ha ancora verificato.
 *
 * Solo una negazione su un ruolo, come nella predisposizione: non può rendere
 * visibile nulla, quindi vale anche per i canali che nascono già riservati
 * allo staff — su quelli non cambia niente, ed è la ragione per cui si può
 * applicare senza guardare cosa contengono.
 */
async function isolaCanaleNuovo(channel: GuildChannel): Promise<void> {
  const config = await getGuildConfig(channel.guild.id).catch(() => null);
  if (!config?.security.verification.enabled) return;
  if (config.security.verification.mode === 'OFF') return;

  const isolante = unverifiedRoleId(config);
  if (!isolante || channel.id === config.security.verification.verifyChannelId) return;
  if (!channel.guild.roles.cache.has(isolante)) return;

  // Un canale figlio senza permessi propri eredita dalla categoria, che è già
  // stata negata: intervenire gli darebbe permessi propri e lo scollegherebbe
  // dall'eredità, che è un effetto collaterale, non l'obiettivo.
  if (channel.parentId !== null && channel.permissionOverwrites.cache.size === 0) return;

  await channel.permissionOverwrites
    .edit(isolante, { ViewChannel: false }, { reason: 'Isolamento di chi non ha verificato' })
    .catch(() => undefined);

  // Se il server è chiuso a `@everyone`, il canale nuovo deve nascere chiuso
  // come gli altri: creato pubblico resterebbe l'unico visibile a chi non ha
  // verificato, e basterebbe un canale aggiunto in fretta per aprire una
  // finestra sul server.
  const verificato = config.security.verification.verifiedRoleId;
  if (!verificato || !channel.guild.roles.cache.has(verificato)) return;

  // Solo se il server è davvero chiuso: si guarda un canale già predisposto,
  // non una configurazione che dice di esserlo. Altrimenti un server che ha il
  // ruolo ma ha scelto di restare aperto si troverebbe i canali nuovi chiusi.
  const chiuso = channel.guild.channels.cache.some((altro) =>
    altro.id !== channel.id && 'permissionOverwrites' in altro
      ? Boolean(
          altro.permissionOverwrites.cache
            .get(channel.guild.id)
            ?.deny.has(PermissionFlagsBits.ViewChannel),
        )
      : false,
  );
  if (!chiuso) return;

  // Un canale creato già privato resta privato: `@everyone` non lo vede, e
  // dargli un permesso esplicito lo aprirebbe a tutti i verificati.
  if (
    channel.permissionOverwrites.cache
      .get(channel.guild.id)
      ?.deny.has(PermissionFlagsBits.ViewChannel)
  ) {
    return;
  }

  const dato = await channel.permissionOverwrites
    .edit(verificato, { ViewChannel: true }, { reason: 'Accesso ai verificati' })
    .then(() => true)
    .catch(() => false);
  if (!dato) return;

  await channel.permissionOverwrites
    .edit(channel.guild.id, { ViewChannel: false }, { reason: 'Visibile solo a chi ha verificato' })
    .catch(() => undefined);
}

async function handleRoleUpdate(client: Client, oldRole: Role, newRole: Role): Promise<void> {
  const config = await getGuildConfig(newRole.guild.id);
  const changes: string[] = [];

  if (oldRole.name !== newRole.name) changes.push(`Nome: \`${oldRole.name}\` → \`${newRole.name}\``);
  if (oldRole.color !== newRole.color) changes.push('Colore modificato');
  if (oldRole.hoist !== newRole.hoist) changes.push(`Visualizzazione separata: ${newRole.hoist}`);

  const before = oldRole.permissions.bitfield;
  const after = newRole.permissions.bitfield;

  if (before !== after) {
    const added = new PermissionsBitField(after & ~before).toArray();
    const removed = new PermissionsBitField(before & ~after).toArray();
    if (added.length) changes.push(`Permessi aggiunti: ${added.join(', ')}`);
    if (removed.length) changes.push(`Permessi rimossi: ${removed.join(', ')}`);

    const dangerous = added.filter((permission) =>
      config.security.antiNuke.dangerousPermissions.includes(permission),
    );

    if (dangerous.length > 0) {
      await recordEvent(client, {
        guildId: newRole.guild.id,
        type: 'ROLE_PERMISSIONS_ESCALATED',
        roleId: newRole.id,
        severity: 85,
        summary:
          `⚠️ Al ruolo <@&${newRole.id}> sono stati aggiunti permessi pericolosi: ` +
          `**${dangerous.join(', ')}**\n` +
          `Il ruolo è assegnato a ${newRole.members.size} membri.`,
        payload: { added: dangerous, memberCount: newRole.members.size },
      });
      return;
    }
  }

  if (changes.length === 0) return;

  await recordEvent(client, {
    guildId: newRole.guild.id,
    type: 'ROLE_UPDATED',
    roleId: newRole.id,
    summary: `Ruolo <@&${newRole.id}>\n${changes.join('\n')}`,
    payload: { changes },
  });
}

/**
 * `webhooksUpdate` non dice cosa è cambiato: si confronta l'elenco corrente con
 * quello registrato per capire se ne è comparso uno nuovo.
 */
async function handleWebhooksUpdate(client: Client, channel: GuildChannel): Promise<void> {
  const config = await getGuildConfig(channel.guild.id);
  if (!config.security.webhookGuard.enabled) return;

  const webhooks = await channel.guild.fetchWebhooks().catch(() => null);
  if (!webhooks) return;

  const { getPrisma } = await import('@angel/db');
  const prisma = getPrisma();
  const known = await prisma.webhookRecord.findMany({
    where: { guildId: channel.guild.id, deletedAt: null },
    select: { id: true, name: true, channelId: true },
  });
  const knownById = new Map(known.map((record) => [record.id, record]));

  for (const webhook of webhooks.values()) {
    const previous = knownById.get(webhook.id);

    if (!previous) {
      await recordEvent(client, {
        guildId: channel.guild.id,
        type: 'WEBHOOK_CREATED',
        actorId: webhook.owner?.id ?? null,
        channelId: webhook.channelId,
        summary: `Webhook **${webhook.name}** creato in <#${webhook.channelId}>`,
        payload: { webhookId: webhook.id },
      });
      await onWebhookCreated(client, channel.guild, webhook, config);
      continue;
    }

    // Un webhook rinominato o spostato è il modo per riciclarne uno approvato
    // facendolo sembrare qualcos'altro: va notato.
    if (previous.name !== webhook.name || previous.channelId !== webhook.channelId) {
      await recordEvent(client, {
        guildId: channel.guild.id,
        type: 'WEBHOOK_UPDATED',
        channelId: webhook.channelId,
        severity: 30,
        summary:
          `Webhook modificato: \`${previous.name}\` → \`${webhook.name}\`` +
          (previous.channelId !== webhook.channelId
            ? `\nSpostato da <#${previous.channelId}> a <#${webhook.channelId}>`
            : ''),
        payload: { webhookId: webhook.id, before: previous, after: { name: webhook.name, channelId: webhook.channelId } },
      });
      await prisma.webhookRecord
        .update({
          where: { id: webhook.id },
          data: { name: webhook.name, channelId: webhook.channelId, lastSeenAt: new Date() },
        })
        .catch(() => undefined);
    }

    knownById.delete(webhook.id);
  }

  // Ciò che resta nella mappa non esiste più su Discord: l'inventario va
  // aggiornato, altrimenti il pannello continuerebbe a mostrare webhook morti.
  for (const [id, record] of knownById) {
    await prisma.webhookRecord
      .update({ where: { id }, data: { deletedAt: new Date() } })
      .catch(() => undefined);
    await recordEvent(client, {
      guildId: channel.guild.id,
      type: 'WEBHOOK_DELETED',
      channelId: record.channelId,
      summary: `Webhook **${record.name}** eliminato`,
      payload: { webhookId: id },
    });
  }
}

function diffChannel(
  oldChannel: NonThreadGuildBasedChannel,
  newChannel: NonThreadGuildBasedChannel,
): string[] {
  const changes: string[] = [];
  if (oldChannel.name !== newChannel.name) {
    changes.push(`Nome: \`${oldChannel.name}\` → \`${newChannel.name}\``);
  }
  if ('topic' in oldChannel && 'topic' in newChannel && oldChannel.topic !== newChannel.topic) {
    changes.push('Descrizione modificata');
  }
  if (
    'rateLimitPerUser' in oldChannel &&
    'rateLimitPerUser' in newChannel &&
    oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser
  ) {
    changes.push(
      `Modalità lenta: ${oldChannel.rateLimitPerUser ?? 0}s → ${newChannel.rateLimitPerUser ?? 0}s`,
    );
  }
  if (oldChannel.parentId !== newChannel.parentId) changes.push('Categoria modificata');

  return changes;
}

/**
 * Differenza fra i permessi di due versioni dello stesso canale.
 *
 * Prima qui c'era la riga «permessi del canale modificati», che è vera e
 * inutile: chi legge un registro dopo un incidente deve sapere *a chi* e
 * *quale* permesso è stato dato, non che qualcosa è cambiato. Con un ruolo che
 * guadagna in silenzio `ManageChannels` su un canale, quella riga è la
 * differenza fra accorgersene e non accorgersene.
 */
function diffOverwrites(
  oldChannel: NonThreadGuildBasedChannel,
  newChannel: NonThreadGuildBasedChannel,
): string[] {
  const changes: string[] = [];
  const ids = new Set([
    ...oldChannel.permissionOverwrites.cache.keys(),
    ...newChannel.permissionOverwrites.cache.keys(),
  ]);

  for (const id of ids) {
    const before = oldChannel.permissionOverwrites.cache.get(id);
    const after = newChannel.permissionOverwrites.cache.get(id);

    // `@everyone` ha come ID quello del server: scriverlo come menzione di
    // ruolo produrrebbe un riferimento che Discord non risolve.
    const chi =
      id === newChannel.guild.id
        ? '@everyone'
        : (after ?? before)?.type === OverwriteType.Member
          ? `<@${id}>`
          : `<@&${id}>`;

    if (!after) {
      changes.push(`Permessi speciali di ${chi} rimossi`);
      continue;
    }
    if (!before) {
      const allowed = after.allow.toArray();
      const denied = after.deny.toArray();
      changes.push(
        `Permessi speciali aggiunti per ${chi}` +
          (allowed.length ? ` · concessi: ${allowed.join(', ')}` : '') +
          (denied.length ? ` · negati: ${denied.join(', ')}` : ''),
      );
      continue;
    }

    // Un permesso può passare per tre stati (concesso, negato, ereditato), e
    // ognuna delle sei transizioni possibili è un'informazione diversa: si
    // confrontano quindi entrambe le maschere, non solo quella dei permessi
    // concessi.
    const nowAllowed = new PermissionsBitField(after.allow.bitfield & ~before.allow.bitfield)
      .toArray()
      .filter((permission) => !before.allow.has(permission));
    const nowDenied = new PermissionsBitField(after.deny.bitfield & ~before.deny.bitfield).toArray();
    const cleared = new PermissionsBitField(
      (before.allow.bitfield | before.deny.bitfield) & ~(after.allow.bitfield | after.deny.bitfield),
    ).toArray();

    const parts: string[] = [];
    if (nowAllowed.length) parts.push(`concessi ${nowAllowed.join(', ')}`);
    if (nowDenied.length) parts.push(`negati ${nowDenied.join(', ')}`);
    if (cleared.length) parts.push(`riportati al valore ereditato ${cleared.join(', ')}`);
    if (parts.length) changes.push(`${chi}: ${parts.join(' · ')}`);
  }

  return changes;
}
