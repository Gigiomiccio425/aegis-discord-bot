/* ═══════════════════════════════════════════════════════════════════════
   RUOLO DEL PROPRIETARIO

   Crea e mantiene un ruolo — «Angel Master» per impostazione predefinita — e
   lo assegna a chi è elencato in `OWNER_IDS`.

   Risolve un problema concreto: restare chiusi fuori dal proprio server.
   Succede più spesso di quanto sembri — un ruolo rimosso per errore, una
   riorganizzazione andata storta, un attacco che toglie i permessi a tutti.
   Con questo modulo il ruolo si ricrea da solo e torna a chi gli spetta.

   Tre garanzie che non sono negoziabili, e il motivo di ciascuna:

   • **Solo `OWNER_IDS`.** L'elenco arriva dall'ambiente, non dal database e
     non dal pannello. Un pannello compromesso non deve poter creare nuovi
     proprietari, e infatti non esiste alcuna interfaccia per farlo.

   • **Permessi minimi per impostazione predefinita.** Il ruolo nasce senza
     alcun potere: è un contrassegno. Chi vuole di più lo dice esplicitamente
     nella configurazione, sapendo che `AMMINISTRATORE` significa che un token
     rubato del bot equivale al server perso.

   • **Tutto registrato.** Creazione, assegnazione e reintegro finiscono nel
     registro con gravità alta. Un ruolo che compare da solo e si assegna da
     solo deve lasciare traccia, altrimenti è indistinguibile da una porta di
     servizio.
   ═══════════════════════════════════════════════════════════════════════ */

import { PermissionFlagsBits, type Guild, type GuildMember, type Client } from 'discord.js';
import type { GuildConfig } from '@angel/shared';
import { childLogger } from '../core/logger.js';
import { isBotOwner } from '../core/permissions.js';
import { recordEvent } from '../logging/auditLogger.js';

const log = childLogger('ruolo-proprietario');

/**
 * Permessi per livello.
 *
 * `MODERAZIONE` non include la gestione dei ruoli: chi può assegnare ruoli
 * può assegnarsi qualunque cosa, e un livello intermedio che concede la
 * scalata completa non è un livello intermedio.
 */
const PERMESSI = {
  NESSUNO: [],
  MODERAZIONE: [
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ViewAuditLog,
    PermissionFlagsBits.ManageNicknames,
  ],
  AMMINISTRATORE: [PermissionFlagsBits.Administrator],
} as const;

export interface OwnerRoleResult {
  /** Il ruolo esiste ora? */
  ok: boolean;
  /** È stato creato adesso, o esisteva già? */
  created: boolean;
  /** A quanti proprietari presenti nel server è stato assegnato. */
  assigned: number;
  /** Perché non è stato possibile, quando `ok` è falso. */
  reason?: string;
}

/**
 * Assicura che il ruolo esista e che i proprietari presenti lo abbiano.
 *
 * Idempotente: chiamarla dieci volte di fila non produce dieci ruoli né dieci
 * righe di registro. Viene invocata all'avvio, all'ingresso in un server
 * nuovo, quando un proprietario entra, e a richiesta dal comando.
 */
