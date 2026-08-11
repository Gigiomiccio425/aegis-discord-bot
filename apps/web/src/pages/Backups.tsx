import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, Empty, ErrorBox, Loading, formatDate } from '../components/ui.js';

interface Snapshot {
  id: string;
  kind: string;
  createdAt: string;
  createdBy: string | null;
  sizeBytes: number;
  restoredAt: string | null;
}

interface Diff {
  missingRoles: { name: string }[];
  missingChannels: { name: string }[];
  addedSince: { roles: { name: string }[]; channels: { name: string }[] };
  note: string;
}

export function Backups() {
  const guildId = useGuildId();
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [diff, setDiff] = useState<{ id: string; data: Diff } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .get<Snapshot[]>(`/api/guilds/${guildId}/backups`)
      .then(setSnapshots)
      .catch((err: Error) => setError(err.message));
  };

  useEffect(load, [guildId]);

  const createBackup = async () => {
    setBusy(true);
    try {
      await api.post(`/api/guilds/${guildId}/backups`);
      // Il bot esegue lo snapshot in modo asincrono: si attende qualche istante
      // prima di rileggere l'elenco.
      setTimeout(load, 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox message={error} />;
  if (!snapshots) return <Loading />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Backup</h1>
        <Button variant="primary" disabled={busy} onClick={() => void createBackup()}>
          Crea backup ora
        </Button>
      </div>

      <Card>
        <p className="text-sm leading-relaxed text-neutral-300">
          Un backup conserva ruoli con i loro permessi, canali con gli overwrite, categorie, emoji,
          sticker, impostazioni del server, regole AutoMod e l'elenco dei ruoli di ogni membro.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-warning)]">
          Discord non consente di ripristinare la cronologia dei messaggi. Dopo un nuke tornano
          struttura e permessi; i messaggi restano consultabili solo nel registro di ANGEL, come
          archivio, e non tornano nei canali.
        </p>
      </Card>

      <Card subtitle="Ultimi 50 backup. Quelli d'emergenza vengono conservati più a lungo degli altri.">
        {snapshots.length === 0 ? (
          <Empty>Nessun backup presente.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {snapshots.map((snapshot) => (
              <li
                key={snapshot.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)]/50 pb-2"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    tone={
                      snapshot.kind === 'EMERGENCY'
                        ? 'danger'
                        : snapshot.kind === 'MANUAL'
                          ? 'accent'
                          : 'neutral'
                    }
                  >
                    {snapshot.kind}
                  </Badge>
                  <span className="text-neutral-300">{formatDate(snapshot.createdAt)}</span>
                  <span className="text-xs text-neutral-500">
                    {Math.round(snapshot.sizeBytes / 1024)} KB
                  </span>
                  {snapshot.restoredAt && (
                    <span className="text-xs text-[var(--color-success)]">
                      ripristinato il {formatDate(snapshot.restoredAt)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-neutral-600">{snapshot.id.slice(0, 8)}</code>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void api
                        .get<Diff>(`/api/guilds/${guildId}/backups/${snapshot.id}/diff`)
                        .then((data) => setDiff({ id: snapshot.id, data }))
                        .catch((err: Error) => setError(err.message))
                    }
                  >
                    Anteprima
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {diff && (
        <Card
          title="Anteprima del ripristino"
          subtitle="Cosa verrebbe ricreato rispetto allo stato attuale"
          action={
            <Button variant="ghost" onClick={() => setDiff(null)}>
              Chiudi
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-medium text-neutral-200">Ruoli da ricreare</h3>
              {diff.data.missingRoles.length === 0 ? (
                <p className="text-sm text-neutral-500">Nessuno: i ruoli ci sono tutti.</p>
              ) : (
                <ul className="space-y-1 text-sm text-neutral-300">
                  {diff.data.missingRoles.map((role) => (
                    <li key={role.name}>• {role.name}</li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium text-neutral-200">Canali da ricreare</h3>
              {diff.data.missingChannels.length === 0 ? (
                <p className="text-sm text-neutral-500">Nessuno: i canali ci sono tutti.</p>
              ) : (
                <ul className="space-y-1 text-sm text-neutral-300">
                  {diff.data.missingChannels.map((channel) => (
                    <li key={channel.name}>• {channel.name}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <p className="mt-4 text-xs text-neutral-500">{diff.data.note}</p>
          <p className="mt-3 text-xs text-neutral-400">
            Il ripristino vero e proprio si esegue dal server con{' '}
            <code className="rounded bg-[var(--color-surface-2)] px-1">
              /backup ripristina id:{diff.id.slice(0, 8)}…
            </code>
            . È volutamente un comando e non un pulsante: è un'operazione che modifica la struttura
            del server e va lanciata da chi ha i permessi di amministratore su Discord.
          </p>
        </Card>
      )}
    </div>
  );
}
