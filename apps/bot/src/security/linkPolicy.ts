import { ChannelType, type Message, type TextChannel } from 'discord.js';
import type { GuildConfig } from '@angel/shared';
import { isExempt } from '../core/permissions.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('linkPolicy');

/* ═══════════════════════════════════════════════════════════════════════
   LINK E GIF: DOVE SÌ E DOVE NO

   Non è una difesa. Un link malevolo lo ferma lo scanner, e lo ferma in ogni
   canale; qui si applica una regola redazionale — il canale annunci che non
   deve riempirsi di link, la chat che non deve diventare un muro di GIF.

   La distinzione conta nel modo di intervenire: chi incolla un link nel canale
   sbagliato non è un aggressore. Il messaggio viene tolto con una spiegazione,
   senza punteggi di rischio e senza sanzioni che si accumulano — motivo per cui
   questo modulo non passa dall'esecutore delle decisioni come gli altri.
   ═══════════════════════════════════════════════════════════════════════ */

const URL_PATTERN = /https?:\/\/[^\s<>]+/gi;

/** Host che servono GIF: il messaggio le mostra come tali anche senza allegato. */
const HOST_GIF = ['tenor.com', 'giphy.com', 'gfycat.com', 'imgur.com/gallery'];

interface Contenuto {
  link: string[];
  gif: boolean;
}

function leggiContenuto(message: Message): Contenuto {
  URL_PATTERN.lastIndex = 0;
  const link = [...(message.content ?? '').matchAll(URL_PATTERN)].map((match) => match[0]);

  const gifDaAllegato = message.attachments.some(
    (allegato) =>
      allegato.contentType === 'image/gif' || allegato.name?.toLowerCase().endsWith('.gif'),
  );

  // Gli embed arrivano dopo la pubblicazione, quindi non sempre ci sono al
  // momento del controllo: l'host nel link resta il segnale più affidabile.
  const gifDaEmbed = message.embeds.some((embed) => embed.data.type === 'gifv');
  const gifDaLink = link.some((url) => HOST_GIF.some((host) => url.toLowerCase().includes(host)));

  return { link, gif: gifDaAllegato || gifDaEmbed || gifDaLink };
}

export interface RegoleLink {
  linkChannelIds: string[];
  gifChannelIds: string[];
  alwaysAllowedDomains: string[];
}

/**
 * La decisione, separata da Discord perché è la parte che si può sbagliare.
 *
 * Qui si cancellano messaggi di persone che non hanno fatto niente di male:
 * un errore di logica non produce un allarme, produce un canale in cui non si
 * riesce a scrivere e nessuno capisce perché.
 */
export function decidi(
  contenuto: Contenuto & { canaleId: string },
  regole: RegoleLink,
): { cosa: string; consentiti: string[] } | null {
  // Un link a Tenor *è* una GIF: contarlo anche come link lo farebbe togliere
  // dal canale delle GIF, cioè esattamente dove è consentito metterlo.
  // I domini sempre ammessi escono di scena qui: se restano solo quelli, non
  // c'è più niente da valutare come link.
  const linkVeri = contenuto.link
    .filter((url) => !HOST_GIF.some((host) => url.toLowerCase().includes(host)))
    .filter(
      (url) =>
        !regole.alwaysAllowedDomains.some((dominio) =>
          dominioDi(url).endsWith(dominio.toLowerCase()),
        ),
    );

  const gifVietate =
    contenuto.gif &&
    regole.gifChannelIds.length > 0 &&
    !regole.gifChannelIds.includes(contenuto.canaleId);
  const linkVietati =
    linkVeri.length > 0 &&
    regole.linkChannelIds.length > 0 &&
    !regole.linkChannelIds.includes(contenuto.canaleId);

  if (!gifVietate && !linkVietati) return null;

  return {
    cosa: gifVietate && linkVietati ? 'link e GIF' : gifVietate ? 'GIF' : 'link',
    consentiti: gifVietate ? regole.gifChannelIds : regole.linkChannelIds,
  };
}

/** Link e GIF presenti in un testo. Esportata per i test, e usata qui sotto. */
export function leggiTesto(testo: string): Contenuto {
  URL_PATTERN.lastIndex = 0;
  const link = [...testo.matchAll(URL_PATTERN)].map((match) => match[0]);
  return {
    link,
    gif: link.some((url) => HOST_GIF.some((host) => url.toLowerCase().includes(host))),
  };
}

function dominioDi(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Applica la regola. Restituisce `true` se il messaggio è stato tolto.
 *
 * L'ordine dei controlli è quello che costa meno: prima le condizioni che si
 * decidono senza guardare il contenuto, poi la lettura del messaggio.
 */
export async function applyLinkPolicy(message: Message, config: GuildConfig): Promise<boolean> {
  const settings = config.security.links;
  if (!settings.enabled || !message.guild || message.author.bot) return false;
  if (isExempt(message.member, settings.exemptions, message.channelId)) return false;

  // Nessun canale indicato significa «ovunque»: un modulo acceso con entrambe
  // le liste vuote non deve togliere tutto: deve non fare nulla.
  if (settings.linkChannelIds.length === 0 && settings.gifChannelIds.length === 0) return false;

  const channel = message.channel;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PublicThread) {
    return false;
  }

  if (settings.allowInTickets && dentroUnTicket(message, config)) return false;

  const { link, gif } = leggiContenuto(message);
  if (link.length === 0 && !gif) return false;

  const canaleId = message.channel.isThread()
    ? (message.channel.parentId ?? message.channelId)
    : message.channelId;

  const esito = decidi({ link, gif, canaleId }, settings);
  if (!esito) return false;

  const { cosa, consentiti } = esito;

  await message.delete().catch((errore: unknown) => {
    log.debug({ err: errore, channelId: message.channelId }, 'messaggio non eliminabile');
  });

  const avviso = settings.notice
    .replaceAll('{utente}', `<@${message.author.id}>`)
    .replaceAll('{cosa}', cosa)
    .replaceAll('{canali}', consentiti.map((id) => `<#${id}>`).join(', ') || 'nessuno');

  const inviato = await (channel as TextChannel)
    .send({ content: avviso, allowedMentions: { users: [message.author.id] } })
    .catch(() => null);

  // La spiegazione si toglie da sola: serve a chi ha appena scritto, e dopo
  // qualche secondo diventa solo un'altra riga di rumore nel canale.
  if (inviato && settings.noticeSeconds > 0) {
    setTimeout(() => {
      void inviato.delete().catch(() => undefined);
    }, settings.noticeSeconds * 1000);
  }

  return true;
}

/**
 * Il messaggio è dentro un ticket?
 *
 * Si guarda la categoria configurata invece di interrogare il database: è la
 * stessa informazione, costa zero, e questo controllo gira su ogni messaggio
 * che contiene un link.
 */
function dentroUnTicket(message: Message, config: GuildConfig): boolean {
  const categoria = config.integrations.tickets.categoryId;
  if (!categoria) return false;

  const canale = message.channel;
  const padre = canale.isThread() ? canale.parent?.parentId : 'parentId' in canale ? canale.parentId : null;

  return padre === categoria;
}
