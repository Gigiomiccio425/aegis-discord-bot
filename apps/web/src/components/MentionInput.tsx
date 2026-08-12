import { useRef, useState } from 'react';
import { useInventario } from './pickers.js';

/* ═══════════════════════════════════════════════════════════════════════
   SCRIVERE MENZIONI SENZA CONOSCERE GLI ID

   Su Discord una menzione è `<#1272925031764328471>`, non `#annunci`. Chi
   scrive un messaggio dal pannello non ha modo di saperlo: o incolla l'ID a
   mano dopo averlo copiato dal client, o rinuncia alla menzione.

   Qui `#` e `@` aprono l'elenco di ciò che esiste nel server, come nel client
   di Discord. Si sceglie il nome, viene inserito l'ID. Chi non vuole l'elenco
   continua a scrivere: il suggerimento sparisce da solo appena il testo smette
   di corrispondere a qualcosa.
   ═══════════════════════════════════════════════════════════════════════ */

interface Voce {
  id: string;
  nome: string;
  /** Come va scritto nel messaggio perché Discord lo interpreti. */
  token: string;
  dettaglio?: string;
}

export function MentionInput({
  guildId,
  value,
  onChange,
  rows = 4,
  placeholder,
  maxLength,
  variabili = [],
}: {
  guildId: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  /** Segnaposto sostituiti al momento della pubblicazione, es. `{titolo}`. */
  variabili?: { nome: string; descrizione: string }[];
}) {
  const inventario = useInventario(guildId);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [ricerca, setRicerca] = useState<{ inizio: number; segno: '#' | '@'; testo: string } | null>(
    null,
  );
  const [evidenziato, setEvidenziato] = useState(0);

  /**
   * Cerca a ritroso dal punto di inserimento un `#` o `@` ancora aperto.
   *
   * Si ferma allo spazio e all'a capo: dopo di quelli il segno non sta più
   * introducendo un nome, e continuare a proporre suggerimenti mentre si
   * scrive una frase normale sarebbe solo fastidio.
   */
  const aggiornaRicerca = (testo: string, cursore: number): void => {
    for (let i = cursore - 1; i >= 0 && cursore - i <= 40; i -= 1) {
      const carattere = testo[i]!;
      if (carattere === ' ' || carattere === '\n') break;
      if (carattere === '#' || carattere === '@') {
        setRicerca({ inizio: i, segno: carattere, testo: testo.slice(i + 1, cursore) });
        setEvidenziato(0);
        return;
      }
    }
    setRicerca(null);
  };

  const voci: Voce[] = !ricerca
    ? []
    : ricerca.segno === '#'
      ? inventario.channels
          .filter((canale) => canale.type === 'TEXT' || canale.type === 'ANNOUNCEMENT')
          .map((canale) => ({
            id: canale.id,
            nome: `#${canale.name}`,
            token: `<#${canale.id}>`,
          }))
      : [
          { id: 'everyone', nome: '@everyone', token: '@everyone', dettaglio: 'tutti i membri' },
          { id: 'here', nome: '@here', token: '@here', dettaglio: 'chi è online' },
          ...inventario.roles
            .filter((ruolo) => !ruolo.everyone)
            .map((ruolo) => ({
              id: ruolo.id,
              nome: `@${ruolo.name}`,
              token: `<@&${ruolo.id}>`,
              dettaglio: 'ruolo',
            })),
        ];

  const filtrate = voci
    .filter((voce) => voce.nome.slice(1).toLowerCase().includes(ricerca?.testo.toLowerCase() ?? ''))
    .slice(0, 8);

  const inserisci = (voce: Voce): void => {
    if (!ricerca) return;
    const area = areaRef.current;
    const cursore = area?.selectionStart ?? value.length;
    const prossimo = `${value.slice(0, ricerca.inizio)}${voce.token} ${value.slice(cursore)}`;
    onChange(prossimo);
    setRicerca(null);

    // Il punto di inserimento va rimesso dopo il token: senza, torna in fondo
    // al testo e chi stava scrivendo in mezzo perde il segno.
    const posizione = ricerca.inizio + voce.token.length + 1;
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(posizione, posizione);
    });
  };

  /** Avvolge la selezione, o inserisce i due segni dove sta il cursore. */
  const avvolgi = (prima: string, dopo = prima): void => {
    const area = areaRef.current;
    if (!area) return;
    const inizio = area.selectionStart;
    const fine = area.selectionEnd;
    const selezione = value.slice(inizio, fine);
    onChange(`${value.slice(0, inizio)}${prima}${selezione}${dopo}${value.slice(fine)}`);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(inizio + prima.length, fine + prima.length);
    });
  };

  const inserisciTesto = (testo: string): void => {
    const area = areaRef.current;
    const posizione = area?.selectionStart ?? value.length;
    onChange(`${value.slice(0, posizione)}${testo}${value.slice(posizione)}`);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(posizione + testo.length, posizione + testo.length);
    });
  };

  return (
    <div className="relative">
      <div className="mb-1 flex flex-wrap items-center gap-1">
        {(
          [
            ['#', 'canale', () => inserisciTesto('#')],
            ['@', 'menzione', () => inserisciTesto('@')],
            ['B', 'grassetto', () => avvolgi('**')],
            ['I', 'corsivo', () => avvolgi('*')],
            ['U', 'sottolineato', () => avvolgi('__')],
            ['S', 'barrato', () => avvolgi('~~')],
            ['</>', 'codice', () => avvolgi('`')],
            ['▨', 'testo nascosto', () => avvolgi('||')],
          ] as const
        ).map(([etichetta, titolo, azione]) => (
          <button
            key={titolo}
            type="button"
            title={titolo}
            onClick={azione}
            className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-neutral-400 hover:text-neutral-200"
          >
            {etichetta}
          </button>
        ))}
      </div>

      <textarea
        ref={areaRef}
        rows={rows}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
        onChange={(event) => {
          onChange(event.target.value);
          aggiornaRicerca(event.target.value, event.target.selectionStart);
        }}
        onClick={(event) =>
          aggiornaRicerca(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onBlur={() => {
          // Ritardo: il clic su una voce dell'elenco toglie il fuoco prima di
          // arrivare al gestore, e chiudere subito lo renderebbe non cliccabile.
          setTimeout(() => setRicerca(null), 150);
        }}
        onKeyDown={(event) => {
          if (filtrate.length === 0) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setEvidenziato((corrente) => (corrente + 1) % filtrate.length);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setEvidenziato((corrente) => (corrente - 1 + filtrate.length) % filtrate.length);
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            inserisci(filtrate[evidenziato]!);
          } else if (event.key === 'Escape') {
            setRicerca(null);
          }
        }}
      />

      {filtrate.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-56 w-full max-w-sm overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
          {filtrate.map((voce, indice) => (
            <button
              key={voce.token}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => inserisci(voce)}
              onMouseEnter={() => setEvidenziato(indice)}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${
                indice === evidenziato
                  ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent-soft)]'
                  : 'text-neutral-300'
              }`}
            >
              <span>{voce.nome}</span>
              {voce.dettaglio && <span className="text-xs text-neutral-600">{voce.dettaglio}</span>}
            </button>
          ))}
        </div>
      )}

      {variabili.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {variabili.map((variabile) => (
            <button
              key={variabile.nome}
              type="button"
              title={variabile.descrizione}
              onClick={() => inserisciTesto(`{${variabile.nome}}`)}
              className="rounded-md bg-[var(--color-surface-2)] px-2 py-0.5 font-mono text-[11px] text-neutral-400 hover:text-[var(--color-accent-soft)]"
            >
              {`{${variabile.nome}}`}
            </button>
          ))}
        </div>
      )}

      {!inventario.pronto && (
        <p className="mt-1 text-xs text-neutral-600">
          Elenco di canali e ruoli non disponibile: il bot lo pubblica pochi secondi dopo l&apos;avvio.
        </p>
      )}
    </div>
  );
}

/**
 * Riscrive i token in nomi leggibili, per mostrare un messaggio già scritto.
 *
 * Serve nell'anteprima: `<#1272925031764328471>` non dice niente a nessuno,
 * mentre `#annunci` si riconosce a colpo d'occhio.
 */
export function LeggibileConNomi(
  testo: string,
  canali: { id: string; name: string }[],
  ruoli: { id: string; name: string }[],
): string {
  return testo
    .replace(/<#(\d+)>/g, (intero, id: string) => {
      const canale = canali.find((voce) => voce.id === id);
      return canale ? `#${canale.name}` : intero;
    })
    .replace(/<@&(\d+)>/g, (intero, id: string) => {
      const ruolo = ruoli.find((voce) => voce.id === id);
      return ruolo ? `@${ruolo.name}` : intero;
    });
}
