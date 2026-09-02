/* ═══════════════════════════════════════════════════════════════════════
   IL PANNELLO DEGLI STREAMER

   Gira su una porta propria, separata da quella del pannello Discord, e la
   ragione è tutta di sicurezza: questo è pensato per essere **esposto a
   Internet**, perché sono gli streamer a doverlo raggiungere per configurare
   il bot da soli. Il pannello Discord invece contiene i dati di ogni server e
   resta dov'è, dietro Tailscale.

   Due porte, due superfici, due platee. Metterli insieme avrebbe significato
   che aprire il secondo apriva anche il primo.

   ── Chi entra ──────────────────────────────────────────────────────────

   Si entra con Twitch, non con Discord: chi ha un canale ha già un account
   Twitch, e chiedergliene un altro sarebbe un ostacolo prima ancora di aver
   mostrato a cosa serve. La stessa autorizzazione che fa entrare è quella che
   dà al bot i permessi di moderare — un passaggio solo invece di due.

   ── Cosa vede ──────────────────────────────────────────────────────────

   Solo i canali su cui ha un ruolo: il proprio, e quelli dove lo streamer lo
   ha aggiunto come moderatore. Non esiste una rotta che restituisca l'elenco
   dei canali serviti, e non è pigrizia: i termini di Twitch vietano di
   raccogliere dati sugli spettatori altrui, e un pannello che mostra i canali
   degli altri è il primo passo per farlo senza accorgersene.
   ═══════════════════════════════════════════════════════════════════════ */

import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import { getPrisma } from '@angel/db';
import {
  DESCRIZIONE_LIVELLI,
  LivelloSicurezza,
  TwitchChannelConfigSchema,
  applicaLivello,
  defaultTwitchConfig,
} from '@angel/shared';
import { AMBITI_CANALE, scambiaCodice, urlAutorizzazione, revoca } from '../deps.js';
import { encrypt } from '../crypto.js';
import { logger } from '../logger.js';
import { getRedis } from '../redis.js';
import type { Motore } from '../motore.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const COOKIE = 'angel_twitch';
/** Durata della sessione. Corta di proposito: si rientra con un clic. */
const SESSIONE_GIORNI = 14;

interface Sessione {
  id: string;
  twitchUserId: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface OpzioniPannello {
  motore: Motore;
  clientId: string;
  clientSecret: string;
  /** Indirizzo pubblico del pannello, senza barra finale. */
  publicUrl: string;
  porta: number;
}

/* ── Sessioni ─────────────────────────────────────────────────────────── */

async function leggiSessione(request: FastifyRequest): Promise<Sessione | null> {
  const id = request.cookies[COOKIE];
  if (!id) return null;

  const riga = await getPrisma()
    .twitchSession.findUnique({ where: { id } })
    .catch(() => null);

  if (!riga || riga.revokedAt || riga.expiresAt < new Date()) return null;

  // L'ultimo accesso si aggiorna senza attendere: è un dato di comodo, e far
  // aspettare ogni richiesta per scriverlo sarebbe pagare una scrittura per
  // ogni lettura.
  void getPrisma()
    .twitchSession.update({ where: { id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return {
    id: riga.id,
    twitchUserId: riga.twitchUserId,
    login: riga.login,
    displayName: riga.displayName ?? riga.login,
    avatarUrl: riga.avatarUrl,
  };
}

async function richiediSessione(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Sessione | null> {
  const sessione = await leggiSessione(request);
  if (!sessione) {
    await reply.code(401).send({ error: 'non autenticato' });
    return null;
  }
  return sessione;
}

/**
 * Il ruolo di una persona su un canale.
 *
 * Il proprietario è chi ha autorizzato; i moderatori li aggiunge lui. Chi non
 * compare non riceve un 403 generico ma un 404: se non hai accesso a un
 * canale, non devi nemmeno poter scoprire che esiste sul nostro bot.
 */
async function ruoloSu(
  sessione: Sessione,
  canaleId: string,
): Promise<'PROPRIETARIO' | 'MODERATORE' | 'LETTURA' | null> {
  if (sessione.twitchUserId === canaleId) return 'PROPRIETARIO';

  const accesso = await getPrisma()
    .twitchAccess.findUnique({
      where: { channelId_twitchUserId: { channelId: canaleId, twitchUserId: sessione.twitchUserId } },
    })
    .catch(() => null);

  return (accesso?.role as 'MODERATORE' | 'LETTURA' | undefined) ?? null;
}

/* ── Server ───────────────────────────────────────────────────────────── */

export async function avviaPannello(opzioni: OpzioniPannello): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 256 * 1024 });

  await app.register(cookie);

  /*
   * Limite di frequenza con Redis.
   *
   * `skipOnError` acceso: se Redis cade, le richieste passano invece di
   * diventare tutte errori 500. È già successo sull'altro pannello, e il
   * sintomo — tutto rotto mentre l'applicazione sta benissimo — è costato
   * un'ora di ricerca nel posto sbagliato.
   */
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    redis: getRedis(),
    skipOnError: true,
    keyGenerator: (request) => request.ip,
  });

