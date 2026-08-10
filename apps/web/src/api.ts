/**
 * Client HTTP del pannello.
 *
 * Il cookie di sessione è httpOnly e same-origin: non c'è alcun token da
 * gestire in JavaScript, il che elimina di netto la categoria di problemi
 * legata ai token conservati in localStorage.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 401) {
    throw new ApiError('Sessione scaduta', 401);
  }

  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const payload = data as { error?: string; dettagli?: unknown } | null;
    throw new ApiError(payload?.error ?? `Errore ${response.status}`, response.status, payload?.dettagli);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/* ── Tipi delle risposte ─────────────────────────────────────────────── */

export interface Me {
  user: { id: string; tag: string; avatar: string | null };
  guilds: { id: string; name: string; icon: string | null; memberCount: number; role: string }[];
  pendingInvite: { id: string; name: string; icon: string | null }[];
}

export interface Stats {
  threatsToday: number;
  threatsWeek: number;
  joinsToday: number;
  activeCases: number;
  quarantined: number;
  topThreats: { type: string; count: number }[];
  incidents: Incident[];
  joinSeries: { hour: string; count: number }[];
}

export interface Incident {
  id: string;
  kind: string;
  startedAt: string;
  endedAt: string | null;
  actorId: string | null;
  affectedUserIds: string[];
  peakRate: number;
  summary: string | null;
}

export interface LogEvent {
  id: string;
  type: string;
  category: string;
  createdAt: string;
  actorId: string | null;
  actorTag: string | null;
  targetId: string | null;
  channelId: string | null;
  messageId: string | null;
  summary: string | null;
  severity: number;
  automated: boolean;
  payload: Record<string, unknown>;
}

export interface CaseRecord {
  id: string;
  number: number;
  type: string;
  status: string;
  targetId: string;
  targetTag: string | null;
  actorId: string;
  reason: string;
  module: string | null;
  automated: boolean;
  createdAt: string;
  expiresAt: string | null;
}

export interface Persona {
  id: string;
  name: string;
  avatarUrl: string | null;
  color: string | null;
  description: string;
  messageCount: number;
}

export interface CustomCommandRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  allowedRoleIds: string[];
  deniedRoleIds: string[];
  allowedChannelIds: string[];
  args: unknown[];
  steps: unknown[];
  cooldownSec: number;
  guildCooldownSec: number;
  ephemeralAck: boolean;
  useCount: number;
}

export interface SecurityInventory {
  webhooks: {
    id: string;
    name: string;
    channelId: string;
    creatorId: string | null;
    managed: boolean;
    approved: boolean;
    firstSeenAt: string;
  }[];
  bots: {
    id: string;
    name: string;
    riskScore: number;
    riskFlags: string[];
    approved: boolean;
    addedBy: string | null;
  }[];
  invitesAtRisk: { code: string; atRisk: boolean; deletedAt: string | null }[];
}

export interface RiskyUser {
  userId: string;
  username: string | null;
  displayName: string | null;
  riskScore: number;
  riskFlags: string[];
  quarantinedAt: string | null;
  quarantineReason: string | null;
  joinedAt: string | null;
  caseCount: number;
}

/** Connessione al feed live degli eventi. */
export function openLiveFeed(guildId: string, onEvent: (event: LogEvent) => void): () => void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/guilds/${guildId}/live`);

  socket.addEventListener('message', (message) => {
    try {
      const data = JSON.parse(message.data as string) as LogEvent & { type: string };
      if (data.type === 'connected') return;
      onEvent(data);
    } catch {
      /* messaggio non interpretabile: ignorato */
    }
  });

  return () => socket.close();
}
