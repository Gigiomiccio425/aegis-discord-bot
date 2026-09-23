import {
  Bell,
  MessageSquareWarning,
  Puzzle,
  ScrollText,
  Settings2,
  ShieldAlert,
  UserCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════════════
   LE SEZIONI DELLA CONFIGURAZIONE, PER CATEGORIA

   Ventisette sezioni in una colonna sola si leggono tutte prima di trovare
   quella giusta. Qui stanno in sette categorie, ognuna con un nome che dice
   cosa protegge o cosa fa — «Protezione dagli attacchi», «Controllo dei
   messaggi» — e mai più di sei sezioni per categoria: la panoramica della
   configurazione si legge in un colpo d'occhio, senza scorrere un menù.

   Un modulo che non compare qui non sparisce: finisce in «Altre
   impostazioni». Il test pretende comunque che ogni modulo abbia un posto
   scritto, perché quella è una rete di sicurezza, non una collocazione.
   ═══════════════════════════════════════════════════════════════════════ */

export interface Sezione {
  key: string;
  label: string;
  group: string;
}

export interface Categoria {
  id: string;
  titolo: string;
  /** Una riga: cosa si trova dentro. */
  descrizione: string;
  icona: LucideIcon;
  /** Il gruppo che il registro dei moduli dà a queste sezioni. */
  gruppo: string;
  chiavi: string[];
}

export interface CategoriaConSezioni extends Omit<Categoria, 'chiavi'> {
  sezioni: Sezione[];
}

/** Le impostazioni generali: non sono un modulo, e il server non le elenca. */
export const SEZIONE_GENERALE: Sezione = { key: 'general', label: 'Generale', group: 'Base' };

export const CATEGORIE: Categoria[] = [
  {
    id: 'base',
    titolo: 'Impostazioni di base',
    descrizione: 'Protezione generale, modalità prova, staff, lingua e identità del bot.',
    icona: Settings2,
    gruppo: 'Base',
    chiavi: ['general'],
  },
  {
    id: 'attacchi',
    titolo: 'Protezione dagli attacchi',
    descrizione: 'Raid, distruzione del server, account rubati, inviti, webhook e bot estranei.',
    icona: ShieldAlert,
    gruppo: 'Sicurezza',
    chiavi: [
      'security.antiRaid',
      'security.antiNuke',
      'security.compromise',
      'security.inviteGuard',
      'security.webhookGuard',
      'security.botGuard',
    ],
  },
  {
    id: 'messaggi',
    titolo: 'Controllo dei messaggi',
    descrizione: 'Spam, linguaggio, litigi, link e allegati pericolosi, AutoMod di Discord.',
    icona: MessageSquareWarning,
    gruppo: 'Sicurezza',
    chiavi: [
      'security.antiSpam',
      'security.language',
      'security.flame',
      'security.links',
      'scanner',
      'security.autoMod',
    ],
  },
  {
    id: 'ingresso',
    titolo: 'Ingresso e membri',
    descrizione: 'Chi entra, la verifica, i ruoli che restano e la tutela di chi è nel server.',
    icona: UserCheck,
    gruppo: 'Sicurezza',
    chiavi: [
      'security.accountGuard',
      'security.verification',
      'security.stickyRoles',
      'security.safety',
    ],
  },
  {
    id: 'registro',
    titolo: 'Registro eventi',
    descrizione: 'Cosa si registra, in quali canali e per quanto tempo si conserva.',
    icona: ScrollText,
    gruppo: 'Registro',
    chiavi: ['logging'],
  },
  {
    id: 'comunita',
    titolo: 'Comunità',
    descrizione: 'Sondaggi, eventi, giveaway, ruoli con reazione, bacheca e ticket.',
    icona: Users,
    gruppo: 'Integrazioni',
    chiavi: [
      'integrations.polls',
      'integrations.events',
      'integrations.giveaways',
      'integrations.reactionRoles',
      'integrations.starboard',
      'integrations.tickets',
    ],
  },
  {
    id: 'notifiche',
    titolo: 'Notifiche esterne',
    descrizione: 'Dirette Twitch, video YouTube e feed RSS annunciati nei canali.',
    icona: Bell,
    gruppo: 'Integrazioni',
    chiavi: ['integrations.twitch', 'integrations.youtube', 'integrations.rss'],
  },
];

const ALTRO: Omit<Categoria, 'chiavi'> = {
  id: 'altro',
  titolo: 'Altre impostazioni',
  descrizione: 'Moduli nuovi, non ancora collocati in una categoria.',
  icona: Puzzle,
  gruppo: '',
};

/** Le sezioni arrivate dal server, nelle loro categorie. Le categorie vuote non compaiono. */
export function raggruppaSezioni(sezioni: readonly Sezione[]): CategoriaConSezioni[] {
  const perChiave = new Map(sezioni.map((sezione) => [sezione.key, sezione]));
  const collocate = new Set<string>();
  const risultato: CategoriaConSezioni[] = [];

  for (const { chiavi, ...categoria } of CATEGORIE) {
    const presenti = chiavi
      .map((chiave) => perChiave.get(chiave))
      .filter((sezione): sezione is Sezione => sezione !== undefined);
    presenti.forEach((sezione) => collocate.add(sezione.key));
    if (presenti.length > 0) risultato.push({ ...categoria, sezioni: presenti });
  }

  const orfane = sezioni.filter((sezione) => !collocate.has(sezione.key));
  if (orfane.length > 0) risultato.push({ ...ALTRO, sezioni: orfane });

  return risultato;
}

/** La categoria di una sezione, o `null` se la sezione non c'è. */
export function categoriaDi(chiave: string, categorie: CategoriaConSezioni[]): CategoriaConSezioni | null {
  return categorie.find((categoria) => categoria.sezioni.some((sezione) => sezione.key === chiave)) ?? null;
}

/** Dove sta una sezione: «Protezione dagli attacchi». */
export function posizioneSezione(chiave: string, categorie: CategoriaConSezioni[]): string {
  return categoriaDi(chiave, categorie)?.titolo ?? '';
}
