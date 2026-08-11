/* ═══════════════════════════════════════════════════════════════════════
   FILTRO DEL LINGUAGGIO

   Valuta il testo di un messaggio contro l'elenco configurato e decide la
   risposta. Il riconoscimento vero — normalizzazione, forme elusive,
   eccezioni — sta in `@angel/scanner`, dove è una funzione pura e collaudata
   senza bisogno di Discord.

   ── Come si risponde, e perché così ──────────────────────────────────────

   La prima versione usava la sola scala a punteggio, e aveva due difetti che
   si vedevano subito usandola.

   Il primo: una parolaccia lieve valeva 15 punti e il primo gradino stava a
   30, quindi **non succedeva niente**. Chi la scriveva vedeva il messaggio
   restare lì e concludeva, ragionevolmente, che il filtro fosse rotto.

   Il secondo, peggiore: la scala applica **un solo** gradino, il più alto
   raggiunto. Un insulto da 40 punti finiva sull'eliminazione; uno grave da 75
   finiva sull'avvertimento — che non elimina. Più l'offesa era grave, più il
   messaggio restava pubblicato.

   Ora la risposta è divisa in due parti indipendenti.

   **Il messaggio si rimuove sempre.** Non è una sanzione ed è ciò che serve
   per primo: finché la frase è lì, continua a fare quello che faceva. Non
   dipende dal punteggio, dalla recidiva o da quanto era grave.

   **La sanzione cresce sulle recidive.** Chi sbaglia una volta si vede
   rimuovere il messaggio e nient'altro; chi continua viene avvertito, poi
   silenziato, con una durata proporzionale alla gravità di ciò che ha
   scritto. È l'unica progressione che distingue la parola sfuggita dal
   comportamento — e la distinzione conta, perché sanzionare la prima produce
   risentimento e non sanzionare il secondo produce un canale invivibile.
   ═══════════════════════════════════════════════════════════════════════ */

import type { Message } from 'discord.js';
import { scanLanguage, type LanguageSeverity } from '@angel/scanner';
import type { Decision, DecisionAction, GuildConfig } from '@angel/shared';
import { getRedis } from '../core/redis.js';
import { isExempt } from '../core/permissions.js';

/** Contatore delle infrazioni recenti, per utente e per server. */
const chiaveRecidiva = (guildId: string, userId: string): string =>
  `lang:strike:${guildId}:${userId}`;

/**
 * Il messaggio è rivolto a qualcuno?
 *
 * Menzionare una persona o rispondere al suo messaggio è ciò che distingue
 * l'imprecazione dall'aggressione. Le menzioni di ruolo non contano: chi
 * scrive «@moderatori questo è uno schifo» sta protestando, non insultando
 * una persona.
 */
function isTargeted(message: Message): boolean {
  if (message.mentions.users.size > 0) return true;
  return message.reference?.messageId != null;
}

/** La gravità più alta fra quelle trovate: decide la durata del silenziamento. */
function peggiore(severita: LanguageSeverity[]): LanguageSeverity {
  if (severita.includes('GRAVE')) return 'GRAVE';
  if (severita.includes('MEDIA')) return 'MEDIA';
  return 'LIEVE';
}

export async function evaluateLanguage(
  message: Message,
  config: GuildConfig,
): Promise<Decision | null> {
  const settings = config.security.language;
  if (!settings.enabled) return null;
  if (!message.content) return null;
  if (settings.exemptChannelIds.includes(message.channelId)) return null;
  if (message.member && isExempt(message.member, settings.exemptions)) return null;

  const esito = scanLanguage(
    message.content,
    {
      terms: settings.terms,
      categories: settings.categories,
      allowlist: settings.allowlist,
      weights: settings.weights,
      targetedBonus: settings.targetedBonus,
    },
    { targeted: isTargeted(message) },
  );

  if (esito.matches.length === 0) return null;

  /* ── Recidiva ──────────────────────────────────────────────────────────
     Un contatore per persona che si azzera da solo. La finestra scorre: chi
     ha detto una parolaccia il mese scorso ricomincia da capo, perché una
     memoria che non dimentica trasforma un errore vecchio in una condanna
     permanente. */
  let infrazioni = 1;
  if (settings.recidiva.enabled && message.guild) {
    const redis = getRedis();
    const key = chiaveRecidiva(message.guild.id, message.author.id);
    infrazioni = await redis
      .incr(key)
      .then(async (valore) => {
        // La scadenza si rinnova a ogni infrazione: la finestra è «dall'ultima
        // volta», non «dalla prima». Chi continua non esce dal conteggio solo
        // perché il primo episodio è ormai lontano.
        await redis.expire(key, settings.recidiva.finestraMinuti * 60).catch(() => undefined);
        return valore;
      })
      .catch(() => 1);
  }

  const gravita = peggiore(esito.matches.map((match) => match.severity));

  /* ── Azioni ────────────────────────────────────────────────────────────
     L'eliminazione è la prima e non dipende da nulla. La sanzione, se c'è,
     viene dopo. */
  const azioni: DecisionAction[] = [];
  const motivo = esito.targeted
    ? 'Linguaggio offensivo rivolto a un membro'
    : 'Linguaggio non consentito';

  if (settings.rimuoviSempre) {
    azioni.push({ kind: 'DELETE_MESSAGE', reason: motivo });
  }

  const gradino = [...settings.recidiva.scala]
    .filter((passo) => infrazioni >= passo.infrazioni)
    .sort((a, b) => b.infrazioni - a.infrazioni)[0];

  if (gradino && gradino.action !== 'NONE') {
    // La durata di base si moltiplica per la gravità: la stessa recidiva vale
    // dieci minuti per una parolaccia e quaranta per un insulto razzista.
    const moltiplicatore = settings.recidiva.moltiplicatori[gravita];
    azioni.push({
      kind: gradino.action,
      durationSec: Math.round(gradino.durationSec * moltiplicatore),
      reason: `${motivo} · ${infrazioni}ª volta in ${settings.recidiva.finestraMinuti} minuti`,
    });
  }

  if (azioni.length === 0) return null;

  const conteggio = esito.matches.reduce<Record<string, number>>((conto, match) => {
    conto[match.category] = (conto[match.category] ?? 0) + 1;
    return conto;
  }, {});

  return {
    module: 'linguaggio',
    triggered: true,
    score: esito.score,
    logEvent: 'AUTOMOD_TRIGGERED',
    reasons: [
      {
        code: 'LINGUAGGIO',
        score: esito.score,
        // Le parole trovate finiscono nel registro ma non nell'avviso
        // pubblico: ripetere l'insulto in chat per dire che l'insulto non si
        // può dire è un modo curioso di moderare.
        detail:
          `${esito.matches.length} espression${esito.matches.length === 1 ? 'e' : 'i'} ` +
          `(${Object.entries(conteggio)
            .map(([categoria, quante]) => `${quante} ${categoria.toLowerCase()}`)
            .join(', ')})` +
          (esito.targeted ? ', rivolte a una persona' : '') +
          (infrazioni > 1
            ? ` · ${infrazioni}ª volta in ${settings.recidiva.finestraMinuti} min`
            : ''),
      },
    ],
    actions: azioni,
  };
}
