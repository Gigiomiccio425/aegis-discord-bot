import { useEffect, useState } from 'react';
import { api } from '../api.js';

/* ═══════════════════════════════════════════════════════════════════════
   SCEGLIERE UN CANALE O UN RUOLO

   Prima si incollava l'ID. Non è solo scomodo: un ID sbagliato non dà errore,
   punta a un altro canale, e la cosa si scopre il giorno in cui l'avviso non
   arriva dove doveva. Con un elenco quell'intera categoria di errori sparisce.

   L'elenco lo scrive il bot in Redis e lo serve l'API. Se non c'è ancora —
   bot appena riavviato, o non connesso — si torna al campo con l'ID a mano
   invece di bloccare la configurazione: un pannello che non lascia lavorare
   perché manca una comodità è peggio della comodità mancante.
   ═══════════════════════════════════════════════════════════════════════ */

export interface Canale {
  id: string;
  name: string;
  type: 'TEXT' | 'VOICE' | 'CATEGORY' | 'FORUM' | 'STAGE' | 'ANNOUNCEMENT' | 'ALTRO';
  parentId: string | null;
  position: number;
}

export interface Ruolo {
  id: string;
  name: string;
  color: string | null;
  position: number;
  managed: boolean;
  everyone: boolean;
}

export interface Inventario {
  channels: Canale[];
  roles: Ruolo[];
  updatedAt: string | null;
  pronto: boolean;
}

const VUOTO: Inventario = { channels: [], roles: [], updatedAt: null, pronto: false };

/**
 * L'inventario del server, condiviso da tutti i selettori della pagina.
 *
 * La promessa si tiene in una mappa perché in una pagina di configurazione i
 * selettori sono decine: senza, ognuno farebbe la sua richiesta, e il pannello
 * chiederebbe cinquanta volte la stessa cosa all'apertura.
 */
const inCorso = new Map<string, Promise<Inventario>>();

export function useInventario(guildId: string): Inventario {
  const [dati, setDati] = useState<Inventario>(VUOTO);

  useEffect(() => {
    let attivo = true;
    let richiesta = inCorso.get(guildId);

    if (!richiesta) {
      richiesta = api
        .get<Inventario>(`/api/guilds/${guildId}/inventario`)
        .catch(() => VUOTO);
      inCorso.set(guildId, richiesta);
    }

    void richiesta.then((risultato) => {
      if (attivo) setDati(risultato);
    });

    return () => {
      attivo = false;
    };
  }, [guildId]);

  return dati;
}

/** Ricarica l'inventario alla prossima richiesta: dopo una predisposizione i canali sono nuovi. */
export function scordaInventario(guildId: string): void {
  inCorso.delete(guildId);
}

const CAMPO =
  'w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm';

const ICONE: Record<Canale['type'], string> = {
  TEXT: '#',
  ANNOUNCEMENT: '📢',
  VOICE: '🔊',
  STAGE: '🎤',
  FORUM: '💬',
  CATEGORY: '▸',
  ALTRO: '·',
};

/** Nome leggibile di un canale, con la categoria che lo contiene. */
function etichettaCanale(canale: Canale, canali: Canale[]): string {
  const categoria = canale.parentId
    ? canali.find((altro) => altro.id === canale.parentId)?.name
    : null;
  return `${ICONE[canale.type]} ${canale.name}${categoria ? `  ·  ${categoria}` : ''}`;
}

export function ChannelPicker({
  guildId,
  value,
  onChange,
  soloTestuali = true,
}: {
  guildId: string;
  value: string | null;
  onChange: (value: string | null) => void;
  soloTestuali?: boolean;
}) {
  const inventario = useInventario(guildId);

  if (!inventario.pronto) return <IdAMano value={value} onChange={onChange} cosa="canale" />;

  const scelte = inventario.channels.filter((canale) =>
    soloTestuali ? canale.type === 'TEXT' || canale.type === 'ANNOUNCEMENT' : true,
  );

  return (
    <select className={CAMPO} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— nessuno —</option>
      {/* Un ID salvato che non è più fra i canali resta selezionabile: toglierlo
          dall'elenco lo farebbe sparire in silenzio al primo salvataggio. */}
      {value && !scelte.some((canale) => canale.id === value) && (
        <option value={value}>ID {value} (canale non trovato)</option>
      )}
      {scelte.map((canale) => (
        <option key={canale.id} value={canale.id}>
          {etichettaCanale(canale, inventario.channels)}
        </option>
      ))}
    </select>
  );
}

