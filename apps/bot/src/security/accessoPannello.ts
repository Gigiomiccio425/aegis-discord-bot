import {
  Events,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type PartialGuildMember,
  type Role,
} from 'discord.js';
import { getPrisma } from '@angel/db';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';

const log = childLogger('accessoPannello');

/* ═══════════════════════════════════════════════════════════════════════
   L'ACCESSO AL PANNELLO SEGUE I PERMESSI SU DISCORD

   Al primo accesso, chi ha «Gestisci server» riceve il ruolo ADMIN nel
   pannello. Il pannello però non lo toglieva mai: un moderatore retrocesso,
   o uscito dal server, restava ADMIN — poteva bloccare il server, cambiare
   la configurazione, leggere l'archivio dei messaggi — finché qualcuno non
   se ne accorgeva e lo toglieva a mano dalla pagina degli accessi.

   Qui la concessione automatica si revoca appena il permesso sparisce: la
   persona esce, perde il ruolo, o il ruolo perde il permesso. Solo quella
   automatica (`grantedBy: 'system'`): un accesso dato a mano da un
   proprietario è una scelta esplicita, e resta.
   ═══════════════════════════════════════════════════════════════════════ */

function puoGestire(member: GuildMember): boolean {
  // `has` conta anche Administrator e il proprietario del server.
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

export async function revocaAccessoAutomatico(
  client: Client,
  guildId: string,
  userId: string,
  motivo: string,
): Promise<boolean> {
  const tolti = await getPrisma()
    .panelAccess.deleteMany({ where: { guildId, userId, grantedBy: 'system' } })
    .catch(() => ({ count: 0 }));
  if (tolti.count === 0) return false;

  log.info({ guildId, userId, motivo }, 'accesso al pannello revocato');
  await recordEvent(client, {
    guildId,
    type: 'CONFIG_CHANGED',
    targetId: userId,
    severity: 40,
    automated: true,
    summary: `🔑 Accesso al pannello revocato a <@${userId}>: ${motivo}`,
  });
  return true;
}

/** Controlla tutti gli accessi automatici di un server: dopo che un ruolo è cambiato. */
async function ricontrollaServer(client: Client, role: Role): Promise<void> {
  const accessi = await getPrisma()
    .panelAccess.findMany({
      where: { guildId: role.guild.id, grantedBy: 'system' },
      select: { userId: true },
    })
    .catch(() => []);

  for (const { userId } of accessi) {
    const member = await role.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      await revocaAccessoAutomatico(client, role.guild.id, userId, 'non è più nel server');
    } else if (!puoGestire(member)) {
      await revocaAccessoAutomatico(
        client,
        role.guild.id,
        userId,
        `il ruolo «${role.name}» non concede più «Gestisci server»`,
      );
    }
  }
}

export function registraRevocheAccesso(client: Client): void {
  client.on(Events.GuildMemberRemove, (member: GuildMember | PartialGuildMember) => {
    void revocaAccessoAutomatico(client, member.guild.id, member.id, 'è uscito dal server');
  });

  client.on(Events.GuildMemberUpdate, (prima, dopo) => {
    // Solo quando cambiano i ruoli: un cambio di soprannome non deve costare
    // una scrittura nel database.
    const stessiRuoli =
      !prima.partial &&
      prima.roles.cache.size === dopo.roles.cache.size &&
      prima.roles.cache.every((_, id) => dopo.roles.cache.has(id));
    if (stessiRuoli || puoGestire(dopo)) return;
    void revocaAccessoAutomatico(
      client,
      dopo.guild.id,
      dopo.id,
      'non ha più il permesso «Gestisci server»',
    );
  });

  client.on(Events.GuildRoleUpdate, (prima, dopo) => {
    const aveva = prima.permissions.has(PermissionFlagsBits.ManageGuild);
    const ha = dopo.permissions.has(PermissionFlagsBits.ManageGuild);
    if (aveva && !ha) void ricontrollaServer(client, dopo);
  });

  client.on(Events.GuildRoleDelete, (role) => {
    if (role.permissions.has(PermissionFlagsBits.ManageGuild)) void ricontrollaServer(client, role);
  });
}
