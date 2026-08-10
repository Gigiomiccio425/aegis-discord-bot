import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, Empty, ErrorBox, Loading, formatDate } from '../components/ui.js';

interface PollSummary {
  id: string;
  question: string;
  channelId: string;
  anonymous: boolean;
  multiSelect: boolean;
  createdAt: string;
  closesAt: string | null;
  closedAt: string | null;
  voters: number;
  results: { label: string; count: number }[];
}

interface GiveawaySummary {
  id: string;
  prize: string;
  channelId: string;
  winnerCount: number;
  hostId: string;
  endsAt: string;
  endedAt: string | null;
  winnerIds: string[];
  entries: number;
  requirements: {
    minAccountAgeDays?: number;
    minMembershipDays?: number;
    requiredRoleIds?: string[];
  };
}

interface ReactionRoleSet {
  id: string;
  title: string;
  channelId: string;
  mode: string;
  options: { roleId: string; label: string }[];
  createdAt: string;
}

export function Integrations() {
  const guildId = useGuildId();
  const [polls, setPolls] = useState<PollSummary[] | null>(null);
  const [giveaways, setGiveaways] = useState<GiveawaySummary[] | null>(null);
  const [menus, setMenus] = useState<ReactionRoleSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    Promise.all([
      api.get<PollSummary[]>(`/api/guilds/${guildId}/polls`),
      api.get<GiveawaySummary[]>(`/api/guilds/${guildId}/giveaways`),
      api.get<ReactionRoleSet[]>(`/api/guilds/${guildId}/reaction-roles`),
    ])
      .then(([pollList, giveawayList, menuList]) => {
        setPolls(pollList);
        setGiveaways(giveawayList);
        setMenus(menuList);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  };

  useEffect(load, [guildId]);

  if (error) return <ErrorBox message={error} />;
  if (!polls || !giveaways || !menus) return <Loading />;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Integrazioni</h1>

      <p className="text-sm text-neutral-400">
        Sondaggi, giveaway e menu dei ruoli si <strong>creano</strong> dai comandi
        (<code>/sondaggio</code>, <code>/giveaway</code>, <code>/ruoli-menu</code>): vanno pubblicati
        in un canale, e sceglierlo da qui per poi non vedere il risultato sarebbe più scomodo. Da
        qui si osserva l'andamento e si chiude in anticipo.
      </p>

      <Card title="Sondaggi" subtitle="I risultati sono visibili qui anche a sondaggio aperto: chi amministra non sta votando.">
        {polls.length === 0 ? (
          <Empty>Nessun sondaggio. Creane uno con <code>/sondaggio crea</code>.</Empty>
        ) : (
          <ul className="space-y-4">
            {polls.map((poll) => {
              const max = Math.max(1, ...poll.results.map((result) => result.count));
              return (
                <li
                  key={poll.id}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-neutral-200">{poll.question}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                        <span>#{poll.channelId}</span>
                        <span>·</span>
                        <span>{poll.voters} votanti</span>
                        {poll.anonymous && <Badge tone="accent">anonimo</Badge>}
                        {poll.multiSelect && <Badge>multiplo</Badge>}
                        {poll.closedAt ? (
                          <Badge>chiuso</Badge>
                        ) : poll.closesAt ? (
                          <span>chiude il {formatDate(poll.closesAt)}</span>
                        ) : null}
                      </div>
                    </div>
                    {!poll.closedAt && (
                      <Button
                        onClick={() =>
                          void api
                            .post(`/api/guilds/${guildId}/polls/${poll.id}/close`)
                            .then(() => setTimeout(load, 1200))
                            .catch((err: Error) => setError(err.message))
                        }
                      >
                        Chiudi ora
                      </Button>
                    )}
                  </div>

                  <div className="mt-3 space-y-1.5">
                    {poll.results.map((result) => (
                      <div key={result.label} className="flex items-center gap-2 text-sm">
                        <span className="w-40 shrink-0 truncate text-neutral-300">
                          {result.label}
                        </span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-base)]">
                          <div
                            className="h-full rounded-full bg-[var(--color-accent)]"
                            style={{ width: `${(result.count / max) * 100}%` }}
                          />
                        </div>
                        <span className="w-10 text-right text-xs text-neutral-500">
                          {result.count}
                        </span>
                      </div>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Giveaway">
        {giveaways.length === 0 ? (
          <Empty>Nessun giveaway. Creane uno con <code>/giveaway crea</code>.</Empty>
        ) : (
          <ul className="space-y-2">
            {giveaways.map((giveaway) => (
              <li
                key={giveaway.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
              >
                <div className="min-w-0">
                  <div className="font-medium text-neutral-200">🎁 {giveaway.prize}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                    <span>{giveaway.entries} partecipanti</span>
                    <span>·</span>
                    <span>{giveaway.winnerCount} vincitori</span>
                    <span>·</span>
                    <span>
                      {giveaway.endedAt
                        ? `concluso il ${formatDate(giveaway.endedAt)}`
                        : `termina il ${formatDate(giveaway.endsAt)}`}
                    </span>
                    {(giveaway.requirements?.minAccountAgeDays ?? 0) > 0 && (
                      <Badge>account ≥ {giveaway.requirements.minAccountAgeDays}g</Badge>
                    )}
                  </div>
                  {giveaway.winnerIds.length > 0 && (
                    <div className="mt-1 text-xs text-[var(--color-success)]">
                      Vincitori: {giveaway.winnerIds.join(', ')}
                    </div>
                  )}
                </div>
                <Button
                  onClick={() =>
                    void api
                      .post(`/api/guilds/${guildId}/giveaways/${giveaway.id}/draw`)
                      .then(() => setTimeout(load, 1500))
                      .catch((err: Error) => setError(err.message))
                  }
                >
                  {giveaway.endedAt ? 'Riestrai' : 'Estrai ora'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Menu dei ruoli"
        subtitle="I ruoli con permessi amministrativi non sono assegnabili da un menu: sarebbe una scalata di privilegi aperta a chiunque veda il messaggio."
      >
        {menus.length === 0 ? (
          <Empty>Nessun menu. Creane uno con <code>/ruoli-menu</code>.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {menus.map((menu) => (
              <li
                key={menu.id}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-neutral-200">{menu.title}</span>
                  <Badge tone="accent">{menu.mode}</Badge>
                </div>
                <div className="mt-1 text-xs text-neutral-500">
                  {menu.options.map((option) => option.label).join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
