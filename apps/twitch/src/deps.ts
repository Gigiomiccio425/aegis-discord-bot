/**
 * Riesportazioni.
 *
 * Un punto solo da cui il resto dell'applicazione prende i tipi della
 * libreria. Serve a rendere evidente il confine: quello che passa da qui è
 * pubblico e provato, quello che sta in `@angel/twitch` e non compare qui non
 * è pensato per essere usato da fuori.
 */
export {
  ErroreHelix,
  Helix,
  PoolEventSub,
  Secchiello,
  secchielloChat,
  almeno,
  improntaMessaggio,
  livelloDi,
  valuta,
  valutaRaid,
  urlAutorizzazione,
  scambiaCodice,
  revoca,
  AMBITI_CANALE,
  BOT_LEGITTIMI,
} from '@angel/twitch';

export type {
  ContestoMessaggio,
  MessaggioChat,
  EventoRaid,
  Rilevazione,
  StatoSpettatore,
  TokenCanale,
  UtenteTwitch,
  Verdetto,
} from '@angel/twitch';

export type { AzioneTwitch, LivelloTwitch, TwitchChannelConfig } from '@angel/shared';
