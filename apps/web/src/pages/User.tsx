import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type CaseRecord, type LogEvent, type RiskyUser } from '../api.js';
import { useGuildId } from '../App.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  Stat,
  formatDate,
  severityTone,
} from '../components/ui.js';

interface Timeline {
  profile: (RiskyUser & {
    accountCreatedAt: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    joinedAt: string | null;
    leftAt: string | null;
    joinCount: number;
    messageCount: number;
    inviteCode: string | null;
    invitedBy: string | null;
    warnCount: number;
    avatarHash: string | null;
  }) | null;
  events: LogEvent[];
  cases: CaseRecord[];
  voice: { totalSeconds: number; sessions: number };
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Scheda utente completa.
 *
 * È la vista che risponde alla domanda più frequente durante un'indagine —
 * «cosa ha fatto questa persona, e cosa le è stato fatto» — mettendo sulla
 * stessa pagina profilo, provvedimenti e cronologia. Finora quei dati erano nel
 * database e raggiungibili via API, ma non c'era modo di guardarli.
 */
export function User() {
  const guildId = useGuildId();
  const { userId } = useParams<{ userId: string }>();
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; content: string | null } | null>(null);

  useEffect(() => {
    if (!userId) return;
    setData(null);
    api
      .get<Timeline>(`/api/guilds/${guildId}/users/${userId}/timeline`)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [guildId, userId]);

  if (error) return <ErrorBox message={error} />;
  if (!data || !userId) return <Loading />;

  const profile = data.profile;
  const accountAgeDays = profile?.accountCreatedAt
    ? Math.floor((Date.now() - new Date(profile.accountCreatedAt).getTime()) / 86_400_000)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {profile?.displayName ?? profile?.username ?? 'Utente'}
          </h1>
          <code className="text-xs text-neutral-500">{userId}</code>
        </div>
        <Link to={`/g/${guildId}/log?actorId=${userId}`}>
          <Button>Vedi solo i suoi eventi</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat
          label="Rischio"
          value={`${profile?.riskScore ?? 0}/100`}
          tone={
            (profile?.riskScore ?? 0) >= 70
              ? 'danger'
              : (profile?.riskScore ?? 0) >= 40
                ? 'warning'
                : 'success'
          }
        />
        <Stat label="Provvedimenti" value={data.cases.length} />
        <Stat label="Avvertimenti" value={profile?.warnCount ?? 0} />
        <Stat
          label="Tempo in vocale"
          value={duration(data.voice.totalSeconds)}
          hint={`${data.voice.sessions} sessioni`}
        />
        <Stat
          label="Età account"
          value={accountAgeDays !== null ? `${accountAgeDays}g` : '—'}
        />
      </div>

      {profile?.quarantinedAt && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Badge tone="danger">In quarantena</Badge>
              <span className="ml-3 text-sm text-neutral-300">
                Dal {formatDate(profile.quarantinedAt)} · {profile.quarantineReason}
              </span>
            </div>
            <Button
              variant="primary"
              onClick={() =>
                void api
                  .post(`/api/guilds/${guildId}/users/${userId}/quarantine/lift`)
                  .then(() =>
                    api
                      .get<Timeline>(`/api/guilds/${guildId}/users/${userId}/timeline`)
                      .then(setData),
                  )
                  .catch((err: Error) => setError(err.message))
              }
            >
              Libera e ripristina i ruoli
            </Button>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Profilo">
          {profile ? (
            <dl className="space-y-2 text-sm">
              {[
                ['Username', profile.username ?? '—'],
                ['Nome visualizzato', profile.displayName ?? '—'],
                ['Primo avvistamento', formatDate(profile.firstSeenAt)],
                ['Ultima attività', formatDate(profile.lastSeenAt)],
                ['Ingressi nel server', String(profile.joinCount)],
                ['Messaggi contati', String(profile.messageCount)],
                [
                  'Entrato con',
                  profile.inviteCode
                    ? `invito ${profile.inviteCode}${profile.invitedBy ? ` di ${profile.invitedBy}` : ''}`
                    : 'non ricostruibile',
                ],
                ['Uscito il', profile.leftAt ? formatDate(profile.leftAt) : '—'],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4">
                  <dt className="text-neutral-500">{label}</dt>
                  <dd className="text-right text-neutral-300">{value}</dd>
                </div>
              ))}
              {profile.riskFlags.length > 0 && (
                <div className="pt-2">
                  <dt className="mb-1 text-neutral-500">Segnali di rischio</dt>
                  <dd className="flex flex-wrap gap-1">
                    {profile.riskFlags.map((flag) => (
                      <Badge key={flag} tone="warning">
                        {flag}
                      </Badge>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <Empty>Nessun profilo registrato per questo utente.</Empty>
          )}
        </Card>

        <Card title="Provvedimenti">
          {data.cases.length === 0 ? (
            <Empty>Nessun provvedimento.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.cases.map((record) => (
                <li
                  key={record.id}
                  className="border-b border-[var(--color-border)]/50 pb-2 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-neutral-500">#{record.number}</span>
                    <Badge tone={record.status === 'ACTIVE' ? 'danger' : 'neutral'}>
                      {record.type}
                    </Badge>
                    <span className="text-xs text-neutral-500">{formatDate(record.createdAt)}</span>
                  </div>
                  <div className="mt-1 text-neutral-300">{record.reason}</div>
                  {record.module && (
                    <div className="text-xs text-neutral-600">automatico · {record.module}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="Cronologia"
        subtitle="Ultimi 100 eventi in cui compare, come autore o come destinatario"
      >
        {data.events.length === 0 ? (
          <Empty>Nessun evento registrato.</Empty>
        ) : (
          <ul className="max-h-[32rem] space-y-1 overflow-y-auto text-sm">
            {data.events.map((event) => (
              <li
                key={event.id}
                className="flex items-start gap-2 border-b border-[var(--color-border)]/40 py-1.5 last:border-0"
              >
                <span className="w-32 shrink-0 text-xs text-neutral-600">
                  {formatDate(event.createdAt)}
                </span>
                <Badge tone={severityTone(event.severity)}>{event.type}</Badge>
                <span className="flex-1 text-neutral-300">
                  {(event.summary ?? '').slice(0, 200)}
                </span>
                {event.messageId && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void api
                        .get<{ id: string; content: string | null }>(
                          `/api/guilds/${guildId}/messages/${event.messageId}`,
                        )
                        .then(setMessage)
                        .catch(() => setMessage({ id: event.messageId!, content: null }))
                    }
                  >
                    messaggio
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {message && (
        <Card
          title="Messaggio archiviato"
          action={
            <Button variant="ghost" onClick={() => setMessage(null)}>
              Chiudi
            </Button>
          }
        >
          <pre className="max-h-72 overflow-auto rounded-lg bg-[var(--color-surface-2)] p-3 text-xs whitespace-pre-wrap text-neutral-300">
            {message.content ??
              'Contenuto non disponibile: il messaggio non era archiviato, oppure la modalità di conservazione non salva il testo.'}
          </pre>
        </Card>
      )}
    </div>
  );
}
