import { ChannelType, Events, type Client, type Guild } from 'discord.js';
import { RedisKeys } from '@angel/shared';
import { getRedis } from './redis.js';
import { childLogger } from './logger.js';

const log = childLogger('inventario');

/* ═══════════════════════════════════════════════════════════════════════
   INVENTARIO DI CANALI E RUOLI

   Il pannello non è connesso a Discord — è una scelta, non una mancanza: una
   sola connessione al gateway significa rate limit gestiti in un punto solo e
   pannello riavviabile senza far cadere il bot.

   Il prezzo era che il pannello non sapesse come si chiamano i canali, e che
   configurarne uno volesse dire incollarne l'ID a mano. Da lì passavano gli
   errori peggiori: un ID copiato male non dà errore, punta a un altro canale.

   Il bot scrive qui ciò che vede, il pannello lo legge. Non è una cache da
   tenere fresca al secondo: nomi e ID di canali e ruoli cambiano raramente, e
   quando cambiano c'è un evento che lo dice.
   ═══════════════════════════════════════════════════════════════════════ */

export interface CanaleInventario {
  id: string;
  name: string;
  type: 'TEXT' | 'VOICE' | 'CATEGORY' | 'FORUM' | 'STAGE' | 'ANNOUNCEMENT' | 'ALTRO';
  parentId: string | null;
  position: number;
}

export interface RuoloInventario {
  id: string;
  name: string;
  color: string | null;
  position: number;
  /** Ruoli gestiti da un'integrazione: non assegnabili a mano. */
  managed: boolean;
  everyone: boolean;
}

export interface Inventario {
  channels: CanaleInventario[];
  roles: RuoloInventario[];
  updatedAt: string;
}

function tipoCanale(type: ChannelType): CanaleInventario['type'] {
  switch (type) {
    case ChannelType.GuildText:
      return 'TEXT';
    case ChannelType.GuildVoice:
      return 'VOICE';
    case ChannelType.GuildCategory:
      return 'CATEGORY';
    case ChannelType.GuildForum:
      return 'FORUM';
    case ChannelType.GuildStageVoice:
      return 'STAGE';
    case ChannelType.GuildAnnouncement:
      return 'ANNOUNCEMENT';
    default:
      return 'ALTRO';
  }
}

function costruisci(guild: Guild): Inventario {
  return {
    channels: guild.channels.cache
      .filter((channel) => !channel.isThread())
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: tipoCanale(channel.type),
        parentId: 'parentId' in channel ? channel.parentId : null,
        position: 'rawPosition' in channel ? channel.rawPosition : 0,
      }))
      .sort((a, b) => a.position - b.position),
    roles: guild.roles.cache
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.color === 0 ? null : `#${role.color.toString(16).padStart(6, '0')}`,
        position: role.position,
        managed: role.managed,
        everyone: role.id === guild.id,
      }))
      // Dal più alto al più basso, come li mostra Discord: cercare un ruolo
      // nell'ordine in cui si è abituati a vederlo è metà del lavoro.
      .sort((a, b) => b.position - a.position),
    updatedAt: new Date().toISOString(),
  };
}

export async function pubblicaInventario(guild: Guild): Promise<void> {
  try {
    // Scade in una settimana: se il bot è uscito dal server, il pannello smette
    // di mostrare canali che non esistono più invece di tenerli per sempre.
    await getRedis().set(
      RedisKeys.guildInventory(guild.id),
      JSON.stringify(costruisci(guild)),
      'EX',
      604_800,
    );
  } catch (errore) {
    log.warn({ err: errore, guildId: guild.id }, 'inventario non pubblicato');
  }
}

/**
 * Ripubblica l'inventario quando la struttura cambia.
 *
 * Con attesa, perché le modifiche alla struttura arrivano a raffica: chi
 * riordina i canali ne sposta dieci in venti secondi, e riscrivere l'inventario
 * dieci volte per poi tenere solo l'ultima scrittura è lavoro buttato.
 */
export function registraInventario(client: Client): void {
  const attese = new Map<string, NodeJS.Timeout>();

  const programma = (guild: Guild): void => {
    const precedente = attese.get(guild.id);
    if (precedente) clearTimeout(precedente);
    attese.set(
      guild.id,
      setTimeout(() => {
        attese.delete(guild.id);
        void pubblicaInventario(guild);
      }, 5000),
    );
  };

  client.once(Events.ClientReady, (ready) => {
    for (const guild of ready.guilds.cache.values()) void pubblicaInventario(guild);
  });

  client.on(Events.GuildCreate, (guild) => void pubblicaInventario(guild));

  // Il primo argomento di questi eventi porta sempre il server, sia che
  // l'evento ne consegni uno solo (creazione, eliminazione) sia che ne consegni
  // due (modifica: prima e dopo). Serve solo sapere *quale* server ricontrollare.
  const daPrimoArgomento = (primo: unknown): void => {
    const guild = (primo as { guild?: Guild }).guild;
    if (guild) programma(guild);
  };

  client.on(Events.ChannelCreate, (channel) => daPrimoArgomento(channel));
  client.on(Events.ChannelDelete, (channel) => daPrimoArgomento(channel));
  client.on(Events.ChannelUpdate, (channel) => daPrimoArgomento(channel));
  client.on(Events.GuildRoleCreate, (role) => daPrimoArgomento(role));
  client.on(Events.GuildRoleDelete, (role) => daPrimoArgomento(role));
  client.on(Events.GuildRoleUpdate, (role) => daPrimoArgomento(role));
}
