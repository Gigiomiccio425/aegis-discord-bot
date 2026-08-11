import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type LogEvent } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, ErrorBox, Empty, Loading, formatDate, severityTone } from '../components/ui.js';

const CATEGORIES = [
  'MESSAGE',
  'REACTION',
  'MEMBER',
  'VOICE',
  'CHANNEL',
  'ROLE',
  'SERVER',
  'INVITE',
  'WEBHOOK',
  'MODERATION',
  'SECURITY',
  'AUTOMOD',
  'BOT',
];

export function Logs() {
  const guildId = useGuildId();
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Il filtro per autore arriva anche dalla scheda utente, via querystring:
  // «vedi solo i suoi eventi» deve atterrare qui già filtrato.
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState({
    category: '',
    actorId: searchParams.get('actorId') ?? '',
    search: '',
    minSeverity: '',
  });

  const load = useCallback(
    async (append = false) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (filters.category) params.set('category', filters.category);
        if (filters.actorId) params.set('actorId', filters.actorId);
        if (filters.search) params.set('search', filters.search);
        if (filters.minSeverity) params.set('minSeverity', filters.minSeverity);
        if (append && cursor) params.set('cursor', cursor);

        const result = await api.get<{ events: LogEvent[]; nextCursor: string | null }>(
          `/api/guilds/${guildId}/logs?${params.toString()}`,
        );
        setEvents((previous) => (append ? [...previous, ...result.events] : result.events));
        setCursor(result.nextCursor);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [guildId, filters, cursor],
  );

  useEffect(() => {
    setCursor(null);
    void load(false);
    // Volutamente senza `load` fra le dipendenze: cambia a ogni cursore, e
    // includerlo farebbe ripartire la ricerca a ogni pagina caricata.
  }, [guildId, filters]);

  /**
   * Esportazione.
   *
   * Passa dal browser e non da fetch, così il file finisce fra i download
   * dell'utente invece che in memoria. I filtri attivi vengono riportati:
   * esportare sempre tutto renderebbe il pulsante inutile quando serve davvero.
   */
  const exportLogs = (format: 'csv' | 'json') => {
    const params = new URLSearchParams({ format, limit: '20000' });
    if (filters.category) params.set('category', filters.category);
    if (filters.actorId) params.set('actorId', filters.actorId);
    if (filters.minSeverity) params.set('minSeverity', filters.minSeverity);
    window.open(`/api/guilds/${guildId}/logs/export?${params.toString()}`, '_blank');
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Registro eventi</h1>
        <div className="flex gap-2">
          <Button onClick={() => exportLogs('csv')}>Esporta CSV</Button>
          <Button onClick={() => exportLogs('json')}>Esporta JSON</Button>
        </div>
      </div>

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            value={filters.category}
            onChange={(event) => setFilters({ ...filters, category: event.target.value })}
          >
            <option value="">Tutte le categorie</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>

          <input
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            placeholder="ID utente"
            value={filters.actorId}
            onChange={(event) => setFilters({ ...filters, actorId: event.target.value })}
          />

          <input
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            placeholder="Cerca nel testo"
            value={filters.search}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          />

          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            value={filters.minSeverity}
            onChange={(event) => setFilters({ ...filters, minSeverity: event.target.value })}
          >
            <option value="">Qualsiasi gravità</option>
            <option value="40">Gravità ≥ 40</option>
            <option value="70">Gravità ≥ 70</option>
            <option value="90">Solo critici (≥ 90)</option>
          </select>
        </div>
      </Card>

      {error && <ErrorBox message={error} />}

      <Card>
        {events.length === 0 && !loading ? (
          <Empty>Nessun evento corrisponde ai filtri.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase text-neutral-500">
                  <th className="py-2 pr-3">Quando</th>
                  <th className="py-2 pr-3">Tipo</th>
                  <th className="py-2 pr-3">Autore</th>
                  <th className="py-2">Dettaglio</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <>
                    <tr
                      key={event.id}
                      className="cursor-pointer border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface-2)]"
                      onClick={() => setExpanded(expanded === event.id ? null : event.id)}
                    >
                      <td className="py-2 pr-3 whitespace-nowrap text-xs text-neutral-500">
                        {formatDate(event.createdAt)}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={severityTone(event.severity)}>{event.type}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-xs text-neutral-400">
                        {event.actorId ? (
                          <Link
                            to={`/g/${guildId}/utente/${event.actorId}`}
                            onClick={(clickEvent) => clickEvent.stopPropagation()}
                            className="hover:text-[var(--color-accent-soft)] hover:underline"
                          >
                            {event.actorTag ?? event.actorId}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 text-neutral-300">
                        {(event.summary ?? '').slice(0, 140) || '—'}
                      </td>
                    </tr>
                    {expanded === event.id && (
                      <tr key={`${event.id}-detail`}>
                        <td colSpan={4} className="bg-[var(--color-surface-2)] p-3">
                          <pre className="max-h-72 overflow-auto text-xs text-neutral-400">
                            {JSON.stringify(event.payload, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {loading && <Loading />}

        {cursor && !loading && (
          <div className="mt-4 text-center">
            <Button onClick={() => void load(true)}>Carica altri</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
