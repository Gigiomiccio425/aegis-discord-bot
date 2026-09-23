import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CornerDownLeft,
  FileText,
  Search,
  SlidersHorizontal,
  ToggleRight,
  type LucideIcon,
} from 'lucide-react';
import { describeField, describeValue, SECTION_DOCS } from '@angel/shared/docs';
import { api } from '../api.js';
import { NAVIGAZIONE } from '../navigazione.js';
import {
  cerca,
  leggi,
  preparaIndice,
  vociConfigurazione,
  vociPagine,
  type Descrittori,
  type TipoVoce,
  type VoceRicerca,
} from '../ricerca.js';
import { SEZIONE_GENERALE, type Sezione } from '../sezioni.js';

/* ═══════════════════════════════════════════════════════════════════════
   LA CASELLA DI RICERCA

   Si apre con Ctrl+K — ⌘K sul Mac — o con «/», da qualunque pagina. Cerca
   fra le pagine, le sezioni della configurazione e ogni singola
   impostazione; per le impostazioni mostra anche il valore attuale, così
   spesso la risposta è già lì senza aprire niente.

   Scegliere un'impostazione apre la configurazione su quella sezione e
   illumina il campo: è la differenza fra «trovato» e «trovato, ora cercalo
   di nuovo nella pagina».
   ═══════════════════════════════════════════════════════════════════════ */

interface RispostaConfig {
  config: Record<string, unknown>;
  modules: Sezione[];
}

const descrittori: Descrittori = {
  campo: describeField,
  sezione: (chiave) => SECTION_DOCS[chiave],
};

/**
 * L'ultima configurazione letta, per server.
 *
 * La casella si riapre spesso, e aspettare la rete a ogni apertura per
 * vedere comparire le impostazioni un attimo dopo le pagine è fastidioso: si
 * parte da quella di prima e intanto si chiede quella di adesso.
 */
const ultimaLetta = new Map<string, RispostaConfig>();

const TITOLI: Record<TipoVoce, string> = {
  pagina: 'Pagine',
  sezione: 'Sezioni della configurazione',
  impostazione: 'Impostazioni',
};

const ICONE: Record<TipoVoce, LucideIcon> = {
  pagina: FileText,
  sezione: SlidersHorizontal,
  impostazione: ToggleRight,
};

/** Le pagine con la stessa icona che hanno nella barra laterale. */
const ICONE_PAGINE = new Map<string, LucideIcon>(
  NAVIGAZIONE.flatMap((gruppo) => gruppo.voci).map((pagina) => [`pagina:${pagina.to}`, pagina.icona]),
);

/** Il valore attuale, in poche parole. */
function riassumiValore(valore: unknown): { testo: string; tono: 'acceso' | 'spento' | 'neutro' } | null {
  if (typeof valore === 'boolean') {
    return valore ? { testo: 'attivo', tono: 'acceso' } : { testo: 'spento', tono: 'spento' };
  }
  if (typeof valore === 'number') return { testo: valore.toLocaleString('it-IT'), tono: 'neutro' };
  if (typeof valore === 'string') {
    if (valore === '') return { testo: 'vuoto', tono: 'spento' };
    const testo = describeValue(valore) ?? valore;
    return { testo: testo.length > 24 ? `${testo.slice(0, 23)}…` : testo, tono: 'neutro' };
  }
  if (valore === null) return { testo: 'non impostato', tono: 'spento' };
  if (Array.isArray(valore)) {
    return valore.length === 0
      ? { testo: 'nessuno', tono: 'spento' }
      : { testo: `${valore.length} ${valore.length === 1 ? 'elemento' : 'elementi'}`, tono: 'neutro' };
  }
  return null;
}

interface Blocco {
  titolo: string;
  voci: VoceRicerca[];
}

