import type { Client, Guild, GuildMember, User } from 'discord.js';
import { getPrisma } from '@angel/db';
import { computePhash, phashDistance } from '@angel/scanner';
import {
  decide,
  generatedNameScore,
  hasHomoglyphs,
  nameSimilarity,
  noDecision,
  type Decision,
  type GuildConfig,
  type Reason,
} from '@angel/shared';
import { isExempt } from '../core/permissions.js';
import { recordEvent } from '../logging/auditLogger.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('accountGuard');

/* ═══════════════════════════════════════════════════════════════════════
   CONTROLLO ACCOUNT

   Profilazione di chi entra. Nessun segnale, da solo, è una prova: esistono
   persone reali senza avatar e con l'account creato ieri. È la combinazione a
   contare, e il risultato è un punteggio — non una condanna.

   La parte più delicata è l'impersonificazione dello staff: un nome simile a
   quello di un moderatore, magari con una "i" cirillica al posto della latina,
   è la premessa di una truffa in DM che il bot non potrà vedere. Riconoscerlo
   all'ingresso è l'unico momento utile.
   ═══════════════════════════════════════════════════════════════════════ */

export interface AccountRisk {
  score: number;
  flags: string[];
  reasons: Reason[];
}

export async function assessAccount(
  member: GuildMember,
  config: GuildConfig,
): Promise<AccountRisk> {
  const settings = config.security.accountGuard;
  const weights = settings.weights;
  const reasons: Reason[] = [];
  const flags: string[] = [];

  const accountAgeHours = (Date.now() - member.user.createdTimestamp) / 3_600_000;

  if (accountAgeHours <= settings.newAccountHours) {
    flags.push('newAccount');
    reasons.push({
      code: 'ACC_NEW',
      detail: `Account creato ${Math.round(accountAgeHours)} ore fa`,
      score: weights.newAccount,
      meta: { accountAgeHours: Math.round(accountAgeHours) },
    });
  }

  if (!member.user.avatar) {
    flags.push('noAvatar');
    reasons.push({
      code: 'ACC_NO_AVATAR',
      detail: 'Nessuna immagine del profilo',
      score: weights.noAvatar,
    });
  }

  const nameScore = generatedNameScore(member.user.username);
  if (nameScore >= 0.5) {
    flags.push('generatedName');
    reasons.push({
      code: 'ACC_GENERATED_NAME',
      detail: `Username con pattern da generazione automatica (${member.user.username})`,
      score: Math.round(weights.generatedName * nameScore),
      meta: { nameScore },
    });
  }

  if (hasHomoglyphs(member.user.username) || hasHomoglyphs(member.displayName)) {
    flags.push('homoglyphName');
    reasons.push({
      code: 'ACC_HOMOGLYPH',
      detail:
        'Il nome contiene caratteri non latini che imitano lettere latine ' +
        '(tecnica usata per copiare i nomi dello staff)',
      score: weights.homoglyphName,
    });
  }

  // Il flag "Spammer" lo assegna Discord stessa: quando c'è, vale più di
  // qualunque euristica locale.
  if (member.user.flags?.has('Spammer')) {
    flags.push('discordSpammerFlag');
    reasons.push({
      code: 'ACC_DISCORD_SPAMMER',
      detail: 'Discord ha contrassegnato questo account come probabile spammer',
      score: weights.discordSpammerFlag,
    });
  }

  if (!member.user.avatar && !member.user.banner && accountAgeHours < 720) {
    flags.push('emptyProfile');
    reasons.push({
      code: 'ACC_EMPTY_PROFILE',
      detail: 'Profilo completamente vuoto',
      score: weights.emptyProfile,
    });
  }

  const impersonation = await detectStaffImpersonation(member, config);
  if (impersonation) {
    flags.push('staffImpersonation');
    reasons.push({
      code: 'ACC_STAFF_IMPERSONATION',
      detail: impersonation.detail,
      score: weights.staffImpersonation,
      meta: impersonation.meta,
    });
  }

  // Il confronto sull'immagine si fa solo se quello sul nome non ha già
  // deciso: scaricare un avatar costa una richiesta di rete, e ripeterla per
  // un caso già accertato non aggiunge nulla.
  if (config.scanner.image.compareAvatarsToStaff && !impersonation) {
    const avatarMatch = await detectAvatarImpersonation(member, config);
    if (avatarMatch) {
      flags.push('staffAvatarCopy');
      reasons.push({
        code: 'ACC_STAFF_AVATAR',
        detail: avatarMatch.detail,
        score: weights.staffImpersonation,
        meta: avatarMatch.meta,
      });
    }
  }

  const score = Math.min(
    100,
    reasons.reduce((total, reason) => total + reason.score, 0),
  );
  return { score, flags, reasons };
}