export function RolePicker({
  guildId,
  value,
  onChange,
}: {
  guildId: string;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const inventario = useInventario(guildId);

  if (!inventario.pronto) return <IdAMano value={value} onChange={onChange} cosa="ruolo" />;

  const scelte = inventario.roles.filter((ruolo) => !ruolo.everyone);

  return (
    <select className={CAMPO} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— nessuno —</option>
      {value && !scelte.some((ruolo) => ruolo.id === value) && (
        <option value={value}>ID {value} (ruolo non trovato)</option>
      )}
      {scelte.map((ruolo) => (
        <option key={ruolo.id} value={ruolo.id}>
          @{ruolo.name}
          {ruolo.managed ? ' (di un’app)' : ''}
        </option>
      ))}
    </select>
  );
}

/**
 * Più canali o più ruoli insieme.
 *
 * A spunte e non a selezione multipla: la selezione multipla di HTML richiede
 * di tenere premuto Ctrl per aggiungere, e chi non lo sa cancella la scelta
 * precedente ogni volta che ne fa una nuova.
 */
export function MultiPicker({
  guildId,
  value,
  onChange,
  cosa,
}: {
  guildId: string;
  value: string[];
  onChange: (value: string[]) => void;
  cosa: 'canali' | 'ruoli';
}) {
  const inventario = useInventario(guildId);
  const [apri, setApri] = useState(false);

  if (!inventario.pronto) {
    return (
      <input
        type="text"
        className={CAMPO}
        value={value.join(', ')}
        placeholder={`ID dei ${cosa}, separati da virgola`}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }

  const scelte =
    cosa === 'ruoli'
      ? inventario.roles.filter((ruolo) => !ruolo.everyone).map((r) => ({ id: r.id, nome: `@${r.name}` }))
      : inventario.channels
          .filter((canale) => canale.type !== 'CATEGORY')
          .map((c) => ({ id: c.id, nome: etichettaCanale(c, inventario.channels) }));

  const scelti = scelte.filter((voce) => value.includes(voce.id));
  const orfani = value.filter((id) => !scelte.some((voce) => voce.id === id));

  return (
    <div className="max-w-md">
      <button
        type="button"
        onClick={() => setApri(!apri)}
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-left text-sm"
      >
        {value.length === 0
          ? `— nessuno —`
          : `${scelti.map((voce) => voce.nome).join(', ')}${
              orfani.length > 0 ? ` + ${orfani.length} non trovati` : ''
            }`}
        <span className="float-right text-neutral-500">{apri ? '▴' : '▾'}</span>
      </button>

      {apri && (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
          {scelte.map((voce) => (
            <label key={voce.id} className="flex items-center gap-2 py-0.5 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--color-accent)]"
                checked={value.includes(voce.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...value, voce.id]
                      : value.filter((id) => id !== voce.id),
                  )
                }
              />
              <span className="text-neutral-300">{voce.nome}</span>
            </label>
          ))}
          {orfani.length > 0 && (
            <p className="mt-2 border-t border-[var(--color-border)] pt-2 text-xs text-neutral-500">
              Non più nel server: {orfani.join(', ')}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => onChange(value.filter((id) => !orfani.includes(id)))}
              >
                togli
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Ripiego quando l'inventario non è disponibile. */
function IdAMano({
  value,
  onChange,
  cosa,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  cosa: string;
}) {
  return (
    <input
      type="text"
      className={CAMPO}
      value={value ?? ''}
      placeholder={`ID del ${cosa} (elenco non disponibile)`}
      onChange={(event) => onChange(event.target.value || null)}
    />
  );
}
