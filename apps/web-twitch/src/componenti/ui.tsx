import type { ReactNode } from 'react';

/* ═══════════════════════════════════════════════════════════════════════
   Mattoni dell'interfaccia.

   Pochi e grandi. La tentazione, avendo già un design system per il pannello
   Discord, sarebbe copiarlo: è denso, compatto, adatto a chi lo conosce a
   memoria. Qui serve il contrario — chi apre questa pagina non l'ha mai
   vista, e ogni elemento deve dire cosa fa senza che nessuno glielo spieghi.
   ═══════════════════════════════════════════════════════════════════════ */

export function Riquadro({
  titolo,
  sottotitolo,
  azione,
  children,
  tono = 'normale',
}: {
  titolo?: string;
  sottotitolo?: string;
  azione?: ReactNode;
  children: ReactNode;
  tono?: 'normale' | 'attenzione' | 'pericolo';
}) {
  const bordo =
    tono === 'pericolo'
      ? 'border-[var(--color-pericolo)]/40'
      : tono === 'attenzione'
        ? 'border-[var(--color-attenzione)]/40'
        : 'border-[var(--color-bordo)]';

  return (
    <section
      className={`rounded-[var(--radius-morbido)] border ${bordo} bg-[var(--color-superficie)]/70 p-5 backdrop-blur-sm sm:p-6`}
    >
      {(titolo || azione) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {titolo && <h2 className="text-base font-semibold tracking-tight">{titolo}</h2>}
            {sottotitolo && (
              <p className="mt-1 max-w-prose text-sm leading-relaxed text-[var(--color-fioco)]">
                {sottotitolo}
              </p>
            )}
          </div>
          {azione}
        </header>
      )}
      {children}
    </section>
  );
}

export function Bottone({
  children,
  variante = 'normale',
  onClick,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  variante?: 'normale' | 'principale' | 'fantasma' | 'pericolo';
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const stili: Record<string, string> = {
    principale:
      'bg-[var(--color-accento)] text-[#160f24] hover:bg-[var(--color-accento-forte)] font-medium',
    normale:
      'bg-[var(--color-superficie-2)] text-[var(--color-testo)] hover:bg-[var(--color-bordo)] border border-[var(--color-bordo)]',
    fantasma: 'text-[var(--color-fioco)] hover:text-[var(--color-testo)] hover:bg-[var(--color-superficie-2)]',
    pericolo:
      'text-[var(--color-pericolo)] border border-[var(--color-pericolo)]/40 hover:bg-[var(--color-pericolo)]/10',
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-4 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${stili[variante]}`}
    >
      {children}
    </button>
  );
}

export function Etichetta({
  children,
  tono = 'neutro',
}: {
  children: ReactNode;
  tono?: 'neutro' | 'ok' | 'attenzione' | 'pericolo' | 'accento';
}) {
  const colori: Record<string, string> = {
    neutro: 'bg-[var(--color-superficie-2)] text-[var(--color-fioco)]',
    ok: 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]',
    attenzione: 'bg-[var(--color-attenzione)]/15 text-[var(--color-attenzione)]',
    pericolo: 'bg-[var(--color-pericolo)]/15 text-[var(--color-pericolo)]',
    accento: 'bg-[var(--color-accento)]/15 text-[var(--color-accento-forte)]',
  };

  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${colori[tono]}`}>
      {children}
    </span>
  );
}

/**
 * Interruttore.
 *
 * Con l'etichetta cliccabile e una descrizione sotto. La descrizione non è
 * decorazione: è la differenza fra una spunta che si capisce e una che si
 * lascia com'è per non sbagliare.
 */
