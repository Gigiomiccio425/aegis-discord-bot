/* ═══════════════════════════════════════════════════════════════════════
   ANTI-FLAME

   Il filtro delle parole guarda un messaggio alla volta. Il flame non è un
   messaggio: è uno scambio.

   La letteratura sul tema converge su tre osservazioni che qui diventano
   codice. La prima: **una sola inciviltà basta a innescare una discussione
   che degenera**, e da lì la spirale si autoalimenta — ogni risposta è
   difensiva, ognuno risponde all'ultimo colpo. La seconda: chi assiste smette
   di partecipare, e il canale resta alle voci più aggressive. La terza, la più
   utile: la **de-escalation funziona meglio della punizione** — interrompere
   il ritmo, far passare qualche minuto, invitare a riformulare.

   Da qui la scelta che governa questo modulo: la prima risposta non è una
   sanzione, è un rallentamento del canale. Silenziare i due che litigano
   punisce chi ha risposto quanto chi ha cominciato, e non impedisce che
   ricomincino altrove; rallentare il canale toglie invece proprio ciò di cui
   la spirale si nutre, che è la rapidità.

   Le sanzioni individuali restano, ma dopo — e solo per chi continua.
   ═══════════════════════════════════════════════════════════════════════ */

import { ChannelType, type Message, type TextChannel } from 'discord.js';
import { normalize } from '@angel/shared';
import type { GuildConfig } from '@angel/shared';
import { getRedis } from '../core/redis.js';
import { childLogger } from '../core/logger.js';
import { recordEvent } from '../logging/auditLogger.js';
import { isExempt } from '../core/permissions.js';

const log = childLogger('flame');

const chiave = (guildId: string, channelId: string): string => `flame:${guildId}:${channelId}`;
const raffreddamento = (channelId: string): string => `flame:cooldown:${channelId}`;

interface Voce {
  userId: string;
  /** Quanto quel messaggio era ostile, 0-100. */
  punteggio: number;
  /** A chi era rivolto, se a qualcuno. */
  bersaglio: string | null;
  quando: number;
}

/*
 * Aggressione in seconda persona.
 *
 * È il segnale che distingue «che schifo di partita» da «fai schifo». Nessuna
 * delle due contiene un insulto dell'elenco, ma solo la seconda è rivolta a
 * una persona — e il flame vive lì.
 *
 * Le espressioni sono volutamente poche e inequivocabili: allargarle
 * significherebbe segnalare conversazioni normali, e un rallentamento del
 * canale imposto a chi stava discutendo civilmente è esattamente il modo di
 * far togliere il modulo.
 */
const SECONDA_PERSONA = [
  /\bsei un(?:a|o)?\b/,
  /\bsei propri(?:o|a)\b/,
  /\bfai schifo\b/,
  /\bfai pena\b/,
  /\bnon capisci\b/,
  /\bnon sai\b.{0,15}\bniente\b/,
  /\bstai zitt(?:o|a)\b/,
  /\bchiudi\b.{0,10}\bbocca\b/,
  /\bvai a\b.{0,12}(?:cagare|quel paese|farti)/,
  /\bma chi (?:sei|ti credi)\b/,
  /\bimpara a\b/,
  /\bpatetic(?:o|a)\b/,
  /\bridicol(?:o|a)\b/,
];

function segnaliDiOstilita(message: Message): { punteggio: number; motivi: string[] } {
  const testo = normalize(message.content ?? '');
  if (!testo) return { punteggio: 0, motivi: [] };

  const motivi: string[] = [];
  let punteggio = 0;

  const secondaPersona = SECONDA_PERSONA.some((schema) => schema.test(testo));
  if (secondaPersona) {
    punteggio += 30;
    motivi.push('rivolto direttamente a una persona');
  }

  // Le maiuscole contano solo insieme a qualcos'altro: un messaggio urlato e
  // basta è maleducazione, non un litigio.
  const lettere = (message.content ?? '').replace(/[^a-zA-Z]/g, '');
  if (lettere.length >= 15) {
    const maiuscole = lettere.replace(/[^A-Z]/g, '').length / lettere.length;
    if (maiuscole > 0.7 && secondaPersona) {
      punteggio += 15;
      motivi.push('urlato');
    }
  }

  if (message.mentions.users.size > 0 && secondaPersona) {
    punteggio += 15;
    motivi.push('con menzione del destinatario');
  }

  return { punteggio, motivi };
}

/**
 * Registra il messaggio e valuta se lo scambio sta degenerando.
 *
 * `punteggioLingua` arriva dal filtro delle parole: se quel messaggio conteneva
 * un insulto, pesa qui senza doverlo cercare una seconda volta.
 */
