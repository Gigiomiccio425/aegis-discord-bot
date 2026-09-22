import { PermissionFlagsBits, type Message } from 'discord.js';
import type { GuildConfig } from '@angel/shared';
import { statoRecente } from '../core/lockdown.js';
import { isStaff } from '../core/permissions.js';

/**
 * Permessi che fanno di un membro qualcuno che può scrivere anche sotto
 * lockdown. Sono gli stessi che escludono un ruolo dal blocco.
 */
const PERMESSI_DA_STAFF =
  PermissionFlagsBits.Administrator |
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ModerateMembers;

/**
 * La seconda linea del lockdown: i messaggi che passano lo stesso.
 *
 * Il blocco vero sta nei permessi dei canali, e da solo non basta. Un canale
 * che il bot non è riuscito a modificare resta aperto; un ruolo con la
 * scrittura concessa che non si è potuto neutralizzare continua a scrivere.
 * In quei casi il lockdown risulta attivo, lo staff lo crede efficace, e chi
 * sta facendo il raid continua. Qui quei messaggi si tolgono appena arrivano.
 *
 * Due eccezioni che contano:
 *
 * • lo staff, per ruolo o per permessi — durante un raid è l'unico che deve
 *   poter parlare;
 * • chi ha una concessione **personale** sul canale. È una scelta esplicita
 *   dello staff, e i ticket la usano: chi ha aperto una richiesta d'aiuto
 *   durante un lockdown deve poter continuare a scriverci.
 *
 * Restituisce `true` se il messaggio è stato trattenuto, e l'analisi si
 * ferma lì: non ha senso sanzionare per spam un messaggio che non doveva
 * nemmeno esserci.
 */
export async function trattieniDuranteLockdown(
  message: Message,
  config: GuildConfig,
): Promise<boolean> {
  if (!message.guild || !message.member) return false;

  const stato = await statoRecente(message.guild.id);
  if (!stato) return false;

  // Nei thread conta il canale che li contiene: è quello che il lockdown chiude.
  const canale = message.channel.isThread() ? message.channel.parent : message.channel;
  if (!canale || !('permissionOverwrites' in canale)) return false;

  const bloccato =
    stato.channels.includes(canale.id) ||
    (stato.ruoli ?? []).some((voce) => voce.canaleId === canale.id) ||
    (stato.falliti ?? []).some((voce) => voce.canaleId === canale.id);
  if (!bloccato) return false;

  if (isStaff(message.member, config)) return false;
  if ((message.member.permissions.bitfield & PERMESSI_DA_STAFF) !== 0n) return false;

  const personale = canale.permissionOverwrites.cache.get(message.author.id);
  if (personale?.allow.has(PermissionFlagsBits.SendMessages)) return false;

  await message.delete().catch(() => undefined);
  return true;
}