export function Interruttore({
  acceso,
  onCambia,
  titolo,
  descrizione,
  disabilitato,
}: {
  acceso: boolean;
  onCambia: (valore: boolean) => void;
  titolo: string;
  descrizione?: string;
  disabilitato?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 py-2 ${disabilitato ? 'opacity-50' : ''}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={acceso}
        aria-label={titolo}
        disabled={disabilitato}
        onClick={() => onCambia(!acceso)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
          acceso ? 'bg-[var(--color-accento)]' : 'bg-[var(--color-bordo)]'
        }`}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${
            acceso ? 'left-6' : 'left-1'
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm">{titolo}</span>
        {descrizione && (
          <span className="mt-0.5 block text-xs leading-relaxed text-[var(--color-fioco)]">
            {descrizione}
          </span>
        )}
      </span>
    </label>
  );
}

export function Numero({
  valore,
  onCambia,
  titolo,
  descrizione,
  min,
  max,
  suffisso,
}: {
  valore: number;
  onCambia: (valore: number) => void;
  titolo: string;
  descrizione?: string;
  min?: number;
  max?: number;
  suffisso?: string;
}) {
  return (
    <label className="flex items-start justify-between gap-4 py-2">
      <span className="min-w-0">
        <span className="block text-sm">{titolo}</span>
        {descrizione && (
          <span className="mt-0.5 block text-xs leading-relaxed text-[var(--color-fioco)]">
            {descrizione}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <input
          type="number"
          value={valore}
          min={min}
          max={max}
          onChange={(evento) => {
            const numero = Number(evento.target.value);
            if (Number.isFinite(numero)) onCambia(numero);
          }}
          className="w-24 rounded-lg border border-[var(--color-bordo)] bg-[var(--color-superficie-2)] px-3 py-1.5 text-right text-sm tabular-nums"
        />
        {suffisso && <span className="text-xs text-[var(--color-fioco)]">{suffisso}</span>}
      </span>
    </label>
  );
}

export function Testo({
  valore,
  onCambia,
  titolo,
  descrizione,
  segnaposto,
  righe,
  max,
}: {
  valore: string;
  onCambia: (valore: string) => void;
  titolo: string;
  descrizione?: string;
  segnaposto?: string;
  righe?: number;
  max?: number;
}) {
  const classi =
    'w-full rounded-lg border border-[var(--color-bordo)] bg-[var(--color-superficie-2)] px-3 py-2 text-sm placeholder:text-[var(--color-fioco)]/60';

  return (
    <label className="block py-2">
      <span className="block text-sm">{titolo}</span>
      {descrizione && (
        <span className="mt-0.5 mb-2 block text-xs leading-relaxed text-[var(--color-fioco)]">
          {descrizione}
        </span>
      )}
      {righe && righe > 1 ? (
        <textarea
          value={valore}
          rows={righe}
          maxLength={max}
          placeholder={segnaposto}
          onChange={(evento) => onCambia(evento.target.value)}
          className={`${classi} resize-y`}
        />
      ) : (
        <input
          type="text"
          value={valore}
          maxLength={max}
          placeholder={segnaposto}
          onChange={(evento) => onCambia(evento.target.value)}
          className={classi}
        />
      )}
    </label>
  );
}

/**
 * Elenco di parole separate da virgola.
 *
 * Lo stato locale tiene il **testo grezzo** e non il valore normalizzato. È
 * la lezione più cara imparata sull'altro pannello: ricalcolando il campo dal
 * valore a ogni battuta, la virgola veniva mangiata nell'istante in cui la si
 * digitava, e diventava impossibile scrivere una lista.
 */
export function Elenco({
  valori,
  onCambia,
  titolo,
  descrizione,
  segnaposto,
}: {
  valori: string[];
  onCambia: (valori: string[]) => void;
  titolo: string;
  descrizione?: string;
  segnaposto?: string;
}) {
  return (
    <label className="block py-2">
      <span className="block text-sm">{titolo}</span>
      {descrizione && (
        <span className="mt-0.5 mb-2 block text-xs leading-relaxed text-[var(--color-fioco)]">
          {descrizione}
        </span>
      )}
      <textarea
        defaultValue={valori.join(', ')}
        rows={2}
        placeholder={segnaposto}
        onBlur={(evento) =>
          onCambia(
            evento.target.value
              .split(',')
              .map((voce) => voce.trim())
              .filter(Boolean),
          )
        }
        className="w-full resize-y rounded-lg border border-[var(--color-bordo)] bg-[var(--color-superficie-2)] px-3 py-2 text-sm placeholder:text-[var(--color-fioco)]/60"
      />
      <span className="mt-1 block text-xs text-[var(--color-fioco)]">
        Separale con una virgola. Si salva quando esci dal campo.
      </span>
    </label>
  );
}

export function Vuoto({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-[var(--color-bordo)] px-4 py-8 text-center text-sm text-[var(--color-fioco)]">
      {children}
    </p>
  );
}

export function Errore({ messaggio }: { messaggio: string }) {
  return (
    <div className="mb-4 rounded-lg border border-[var(--color-pericolo)]/40 bg-[var(--color-pericolo)]/10 px-4 py-3 text-sm text-[var(--color-pericolo)]">
      {messaggio}
    </div>
  );
}

export function Caricamento() {
  return (
    <div className="flex items-center gap-3 py-12 text-sm text-[var(--color-fioco)]">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-bordo)] border-t-[var(--color-accento)]" />
      Carico…
    </div>
  );
}

/** Data leggibile. Le ore sono quelle del browser, che è dove si legge. */
export function quando(valore: string | Date): string {
  const data = typeof valore === 'string' ? new Date(valore) : valore;
  return data.toLocaleString('it-IT', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
