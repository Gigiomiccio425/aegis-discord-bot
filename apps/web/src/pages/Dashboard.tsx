import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, openLiveFeed, type LogEvent, type Stats } from '../api.js';
import { useGuildId } from '../App.js';
import { Activity, DatabaseBackup, Lock, LockOpen, Radio, ShieldAlert, Siren } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Empty,
  Gruppo,
  IntestazionePagina,
  Loading,
  Stat,
  formatDate,
  severityTone,
} from '../components/ui.js';

export function Dashboard() {
  const guildId = useGuildId();
  const [stats, setStats] = useState<Stats | null>(null);
  const [live, setLive] = useState<LogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStats(null);
    api
      .get<Stats>(`/api/guilds/${guildId}/stats`)
      .then(setStats)
      .catch((err: Error) => setError(err.message));

    // Il feed live è ciò che rende la dashboard utile *durante* un attacco:
    // senza, si vedrebbe la situazione solo ricaricando la pagina.
    const close = openLiveFeed(guildId, (event) => {
      setLive((previous) => [event, ...previous].slice(0, 40));
    });
    return close;
  }, [guildId]);

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      const fresh = await api.get<Stats>(`/api/guilds/${guildId}/stats`);
      setStats(fresh);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox message={error} />;
  if (!stats) return <Loading />;

  const chartData = stats.joinSeries.map((point) => ({
    ora: new Date(point.hour).toLocaleString('it-IT', { day: '2-digit', hour: '2-digit' }),
    ingressi: point.count,
  }));

  return (
    <div>
      <IntestazionePagina
        azioni={
          <>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void runAction(() =>
                  api.post(`/api/guilds/${guildId}/actions/lockdown`, {
                    reason: 'Lockdown attivato dal pannello',
                    minutes: 15,
                  }),
                )
              }
            >
              <Lock aria-hidden size={15} />
              Lockdown 15 min
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void runAction(() => api.delete(`/api/guilds/${guildId}/actions/lockdown`))
              }
            >
              <LockOpen aria-hidden size={15} />
              Revoca lockdown
            </Button>
            <Button
              disabled={busy}
              onClick={() => void runAction(() => api.post(`/api/guilds/${guildId}/backups`))}
            >
              <DatabaseBackup aria-hidden size={15} />
              Backup ora
            </Button>
          </>
        }
      />

      <div className="space-y-8">
        <Gruppo titolo="Oggi">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat
              label="Minacce oggi"
              value={stats.threatsToday}
              tone={
                stats.threatsToday > 20 ? 'danger' : stats.threatsToday > 0 ? 'warning' : 'success'
              }
            />
            <Stat label="Minacce (7 giorni)" value={stats.threatsWeek} />
            <Stat label="Ingressi oggi" value={stats.joinsToday} />
            <Stat
              label="Provvedimenti attivi"
              value={stats.activeCases}
              tone={stats.activeCases > 0 ? 'warning' : 'neutral'}
            />
            <Stat
              label="In quarantena"
              value={stats.quarantined}
              tone={stats.quarantined > 0 ? 'danger' : 'neutral'}
              hint={stats.quarantined > 0 ? 'Verifica i falsi positivi' : undefined}
            />
          </div>
        </Gruppo>

        <Gruppo titolo="Andamento della settimana">
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <Card
                icona={Activity}
                title="Ingressi per ora (7 giorni)"
                subtitle="Un picco improvviso è il segnale più leggibile di un raid in corso."
              >
                {chartData.length === 0 ? (
                  <Empty>Nessun ingresso registrato in questo periodo.</Empty>
                ) : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData}>
                        <defs>
                          <linearGradient id="ingressi" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.5} />
                            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="var(--color-border)" vertical={false} />
                        <XAxis
                          dataKey="ora"
                          tick={{ fill: 'var(--color-neutral-500)', fontSize: 11 }}
                          minTickGap={40}
                        />
                        <YAxis
                          tick={{ fill: 'var(--color-neutral-500)', fontSize: 11 }}
                          allowDecimals={false}
                          width={32}
                        />
                        <Tooltip
                          contentStyle={{
                            background: 'var(--color-surface-2)',
                            border: '1px solid var(--color-border)',
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="ingressi"
                          stroke="var(--color-accent)"
                          fill="url(#ingressi)"
                          strokeWidth={2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>
            </div>
            <Card icona={ShieldAlert} title="Minacce più frequenti" subtitle="Ultimi 7 giorni">
              {stats.topThreats.length === 0 ? (
                <Empty>Nessuna minaccia rilevata.</Empty>
              ) : (
                <ul className="space-y-2 text-sm">
                  {stats.topThreats.map((threat) => (
                    <li key={threat.type} className="flex items-center justify-between">
                      <span className="text-neutral-300">{threat.type}</span>
                      <Badge tone="warning">{threat.count}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </Gruppo>

        <Gruppo titolo="Incidenti e attività">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card
              icona={Siren}
              title="Incidenti recenti"
              subtitle="Raid, nuke e blocchi di emergenza"
            >
              {stats.incidents.length === 0 ? (
                <Empty>Nessun incidente registrato.</Empty>
              ) : (
                <ul className="space-y-3 text-sm">
                  {stats.incidents.map((incident) => (
                    <li
                      key={incident.id}
                      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
                    >
                      <div className="flex items-center justify-between">
                        <Badge tone={incident.endedAt ? 'neutral' : 'danger'}>
                          {incident.kind}
                        </Badge>
                        <span className="text-xs text-neutral-500">
                          {formatDate(incident.startedAt)}
                        </span>
                      </div>
                      <p className="mt-2 text-neutral-300">{incident.summary}</p>
                      {incident.affectedUserIds.length > 0 && (
                        <div className="mt-2 flex items-center gap-3">
                          <span className="text-xs text-neutral-500">
                            {incident.affectedUserIds.length} account coinvolti
                          </span>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void runAction(() =>
                                api.post(`/api/guilds/${guildId}/incidents/${incident.id}/release`),
                              )
                            }
                          >
                            Riabilita tutti
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card icona={Radio} title="Attività in tempo reale" subtitle="Eventi mentre accadono">
              {live.length === 0 ? (
                <Empty>In ascolto… gli eventi compariranno qui appena accadono.</Empty>
              ) : (
                <ul className="max-h-96 space-y-2 overflow-y-auto text-sm">
                  {live.map((event, index) => (
                    <li
                      key={`${event.createdAt}-${index}`}
                      className="flex items-start gap-2 border-b border-[var(--color-border)] pb-2 last:border-0"
                    >
                      <Badge tone={severityTone(event.severity)}>{event.type}</Badge>
                      <span className="flex-1 text-neutral-300">{event.summary ?? '—'}</span>
                      <span className="shrink-0 text-xs text-neutral-500">
                        {new Date(event.createdAt).toLocaleTimeString('it-IT')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </Gruppo>
      </div>
    </div>
  );
}
