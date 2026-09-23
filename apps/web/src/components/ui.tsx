import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { doveSiamo } from '../navigazione.js';

/* ═══════════════════════════════════════════════════════════════════════
   L'IMPAGINAZIONE COMUNE

   Ogni pagina comincia allo stesso modo — icona, titolo, una riga che dice
   a cosa serve, le azioni a destra — e divide il resto in gruppi con un
   titolo. Chi apre una pagina che non usa da un mese deve capire in due
   secondi dov'è e cosa ci si fa, senza leggere ogni scheda.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * L'intestazione di una pagina.
 *
 * Titolo, icona e descrizione vengono dalla navigazione, così la pagina
 * dice di sé la stessa cosa che dice la barra laterale. Si possono
 * sostituire dove la pagina ha qualcosa di più preciso da dire.
 */
export function IntestazionePagina({
  titolo,
  descrizione,
  azioni,
  children,
}: {
  titolo?: ReactNode;
  descrizione?: ReactNode;
  azioni?: ReactNode;
  /** Sotto il titolo: avvisi che riguardano tutta la pagina. */
  children?: ReactNode;
}) {
  const { pathname } = useLocation();
  const qui = doveSiamo(pathname);
  const Icona = qui?.voce.icona;

  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {Icona && (
            <span
              aria-hidden
              className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent)]/12 text-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]/25"
            >
              <Icona size={20} strokeWidth={1.8} />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
              {titolo ?? qui?.voce.label}
            </h1>
            {(descrizione ?? qui?.voce.descrizione) && (
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-neutral-400">
                {descrizione ?? qui?.voce.descrizione}
              </p>
            )}
          </div>
        </div>
        {azioni && <div className="flex flex-wrap items-center gap-2">{azioni}</div>}
      </div>
      {children && <div className="mt-4 space-y-3">{children}</div>}
    </header>
  );
}

/**
 * Un gruppo di schede con un titolo.
 *
 * Divide una pagina per quello che ci si fa: «Preparazione», «Emergenza».
 * L'occhio scorre i titoli dei gruppi e salta quelli che non c'entrano,
 * invece di leggere ogni scheda per scoprire di cosa parla.
 */
export function Gruppo({
  titolo,
  descrizione,
  id,
  children,
}: {
  titolo: string;
  descrizione?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
          {titolo}
        </h2>
        <span aria-hidden className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
      {descrizione && <p className="-mt-2 text-sm text-neutral-400">{descrizione}</p>}
      {children}
    </section>
  );
}

