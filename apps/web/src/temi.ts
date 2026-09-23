/* ═══════════════════════════════════════════════════════════════════════
   I TEMI DEL PANNELLO

   Un tema è un insieme di colori con un significato, non una tavolozza: il
   fondo, le superfici, l'accento, i tre colori di stato, e la scala del
   testo dal più forte al più tenue.

   ── La scala del testo, e perché si inverte ────────────────────────────

   Il pannello colora il testo con la scala `neutral` di Tailwind: 200 per il
   testo principale, 500 per le spiegazioni, 600 per i dettagli. Nei temi
   scuri il 200 è quasi bianco; nei temi chiari deve diventare quasi nero.
   Qui la scala vuol dire «quanto il testo si stacca dal fondo», non «quanto è
   chiaro»: così ogni pagina esistente diventa leggibile in ogni tema senza
   toccare una riga delle pagine.

   Ogni tema passa dal test del contrasto: il testo principale e le
   spiegazioni devono restare leggibili sul fondo e sulle superfici. Un tema
   bello che si legge male non entra.
   ═══════════════════════════════════════════════════════════════════════ */

export interface Colori {
  /** Il fondo della pagina. */
  base: string;
  /** Schede, barra laterale. */
  superficie: string;
  /** Campi, elementi dentro le schede. */
  superficie2: string;
  /** Una superficie sotto il puntatore. */
  superficieSopra: string;
  bordo: string;

  accento: string;
  /** L'accento usato come testo: la voce attiva, i collegamenti. */
  accentoTesto: string;
  accentoSopra: string;
  /** Il testo sopra un pulsante color accento. */
  sopraAccento: string;

  pericolo: string;
  pericoloTesto: string;
  pericoloSopra: string;
  sopraPericolo: string;
  avviso: string;
  avvisoTesto: string;
  successo: string;
  successoTesto: string;

  /** Scala del testo: 100 il più forte, 600 il più tenue. */
  testo: { 100: string; 200: string; 300: string; 400: string; 500: string; 600: string };
}

export interface Tema {
  id: string;
  nome: string;
  descrizione: string;
  chiaro: boolean;
  colori: Colori;
  /** Un carattere diverso, per i temi che lo chiedono. */
  carattere?: string;
}

/* ── I colori di stato, per famiglia ─────────────────────────────────── */

const statoScuro = {
  pericolo: '#f06a7a',
  pericoloTesto: '#ffb3bd',
  pericoloSopra: '#f5838f',
  sopraPericolo: '#1a0508',
  avviso: '#f0ad4e',
  avvisoTesto: '#ffd58a',
  successo: '#4cc98a',
  successoTesto: '#9ee8bf',
};

const statoChiaro = {
  pericolo: '#c62f45',
  pericoloTesto: '#9e1c30',
  pericoloSopra: '#a8253a',
  sopraPericolo: '#ffffff',
  avviso: '#9a5c00',
  avvisoTesto: '#7a4800',
  successo: '#1b7a48',
  successoTesto: '#14613a',
};

/** La scala del testo di un tema, dal più forte al più tenue. */
function scala(forte: string, principale: string, medio: string, secondario: string, tenue: string, minimo: string) {
  return { 100: forte, 200: principale, 300: medio, 400: secondario, 500: tenue, 600: minimo };
}

/* ── I temi ──────────────────────────────────────────────────────────── */

