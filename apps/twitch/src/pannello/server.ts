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
import { riversaFile } from '../archivio.js';
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

/**
 * La pagina che mostra i token dell'account bot.
 *
 * HTML scritto a mano e non una pagina del pannello React: si vede una volta
 * sola, prima che il bot esista, e deve funzionare anche se il pannello non è
 * stato compilato. `noindex` e `no-store` perché quello che c'è scritto non
 * deve finire in nessuna cache di nessun tipo.
 */
function paginaToken(
  utente: { id: string; login: string; display_name: string },
  token: { accessToken: string; refreshToken: string },
): string {
  const righe = [
    ['TWITCH_BOT_USER_ID', utente.id],
    ['TWITCH_BOT_LOGIN', utente.login],
    ['TWITCH_BOT_ACCESS_TOKEN', token.accessToken],
    ['TWITCH_BOT_REFRESH_TOKEN', token.refreshToken],
  ];

  const scappa = (testo: string): string =>
    testo.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

  return `<!doctype html>
<html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Credenziali del bot</title>
<style>
 body{margin:0;background:#0d0b14;color:#ece9f3;font:15px/1.6 system-ui,sans-serif;padding:2rem}
 main{max-width:44rem;margin:0 auto}
 h1{font-size:1.3rem;margin:0 0 .5rem}
 p{color:#9a92ad}
 pre{background:#1f1a2b;border:1px solid #2e2740;border-radius:12px;padding:1rem;overflow-x:auto;
     white-space:pre-wrap;word-break:break-all;font-size:13px}
 .avviso{border:1px solid rgba(248,113,113,.4);background:rgba(248,113,113,.1);
         border-radius:12px;padding:1rem;color:#f87171;margin:1.5rem 0}
 strong{color:#ece9f3}
</style></head><body><main>
<h1>Credenziali di <strong>${scappa(utente.display_name)}</strong></h1>
<p>Incolla queste quattro righe nel blocco <code>environment:</code> del compose, poi riavvia l'app.</p>
<pre>${righe.map(([nome, valore]) => `      ${nome}: '${scappa(valore ?? '')}'`).join('\n')}</pre>
<div class="avviso">
  <strong>Questa pagina non si ripete.</strong> I valori non sono salvati da nessuna parte: se
  chiudi senza copiarli, rifai il giro.<br><br>
  Chi ha questi token può scrivere in chat come il bot. Non passarli su canali che conservano i
  messaggi, e <strong>togli <code>TWITCH_SETUP_KEY</code> dal compose</strong> appena finito:
  finché c'è, chiunque la indovini può rifare questo giro.
</div>
</main></body></html>`;
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

  /**
   * Il flusso che raccoglie i token dell'**account del bot**.
   *
   * È il passaggio più scomodo dell'installazione, e finora la documentazione
   * si limitava a dire «ottienili con il flusso OAuth», che è come dire a
   * qualcuno di procurarsi una chiave inglese senza dirgli dove.
   *
   * Non è una rotta pubblica: risponde solo se `TWITCH_SETUP_KEY` è impostata
   * nel compose e la chiave nell'indirizzo combacia. Senza quella variabile
   * non esiste — 404, non 403, perché chi non deve saperlo non deve nemmeno
   * sapere che c'è qualcosa da indovinare.
   *
   * I token non vengono salvati da nessuna parte: si mostrano una volta, si
   * incollano nel compose, e la chiave di installazione si toglie.
   */
  app.get<{ Querystring: { chiave?: string } }>('/api/auth/bot', async (request, reply) => {
    const attesa = process.env.TWITCH_SETUP_KEY;
    if (!attesa || request.query.chiave !== attesa) {
      return reply.code(404).send({ error: 'endpoint non trovato' });
    }

    const stato = randomBytes(16).toString('base64url');
    void reply.setCookie('angel_stato', stato, {
      httpOnly: true,
      sameSite: 'lax',
      secure: sicuro,
      path: '/',
      maxAge: 600,
    });
    void reply.setCookie('angel_flusso', 'bot', {
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
        // Solo quello che serve a leggere e scrivere in chat. L'account del
        // bot non modera niente: i permessi di moderazione li dà lo streamer
        // sul proprio canale, ed è giusto che restino separati.
        ambiti: ['user:read:chat', 'user:write:chat', 'channel:bot'],
        forzaConferma: true,
      }),
    );
  });

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
      const flusso = request.cookies.angel_flusso;
      void reply.clearCookie('angel_stato', { path: '/' });
      void reply.clearCookie('angel_flusso', { path: '/' });

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
       * Flusso dell'account bot: si mostrano i valori e non si salva niente.
       *
       * Salvarli sarebbe più comodo e sbagliato: sono le credenziali di un
       * account, non di un canale, e devono stare nel compose insieme alle
       * altre — dove chi fa un trasloco le trova, e dove il kit di trasloco le
       * legge. In un database sarebbero l'unica credenziale che sopravvive al
       * compose e sparisce con il volume.
       */
      if (flusso === 'bot') {
        return reply.type('text/html; charset=utf-8').send(paginaToken(utente, token));
      }

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

  /**
   * Collega il canale a un server Discord.
   *
   * Sta qui e non fra i comandi Discord perché qui chi la chiama ha dimostrato
   * di possedere il canale entrando con Twitch. Dall'altra parte l'unica prova
   * sarebbe «amministro un server», che non dice niente su chi possiede il
   * canale — e permetterebbe di dirottare altrove gli avvisi di moderazione di
   * qualcun altro.
   */
  app.put<{ Params: { id: string }; Body: { guildId?: string | null } }>(
    '/api/canali/:id/discord',
    async (request, reply) => {
      const sessione = await richiediSessione(request, reply);
      if (!sessione) return;
      if ((await ruoloSu(sessione, request.params.id)) !== 'PROPRIETARIO') {
        return reply.code(403).send({ error: 'solo chi possiede il canale può collegarlo' });
      }

      const grezzo = (request.body?.guildId ?? '').trim();

      // Vuoto scollega. Un identificativo Discord è uno snowflake a 17-20
      // cifre: chi incolla un invito o il nome del server se ne accorge subito
      // invece di trovarsi un registro che non arriva mai.
      if (grezzo && !/^\d{17,20}$/.test(grezzo)) {
        return reply.code(400).send({
          error:
            'identificativo del server non valido: sono 17-20 cifre. Su Discord si copia con ' +
            '/twitch collega, oppure con il tasto destro sul nome del server.',
        });
      }

      const guildId = grezzo || null;

      await getPrisma().twitchChannel.update({
        where: { id: request.params.id },
        data: { guildId },
      });

      const canale = opzioni.motore.registro.get(request.params.id);
      if (canale) canale.guildId = guildId;

      logger.info(
        { canale: request.params.id, guildId, da: sessione.login },
        guildId ? 'canale collegato a un server Discord' : 'canale scollegato da Discord',
      );

      return { guildId };
    },
  );

  /* ── Chi può entrare nel pannello di questo canale ────────────── */

  app.get<{ Params: { id: string } }>('/api/canali/:id/accessi', async (request, reply) => {
    const sessione = await richiediSessione(request, reply);
    if (!sessione) return;
    if (!(await ruoloSu(sessione, request.params.id))) {
      return reply.code(404).send({ error: 'canale non trovato' });
    }

    return getPrisma().twitchAccess.findMany({
      where: { channelId: request.params.id },
      orderBy: { createdAt: 'asc' },
    });
  });

  /**
   * Aggiunge qualcuno al pannello.
   *
   * Solo il proprietario, e non i moderatori che ha già aggiunto: un
   * moderatore che può nominare altri moderatori è un moderatore che può
   * regalare il canale a chiunque, e lo streamer se ne accorgerebbe dopo.
   */
  app.post<{ Params: { id: string }; Body: { login?: string; ruolo?: string } }>(
    '/api/canali/:id/accessi',
    async (request, reply) => {
      const sessione = await richiediSessione(request, reply);
      if (!sessione) return;
      if ((await ruoloSu(sessione, request.params.id)) !== 'PROPRIETARIO') {
        return reply.code(403).send({ error: 'solo chi possiede il canale può dare accesso' });
      }

      const login = (request.body?.login ?? '').trim().toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{3,25}$/.test(login)) {
        return reply.code(400).send({ error: 'login Twitch non valido' });
      }

      const ruolo = request.body?.ruolo === 'LETTURA' ? 'LETTURA' : 'MODERATORE';

      const utenti = await opzioni.motore.helix.utenti([login]).catch(() => []);
      const utente = utenti[0];
      if (!utente) return reply.code(404).send({ error: `nessun account Twitch «${login}»` });

      if (utente.id === request.params.id) {
        return reply.code(400).send({ error: 'il proprietario ha già accesso' });
      }

      await getPrisma().twitchAccess.upsert({
        where: {
          channelId_twitchUserId: { channelId: request.params.id, twitchUserId: utente.id },
        },
        create: {
          channelId: request.params.id,
          twitchUserId: utente.id,
          login: utente.login,
          role: ruolo,
        },
        update: { role: ruolo, login: utente.login },
      });

      logger.info(
        { canale: request.params.id, a: utente.login, ruolo, da: sessione.login },
        'accesso al pannello concesso',
      );
      return { login: utente.login, ruolo };
    },
  );

  app.delete<{ Params: { id: string; utenteId: string } }>(
    '/api/canali/:id/accessi/:utenteId',
    async (request, reply) => {
      const sessione = await richiediSessione(request, reply);
      if (!sessione) return;
      if ((await ruoloSu(sessione, request.params.id)) !== 'PROPRIETARIO') {
        return reply.code(403).send({ error: 'solo chi possiede il canale può togliere accesso' });
      }

      await getPrisma()
        .twitchAccess.deleteMany({
          where: { channelId: request.params.id, twitchUserId: request.params.utenteId },
        })
        .catch(() => undefined);

      return { tolto: true };
    },
  );

  /**
   * Rimette nel database il registro di un giorno rimasto solo su disco.
   *
   * Serve dopo un guasto: senza, il pannello ha un buco esattamente nelle ore
   * in cui è successo qualcosa, che sono le sole in cui a qualcuno verrà in
   * mente di guardarlo. Non è automatico di proposito — rileggere giorni di
   * file significa scrivere decine di migliaia di righe, e farlo da soli
   * all'avvio dopo un guasto vorrebbe dire caricare il database proprio mentre
   * si sta riprendendo.
   */
  app.post<{ Params: { id: string }; Body: { giorno?: string } }>(
    '/api/canali/:id/riversa',
    async (request, reply) => {
      const sessione = await richiediSessione(request, reply);
      if (!sessione) return;
      const ruolo = await ruoloSu(sessione, request.params.id);
      if (!ruolo || ruolo === 'LETTURA') return reply.code(403).send({ error: 'non consentito' });

      const giorno = request.body?.giorno ?? new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(giorno)) {
        return reply.code(400).send({ error: 'la data va scritta come AAAA-MM-GG' });
      }

      const canale = opzioni.motore.registro.get(request.params.id);
      if (!canale) return reply.code(409).send({ error: 'canale non collegato in questo momento' });

      const esito = await riversaFile(canale.id, canale.login, giorno);
      return { giorno, ...esito };
    },
  );

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
