import type { Client, Guild, GuildMember } from 'discord.js';
import { getPrisma } from '@aegis/db';
import { nameSimilarity, RedisKeys, type GuildConfig } from '@aegis/shared';
import { getRedis, slidingWindowCount, slidingWindowMembers } from '../core/redis.js';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';
import { enableLockdown, quarantineMember } from '../core/enforcer.js';

const log = childLogger('antiRaid');

/* ═══════════════════════════════════════════════════════════════════════
   ANTI-RAID

   Due rilevatori che lavorano insieme.

   Il primo conta i join su finestra scorrevole: è il caso rumoroso, decine di
   account in pochi secondi. Il secondo confronta gli account entrati di
   recente fra loro — età, avatar, somiglianza dei nomi — e riconosce il raid
   lento, quello che entra a cinque alla volta per non far scattare le soglie.

   Il tempo conta: i primi trenta secondi decidono se l'attacco viene fermato o
   se si trasforma in una pulizia di ore. Per questo la risposta è automatica e
   graduata, non un semplice avviso allo staff.
   ═══════════════════════════════════════════════════════════════════════ */

export interface JoinRecord {
  userId: string;
  username: string;
  accountAgeHours: number;
  hasAvatar: boolean;
  joinedAt: number;
}

export interface ClusterSettings {
  newAccountHours: number;
  nameSimilarity: number;
  minClusterSize: number;
  windowSec: number;
}

/**
 * Riconoscimento del gruppo, isolato dal resto.
 *
 * È una funzione pura, senza Redis né Discord, per una ragione precisa: è la
 * logica che decide se mettere in quarantena decine di persone in una volta.
 * Una decisione del genere deve poter essere collaudata con casi noti, non
 * osservata dal vivo durante un attacco.
 *
 * Il criterio: un nome molto simile a un altro basta da solo — le reti di
 * self-bot generano `raider_01`, `raider_02` e simili. Gli indizi deboli
 * (account appena creato, nessun avatar) contano solo insieme, perché presi
 * singolarmente descrivono anche un utente nuovo del tutto legittimo.
 */
export function clusterMembers(
  recent: JoinRecord[],
  candidate: JoinRecord,
  settings: ClusterSettings,
  now = Date.now(),
): JoinRecord[] {
  const cutoff = now - settings.windowSec * 1000;

  return recent.filter((record) => {
    if (record.joinedAt < cutoff) return false;
    const similar =
      nameSimilarity(record.username, candidate.username) >= settings.nameSimilarity;
    const weakSignals = record.accountAgeHours <= settings.newAccountHours && !record.hasAvatar;
    return similar || weakSignals;
  });
}

const JOIN_DETAILS_TTL = 3600;

/** Chiamata a ogni ingresso. Restituisce true se ha rilevato un raid. */
export async function trackJoin(
  client: Client,
  member: GuildMember,
  config: GuildConfig,
): Promise<boolean> {
  const settings = config.security.antiRaid;
  if (!settings.enabled) return false;

  const guildId = member.guild.id;
  const redis = getRedis();
  const now = Date.now();

  const record: JoinRecord = {
    userId: member.id,
    username: member.user.username,
    accountAgeHours: (now - member.user.createdTimestamp) / 3_600_000,
    hasAvatar: member.user.avatar !== null,
    joinedAt: now,
  };

  // I dettagli servono al rilevatore di cluster; il conteggio alla soglia.
  const detailsKey = `raid:details:${guildId}`;
  await redis.hset(detailsKey, member.id, JSON.stringify(record));
  await redis.expire(detailsKey, JOIN_DETAILS_TTL);

  const burstCount = await slidingWindowCount(
    RedisKeys.joinWindow(guildId),
    settings.joinBurst.windowSec * 1000,
    member.id,
  );

  if (burstCount >= settings.joinBurst.count) {
    const participants = await slidingWindowMembers(
      RedisKeys.joinWindow(guildId),
      settings.joinBurst.windowSec * 1000,
    );
    await triggerRaid(client, member.guild, config, {
      reason: `${burstCount} ingressi in ${settings.joinBurst.windowSec} secondi`,
      userIds: participants,
      rate: burstCount,
    });
    return true;
  }

  if (settings.clustering.enabled) {
    const cluster = await detectCluster(guildId, record, settings.clustering);
    if (cluster.length >= settings.clustering.minClusterSize) {
      await triggerRaid(client, member.guild, config, {
        reason:
          `${cluster.length} account con caratteristiche simili entrati negli ultimi ` +
          `${Math.round(settings.clustering.windowSec / 60)} minuti ` +
          '(nomi affini, account recenti, profili vuoti)',
        userIds: cluster,
        rate: cluster.length,
      });
      return true;
    }
  }

  return false;
}

/**
 * Cerca account simili fra quelli entrati di recente.
 *
 * Il confronto usa la similarità Jaro-Winkler sui nomi normalizzati, così
 * `raider_01`, `raider_02` e `raid3r_03` finiscono nello stesso gruppo anche se
 * nessuna coppia è identica.
 */
async function detectCluster(
  guildId: string,
  candidate: JoinRecord,
  settings: GuildConfig['security']['antiRaid']['clustering'],
): Promise<string[]> {
  const redis = getRedis();
  const raw = await redis.hgetall(`raid:details:${guildId}`);
  const cutoff = Date.now() - settings.windowSec * 1000;

  const recent: JoinRecord[] = [];
  for (const value of Object.values(raw) as string[]) {
    try {
      const record = JSON.parse(value) as JoinRecord;
      if (record.joinedAt >= cutoff) recent.push(record);
    } catch {
      /* voce corrotta: ignorata */
    }
  }

  return clusterMembers(recent, candidate, settings).map((record) => record.userId);
}

