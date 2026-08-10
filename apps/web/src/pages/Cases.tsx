import { useEffect, useState } from 'react';
import { api, type CaseRecord } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, Empty, ErrorBox, Loading, formatDate } from '../components/ui.js';

const TONE: Record<string, 'neutral' | 'warning' | 'danger' | 'success'> = {
  NOTE: 'neutral',
  WARN: 'warning',
  MUTE: 'warning',
  KICK: 'danger',
  BAN: 'danger',
  QUARANTINE: 'danger',
  ROLE_STRIP: 'danger',
  PURGE: 'neutral',
  UNBAN: 'success',
  UNQUARANTINE: 'success',
};

interface AppealRecord extends CaseRecord {
  appealText: string | null;
  appealAt: string | null;
}

export function Cases() {
  const guildId = useGuildId();
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [appeals, setAppeals] = useState<AppealRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('ACTIVE');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: '100' });
    if (status) params.set('status', status);
    Promise.all([
      api.get<{ cases: CaseRecord[]; total: number }>(
        `/api/guilds/${guildId}/cases?${params.toString()}`,
      ),
      api.get<AppealRecord[]>(`/api/guilds/${guildId}/appeals`),
    ])
      .then(([result, appealList]) => {
        setCases(result.cases);
        setTotal(result.total);
        setAppeals(appealList);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [guildId, status]);

  const resolveAppeal = async (caseId: string, accepted: boolean) => {
    try {
      await api.post(`/api/guilds/${guildId}/cases/${caseId}/appeal`, { accepted });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (caseId: string) => {
    try {
      await api.post(`/api/guilds/${guildId}/cases/${caseId}/revoke`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Provvedimenti</h1>
        <select
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="ACTIVE">Attivi</option>
          <option value="EXPIRED">Scaduti</option>
          <option value="REVOKED">Revocati</option>
          <option value="">Tutti</option>
        </select>
      </div>

      {error && <ErrorBox message={error} />}

      {appeals.length > 0 && (
        <Card
          title={`Appelli in attesa (${appeals.length})`}
          subtitle="Accogliere un appello revoca davvero il provvedimento su Discord, non solo nel registro."
        >
          <ul className="space-y-3">
            {appeals.map((appeal) => (
              <li
                key={appeal.id}
                className="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-mono text-xs text-neutral-500">#{appeal.number}</span>
                      <Badge tone={TONE[appeal.type] ?? 'neutral'}>{appeal.type}</Badge>
                      <span className="text-neutral-300">{appeal.targetTag ?? appeal.targetId}</span>
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      Provvedimento: {appeal.reason.slice(0, 120)}
                    </div>
                    <blockquote className="mt-2 border-l-2 border-[var(--color-border)] pl-3 text-sm text-neutral-300">
                      {appeal.appealText ?? '(nessun testo)'}
                    </blockquote>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="primary" onClick={() => void resolveAppeal(appeal.id, true)}>
                      Accogli
                    </Button>
                    <Button onClick={() => void resolveAppeal(appeal.id, false)}>Respingi</Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card subtitle={`${total} provvedimenti registrati in totale`}>
        {loading ? (
          <Loading />
        ) : cases.length === 0 ? (
          <Empty>Nessun provvedimento in questo stato.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase text-neutral-500">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">Tipo</th>
                  <th className="py-2 pr-3">Utente</th>
                  <th className="py-2 pr-3">Motivo</th>
                  <th className="py-2 pr-3">Origine</th>
                  <th className="py-2 pr-3">Data</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {cases.map((record) => (
                  <tr key={record.id} className="border-b border-[var(--color-border)]/50">
                    <td className="py-2 pr-3 font-mono text-xs text-neutral-500">#{record.number}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={TONE[record.type] ?? 'neutral'}>{record.type}</Badge>
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      <div className="text-neutral-300">{record.targetTag ?? '—'}</div>
                      <div className="font-mono text-neutral-600">{record.targetId}</div>
                    </td>
                    <td className="py-2 pr-3 text-neutral-300">{record.reason.slice(0, 90)}</td>
                    <td className="py-2 pr-3 text-xs text-neutral-500">
                      {record.automated ? `auto · ${record.module ?? ''}` : 'manuale'}
                    </td>
                    <td className="py-2 pr-3 text-xs whitespace-nowrap text-neutral-500">
                      {formatDate(record.createdAt)}
                    </td>
                    <td className="py-2 text-right">
                      {record.status === 'ACTIVE' && (
                        <Button variant="ghost" onClick={() => void revoke(record.id)}>
                          Revoca
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-neutral-500">
        Revocare una quarantena restituisce all'utente i ruoli che aveva prima: sono conservati
        proprio per questo. È l'operazione da usare quando una difesa automatica ha colpito un
        utente legittimo.
      </p>
    </div>
  );
}
