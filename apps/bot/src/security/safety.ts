import type { Client, Message } from 'discord.js';
import { normalize, noDecision, type Decision, type GuildConfig, type Reason } from '@angel/shared';
import { isExempt } from '../core/permissions.js';
import { recordEvent } from '../logging/auditLogger.js';

/* ═══════════════════════════════════════════════════════════════════════
   TUTELA DEGLI UTENTI

   Due ambiti che il bot può realmente coprire, e uno che non può.

   Può: riconoscere i link che raccolgono l'indirizzo IP (usati per le
   ritorsioni DDoS nate dai litigi in chat) e notare, nei canali pubblici, gli
   schemi di avvicinamento tipici dell'adescamento — la richiesta di spostarsi
   in privato unita a domande sull'età.

   Non può: leggere i messaggi privati. Il grooming e la sextortion si
   consumano quasi interamente lì. Ciò che resta è intercettare il *primo*
   passo, quello pubblico, e dare allo staff un canale di segnalazione con le
   prove già congelate. Va detto senza indorare la pillola: questa non è una
   protezione completa, è un allarme precoce.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Schemi di avvicinamento. Ogni riga, presa da sola, è innocua: la soglia
 * scatta solo con la combinazione, e l'esito è una segnalazione allo staff —
 * mai una sanzione automatica. Un falso positivo qui costa molto più caro di
 * un falso negativo altrove.
 */
