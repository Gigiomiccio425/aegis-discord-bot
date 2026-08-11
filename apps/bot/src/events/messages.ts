import {
  Events,
  type Client,
  type Message,
  type PartialMessage,
  type PartialPollAnswer,
  type PollAnswer,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import { contentFingerprint, mergeDecisions, type Decision } from '@angel/shared';
import { getGuildConfig } from '../core/config.js';
import { applyDecision } from '../core/enforcer.js';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';
import { codeBlock } from '../logging/formatters.js';
import { archiveMessage, markDeleted } from '../logging/archiver.js';
import { evaluateSpam } from '../security/antiSpam.js';
import { evaluateContent } from '../security/contentGuard.js';
import { evaluateInvites } from '../security/inviteGuard.js';
import { evaluateSafety } from '../security/safety.js';
import { evaluateCompromise, trackActivity } from '../security/compromise.js';

const log = childLogger('events:messages');

/**
 * Catena di analisi di un messaggio.
 *
 * I moduli vengono eseguiti in parallelo e le loro decisioni fuse in una sola:
 * eseguirli in sequenza con uscita anticipata sembrerebbe più efficiente, ma
 * perderebbe informazioni — un messaggio può essere insieme spam, phishing e
 * segnale di account compromesso, e lo staff deve vederli tutti e tre nel log.
 * L'esecutore applica poi una sola sanzione, la più grave.
 */
export function registerMessageEvents(client: Client): void {
  client.on(Events.MessageCreate, (message) => {
    void handleMessageCreate(client, message).catch((error) =>
      log.error({ err: error, messageId: message.id }, 'analisi messaggio fallita'),
    );
  });

  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    void handleMessageUpdate(client, oldMessage, newMessage).catch((error) =>
      log.error({ err: error }, 'gestione modifica messaggio fallita'),
    );
  });

  client.on(Events.MessageDelete, (message) => {
    void handleMessageDelete(client, message).catch((error) =>
      log.error({ err: error }, 'gestione eliminazione messaggio fallita'),
    );
  });

  client.on(Events.MessageBulkDelete, (messages) => {
    void handleBulkDelete(client, messages).catch((error) =>
      log.error({ err: error }, 'gestione eliminazione di massa fallita'),
    );
  });

  /**
   * Sondaggi nativi di Discord.
   *
   * Sono distinti da quelli di ANGEL: chiunque può crearne uno dal client, e
   * senza questi due eventi il registro avrebbe un buco proprio dove si prende
   * una decisione collettiva.
   */
  client.on(Events.MessagePollVoteAdd, (answer, userId) => {
    void handlePollVote(client, answer, userId, true).catch(() => undefined);
  });

  client.on(Events.MessagePollVoteRemove, (answer, userId) => {
    void handlePollVote(client, answer, userId, false).catch(() => undefined);
  });
}

async function handlePollVote(
  client: Client,
  // Con il partial `PollAnswer` l'oggetto può arrivare incompleto — succede
  // per i sondaggi pubblicati prima dell'ultimo riavvio del bot.
  answer: PollAnswer | PartialPollAnswer,
  userId: string,
  added: boolean,
): Promise<void> {
  const message = answer.poll?.message;
  const guildId = message?.guildId;
  if (!guildId) return;

  const user = await client.users.fetch(userId).catch(() => null);

  await recordEvent(client, {
    guildId,
    type: 'MESSAGE_POLL_VOTED',
    actorId: userId,
    actorTag: user?.tag ?? null,
    channelId: message.channelId,
    messageId: message.id,
    summary:
      `${added ? 'Voto' : 'Voto ritirato'} nel sondaggio nativo ` +
      `«${answer.poll?.question.text?.slice(0, 80) ?? '—'}»: ` +
      `${answer.text ?? answer.emoji?.name ?? `opzione ${answer.id}`}`,
    payload: { answerId: answer.id, added, answer: answer.text },
  });
}

async function handleMessageCreate(client: Client, message: Message): Promise<void> {
  if (!message.guild || message.author.bot || message.system) return;

  const config = await getGuildConfig(message.guild.id);

  // L'archiviazione precede l'analisi: se il messaggio viene eliminato tra un
  // istante, la copia deve esistere già.
  await archiveMessage(message, config).catch(() => undefined);

  // Gli allegati hanno un evento proprio, separato dal messaggio: «chi ha
  // caricato quel file» è una domanda che si pone da sola, e cercarla fra i
  // messaggi ordinari sarebbe impraticabile.
  if (message.attachments.size > 0) {
    await recordEvent(client, {
      guildId: message.guild.id,
      type: 'ATTACHMENT_POSTED',
      actorId: message.author.id,
      actorTag: message.author.tag,
      channelId: message.channelId,
      messageId: message.id,
      summary: message.attachments
        .map(
          (attachment) =>
            `📎 ${attachment.name} · ${Math.round(attachment.size / 1024)} KB` +
            (attachment.contentType ? ` · ${attachment.contentType}` : ''),
        )
        .join('\n')
        .slice(0, 1000),
      payload: {
        attachments: message.attachments.map((attachment) => ({
          name: attachment.name,
          size: attachment.size,
          contentType: attachment.contentType,
          width: attachment.width,
          height: attachment.height,
        })),
      },
    });
  }

  const activity = await trackActivity(message);

  const [spam, content, invites, safety] = await Promise.all([
    evaluateSpam(message, config).catch(() => null),
    evaluateContent(client, message, config).catch((error) => {
      log.debug({ err: error }, 'scanner contenuti fallito');
      return null;
    }),
    evaluateInvites(client, message, config).catch(() => null),
    evaluateSafety(client, message, config).catch(() => null),
  ]);

  // Il rilevatore di account compromessi ha bisogno dell'esito dello scanner:
  // "immagine con link" e "contiene un QR" sono suoi segnali d'ingresso.
  const compromise = await evaluateCompromise(client, message, config, {
    hasUrl: hasFinding(content, (code) => code.startsWith('URL_')) || /https?:\/\//i.test(message.content ?? ''),
    hasImage: message.attachments.some((attachment) =>
      attachment.contentType?.startsWith('image/'),
    ),
    hasQrCode: hasFinding(content, (code) => code.startsWith('QR_')),
    crossChannelCount: activity.crossChannelCount,
  }).catch(() => null);

  const decisions = [spam, content, invites, safety, compromise].filter(
    (decision): decision is Decision => decision !== null && decision.triggered,
  );
  if (decisions.length === 0) {
    await logPlainMessage(client, message, config);
    return;
  }

  const merged = mergeDecisions(decisions);
  await applyDecision(
    {
      client,
      guild: message.guild,
      config,
      member: message.member,
      message,
      module: merged.module,
    },
    merged,
  );
}