  const sicuro = opzioni.publicUrl.startsWith('https://');
  const redirectUri = `${opzioni.publicUrl}/api/auth/callback`;

  app.get('/api/salute', async () => ({
    ok: true,
    ...opzioni.motore.stato(),
  }));

  /* ── Accesso ──────────────────────────────────────────────────── */

  app.get('/api/auth/entra', async (request, reply) => {
    const stato = randomBytes(16).toString('base64url');

    // Lo stato vive in un cookie e non in memoria: il pannello può riavviarsi
    // mentre qualcuno è sulla schermata di Twitch, e in quel caso l'accesso
    // fallirebbe con «stato non valido» senza che nessuno capisca perché.
    void reply.setCookie('angel_stato', stato, {
      httpOnly: true,
      sameSite: 'lax',
      secure: sicuro,
      path: '/',
      maxAge: 600,
    });

    return reply.redirect(
      urlAutorizzazione({
        clientId: opzioni.clientId,
        redirectUri,
        stato,
        ambiti: AMBITI_CANALE,
      }),
    );
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/callback',
    async (request, reply) => {
      const { code, state, error } = request.query;

      if (error) return reply.redirect('/?errore=autorizzazione-negata');
      if (!code || !state || state !== request.cookies.angel_stato) {
        return reply.redirect('/?errore=stato-non-valido');
      }
      void reply.clearCookie('angel_stato', { path: '/' });

      const token = await scambiaCodice({
        clientId: opzioni.clientId,
        clientSecret: opzioni.clientSecret,
        redirectUri,
        codice: code,
      }).catch((errore: unknown) => {
        logger.warn({ err: errore }, 'scambio del codice fallito');
        return null;
      });
      if (!token) return reply.redirect('/?errore=scambio-fallito');

      const utente = await opzioni.motore.helix.ioSono(token.accessToken);
      if (!utente) return reply.redirect('/?errore=utente-sconosciuto');

      /*
       * L'autorizzazione crea o aggiorna il canale.
       *
       * `upsert` e non `create`: chi riautorizza dopo una scadenza deve
       * ritrovare la propria configurazione, non ricominciare da capo. È il
       * caso più frequente in assoluto, e trattarlo come un canale nuovo
       * significherebbe cancellare comandi e timer a ogni cambio di password.
       */
      await getPrisma().twitchChannel.upsert({
        where: { id: utente.id },
        create: {
          id: utente.id,
          login: utente.login,
          displayName: utente.display_name,
          avatarUrl: utente.profile_image_url,
          tokenEnc: encrypt(token.accessToken),
          refreshEnc: encrypt(token.refreshToken),
          scopes: token.scopes,
          tokenExpiresAt: new Date(Date.now() + token.expiresIn * 1000),
          config: defaultTwitchConfig(),
        },
        update: {
          login: utente.login,
          displayName: utente.display_name,
          avatarUrl: utente.profile_image_url,
          tokenEnc: encrypt(token.accessToken),
          refreshEnc: encrypt(token.refreshToken),
          scopes: token.scopes,
          tokenExpiresAt: new Date(Date.now() + token.expiresIn * 1000),
          tokenFailedAt: null,
          enabled: true,
        },
      });

      const sessioneId = randomUUID();
      await getPrisma().twitchSession.create({
        data: {
          id: sessioneId,
          twitchUserId: utente.id,
          login: utente.login,
          displayName: utente.display_name,
          avatarUrl: utente.profile_image_url,
          expiresAt: new Date(Date.now() + SESSIONE_GIORNI * 86_400_000),
          ip: request.ip,
          userAgent: request.headers['user-agent']?.slice(0, 250) ?? null,
        },
      });

      void reply.setCookie(COOKIE, sessioneId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: sicuro,
        path: '/',
        maxAge: SESSIONE_GIORNI * 86_400,
      });

      await opzioni.motore.collega(utente.id).catch((errore: unknown) =>
        logger.warn({ err: errore }, 'canale autorizzato ma non collegato'),
      );

      return reply.redirect('/');
    },
  );

