/* ═══════════════════════════════════════════════════════════════════════
   COMANDI IN CHAT

   Tre famiglie:

   • **integrati** — `!uptime`, `!seguito`, `!gioco`, `!comandi`, `!dado`;
   • **personalizzati** — quelli che lo streamer scrive dal pannello;
   • **`!angel`** — il governo del bot dalla chat.

   L'ultima è quella che giustifica il file. Il requisito era che il bot
   funzioni «in qualsiasi situazione, anche senza pannello», e questo è il
   posto in cui quella promessa si mantiene: livello di sicurezza, scudo,
   domini ammessi, timer, modalità prova — tutto si comanda da una riga di
   chat. Se il pannello è irraggiungibile, se il database è caduto, se lo
   streamer è al telefono e ha solo l'app di Twitch, `!angel scudo on` funziona
   comunque.

   È anche la ragione per cui questi comandi non passano dal database: leggono
   e scrivono la configurazione in memoria, e il salvataggio è un tentativo
   che può fallire senza portarsi via l'effetto. Un comando che non funziona
   quando il database è giù sarebbe un comando che non funziona proprio quando
   serve.

   ── Sul rispetto delle regole di Twitch ────────────────────────────────

   `!angel dimenticami` cancella tutto quello che il bot sa di chi lo scrive,
   su quel canale. Non è una gentilezza: l'accordo con Twitch obbliga a dare
   modo di opporsi al trattamento, e un comando che si può disattivare sarebbe
   un modo per non darlo. Per questo non ha un interruttore.
   ═══════════════════════════════════════════════════════════════════════ */

import { applicaModello, type TwitchChannelConfig, type LivelloSicurezza } from '@angel/shared';
import { applicaLivello, DESCRIZIONE_LIVELLI } from '@angel/shared';
import { almeno, type MessaggioChat } from './deps.js';
import { attivaScudo, manda, togliScudo, type Esecutore } from './azioni.js';
import { logger } from './logger.js';
import type { Canale } from './stato.js';

export interface ContestoComando {
  esecutore: Esecutore;
  canale: Canale;
  messaggio: MessaggioChat;
  /** Quello che segue il nome del comando. */
  argomento: string;
  /** Salva la configurazione. Può fallire: il comando ha effetto lo stesso. */
  salva: (canale: Canale) => Promise<boolean>;
  /** Da quanto il canale è in diretta, in millisecondi. Null se offline. */
  daQuandoOnline: number | null;
  /** Cancella tutto quello che si sa di una persona su questo canale. */
  dimentica: (canale: Canale, utenteId: string) => Promise<number>;
}

/** Cooldown ricordati in memoria: chiave `comando:utente` e `comando`. */
const attese = new Map<string, number>();

function inAttesa(chiave: string, secondi: number, adesso: number): boolean {
  if (secondi <= 0) return false;
  const scade = attese.get(chiave) ?? 0;
  if (scade > adesso) return true;
  attese.set(chiave, adesso + secondi * 1000);
  return false;
}

/* ── Smistamento ──────────────────────────────────────────────────────── */

/**
 * Prova a eseguire un comando. Restituisce vero se il messaggio era un comando.
 *
 * La moderazione viene **prima**: un comando dentro un messaggio pieno di
 * insulti resta un messaggio pieno di insulti, e rispondere prima di
 * cancellare significherebbe lasciare la risposta del bot attaccata a un
 * messaggio che non c'è più.
 */
export async function eseguiComando(ctx: ContestoComando): Promise<boolean> {
  const config = ctx.canale.config;
  const testo = ctx.messaggio.testo.trim();
  if (!testo.startsWith(config.prefisso)) return false;

  const senzaPrefisso = testo.slice(config.prefisso.length);
  const spazio = senzaPrefisso.indexOf(' ');
  const nome = (spazio === -1 ? senzaPrefisso : senzaPrefisso.slice(0, spazio)).toLowerCase();
  const argomento = spazio === -1 ? '' : senzaPrefisso.slice(spazio + 1).trim();
  if (!nome) return false;

  const contesto = { ...ctx, argomento };

  if (nome === 'angel') return comandoAngel(contesto);
  if (await comandoPersonalizzato(contesto, nome)) return true;
  if (config.chat.comandiIntegrati) return comandoIntegrato(contesto, nome);
  return false;
}

