import { useMemo, useState } from 'react';
import { Badge, Button } from './ui.js';

/* ═══════════════════════════════════════════════════════════════════════
   ELENCO DELLE PAROLE

   Cinquecento voci non stanno in un editor generico: né come schede, che
   sarebbero cinquecento riquadri, né come JSON, che è illeggibile appena
   supera lo schermo. E la cosa che si fa più spesso — aggiungere la parola
   che è appena comparsa in chat — deve costare un campo e un pulsante,
   altrimenti non la aggiunge nessuno e l'elenco invecchia.

   Da qui: ricerca, filtri, aggiunta in cima, e incolla di massa per quando le
   parole da mettere sono venti.
   ═══════════════════════════════════════════════════════════════════════ */

export interface Termine {
  term: string;
  severity: 'LIEVE' | 'MEDIA' | 'GRAVE';
  category: 'VOLGARITA' | 'INSULTO' | 'DISCRIMINAZIONE' | 'MINACCIA' | 'AUTOLESIONISMO' | 'BESTEMMIA' | 'SESSUALE';
  substring?: boolean;
}

const CATEGORIE: { valore: Termine['category']; nome: string }[] = [
  { valore: 'VOLGARITA', nome: 'Volgarità' },
  { valore: 'INSULTO', nome: 'Insulto' },
  { valore: 'DISCRIMINAZIONE', nome: 'Discriminazione' },
  { valore: 'MINACCIA', nome: 'Minaccia' },
  { valore: 'AUTOLESIONISMO', nome: 'Autolesionismo' },
  { valore: 'BESTEMMIA', nome: 'Bestemmia' },
  { valore: 'SESSUALE', nome: 'Sessuale' },
];

const GRAVITA: { valore: Termine['severity']; tono: 'neutral' | 'warning' | 'danger' }[] = [
  { valore: 'LIEVE', tono: 'neutral' },
  { valore: 'MEDIA', tono: 'warning' },
  { valore: 'GRAVE', tono: 'danger' },
];

const CAMPO =
  'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm';

/** Quante righe si disegnano al massimo: oltre, si filtra invece di scorrere. */
const MAX_RIGHE = 120;