export async function trackFlame(
  message: Message,
  config: GuildConfig,
  punteggioLingua = 0,
): Promise<void> {
  const settings = config.security.flame;
  if (!settings.enabled || !message.guild || !message.member) return;
  if (settings.exemptChannelIds.includes(message.channelId)) return;
  if (isExempt(message.member, settings.exemptions)) return;

  const segnali = segnaliDiOstilita(message);
  const punteggio = Math.min(100, segnali.punteggio + punteggioLingua);
  if (punteggio < settings.sogliaMessaggio) return;

  const redis = getRedis();
  const key = chiave(message.guild.id, message.channelId);
  const adesso = Date.now();

  const voce: Voce = {
    userId: message.author.id,
    punteggio,
    bersaglio: message.mentions.users.first()?.id ?? null,
    quando: adesso,
  };

  await redis.zadd(key, adesso, JSON.stringify(voce)).catch(() => undefined);
  await redis.expire(key, settings.finestraSec * 2).catch(() => undefined);

  const grezze = await redis
    .zrangebyscore(key, adesso - settings.finestraSec * 1000, adesso)
    .catch(() => [] as string[]);

  const voci: Voce[] = grezze
    .map((riga) => {
      try {
        return JSON.parse(riga) as Voce;
      } catch {
        return null;
      }
    })
    .filter((riga): riga is Voce => riga !== null);

  const partecipanti = new Set(voci.map((riga) => riga.userId));

  // Due condizioni insieme, e nessuna delle due basta da sola: **almeno due
  // persone** — altrimenti è uno che si sfoga, non un litigio — e abbastanza
  // messaggi ostili ravvicinati da configurare uno scambio e non un episodio.
  if (partecipanti.size < 2 || voci.length < settings.messaggiPerScatto) return;

  const gia = await redis.exists(raffreddamento(message.channelId)).catch(() => 0);
  if (gia === 1) return;

  await deEscalate(message, config, [...partecipanti], voci.length);
}

/**
 * Interviene sul canale, non sulle persone.
 *
 * La modalità lenta è reversibile, non lascia un provvedimento sul profilo di
 * nessuno e non richiede di stabilire chi ha cominciato — cosa che, in una
 * discussione degenerata, di solito non si può stabilire affatto.
 */
async function deEscalate(
  message: Message,
  config: GuildConfig,
  partecipanti: string[],
  quanti: number,
): Promise<void> {
  const settings = config.security.flame;
  const canale = message.channel as TextChannel;
  const redis = getRedis();

  // Il raffreddamento si segna **prima** di agire: se due messaggi arrivano
  // nello stesso istante, il secondo trova la chiave e non ripete l'intervento.
  await redis
    .set(raffreddamento(message.channelId), '1', 'EX', settings.raffreddamentoSec)
    .catch(() => undefined);

  const precedente = canale.rateLimitPerUser ?? 0;

  if (settings.rallentaCanale && canale.type === ChannelType.GuildText && !config.general.dryRun) {
    await canale
      .setRateLimitPerUser(
        Math.max(precedente, settings.slowmodeSec),
        'Discussione accesa: rallentamento temporaneo',
      )
      .catch((errore: unknown) => log.debug({ err: errore }, 'modalità lenta non applicata'));

    // Ripristino programmato. Non sopravvive a un riavvio, ed è accettabile:
    // il danno di una modalità lenta rimasta accesa è un fastidio, mentre
    // tenere uno stato persistente per questo costerebbe più di quanto valga.
    setTimeout(
      () => {
        void canale
          .setRateLimitPerUser(precedente, 'Fine del rallentamento temporaneo')
          .catch(() => undefined);
      },
      settings.durataSlowmodeSec * 1000,
    ).unref?.();
  }

  if (settings.avvisaInCanale && !config.general.dryRun) {
    const avviso = await canale
      .send({
        content: settings.messaggio.replace(
          '{secondi}',
          String(settings.rallentaCanale ? settings.slowmodeSec : 0),
        ),
        allowedMentions: { parse: [] },
      })
      .catch(() => null);

    if (avviso && settings.cancellaAvvisoSec > 0) {
      setTimeout(() => {
        void avviso.delete().catch(() => undefined);
      }, settings.cancellaAvvisoSec * 1000).unref?.();
    }
  }

  await recordEvent(message.client, {
    guildId: message.guild!.id,
    type: 'SECURITY_FLAME_DETECTED',
    channelId: message.channelId,
    severity: 55,
    automated: true,
    summary:
      `🔥 **Discussione accesa** in <#${message.channelId}>\n` +
      `${partecipanti.length} persone, ${quanti} messaggi ostili nella finestra.\n` +
      (settings.rallentaCanale
        ? `Modalità lenta a ${settings.slowmodeSec}s per ${Math.round(settings.durataSlowmodeSec / 60)} minuti.`
        : 'Nessun rallentamento applicato: è disattivato.'),
    payload: { partecipanti, messaggiOstili: quanti },
  });
}
