import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as EventoTastiera,
  type ReactNode,
} from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  CircleDot,
  FlaskConical,
  History,
  Power,
} from 'lucide-react';
import { describeField, describeValue, SECTION_DOCS } from '@angel/shared/docs';
import { analizzaConfigurazione } from '@angel/shared/coerenza';
import { virgoletteSugliId } from '@angel/shared/json';
import { api } from '../api.js';
import { ChannelPicker, MultiPicker, RolePicker } from '../components/pickers.js';
import { ParoleEditor, WordlistEditor, type Termine } from '../components/WordlistEditor.js';
import { useGuildId } from '../App.js';
import {
  categoriaDi,
  raggruppaSezioni,
  SEZIONE_GENERALE,
  type CategoriaConSezioni,
  type Sezione,
} from '../sezioni.js';
import { gruppoGrande, gruppoPiccolo, PRINCIPALI, schedaDelCampo, schedeDi } from '../schede.js';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Gruppo,
  IntestazionePagina,
  Interruttore,
  ListInput,
  Loading,
  NumberInput,
  formatDate,
} from '../components/ui.js';

/* ═══════════════════════════════════════════════════════════════════════
   CONFIGURAZIONE

   L'editor è generico: percorre l'oggetto di configurazione e sceglie il
   controllo in base al tipo del valore. La ragione è pratica — i moduli hanno
   diverse centinaia di opzioni e continueranno a cambiare; una maschera scritta
   a mano per ciascuna sarebbe disallineata entro un mese.

   La validazione vera resta lato server, dove gli stessi schemi Zod usati dal
   bot rifiutano tutto ciò che non è coerente.
   ═══════════════════════════════════════════════════════════════════════ */

type Json = Record<string, unknown>;

/**
 * Le scelte fisse, per tutto l'editor.
 *
 * Un contesto e non una proprietà: l'editor si richiama da solo dentro gli
 * elenchi di oggetti, e passarle a mano a ogni livello era un filo in più da
 * dimenticare.
 */
const ScelteFisse = createContext<Record<string, string[]>>({});

/** `…ladder.2.action` → `…ladder.*.action`: le scelte non dipendono dalla posizione. */
function percorsoDelloSchema(percorso: string): string {
  return percorso
    .split('.')
    .map((parte) => (/^\d+$/.test(parte) ? '*' : parte))
    .join('.');
}

interface ConfigResponse {
  config: Json;
  modules: { key: string; label: string; group: string }[];
  objectArrays: string[];
  objectArrayTemplates: Record<string, unknown>;
  /** Valori ammessi dei campi a scelta fissa; negli elenchi l'indice è `*`. */
  enumChoices?: Record<string, string[]>;
  invalid: { path: string; message: string }[] | null;
}