/* ── Personalizzati ───────────────────────────────────────────────────── */

async function comandoPersonalizzato(ctx: ContestoComando, nome: string): Promise<boolean> {
  const comando = ctx.canale.config.chat.comandi.find(
    (c) => c.attivo && (c.nome === nome || c.alias.includes(nome)),
  );
  if (!comando) return false;

  if (!almeno(ctx.messaggio, comando.livello)) return true;

  const adesso = Date.now();
  const chiaveUtente = `${ctx.canale.id}:${comando.nome}:${ctx.messaggio.utenteId}`;
  const chiaveCanale = `${ctx.canale.id}:${comando.nome}`;

  // Il cooldown di canale si controlla per secondo: due persone che premono
  // insieme non devono produrre due risposte identiche di fila.
  if (inAttesa(chiaveUtente, comando.cooldownSec, adesso)) return true;
  if (inAttesa(chiaveCanale, comando.cooldownCanaleSec, adesso)) return true;

  await manda(ctx.esecutore, ctx.canale, await espandi(ctx, comando.risposta));
  return true;
}

/**
 * Sostituisce i segnaposto.
 *
 * Usa `applicaModello` di `@angel/shared`, la stessa funzione dei comandi
 * personalizzati di Discord e dei modelli degli annunci. Erano quattro
 * implementazioni diverse e divergevano: `{utente}` funzionava in un posto e
 * non nell'altro, e nessuno sapeva quale fosse quello giusto.
 */
async function espandi(ctx: ContestoComando, modello: string): Promise<string> {
  return applicaModello(modello, {
    utente: ctx.messaggio.utenteNome,
    canale: ctx.canale.nome,
    argomento: ctx.argomento,
    uptime: ctx.daQuandoOnline ? durata(ctx.daQuandoOnline) : 'offline',
  });
}

/* ── Integrati ────────────────────────────────────────────────────────── */

async function comandoIntegrato(ctx: ContestoComando, nome: string): Promise<boolean> {
  const adesso = Date.now();
  // Un cooldown di canale comune a tutti gli integrati: sono risposte
  // pubbliche, e in una chat viva senza attesa diventerebbero loro stesse
  // lo spam da cui il bot dovrebbe difendere.
  if (inAttesa(`${ctx.canale.id}:integrati`, 3, adesso)) return true;

  switch (nome) {
    case 'uptime':
    case 'inonda':
      await manda(
        ctx.esecutore,
        ctx.canale,
        ctx.daQuandoOnline
          ? `${ctx.canale.nome} è in diretta da ${durata(ctx.daQuandoOnline)}`
          : `${ctx.canale.nome} non è in diretta`,
      );
      return true;

    case 'comandi':
    case 'commands': {
      const elenco = ctx.canale.config.chat.comandi
        .filter((c) => c.attivo && c.livello === 'TUTTI')
        .map((c) => ctx.canale.config.prefisso + c.nome);
      await manda(
        ctx.esecutore,
        ctx.canale,
        elenco.length > 0
          ? `Comandi: ${elenco.join(' ')}`
          : 'Non ci sono comandi personalizzati su questo canale.',
      );
      return true;
    }

    case 'dado':
    case 'dice': {
      const facce = Math.min(1000, Math.max(2, Number.parseInt(ctx.argomento, 10) || 6));
      await manda(
        ctx.esecutore,
        ctx.canale,
        `@${ctx.messaggio.utenteNome} ha tirato ${Math.floor(Math.random() * facce) + 1} su ${facce}`,
      );
      return true;
    }

    case 'seguito':
    case 'followage': {
      const da = await ctx.esecutore.helix
        .seguace(ctx.canale.id, ctx.messaggio.utenteId, ctx.canale.id)
        .catch(() => null);
      await manda(
        ctx.esecutore,
        ctx.canale,
        da
          ? `@${ctx.messaggio.utenteNome} segue ${ctx.canale.nome} da ${durata(Date.now() - da.getTime())}`
          : `@${ctx.messaggio.utenteNome} non segue ancora il canale`,
      );
      return true;
    }

    default:
      return false;
  }
}