/**
 * Confronta nome e nickname con quelli dello staff reale.
 *
 * Il confronto avviene sui nomi normalizzati (omoglifi ricondotti al latino,
 * diacritici rimossi): altrimenti `Мoderatore` con la M cirillica risulterebbe
 * una stringa completamente diversa.
 */
async function detectStaffImpersonation(
  member: GuildMember,
  config: GuildConfig,
): Promise<{ detail: string; meta: Record<string, unknown> } | null> {
  const staffRoleIds = [
    ...config.security.accountGuard.staffRoleIds,
    ...config.general.staffRoleIds,
  ];
  if (staffRoleIds.length === 0) return null;
  if (member.roles.cache.some((role) => staffRoleIds.includes(role.id))) return null;

  const candidates = member.guild.members.cache.filter((other) =>
    other.roles.cache.some((role) => staffRoleIds.includes(role.id)),
  );

  const names = [member.user.username, member.displayName];
  for (const staff of candidates.values()) {
    for (const name of names) {
      const similarity = Math.max(
        nameSimilarity(name, staff.user.username),
        nameSimilarity(name, staff.displayName),
      );
      if (similarity >= 0.9 && name.toLowerCase() !== staff.user.username.toLowerCase()) {
        return {
          detail:
            `Il nome "${name}" è quasi identico a quello di un membro dello staff ` +
            `(${staff.displayName}), somiglianza ${Math.round(similarity * 100)}%`,
          meta: { similarity, staffId: staff.id, staffName: staff.displayName },
        };
      }
    }
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
   CONFRONTO DEGLI AVATAR

   Copiare il nome di un moderatore è facile da riconoscere; copiare la foto
   del profilo lo è molto meno, e per la vittima è il segnale più convincente
   dei due — un nome si legge distrattamente, un'immagine si riconosce a colpo
   d'occhio.

   Il confronto usa l'hash percettivo: resta stabile se l'immagine viene
   ricompressa o ridimensionata, che è esattamente ciò che accade quando
   qualcuno salva l'avatar altrui e lo ricarica.
   ═══════════════════════════════════════════════════════════════════════ */

const AVATAR_MAX_DISTANCE = 6;
const AVATAR_TIMEOUT_MS = 5000;

/** Scarica l'avatar e ne calcola l'hash percettivo. */
export async function avatarPhash(user: User): Promise<string | undefined> {
  const url = user.avatar
    ? user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true })
    : null;
  // Gli avatar predefiniti sono uguali per milioni di persone: confrontarli
  // produrrebbe solo falsi positivi a catena.
  if (!url) return undefined;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    return await computePhash(Buffer.from(await response.arrayBuffer()));
  } catch {
    return undefined;
  }
}

/**
 * Hash degli avatar dello staff, calcolati una volta e conservati nel profilo.
 *
 * Ricalcolarli a ogni ingresso significherebbe una decina di download per ogni
 * nuovo membro: si aggiornano solo quando l'avatar cambia davvero.
 */
async function staffAvatarHashes(
  guild: Guild,
  staffRoleIds: string[],
): Promise<{ userId: string; name: string; phash: string }[]> {
  if (staffRoleIds.length === 0) return [];

  const prisma = getPrisma();
  const staff = guild.members.cache.filter((member) =>
    member.roles.cache.some((role) => staffRoleIds.includes(role.id)),
  );

  const result: { userId: string; name: string; phash: string }[] = [];

  for (const member of staff.values()) {
    if (!member.user.avatar) continue;

    const profile = await prisma.userProfile
      .findUnique({ where: { guildId_userId: { guildId: guild.id, userId: member.id } } })
      .catch(() => null);

    if (profile?.avatarPhash && profile.avatarHash === member.user.avatar) {
      result.push({ userId: member.id, name: member.displayName, phash: profile.avatarPhash });
      continue;
    }

    const hash = await avatarPhash(member.user);
    if (!hash) continue;

    await prisma.userProfile
      .upsert({
        where: { guildId_userId: { guildId: guild.id, userId: member.id } },
        create: {
          guildId: guild.id,
          userId: member.id,
          username: member.user.username,
          displayName: member.displayName,
          avatarHash: member.user.avatar,
          avatarPhash: hash,
        },
        update: { avatarHash: member.user.avatar, avatarPhash: hash },
      })
      .catch(() => undefined);

    result.push({ userId: member.id, name: member.displayName, phash: hash });
  }

  return result;
}

