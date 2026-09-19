import { DiscordAPIError } from 'discord.js';

/**
 * Un errore di Discord detto in modo che chi legge sappia cosa fare.
 *
 * Il messaggio originale è in inglese e parla di codici: «Missing
 * Permissions» non dice quale permesso, né dove. Questi sono i casi che
 * capitano davvero quando lo staff usa il pannello, con il rimedio accanto.
 */
export function descriviErroreDiscord(errore: unknown): string {
  if (errore instanceof DiscordAPIError) {
    switch (errore.code) {
      case 50013:
        return (
          'al bot manca un permesso, oppure il suo ruolo è più in basso di quello ' +
          'della persona: sposta il ruolo del bot più in alto nell’elenco dei ruoli'
        );
      case 50001:
        return 'il bot non vede quel canale';
      case 10003:
        return 'il canale non esiste più';
      case 10007:
        return 'la persona non è più nel server';
      case 10008:
        return 'il messaggio non esiste più';
      case 10011:
        return 'il ruolo non esiste più';
      case 10013:
        return 'utente sconosciuto';
      case 10026:
        return 'la persona non risulta bandita';
      case 50035:
        return `Discord ha rifiutato i dati: ${errore.message.slice(0, 160)}`;
      default:
        return `Discord ha risposto ${errore.code}: ${errore.message.slice(0, 160)}`;
    }
  }
  return errore instanceof Error ? errore.message.slice(0, 200) : 'errore sconosciuto';
}