  app.post('/api/auth/esci', async (request, reply) => {
    const id = request.cookies[COOKIE];
    if (id) {
      await getPrisma()
        .twitchSession.update({ where: { id }, data: { revokedAt: new Date() } })
        .catch(() => undefined);
    }
    void reply.clearCookie(COOKIE, { path: '/' });
    return { uscito: true };
  });

  /* ── Chi sono, e cosa posso toccare ───────────────────────────── */

  app.get('/api/io', async (request, reply) => {
    const sessione = await leggiSessione(request);
    if (!sessione) return { autenticato: false, canali: [] };

    const accessi = await getPrisma()
      .twitchAccess.findMany({ where: { twitchUserId: sessione.twitchUserId } })
      .catch(() => []);

    const ids = [sessione.twitchUserId, ...accessi.map((a) => a.channelId)];
    const canali = await getPrisma()
      .twitchChannel.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          login: true,
          displayName: true,
          avatarUrl: true,
          enabled: true,
          connected: true,
          tokenFailedAt: true,
          guildId: true,
        },
      })
      .catch(() => []);

    void reply;
    return {
      autenticato: true,
      utente: {
        id: sessione.twitchUserId,
        login: sessione.login,
        nome: sessione.displayName,
        avatar: sessione.avatarUrl,
      },
      canali: canali.map((c) => ({
        ...c,
        ruolo:
          c.id === sessione.twitchUserId
            ? 'PROPRIETARIO'
            : (accessi.find((a) => a.channelId === c.id)?.role ?? 'LETTURA'),
        daRiautorizzare: c.tokenFailedAt !== null,
      })),
      livelli: DESCRIZIONE_LIVELLI,
    };
  });

  /* ── Configurazione ───────────────────────────────────────────── */

  app.get<{ Params: { id: string } }>('/api/canali/:id', async (request, reply) => {
    const sessione = await richiediSessione(request, reply);
    if (!sessione) return;

    const ruolo = await ruoloSu(sessione, request.params.id);
    if (!ruolo) return reply.code(404).send({ error: 'canale non trovato' });

    const canale = await getPrisma()
      .twitchChannel.findUnique({ where: { id: request.params.id } })
      .catch(() => null);
    if (!canale) return reply.code(404).send({ error: 'canale non trovato' });

    const vivo = opzioni.motore.registro.get(canale.id);

    return {
      id: canale.id,
      login: canale.login,
      nome: canale.displayName ?? canale.login,
      avatar: canale.avatarUrl,
      guildId: canale.guildId,
      ruolo,
      daRiautorizzare: canale.tokenFailedAt !== null,
      online: vivo?.online ?? false,
      scudoFinoA: vivo?.scudoFinoA ?? null,
      config: canale.config,
    };
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/canali/:id/config',
    async (request, reply) => {
      const sessione = await richiediSessione(request, reply);
      if (!sessione) return;

      const ruolo = await ruoloSu(sessione, request.params.id);
      if (!ruolo) return reply.code(404).send({ error: 'canale non trovato' });
      if (ruolo === 'LETTURA') return reply.code(403).send({ error: 'sola lettura' });

      const esito = TwitchChannelConfigSchema.safeParse(request.body);
      if (!esito.success) {
        return reply.code(400).send({
          error: 'configurazione non valida',
          dettagli: esito.error.issues.map((i) => ({
            campo: i.path.join('.'),
            problema: i.message,
          })),
        });
      }

      /*
       * Toccare un campo sposta il livello su PERSONALIZZATO.
       *
       * Altrimenti il pannello mentirebbe: direbbe «Normale» su una
       * configurazione che di normale non ha più niente, e la prossima
       * persona che legge quel valore trarrebbe la conclusione sbagliata.
       */
      const precedente = await getPrisma()
        .twitchChannel.findUnique({ where: { id: request.params.id }, select: { config: true } })
        .catch(() => null);

      const config = esito.data;
      if (
        precedente &&
        JSON.stringify(precedente.config) !== JSON.stringify(config) &&
        config.livello === (precedente.config as { livello?: string }).livello
      ) {
        const daLivello = applicaLivello(config.livello, config);
        if (JSON.stringify(daLivello) !== JSON.stringify(config)) config.livello = 'PERSONALIZZATO';
      }

      await getPrisma().twitchChannel.update({
        where: { id: request.params.id },
        data: { config },
      });

      opzioni.motore.registro.aggiorna(request.params.id, config);
      return { salvato: true, livello: config.livello };
    },
  );

  app.post<{ Params: { id: string }; Body: { livello?: string } }>(
    '/api/canali/:id/livello',
    async (request, reply) => {
      const sessione = await richiediSessione(request, reply);
      if (!sessione) return;

      const ruolo = await ruoloSu(sessione, request.params.id);
      if (!ruolo || ruolo === 'LETTURA') return reply.code(403).send({ error: 'non consentito' });

      const scelto = LivelloSicurezza.safeParse(request.body?.livello);
      if (!scelto.success) return reply.code(400).send({ error: 'livello sconosciuto' });

      const canale = opzioni.motore.registro.get(request.params.id);
      const config = applicaLivello(scelto.data, canale?.config);

      await getPrisma().twitchChannel.update({
        where: { id: request.params.id },
        data: { config },
      });
      opzioni.motore.registro.aggiorna(request.params.id, config);

      return { livello: config.livello, descrizione: DESCRIZIONE_LIVELLI[config.livello] };
    },
  );

  /* ── Registro ─────────────────────────────────────────────────── */

  app.get<{
    Params: { id: string };
    Querystring: { tipo?: string; modulo?: string; prima?: string; quanti?: string };
  }>('/api/canali/:id/eventi', async (request, reply) => {
    const sessione = await richiediSessione(request, reply);
    if (!sessione) return;

    const ruolo = await ruoloSu(sessione, request.params.id);
    if (!ruolo) return reply.code(404).send({ error: 'canale non trovato' });

    const quanti = Math.min(200, Math.max(1, Number(request.query.quanti) || 50));

    const eventi = await getPrisma().twitchEvent.findMany({
      where: {
        channelId: request.params.id,
        ...(request.query.tipo ? { type: request.query.tipo } : {}),
        ...(request.query.modulo ? { module: request.query.modulo } : {}),
        ...(request.query.prima ? { createdAt: { lt: new Date(request.query.prima) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: quanti,
    });

    // `id` è un BigInt: JSON non lo sa serializzare e la rotta risponderebbe
    // 500 senza dire quale campo lo ha fatto cadere.
    return eventi.map((evento) => ({ ...evento, id: evento.id.toString() }));
  });

  app.get<{ Params: { id: string } }>('/api/canali/:id/riassunto', async (request, reply) => {
    const sessione = await richiediSessione(request, reply);
    if (!sessione) return;
    if (!(await ruoloSu(sessione, request.params.id))) {
      return reply.code(404).send({ error: 'canale non trovato' });
    }

    const da = new Date(Date.now() - 7 * 86_400_000);
    const perModulo = await getPrisma().twitchEvent.groupBy({
      by: ['module'],
      where: { channelId: request.params.id, createdAt: { gte: da }, module: { not: null } },
      _count: { _all: true },
    });
    const perTipo = await getPrisma().twitchEvent.groupBy({
      by: ['type'],
      where: { channelId: request.params.id, createdAt: { gte: da } },
      _count: { _all: true },
    });

    return {
      da: da.toISOString(),
      moduli: perModulo.map((r) => ({ modulo: r.module, quanti: r._count._all })),
      tipi: perTipo.map((r) => ({ tipo: r.type, quanti: r._count._all })),
    };
  });

  /* ── Azioni ───────────────────────────────────────────────────── */

  app.post<{ Params: { id: string }; Body: { attivo?: boolean } }>(
    '/api/canali/:id/scudo',
    async (request, reply) => {
      const sessione = await richiediSessione(request, reply);
      if (!sessione) return;
      const ruolo = await ruoloSu(sessione, request.params.id);
      if (!ruolo || ruolo === 'LETTURA') return reply.code(403).send({ error: 'non consentito' });

      const canale = opzioni.motore.registro.get(request.params.id);
      if (!canale) return reply.code(409).send({ error: 'canale non collegato in questo momento' });

      await opzioni.motore.scudoDaPannello(canale, request.body?.attivo !== false);
      return { scudoFinoA: canale.scudoFinoA };
    },
  );

  /**
   * Stacca il canale.
   *
   * Revoca il token lato Twitch, non solo il nostro: lasciarlo valido
   * significherebbe che un'applicazione che lo streamer ha rimosso continua a
   * comparire fra quelle autorizzate nel suo account, con i permessi di
   * bandire chi vuole. La configurazione resta, così riautorizzare la
   * ritrova.
   */
  app.delete<{ Params: { id: string } }>('/api/canali/:id', async (request, reply) => {
    const sessione = await richiediSessione(request, reply);
    if (!sessione) return;
    if ((await ruoloSu(sessione, request.params.id)) !== 'PROPRIETARIO') {
      return reply.code(403).send({ error: 'solo chi possiede il canale può staccarlo' });
    }

    const canale = await getPrisma().twitchChannel.findUnique({
      where: { id: request.params.id },
      select: { tokenEnc: true },
    });

    await opzioni.motore.scollega(request.params.id);
    await getPrisma().twitchChannel.update({
      where: { id: request.params.id },
      data: { enabled: false, connected: false, tokenEnc: null, refreshEnc: null },
    });

    if (canale?.tokenEnc) {
      const { decrypt } = await import('../crypto.js');
      const chiaro = decrypt(canale.tokenEnc);
      if (chiaro) await revoca(opzioni.clientId, chiaro);
    }

    return { staccato: true };
  });

  /* ── Il pannello ──────────────────────────────────────────────── */

  const radice = path.resolve(here, '../../../web-twitch/dist');
  await app.register(staticPlugin, { root: radice, prefix: '/', wildcard: false });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'endpoint non trovato' });
    }
    return reply.sendFile('index.html');
  });

  await app.listen({ port: opzioni.porta, host: '0.0.0.0' });
  logger.info({ porta: opzioni.porta, publicUrl: opzioni.publicUrl }, 'pannello Twitch avviato');
  return app;
}