export function Card({
  title,
  subtitle,
  children,
  action,
  id,
  icona: Icona,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
  id?: string;
  icona?: LucideIcon;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm shadow-black/5"
    >
      {(title || action) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-start gap-2.5">
            {Icona && (
              <Icona
                aria-hidden
                size={18}
                strokeWidth={1.8}
                className="mt-0.5 shrink-0 text-[var(--color-accent-soft)]"
              />
            )}
            <div className="min-w-0">
              {title && <h2 className="text-base font-semibold text-neutral-100">{title}</h2>}
              {subtitle && <p className="mt-1 text-sm leading-relaxed text-neutral-400">{subtitle}</p>}
            </div>
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * Acceso o spento.
 *
 * Un interruttore dice lo stato a colpo d'occhio anche da lontano, dove una
 * casella di spunta piccola si confonde con le altre. È un pulsante vero,
 * con `role="switch"`: la tastiera lo raggiunge e lo spazio lo cambia.
 */
export function Interruttore({
  acceso,
  onChange,
  etichetta,
  id,
}: {
  acceso: boolean;
  onChange: (acceso: boolean) => void;
  /** Per chi usa un lettore di schermo, quando l'etichetta visibile non è collegata. */
  etichetta?: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={acceso}
      aria-label={etichetta}
      onClick={() => onChange(!acceso)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
        acceso
          ? 'border-transparent bg-[var(--color-accent)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-4 w-4 rounded-full shadow transition-transform ${
          acceso
            ? 'translate-x-[22px] bg-[var(--color-on-accent)]'
            : 'translate-x-[3px] bg-neutral-500'
        }`}
      />
    </button>
  );
}

export function Stat({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'danger' | 'warning' | 'success';
  hint?: string;
}) {
  const toneClass = {
    neutral: 'text-neutral-100',
    danger: 'text-[var(--color-danger)]',
    warning: 'text-[var(--color-warning)]',
    success: 'text-[var(--color-success)]',
  }[tone];

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-2 text-3xl font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-neutral-500">{hint}</div>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const variants = {
    default: 'bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-hover)] border-[var(--color-border)]',
    // Testo scuro sull'oro: bianco su oro chiaro scende sotto il rapporto di
    // contrasto leggibile, ed è il pulsante che si preme di corsa.
    primary: 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] border-transparent text-[var(--color-on-accent)] font-medium',
    danger: 'bg-[var(--color-danger)] hover:bg-[var(--color-danger-hover)] border-transparent text-[var(--color-on-danger)]',
    ghost: 'bg-transparent hover:bg-[var(--color-surface-2)] border-transparent',
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants}`}
    >
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'danger' | 'warning' | 'success' | 'accent';
}) {
  const tones = {
    neutral: 'bg-[var(--color-surface-2)] text-neutral-300',
    danger: 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]',
    warning: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]',
    success: 'bg-[var(--color-success)]/15 text-[var(--color-success)]',
    accent: 'bg-[var(--color-accent)]/15 text-[var(--color-accent-soft)]',
  }[tone];

  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${tones}`}>
      {children}
    </span>
  );
}

export function severityTone(severity: number): 'neutral' | 'warning' | 'danger' {
  if (severity >= 80) return 'danger';
  if (severity >= 40) return 'warning';
  return 'neutral';
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-neutral-500">{children}</p>;
}

export function Loading() {
  return <p className="py-8 text-center text-sm text-neutral-500">Caricamento…</p>;
}

export function ErrorBox({ message }: { message: string }) {
  return (
    // `whitespace-pre-line`: gli errori di validazione arrivano con un campo
    // per riga, e schiacciarli su una riga sola li rende di nuovo illeggibili.
    <div className="whitespace-pre-line rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-sm text-[var(--color-danger-text)]">
      {message}
    </div>
  );
}

export function formatDate(value: string | Date): string {
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}

/* ═══════════════════════════════════════════════════════════════════════
   CONTROLLI CHE NON COMBATTONO CON CHI SCRIVE

   Il problema è sempre lo stesso: il valore mostrato viene ricalcolato dal
   dato normalizzato a ogni tasto premuto. La virgola appena scritta non
   sopravvive alla normalizzazione — `'a,'` diventa `['a']` diventa `'a'` — e
   il secondo valore non si riesce proprio a cominciare. Lo stesso vale per il
   numero svuotato per riscriverlo, che torna 0 sotto le dita.

   La soluzione è tenere il testo grezzo mentre il campo è in uso e
   normalizzare solo il dato che esce. Il testo mostrato si riallinea quando il
   valore cambia da fuori — ripristino di una versione, ricarica — e non mentre
   si scrive.
   ═══════════════════════════════════════════════════════════════════════ */

/** Elenco di valori semplici, separati da virgola. */
export function ListInput({
  value,
  numeric = false,
  className,
  placeholder = 'valori separati da virgola',
  onChange,
}: {
  value: (string | number)[];
  numeric?: boolean;
  className?: string;
  placeholder?: string;
  onChange: (value: (string | number)[]) => void;
}) {
  const canonico = value.join(', ');
  const [text, setText] = useState(canonico);
  const [ultimo, setUltimo] = useState(canonico);

  // Riallineamento solo su cambi che non vengono da qui: si confronta con
  // l'ultimo valore prodotto da questo campo, non con il testo scritto, che
  // durante la digitazione è legittimamente diverso dal canonico.
  if (canonico !== ultimo) {
    setUltimo(canonico);
    setText(canonico);
  }

  return (
    <input
      type="text"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const valori = event.target.value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => (numeric ? Number(item) : item))
          .filter((item) => !(typeof item === 'number' && Number.isNaN(item)));
        setUltimo(valori.join(', '));
        onChange(valori);
      }}
      className={
        className ??
        'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm'
      }
      placeholder={placeholder}
    />
  );
}

/**
 * Numero.
 *
 * Il campo può restare temporaneamente vuoto o contenere solo un meno: sono
 * stati di passaggio mentre si riscrive, e in quel momento il valore salvato
 * resta l'ultimo numero valido invece di diventare zero.
 */
export function NumberInput({
  value,
  step,
  min,
  title,
  className,
  id,
  onChange,
}: {
  value: number;
  step?: number | string;
  min?: number;
  title?: string;
  className?: string;
  id?: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [ultimo, setUltimo] = useState(value);

  if (value !== ultimo) {
    setUltimo(value);
    setText(String(value));
  }

  return (
    <input
      id={id}
      type="number"
      value={text}
      step={step}
      min={min}
      title={title}
      onChange={(event) => {
        setText(event.target.value);
        const numero = Number(event.target.value);
        if (event.target.value.trim() === '' || Number.isNaN(numero)) return;
        setUltimo(numero);
        onChange(numero);
      }}
      onBlur={() => {
        // Uscendo dal campo lo stato di passaggio finisce: si rimette ciò che
        // è davvero salvato, così non resta a schermo un vuoto che non
        // corrisponde a niente.
        if (text.trim() === '' || Number.isNaN(Number(text))) setText(String(ultimo));
      }}
      className={
        className ??
        'w-32 shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm'
      }
    />
  );
}
