import { Events, type Client, type Guild } from 'discord.js';
import { getPrisma } from '@aegis/db';
import { recordEvent } from '../logging/auditLogger.js';
import { syncInvites } from '../security/inviteGuard.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('events:invites');

/**
 * Attribuzione degli inviti.
 *
 * Discord non dice quale invito ha usato chi entra. L'unico modo è tenere una
 * copia dei contatori e confrontarla dopo ogni ingresso: l'invito il cui
 * contatore è cresciuto è quello usato. Il metodo ha un limite noto — con due
 * ingressi nello stesso istante l'attribuzione può sbagliare — ma è l'unico
 * disponibile, ed è quello che permette di risalire a chi porta account
 * problematici nel server.
 */
const inviteCounts = new Map<string, Map<string, number>>();

export function registerInviteEvents(client: Client): void {
  client.on(Events.InviteCreate, (invite) => {
    if (!invite.guild) return;
    const guildId = invite.guild.id;

    const counts = inviteCounts.get(guildId) ?? new Map();
    counts.set(invite.code, invite.uses ?? 0);
    inviteCounts.set(guildId, counts);

    void getPrisma()
      .inviteRecord.upsert({
        where: { code: invite.code },
        create: {
          code: invite.code,
          guildId,
          channelId: invite.channelId ?? null,
          inviterId: invite.inviterId ?? null,
          uses: invite.uses ?? 0,
          maxUses: invite.maxUses ?? 0,
          temporary: invite.temporary ?? false,
          expiresAt: invite.expiresAt ?? null,
        },
        update: { deletedAt: null },
      })
      .catch(() => undefined);

    void recordEvent(client, {
      guildId,
      type: 'INVITE_CREATED',
      actorId: invite.inviterId ?? null,
      channelId: invite.channelId ?? null,
      summary:
        `Codice \`${invite.code}\`` +
        (invite.maxUses ? ` · massimo ${invite.maxUses} usi` : ' · usi illimitati') +
        (invite.expiresAt ? ` · scade <t:${Math.floor(invite.expiresAt.getTime() / 1000)}:R>` : ' · non scade'),
      payload: { code: invite.code, maxUses: invite.maxUses, maxAge: invite.maxAge },
    });
  });

  client.on(Events.InviteDelete, (invite) => {
    if (!invite.guild) return;
    const guildId = invite.guild.id;
    inviteCounts.get(guildId)?.delete(invite.code);

    void getPrisma()
      .inviteRecord.updateMany({
        where: { code: invite.code },
        data: { deletedAt: new Date() },
      })
      .catch(() => undefined);

    void recordEvent(client, {
      guildId,
      type: 'INVITE_DELETED',
      summary:
        `Codice \`${invite.code}\` eliminato.\n` +
        '⚠️ Se questo link è stato pubblicato altrove, il codice può ora essere rivendicato da un ' +
        'altro server: chi apre il vecchio link finirebbe lì.',
      severity: 20,
      payload: { code: invite.code },
    });
  });
}

/** Carica i contatori all'avvio: senza, la prima attribuzione è impossibile. */
export async function primeInviteCache(guild: Guild): Promise<void> {
  const counts = await syncInvites(guild);
  inviteCounts.set(guild.id, counts);
  log.debug({ guildId: guild.id, invites: counts.size }, 'cache inviti caricata');
}

/** Confronta i contatori e restituisce l'invito verosimilmente usato. */
export async function attributeInvite(
  guild: Guild,
): Promise<{ code: string; inviterId: string | null } | null> {
  const previous = inviteCounts.get(guild.id);
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;

  const current = new Map<string, number>();
  let used: { code: string; inviterId: string | null } | null = null;

  for (const invite of invites.values()) {
    const uses = invite.uses ?? 0;
    current.set(invite.code, uses);
    if (previous && uses > (previous.get(invite.code) ?? 0)) {
      used = { code: invite.code, inviterId: invite.inviterId ?? null };
    }
  }

  // Un invito a uso singolo sparisce appena viene usato: non comparirebbe più
  // nell'elenco, quindi si cerca fra quelli scomparsi.
  if (!used && previous) {
    for (const [code, uses] of previous) {
      if (!current.has(code)) {
        const record = await getPrisma()
          .inviteRecord.findUnique({ where: { code } })
          .catch(() => null);
        used = { code, inviterId: record?.inviterId ?? null };
        break;
      }
      void uses;
    }
  }

  inviteCounts.set(guild.id, current);

  if (used) {
    await getPrisma()
      .inviteRecord.updateMany({
        where: { code: used.code },
        data: { uses: current.get(used.code) ?? 0 },
      })
      .catch(() => undefined);
  }

  return used;
}
