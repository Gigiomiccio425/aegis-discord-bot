import type { Job } from 'bullmq';
import { getPrisma } from '@aegis/db';
import { GuildConfigSchema, RedisKeys } from '@aegis/shared';
import { getRedis } from '../redis.js';
import { childLogger } from '../logger.js';

const log = childLogger('securityAudit');

/**
 * Revisione periodica di webhook e bot.
 *
 * Prima esisteva solo `/audit` a mano, mentre la configurazione prometteva
 * «ogni 6 ore»: un webhook ostile creato di notte restava fino a quando
 * qualcuno si fosse ricordato di lanciare il comando. Un'opzione che dichiara
 * una frequenza e non la rispetta è peggio di un'opzione assente, perché chi la
 * imposta smette di preoccuparsene.
 *
 * L'intervallo è per server: si tiene traccia dell'ultimo controllo su Redis e
 * si richiede il successivo solo quando è davvero scaduto.
 */
export async function securityAuditProcessor(_job: Job): Promise<void> {
  const prisma = getPrisma();
  const redis = getRedis();

  const guilds = await prisma.guild.findMany({
    where: { active: true },
    select: { id: true, config: true },
  });

  let requested = 0;

  for (const guild of guilds) {
    const parsed = GuildConfigSchema.safeParse(guild.config);
    if (!parsed.success) continue;
    const config = parsed.data;

    // Si prende l'intervallo più stretto fra i due moduli attivi: se il
    // controllo dei webhook vuole 6 ore e quello dei bot 12, si gira ogni 6 e
    // li si esegue entrambi. Due job separati raddoppierebbero le chiamate API
    // senza guadagno.
    const intervals: number[] = [];
    if (config.security.webhookGuard.enabled && config.security.webhookGuard.auditIntervalHours > 0) {
      intervals.push(config.security.webhookGuard.auditIntervalHours);
    }
    if (config.security.botGuard.enabled && config.security.botGuard.auditIntervalHours > 0) {
      intervals.push(config.security.botGuard.auditIntervalHours);
    }
    if (intervals.length === 0) continue;

    const hours = Math.min(...intervals);
    const key = `audit:last:${guild.id}`;

    // NX con scadenza: la chiave esiste finché l'intervallo non è trascorso.
    // È un lucchetto e un promemoria insieme, senza righe aggiuntive nel database.
    const claimed = await redis.set(key, Date.now().toString(), 'EX', hours * 3600, 'NX');
    if (claimed === null) continue;

    await redis.publish(
      RedisKeys.commandChannel,
      JSON.stringify({ action: 'security.audit', guildId: guild.id }),
    );
    requested++;
  }

  if (requested > 0) {
    log.info({ guilds: requested }, 'revisioni di sicurezza richieste');
  }
}
