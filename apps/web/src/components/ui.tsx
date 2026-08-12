import { useState, type ReactNode } from 'react';

export function Card({
  title,
  subtitle,
  children,
  action,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {subtitle && <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
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
    default: 'bg-[var(--color-surface-2)] hover:bg-[#262b36] border-[var(--color-border)]',
    // Testo scuro sull'oro: bianco su oro chiaro scende sotto il rapporto di
    // contrasto leggibile, ed è il pulsante che si preme di corsa.
    primary: 'bg-[var(--color-accent)] hover:bg-[#c2a052] border-transparent text-[#14161e] font-medium',
    danger: 'bg-[var(--color-danger)] hover:bg-[#c73538] border-transparent text-white',
    ghost: 'bg-transparent hover:bg-[var(--color-surface-2)] border-transparent',
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants}`}
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
    <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-sm text-[#f2a3ad]">
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
  onChange,
}: {
  value: number;
  step?: number | string;
  min?: number;
  title?: string;
  className?: string;
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