export function WordlistEditor({
  value,
  onChange,
}: {
  value: Termine[];
  onChange: (value: Termine[]) => void;
}) {
  const [ricerca, setRicerca] = useState('');
  const [filtroCategoria, setFiltroCategoria] = useState<'' | Termine['category']>('');
  const [nuovo, setNuovo] = useState('');
  const [nuovaCategoria, setNuovaCategoria] = useState<Termine['category']>('INSULTO');
  const [nuovaGravita, setNuovaGravita] = useState<Termine['severity']>('MEDIA');
  const [incolla, setIncolla] = useState('');
  const [apriIncolla, setApriIncolla] = useState(false);
  const [avviso, setAvviso] = useState<string | null>(null);

  const filtrati = useMemo(() => {
    const query = ricerca.trim().toLowerCase();
    return value
      .map((voce, indice) => ({ voce, indice }))
      .filter(({ voce }) => !filtroCategoria || voce.category === filtroCategoria)
      .filter(({ voce }) => !query || voce.term.toLowerCase().includes(query));
  }, [value, ricerca, filtroCategoria]);

  const perCategoria = useMemo(() => {
    const conteggio = new Map<string, number>();
    for (const voce of value) conteggio.set(voce.category, (conteggio.get(voce.category) ?? 0) + 1);
    return conteggio;
  }, [value]);

  const esiste = (termine: string): boolean =>
    value.some((voce) => voce.term.toLowerCase() === termine.toLowerCase());

  const aggiungi = (): void => {
    const termine = nuovo.trim().toLowerCase();
    if (termine.length < 2) return;
    if (esiste(termine)) {
      setAvviso(`«${termine}» c'è già.`);
      return;
    }
    // In cima, non in fondo: la voce appena aggiunta si deve vedere senza
    // scorrere cinquecento righe per verificare che sia andata.
    onChange([{ term: termine, severity: nuovaGravita, category: nuovaCategoria }, ...value]);
    setNuovo('');
    setAvviso(null);
  };

  const aggiungiTutte = (): void => {
    const righe = incolla
      .split(/[\n,;]+/)
      .map((riga) => riga.trim().toLowerCase())
      .filter((riga) => riga.length >= 2);

    const nuove = righe
      .filter((riga, indice) => righe.indexOf(riga) === indice)
      .filter((riga) => !esiste(riga))
      .map((term) => ({ term, severity: nuovaGravita, category: nuovaCategoria }));

    if (nuove.length === 0) {
      setAvviso('Nessuna parola nuova: erano tutte già presenti.');
      return;
    }

    onChange([...nuove, ...value]);
    setIncolla('');
    setApriIncolla(false);
    setAvviso(
      `${nuove.length} aggiunte${righe.length - nuove.length > 0 ? `, ${righe.length - nuove.length} già presenti` : ''}.`,
    );
  };

  const modifica = (indice: number, campi: Partial<Termine>): void =>
    onChange(value.map((voce, posizione) => (posizione === indice ? { ...voce, ...campi } : voce)));

  const rimuovi = (indice: number): void =>
    onChange(value.filter((_, posizione) => posizione !== indice));

  return (
    <div className="space-y-3">
      {/* Aggiunta rapida */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={nuovo}
            placeholder="parola o frase da bloccare"
            onChange={(event) => setNuovo(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                aggiungi();
              }
            }}
            className={`${CAMPO} flex-1 min-w-48`}
          />
          <select
            value={nuovaCategoria}
            onChange={(event) => setNuovaCategoria(event.target.value as Termine['category'])}
            className={CAMPO}
          >
            {CATEGORIE.map((categoria) => (
              <option key={categoria.valore} value={categoria.valore}>
                {categoria.nome}
              </option>
            ))}
          </select>
          <select
            value={nuovaGravita}
            onChange={(event) => setNuovaGravita(event.target.value as Termine['severity'])}
            className={CAMPO}
          >
            {GRAVITA.map((gravita) => (
              <option key={gravita.valore} value={gravita.valore}>
                {gravita.valore.toLowerCase()}
              </option>
            ))}
          </select>
          <Button variant="primary" onClick={aggiungi}>
            Aggiungi
          </Button>
          <button
            type="button"
            onClick={() => setApriIncolla(!apriIncolla)}
            className="text-xs text-neutral-500 underline"
          >
            {apriIncolla ? 'chiudi' : 'incolla un elenco'}
          </button>
        </div>

        {apriIncolla && (
          <div className="mt-2">
            <textarea
              value={incolla}
              rows={5}
              placeholder={'una parola per riga, oppure separate da virgola'}
              onChange={(event) => setIncolla(event.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs"
            />
            <div className="mt-1 flex items-center gap-3">
              <Button onClick={aggiungiTutte}>Aggiungi tutte</Button>
              <span className="text-xs text-neutral-500">
                Vanno nella categoria e nella gravità scelte qui sopra. I doppioni vengono saltati.
              </span>
            </div>
          </div>
        )}

        {avviso && <p className="mt-2 text-xs text-[var(--color-accent-soft)]">{avviso}</p>}
      </div>

      {/* Ricerca e filtri */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={ricerca}
          placeholder="cerca fra le parole"
          onChange={(event) => setRicerca(event.target.value)}
          className={`${CAMPO} flex-1 min-w-40`}
        />
        <select
          value={filtroCategoria}
          onChange={(event) => setFiltroCategoria(event.target.value as '' | Termine['category'])}
          className={CAMPO}
        >
          <option value="">tutte le categorie ({value.length})</option>
          {CATEGORIE.map((categoria) => (
            <option key={categoria.valore} value={categoria.valore}>
              {categoria.nome} ({perCategoria.get(categoria.valore) ?? 0})
            </option>
          ))}
        </select>
      </div>

      {/* Righe */}
      {filtrati.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-6 text-center text-xs text-neutral-500">
          Nessuna parola con questi criteri.
        </p>
      ) : (
        <div className="divide-y divide-[var(--color-border)]/60 rounded-lg border border-[var(--color-border)]">
          {filtrati.slice(0, MAX_RIGHE).map(({ voce, indice }) => (
            <div key={`${voce.term}-${indice}`} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              <span className="flex-1 min-w-40 font-mono text-sm text-neutral-200">{voce.term}</span>

              <select
                value={voce.category}
                onChange={(event) =>
                  modifica(indice, { category: event.target.value as Termine['category'] })
                }
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-1 text-xs"
              >
                {CATEGORIE.map((categoria) => (
                  <option key={categoria.valore} value={categoria.valore}>
                    {categoria.nome}
                  </option>
                ))}
              </select>

              <select
                value={voce.severity}
                onChange={(event) =>
                  modifica(indice, { severity: event.target.value as Termine['severity'] })
                }
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-1 text-xs"
              >
                {GRAVITA.map((gravita) => (
                  <option key={gravita.valore} value={gravita.valore}>
                    {gravita.valore.toLowerCase()}
                  </option>
                ))}
              </select>

              <Badge tone={GRAVITA.find((g) => g.valore === voce.severity)?.tono ?? 'neutral'}>
                {voce.severity.toLowerCase()}
              </Badge>

              <button
                type="button"
                onClick={() => rimuovi(indice)}
                className="text-xs text-[var(--color-danger)] underline"
              >
                togli
              </button>
            </div>
          ))}
        </div>
      )}

      {filtrati.length > MAX_RIGHE && (
        <p className="text-xs text-neutral-500">
          Mostrate {MAX_RIGHE} di {filtrati.length}. Usa la ricerca per trovare quella che ti serve.
        </p>
      )}
    </div>
  );
}

/**
 * Elenco di parole semplici, una per riga.
 *
 * Usato per le eccezioni. Su una riga sola separate da virgola diventavano
 * illeggibili dopo la ventesima, ed è un elenco che si legge più spesso di
 * quanto si scriva: serve vederlo, non contarlo.
 */
export function ParoleEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}) {
  const canonico = value.join('\n');
  const [testo, setTesto] = useState(canonico);
  const [ultimo, setUltimo] = useState(canonico);

  // Come per gli altri campi: il testo grezzo resta mentre si scrive, e si
  // riallinea solo ai cambi che arrivano da fuori.
  if (canonico !== ultimo) {
    setUltimo(canonico);
    setTesto(canonico);
  }

  return (
    <div>
      <textarea
        value={testo}
        rows={Math.min(16, Math.max(4, value.length + 1))}
        placeholder={placeholder}
        onChange={(event) => {
          setTesto(event.target.value);
          const parole = event.target.value
            .split(/[\n,;]+/)
            .map((parola) => parola.trim())
            .filter(Boolean);
          setUltimo(parole.join('\n'));
          onChange(parole);
        }}
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-xs"
      />
      <p className="mt-1 text-xs text-neutral-500">{value.length} voci, una per riga.</p>
    </div>
  );
}