export async function ensureOwnerRole(
  client: Client,
  guild: Guild,
  config: GuildConfig,
): Promise<OwnerRoleResult> {
  const settings = config.general.ownerRole;
  if (!settings.enabled) return { ok: false, created: false, assigned: 0, reason: 'disattivato' };

  const me = await guild.members.fetchMe().catch(() => null);
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return {
      ok: false,
      created: false,
      assigned: 0,
      reason: 'al bot manca il permesso di gestire i ruoli',
    };
  }

  // Per nome e non per ID salvato: se qualcuno elimina il ruolo, l'ID
  // memorizzato punterebbe nel vuoto per sempre. Il nome invece si ritrova, e
  // se non esiste si ricrea — che è precisamente il comportamento voluto.
  let role = guild.roles.cache.find((entry) => entry.name === settings.name) ?? null;
  let created = false;

  if (!role) {
    if (!settings.reapply && guild.roles.cache.size > 0) {
      // Con il reintegro spento il ruolo si crea comunque la prima volta, ma
      // non viene ricreato dopo un'eliminazione deliberata: cancellarlo è un
      // modo legittimo di dire «non lo voglio».
      return { ok: false, created: false, assigned: 0, reason: 'eliminato e reintegro spento' };
    }

    role = await guild.roles
      .create({
        name: settings.name,
        color: settings.color as `#${string}`,
        hoist: settings.hoist,
        permissions: [...PERMESSI[settings.permissions]],
        mentionable: false,
        reason: 'Ruolo del proprietario del bot',
      })
      .catch((error: unknown) => {
        log.warn({ err: error, guildId: guild.id }, 'creazione del ruolo fallita');
        return null;
      });

    if (!role) {
      return { ok: false, created: false, assigned: 0, reason: 'Discord ha rifiutato la creazione' };
    }
    created = true;

    await recordEvent(client, {
      guildId: guild.id,
      type: 'ROLE_CREATED',
      roleId: role.id,
      actorId: client.user?.id,
      severity: 60,
      summary:
        `👑 Ruolo **${settings.name}** creato dal bot per i proprietari.\n` +
        `Permessi: ${settings.permissions.toLowerCase()}`,
      payload: { permissions: settings.permissions, automatic: true },
    });
  }

  // Il ruolo va posizionato il più in alto possibile ma **sotto** quello del
  // bot: Discord rifiuta di creare o spostare un ruolo più alto del proprio, e
  // se il tentativo fallisce l'intera operazione si fermerebbe qui.
  const target = Math.max(me.roles.highest.position - 1, 1);
  if (role.position < target && role.editable) {
    await role.setPosition(target).catch(() => undefined);
  }

  const assigned = await assignToOwners(client, guild, role.id, settings.name);
  return { ok: true, created, assigned };
}

async function assignToOwners(
  client: Client,
  guild: Guild,
  roleId: string,
  roleName: string,
): Promise<number> {
  // Si guardano i membri già in cache più quelli recuperati per ID: cercare
  // fra tutti i membri di un server grande costerebbe una richiesta pesante
  // per trovare al massimo due o tre persone, i cui ID sono già noti.
  const owners = (process.env.OWNER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  let assigned = 0;

  for (const ownerId of owners) {
    const member = await guild.members.fetch(ownerId).catch(() => null);
    if (!member || member.roles.cache.has(roleId)) continue;

    const done = await member.roles
      .add(roleId, 'Proprietario del bot')
      .then(() => true)
      .catch((error: unknown) => {
        log.warn({ err: error, guildId: guild.id, ownerId }, 'assegnazione del ruolo fallita');
        return false;
      });

    if (!done) continue;
    assigned += 1;

    await recordEvent(client, {
      guildId: guild.id,
      type: 'MEMBER_ROLE_ADDED',
      roleId,
      actorId: client.user?.id,
      targetId: ownerId,
      targetTag: member.user.tag,
      severity: 60,
      summary: `👑 Ruolo **${roleName}** assegnato a <@${ownerId}> (proprietario del bot)`,
      payload: { automatic: true },
    });
  }

  return assigned;
}

/**
 * Un proprietario è appena entrato: gli si dà il ruolo senza attendere il
 * prossimo controllo periodico.
 *
 * Il caso concreto è il primo ingresso in un server nuovo — il momento in cui
 * il ruolo serve, perché non si hanno ancora permessi.
 */
export async function onOwnerJoin(
  client: Client,
  member: GuildMember,
  config: GuildConfig,
): Promise<void> {
  if (!config.general.ownerRole.enabled) return;
  if (!isBotOwner(member.id)) return;
  await ensureOwnerRole(client, member.guild, config).catch((error: unknown) =>
    log.warn({ err: error, guildId: member.guild.id }, 'ruolo del proprietario non applicato'),
  );
}
