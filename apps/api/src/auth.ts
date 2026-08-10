import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPrisma, type PanelRole } from '@aegis/db';
import { encrypt } from './crypto.js';
import { logger } from './logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   AUTENTICAZIONE DEL PANNELLO

   OAuth2 Discord, con due scelte deliberate.

   Primo: la sessione vive in tabella, non solo nel cookie. Un cookie firmato
   non si può revocare — se l'account di un moderatore viene compromesso, senza
   una tabella l'unico rimedio sarebbe cambiare il segreto e disconnettere
   tutti. Con la tabella si revoca la singola sessione.

   Secondo: i permessi del pannello sono separati da quelli Discord. Avere
   `MANAGE_GUILD` è la condizione minima per entrare, ma cosa si può fare
   dentro lo decide `PanelAccess`. Amministrare un server non implica il
   diritto di leggere ogni messaggio archiviato.
   ═══════════════════════════════════════════════════════════════════════ */

const SESSION_COOKIE = 'aegis_session';
const SESSION_DAYS = 7;
const DISCORD_API = 'https://discord.com/api/v10';

export interface SessionUser {
  id: string;
  tag: string;
  avatar: string | null;
  sessionId: string;
}

export function authorizeUrl(state: string): string {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = `${process.env.PUBLIC_URL}/api/auth/callback`;
  const params = new URLSearchParams({
    client_id: clientId ?? '',
    redirect_uri: redirectUri,
    response_type: 'code',
    // `identify` e `guilds` bastano: non si chiede l'email, che non serve a
    // nulla e sarebbe solo un dato in più da proteggere.
    scope: 'identify guilds',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} | null> {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const response = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${process.env.PUBLIC_URL}/api/auth/callback`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  } catch (error) {
    logger.warn({ err: error }, 'scambio del codice OAuth fallito');
    return null;
  }
}

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  global_name?: string | null;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser | null> {
  const response = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json()) as DiscordUser;
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

export async function fetchUserGuilds(accessToken: string): Promise<DiscordGuildSummary[]> {
  const response = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!response?.ok) return [];
  return (await response.json()) as DiscordGuildSummary[];
}

/** MANAGE_GUILD = 0x20. È la soglia minima per vedere un server nel pannello. */
export function canManageGuild(guild: DiscordGuildSummary): boolean {
  if (guild.owner) return true;
  return (BigInt(guild.permissions) & 0x20n) === 0x20n;
}

export async function createSession(
  user: DiscordUser,
  tokens: { accessToken: string; refreshToken: string },
  request: FastifyRequest,
): Promise<string> {
  const prisma = getPrisma();
  const session = await prisma.panelSession.create({
    data: {
      userId: user.id,
      userTag: user.global_name ?? user.username,
      avatar: user.avatar,
      tokenEnc: encrypt(JSON.stringify(tokens)),
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
      ip: request.ip,
      userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
    },
  });
  return session.id;
}

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    // `secure` solo su HTTPS: in sviluppo su http://localhost il cookie
    // altrimenti non verrebbe mai inviato.
    secure: (process.env.PUBLIC_URL ?? '').startsWith('https://'),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
    signed: true,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function getSessionUser(request: FastifyRequest): Promise<SessionUser | null> {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;

  const prisma = getPrisma();
  const session = await prisma.panelSession.findUnique({ where: { id: unsigned.value } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

  // Aggiornamento pigro dell'ultimo accesso: scrivere a ogni richiesta
  // significherebbe una UPDATE per ogni chiamata dell'interfaccia.
  if (Date.now() - session.lastSeenAt.getTime() > 300_000) {
    await prisma.panelSession
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  return {
    id: session.userId,
    tag: session.userTag ?? session.userId,
    avatar: session.avatar,
    sessionId: session.id,
  };
}

export function generateState(): string {
  return randomBytes(24).toString('base64url');
}

/* ── Autorizzazione per server ────────────────────────────────────────── */

const ROLE_RANK: Record<PanelRole, number> = {
  VIEWER: 1,
  MOD: 2,
  ADMIN: 3,
  OWNER: 4,
};

const ownerIds = (process.env.OWNER_IDS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

export async function getPanelRole(userId: string, guildId: string): Promise<PanelRole | null> {
  if (ownerIds.includes(userId)) return 'OWNER';

  const prisma = getPrisma();
  const access = await prisma.panelAccess.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });
  return access?.role ?? null;
}

export function hasAtLeast(role: PanelRole | null, required: PanelRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[required];
}