export function Ricerca({ guildId, onChiudi }: { guildId: string; onChiudi: () => void }) {
  const navigate = useNavigate();
  const [domanda, setDomanda] = useState('');
  const [attiva, setAttiva] = useState(0);
  const [dati, setDati] = useState<RispostaConfig | null>(() => ultimaLetta.get(guildId) ?? null);
  const [senzaConfig, setSenzaConfig] = useState(false);
  const campo = useRef<HTMLInputElement>(null);
  const elenco = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let attivo = true;
    api
      .get<RispostaConfig>(`/api/guilds/${guildId}/config`)
      .then((risposta) => {
        ultimaLetta.set(guildId, risposta);
        if (attivo) setDati(risposta);
      })
      // Un ruolo che non può leggere la configurazione cerca comunque fra
      // le pagine: la casella non sparisce, dice solo cosa manca.
      .catch(() => {
        if (attivo) setSenzaConfig(true);
      });
    return () => {
      attivo = false;
    };
  }, [guildId]);

  // Mentre la casella è aperta la pagina sotto non scorre, e alla chiusura
  // il fuoco torna dov'era: chi l'ha aperta dalla tastiera ci ritrova il
  // punto in cui stava.
  useEffect(() => {
    const prima = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    campo.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      prima?.focus?.();
    };
  }, []);

  const indice = useMemo(() => {
    const voci = vociPagine();
    if (dati) {
      voci.push(...vociConfigurazione(dati.config, [SEZIONE_GENERALE, ...dati.modules], descrittori));
    }
    return preparaIndice(voci);
  }, [dati]);

  const blocchi = useMemo<Blocco[]>(() => {
    if (domanda.trim() === '') {
      // Senza niente scritto la casella fa da scorciatoia per le pagine: il
      // modo più rapido di andare altrove senza toccare il mouse.
      return NAVIGAZIONE.map((gruppo) => ({
        titolo: gruppo.titolo,
        voci: vociPagine().filter((voce) => voce.dove === gruppo.titolo),
      }));
    }

    // Raggruppati per tipo, e i gruppi nell'ordine del loro risultato
    // migliore: chi cerca un'impostazione non deve scorrere tre pagine
    // prima di trovarla, e viceversa.
    const risultati = cerca(indice, domanda);
    const perTipo = new Map<TipoVoce, { migliore: number; voci: VoceRicerca[] }>();
    for (const { voce, punteggio } of risultati) {
      const blocco = perTipo.get(voce.tipo) ?? { migliore: punteggio, voci: [] };
      blocco.voci.push(voce);
      perTipo.set(voce.tipo, blocco);
    }
    return [...perTipo.entries()]
      .sort(([, a], [, b]) => b.migliore - a.migliore)
      .map(([tipo, blocco]) => ({ titolo: TITOLI[tipo], voci: blocco.voci }));
  }, [domanda, indice]);

  const piatti = useMemo(() => blocchi.flatMap((blocco) => blocco.voci), [blocchi]);
  const soloParziali = useMemo(
    () => domanda.trim() !== '' && cerca(indice, domanda, 1)[0]?.parziale === true,
    [domanda, indice],
  );
  const attivaSicura = Math.min(attiva, Math.max(piatti.length - 1, 0));

  // La voce scelta con le frecce resta sempre visibile.
  useEffect(() => {
    const voce = piatti[attivaSicura];
    if (!voce) return;
    elenco.current
      ?.querySelector(`[data-voce="${CSS.escape(voce.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [attivaSicura, piatti]);

  const apri = (voce: VoceRicerca) => {
    onChiudi();
    navigate(`/g/${guildId}/${voce.destinazione}`);
  };

  const tasto = (evento: KeyboardEvent) => {
    if (evento.key === 'ArrowDown') {
      evento.preventDefault();
      setAttiva(piatti.length === 0 ? 0 : (attivaSicura + 1) % piatti.length);
    } else if (evento.key === 'ArrowUp') {
      evento.preventDefault();
      setAttiva(piatti.length === 0 ? 0 : (attivaSicura - 1 + piatti.length) % piatti.length);
    } else if (evento.key === 'Enter') {
      evento.preventDefault();
      const voce = piatti[attivaSicura];
      if (voce) apri(voce);
    } else if (evento.key === 'Escape') {
      evento.preventDefault();
      onChiudi();
    }
  };

  const idAttiva = piatti[attivaSicura] ? `ricerca-${piatti[attivaSicura]!.id}` : undefined;
  let posizione = -1;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[8vh] sm:px-6">
      <div aria-hidden className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onChiudi} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cerca nel pannello"
        className="relative flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl shadow-black/40"
        onKeyDown={tasto}
      >
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4">
          <Search aria-hidden size={18} className="shrink-0 text-neutral-500" />
          <input
            ref={campo}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="ricerca-risultati"
            aria-activedescendant={idAttiva}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={domanda}
            onChange={(evento) => {
              setDomanda(evento.target.value);
              setAttiva(0);
            }}
            placeholder="Cerca un'impostazione, una sezione, una pagina…"
            className="h-14 w-full bg-transparent text-base text-neutral-100 outline-none placeholder:text-neutral-500"
          />
          <kbd className="hidden shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-neutral-500 sm:inline">
            Esc
          </kbd>
        </div>

        <div
          ref={elenco}
          id="ricerca-risultati"
          role="listbox"
          aria-label="Risultati"
          className="flex-1 overflow-y-auto p-2"
        >
          {piatti.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-neutral-300">Nessun risultato per «{domanda.trim()}».</p>
              <p className="mt-1 text-xs text-neutral-500">
                Prova con una parola sola, o con quello che l'impostazione fa: «ingressi», «link»,
                «silenzia».
              </p>
            </div>
          ) : (
            <>
            {soloParziali && (
              <p className="px-3 pb-1 pt-2 text-xs text-neutral-500">
                Nessuna voce contiene tutte le parole: queste ne contengono una parte.
              </p>
            )}
            {blocchi.map((blocco) => (
              <div key={blocco.titolo} role="group" aria-label={blocco.titolo} className="mb-2 last:mb-0">
                <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
                  {blocco.titolo}
                </div>
                {blocco.voci.map((voce) => {
                  posizione += 1;
                  const questa = posizione;
                  const selezionata = questa === attivaSicura;
                  const Icona = ICONE_PAGINE.get(voce.id) ?? ICONE[voce.tipo];
                  const valore =
                    voce.percorso && dati ? riassumiValore(leggi(dati.config, voce.percorso)) : null;

                  return (
                    <div
                      key={voce.id}
                      id={`ricerca-${voce.id}`}
                      data-voce={voce.id}
                      role="option"
                      aria-selected={selezionata}
                      onMouseMove={() => {
                        if (!selezionata) setAttiva(questa);
                      }}
                      onClick={() => apri(voce)}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 ${
                        selezionata ? 'bg-[var(--color-accent)]/12' : ''
                      }`}
                    >
                      <Icona
                        aria-hidden
                        size={17}
                        strokeWidth={1.8}
                        className={`mt-0.5 shrink-0 ${
                          selezionata ? 'text-[var(--color-accent-soft)]' : 'text-neutral-500'
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span
                            className={`text-sm font-medium ${
                              selezionata ? 'text-[var(--color-accent-soft)]' : 'text-neutral-100'
                            }`}
                          >
                            {voce.titolo}
                          </span>
                          <span className="truncate text-xs text-neutral-500">{voce.dove}</span>
                        </div>
                        {voce.descrizione && (
                          <p className="mt-0.5 line-clamp-1 text-xs text-neutral-400">
                            {voce.descrizione.replace(/\*\*(.+?)\*\*/g, '$1')}
                          </p>
                        )}
                      </div>
                      {valore && (
                        <span
                          className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                            valore.tono === 'acceso'
                              ? 'bg-[var(--color-success)]/15 text-[var(--color-success-text)]'
                              : valore.tono === 'spento'
                                ? 'bg-[var(--color-surface-2)] text-neutral-500'
                                : 'bg-[var(--color-surface-2)] text-neutral-300'
                          }`}
                        >
                          {valore.testo}
                        </span>
                      )}
                      {selezionata && (
                        <CornerDownLeft
                          aria-hidden
                          size={15}
                          className="mt-1 shrink-0 text-[var(--color-accent-soft)]"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-neutral-500">
          <span>
            <kbd className="font-sans">↑</kbd> <kbd className="font-sans">↓</kbd> per scegliere
          </span>
          <span>
            <kbd className="font-sans">Invio</kbd> per aprire
          </span>
          <span>
            <kbd className="font-sans">Esc</kbd> per chiudere
          </span>
          {senzaConfig && !dati && (
            <span className="ml-auto">Il tuo ruolo non vede la configurazione: cerco solo fra le pagine.</span>
          )}
        </div>
      </div>
    </div>
  );
}