async function detectAvatarImpersonation(
  member: GuildMember,
  config: GuildConfig,
): Promise<{ detail: string; meta: Record<string, unknown> } | null> {
  const staffRoleIds = [
    ...new Set([...config.security.accountGuard.staffRoleIds, ...config.general.staffRoleIds]),
  ];
  if (staffRoleIds.length === 0) return null;
  if (member.roles.cache.some((role) => staffRoleIds.includes(role.id))) return null;
  if (!member.user.avatar) return null;

  const hash = await avatarPhash(member.user);
  if (!hash) return null;

  const prisma = getPrisma();
  await prisma.userProfile
    .updateMany({
      where: { guildId: member.guild.id, userId: member.id },
      data: { avatarPhash: hash, avatarHash: member.user.avatar },
    })
    .catch(() => undefined);

  const staff = await staffAvatarHashes(member.guild, staffRoleIds);
  for (const entry of staff) {
    const distance = phashDistance(hash, entry.phash);
    if (distance <= AVATAR_MAX_DISTANCE) {
      return {
        detail:
          `L'immagine del profilo è praticamente identica a quella di un membro dello staff ` +
          `(${entry.name}), distanza ${distance}.`,
        meta: { distance, staffId: entry.userId, staffName: entry.name },
      };
    }
  }
  return null;
}

/**
 * Riprofilazione periodica dei membri già presenti.
 *
 * Serve perché il rischio non è una fotografia scattata all'ingresso: un
 * account entrato mesi fa può cambiare nome e avatar per somigliare a un
 * moderatore, e senza una nuova valutazione nessuno se ne accorgerebbe.
 *
 * Il lavoro è limitato per esecuzione: profilare migliaia di membri in un colpo
 * solo significherebbe altrettante richieste di rete.
 */
export async function rescanGuildAccounts(
  client: Client,
  guild: Guild,
  config: GuildConfig,
  limit = 300,
): Promise<{ scanned: number; flagged: number }> {
  const settings = config.security.accountGuard;
  if (!settings.enabled || settings.rescanIntervalHours === 0) {
    return { scanned: 0, flagged: 0 };
  }

  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - settings.rescanIntervalHours * 3_600_000);

  const stale = await prisma.userProfile.findMany({
    where: {
      guildId: guild.id,
      leftAt: null,
      OR: [{ riskUpdatedAt: null }, { riskUpdatedAt: { lt: cutoff } }],
    },
    orderBy: { riskScore: 'desc' },
    take: limit,
    select: { userId: true },
  });

  let scanned = 0;
  let flagged = 0;

  for (const entry of stale) {
    const member = await guild.members.fetch(entry.userId).catch(() => null);
    if (!member) {
      // Non è più nel server: si segna l'uscita invece di riprovare ogni volta.
      await prisma.userProfile
        .updateMany({
          where: { guildId: guild.id, userId: entry.userId },
          data: { leftAt: new Date(), riskUpdatedAt: new Date() },
        })
        .catch(() => undefined);
      continue;
    }

    const decision = await evaluateAccount(client, member, config).catch(() => null);
    scanned++;
    if (decision?.triggered && decision.score >= 60) flagged++;
  }

  if (scanned > 0) {
    log.info({ guildId: guild.id, scanned, flagged }, 'riprofilazione account completata');
  }
  return { scanned, flagged };
}

/** Valuta il membro e applica la scala di azioni configurata. */
export async function evaluateAccount(
  client: Client,
  member: GuildMember,
  config: GuildConfig,
): Promise<Decision> {
  const settings = config.security.accountGuard;
  if (!settings.enabled) return noDecision('accountGuard');
  if (isExempt(member, settings.exemptions)) return noDecision('accountGuard');

  const risk = await assessAccount(member, config);

  const prisma = getPrisma();
  await prisma.userProfile.upsert({
    where: { guildId_userId: { guildId: member.guild.id, userId: member.id } },
    create: {
      guildId: member.guild.id,
      userId: member.id,
      username: member.user.username,
      displayName: member.displayName,
      avatarHash: member.user.avatar,
      accountCreatedAt: new Date(member.user.createdTimestamp),
      joinedAt: member.joinedAt ?? new Date(),
      riskScore: risk.score,
      riskFlags: risk.flags,
      riskUpdatedAt: new Date(),
    },
    update: {
      username: member.user.username,
      displayName: member.displayName,
      avatarHash: member.user.avatar,
      joinedAt: member.joinedAt ?? new Date(),
      leftAt: null,
      joinCount: { increment: 1 },
      riskScore: risk.score,
      riskFlags: risk.flags,
      riskUpdatedAt: new Date(),
      lastSeenAt: new Date(),
    },
  });

  if (risk.reasons.length === 0) return noDecision('accountGuard');

  if (risk.flags.includes('staffImpersonation')) {
    await recordEvent(client, {
      guildId: member.guild.id,
      type: 'SECURITY_IMPERSONATION',
      targetId: member.id,
      targetTag: member.user.tag,
      severity: 85,
      automated: true,
      summary:
        `🎭 Possibile imitazione di un membro dello staff: <@${member.id}>\n` +
        risk.reasons.find((r) => r.code === 'ACC_STAFF_IMPERSONATION')?.detail,
      payload: { flags: risk.flags, score: risk.score },
    });
  }

  return decide('accountGuard', risk.reasons, settings.ladder, 'SECURITY_ACCOUNT_FLAGGED');
}
