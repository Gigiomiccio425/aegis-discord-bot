import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, Empty, ErrorBox, Loading, formatDate } from '../components/ui.js';

interface AccessEntry {
  id: string;
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MOD' | 'VIEWER';
  grantedBy: string | null;
  grantedAt: string;
  lastLoginAt: string | null;
}

interface AccessResponse {
  entries: AccessEntry[];
  yourRole: AccessEntry['role'];
  yourId: string;
}

const ROLES: AccessEntry['role'][] = ['VIEWER', 'MOD', 'ADMIN', 'OWNER'];

const DESCRIPTIONS: Record<AccessEntry['role'], string> = {
  VIEWER: 'Vede la dashboard e le statistiche. Nessuna azione, nessun archivio.',
  MOD: 'Registro, provvedimenti, appelli, scheda utente e trascrizioni.',
  ADMIN: 'Tutto quanto sopra, più configurazione, backup e gestione degli accessi.',
  OWNER: 'Controllo completo. Solo un OWNER può nominare un altro OWNER.',
};

export function Access() {
  const guildId = useGuildId();
  const [data, setData] = useState<AccessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ userId: '', role: 'VIEWER' as AccessEntry['role'] });

  const load = () => {
    api
      .get<AccessResponse>(`/api/guilds/${guildId}/access`)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  };

  useEffect(load, [guildId]);

  const grant = async (userId: string, role: AccessEntry['role']) => {
    try {
      await api.put(`/api/guilds/${guildId}/access/${userId}`, { role });
      setDraft({ userId: '', role: 'VIEWER' });
      setError(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (error && !data) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Accessi al pannello</h1>

      {error && <ErrorBox message={error} />}

      <Card>
        <p className="text-sm leading-relaxed text-neutral-300">
          I permessi del pannello sono <strong>separati</strong> da quelli di Discord: avere
          <code className="mx-1">MANAGE_GUILD</code> è la condizione minima per entrare, ma cosa si
          può fare dentro lo decide questo elenco. Amministrare un server non implica il diritto di
          leggere l'archivio di tutte le conversazioni.
        </p>
        <p className="mt-3 text-sm text-neutral-400">
          Revocare un accesso chiude anche le sessioni aperte di quella persona: altrimenti
          resterebbe dentro fino alla scadenza del cookie, e la revoca sarebbe solo formale.
        </p>
      </Card>

      <Card title="Livelli">
        <ul className="space-y-2 text-sm">
          {ROLES.map((role) => (
            <li key={role} className="flex gap-3">
              <Badge tone={role === 'OWNER' ? 'danger' : role === 'ADMIN' ? 'warning' : 'neutral'}>
                {role}
              </Badge>
              <span className="text-neutral-400">{DESCRIPTIONS[role]}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Concedi accesso">
        <div className="flex flex-wrap gap-2">
          <input
            className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            placeholder="ID Discord dell'utente"
            value={draft.userId}
            onChange={(event) => setDraft({ ...draft, userId: event.target.value.trim() })}
          />
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            value={draft.role}
            onChange={(event) =>
              setDraft({ ...draft, role: event.target.value as AccessEntry['role'] })
            }
          >
            {ROLES.filter((role) => role !== 'OWNER' || data.yourRole === 'OWNER').map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            disabled={!/^\d{17,20}$/.test(draft.userId)}
            onClick={() => void grant(draft.userId, draft.role)}
          >
            Concedi
          </Button>
        </div>
      </Card>

      <Card subtitle={`${data.entries.length} persone hanno accesso a questo server`}>
        {data.entries.length === 0 ? (
          <Empty>Nessun accesso registrato.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase text-neutral-500">
                  <th className="py-2 pr-3">Utente</th>
                  <th className="py-2 pr-3">Livello</th>
                  <th className="py-2 pr-3">Concesso</th>
                  <th className="py-2 pr-3">Ultimo accesso</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => {
                  const isSelf = entry.userId === data.yourId;
                  return (
                    <tr key={entry.id} className="border-b border-[var(--color-border)]/50">
                      <td className="py-2 pr-3">
                        <code className="text-neutral-300">{entry.userId}</code>
                        {isSelf && <Badge tone="accent">tu</Badge>}
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs disabled:opacity-40"
                          value={entry.role}
                          disabled={isSelf}
                          onChange={(event) =>
                            void grant(entry.userId, event.target.value as AccessEntry['role'])
                          }
                        >
                          {ROLES.filter(
                            (role) => role !== 'OWNER' || data.yourRole === 'OWNER',
                          ).map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 pr-3 text-xs text-neutral-500">
                        {formatDate(entry.grantedAt)}
                      </td>
                      <td className="py-2 pr-3 text-xs text-neutral-500">
                        {entry.lastLoginAt ? formatDate(entry.lastLoginAt) : 'mai'}
                      </td>
                      <td className="py-2 text-right">
                        {!isSelf && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void api
                                .delete(`/api/guilds/${guildId}/access/${entry.userId}`)
                                .then(load)
                                .catch((err: Error) => setError(err.message))
                            }
                          >
                            Revoca
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 text-xs text-neutral-500">
          Non puoi modificare né revocare il tuo stesso accesso: serve un altro amministratore. È la
          garanzia che un account compromesso non possa prendersi tutto e chiudere fuori gli altri.
        </p>
      </Card>
    </div>
  );
}