export const TEMI: Tema[] = [
  {
    id: 'notte-oro',
    nome: 'Notte e oro',
    descrizione: 'Il tema di ANGEL. Un accento caldo che si trova subito, di notte.',
    chiaro: false,
    colori: {
      base: '#0b0d13',
      superficie: '#14161e',
      superficie2: '#1c1f2a',
      superficieSopra: '#262b36',
      bordo: '#2b2f3d',
      accento: '#d8b45f',
      accentoTesto: '#f0dfae',
      accentoSopra: '#c2a052',
      sopraAccento: '#14161e',
      ...statoScuro,
      testo: scala('#f5f6f8', '#e4e6eb', '#c9cdd6', '#b0b6c2', '#9aa1af', '#7c8393'),
    },
  },
  {
    id: 'mezzanotte',
    nome: 'Mezzanotte',
    descrizione: 'Blu profondo e azzurro. Freddo, calmo, da ore lunghe.',
    chiaro: false,
    colori: {
      base: '#0a0f1c',
      superficie: '#111827',
      superficie2: '#1a2335',
      superficieSopra: '#223047',
      bordo: '#28344a',
      accento: '#5b9dff',
      accentoTesto: '#b9d4ff',
      accentoSopra: '#4886e6',
      sopraAccento: '#06101f',
      ...statoScuro,
      testo: scala('#f3f6fb', '#e1e7f0', '#c4cedd', '#a9b5c7', '#93a0b4', '#76839a'),
    },
  },
  {
    id: 'crepuscolo',
    nome: 'Crepuscolo',
    descrizione: 'Grigio ardesia e ghiaccio. Contrasti morbidi, niente nero pieno.',
    chiaro: false,
    colori: {
      base: '#1b1f27',
      superficie: '#232833',
      superficie2: '#2c3240',
      superficieSopra: '#353c4c',
      bordo: '#3b4252',
      accento: '#88c0d0',
      accentoTesto: '#c8e6ee',
      accentoSopra: '#76adbd',
      sopraAccento: '#10161c',
      ...statoScuro,
      testo: scala('#f4f6f9', '#e5e9f0', '#d0d6e0', '#b9c1cd', '#a6afbd', '#8a93a3'),
    },
  },
  {
    id: 'smeraldo',
    nome: 'Smeraldo',
    descrizione: 'Verde bosco. Riposante per chi tiene il pannello aperto tutto il giorno.',
    chiaro: false,
    colori: {
      base: '#07120e',
      superficie: '#0e1b16',
      superficie2: '#15261f',
      superficieSopra: '#1c3129',
      bordo: '#22392f',
      accento: '#3fcf8e',
      accentoTesto: '#a8ecca',
      accentoSopra: '#34b67b',
      sopraAccento: '#04120b',
      ...statoScuro,
      testo: scala('#f1f7f4', '#dfebe5', '#c2d4cb', '#a6bbb1', '#91a89d', '#748b80'),
    },
  },
  {
    id: 'oceano',
    nome: 'Oceano',
    descrizione: 'Petrolio e turchese.',
    chiaro: false,
    colori: {
      base: '#06131a',
      superficie: '#0c1d26',
      superficie2: '#132834',
      superficieSopra: '#1a3443',
      bordo: '#1f3b4a',
      accento: '#2ec4c9',
      accentoTesto: '#a6ecee',
      accentoSopra: '#27aab0',
      sopraAccento: '#031214',
      ...statoScuro,
      testo: scala('#f0f7f9', '#dce9ee', '#bfd3db', '#a2bac4', '#8ea7b2', '#718c98'),
    },
  },
  {
    id: 'ametista',
    nome: 'Ametista',
    descrizione: 'Viola notturno e lilla.',
    chiaro: false,
    colori: {
      base: '#0f0b17',
      superficie: '#171222',
      superficie2: '#211a30',
      superficieSopra: '#2a2240',
      bordo: '#33294a',
      accento: '#a98bff',
      accentoTesto: '#d9ccff',
      accentoSopra: '#9577f0',
      sopraAccento: '#120a24',
      ...statoScuro,
      testo: scala('#f6f3fb', '#e7e1f2', '#cdc4df', '#b3a8c9', '#9f94b8', '#82779b'),
    },
  },
  {
    id: 'ciliegia',
    nome: 'Ciliegia',
    descrizione: 'Prugna scura e rosa acceso.',
    chiaro: false,
    colori: {
      base: '#140a10',
      superficie: '#1d1018',
      superficie2: '#291722',
      superficieSopra: '#351e2c',
      bordo: '#3e2433',
      accento: '#ff6fa5',
      accentoTesto: '#ffc2d9',
      accentoSopra: '#e85f93',
      sopraAccento: '#20050f',
      ...statoScuro,
      testo: scala('#faf2f5', '#efdfe6', '#dac3cd', '#c2a6b2', '#ad909d', '#907380'),
    },
  },
  {
    id: 'brace',
    nome: 'Brace',
    descrizione: 'Carbone e arancio. Per chi vuole che gli allarmi si sentano.',
    chiaro: false,
    colori: {
      base: '#120c0a',
      superficie: '#1b1311',
      superficie2: '#261b17',
      superficieSopra: '#32231e',
      bordo: '#3a2a24',
      accento: '#ff8a4c',
      accentoTesto: '#ffc9a8',
      accentoSopra: '#e87a3f',
      sopraAccento: '#1f0c03',
      ...statoScuro,
      testo: scala('#faf4f1', '#eee3de', '#d9c8c1', '#c1ada5', '#ad9890', '#8f7a72'),
    },
  },
  {
    id: 'grafite',
    nome: 'Grafite',
    descrizione: 'Solo grigi e bianco. Nessun colore che distragga dai dati.',
    chiaro: false,
    colori: {
      base: '#0f0f10',
      superficie: '#18181a',
      superficie2: '#212124',
      superficieSopra: '#2b2b2f',
      bordo: '#333337',
      accento: '#e6e6e6',
      accentoTesto: '#ffffff',
      accentoSopra: '#cfcfcf',
      sopraAccento: '#111111',
      ...statoScuro,
      testo: scala('#f7f7f7', '#e6e6e6', '#cccccc', '#b3b3b3', '#a0a0a0', '#828282'),
    },
  },
  {
    id: 'terminale',
    nome: 'Terminale',
    descrizione: 'Fosfori verdi su nero, carattere a spaziatura fissa.',
    chiaro: false,
    carattere: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
    colori: {
      base: '#030703',
      superficie: '#07100a',
      superficie2: '#0c1a10',
      superficieSopra: '#122417',
      bordo: '#173322',
      accento: '#39ff7a',
      accentoTesto: '#b5ffcc',
      accentoSopra: '#2ee06a',
      sopraAccento: '#021006',
      ...statoScuro,
      testo: scala('#e9ffef', '#cdf5d8', '#a9dcb7', '#8cc49c', '#79b089', '#5e9170'),
    },
  },
  {
    id: 'lime',
    nome: 'Lime',
    descrizione: 'Nero e verde acido. L’accento più vistoso: si vede subito dove premere.',
    chiaro: false,
    colori: {
      base: '#0c0f0a',
      superficie: '#141a12',
      superficie2: '#1c2419',
      superficieSopra: '#26301f',
      bordo: '#2c3727',
      accento: '#b8e62e',
      accentoTesto: '#dcf59a',
      accentoSopra: '#a3cf22',
      sopraAccento: '#11160a',
      ...statoScuro,
      testo: scala('#f4f7f0', '#e3e9dc', '#c8d1bf', '#aeb8a4', '#98a38d', '#7a8570'),
    },
  },
  {
    id: 'contrasto',
    nome: 'Alto contrasto',
    descrizione: 'Nero pieno, testo bianco, accento giallo. Il più leggibile.',
    chiaro: false,
    colori: {
      base: '#000000',
      superficie: '#000000',
      superficie2: '#121212',
      superficieSopra: '#1f1f1f',
      bordo: '#8a8a8a',
      accento: '#ffd400',
      accentoTesto: '#ffe866',
      accentoSopra: '#e6bf00',
      sopraAccento: '#000000',
      pericolo: '#ff6b7d',
      pericoloTesto: '#ffc2ca',
      pericoloSopra: '#ff8594',
      sopraPericolo: '#000000',
      avviso: '#ffb74d',
      avvisoTesto: '#ffe0a6',
      successo: '#5ee39b',
      successoTesto: '#b3f5d1',
      testo: scala('#ffffff', '#ffffff', '#f0f0f0', '#e0e0e0', '#cccccc', '#b0b0b0'),
    },
  },

  /* ── Chiari ─────────────────────────────────────────────────────────── */

  {
    id: 'carta',
    nome: 'Carta',
    descrizione: 'Avorio e oro scuro: Notte e oro, di giorno.',
    chiaro: true,
    colori: {
      base: '#f4f0e7',
      superficie: '#fffdf8',
      superficie2: '#f0eadd',
      superficieSopra: '#e8e0cf',
      bordo: '#dcd1bb',
      accento: '#8a681a',
      accentoTesto: '#6b5010',
      accentoSopra: '#735612',
      sopraAccento: '#ffffff',
      ...statoChiaro,
      testo: scala('#15130e', '#221f18', '#3b362b', '#4d473a', '#5f5849', '#7a7262'),
    },
  },
  {
    id: 'neve',
    nome: 'Neve',
    descrizione: 'Bianco e blu, pulito come un documento.',
    chiaro: true,
    colori: {
      base: '#f1f4f9',
      superficie: '#ffffff',
      superficie2: '#eef1f6',
      superficieSopra: '#e2e7f0',
      bordo: '#d5dbe6',
      accento: '#2f6fdb',
      accentoTesto: '#1d4fa8',
      accentoSopra: '#2560c4',
      sopraAccento: '#ffffff',
      ...statoChiaro,
      testo: scala('#0f1319', '#1d232d', '#353e4c', '#48515f', '#586171', '#747d8c'),
    },
  },
  {
    id: 'salvia',
    nome: 'Salvia',
    descrizione: 'Verde chiaro e muschio.',
    chiaro: true,
    colori: {
      base: '#eef3ee',
      superficie: '#fbfdfb',
      superficie2: '#e6eee7',
      superficieSopra: '#dae5dc',
      bordo: '#ccdacf',
      accento: '#2f7d4f',
      accentoTesto: '#1f5c38',
      accentoSopra: '#276b43',
      sopraAccento: '#ffffff',
      ...statoChiaro,
      testo: scala('#0f1611', '#1c261f', '#324036', '#445247', '#546357', '#6f7e72'),
    },
  },
  {
    id: 'seppia',
    nome: 'Seppia',
    descrizione: 'Pergamena e marrone. Stanca meno gli occhi di sera.',
    chiaro: true,
    colori: {
      base: '#f0e7d6',
      superficie: '#faf4e8',
      superficie2: '#ece1cc',
      superficieSopra: '#e2d4bb',
      bordo: '#d6c4a4',
      accento: '#8a4b1c',
      accentoTesto: '#6a3713',
      accentoSopra: '#743f17',
      sopraAccento: '#ffffff',
      ...statoChiaro,
      testo: scala('#1c140c', '#2a2016', '#43362a', '#554638', '#655444', '#7f6d5b'),
    },
  },
  {
    id: 'lavanda',
    nome: 'Lavanda',
    descrizione: 'Bianco lilla e viola.',
    chiaro: true,
    colori: {
      base: '#f3f1fa',
      superficie: '#ffffff',
      superficie2: '#eeeaf8',
      superficieSopra: '#e3ddf3',
      bordo: '#d9d1ee',
      accento: '#6a4fd1',
      accentoTesto: '#4c35a8',
      accentoSopra: '#5a41b8',
      sopraAccento: '#ffffff',
      ...statoChiaro,
      testo: scala('#15121e', '#221e2e', '#3a3448', '#4b455a', '#5b556b', '#777188'),
    },
  },
  {
    id: 'pesca',
    nome: 'Pesca',
    descrizione: 'Pesca chiara e terracotta. Caldo e morbido sugli occhi.',
    chiaro: true,
    colori: {
      base: '#fbf1ea',
      superficie: '#fffaf6',
      superficie2: '#f7e8de',
      superficieSopra: '#f0dccf',
      bordo: '#e8cfbf',
      accento: '#b4492a',
      accentoTesto: '#8f361d',
      accentoSopra: '#9c3e23',
      sopraAccento: '#ffffff',
      ...statoChiaro,
      testo: scala('#1c120d', '#2a1d16', '#44342b', '#56453b', '#68564b', '#857165'),
    },
  },
  {
    id: 'petalo',
    nome: 'Petalo',
    descrizione: 'Rosa cipria e lampone.',
    chiaro: true,
    colori: {
      base: '#fbf0f3',
      superficie: '#fffafb',
      superficie2: '#f7e6ec',
      superficieSopra: '#f0d8e1',
      bordo: '#e8ccd6',
      accento: '#b0275e',
      accentoTesto: '#8c1c49',
      accentoSopra: '#971f50',
      sopraAccento: '#ffffff',
      ...statoChiaro,
      testo: scala('#1d1115', '#2b1b21', '#45323a', '#57434b', '#69545c', '#86707a'),
    },
  },
  {
    id: 'nebbia',
    nome: 'Nebbia',
    descrizione: 'Grigi freddi e petrolio. Sobrio, da ufficio.',
    chiaro: true,
    colori: {
      base: '#eef1f3',
      superficie: '#fbfcfd',
      superficie2: '#e6eaee',
      superficieSopra: '#dae0e5',
      bordo: '#cdd5dc',
      accento: '#2f6f7e',
      accentoTesto: '#1f5663',
      accentoSopra: '#285f6c',
      sopraAccento: '#ffffff',
      ...statoChiaro,
      testo: scala('#0f1417', '#1a2126', '#313b42', '#434e56', '#55616a', '#6f7b85'),
    },
  },
];

