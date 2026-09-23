import { useEffect, useRef, type ReactNode } from 'react';
import { Check, Monitor, X } from 'lucide-react';
import { useTema } from '../tema.js';
import {
  AUTOMATICO,
  TEMA_CHIARO_AUTOMATICO,
  TEMA_PREDEFINITO,
  TEMI,
  temaDaId,
  type Tema,
} from '../temi.js';

/* ═══════════════════════════════════════════════════════════════════════
   LA SCELTA DEL TEMA

   Ogni tema si mostra con i suoi colori, non con il nome soltanto: una
   miniatura del pannello — fondo, barra, testo, pulsante — dice in un colpo
   d'occhio quello che «Ametista» non dice. La scelta vale subito e resta in
   questo browser.
   ═══════════════════════════════════════════════════════════════════════ */

function Miniatura({ tema }: { tema: Tema }) {
  const c = tema.colori;
  return (
    <div
      aria-hidden
      className="flex h-16 gap-1.5 overflow-hidden rounded-lg p-1.5"
      style={{ background: c.base, boxShadow: `inset 0 0 0 1px ${c.bordo}` }}
    >
      <div className="flex w-1/4 flex-col gap-1 rounded-md p-1" style={{ background: c.superficie }}>
        <span className="h-1 w-full rounded-full" style={{ background: c.accento }} />
        <span className="h-1 w-3/4 rounded-full" style={{ background: c.testo[500] }} />
        <span className="h-1 w-2/3 rounded-full" style={{ background: c.testo[500] }} />
      </div>
      <div className="flex flex-1 flex-col gap-1 rounded-md p-1.5" style={{ background: c.superficie }}>
        <span className="h-1.5 w-2/3 rounded-full" style={{ background: c.testo[200] }} />
        <span className="h-1 w-5/6 rounded-full" style={{ background: c.testo[500] }} />
        <div className="mt-auto flex items-center gap-1">
          <span className="h-2.5 w-7 rounded" style={{ background: c.accento }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.successo }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.avviso }} />
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.pericolo }} />
        </div>
      </div>
    </div>
  );
}

function Opzione({
  scelto,
  onScegli,
  titolo,
  descrizione,
  children,
}: {
  scelto: boolean;
  onScegli: () => void;
  titolo: string;
  descrizione: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={scelto}
      onClick={onScegli}
      className={`flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors ${
        scelto
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
          : 'border-[var(--color-border)] hover:border-neutral-500 hover:bg-[var(--color-surface-2)]'
      }`}
    >
      {children}
      <div className="px-0.5">
        <div className="flex items-center gap-1.5 text-sm font-medium text-neutral-100">
          {titolo}
          {scelto && <Check aria-hidden size={14} className="text-[var(--color-accent-soft)]" />}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-neutral-500">{descrizione}</p>
      </div>
    </button>
  );
}

function Elenco({ titolo, temi, scelta, scegli }: {
  titolo: string;
  temi: Tema[];
  scelta: string;
  scegli: (id: string) => void;
}) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
        {titolo}
      </h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {temi.map((tema) => (
          <Opzione
            key={tema.id}
            scelto={scelta === tema.id}
            onScegli={() => scegli(tema.id)}
            titolo={tema.nome}
            descrizione={tema.descrizione}
          >
            <Miniatura tema={tema} />
          </Opzione>
        ))}
      </div>
    </section>
  );
}

export function SceltaTema({ onChiudi }: { onChiudi: () => void }) {
  const { scelta, scegli } = useTema();
  const chiudi = useRef<HTMLButtonElement>(null);

  // Esc chiude, e il fuoco torna al pulsante da cui si era aperto.
  useEffect(() => {
    const prima = document.activeElement as HTMLElement | null;
    chiudi.current?.focus();
    const esc = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') onChiudi();
    };
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('keydown', esc);
      prima?.focus?.();
    };
  }, [onChiudi]);

  const notte = temaDaId(TEMA_PREDEFINITO);
  const giorno = temaDaId(TEMA_CHIARO_AUTOMATICO);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-3 py-[6vh] sm:px-6">
      <div aria-hidden className="fixed inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onChiudi} />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="scelta-tema-titolo"
        className="relative w-full max-w-4xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl shadow-black/40"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
          <div>
            <h2 id="scelta-tema-titolo" className="text-lg font-semibold text-neutral-100">
              Tema del pannello
            </h2>
            <p className="mt-0.5 text-sm text-neutral-400">
              Vale solo per questo browser: gli altri moderatori tengono il loro. Tutti i temi
              passano la verifica del contrasto.
            </p>
          </div>
          <button
            ref={chiudi}
            type="button"
            onClick={onChiudi}
            aria-label="Chiudi"
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-[var(--color-surface-2)] hover:text-neutral-100"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-6 p-5">
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
              Segui il sistema
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <Opzione
                scelto={scelta === AUTOMATICO}
                onScegli={() => scegli(AUTOMATICO)}
                titolo="Automatico"
                descrizione={`${notte.nome} con il sistema scuro, ${giorno.nome} con quello chiaro.`}
              >
                {/* Metà e metà, tagliate in diagonale: i due temi fra cui sceglie. */}
                <div aria-hidden className="relative h-16">
                  <div className="absolute inset-0">
                    <Miniatura tema={notte} />
                  </div>
                  <div
                    className="absolute inset-0"
                    style={{ clipPath: 'polygon(58% 0, 100% 0, 100% 100%, 42% 100%)' }}
                  >
                    <Miniatura tema={giorno} />
                  </div>
                  <Monitor
                    size={18}
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-black/55 p-0.5 text-white"
                  />
                </div>
              </Opzione>
            </div>
          </section>

          <Elenco titolo="Scuri" temi={TEMI.filter((tema) => !tema.chiaro)} scelta={scelta} scegli={scegli} />
          <Elenco titolo="Chiari" temi={TEMI.filter((tema) => tema.chiaro)} scelta={scelta} scegli={scegli} />
        </div>
      </div>
    </div>
  );
}
