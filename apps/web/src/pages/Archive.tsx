import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuildId } from '../App.js';
import { Button, Card, Empty, ErrorBox, Loading, Stat, formatDate } from '../components/ui.js';

interface ArchiveSummary {
  channels: { channelId: string; messages: number }[];
  total: number;
  deleted: number;
  attachments: number;
  oldest: string | null;
}

export function Archive() {
  const guildId = useGuildId();
  const [data, setData] = useState<ArchiveSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState('');

  useEffect(() => {
    api
      .get<ArchiveSummary>(`/api/guilds/${guildId}/archive`)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [guildId]);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;

  const download = (channelId: string) => {
    const params = new URLSearchParams({ name: channelId });
    if (days) params.set('days', days);
    // Il download passa dal browser e non da fetch: così il file finisce fra i
    // download dell'utente invece che in memoria.
    window.open(
      `/api/guilds/${guildId}/archive/${channelId}/transcript?${params.toString()}`,
      '_blank',
    );
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Archivio messaggi</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Messaggi archiviati" value={data.total.toLocaleString('it-IT')} />
        <Stat
          label="Di cui eliminati"
          value={data.deleted.toLocaleString('it-IT')}
          tone={data.deleted > 0 ? 'warning' : 'neutral'}
        />
        <Stat label="Allegati salvati" value={data.attachments.toLocaleString('it-IT')} />
        <Stat
          label="Il più vecchio"
          value={data.oldest ? formatDate(data.oldest).split(',')[0] ?? '—' : '—'}
        />
      </div>

      <Card>
        <p className="text-sm leading-relaxed text-neutral-300">
          Discord <strong>non consente</strong> di ripristinare i messaggi eliminati: nessun
          endpoint lo permette. Aegis tiene una copia mentre i messaggi passano, e da lì può
          produrre una trascrizione consultabile oppure ripubblicarli come ricostruzione dichiarata
          (<code>/archivio ricostruisci</code>).
        </p>
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          L'archivio contiene solo ciò che il bot ha visto passare dopo la sua installazione, e solo
          nella misura consentita dalla modalità di conservazione impostata nella configurazione del
          registro.
        </p>
      </Card>

      <Card
        title="Trascrizioni per canale"
        subtitle="File HTML autonomo: nessuna risorsa remota, leggibile anche fra dieci anni."
        action={
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              placeholder="giorni"
              value={days}
              onChange={(event) => setDays(event.target.value)}
              className="w-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
            />
            <span className="text-xs text-neutral-500">vuoto = tutto</span>
          </div>
        }
      >
        {data.channels.length === 0 ? (
          <Empty>
            Nessun messaggio archiviato. Verifica che il registro sia attivo e che la modalità di
            conservazione non sia impostata su «nessuna registrazione».
          </Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.channels.map((channel) => (
              <li
                key={channel.channelId}
                className="flex items-center justify-between gap-3 border-b border-[var(--color-border)]/50 py-2 last:border-0"
              >
                <div className="min-w-0">
                  <code className="text-neutral-300">{channel.channelId}</code>
                  <span className="ml-3 text-xs text-neutral-500">
                    {channel.messages.toLocaleString('it-IT')} messaggi
                  </span>
                </div>
                <Button onClick={() => download(channel.channelId)}>Scarica trascrizione</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
