import { Events, type Client, type VoiceState } from 'discord.js';
import { getPrisma } from '@aegis/db';
import { recordEvent } from '../logging/auditLogger.js';
import { humanDuration } from '../core/i18n.js';
import type { LogEventType } from '@aegis/shared';

/**
 * Attività vocale.
 *
 * `voiceStateUpdate` arriva per ogni minima variazione: entrata, uscita,
 * spostamento, microfono, cuffie, condivisione schermo, webcam. Vengono
 * distinte tutte, perché "chi era in vocale con chi e per quanto" è la domanda
 * che si pone dopo ogni contestazione fra utenti.
 *
 * Oltre ai singoli eventi si tiene la durata della sessione: entrata e uscita
 * separate non dicono quanto tempo una persona è rimasta.
 */
export function registerVoiceEvents(client: Client): void {
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    void handleVoice(client, oldState, newState).catch(() => undefined);
  });
}

async function handleVoice(
  client: Client,
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> {
  const guildId = newState.guild.id;
  const userId = newState.id;
  const member = newState.member ?? oldState.member;
  const prisma = getPrisma();

  const emit = (type: LogEventType, summary?: string, payload?: Record<string, unknown>) =>
    recordEvent(client, {
      guildId,
      type,
      actorId: userId,
      actorTag: member?.user.tag ?? null,
      channelId: newState.channelId ?? oldState.channelId,
      summary,
      payload,
    });

  /* ── Ingresso ───────────────────────────────────────────────────────── */
  if (!oldState.channelId && newState.channelId) {
    await prisma.voiceSession
      .create({
        data: {
          guildId,
          userId,
          channelId: newState.channelId,
          joinedAt: new Date(),
        },
      })
      .catch(() => undefined);
    await emit('VOICE_JOINED', `Entrato in <#${newState.channelId}>`);
    return;
  }

  /* ── Uscita ─────────────────────────────────────────────────────────── */
  if (oldState.channelId && !newState.channelId) {
    const session = await prisma.voiceSession
      .findFirst({
        where: { guildId, userId, leftAt: null },
        orderBy: { joinedAt: 'desc' },
      })
      .catch(() => null);

    let seconds = 0;
    if (session) {
      seconds = Math.round((Date.now() - session.joinedAt.getTime()) / 1000);
      await prisma.voiceSession
        .update({ where: { id: session.id }, data: { leftAt: new Date(), seconds } })
        .catch(() => undefined);
    }

    await emit(
      'VOICE_LEFT',
      `Uscito da <#${oldState.channelId}>` + (seconds ? ` dopo ${humanDuration(seconds)}` : ''),
      { seconds },
    );

    /**
     * Riepilogo della sessione.
     *
     * Entrata e uscita separate non rispondono alla domanda che si pone
     * davvero — «quanto è rimasto, e cosa ha fatto» — perché costringono a
     * incrociare due righe distanti ore. Il riepilogo la chiude in una.
     */
    if (session && seconds >= 5) {
      await emit(
        'VOICE_SESSION_SUMMARY',
        `Sessione in <#${session.channelId}> · durata **${humanDuration(seconds)}**` +
          (session.streamed ? ' · ha condiviso lo schermo' : '') +
          (session.video ? ' · webcam attiva' : ''),
        {
          seconds,
          channelId: session.channelId,
          streamed: session.streamed,
          video: session.video,
          joinedAt: session.joinedAt.toISOString(),
        },
      );
    }
    return;
  }

  /* ── Spostamento ────────────────────────────────────────────────────── */
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    await prisma.voiceSession
      .updateMany({
        where: { guildId, userId, leftAt: null },
        data: { channelId: newState.channelId },
      })
      .catch(() => undefined);
    await emit(
      'VOICE_MOVED',
      `Da <#${oldState.channelId}> a <#${newState.channelId}>`,
    );
  }

  /* ── Stato del microfono e dell'audio ───────────────────────────────── */
  if (oldState.selfMute !== newState.selfMute) {
    await emit(newState.selfMute ? 'VOICE_SELF_MUTED' : 'VOICE_SELF_UNMUTED');
  }
  if (oldState.selfDeaf !== newState.selfDeaf) {
    await emit(newState.selfDeaf ? 'VOICE_SELF_DEAFENED' : 'VOICE_SELF_UNDEAFENED');
  }
  // Mute e deafen imposti dal server sono azioni di moderazione, non scelte
  // dell'utente: vanno distinti nel registro.
  if (oldState.serverMute !== newState.serverMute) {
    await emit(newState.serverMute ? 'VOICE_SERVER_MUTED' : 'VOICE_SERVER_UNMUTED');
  }
  if (oldState.serverDeaf !== newState.serverDeaf) {
    await emit(newState.serverDeaf ? 'VOICE_SERVER_DEAFENED' : 'VOICE_SERVER_UNDEAFENED');
  }

  /* ── Condivisione schermo e webcam ──────────────────────────────────── */
  if (oldState.streaming !== newState.streaming) {
    if (newState.streaming) {
      await prisma.voiceSession
        .updateMany({ where: { guildId, userId, leftAt: null }, data: { streamed: true } })
        .catch(() => undefined);
    }
    await emit(newState.streaming ? 'VOICE_STREAM_STARTED' : 'VOICE_STREAM_STOPPED');
  }
  if (oldState.selfVideo !== newState.selfVideo) {
    if (newState.selfVideo) {
      await prisma.voiceSession
        .updateMany({ where: { guildId, userId, leftAt: null }, data: { video: true } })
        .catch(() => undefined);
    }
    await emit(newState.selfVideo ? 'VOICE_VIDEO_STARTED' : 'VOICE_VIDEO_STOPPED');
  }
}
