import { useEffect, useMemo, useState } from 'react';
import { describeField, SECTION_DOCS } from '@aegis/shared/docs';
import { api } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, ErrorBox, Loading, formatDate } from '../components/ui.js';

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
      setError((err as Error).message);
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
        <div className="rounded-lg border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-sm text-[#8ee0a8]">
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
                    ? 'bg-[var(--color-accent)]/15 text-[#a5adff]'
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

function ObjectEditor({
  value,
  path,
  onChange,
  depth = 0,
}: {
  value: Json;
  path: string;
  onChange: (path: string, value: unknown) => void;
  depth?: number;
}) {
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
                <input
                  type="number"
                  value={entry}
                  onChange={(event) => onChange(fullPath, Number(event.target.value))}
                  className="w-32 shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
                />
              </label>
              <Help path={fullPath} />
            </div>
          );
        }

        if (typeof entry === 'string' || entry === null) {
          const multiline = typeof entry === 'string' && entry.length > 80;
          return (
            <div key={key} className="py-2">
              <label className="block text-sm">
                <span className="mb-1 block text-neutral-300">{label}</span>
                {multiline ? (
                  <textarea
                    value={entry}
                    rows={3}
                    onChange={(event) => onChange(fullPath, event.target.value || null)}
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
                  />
                ) : (
                  <input
                    type="text"
                    value={entry ?? ''}
                    placeholder={entry === null ? 'non impostato' : ''}
                    onChange={(event) => onChange(fullPath, event.target.value || null)}
                    className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
                  />
                )}
              </label>
              <Help path={fullPath} />
            </div>
          );
        }

        if (Array.isArray(entry)) {
          const isPrimitive = entry.every(
            (item) => typeof item === 'string' || typeof item === 'number',
          );
          if (isPrimitive) {
            return (
              <div key={key} className="py-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-300">{label}</span>
                  <input
                    type="text"
                    value={entry.join(', ')}
                    onChange={(event) =>
                      onChange(
                        fullPath,
                        event.target.value
                          .split(',')
                          .map((item) => item.trim())
                          .filter(Boolean),
                      )
                    }
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
                    placeholder="valori separati da virgola"
                  />
                </label>
                <Help path={fullPath} />
              </div>
            );
          }

          // Le strutture complesse (scale d'azione, elenchi di streamer) si
          // modificano come JSON: fabbricare un editor dedicato per ciascuna
          // costerebbe più di quanto renda, e il server valida comunque tutto.
          return (
            <div key={key} className="py-2 text-sm">
              <span className="mb-1 block text-neutral-300">{label}</span>
              <Help path={fullPath} />
              <div className="mt-1">
                <JsonEditor value={entry} onChange={(next) => onChange(fullPath, next)} />
              </div>
            </div>
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

function JsonEditor({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);

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
          try {
            onChange(JSON.parse(event.target.value));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid && <p className="mt-1 text-xs text-[var(--color-danger)]">JSON non valido</p>}
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
