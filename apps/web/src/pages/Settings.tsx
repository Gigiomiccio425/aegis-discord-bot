import { useEffect, useMemo, useState } from 'react';
import { describeField, SECTION_DOCS } from '@angel/shared/docs';
import { virgoletteSugliId } from '@angel/shared/json';
import { api } from '../api.js';
import { ChannelPicker, MultiPicker, RolePicker } from '../components/pickers.js';
import { ParoleEditor, WordlistEditor, type Termine } from '../components/WordlistEditor.js';
import { useGuildId } from '../App.js';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
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

interface ConfigResponse {
  config: Json;
  modules: { key: string; label: string; group: string }[];
  objectArrays: string[];
  objectArrayTemplates: Record<string, unknown>;
  invalid: { path: string; message: string }[] | null;
}

export function Settings() {
  const guildId = useGuildId();
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [draft, setDraft] = useState<Json | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [selected, setSelected] = useState('general');
  const [saving, setSaving] = useState(false);

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

  const sections = useMemo(() => {
    if (!data) return [];
    return [
      { key: 'general', label: 'Generale', group: 'Base' },
      ...data.modules,
    ];
  }, [data]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api.put<{ changedPaths: string[] }>(
        `/api/guilds/${guildId}/config`,
        draft,
      );
      setSaved(`Salvato: ${result.changedPaths.length} modifiche applicate subito al bot.`);
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

  const current = getPath(draft, selected);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Configurazione</h1>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Salvataggio…' : 'Salva modifiche'}
        </Button>
      </div>

      {error && <ErrorBox message={error} />}
      {saved && (
        <div className="rounded-lg border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-sm text-[#8fe0b4]">
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

      <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
        <nav className="space-y-1">
          {sections.map((section) => {
            const value = getPath(draft, section.key);
            const enabled =
              value && typeof value === 'object' && 'enabled' in (value as Json)
                ? Boolean((value as Json).enabled)
                : null;

            return (
              <button
                key={section.key}
                onClick={() => setSelected(section.key)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  selected === section.key
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent-soft)]'
                    : 'text-neutral-300 hover:bg-[var(--color-surface-2)]'
                }`}
              >
                <span>{section.label}</span>
                {enabled !== null && (
                  <span className={enabled ? 'text-[var(--color-success)]' : 'text-neutral-600'}>
                    ●
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <Card>
          <SectionIntro sectionKey={selected} />
          {current && typeof current === 'object' ? (
            <ObjectEditor
              value={current as Json}
              path={selected}
              objectArrays={data.objectArrays ?? []}
              objectTemplates={data.objectArrayTemplates ?? {}}
              onChange={(path, value) => {
                const next = structuredClone(draft);
                setPath(next, path, value);
                setDraft(next);
              }}
            />
          ) : (
            <p className="text-sm text-neutral-500">Sezione non disponibile.</p>
          )}
        </Card>
      </div>

      <ConfigHistory guildId={guildId} onRestored={() => location.reload()} />
      <PanelSessions />
    </div>
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

/**
 * Introduzione della sezione.
 *
 * Risponde alla domanda che viene prima di ogni spunta — questa cosa a che
 * serve, e mi serve — senza costringere ad aprire il README.
 */
function SectionIntro({ sectionKey }: { sectionKey: string }) {
  const doc = SECTION_DOCS[sectionKey];
  if (!doc) return null;

  return (
    <div className="mb-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 p-4">
      <p className="text-sm font-medium text-neutral-200">{doc.summary}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">{stripMarkdown(doc.detail)}</p>
    </div>
  );
}

/** Il grassetto `**così**` non ha senso in HTML: si toglie e basta. */
function stripMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1');
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
  return <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{doc.help}</p>;
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
    <div className="py-2 text-sm">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-neutral-300">
          {label}
          {items.length > 0 && <span className="ml-2 text-xs text-neutral-600">{items.length}</span>}
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
  const guildId = useGuildId();

  return (
    <div className={depth > 0 ? 'ml-3 border-l border-[var(--color-border)] pl-3' : ''}>
      {Object.entries(value).map(([key, entry]) => {
        const fullPath = `${path}.${key}`;
        const label = labelFor(fullPath, key);

        if (typeof entry === 'boolean') {
          return (
            <div key={key} className="py-2">
              <label className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={entry}
                  onChange={(event) => onChange(fullPath, event.target.checked)}
                  className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="text-neutral-200">{label}</span>
                {key === 'enabled' && (
                  <Badge tone={entry ? 'success' : 'neutral'}>{entry ? 'attivo' : 'spento'}</Badge>
                )}
              </label>
              <div className="pl-7">
                <Help path={fullPath} />
              </div>
            </div>
          );
        }

        if (typeof entry === 'number') {
          return (
            <div key={key} className="py-2">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="text-neutral-300">{label}</span>
                <NumberInput value={entry} onChange={(next) => onChange(fullPath, next)} />
              </label>
              <Help path={fullPath} />
            </div>
          );
        }

        if (typeof entry === 'string' || entry === null) {
          // Il nome del campo dice già cosa contiene: la convenzione
          // `…ChannelId` / `…RoleId` è rispettata in tutto lo schema, e usarla
          // evita di tenere un elenco a parte che si dimentica di aggiornare.
          const riferimento = tipoDiRiferimento(key);

          return (
            <div key={key} className="py-2">
              <label className="block text-sm">
                <span className="mb-1 block text-neutral-300">{label}</span>
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
              </label>
              <Help path={fullPath} />
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
              <div key={key} className="py-2 text-sm">
                <span className="mb-1 block text-neutral-300">{label}</span>
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
              <div key={key} className="py-2 text-sm">
                <span className="mb-1 block text-neutral-300">{label}</span>
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
              <div key={key} className="py-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-300">{label}</span>
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
                </label>
                <Help path={fullPath} />
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

        if (typeof entry === 'object') {
          const doc = describeField(fullPath);
          return (
            <details key={key} className="py-2" open={depth === 0}>
              <summary className="cursor-pointer text-sm font-medium text-neutral-200">
                {label}
              </summary>
              {doc && <p className="mt-0.5 text-xs text-neutral-500">{doc.help}</p>}
              <ObjectEditor
                value={entry as Json}
                path={fullPath}
                objectArrays={objectArrays}
                objectTemplates={objectTemplates}
                onChange={onChange}
                depth={depth + 1}
              />
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