function hasFinding(decision: Decision | null, predicate: (code: string) => boolean): boolean {
  if (!decision) return false;
  return decision.reasons.some((reason) => predicate(reason.code));
}

/**
 * Registro dei messaggi ordinari.
 *
 * Volutamente non attivo per impostazione predefinita: registrare ogni
 * messaggio in un canale Discord lo rende illeggibile, e il pannello legge già
 * tutto da Postgres. Chi lo vuole lo attiva dalla configurazione delle rotte.
 */
async function logPlainMessage(
  client: Client,
  message: Message,
  config: Awaited<ReturnType<typeof getGuildConfig>>,
): Promise<void> {
  const route = config.logging.routes.MESSAGE;
  if (!route?.enabled || !route.channelId) return;
  if (route.excludeTypes.includes('MESSAGE_CREATED')) return;

  await recordEvent(client, {
    guildId: message.guild!.id,
    type: 'MESSAGE_CREATED',
    actorId: message.author.id,
    actorTag: message.author.tag,
    channelId: message.channelId,
    messageId: message.id,
    summary: config.logging.showContentInChannel ? codeBlock(message.content ?? '') : undefined,
    payload: {
      attachments: message.attachments.size,
      length: message.content?.length ?? 0,
    },
  });
}

async function handleMessageUpdate(
  client: Client,
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
): Promise<void> {
  if (!newMessage.guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return; // embed caricato, non una modifica

  const config = await getGuildConfig(newMessage.guild.id);
  const full = newMessage.partial ? await newMessage.fetch().catch(() => null) : (newMessage as Message);
  if (!full) return;

  await recordEvent(client, {
    guildId: newMessage.guild.id,
    type: 'MESSAGE_EDITED',
    actorId: full.author.id,
    actorTag: full.author.tag,
    channelId: full.channelId,
    messageId: full.id,
    fields: config.logging.showContentInChannel
      ? [
          { name: 'Prima', value: codeBlock(oldMessage.content ?? '(non in cache)') },
          { name: 'Dopo', value: codeBlock(full.content ?? '') },
        ]
      : undefined,
    payload: { before: oldMessage.content?.slice(0, 2000), after: full.content?.slice(0, 2000) },
  });

  const prisma = getPrisma();
  await prisma.messageArchive
    .updateMany({
      where: { id: full.id },
      data: {
        content: config.logging.messageContent === 'FULL' ? full.content : null,
        fingerprint: full.content ? contentFingerprint(full.content) : null,
        editedAt: new Date(),
      },
    })
    .catch(() => undefined);

  // Una modifica può trasformare un messaggio innocuo in phishing: è una
  // tecnica nota per aggirare i filtri che guardano solo alla pubblicazione.
  const decision = await evaluateContent(client, full, config).catch(() => null);
  if (decision?.triggered) {
    await applyDecision(
      {
        client,
        guild: full.guild!,
        config,
        member: full.member,
        message: full,
        module: 'scanner (modifica)',
      },
      decision,
    );
  }
}

async function handleMessageDelete(
  client: Client,
  message: Message | PartialMessage,
): Promise<void> {
  if (!message.guild) return;
  const config = await getGuildConfig(message.guild.id);

  const archived = await markDeleted(message.id, null);

  await recordEvent(client, {
    guildId: message.guild.id,
    type: 'MESSAGE_DELETED',
    actorId: message.author?.id ?? archived?.authorId ?? null,
    actorTag: message.author?.tag ?? archived?.authorTag ?? null,
    channelId: message.channelId,
    messageId: message.id,
    fields:
      config.logging.showContentInChannel
        ? [
            {
              name: 'Contenuto',
              value: codeBlock(message.content ?? archived?.content ?? '(non disponibile)'),
            },
          ]
        : undefined,
    payload: {
      hadAttachments: (message.attachments?.size ?? 0) > 0,
      recovered: Boolean(archived?.content),
    },
  });
}

async function handleBulkDelete(
  client: Client,
  messages: ReadonlyMap<string, Message | PartialMessage>,
): Promise<void> {
  const first = messages.values().next().value;
  if (!first?.guild) return;

  const prisma = getPrisma();
  await prisma.messageArchive
    .updateMany({ where: { id: { in: [...messages.keys()] } }, data: { deletedAt: new Date() } })
    .catch(() => undefined);

  await recordEvent(client, {
    guildId: first.guild.id,
    type: 'MESSAGE_BULK_DELETED',
    channelId: first.channelId,
    severity: 40,
    summary:
      `🧹 ${messages.size} messaggi eliminati in blocco in <#${first.channelId}>.\n` +
      'I contenuti restano consultabili nel pannello, nella cronologia del canale.',
    payload: { count: messages.size, messageIds: [...messages.keys()].slice(0, 100) },
  });
}
