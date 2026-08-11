/* ═══════════════════════════════════════════════════════════════════════
   IDENTITÀ DEL BOT

   Applica nome, immagine, soprannome, stato e attività.

   Due limiti di Discord governano tutto ciò che segue.

   Il primo: **nome e avatar sono globali**. Non esiste un nome per server, e
   cambiarli da un server li cambia ovunque. Il soprannome invece è locale, ed
   è il solo modo di farsi chiamare diversamente altrove.

   Il secondo: **due cambi di nome all'ora**. Superato il limite Discord
   risponde con un errore che non nomina la causa. Per questo il nome si
   applica solo quando è davvero diverso da quello attuale — un riavvio non
   deve consumare il credito, e con quattro riavvii ravvicinati il bot
   resterebbe senza per un'ora.
   ═══════════════════════════════════════════════════════════════════════ */

import { ActivityType, type Client, type Guild } from 'discord.js';
import type { GuildConfig } from '@angel/shared';
import { childLogger } from './logger.js';

const log = childLogger('identita');

const TIPO_ATTIVITA = {
  CUSTOM: ActivityType.Custom,
  PLAYING: ActivityType.Playing,
  WATCHING: ActivityType.Watching,
  LISTENING: ActivityType.Listening,
  COMPETING: ActivityType.Competing,
} as const;

/**
 * Applica stato e attività.
 *
 * È l'unica parte senza limiti di frequenza, quindi si può richiamare a ogni
 * modifica della configurazione senza precauzioni.
 */
export function applyPresence(client: Client<true>, config: GuildConfig, guild?: Guild): void {
  const identity = config.general.identity;
  const testo = identity.activityText
    .replace(/\{server\}/g, guild?.name ?? client.guilds.cache.first()?.name ?? 'questo server')
    .replace(/\{membri\}/g, String(guild?.memberCount ?? ''))
    .slice(0, 128);

  client.user.setPresence({
    status: identity.status,
    activities: testo ? [{ name: testo, type: TIPO_ATTIVITA[identity.activityType] }] : [],
  });
}

/**
 * Applica nome e immagini globali.
 *
 * Ogni fallimento è registrato e ignorato: un avatar irraggiungibile o un
 * limite di frequenza raggiunto non sono motivi per non avviare il bot, e
 * ritentare in un ciclo peggiorerebbe soltanto il secondo caso.
 */
export async function applyGlobalIdentity(
  client: Client<true>,
  config: GuildConfig,
): Promise<void> {
  const identity = config.general.identity;

  if (identity.username && identity.username !== client.user.username) {
    await client.user
      .setUsername(identity.username)
      .then(() => log.info({ nome: identity.username }, 'nome del bot aggiornato'))
      .catch((error: unknown) =>
        log.warn(
          { err: error },
          'nome non aggiornato: Discord consente due cambi all\'ora per le applicazioni',
        ),
      );
  }

  if (identity.avatarUrl) {
    await client.user
      .setAvatar(identity.avatarUrl)
      .then(() => log.info('immagine del bot aggiornata'))
      .catch((error: unknown) => log.warn({ err: error }, 'immagine non aggiornata'));
  }

  if (identity.bannerUrl) {
    await client.user
      .setBanner(identity.bannerUrl)
      .then(() => log.info('banner del bot aggiornato'))
      .catch((error: unknown) =>
        log.warn(
          { err: error },
          'banner non aggiornato: richiede che l\'applicazione lo supporti',
        ),
      );
  }
}

/** Soprannome nel singolo server: l'unica parte dell'identità che è locale. */
export async function applyNickname(guild: Guild, config: GuildConfig): Promise<void> {
  const desiderato = config.general.identity.nickname;
  const me = await guild.members.fetchMe().catch(() => null);
  if (!me) return;

  const attuale = me.nickname ?? '';
  if (desiderato === attuale) return;

  await me
    .setNickname(desiderato || null, 'Identità configurata di ANGEL')
    .catch((error: unknown) =>
      log.debug({ err: error, guildId: guild.id }, 'soprannome non applicato'),
    );
}