/* ── !angel ───────────────────────────────────────────────────────────── */

const AIUTO =
  'Comandi: stato · livello <osserva|leggero|normale|alto|blindato> · prova <on|off> · ' +
  'scudo <on|off> · permetti <dominio> · vieta <dominio> · silenzia <utente> [secondi] · ' +
  'bandisci <utente> · perdona <utente> · timer <on|off|nome> · dimenticami';

async function comandoAngel(ctx: ContestoComando): Promise<boolean> {
  const spazio = ctx.argomento.indexOf(' ');
  const sotto = (spazio === -1 ? ctx.argomento : ctx.argomento.slice(0, spazio)).toLowerCase();
  const resto = spazio === -1 ? '' : ctx.argomento.slice(spazio + 1).trim();

  // `dimenticami` lo può usare chiunque: è il diritto di opporsi, e riservarlo
  // ai moderatori significherebbe non darlo a chi serve.
  if (sotto === 'dimenticami' || sotto === 'forgetme') {
    const quanti = await ctx.dimentica(ctx.canale, ctx.messaggio.utenteId);
    await manda(
      ctx.esecutore,
      ctx.canale,
      `@${ctx.messaggio.utenteNome} fatto: cancellate ${quanti} righe che ti riguardavano su questo canale.`,
    );
    return true;
  }

  if (!almeno(ctx.messaggio, ctx.canale.config.chat.livelloComandiBot)) return true;

  switch (sotto) {
    case '':
    case 'aiuto':
    case 'help':
      await manda(ctx.esecutore, ctx.canale, AIUTO);
      return true;

    case 'stato':
    case 'status':
      await manda(ctx.esecutore, ctx.canale, riassuntoStato(ctx));
      return true;

    case 'livello':
    case 'level':
      return cambiaLivello(ctx, resto);

    case 'prova':
    case 'test': {
      const acceso = resto === 'on' || resto === 'si';
      ctx.canale.config.modalitaProva = acceso;
      await ctx.salva(ctx.canale);
      await manda(
        ctx.esecutore,
        ctx.canale,
        acceso
          ? 'Modalità prova ATTIVA: registro quello che farei, non sanziono nessuno.'
          : 'Modalità prova spenta: le sanzioni tornano reali.',
      );
      return true;
    }

    case 'scudo':
    case 'shield': {
      if (resto === 'off' || resto === 'no') {
        await togliScudo(ctx.esecutore, ctx.canale);
        await manda(ctx.esecutore, ctx.canale, 'Restrizioni tolte.');
      } else {
        await attivaScudo(ctx.esecutore, ctx.canale, `richiesto da ${ctx.messaggio.utenteLogin}`);
        await manda(
          ctx.esecutore,
          ctx.canale,
          `Scudo attivo per ${Math.round(ctx.canale.config.sicurezza.antiRaid.durataSec / 60)} minuti.`,
        );
      }
      return true;
    }

    case 'permetti':
    case 'allow':
      return listaDomini(ctx, resto, 'ammessi');

    case 'vieta':
    case 'deny':
      return listaDomini(ctx, resto, 'vietati');

    case 'silenzia':
    case 'timeout':
      return sanzionaDaChat(ctx, resto, true);

    case 'bandisci':
    case 'ban':
      return sanzionaDaChat(ctx, resto, false);

    case 'perdona':
    case 'unban': {
      const login = pulisciLogin(resto);
      if (!login) return true;
      const utenti = await ctx.esecutore.helix.utenti([login]).catch(() => []);
      const bersaglio = utenti[0];
      if (!bersaglio) {
        await manda(ctx.esecutore, ctx.canale, `Non trovo ${login}.`);
        return true;
      }
      await ctx.esecutore.helix
        .revocaSanzione(ctx.canale.id, ctx.canale.id, bersaglio.id)
        .catch(() => undefined);
      await manda(ctx.esecutore, ctx.canale, `${login} perdonato.`);
      return true;
    }

    case 'timer':
      return comandoTimer(ctx, resto);

    default:
      await manda(ctx.esecutore, ctx.canale, AIUTO);
      return true;
  }
}

