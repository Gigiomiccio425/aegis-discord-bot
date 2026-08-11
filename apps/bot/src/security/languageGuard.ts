/* ═══════════════════════════════════════════════════════════════════════
   FILTRO DEL LINGUAGGIO

   Valuta il testo di un messaggio contro l'elenco configurato e restituisce
   una decisione. Il riconoscimento vero — normalizzazione, forme elusive,
   eccezioni — sta in `@angel/scanner`, dove è una funzione pura e collaudata
   senza bisogno di Discord.

   Qui resta solo ciò che richiede il contesto: chi ha scritto, dov'è, e se il
   messaggio era rivolto a qualcuno.
   ═══════════════════════════════════════════════════════════════════════ */

import type { Message } from 'discord.js';
import { scanLanguage } from '@angel/scanner';
import { decide, type Decision, type GuildConfig } from '@angel/shared';
import { isExempt } from '../core/permissions.js';

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

  const gravita = esito.matches.reduce<Record<string, number>>((conto, match) => {
    conto[match.severity] = (conto[match.severity] ?? 0) + 1;
    return conto;
  }, {});

  // Il punteggio è già stato calcolato dallo scanner, che conosce i pesi e il
  // supplemento per gli insulti rivolti: si passa come motivo unico, così la
  // scala di risposta lo riceve intatto invece di ricomporlo da capo.
  return decide(
    'linguaggio',
    [
      {
        code: 'LINGUAGGIO',
        score: esito.score,
        // Le parole trovate finiscono nel registro ma non nell'avviso
        // pubblico: ripetere l'insulto in chat per dire che l'insulto non si
        // può dire è un modo curioso di moderare.
        detail:
          `${esito.matches.length} espression${esito.matches.length === 1 ? 'e segnalata' : 'i segnalate'}` +
          (esito.targeted ? ', rivolte a una persona' : '') +
          ` (${Object.entries(gravita)
            .map(([severita, quante]) => `${quante} ${severita.toLowerCase()}`)
            .join(', ')})`,
      },
    ],
    settings.ladder,
    'AUTOMOD_TRIGGERED',
  );
}