export const TEMA_PREDEFINITO = 'notte-oro';
/** Il tema chiaro usato da «Automatico» quando il sistema è in modalità chiara. */
export const TEMA_CHIARO_AUTOMATICO = 'carta';
/** «Automatico»: segue la modalità chiara o scura del sistema. */
export const AUTOMATICO = 'auto';

const CHIAVE = 'angel.tema';

export function temaDaId(id: string): Tema {
  return TEMI.find((tema) => tema.id === id) ?? TEMI.find((tema) => tema.id === TEMA_PREDEFINITO)!;
}

/**
 * La scelta salvata in questo browser.
 *
 * Solo qui, e non sul server: il tema è una preferenza di chi guarda, non una
 * proprietà del server Discord. Due moderatori sullo stesso server possono
 * volere due temi diversi.
 */
export function sceltaSalvata(): string {
  try {
    return localStorage.getItem(CHIAVE) ?? AUTOMATICO;
  } catch {
    // Navigazione privata o archiviazione bloccata: si parte dal predefinito.
    return AUTOMATICO;
  }
}

export function salvaScelta(scelta: string): void {
  try {
    localStorage.setItem(CHIAVE, scelta);
  } catch {
    // Non salvata: il tema vale per questa pagina e basta.
  }
}

/** Il tema effettivo per una scelta, sciogliendo «Automatico». */
export function temaPerScelta(scelta: string, sistemaChiaro: boolean): Tema {
  if (scelta === AUTOMATICO) {
    return temaDaId(sistemaChiaro ? TEMA_CHIARO_AUTOMATICO : TEMA_PREDEFINITO);
  }
  return temaDaId(scelta);
}

