import type { ReactNode } from 'react';

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
