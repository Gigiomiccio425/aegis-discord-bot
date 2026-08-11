import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PanelRole } from '@angel/db';
import { getPanelRole, getSessionUser, hasAtLeast, type SessionUser } from './auth.js';

export interface GuildContext {
  user: SessionUser;
  guildId: string;
  role: PanelRole;
}

/**
 * Controllo di accesso per le rotte legate a un server.
 *
 * Restituisce `null` e risponde già con l'errore quando l'accesso è negato:
 * la rotta chiamante deve solo verificare il valore e uscire. Un helper che
 * lanciasse eccezioni renderebbe più facile dimenticare il controllo, e qui
 * dimenticarlo significa esporre l'archivio dei messaggi di un server.
 */
export async function requireGuild(
  request: FastifyRequest,
  reply: FastifyReply,
  guildId: string,
  minimumRole: PanelRole = 'VIEWER',
): Promise<GuildContext | null> {
  const user = await getSessionUser(request);
  if (!user) {
    await reply.code(401).send({ error: 'non autenticato' });
    return null;
  }

  const role = await getPanelRole(user.id, guildId);
  if (!hasAtLeast(role, minimumRole)) {
    await reply.code(403).send({ error: 'permessi insufficienti per questo server' });
    return null;
  }

  return { user, guildId, role: role! };
}

export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionUser | null> {
  const user = await getSessionUser(request);
  if (!user) {
    await reply.code(401).send({ error: 'non autenticato' });
    return null;
  }
  return user;
}
