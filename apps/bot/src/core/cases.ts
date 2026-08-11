import { getPrisma, type CaseType } from '@angel/db';
import { getRedis } from './redis.js';

/**
 * Numerazione progressiva dei casi, per server.
 *
 * Il contatore vive in Redis perché più processi (bot e pannello) possono
 * aprire casi contemporaneamente: un `count()` sul database seguito da un
 * `create()` produrrebbe numeri duplicati proprio durante un raid, quando i
 * casi si aprono a raffica. Al primo uso il contatore si allinea al massimo
 * già presente nel database.
 */
async function nextCaseNumber(guildId: string): Promise<number> {
  const redis = getRedis();
  const key = `case:seq:${guildId}`;

  const exists = await redis.exists(key);
  if (!exists) {
    const prisma = getPrisma();
    const last = await prisma.case.findFirst({
      where: { guildId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    // NX: se un altro processo ha già seminato il contatore, non lo si sovrascrive.
    await redis.set(key, String(last?.number ?? 0), 'NX');
  }

  return redis.incr(key);
}

export interface CreateCaseInput {
  guildId: string;
  type: CaseType;
  targetId: string;
  targetTag?: string | null;
  actorId: string;
  actorTag?: string | null;
  reason: string;
  automated?: boolean;
  module?: string;
  evidence?: Record<string, unknown>;
  expiresAt?: Date | null;
}

export async function createCase(input: CreateCaseInput) {
  const prisma = getPrisma();
  const number = await nextCaseNumber(input.guildId);

  const record = await prisma.case.create({
    data: {
      guildId: input.guildId,
      number,
      type: input.type,
      targetId: input.targetId,
      targetTag: input.targetTag ?? null,
      actorId: input.actorId,
      actorTag: input.actorTag ?? null,
      reason: input.reason,
      automated: input.automated ?? false,
      module: input.module ?? null,
      evidence: (input.evidence ?? {}) as object,
      expiresAt: input.expiresAt ?? null,
    },
  });

  await prisma.userProfile.upsert({
    where: { guildId_userId: { guildId: input.guildId, userId: input.targetId } },
    create: {
      guildId: input.guildId,
      userId: input.targetId,
      caseCount: 1,
      warnCount: input.type === 'WARN' ? 1 : 0,
    },
    update: {
      caseCount: { increment: 1 },
      ...(input.type === 'WARN' ? { warnCount: { increment: 1 } } : {}),
    },
  });

  return record;
}

/** Casi a termine scaduti: il chiamante (worker) revoca la sanzione. */
export async function expiredCases(limit = 100) {
  const prisma = getPrisma();
  return prisma.case.findMany({
    where: { status: 'ACTIVE', expiresAt: { not: null, lte: new Date() } },
    take: limit,
  });
}

export async function markCaseExpired(caseId: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.case.update({ where: { id: caseId }, data: { status: 'EXPIRED' } });
}

export async function revokeCase(caseId: string, actorId: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.case.update({
    where: { id: caseId },
    data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: actorId },
  });
}