/** Le variabili CSS di un tema, come le leggono Tailwind e le pagine. */
export function variabili(tema: Tema): Record<string, string> {
  const c = tema.colori;
  return {
    '--color-base': c.base,
    '--color-surface': c.superficie,
    '--color-surface-2': c.superficie2,
    '--color-surface-hover': c.superficieSopra,
    '--color-border': c.bordo,
    '--color-accent': c.accento,
    '--color-accent-soft': c.accentoTesto,
    '--color-accent-hover': c.accentoSopra,
    '--color-on-accent': c.sopraAccento,
    '--color-danger': c.pericolo,
    '--color-danger-text': c.pericoloTesto,
    '--color-danger-hover': c.pericoloSopra,
    '--color-on-danger': c.sopraPericolo,
    '--color-warning': c.avviso,
    '--color-warning-text': c.avvisoTesto,
    '--color-success': c.successo,
    '--color-success-text': c.successoTesto,
    // La scala `neutral` di Tailwind: è quella che le pagine usano per il
    // testo, quindi ridefinirla qui porta ogni pagina nel tema.
    '--color-neutral-100': c.testo[100],
    '--color-neutral-200': c.testo[200],
    '--color-neutral-300': c.testo[300],
    '--color-neutral-400': c.testo[400],
    '--color-neutral-500': c.testo[500],
    '--color-neutral-600': c.testo[600],
    '--color-text': c.testo[200],
    '--font-pannello': tema.carattere ?? '',
  };
}

/** Applica un tema al documento. */
export function applicaTema(tema: Tema, radice: HTMLElement = document.documentElement): void {
  for (const [nome, valore] of Object.entries(variabili(tema))) {
    if (valore) radice.style.setProperty(nome, valore);
    else radice.style.removeProperty(nome);
  }
  // I controlli nativi — tendine, barre di scorrimento, caselle — seguono
  // questa proprietà: senza, una tendina bianca comparirebbe su un tema scuro.
  radice.style.colorScheme = tema.chiaro ? 'light' : 'dark';
  radice.dataset.tema = tema.id;
}
