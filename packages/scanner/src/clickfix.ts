import { normalize } from '@angel/shared';
import type { Finding } from './types.js';

/* ═══════════════════════════════════════════════════════════════════════
   CLICKFIX / FINTA CAPTCHA

   L'attacco non sfrutta alcuna vulnerabilità: convince la persona a eseguire
   il comando da sola. La pagina mostra una "verifica umano" volutamente rotta e
   propone la scorciatoia — «premi Win+R, incolla, Invio» — mentre negli appunti
   c'è già una riga PowerShell offuscata.

   Cresciuto del 517% nel primo semestre 2025; l'8 giugno 2026 la FTC ha emesso
   un avviso pubblico. Le varianti recenti usano shellcode Donut e script App-V
   firmati Microsoft per aggirare gli EDR, quindi l'antivirus della vittima non
   è una garanzia: conviene fermare l'istruzione prima che venga letta.

   L'istruzione compare sia nel testo dei messaggi sia dentro gli screenshot,
   perciò questa funzione viene applicata anche al testo estratto via OCR.
   ═══════════════════════════════════════════════════════════════════════ */

/** Comandi che scaricano ed eseguono codice in un colpo solo. */
const EXECUTION_PATTERNS: { re: RegExp; detail: string; score: number }[] = [
  {
    re: /powershell(?:\.exe)?\s+(?:-\w+\s+)*-e(?:nc|ncodedcommand)?\b/i,
    detail: 'Comando PowerShell con payload codificato in base64',
    score: 90,
  },
  {
    re: /\b(?:iex|invoke-expression)\s*[(\s]/i,
    detail: 'Invoke-Expression: esegue codice scaricato al volo',
    score: 85,
  },
  {
    re: /\b(?:irm|iwr|invoke-webrequest|invoke-restmethod)\s+\S*https?:/i,
    detail: 'Download remoto via PowerShell',
    score: 80,
  },
  {
    re: /\bmshta\s+https?:/i,
    detail: 'mshta con URL remoto: esecuzione di script HTML applicativo',
    score: 85,
  },
  {
    re: /\b(?:curl|wget)\s+[^\n|]+\|\s*(?:sudo\s+)?(?:ba|z|d)?sh\b/i,
    detail: 'Download eseguito direttamente dalla shell',
    score: 80,
  },
  {
    re: /\bcertutil\s+-urlcache\b/i,
    detail: 'certutil usato come downloader (tecnica living-off-the-land)',
    score: 80,
  },
  {
    re: /\bbitsadmin\s+\/transfer\b/i,
    detail: 'bitsadmin usato come downloader',
    score: 75,
  },
  {
    re: /\bregsvr32\s+\/[isu]+\s+\S*https?:/i,
    detail: 'regsvr32 con URL remoto',
    score: 80,
  },
  {
    re: /\bcmd(?:\.exe)?\s+\/c\s+.*(?:http|powershell)/i,
    detail: 'cmd /c che avvia un download o PowerShell',
    score: 70,
  },
];

/** Istruzioni rivolte all'utente: sono la parte riconoscibile dell'inganno. */
const INSTRUCTION_PATTERNS: { re: RegExp; detail: string; score: number }[] = [
  {
    re: /\b(?:win(?:dows)?|⊞)\s*\+\s*r\b/i,
    detail: 'Istruzione ad aprire la finestra Esegui (Win+R)',
    score: 55,
  },
  {
    re: /\bctrl\s*\+\s*v\b/i,
    detail: 'Istruzione a incollare dagli appunti',
    score: 35,
  },
  {
    re: /\b(?:premi|press|tieni premuto|hold)\b[^.\n]{0,40}\b(?:win(?:dows)?|⊞)\b/i,
    detail: 'Istruzione a premere il tasto Windows',
    score: 45,
  },
  {
    re: /\bincolla\b[^.\n]{0,30}\b(?:invio|enter)\b/i,
    detail: 'Istruzione "incolla e premi Invio"',
    score: 50,
  },
  {
    re: /\bpaste\b[^.\n]{0,30}\b(?:enter|return)\b/i,
    detail: 'Istruzione "paste and press Enter"',
    score: 50,
  },
  {
    re: /\b(?:verifica|verify|conferma|confirm)\b[^.\n]{0,60}\b(?:umano|human|robot|captcha)\b/i,
    detail: 'Testo da finta verifica CAPTCHA',
    score: 25,
  },
  {
    re: /\bi'?m not a robot\b|\bnon sono un robot\b/i,
    detail: 'Formula tipica della finta CAPTCHA',
    score: 20,
  },
  {
    re: /\b(?:terminal|terminale|prompt dei comandi|command prompt|powershell)\b[^.\n]{0,40}\b(?:apri|open|incolla|paste)\b/i,
    detail: 'Istruzione ad aprire un terminale e incollare',
    score: 50,
  },
];

export interface ClickFixResult {
  detected: boolean;
  score: number;
  matches: { pattern: string; detail: string }[];
}

/**
 * Analizza un testo alla ricerca del pattern ClickFix.
 *
 * La logica non somma ciecamente: la combinazione «istruzione a usare Win+R» +
 * «riga di comando» è ciò che rende il caso certo. Una sola delle due può
 * comparire in una discussione tecnica legittima.
 */
export function detectClickFix(text: string, extraPatterns: string[] = []): ClickFixResult {
  if (!text) return { detected: false, score: 0, matches: [] };
  const haystack = normalize(text);
  const matches: { pattern: string; detail: string }[] = [];

  let executionScore = 0;
  let instructionScore = 0;

  for (const { re, detail, score } of EXECUTION_PATTERNS) {
    if (re.test(text) || re.test(haystack)) {
      matches.push({ pattern: re.source, detail });
      executionScore = Math.max(executionScore, score);
    }
  }
  for (const { re, detail, score } of INSTRUCTION_PATTERNS) {
    if (re.test(text) || re.test(haystack)) {
      matches.push({ pattern: re.source, detail });
      instructionScore = Math.max(instructionScore, score);
    }
  }
  for (const raw of extraPatterns) {
    try {
      const re = new RegExp(raw, 'i');
      if (re.test(haystack)) {
        matches.push({ pattern: raw, detail: 'Pattern personalizzato del server' });
        instructionScore = Math.max(instructionScore, 40);
      }
    } catch {
      // Una regex scritta male nel pannello non deve bloccare lo scanner.
    }
  }

  if (matches.length === 0) return { detected: false, score: 0, matches: [] };

  // Entrambi i segnali presenti: caso pieno, punteggio massimo.
  const combined =
    executionScore > 0 && instructionScore > 0
      ? Math.min(100, executionScore + instructionScore)
      : Math.max(executionScore, instructionScore);

  return { detected: combined >= 50, score: combined, matches };
}

export function clickFixFindings(
  text: string,
  origin: 'TEXT' | 'OCR',
  extraPatterns: string[] = [],
): Finding[] {
  const result = detectClickFix(text, extraPatterns);
  if (!result.detected) return [];
  return [
    {
      code: origin === 'OCR' ? 'OCR_CLICKFIX' : 'TEXT_CLICKFIX',
      detail:
        `Schema ClickFix rilevato${origin === 'OCR' ? " nell'immagine" : ''}: ` +
        result.matches.map((m) => m.detail).join('; '),
      score: result.score,
      meta: { matches: result.matches },
    },
  ];
}