async function triggerRaid(
  client: Client,
  guild: Guild,
  config: GuildConfig,
  info: { reason: string; userIds: string[]; rate: number },
): Promise<void> {
  const redis = getRedis();
  const stateKey = RedisKeys.raidState(guild.id);

  // Un raid già in corso non deve riaprire un incidente a ogni nuovo ingresso.
  const alreadyActive = await redis.set(stateKey, '1', 'EX', 900, 'NX');
  if (alreadyActive === null) {
    await handleRaiders(client, guild, config, info.userIds);
    return;
  }

  log.warn({ guildId: guild.id, reason: info.reason, count: info.userIds.length }, 'raid rilevato');

  const prisma = getPrisma();
  const incident = await prisma.incident.create({
    data: {
      guildId: guild.id,
      kind: 'RAID',
      affectedUserIds: info.userIds,
      peakRate: info.rate,
      summary: info.reason,
    },
  });

  await recordEvent(client, {
    guildId: guild.id,
    type: 'SECURITY_RAID_DETECTED',
    actorId: client.user?.id,
    severity: 100,
    automated: true,
    summary:
      `🚨 **Raid rilevato**\n${info.reason}\n` +
      `Account coinvolti: ${info.userIds.length}\n` +
      `Livello di risposta: **${config.security.antiRaid.responseLevel}**`,
    payload: { incidentId: incident.id, userIds: info.userIds.slice(0, 100) },
  });

  switch (config.security.antiRaid.responseLevel) {
    case 'LOCKDOWN':
      await enableLockdown(
        client,
        guild,
        config,
        `Raid: ${info.reason}`,
        config.security.antiRaid.autoLiftAfterSec,
      );
      await handleRaiders(client, guild, config, info.userIds);
      break;
    case 'QUARANTINE':
      await handleRaiders(client, guild, config, info.userIds);
      break;
    case 'VERIFY':
      await applyVerificationGate(guild, config, info.userIds);
      break;
    case 'MONITOR':
      break;
  }

  if (config.security.antiRaid.autoLiftAfterSec > 0) {
    setTimeout(() => {
      void endRaid(client, guild, incident.id);
    }, config.security.antiRaid.autoLiftAfterSec * 1000);
  }
}

/**
 * Applica l'azione configurata ai partecipanti.
 *
 * Con l'azione BAN si usa l'endpoint bulk (fino a 200 utenti per chiamata):
 * duecento ban singoli finirebbero contro il rate limit proprio nel momento in
 * cui la velocità è tutto.
 */
async function handleRaiders(
  client: Client,
  guild: Guild,
  config: GuildConfig,
  userIds: string[],
): Promise<void> {
  const settings = config.security.antiRaid;
  if (config.general.dryRun) return;

  if (settings.raiderAction === 'BAN' && settings.useBulkBan) {
    for (let i = 0; i < userIds.length; i += 200) {
      const batch = userIds.slice(i, i + 200);
      await guild.bans
        .bulkCreate(batch, {
          reason: 'Anti-raid: ingresso coordinato',
          deleteMessageSeconds: settings.banDeleteMessageDays * 86400,
        })
        .catch((error) => log.warn({ err: error }, 'bulk ban fallito'));
    }
    return;
  }

  for (const userId of userIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;

    switch (settings.raiderAction) {
      case 'QUARANTINE':
        await quarantineMember(
          { client, guild, config, member, module: 'antiRaid' },
          'Anti-raid: ingresso coordinato',
        ).catch(() => undefined);
        break;
      case 'KICK':
        await member.kick('Anti-raid: ingresso coordinato').catch(() => undefined);
        break;
      case 'BAN':
        await guild.bans
          .create(userId, { reason: 'Anti-raid: ingresso coordinato' })
          .catch(() => undefined);
        break;
      default:
        break;
    }
  }
}

async function applyVerificationGate(
  guild: Guild,
  config: GuildConfig,
  userIds: string[],
): Promise<void> {
  const roleId =
    config.security.verification.quarantineRoleId ?? config.general.quarantineRoleId;
  if (!roleId) return;

  for (const userId of userIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    await member?.roles.add(roleId, 'Anti-raid: verifica richiesta').catch(() => undefined);
  }
}

export async function endRaid(client: Client, guild: Guild, incidentId?: string): Promise<void> {
  const redis = getRedis();
  const stateKey = RedisKeys.raidState(guild.id);
  if (!(await redis.exists(stateKey))) return;

  await redis.del(stateKey);
  await redis.del(RedisKeys.joinWindow(guild.id));

  if (incidentId) {
    const prisma = getPrisma();
    await prisma.incident
      .update({ where: { id: incidentId }, data: { endedAt: new Date() } })
      .catch(() => undefined);
  }

  await recordEvent(client, {
    guildId: guild.id,
    type: 'SECURITY_RAID_ENDED',
    actorId: client.user?.id,
    summary:
      'Raid concluso. Gli account messi in quarantena sono elencati nell\'incidente: ' +
      'dal pannello si possono riabilitare in blocco se fra loro ci sono utenti legittimi.',
  });
}

export async function isRaidActive(guildId: string): Promise<boolean> {
  return (await getRedis().exists(RedisKeys.raidState(guildId))) === 1;
}