const GROOMING_SIGNALS: { re: RegExp; label: string; score: number }[] = [
  { re: /\bquanti anni hai\b|\bhow old are you\b|\bwhat'?s your age\b/i, label: 'richiesta di età', score: 25 },
  { re: /\bsei minorenne\b|\bare you (a )?minor\b|\bunder ?18\b/i, label: 'riferimento alla minore età', score: 30 },
  { re: /\bscrivimi in (privato|dm)\b|\bdm me\b|\bmessage me privately\b|\bin privato\b/i, label: 'invito a spostarsi in privato', score: 20 },
  { re: /\bnon dirlo a nessuno\b|\bdon'?t tell (anyone|your parents)\b|\bè un segreto\b/i, label: 'richiesta di segretezza', score: 40 },
  { re: /\bmandami una foto\b|\bsend (me )?(a )?(pic|photo|selfie)\b|\bfoto tua\b/i, label: 'richiesta di foto', score: 35 },
  { re: /\bsei sola\b|\bsei solo a casa\b|\bare you (home )?alone\b/i, label: 'verifica di isolamento', score: 35 },
  { re: /\bsnap(chat)?\b.{0,20}\b(aggiungimi|add me)\b/i, label: 'spostamento su altra piattaforma', score: 20 },
  { re: /\bregalo\b.{0,30}\b(nitro|robux|vbucks|gift card)\b.{0,40}\b(se|if)\b/i, label: 'offerta condizionata di regali', score: 30 },
];

export async function evaluateSafety(
  client: Client,
  message: Message,
  config: GuildConfig,
): Promise<Decision> {
  const settings = config.security.safety;
  if (!settings.enabled || !message.guild || message.author.bot) return noDecision('safety');
  if (isExempt(message.member, settings.exemptions, message.channelId)) return noDecision('safety');

  const content = message.content ?? '';
  if (!content.trim()) return noDecision('safety');

  const reasons: Reason[] = [];

  /* ── Link raccolta IP ──────────────────────────────────────────────── */
  if (settings.blockIpGrabbers) {
    const haystack = normalize(content);
    const found = settings.ipGrabberDomains.filter((domain) => haystack.includes(normalize(domain)));
    if (found.length > 0) {
      reasons.push({
        code: 'SAFE_IP_GRABBER',
        detail:
          `Link a un servizio di raccolta IP: ${found.join(', ')}. ` +
          'Chi lo apre consegna il proprio indirizzo, che viene poi usato per attacchi DDoS o doxxing.',
        score: 75,
        meta: { domains: found },
      });
    }
  }

  /* ── Schemi di adescamento ─────────────────────────────────────────── */
  if (settings.groomingPatterns) {
    const matched = GROOMING_SIGNALS.filter(({ re }) => re.test(content));
    // Un solo segnale non basta: "quanti anni hai" è una domanda normale.
    if (matched.length >= 2) {
      const score = Math.min(
        90,
        matched.reduce((total, signal) => total + signal.score, 0),
      );
      reasons.push({
        code: 'SAFE_GROOMING',
        detail: `Schema di avvicinamento sospetto: ${matched.map((m) => m.label).join(', ')}`,
        score,
        meta: { signals: matched.map((m) => m.label) },
      });

      await reportToStaff(client, message, config, matched.map((m) => m.label));
    }
  }

  if (reasons.length === 0) return noDecision('safety');

  const hasGrabber = reasons.some((reason) => reason.code === 'SAFE_IP_GRABBER');
  const score = Math.min(
    100,
    reasons.reduce((total, reason) => total + reason.score, 0),
  );

  return {
    module: 'safety',
    triggered: true,
    score,
    reasons,
    // Sull'adescamento non si sanziona in automatico: si elimina il contenuto
    // solo se c'è un link grabber, altrimenti decide una persona.
    actions: hasGrabber
      ? [{ kind: 'DELETE_MESSAGE', reason: 'Link di raccolta IP' }]
      : [{ kind: 'ALERT_STAFF', reason: 'Possibile adescamento: valutazione umana necessaria' }],
    logEvent: hasGrabber ? 'SECURITY_IP_GRABBER' : 'SECURITY_GROOMING_SUSPECTED',
  };
}

/**
 * Segnalazione con prove congelate.
 *
 * Il contenuto viene copiato nel messaggio di segnalazione perché l'autore può
 * cancellarlo in qualsiasi momento — e di norma lo fa appena si accorge di
 * essere stato notato.
 */
async function reportToStaff(
  client: Client,
  message: Message,
  config: GuildConfig,
  signals: string[],
): Promise<void> {
  const settings = config.security.safety;
  const channelId = settings.reportChannelId ?? config.general.alertChannelId;
  if (!channelId) return;

  // Il ruolo di escalation viene menzionato direttamente nel canale delle
  // segnalazioni: un sospetto adescamento non può aspettare che qualcuno passi
  // di lì per caso, e il canale di sicurezza generale è spesso silenziato.
  if (settings.escalationRoleId) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased() && 'send' in channel) {
      await channel
        .send({
          content:
            `<@&${settings.escalationRoleId}> — segnalazione urgente in <#${message.channelId}>, ` +
            'dettagli qui sotto.',
          allowedMentions: { roles: [settings.escalationRoleId] },
        })
        .catch(() => undefined);
    }
  }

  await recordEvent(client, {
    guildId: message.guild!.id,
    type: 'SECURITY_GROOMING_SUSPECTED',
    actorId: message.author.id,
    actorTag: message.author.tag,
    channelId: message.channelId,
    messageId: message.id,
    severity: 90,
    automated: true,
    summary:
      `🚨 **Possibile adescamento** in <#${message.channelId}>\n` +
      `Autore: <@${message.author.id}> (${message.author.tag})\n` +
      `Segnali: ${signals.join(', ')}\n\n` +
      '**Nessuna azione automatica è stata applicata**: serve una valutazione umana.\n' +
      'Se il sospetto è fondato, segnala a Discord (Trust & Safety) e alle autorità competenti. ' +
      'Non contattare la persona segnalata prima di aver raccolto le prove.',
    fields: settings.preserveEvidence
      ? [
          {
            name: 'Contenuto del messaggio (copia conservata)',
            value: `\`\`\`\n${(message.content ?? '').slice(0, 900)}\n\`\`\``,
          },
        ]
      : undefined,
    payload: { signals, content: settings.preserveEvidence ? message.content?.slice(0, 2000) : undefined },
  });
}