function riassuntoStato(ctx: ContestoComando): string {
  const config = ctx.canale.config;
  const attivi = Object.entries(config.sicurezza)
    .filter(([, modulo]) => (modulo as { attivo: boolean }).attivo)
    .map(([nome]) => nome);

  const pezzi = [
    `livello ${config.livello.toLowerCase()}`,
    config.modalitaProva ? 'MODALITÀ PROVA' : 'sanzioni attive',
    `${attivi.length} moduli accesi`,
    `${config.chat.comandi.length} comandi`,
    `${config.chat.timer.filter((t) => t.attivo).length} timer`,
  ];

  if (ctx.canale.scudoFinoA) {
    pezzi.push(`scudo attivo ancora ${Math.round((ctx.canale.scudoFinoA - Date.now()) / 60000)}m`);
  }
  // Lo si dice in chat perché è l'unico posto in cui si può dire: senza
  // database il pannello non risponde, e questo comando è l'unica finestra.
  if (!ctx.canale.token) pezzi.push('⚠️ da riautorizzare');

  return `ANGEL — ${pezzi.join(' · ')}`;
}

async function cambiaLivello(ctx: ContestoComando, resto: string): Promise<boolean> {
  const scelto = resto.trim().toUpperCase();
  const validi: LivelloSicurezza[] = ['OSSERVA', 'LEGGERO', 'NORMALE', 'ALTO', 'BLINDATO'];

  if (!validi.includes(scelto as LivelloSicurezza)) {
    await manda(
      ctx.esecutore,
      ctx.canale,
      `Livello attuale: ${ctx.canale.config.livello.toLowerCase()}. Scegli fra ${validi
        .join(', ')
        .toLowerCase()}.`,
    );
    return true;
  }

  const nuovo = applicaLivello(scelto as LivelloSicurezza, ctx.canale.config);
  ctx.canale.config = nuovo;
  const salvato = await ctx.salva(ctx.canale);

  await manda(
    ctx.esecutore,
    ctx.canale,
    `Livello ${scelto.toLowerCase()}: ${DESCRIZIONE_LIVELLI[scelto as LivelloSicurezza].split('.')[0]}.` +
      (salvato ? '' : ' (attivo adesso, ma non ho potuto salvarlo: database non raggiungibile)'),
  );
  return true;
}

async function listaDomini(
  ctx: ContestoComando,
  resto: string,
  quale: 'ammessi' | 'vietati',
): Promise<boolean> {
  const dominio = resto
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];

  if (!dominio) {
    const elenco =
      quale === 'ammessi'
        ? ctx.canale.config.sicurezza.link.dominiAmmessi
        : ctx.canale.config.sicurezza.link.dominiVietati;
    await manda(
      ctx.esecutore,
      ctx.canale,
      elenco.length > 0 ? `Domini ${quale}: ${elenco.join(', ')}` : `Nessun dominio ${quale}.`,
    );
    return true;
  }

  const elenco =
    quale === 'ammessi'
      ? ctx.canale.config.sicurezza.link.dominiAmmessi
      : ctx.canale.config.sicurezza.link.dominiVietati;

  if (elenco.includes(dominio)) {
    elenco.splice(elenco.indexOf(dominio), 1);
    await ctx.salva(ctx.canale);
    await manda(ctx.esecutore, ctx.canale, `${dominio} tolto dai domini ${quale}.`);
  } else {
    elenco.push(dominio);
    await ctx.salva(ctx.canale);
    await manda(ctx.esecutore, ctx.canale, `${dominio} aggiunto ai domini ${quale}.`);
  }
  return true;
}