export function Settings() {
  const guildId = useGuildId();
  const { key: passaggio } = useLocation();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [draft, setDraft] = useState<Json | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // La sezione aperta sta nell'indirizzo, non in uno stato della pagina: la
  // ricerca ci porta con un link, il tasto «indietro» torna alla sezione di
  // prima, e un link incollato in chat apre quella giusta. Senza sezione
  // nell'indirizzo si vede la panoramica.
  const selected = params.get('sezione');
  const campoCercato = params.get('campo');
  const schedaScelta = params.get('scheda');
  const seleziona = (sezione: string) => setParams({ sezione });
  const panoramica = () => setParams({});

  useEffect(() => {
    api
      .get<ConfigResponse>(`/api/guilds/${guildId}/config`)
      .then((result) => {
        setData(result);
        setDraft(structuredClone(result.config));
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [guildId]);

  const sections = useMemo<Sezione[]>(
    () => (data ? [SEZIONE_GENERALE, ...data.modules] : []),
    [data],
  );
  const categorie = useMemo(() => raggruppaSezioni(sections), [sections]);
  const pronto = draft !== null;

  /*
   * Arrivati dalla ricerca: il campo si porta al centro dello schermo, si
   * aprono i riquadri chiusi che lo contengono, e si illumina per qualche
   * secondo. Il fuoco va sul controllo, così si può cambiare subito.
   *
   * `passaggio` cambia a ogni navigazione, anche verso lo stesso indirizzo:
   * cercare due volte lo stesso campo lo illumina due volte.
   */
  useEffect(() => {
    if (!campoCercato || !pronto) return;
    const frame = requestAnimationFrame(() => {
      const riga = document.querySelector<HTMLElement>(`[data-campo="${CSS.escape(campoCercato)}"]`);
      if (!riga) return;
      for (let antenato: HTMLElement | null = riga; antenato; antenato = antenato.parentElement) {
        if (antenato instanceof HTMLDetailsElement) antenato.open = true;
      }
      const senzaMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;
      riga.scrollIntoView({ block: 'center', behavior: senzaMovimento ? 'auto' : 'smooth' });
      riga.classList.remove('evidenziato');
      void riga.offsetWidth; // riparte l'animazione anche se la classe c'era già
      riga.classList.add('evidenziato');
      riga
        .querySelector<HTMLElement>('input, select, textarea, button[role="switch"]')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [passaggio, campoCercato, selected, pronto]);

  const sporcoOra = data !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(data.config);

  // Chiudere la scheda con modifiche non salvate chiede conferma: il
  // browser mostra il suo avviso, l'unico che si può mostrare lì.
  useEffect(() => {
    if (!sporcoOra) return;
    const avvisa = (evento: BeforeUnloadEvent) => evento.preventDefault();
    window.addEventListener('beforeunload', avvisa);
    return () => window.removeEventListener('beforeunload', avvisa);
  }, [sporcoOra]);

  // Calcolati una volta per tutta la pagina: la panoramica li riassume, la
  // pagina di un modulo mostra i suoi.
  const problemi = useMemo(() => {
    if (!draft) return [];
    try {
      return analizzaConfigurazione(draft as unknown as Parameters<typeof analizzaConfigurazione>[0]);
    } catch {
      // Una bozza a metà modifica può non essere ancora valida: in quel caso
      // non si mostra niente invece di un errore che non riguarda l'utente.
      return [];
    }
  }, [draft]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api.put<{ changedPaths: string[] }>(
        `/api/guilds/${guildId}/config`,
        draft,
      );
      setSaved(`Salvato: ${result.changedPaths.length} modifiche applicate subito al bot.`);
      // La copia di riferimento si aggiorna qui: senza, l'avviso «modifiche non
      // salvate» resterebbe acceso anche dopo aver salvato.
      setData((precedente) =>
        precedente ? { ...precedente, config: structuredClone(draft) } : precedente,
      );
      setError(null);
      setTimeout(() => setSaved(null), 5000);
    } catch (err) {
      setError(spiegaErrore(err));
    } finally {
      setSaving(false);
    }
  };

  if (error && !data) return <ErrorBox message={error} />;
  if (!data || !draft) return <Loading />;

  const sezione = selected ? sections.find((candidata) => candidata.key === selected) : undefined;
  const current = sezione ? getPath(draft, sezione.key) : undefined;

  /*
   * Questa pagina non salva da sola, e non deve: fra le sue opzioni ce ne sono
   * che spengono difese, e salvare a ogni spunta significherebbe applicarle nel
   * mezzo di una modifica pensata a metà. Le altre pagine — annunci, azioni —
   * salvano subito perché lì ogni gesto è già una decisione compiuta.
   *
   * Quello che mancava era dirlo. Chi cambiava una soglia e passava a un'altra
   * sezione non aveva modo di sapere di non aver salvato: ora la barra in
   * basso resta lì, su ogni sezione, finché le modifiche non sono salvate o
   * scartate.
   */
  const sporco = sporcoOra;

  const cambia = (path: string, value: unknown) => {
    const next = structuredClone(draft);
    setPath(next, path, value);
    setDraft(next);
  };

  const annulla = () => {
    if (!confirm('Scartare le modifiche non salvate? Si torna alla configurazione salvata.')) return;
    setDraft(structuredClone(data.config));
  };

  const nomeDi = (chiave: string) => sections.find((voce) => voce.key === chiave)?.label ?? chiave;

  // La sezione di un campo: la più lunga fra quelle che lo contengono. Un
  // problema del modulo può indicare un campo delle impostazioni generali.
  const sezioneDelCampo = (campo: string): string | undefined =>
    sections
      .map((voce) => voce.key)
      .filter((chiave) => campo === chiave || campo.startsWith(`${chiave}.`))
      .sort((a, b) => b.length - a.length)[0];

  const avvisi =
    error || saved || data.invalid ? (
      <>
        {error && <ErrorBox message={error} />}
        {saved && (
          <div
            role="status"
            className="rounded-lg border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-sm text-[var(--color-success-text)]"
          >
            {saved}
          </div>
        )}
        {data.invalid && (
          <ErrorBox
            message={`La configurazione salvata non è valida: il bot sta usando i valori predefiniti. Campi: ${data.invalid
              .map((issue) => issue.path)
              .join(', ')}`}
          />
        )}
      </>
    ) : null;

  return (
    <div>
      {sezione && current && typeof current === 'object' ? (
        <ScelteFisse.Provider value={data.enumChoices ?? {}}>
          <SchedaModulo
            key={sezione.key}
            sezione={sezione}
            categoria={categoriaDi(sezione.key, categorie)}
            valore={current as Json}
            draft={draft}
            problemi={problemi.filter((problema) => problema.modulo === sezione.key)}
            schedaScelta={schedaScelta}
            campoCercato={campoCercato}
            avvisi={avvisi}
            onScheda={(scheda) => setParams({ sezione: sezione.key, scheda })}
            onApri={seleziona}
            onPanoramica={panoramica}
            onVaiCampo={(campo) => setParams({ sezione: sezioneDelCampo(campo) ?? sezione.key, campo })}
            objectArrays={data.objectArrays ?? []}
            objectTemplates={data.objectArrayTemplates ?? {}}
            onChange={cambia}
          />
        </ScelteFisse.Provider>
      ) : (
        <Panoramica
          categorie={categorie}
          draft={draft}
          problemi={problemi}
          sporco={sporco}
          avvisi={avvisi}
          guildId={guildId}
          nomeDi={nomeDi}
          onApri={seleziona}
          onChange={cambia}
        />
      )}

      {sporco && (
        <BarraSalvataggio saving={saving} onSalva={() => void save()} onAnnulla={annulla} />
      )}
    </div>
  );
}

type Problemi = ReturnType<typeof analizzaConfigurazione>;

/** Acceso, spento, o `null` per le sezioni senza interruttore. */
function statoModulo(draft: Json, chiave: string): boolean | null {
  const valore = getPath(draft, chiave);
  return valore && typeof valore === 'object' && typeof (valore as Json).enabled === 'boolean'
    ? Boolean((valore as Json).enabled)
    : null;
}

/* ═══════════════════════════════════════════════════════════════════════
   LA PANORAMICA

   La configurazione si apre qui, non su una sezione: prima di cambiare
   qualcosa si vuole sapere com'è messo il server. In alto i due
   interruttori che valgono per tutto, poi i problemi, poi le categorie con
   i loro moduli — ognuno si accende e si spegne dalla sua riga, e si apre
   solo per cambiarne le soglie.
   ═══════════════════════════════════════════════════════════════════════ */

function Panoramica({
  categorie,
  draft,
  problemi,
  sporco,
  avvisi,
  guildId,
  nomeDi,
  onApri,
  onChange,
}: {
  categorie: CategoriaConSezioni[];
  draft: Json;
  problemi: Problemi;
  sporco: boolean;
  avvisi: ReactNode;
  guildId: string;
  nomeDi: (modulo: string) => string;
  onApri: (sezione: string) => void;
  onChange: (path: string, value: unknown) => void;
}) {
  return (
    <div>
      <IntestazionePagina
        descrizione="I moduli divisi per quello che fanno. Si accendono e si spengono da qui; si apre un modulo per cambiarne le impostazioni. Le modifiche valgono quando premi «Salva»."
        azioni={
          sporco ? (
            <Badge tone="warning">modifiche non salvate</Badge>
          ) : (
            <Badge tone="success">tutto salvato</Badge>
          )
        }
      >
        {avvisi}
      </IntestazionePagina>

      <div className="space-y-8">
        <StatoProtezione draft={draft} onChange={onChange} onApriGenerale={() => onApri(SEZIONE_GENERALE.key)} />
        <Coerenza problemi={problemi} onApri={onApri} nomeDi={nomeDi} />

        {/* A colonne e non a griglia: le categorie hanno da uno a sei moduli, e
            in una griglia la più corta resterebbe alta quanto la vicina. Le
            impostazioni generali stanno già nel riquadro qui sopra. */}
        <div className="gap-5 lg:columns-2">
          {categorie
            .filter((categoria) => categoria.id !== 'base')
            .map((categoria) => (
              <CartaCategoria
                key={categoria.id}
                categoria={categoria}
                draft={draft}
                problemi={problemi}
                onApri={onApri}
                onChange={onChange}
              />
            ))}
        </div>

        <Gruppo titolo="Storico e sessioni">
          <ConfigHistory guildId={guildId} onRestored={() => location.reload()} />
          <PanelSessions />
        </Gruppo>
      </div>
    </div>
  );
}

/**
 * I due interruttori che valgono per tutti i moduli, con una frase che dice
 * cosa succede adesso. «Modalità prova» accesa e dimenticata è il motivo più
 * comune per cui «il bot non fa niente»: qui si vede prima di ogni altra cosa.
 */
function StatoProtezione({
  draft,
  onChange,
  onApriGenerale,
}: {
  draft: Json;
  onChange: (path: string, value: unknown) => void;
  onApriGenerale: () => void;
}) {
  const generale = (draft.general ?? {}) as Json;
  const attiva = generale.masterEnabled;
  const prova = generale.dryRun;
  if (typeof attiva !== 'boolean') return null;

  const stato = !attiva
    ? {
        classi: 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-danger-text)]',
        testo: 'Protezione spenta: nessun modulo valuta niente e nessuna sanzione parte.',
      }
    : prova === true
      ? {
          classi: 'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 text-[var(--color-warning-text)]',
          testo: 'Modalità prova: i moduli registrano tutto ma non sanzionano nessuno.',
        }
      : {
          classi: 'border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-success-text)]',
          testo: 'Protezione attiva: i moduli accesi intervengono davvero.',
        };

  const voci: { percorso: string; valore: boolean; icona: typeof Power }[] = [
    { percorso: 'general.masterEnabled', valore: attiva, icona: Power },
  ];
  if (typeof prova === 'boolean') voci.push({ percorso: 'general.dryRun', valore: prova, icona: FlaskConical });

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <p role="status" className={`border-b px-5 py-3 text-sm font-medium ${stato.classi}`}>
        {stato.testo}
      </p>
      <div className="grid divide-y divide-[var(--color-border)] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        {voci.map(({ percorso, valore, icona: Icona }) => {
          const doc = describeField(percorso);
          const id = `campo-${percorso}`;
          return (
            <div key={percorso} className="flex items-start gap-3 px-5 py-4">
              <Icona aria-hidden size={18} className="mt-0.5 shrink-0 text-[var(--color-accent-soft)]" />
              <div className="min-w-0 flex-1">
                <label htmlFor={id} className="cursor-pointer text-sm font-medium text-neutral-100">
                  {doc?.label ?? percorso}
                </label>
                {doc && <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">{stripMarkdown(doc.help)}</p>}
              </div>
              <Interruttore id={id} acceso={valore} onChange={(acceso) => onChange(percorso, acceso)} />
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onApriGenerale}
        className="flex w-full items-center gap-2 border-t border-[var(--color-border)] px-5 py-3 text-left text-sm text-neutral-300 transition-colors hover:bg-[var(--color-surface-2)]/60 hover:text-neutral-100"
      >
        <span className="min-w-0 flex-1">
          <span className="font-medium">Impostazioni generali</span>
          <span className="text-neutral-500"> — staff, lingua, avvisi in chat, identità del bot, copia leggera</span>
        </span>
        <ChevronRight aria-hidden size={16} className="shrink-0 text-neutral-500" />
      </button>
    </section>
  );
}

/** Una categoria: i suoi moduli, uno per riga, con l'interruttore a portata di mano. */
function CartaCategoria({
  categoria,
  draft,
  problemi,
  onApri,
  onChange,
}: {
  categoria: CategoriaConSezioni;
  draft: Json;
  problemi: Problemi;
  onApri: (sezione: string) => void;
  onChange: (path: string, value: unknown) => void;
}) {
  const Icona = categoria.icona;
  const stati = categoria.sezioni.map((sezione) => statoModulo(draft, sezione.key));
  const conInterruttore = stati.filter((stato) => stato !== null).length;
  const accesi = stati.filter((stato) => stato === true).length;

  return (
    <section className="mb-5 flex break-inside-avoid flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <header className="flex items-start gap-3 border-b border-[var(--color-border)] px-5 py-4">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)]/12 text-[var(--color-accent-soft)]"
        >
          <Icona size={18} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-neutral-100">{categoria.titolo}</h2>
          <p className="mt-0.5 text-[13px] leading-snug text-neutral-400">{categoria.descrizione}</p>
        </div>
        {conInterruttore > 0 && (
          <span className="shrink-0 pt-0.5 text-xs text-neutral-500">
            {accesi} di {conInterruttore} attivi
          </span>
        )}
      </header>

      <ul className="divide-y divide-[var(--color-border)]/60">
        {categoria.sezioni.map((sezione, indice) => {
          const acceso = stati[indice] ?? null;
          const errori = problemi.filter(
            (problema) => problema.modulo === sezione.key && problema.livello === 'errore',
          ).length;
          return (
            <li key={sezione.key} className="flex items-center gap-3 pr-5 transition-colors hover:bg-[var(--color-surface-2)]/60">
              <button
                type="button"
                onClick={() => onApri(sezione.key)}
                className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-5 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm font-medium ${acceso === false ? 'text-neutral-400' : 'text-neutral-100'}`}>
                      {sezione.label}
                    </span>
                    {errori > 0 && <Badge tone="danger">da sistemare</Badge>}
                  </span>
                  {SECTION_DOCS[sezione.key] && (
                    <span className="mt-0.5 block truncate text-xs text-neutral-500">
                      {SECTION_DOCS[sezione.key]!.summary}
                    </span>
                  )}
                </span>
                <ChevronRight aria-hidden size={16} className="shrink-0 text-neutral-500" />
              </button>
              {acceso !== null && (
                <Interruttore
                  acceso={acceso}
                  etichetta={`${sezione.label}: ${acceso ? 'attivo' : 'spento'}`}
                  onChange={(nuovo) => onChange(`${sezione.key}.enabled`, nuovo)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   LA PAGINA DI UN MODULO

   Un modulo alla volta, diviso in schede. Sopra, la strada per tornare alla
   panoramica e gli altri moduli della stessa categoria — si passa
   dall'anti-raid all'anti-nuke con un clic, senza un menù di ventisette
   voci da scorrere. Poi cosa fa il modulo, se è acceso, e cosa non va.
   ═══════════════════════════════════════════════════════════════════════ */

function SchedaModulo({
  sezione,
  categoria,
  valore,
  draft,
  problemi,
  schedaScelta,
  campoCercato,
  avvisi,
  onScheda,
  onApri,
  onPanoramica,
  onVaiCampo,
  objectArrays,
  objectTemplates,
  onChange,
}: {
  sezione: Sezione;
  categoria: CategoriaConSezioni | null;
  valore: Json;
  draft: Json;
  problemi: Problemi;
  schedaScelta: string | null;
  campoCercato: string | null;
  avvisi: ReactNode;
  onScheda: (scheda: string) => void;
  onApri: (sezione: string) => void;
  onPanoramica: () => void;
  onVaiCampo: (campo: string) => void;
  objectArrays: string[];
  objectTemplates: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
}) {
  const doc = SECTION_DOCS[sezione.key];
  const interruttore = typeof valore.enabled === 'boolean' ? valore.enabled : null;
  const schede = schedeDi(valore, sezione.key, labelFor);

  // La scheda scelta a mano vince; se si arriva da un campo, quella che lo
  // contiene; altrimenti la prima.
  const attiva =
    schede.find((scheda) => scheda.id === schedaScelta)?.id ??
    (campoCercato ? schedaDelCampo(campoCercato, sezione.key, schede) : null) ??
    schede[0]?.id ??
    null;
  const scheda = schede.find((candidata) => candidata.id === attiva) ?? null;

  const comuni = { objectArrays, objectTemplates, onChange };
  const sciolte = Object.entries(valore).filter(
    ([chiave, voce]) =>
      !(interruttore !== null && chiave === 'enabled') && (schede.length === 0 || !gruppoGrande(voce)),
  );

  let contenuto: ReactNode;
  if (!scheda || scheda.id === PRINCIPALI) {
    contenuto = (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-2">
        <Righe voci={sciolte} path={sezione.key} depth={0} {...comuni} />
      </section>
    );
  } else {
    const gruppo = (valore[scheda.id] ?? {}) as Json;
    const aiuto = scheda.percorso ? describeField(scheda.percorso) : null;
    contenuto = (
      <section
        data-campo={scheda.percorso ?? undefined}
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
      >
        {aiuto && (
          <p className="border-b border-[var(--color-border)] px-5 py-3 text-sm leading-relaxed text-neutral-400">
            {stripMarkdown(aiuto.help)}
          </p>
        )}
        <div className="px-5 py-2">
          <Righe voci={Object.entries(gruppo)} path={scheda.percorso ?? sezione.key} depth={1} {...comuni} />
        </div>
      </section>
    );
  }

  // Le frecce spostano fra le schede, come in ogni elenco di schede.
  const frecce = (evento: EventoTastiera) => {
    if (evento.key !== 'ArrowRight' && evento.key !== 'ArrowLeft') return;
    const posizione = schede.findIndex((candidata) => candidata.id === attiva);
    const passo = evento.key === 'ArrowRight' ? 1 : -1;
    const prossima = schede[(posizione + passo + schede.length) % schede.length];
    if (!prossima) return;
    evento.preventDefault();
    onScheda(prossima.id);
    requestAnimationFrame(() => document.getElementById(`scheda-${prossima.id}`)?.focus());
  };

  return (
    <div>
      <nav aria-label="Dove sei" className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <button
          type="button"
          onClick={onPanoramica}
          className="-ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-neutral-400 transition-colors hover:bg-[var(--color-surface-2)] hover:text-neutral-100"
        >
          <ArrowLeft aria-hidden size={16} />
          Tutte le impostazioni
        </button>
        {categoria && (
          <>
            <span aria-hidden className="text-neutral-600">/</span>
            <span className="text-neutral-400">{categoria.titolo}</span>
          </>
        )}
      </nav>

      {categoria && categoria.sezioni.length > 1 && (
        <nav aria-label={`Moduli di ${categoria.titolo}`} className="mb-5 flex flex-wrap gap-1.5">
          {categoria.sezioni.map((vicina) => {
            const stato = statoModulo(draft, vicina.key);
            const qui = vicina.key === sezione.key;
            return (
              <button
                key={vicina.key}
                type="button"
                aria-current={qui ? 'page' : undefined}
                onClick={() => onApri(vicina.key)}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors ${
                  qui
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/12 font-medium text-[var(--color-accent-soft)]'
                    : 'border-[var(--color-border)] text-neutral-300 hover:border-neutral-500 hover:text-neutral-100'
                }`}
              >
                {stato !== null && (
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      stato ? 'bg-[var(--color-success)]' : 'ring-1 ring-inset ring-neutral-500'
                    }`}
                  />
                )}
                {vicina.label}
                {stato !== null && <span className="sr-only">{stato ? '(attivo)' : '(spento)'}</span>}
              </button>
            );
          })}
        </nav>
      )}

      {avvisi && <div className="mb-4 space-y-3">{avvisi}</div>}

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">{sezione.label}</h1>
            {doc && <p className="mt-1 text-sm leading-relaxed text-neutral-300">{doc.summary}</p>}
          </div>
          {interruttore !== null && (
            <div
              data-campo={`${sezione.key}.enabled`}
              className={`flex items-center gap-3 rounded-xl border px-3.5 py-2.5 ${
                interruttore
                  ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
              }`}
            >
              <label
                htmlFor={`campo-${sezione.key}.enabled`}
                className={`text-sm font-medium ${
                  interruttore ? 'text-[var(--color-success-text)]' : 'text-neutral-400'
                }`}
              >
                {interruttore ? 'Modulo attivo' : 'Modulo spento'}
              </label>
              <Interruttore
                id={`campo-${sezione.key}.enabled`}
                acceso={interruttore}
                onChange={(acceso) => onChange(`${sezione.key}.enabled`, acceso)}
              />
            </div>
          )}
        </div>

        {doc && (
          <details className="group mt-3">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-[var(--color-accent-soft)]">
              <ChevronRight aria-hidden size={14} className="transition-transform group-open:rotate-90" />
              Come funziona
            </summary>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-neutral-400">{stripMarkdown(doc.detail)}</p>
          </details>
        )}

        {problemi.length > 0 && (
          <ul className="mt-4 space-y-2 border-t border-[var(--color-border)] pt-4">
            {problemi.map((problema, indice) => {
              const tono =
                problema.livello === 'errore'
                  ? 'text-[var(--color-danger)]'
                  : problema.livello === 'avviso'
                    ? 'text-[var(--color-warning)]'
                    : 'text-neutral-500';
              return (
                <li
                  key={indice}
                  className="flex flex-wrap items-start gap-3 rounded-lg bg-[var(--color-surface-2)]/70 px-3 py-2.5 sm:flex-nowrap"
                >
                  <AlertTriangle aria-hidden size={16} className={`mt-0.5 shrink-0 ${tono}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-neutral-100">{problema.titolo}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-neutral-400">
                      {stripMarkdown(problema.dettaglio)}
                    </p>
                  </div>
                  {problema.campo && (
                    <Button variant="ghost" onClick={() => onVaiCampo(problema.campo!)}>
                      Sistema
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {interruttore === false && (
        <p className="mt-4 rounded-lg border border-dashed border-[var(--color-border)] px-4 py-3 text-sm text-neutral-400">
          Il modulo è spento: le impostazioni qui sotto restano salvate ma non hanno effetto finché non
          lo accendi.
        </p>
      )}

      <div className="mt-6">
        {schede.length > 0 && (
          <div
            role="tablist"
            aria-label={`Impostazioni di ${sezione.label}`}
            onKeyDown={frecce}
            // La linea di fondo è un'ombra interna e non un bordo: con un bordo
            // la sottolineatura della scheda doveva sporgere di un pixel, e lo
            // scorrimento orizzontale mostrava una barra verticale per quel pixel.
            className="mb-4 flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-border)]"
          >
            {schede.map((voce) => {
              const selezionata = voce.id === attiva;
              return (
                <button
                  key={voce.id}
                  id={`scheda-${voce.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selezionata}
                  aria-controls="pannello-scheda"
                  tabIndex={selezionata ? 0 : -1}
                  onClick={() => onScheda(voce.id)}
                  className={`shrink-0 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors ${
                    selezionata
                      ? 'border-[var(--color-accent)] text-[var(--color-accent-soft)]'
                      : 'border-transparent text-neutral-400 hover:text-neutral-100'
                  }`}
                >
                  {voce.titolo}
                </button>
              );
            })}
          </div>
        )}
        <div
          id="pannello-scheda"
          role={schede.length > 0 ? 'tabpanel' : undefined}
          aria-labelledby={attiva ? `scheda-${attiva}` : undefined}
        >
          {contenuto}
        </div>
      </div>
    </div>
  );
}

/** Salva o scarta: sempre in vista finché c'è qualcosa da salvare. */
function BarraSalvataggio({
  saving,
  onSalva,
  onAnnulla,
}: {
  saving: boolean;
  onSalva: () => void;
  onAnnulla: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-20 mt-8">
      <div
        role="status"
        className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-warning)]/50 bg-[var(--color-surface)] px-4 py-3 shadow-xl shadow-black/30"
      >
        <p className="flex items-center gap-2 text-sm text-neutral-200">
          <CircleDot aria-hidden size={16} className="shrink-0 text-[var(--color-warning)]" />
          Modifiche non salvate: il bot le usa solo dopo «Salva».
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={saving} onClick={onAnnulla}>
            Annulla modifiche
          </Button>
          <Button variant="primary" disabled={saving} onClick={onSalva}>
            {saving ? 'Salvataggio…' : 'Salva modifiche'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Cosa non torna nella configurazione, mentre la si modifica.
 *
 * Guarda la bozza e non ciò che è salvato: un problema che compare nel momento
 * in cui lo si crea è un problema che si corregge subito, mentre lo stesso
 * avviso letto tre giorni dopo è una caccia a cosa si era cambiato.
 *
 * I moduli spenti non producono nulla: dire a chi non usa i ticket che manca
 * la categoria dei ticket è il modo più rapido per far ignorare l'intero
 * riquadro.
 */
function Coerenza({
  problemi,
  onApri,
  nomeDi,
}: {
  problemi: Problemi;
  onApri: (modulo: string) => void;
  nomeDi: (modulo: string) => string;
}) {
  const [aperto, setAperto] = useState(false);

  if (problemi.length === 0) return null;

  const errori = problemi.filter((problema) => problema.livello === 'errore');
  const avvisi = problemi.filter((problema) => problema.livello === 'avviso');
  const note = problemi.filter((problema) => problema.livello === 'nota');
  const mostrati = aperto ? problemi : [];

  /*
   * Chiuso, il riquadro dice solo dove andare: i moduli da sistemare, uno
   * per etichetta. Il dettaglio di ogni problema si apre a richiesta — aperto
   * sempre, spingeva la sezione scelta mezza schermata più in basso, su ogni
   * sezione, anche per chi quei problemi li conosceva già.
   */
  const moduliDi = (elenco: typeof problemi) => [...new Set(elenco.map((problema) => problema.modulo))];
  const moduliErrore = moduliDi(errori);
  const moduliAvviso = moduliDi(avvisi).filter((modulo) => !moduliErrore.includes(modulo));

  const colore = (livello: string): string =>
    livello === 'errore'
      ? 'text-[var(--color-danger)]'
      : livello === 'avviso'
        ? 'text-[var(--color-warning)]'
        : 'text-neutral-500';

  return (
    <Card
      title="Controlli di coerenza"
      subtitle={
        errori.length > 0
          ? `${errori.length} ${errori.length === 1 ? 'modulo acceso non può funzionare' : 'moduli accesi non possono funzionare'}`
          : 'Nessun blocco: solo cose che vale la pena sapere.'
      }
      action={
        <div className="flex items-center gap-2 text-xs">
          {errori.length > 0 && <Badge tone="danger">{errori.length} da sistemare</Badge>}
          {avvisi.length > 0 && <Badge tone="warning">{avvisi.length} da guardare</Badge>}
          {note.length > 0 && <Badge tone="neutral">{note.length} note</Badge>}
        </div>
      }
    >
      {!aperto && (
        <div className="space-y-2 text-sm">
          {[
            { titolo: 'Da sistemare in', moduli: moduliErrore, tono: 'danger' as const },
            { titolo: 'Da guardare in', moduli: moduliAvviso, tono: 'warning' as const },
          ]
            .filter((riga) => riga.moduli.length > 0)
            .map((riga) => (
              <div key={riga.titolo} className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-neutral-500">{riga.titolo}:</span>
                {riga.moduli.map((modulo) => (
                  <button
                    key={modulo}
                    type="button"
                    onClick={() => onApri(modulo)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                      riga.tono === 'danger'
                        ? 'border-[var(--color-danger)]/40 text-[var(--color-danger-text)] hover:bg-[var(--color-danger)]/10'
                        : 'border-[var(--color-warning)]/40 text-[var(--color-warning-text)] hover:bg-[var(--color-warning)]/10'
                    }`}
                  >
                    {nomeDi(modulo)}
                  </button>
                ))}
              </div>
            ))}
        </div>
      )}

      <ul className="space-y-2 text-sm">
        {mostrati.map((problema, indice) => (
          <li key={indice} className="flex items-start gap-2">
            <span className={`mt-0.5 ${colore(problema.livello)}`}>●</span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-neutral-200">{problema.titolo}</span>
                <button
                  type="button"
                  onClick={() => onApri(problema.modulo)}
                  className="text-xs text-[var(--color-accent-soft)] underline"
                >
                  apri «{nomeDi(problema.modulo)}»
                </button>
              </div>
              <p className="text-xs leading-relaxed text-neutral-400">
                {stripMarkdown(problema.dettaglio)}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {!aperto && (
        <button
          type="button"
          onClick={() => setAperto(true)}
          className="mt-3 text-xs text-neutral-500 underline"
        >
          mostra i dettagli ({problemi.length})
        </button>
      )}
      {aperto && (
        <button
          type="button"
          onClick={() => setAperto(false)}
          className="mt-3 text-xs text-neutral-500 underline"
        >
          mostra meno
        </button>
      )}
    </Card>
  );
}

/**
 * Il motivo del rifiuto, campo per campo.
 *
 * «Configurazione non valida» da solo lascia a cercare quale delle poche
 * centinaia di opzioni sia quella sbagliata. Il server manda già il percorso e
 * il motivo di ogni problema: non mostrarli era buttare via l'unica
 * informazione utile del messaggio.
 */
function spiegaErrore(err: unknown): string {
  const errore = err as { message?: string; details?: unknown };
  const dettagli = errore.details;

  if (Array.isArray(dettagli) && dettagli.length > 0) {
    const righe = (dettagli as { path?: string; message?: string }[])
      .slice(0, 8)
      .map((problema) => `${problema.path ?? '?'} — ${problema.message ?? 'valore rifiutato'}`);
    const resto = dettagli.length > righe.length ? `\n…e altri ${dettagli.length - righe.length}` : '';
    return `${errore.message ?? 'Salvataggio rifiutato'}:\n${righe.join('\n')}${resto}`;
  }

  return errore.message ?? 'Salvataggio rifiutato';
}

interface HistoryEntry {
  id: string;
  actorId: string;
  source: string;
  paths: string[];
  createdAt: string;
}

/**
 * Storico delle modifiche alla configurazione.
 *
 * Risponde alla domanda che si pone dopo ogni incidente — «chi ha disattivato
 * l'anti-nuke ieri sera» — e permette di tornare indietro senza ricostruire a
 * memoria com'era prima.
 */
function ConfigHistory({ guildId, onRestored }: { guildId: string; onRestored: () => void }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<HistoryEntry[]>(`/api/guilds/${guildId}/config/history`)
      .then(setEntries)
      .catch((err: Error) => setError(err.message));
  }, [guildId]);

  if (error) return null;
  if (!entries) return null;

  return (
    <Card
      icona={History}
      title="Storico delle modifiche"
      subtitle="Ripristinare riporta la configurazione com'era prima di quella modifica."
    >
      {entries.length === 0 ? (
        <p className="text-sm text-neutral-500">Nessuna modifica registrata.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {entries.slice(0, 15).map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)]/50 pb-2 last:border-0"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge tone={entry.source === 'panel' ? 'accent' : 'neutral'}>
                    {entry.source}
                  </Badge>
                  <span className="text-neutral-300">{formatDate(entry.createdAt)}</span>
                  <code className="text-xs text-neutral-600">{entry.actorId}</code>
                </div>
                <div className="mt-1 text-xs text-neutral-500">
                  {entry.paths.length === 0
                    ? 'nessun percorso registrato'
                    : `${entry.paths.length} modifiche: ${entry.paths.slice(0, 4).join(', ')}${entry.paths.length > 4 ? '…' : ''}`}
                </div>
              </div>
              <Button
                onClick={() =>
                  void api
                    .post(`/api/guilds/${guildId}/config/history/${entry.id}/restore`)
                    .then(onRestored)
                    .catch((err: Error) => setError(err.message))
                }
              >
                Ripristina
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

interface SessionEntry {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/**
 * Sessioni attive del pannello.
 *
 * Le sessioni vivono in tabella proprio per questo: un cookie firmato non si
 * può revocare, e se l'account di un moderatore viene compromesso serve poterlo
 * disconnettere subito senza cambiare il segreto e buttare fuori tutti.
 */
function PanelSessions() {
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null);

  const load = () => {
    api
      .get<SessionEntry[]>('/api/auth/sessions')
      .then(setSessions)
      .catch(() => setSessions([]));
  };

  useEffect(load, []);

  if (!sessions || sessions.length === 0) return null;

  return (
    <Card
      title="Le tue sessioni"
      subtitle="Revocare una sessione la disconnette all'istante, senza toccare le altre."
    >
      <ul className="space-y-2 text-sm">
        {sessions.map((session) => (
          <li
            key={session.id}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)]/50 pb-2 last:border-0"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {session.current && <Badge tone="success">questa</Badge>}
                <span className="text-neutral-300">{session.ip ?? 'IP sconosciuto'}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-neutral-500">
                {session.userAgent ?? 'client sconosciuto'}
              </div>
              <div className="text-xs text-neutral-600">
                Aperta il {formatDate(session.createdAt)} · vista {formatDate(session.lastSeenAt)}
              </div>
            </div>
            {!session.current && (
              <Button
                onClick={() => void api.delete(`/api/auth/sessions/${session.id}`).then(load)}
              >
                Revoca
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Il grassetto `**così**` non ha senso in HTML: si toglie e basta. */
function stripMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
}

/**
 * Riga di spiegazione sotto un controllo.
 *
 * Nessun fallback generico: se manca la descrizione non compare nulla. Un
 * aiuto che non aiuta occupa spazio e insegna a ignorare tutti gli altri.
 */
function Help({ path }: { path: string }) {
  const doc = describeField(path);
  if (!doc) return null;
  return <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-neutral-400">{doc.help}</p>;
}

/** Etichetta in italiano se esiste, altrimenti il nome tecnico ripulito. */
function labelFor(path: string, key: string): string {
  return describeField(path)?.label ?? humanize(key);
}

/**
 * Cosa contiene un campo, letto dal suo nome.
 *
 * Tutto lo schema segue la stessa convenzione — `…ChannelId`, `…RoleIds` — e
 * appoggiarsi a quella evita di mantenere un elenco a parte di quali campi
 * sono canali: un elenco che al primo modulo nuovo resta indietro, e il campo
 * torna silenziosamente a farsi incollare un ID a mano.
 */
function tipoDiRiferimento(key: string): 'canale' | 'ruolo' | 'utente' | null {
  const minuscolo = key.toLowerCase();
  if (minuscolo.endsWith('channelid') || minuscolo.endsWith('channelids')) return 'canale';
  // L'unica eccezione alla convenzione: i canali che il lockdown lascia
  // aperti. `…Channels` da solo non basta — `youtube.channels` è un elenco di
  // canali YouTube, non di Discord.
  if (minuscolo.endsWith('exemptchannels')) return 'canale';
  if (minuscolo.endsWith('roleid') || minuscolo.endsWith('roleids')) return 'ruolo';
  if (minuscolo.endsWith('userid') || minuscolo.endsWith('userids')) return 'utente';
  return null;
}

/**
 * Elenco di oggetti: una scheda per elemento.
 *
 * Prima era un blocco di JSON. Funzionava per chi sa cos'è il JSON e per
 * nessun altro: una virgola di troppo rendeva invalido tutto il blocco, e gli
 * ID Discord vanno fra virgolette per una ragione che non c'entra nulla con
 * Discord. Ogni elemento è un oggetto come tutti gli altri della
 * configurazione, quindi si modifica con gli stessi controlli — comprese le
 * tendine dei canali e dei ruoli.
 *
 * Il JSON resta, richiuso: serve per copiare una configurazione da un server
 * all'altro, che a mano sarebbe un lavoro da mezz'ora.
 */
function ObjectListEditor({
  label,
  path,
  items,
  template,
  objectArrays,
  objectTemplates,
  onChange,
}: {
  label: string;
  path: string;
  items: unknown[];
  template: unknown;
  objectArrays: string[];
  objectTemplates: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
}) {
  const [json, setJson] = useState(false);

  const rimuovi = (indice: number) =>
    onChange(
      path,
      items.filter((_, posizione) => posizione !== indice),
    );

  return (
    <div data-campo={path} className="-mx-2 rounded-lg px-2 py-3 text-sm">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="font-medium text-neutral-200">
          {label}
          {items.length > 0 && <span className="ml-2 text-xs font-normal text-neutral-500">{items.length}</span>}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setJson(!json)}
            className="text-xs text-neutral-500 underline"
          >
            {json ? 'a schede' : 'come JSON'}
          </button>
          {template !== undefined && (
            <Button onClick={() => onChange(path, [...items, structuredClone(template)])}>
              Aggiungi
            </Button>
          )}
        </div>
      </div>
      <Help path={path} />

      {json ? (
        <div className="mt-1">
          <JsonEditor value={items} onChange={(next) => onChange(path, next)} />
        </div>
      ) : items.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-xs text-neutral-500">
          Nessun elemento. {template !== undefined && 'Usa «Aggiungi» per crearne uno.'}
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {items.map((item, indice) => (
            <div
              key={indice}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 p-3"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-500">
                  {titoloElemento(item, indice)}
                </span>
                <button
                  type="button"
                  onClick={() => rimuovi(indice)}
                  className="text-xs text-[var(--color-danger)] underline"
                >
                  Rimuovi
                </button>
              </div>
              {item && typeof item === 'object' ? (
                <ObjectEditor
                  value={item as Json}
                  path={`${path}.${indice}`}
                  objectArrays={objectArrays}
                  objectTemplates={objectTemplates}
                  onChange={onChange}
                  depth={1}
                />
              ) : (
                <p className="text-xs text-neutral-500">Elemento non modificabile a schede.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Come si chiama un elemento nell'elenco.
 *
 * «Elemento 3» non aiuta a trovare lo streamer da correggere. I campi cercati
 * sono quelli che nello schema fanno da nome: il login di Twitch, il canale
 * YouTube, l'indirizzo del feed, il termine del filtro, la soglia di una scala.
 */
function titoloElemento(item: unknown, indice: number): string {
  if (item && typeof item === 'object') {
    const oggetto = item as Record<string, unknown>;
    for (const chiave of ['login', 'channel', 'label', 'url', 'term', 'name']) {
      const valore = oggetto[chiave];
      if (typeof valore === 'string' && valore.trim() !== '') return valore;
    }
    if (typeof oggetto.atScore === 'number') return `da ${oggetto.atScore} punti`;
    if (typeof oggetto.infrazioni === 'number') return `alla ${oggetto.infrazioni}ª infrazione`;
  }
  return `Elemento ${indice + 1}`;
}

function oggettoSemplice(valore: unknown): valore is Json {
  return typeof valore === 'object' && valore !== null && !Array.isArray(valore);
}

/**
 * Le impostazioni di un oggetto, una riga ciascuna. Lo usano gli elenchi di
 * oggetti per ogni loro elemento; le sezioni passano da `SchedaModulo`, che
 * le divide in schede prima.
 */
function ObjectEditor({
  value,
  path,
  objectArrays,
  objectTemplates,
  onChange,
  depth = 0,
}: {
  value: Json;
  path: string;
  objectArrays: string[];
  objectTemplates: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
  depth?: number;
}) {
  return (
    <Righe
      voci={Object.entries(value)}
      path={path}
      depth={depth}
      objectArrays={objectArrays}
      objectTemplates={objectTemplates}
      onChange={onChange}
    />
  );
}

/**
 * Una riga per impostazione.
 *
 * Gli interruttori e i numeri stanno a destra, con il nome e la spiegazione
 * a sinistra: si legge la colonna dei nomi e l'occhio trova il valore sulla
 * stessa riga. I campi larghi — testi, canali, elenchi — vanno sotto il
 * nome, dove hanno lo spazio che serve.
 *
 * Ogni riga porta il suo percorso in `data-campo`: è lì che la ricerca
 * atterra.
 */
function Righe({
  voci,
  path,
  depth,
  objectArrays,
  objectTemplates,
  onChange,
}: {
  voci: [string, unknown][];
  path: string;
  depth: number;
  objectArrays: string[];
  objectTemplates: Record<string, unknown>;
  onChange: (path: string, value: unknown) => void;
}) {
  const guildId = useGuildId();
  const scelteFisse = useContext(ScelteFisse);
  const riga = '-mx-2 rounded-lg px-2 py-3';

  return (
    <div className="divide-y divide-[var(--color-border)]/60">
      {voci.map(([key, entry]) => {
        const fullPath = `${path}.${key}`;
        const label = labelFor(fullPath, key);
        const id = `campo-${fullPath}`;

        if (typeof entry === 'boolean') {
          return (
            <div key={key} data-campo={fullPath} className={`${riga} flex items-start justify-between gap-4`}>
              <div className="min-w-0">
                <label htmlFor={id} className="cursor-pointer text-sm font-medium text-neutral-200">
                  {label}
                </label>
                <Help path={fullPath} />
              </div>
              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                <span className={`text-xs ${entry ? 'text-[var(--color-success-text)]' : 'text-neutral-500'}`}>
                  {entry ? 'sì' : 'no'}
                </span>
                <Interruttore id={id} acceso={entry} onChange={(next) => onChange(fullPath, next)} />
              </div>
            </div>
          );
        }

        if (typeof entry === 'number') {
          return (
            <div
              key={key}
              data-campo={fullPath}
              className={`${riga} flex flex-wrap items-start justify-between gap-x-4 gap-y-2`}
            >
              <div className="min-w-0 flex-1">
                <label htmlFor={id} className="text-sm font-medium text-neutral-200">
                  {label}
                </label>
                <Help path={fullPath} />
              </div>
              <div className="shrink-0">
                <NumberInput id={id} value={entry} onChange={(next) => onChange(fullPath, next)} />
              </div>
            </div>
          );
        }

        if (typeof entry === 'string' || entry === null) {
          // Il nome del campo dice già cosa contiene: la convenzione
          // `…ChannelId` / `…RoleId` è rispettata in tutto lo schema, e usarla
          // evita di tenere un elenco a parte che si dimentica di aggiornare.
          const riferimento = tipoDiRiferimento(key);
          const scelte = scelteFisse[percorsoDelloSchema(fullPath)];

          if (scelte && typeof entry === 'string') {
            return (
              <div
                key={key}
                data-campo={fullPath}
                className={`${riga} flex flex-wrap items-start justify-between gap-x-4 gap-y-2`}
              >
                <div className="min-w-0 flex-1">
                  <label htmlFor={id} className="text-sm font-medium text-neutral-200">
                    {label}
                  </label>
                  <Help path={fullPath} />
                </div>
                <select
                  id={id}
                  value={entry}
                  onChange={(event) => onChange(fullPath, event.target.value)}
                  className="w-full shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm sm:w-64"
                >
                  {/* Un valore fuori elenco — da una versione vecchia — resta
                      visibile invece di sparire in silenzio. */}
                  {!scelte.includes(entry) && <option value={entry}>{entry}</option>}
                  {scelte.map((valore) => (
                    <option key={valore} value={valore}>
                      {describeValue(valore) ?? valore}
                    </option>
                  ))}
                </select>
              </div>
            );
          }

          return (
            <div key={key} data-campo={fullPath} className={riga}>
              <label className="block">
                <span className="block text-sm font-medium text-neutral-200">{label}</span>
                <Help path={fullPath} />
                <div className="mt-2">
                  {riferimento === 'canale' ? (
                    <ChannelPicker
                      guildId={guildId}
                      value={entry}
                      soloTestuali={!key.toLowerCase().includes('voice')}
                      onChange={(next) => onChange(fullPath, next)}
                    />
                  ) : riferimento === 'ruolo' ? (
                    <RolePicker
                      guildId={guildId}
                      value={entry}
                      onChange={(next) => onChange(fullPath, next)}
                    />
                  ) : (
                    <TextInput value={entry} onChange={(next) => onChange(fullPath, next)} />
                  )}
                </div>
              </label>
            </div>
          );
        }

        if (Array.isArray(entry)) {
          // L'elenco delle parole ha un editor suo: cinquecento voci non stanno
          // né come schede né come JSON, e la cosa che si fa più spesso —
          // aggiungere quella appena comparsa in chat — deve costare un campo e
          // un pulsante, altrimenti non la aggiunge nessuno.
          if (fullPath === 'security.language.terms') {
            return (
              <div key={key} data-campo={fullPath} className={`${riga} text-sm`}>
                <span className="block font-medium text-neutral-200">{label}</span>
                <Help path={fullPath} />
                <div className="mt-2">
                  <WordlistEditor
                    value={entry as Termine[]}
                    onChange={(next) => onChange(fullPath, next)}
                  />
                </div>
              </div>
            );
          }

          if (fullPath === 'security.language.allowlist') {
            return (
              <div key={key} data-campo={fullPath} className={`${riga} text-sm`}>
                <span className="block font-medium text-neutral-200">{label}</span>
                <Help path={fullPath} />
                <div className="mt-2">
                  <ParoleEditor
                    value={entry as string[]}
                    placeholder="una parola per riga"
                    onChange={(next) => onChange(fullPath, next)}
                  />
                </div>
              </div>
            );
          }

          // La forma la decide lo schema, non il contenuto: un elenco vuoto non
          // dice se conterrà stringhe od oggetti, e indovinare dal valore
          // significa mostrare una casella di testo dove serve un editor di
          // oggetti — con tutto ciò che si scrive lì rifiutato dal salvataggio.
          const oggetti =
            objectArrays.includes(fullPath) ||
            entry.some((item) => typeof item === 'object' && item !== null);

          if (!oggetti) {
            const riferimento = tipoDiRiferimento(key);

            return (
              <div key={key} data-campo={fullPath} className={riga}>
                <label className="block">
                  <span className="block text-sm font-medium text-neutral-200">{label}</span>
                  <Help path={fullPath} />
                  <div className="mt-2">
                    {riferimento === 'canale' || riferimento === 'ruolo' ? (
                      <MultiPicker
                        guildId={guildId}
                        value={entry as string[]}
                        cosa={riferimento === 'ruolo' ? 'ruoli' : 'canali'}
                        onChange={(next) => onChange(fullPath, next)}
                      />
                    ) : (
                      <ListInput
                        value={entry as (string | number)[]}
                        numeric={entry.every((item) => typeof item === 'number')}
                        onChange={(next) => onChange(fullPath, next)}
                      />
                    )}
                  </div>
                </label>
              </div>
            );
          }

          return (
            <ObjectListEditor
              key={key}
              label={label}
              path={fullPath}
              items={entry}
              template={objectTemplates[fullPath]}
              objectArrays={objectArrays}
              objectTemplates={objectTemplates}
              onChange={onChange}
            />
          );
        }

        if (oggettoSemplice(entry)) {
          const doc = describeField(fullPath);
          const figli = Object.entries(entry);
          const interno = (
            <div className="ml-2 mt-2 border-l border-[var(--color-border)] pl-4">
              <Righe
                voci={figli}
                path={fullPath}
                depth={depth + 1}
                objectArrays={objectArrays}
                objectTemplates={objectTemplates}
                onChange={onChange}
              />
            </div>
          );

          // Due o tre numeri che vanno letti insieme — «5 in 30 secondi» —
          // restano aperti: chiuderli costringerebbe a un clic per leggere
          // mezza frase.
          if (gruppoPiccolo(entry) && figli.every(([, figlio]) => typeof figlio === 'number')) {
            // Solo numeri: si leggono come una frase, sulla stessa riga. La
            // spiegazione di ogni numero resta nel suggerimento: è quasi sempre
            // «arco di tempo su cui si contano gli eventi», e ripeterla sotto
            // ogni soglia raddoppiava l'altezza della pagina.
            return (
              <div
                key={key}
                data-campo={fullPath}
                className={`${riga} flex flex-wrap items-start justify-between gap-x-4 gap-y-2`}
              >
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-neutral-200">{label}</span>
                  {doc && <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-neutral-400">{doc.help}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-3">
                  {figli.map(([chiaveFiglio, figlio]) => {
                    const percorsoFiglio = `${fullPath}.${chiaveFiglio}`;
                    const idFiglio = `campo-${percorsoFiglio}`;
                    return (
                      <div key={chiaveFiglio} data-campo={percorsoFiglio} className="rounded-lg">
                        <label
                          htmlFor={idFiglio}
                          title={describeField(percorsoFiglio)?.help}
                          className="mb-1 block text-xs text-neutral-400"
                        >
                          {labelFor(percorsoFiglio, chiaveFiglio)}
                        </label>
                        <NumberInput
                          id={idFiglio}
                          value={figlio as number}
                          onChange={(next) => onChange(percorsoFiglio, next)}
                          className="w-28 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          }

          if (gruppoPiccolo(entry)) {
            return (
              <div key={key} data-campo={fullPath} className={riga}>
                <span className="text-sm font-medium text-neutral-200">{label}</span>
                {doc && <p className="mt-0.5 max-w-2xl text-[13px] leading-relaxed text-neutral-400">{doc.help}</p>}
                {interno}
              </div>
            );
          }

          // Un gruppo più grande dentro un gruppo: chiuso finché non serve,
          // perché tre livelli aperti insieme sono una pagina che non finisce
          // più. Il riepilogo dice già se è acceso, e la ricerca lo apre da
          // sola quando il campo cercato sta lì dentro.
          const acceso = typeof entry.enabled === 'boolean' ? entry.enabled : null;
          return (
            <details key={key} data-campo={fullPath} className={riga}>
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm">
                {/* Il selettore guarda il `details` padre diretto: con i
                    gruppi annidati, `group-open` si accenderebbe anche per
                    quello esterno. */}
                <ChevronRight
                  aria-hidden
                  size={15}
                  className="shrink-0 text-neutral-500 transition-transform [details[open]>summary>&]:rotate-90"
                />
                <span className="shrink-0 font-medium text-neutral-200">{label}</span>
                {doc && <span className="hidden min-w-0 truncate text-xs text-neutral-500 md:inline">{doc.help}</span>}
                {acceso !== null && (
                  <span className="ml-auto shrink-0">
                    <Badge tone={acceso ? 'success' : 'neutral'}>{acceso ? 'attivo' : 'spento'}</Badge>
                  </span>
                )}
              </summary>
              {doc && (
                <p className="ml-6 mt-1 max-w-2xl text-[13px] leading-relaxed text-neutral-400 md:hidden">
                  {doc.help}
                </p>
              )}
              {interno}
            </details>
          );
        }

        return null;
      })}
    </div>
  );
}

/**
 * Testo, su una riga o su tre.
 *
 * La scelta fra riga singola e area di testo si fa una volta all'apertura:
 * deciderla a ogni tasto premuto significava vedere il campo trasformarsi
 * sotto le dita all'ottantunesimo carattere, perdendo il fuoco e il punto di
 * inserimento.
 */
function TextInput({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const [multiline] = useState(() => typeof value === 'string' && (value.length > 80 || value.includes('\n')));
  const [vuotoEraNullo] = useState(value === null);

  // Svuotare un campo che era già vuoto lo lascia nullo; svuotare un campo che
  // aveva un testo lo lascia vuoto. Trasformare sempre il vuoto in `null`
  // faceva rifiutare dal salvataggio i campi che una stringa devono averla.
  const emetti = (testo: string) => onChange(testo === '' && vuotoEraNullo ? null : testo);

  if (multiline) {
    return (
      <textarea
        value={value ?? ''}
        rows={3}
        onChange={(event) => emetti(event.target.value)}
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
      />
    );
  }

  return (
    <input
      type="text"
      value={value ?? ''}
      placeholder={value === null ? 'non impostato' : ''}
      onChange={(event) => emetti(event.target.value)}
      className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
    />
  );
}

function JsonEditor({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  const canonico = JSON.stringify(value, null, 2);
  const [text, setText] = useState(canonico);
  const [ultimo, setUltimo] = useState(canonico);
  const [invalid, setInvalid] = useState(false);
  const [corretti, setCorretti] = useState(false);

  // Il testo si riallinea solo ai cambi che arrivano da fuori — il pulsante
  // «Aggiungi», il ripristino di una versione — e non a quelli che questo
  // stesso campo ha appena prodotto, che riformatterebbero il JSON mentre lo
  // si scrive.
  if (canonico !== ultimo) {
    setUltimo(canonico);
    setText(canonico);
    setInvalid(false);
  }

  return (
    <div>
      <textarea
        className={`w-full rounded-lg border bg-[var(--color-surface-2)] px-3 py-2 font-mono text-xs ${
          invalid ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)]'
        }`}
        rows={Math.min(14, text.split('\n').length + 1)}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const sistemato = virgoletteSugliId(event.target.value);
          setCorretti(sistemato !== event.target.value);
          try {
            const parsed: unknown = JSON.parse(sistemato);
            setUltimo(JSON.stringify(parsed, null, 2));
            onChange(parsed);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        onBlur={() => {
          // Uscendo dal campo si mostra il JSON come è stato davvero letto:
          // rientrato, e con gli ID fra virgolette. Vederlo è l'unico modo di
          // accorgersi della correzione invece di scoprirla al salvataggio.
          if (!invalid) setText(ultimo);
        }}
      />
      {invalid && <p className="mt-1 text-xs text-[var(--color-danger)]">JSON non valido</p>}
      {corretti && !invalid && (
        <p className="mt-1 text-xs text-[var(--color-warning)]">
          ID Discord messi fra virgolette: sono più lunghi di quanto un numero JSON possa
          rappresentare senza perdere cifre.
        </p>
      )}
    </div>
  );
}

function getPath(source: Json, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object' && key in value) {
      return (value as Json)[key];
    }
    return undefined;
  }, source);
}

function setPath(target: Json, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop();
  if (!last) return;
  let cursor: Json = target;
  for (const key of keys) {
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key] as Json;
  }
  cursor[last] = value;
}

/** `joinBurst` → «Join burst», `newAccountHours` → «New account hours». */
function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
