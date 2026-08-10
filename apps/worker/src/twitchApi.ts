import { childLogger } from './logger.js';

const log = childLogger('twitch');

/* ═══════════════════════════════════════════════════════════════════════
   API TWITCH

   Gli avvisi live arrivano via EventSub (webhook firmato), non via polling:
   la notifica è immediata e non consuma quota. I clip invece richiedono
   polling, perché non esiste un evento EventSub dedicato.
   ═══════════════════════════════════════════════════════════════════════ */

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Token applicativo (client credentials). Vale per le API pubbliche. */
async function getAppToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as { access_token: string; expires_in: number };
    cachedToken = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return cachedToken.value;
  } catch (error) {
    log.warn({ err: error }, 'token Twitch non ottenuto');
    return null;
  }
}

async function twitchFetch<T>(path: string): Promise<T | null> {
  const token = await getAppToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!token || !clientId) return null;

  try {
    const response = await fetch(`https://api.twitch.tv/helix/${path}`, {
      headers: { 'Client-Id': clientId, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      log.debug({ path, status: response.status }, 'richiesta Twitch fallita');
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    log.debug({ err: error, path }, 'richiesta Twitch fallita');
    return null;
  }
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

export async function getUserByLogin(login: string): Promise<TwitchUser | null> {
  const data = await twitchFetch<{ data: TwitchUser[] }>(
    `users?login=${encodeURIComponent(login)}`,
  );
  return data?.data[0] ?? null;
}

export interface TwitchStream {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  game_name: string;
  title: string;
  viewer_count: number;
  started_at: string;
  thumbnail_url: string;
}

export async function getStream(userId: string): Promise<TwitchStream | null> {
  const data = await twitchFetch<{ data: TwitchStream[] }>(`streams?user_id=${userId}`);
  return data?.data[0] ?? null;
}

export interface TwitchClip {
  id: string;
  url: string;
  title: string;
  creator_name: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
}

export async function getClips(userId: string, since: Date): Promise<TwitchClip[]> {
  const data = await twitchFetch<{ data: TwitchClip[] }>(
    `clips?broadcaster_id=${userId}&started_at=${since.toISOString()}&first=20`,
  );
  return data?.data ?? [];
}

/**
 * Sottoscrizione EventSub via webhook.
 *
 * Twitch invia subito un messaggio di verifica al callback: l'API deve
 * rispondere 200 con la stringa `challenge` in chiaro nel corpo, altrimenti la
 * sottoscrizione resta in stato `webhook_callback_verification_pending` e non
 * arriverà mai alcun evento.
 */
export async function subscribeEventSub(
  type: 'stream.online' | 'stream.offline',
  broadcasterUserId: string,
  callbackUrl: string,
): Promise<string | null> {
  const token = await getAppToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_EVENTSUB_SECRET;
  if (!token || !clientId || !secret) return null;

  try {
    const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type,
        version: '1',
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: 'webhook', callback: callbackUrl, secret },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const text = await response.text();
      log.warn({ status: response.status, body: text.slice(0, 300) }, 'sottoscrizione EventSub fallita');
      return null;
    }

    const data = (await response.json()) as { data: { id: string }[] };
    return data.data[0]?.id ?? null;
  } catch (error) {
    log.warn({ err: error }, 'sottoscrizione EventSub fallita');
    return null;
  }
}

export async function deleteEventSub(subscriptionId: string): Promise<void> {
  const token = await getAppToken();
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!token || !clientId) return;

  await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${subscriptionId}`, {
    method: 'DELETE',
    headers: { 'Client-Id': clientId, authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  }).catch(() => undefined);
}
