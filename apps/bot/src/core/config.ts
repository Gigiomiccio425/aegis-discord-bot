import { getPrisma } from '@aegis/db';
import {
  defaultGuildConfig,
  GuildConfigSchema,
  RedisKeys,
  type GuildConfig,
} from '@aegis/shared';
import { getRedis, getSubscriber } from './redis.js';
import { childLogger } from './logger.js';

const log = childLogger('config');

/**
 * Configurazione dei server, con tre livelli di lettura.
 *
 *   memoria → Redis → Postgres
 *
 * Il livello in memoria esiste perché la config viene letta a *ogni messaggio*:
 * un giro su Redis per messaggio, moltiplicato per un server attivo, sarebbe
 * spreco puro. L'invalidazione arriva via pub/sub, quindi una modifica dal
 * pannello ha effetto immediato senza riavviare nulla.
 */
const memory = new Map<string, { config: GuildConfig; expiresAt: number }>();
const MEMORY_TTL_MS = 30_000;
const REDIS_TTL_SEC = 600;

export async function getGuildConfig(guildId: string): Promise<GuildConfig> {
  const cached = memory.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  const redis = getRedis();
  const raw = await redis.get(RedisKeys.guildConfig(guildId)).catch(() => null);
  if (raw) {
    try {
      const parsed = GuildConfigSchema.parse(JSON.parse(raw));
      memory.set(guildId, { config: parsed, expiresAt: Date.now() + MEMORY_TTL_MS });
      return parsed;
    } catch {
      // Cache corrotta o schema cambiato: si riparte dal database.
      await redis.del(RedisKeys.guildConfig(guildId)).catch(() => undefined);
    }
  }

  const config = await loadFromDatabase(guildId);
  memory.set(guildId, { config, expiresAt: Date.now() + MEMORY_TTL_MS });
  await redis
    .set(RedisKeys.guildConfig(guildId), JSON.stringify(config), 'EX', REDIS_TTL_SEC)
    .catch(() => undefined);
  return config;
}

async function loadFromDatabase(guildId: string): Promise<GuildConfig> {
  const prisma = getPrisma();
  const guild = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild) return defaultGuildConfig();

  const parsed = GuildConfigSchema.safeParse(guild.config);
  if (parsed.success) return parsed.data;

  // Una configurazione non valida non deve spegnere le difese: si torna ai
  // default e si segnala, invece di lanciare un'eccezione a ogni messaggio.
  log.error(
    { guildId, issues: parsed.error.issues.slice(0, 5) },
    'configurazione non valida nel database, uso i valori predefiniti',
  );
  return defaultGuildConfig();
}

/** Salva la configurazione e ne annuncia l'invalidazione a tutti i processi. */
export async function saveGuildConfig(
  guildId: string,
  config: GuildConfig,
  actor: { id: string; source: 'panel' | 'command' | 'system'; paths?: string[] },
): Promise<void> {
  const prisma = getPrisma();
  const previous = await prisma.guild.findUnique({ where: { id: guildId } });

  await prisma.guild.update({
    where: { id: guildId },
    data: { config, configVersion: config.version },
  });

  await prisma.configHistory.create({
    data: {
      guildId,
      actorId: actor.id,
      source: actor.source,
      paths: actor.paths ?? [],
      before: (previous?.config ?? {}) as object,
      after: config as unknown as object,
    },
  });

  await invalidateGuildConfig(guildId);
}

export async function invalidateGuildConfig(guildId: string): Promise<void> {
  memory.delete(guildId);
  const redis = getRedis();
  await redis.del(RedisKeys.guildConfig(guildId)).catch(() => undefined);
  await redis.publish(RedisKeys.configChannel, guildId).catch(() => undefined);
}

/** Resta in ascolto delle invalidazioni pubblicate dagli altri processi. */
export function subscribeConfigInvalidation(): void {
  const sub = getSubscriber();
  void sub.subscribe(RedisKeys.configChannel).catch((error: unknown) => {
    log.error({ err: error }, 'impossibile sottoscrivere il canale di configurazione');
  });
  sub.on('message', (channel: string, message: string) => {
    if (channel !== RedisKeys.configChannel) return;
    memory.delete(message);
    log.debug({ guildId: message }, 'configurazione invalidata');
  });
}

/** Registra un server appena aggiunto, o lo riattiva se il bot era stato rimosso. */
export async function ensureGuild(guild: {
  id: string;
  name: string;
  iconHash?: string | null;
  ownerId?: string | null;
  memberCount?: number;
}): Promise<void> {
  const prisma = getPrisma();
  await prisma.guild.upsert({
    where: { id: guild.id },
    create: {
      id: guild.id,
      name: guild.name,
      iconHash: guild.iconHash ?? null,
      ownerId: guild.ownerId ?? null,
      memberCount: guild.memberCount ?? 0,
      config: defaultGuildConfig() as unknown as object,
      active: true,
    },
    update: {
      name: guild.name,
      iconHash: guild.iconHash ?? null,
      ownerId: guild.ownerId ?? null,
      memberCount: guild.memberCount ?? 0,
      active: true,
    },
  });
}
