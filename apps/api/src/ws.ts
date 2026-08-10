import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { RedisKeys } from '@aegis/shared';
import { getPanelRole, getSessionUser, hasAtLeast } from './auth.js';
import { getSubscriber } from './redis.js';
import { logger } from './logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   FEED LIVE

   Il pannello riceve gli eventi mentre accadono, non a ogni ricarica. Durante
   un raid la differenza è sostanziale: si vede la curva salire e si può
   intervenire, invece di scoprire tutto a cose fatte.

   Una sola sottoscrizione Redis condivisa da tutte le connessioni: una
   sottoscrizione per client moltiplicherebbe le connessioni a Redis per il
   numero di schede aperte dai moderatori.
   ═══════════════════════════════════════════════════════════════════════ */

interface Client {
  socket: WebSocket;
  userId: string;
  guildId: string;
}

const clients = new Set<Client>();
let subscribed = false;

export async function registerLiveFeed(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/live',
    { websocket: true },
    async (socket, request) => {
      const user = await getSessionUser(request);
      if (!user) {
        socket.close(4401, 'non autenticato');
        return;
      }

      const guildId = (request.params as { guildId: string }).guildId;
      const role = await getPanelRole(user.id, guildId);
      if (!hasAtLeast(role, 'VIEWER')) {
        socket.close(4403, 'permessi insufficienti');
        return;
      }

      const client: Client = { socket, userId: user.id, guildId };
      clients.add(client);
      ensureSubscription();

      socket.send(JSON.stringify({ type: 'connected', guildId }));

      // Ping periodico: senza, i proxy chiudono le connessioni inattive dopo
      // qualche minuto e il pannello smette di aggiornarsi senza dirlo.
      const ping = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, 30_000);

      socket.on('close', () => {
        clearInterval(ping);
        clients.delete(client);
      });

      socket.on('error', () => {
        clearInterval(ping);
        clients.delete(client);
      });
    },
  );
}

function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;

  const subscriber = getSubscriber();
  void subscriber.subscribe(RedisKeys.eventChannel).catch((error: unknown) => {
    logger.error({ err: error }, 'sottoscrizione al feed eventi fallita');
    subscribed = false;
  });

  subscriber.on('message', (channel: string, message: string) => {
    if (channel !== RedisKeys.eventChannel) return;

    let event: { guildId?: string };
    try {
      event = JSON.parse(message) as { guildId?: string };
    } catch {
      return;
    }
    if (!event.guildId) return;

    for (const client of clients) {
      // Ogni client riceve solo gli eventi del proprio server: il filtro sta
      // qui e non nel browser, altrimenti basterebbe aprire gli strumenti di
      // sviluppo per leggere l'attività di server altrui.
      if (client.guildId !== event.guildId) continue;
      if (client.socket.readyState !== client.socket.OPEN) continue;
      client.socket.send(message);
    }
  });
}

export function connectedClients(): number {
  return clients.size;
}
