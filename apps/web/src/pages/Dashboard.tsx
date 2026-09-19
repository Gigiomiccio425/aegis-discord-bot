import { useCallback, useEffect, useState } from 'react';
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
import { Badge, Button, Card, ErrorBox, Empty, Loading, Stat, formatDate, severityTone } from '../components/ui.js';
import { EsitoAzione, useAzione } from '../components/azione.js';

interface StatoLockdown {
  attivo: boolean;
  motivo: string | null;
  dal: number | null;
  scade: number | null;
  canali: number;
  ruoli: number;
  falliti: { canaleId: string; nome: string; motivo: string }[];
  botInLinea: boolean;
}

export function Dashboard() {
  const guildId = useGuildId();
  const [stats, setStats] = useState<Stats | null>(null);
  const [lockdown, setLockdown] = useState<StatoLockdown | null>(null);
  const [live, setLive] = useState<LogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const azione = useAzione(guildId);

  const aggiorna = useCallback(() => {
    void api
      .get<Stats>(`/api/guilds/${guildId}/stats`)
      .then(setStats)
      .catch((err: Error) => setError(err.message));
    void api
      .get<StatoLockdown>(`/api/guilds/${guildId}/lockdown`)
      .then(setLockdown)
      .catch(() => undefined);
  }, [guildId]);

  useEffect(() => {
    setStats(null);
    setLockdown(null);
    aggiorna();

    // Il feed live è ciò che rende la dashboard utile *durante* un attacco:
    // senza, si vedrebbe la situazione solo ricaricando la pagina. Un
    // lockdown partito da Discord o dall'anti-raid deve comparire anche qui.
    const close = openLiveFeed(guildId, (event) => {
      setLive((previous) => [event, ...previous].slice(0, 40));
      if (event.type.startsWith('SECURITY_LOCKDOWN')) aggiorna();
    });
    // Lo stato del lockdown cambia anche senza eventi — una scadenza, il bot
    // che si ricollega — e chi guarda la dashboard deve vederlo senza ricaricare.
    const timer = setInterval(() => {
      void api
        .get<StatoLockdown>(`/api/guilds/${guildId}/lockdown`)
        .then(setLockdown)
        .catch(() => undefined);
    }, 15_000);
    return () => {
      close();
      clearInterval(timer);
    };
  }, [guildId, aggiorna]);

  const esegui = (richiesta: () => Promise<unknown>) =>
    void azione.esegui(richiesta, { dopo: aggiorna });

  // Un'azione fallita non sostituisce più la pagina con un errore: prima un
  // lockdown rifiutato faceva sparire la dashboard intera, proprio durante
  // l'attacco. L'esito resta accanto ai pulsanti.
  if (error && !stats) return <ErrorBox message={error} />;
  if (!stats) return <Loading />;

  const chartData = stats.joinSeries.map((point) => ({
    ora: new Date(point.hour).toLocaleString('it-IT', { day: '2-digit', hour: '2-digit' }),
    ingressi: point.count,
  }));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={azione.occupato || lockdown?.attivo === true}
            onClick={() =>
              esegui(() =>
                api.post(`/api/guilds/${guildId}/actions/lockdown`, {
                  reason: 'Lockdown attivato dal pannello',
                  minutes: 15,
                }),
              )
            }
          >
            🔒 Lockdown 15 min
          </Button>
          <Button
            disabled={azione.occupato}
            onClick={() => esegui(() => api.delete(`/api/guilds/${guildId}/actions/lockdown`))}
          >
            🔓 Revoca lockdown
          </Button>
          <Button
            disabled={azione.occupato}
            onClick={() => esegui(() => api.post(`/api/guilds/${guildId}/backups`))}
          >
            💾 Backup ora
          </Button>
        </div>
      </header>

      <EsitoAzione guildId={guildId} stato={azione.stato} onChiudi={azione.azzera} />

      {lockdown && !lockdown.botInLinea && (
        <div className="rounded-lg border border-[var(--color-warning,#d8b45f)]/40 bg-[var(--color-warning,#d8b45f)]/10 p-3 text-sm text-[#ecd9a3]">
          Il bot non è collegato a Discord in questo momento. I comandi dal pannello restano in
          coda e partono appena torna — un lockdown solo entro tre minuti, perché dopo non
          sarebbe più quello che hai chiesto.
        </div>
      )}

      {lockdown?.attivo && (
        <Card
          title="🔒 Lockdown attivo"
          subtitle={
            (lockdown.dal ? `Dalle ${new Date(lockdown.dal).toLocaleTimeString('it-IT')}` : '') +
            (lockdown.scade
              ? ` · revoca automatica alle ${new Date(lockdown.scade).toLocaleTimeString('it-IT')}`
              : ' · revoca solo manuale')
          }
        >
          <div className="space-y-2 text-sm text-neutral-300">
            {lockdown.motivo && <p>{lockdown.motivo}</p>}
            <p>
              Canali chiusi: <strong>{lockdown.canali}</strong>
              {lockdown.ruoli > 0 && (
                <>
                  {' '}
                  · permessi di ruoli sospesi: <strong>{lockdown.ruoli}</strong>
                </>
              )}
            </p>
            {lockdown.falliti.length > 0 && (
              <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-2 text-[#f2a3ad]">
                <p className="font-medium">
                  {lockdown.falliti.length} non chiusi — lì si può ancora scrivere:
                </p>
                <ul className="mt-1 list-inside list-disc">
                  {lockdown.falliti.slice(0, 10).map((f) => (
                    <li key={`${f.canaleId}-${f.motivo}`}>
                      #{f.nome} — {f.motivo.replace(/<@&\d+>/g, 'un ruolo')}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}

      {lockdown && !lockdown.attivo && azione.stato?.testo.includes('non risulta attivo') && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-400">
          <span>I canali risultano comunque chiusi?</span>
          <Button
            variant="ghost"
            disabled={azione.occupato}
            onClick={() => {
              const conferma = window.confirm(
                'Riapre ogni canale che nega la scrittura a @everyone, compresi quelli che ' +
                  'lo staff aveva messo in sola lettura, come gli annunci: andranno richiusi a ' +
                  'mano. Procedere?',
              );
              if (conferma) {
                esegui(() => api.delete(`/api/guilds/${guildId}/actions/lockdown?forza=1`));
              }
            }}
          >
            Forza la riapertura
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat
          label="Minacce oggi"
          value={stats.threatsToday}
          tone={stats.threatsToday > 20 ? 'danger' : stats.threatsToday > 0 ? 'warning' : 'success'}
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

      <Card
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
                    <stop offset="0%" stopColor="#d8b45f" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#d8b45f" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#2a2f3a" vertical={false} />
                <XAxis dataKey="ora" tick={{ fill: '#8b93a5', fontSize: 11 }} minTickGap={40} />
                <YAxis tick={{ fill: '#8b93a5', fontSize: 11 }} allowDecimals={false} width={32} />
                <Tooltip
                  contentStyle={{
                    background: '#1e222b',
                    border: '1px solid #2a2f3a',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="ingressi"
                  stroke="#d8b45f"
                  fill="url(#ingressi)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Attività in tempo reale" subtitle="Eventi mentre accadono">
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

        <Card title="Minacce più frequenti" subtitle="Ultimi 7 giorni">
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

      <Card title="Incidenti recenti" subtitle="Raid, nuke e blocchi di emergenza">
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
                  <Badge tone={incident.endedAt ? 'neutral' : 'danger'}>{incident.kind}</Badge>
                  <span className="text-xs text-neutral-500">{formatDate(incident.startedAt)}</span>
                </div>
                <p className="mt-2 text-neutral-300">{incident.summary}</p>
                {incident.affectedUserIds.length > 0 && (
                  <div className="mt-2 flex items-center gap-3">
                    <span className="text-xs text-neutral-500">
                      {incident.affectedUserIds.length} account coinvolti
                    </span>
                    <Button
                      variant="ghost"
                      disabled={azione.occupato}
                      onClick={() =>
                        esegui(() =>
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
    </div>
  );
}
