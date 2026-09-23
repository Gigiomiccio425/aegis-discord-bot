import {
  Archive,
  Bot,
  DatabaseBackup,
  Gavel,
  KeyRound,
  LayoutDashboard,
  Megaphone,
  Plug,
  ScrollText,
  ShieldAlert,
  SlidersHorizontal,
  Ticket,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════════════
   LE PAGINE DEL PANNELLO, PER GRUPPO

   Prima erano tredici voci in fila, tutte uguali: per trovarne una bisognava
   leggerle. Divise per quello che servono a fare, l'occhio va al gruppo e
   poi alla voce, e le voci da leggere diventano tre o quattro.

   Un solo elenco per tre usi — la barra laterale, il percorso in cima alla
   pagina, la ricerca — così non possono mai dire cose diverse.
   ═══════════════════════════════════════════════════════════════════════ */

export interface VocePagina {
  /** Il percorso dopo `/g/<server>/`. Vuoto per la dashboard. */
  to: string;
  label: string;
  /** Cosa ci si trova, in una riga: la mostra la ricerca. */
  descrizione: string;
  icona: LucideIcon;
  end?: boolean;
  /**
   * Parole con cui qualcuno cercherebbe questa pagina senza saperne il nome:
   * «lockdown» porta alla dashboard, dove sta il pulsante.
   */
  parole?: string[];
}

export interface GruppoNavigazione {
  titolo: string;
  voci: VocePagina[];
}

export const NAVIGAZIONE: GruppoNavigazione[] = [
  {
    titolo: 'Panoramica',
    voci: [
      {
        to: '',
        end: true,
        label: 'Dashboard',
        descrizione: 'Minacce di oggi, ingressi, incidenti e azioni rapide',
        icona: LayoutDashboard,
        parole: ['lockdown', 'blocco', 'azioni rapide', 'panico', 'statistiche', 'incidenti'],
      },
      {
        to: 'log',
        label: 'Registro eventi',
        descrizione: 'Tutto quello che è successo, filtrabile',
        icona: ScrollText,
        parole: ['log', 'eventi', 'storico', 'audit'],
      },
    ],
  },
  {
    titolo: 'Moderazione',
    voci: [
      {
        to: 'casi',
        label: 'Provvedimenti',
        descrizione: 'Ban, silenziamenti, quarantene e appelli',
        icona: Gavel,
        parole: ['ban', 'mute', 'silenzia', 'quarantena', 'appelli', 'casi', 'sanzioni'],
      },
      {
        to: 'sicurezza',
        label: 'Sicurezza',
        descrizione: 'Inviti a rischio, webhook, bot e account sospetti',
        icona: ShieldAlert,
        parole: ['webhook', 'inviti', 'bot', 'account a rischio', 'inventario'],
      },
      {
        to: 'archivio',
        label: 'Archivio messaggi',
        descrizione: 'Messaggi conservati, trascrizioni esportabili',
        icona: Archive,
        parole: ['messaggi', 'trascrizioni', 'eliminati'],
      },
      {
        to: 'ticket',
        label: 'Ticket e trascrizioni',
        descrizione: "Richieste d'assistenza e le loro trascrizioni",
        icona: Ticket,
        parole: ['assistenza', 'supporto'],
      },
    ],
  },
  {
    titolo: 'Comunità',
    voci: [
      {
        to: 'annunci',
        label: 'Annunci',
        descrizione: 'Dirette Twitch, video YouTube, feed',
        icona: Megaphone,
        parole: ['twitch', 'youtube', 'rss', 'dirette', 'notifiche'],
      },
      {
        to: 'integrazioni',
        label: 'Integrazioni',
        descrizione: 'Sondaggi, giveaway e menu dei ruoli',
        icona: Plug,
        parole: ['sondaggi', 'giveaway', 'ruoli con reazione', 'menu'],
      },
      {
        to: 'comandi',
        label: 'Comandi e personas',
        descrizione: 'Comandi personalizzati e identità del bot',
        icona: Bot,
        parole: ['comandi personalizzati', 'personas', 'webhook'],
      },
    ],
  },
  {
    titolo: 'Sistema',
    voci: [
      {
        to: 'impostazioni',
        label: 'Configurazione',
        descrizione: 'Tutte le impostazioni dei moduli',
        icona: SlidersHorizontal,
        parole: ['impostazioni', 'moduli', 'opzioni', 'soglie'],
      },
      {
        to: 'backup',
        label: 'Backup',
        descrizione: 'Struttura del server, copia completa, copia leggera',
        icona: DatabaseBackup,
        parole: ['copia', 'ripristino', 'snapshot', 'copia leggera', 'trasloco'],
      },
      {
        to: 'strumenti',
        label: 'Strumenti',
        descrizione: 'Prepara il server, rientro dall’emergenza, scrivi come il bot',
        icona: Wrench,
        parole: ['prepara', 'setup', 'emergenza', 'scrivi', 'messaggio'],
      },
      {
        to: 'accessi',
        label: 'Accessi al pannello',
        descrizione: 'Chi può entrare nel pannello, e con che ruolo',
        icona: KeyRound,
        parole: ['permessi', 'admin', 'moderatori', 'accessi'],
      },
    ],
  },
];

/** Tutte le pagine, in ordine. */
export const PAGINE: VocePagina[] = NAVIGAZIONE.flatMap((gruppo) => gruppo.voci);

/** Il gruppo e la voce di un percorso, per il percorso in cima alla pagina. */
export function doveSiamo(
  percorso: string,
): { gruppo: GruppoNavigazione; voce: VocePagina } | null {
  // `/g/<server>/casi/…` → `casi`. La dashboard è il segmento vuoto.
  const segmento = percorso.split('/').filter(Boolean)[2] ?? '';
  for (const gruppo of NAVIGAZIONE) {
    const voce = gruppo.voci.find((candidata) => candidata.to === segmento);
    if (voce) return { gruppo, voce };
  }
  return null;
}