async function sanzionaDaChat(
  ctx: ContestoComando,
  resto: string,
  silenzio: boolean,
): Promise<boolean> {
  const [primo, secondo] = resto.split(/\s+/);
  const login = pulisciLogin(primo ?? '');
  if (!login) {
    await manda(ctx.esecutore, ctx.canale, 'Serve il nome: !angel silenzia @tizio 600');
    return true;
  }

  const utenti = await ctx.esecutore.helix.utenti([login]).catch(() => []);
  const bersaglio = utenti[0];
  if (!bersaglio) {
    await manda(ctx.esecutore, ctx.canale, `Non trovo ${login}.`);
    return true;
  }

  const durataSec = silenzio ? Math.max(1, Number.parseInt(secondo ?? '600', 10) || 600) : undefined;

  try {
    await ctx.esecutore.helix.sanziona(
      ctx.canale.id,
      ctx.canale.id,
      bersaglio.id,
      `ANGEL: chiesto da ${ctx.messaggio.utenteLogin}`,
      durataSec,
    );
    ctx.esecutore.archivio.registra({
      canale: ctx.canale,
      tipo: silenzio ? 'SILENZIATO' : 'BANDITO',
      modulo: 'comando',
      gravita: 50,
      utenteId: bersaglio.id,
      utenteLogin: bersaglio.login,
      azione: silenzio ? 'SILENZIA' : 'BANDISCI',
      durataSec: durataSec ?? 0,
      motivo: `chiesto in chat da ${ctx.messaggio.utenteLogin}`,
    });
    await manda(
      ctx.esecutore,
      ctx.canale,
      silenzio ? `${login} silenziato per ${durataSec}s.` : `${login} bandito.`,
    );
  } catch (errore) {
    logger.warn({ err: errore, canale: ctx.canale.login }, 'sanzione da chat non riuscita');
    await manda(ctx.esecutore, ctx.canale, `Non ci sono riuscito su ${login}.`);
  }
  return true;
}

async function comandoTimer(ctx: ContestoComando, resto: string): Promise<boolean> {
  const timer = ctx.canale.config.chat.timer;

  if (!resto) {
    await manda(
      ctx.esecutore,
      ctx.canale,
      timer.length > 0
        ? `Timer: ${timer.map((t) => `${t.nome}${t.attivo ? '' : ' (spento)'}`).join(', ')}`
        : 'Nessun messaggio a tempo configurato.',
    );
    return true;
  }

  if (resto === 'on' || resto === 'off') {
    const acceso = resto === 'on';
    for (const voce of timer) voce.attivo = acceso;
    await ctx.salva(ctx.canale);
    await manda(ctx.esecutore, ctx.canale, `Messaggi a tempo ${acceso ? 'accesi' : 'spenti'}.`);
    return true;
  }

  const voce = timer.find((t) => t.nome.toLowerCase() === resto.toLowerCase());
  if (!voce) {
    await manda(ctx.esecutore, ctx.canale, `Non ho un timer che si chiama «${resto}».`);
    return true;
  }

  voce.attivo = !voce.attivo;
  await ctx.salva(ctx.canale);
  await manda(
    ctx.esecutore,
    ctx.canale,
    `Timer «${voce.nome}» ${voce.attivo ? 'acceso' : 'spento'}.`,
  );
  return true;
}

/* ── Utilità ──────────────────────────────────────────────────────────── */

function pulisciLogin(testo: string): string {
  return testo.trim().replace(/^@/, '').toLowerCase();
}

/** Durata leggibile: «3 g 4 h», «12 m». */
export function durata(ms: number): string {
  const secondi = Math.floor(ms / 1000);
  const giorni = Math.floor(secondi / 86400);
  const ore = Math.floor((secondi % 86400) / 3600);
  const minuti = Math.floor((secondi % 3600) / 60);

  if (giorni > 0) return `${giorni} g ${ore} h`;
  if (ore > 0) return `${ore} h ${minuti} m`;
  if (minuti > 0) return `${minuti} m`;
  return `${secondi} s`;
}

/** Per i test e per il pannello: quali comandi esistono di serie. */
export const COMANDI_INTEGRATI = ['uptime', 'comandi', 'dado', 'seguito'] as const;

export function configHaComando(config: TwitchChannelConfig, nome: string): boolean {
  return config.chat.comandi.some((c) => c.nome === nome || c.alias.includes(nome));
}
