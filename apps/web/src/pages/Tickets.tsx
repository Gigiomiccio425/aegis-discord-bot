import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, Empty, ErrorBox, Loading, Stat, formatDate } from '../components/ui.js';

interface Ticket {
  number: number;
  subject: string;
  status: 'OPEN' | 'CLOSED' | 'ARCHIVED';
  openerId: string;
  claimedBy: string | null;
  claimedAt: string | null;
  closedBy: string | null;
  closedAt: string | null;
  closeReason: string | null;
  createdAt: string;
  messageCount: number;
  hasTranscript: boolean;
}

interface TicketList {
  tickets: Ticket[];
  open: number;
  closed: number;
}

const STATI: Record<Ticket['status'], { label: string; tone: 'accent' | 'neutral' }> = {
  OPEN: { label: 'Aperto', tone: 'accent' },
  CLOSED: { label: 'Chiuso', tone: 'neutral' },
  ARCHIVED: { label: 'Archiviato', tone: 'neutral' },
};

export function Tickets() {
  const guildId = useGuildId();
  const [data, setData] = useState<TicketList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<'' | Ticket['status']>('');

  useEffect(() => {
    setData(null);
    const query = filtro ? `?status=${filtro}` : '';
    api
      .get<TicketList>(`/api/guilds/${guildId}/tickets${query}`)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [guildId, filtro]);

  if (error) return <ErrorBox message={error} />;

  const apri = (numero: number) => {
    // La trascrizione è una pagina HTML autonoma: si apre in una scheda invece
    // di scaricarsi, così si legge subito e si salva solo se serve.
    window.open(`/api/guilds/${guildId}/tickets/${numero}/transcript`, '_blank');
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Ticket e trascrizioni</h1>

      {data && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Aperti" value={data.open} tone={data.open > 0 ? 'warning' : 'neutral'} />
          <Stat label="Chiusi" value={data.closed} />
          <Stat
            label="Con trascrizione"
            value={data.tickets.filter((ticket) => ticket.hasTranscript).length}
          />
          <Stat
            label="Messaggi nei ticket"
            value={data.tickets
              .reduce((somma, ticket) => somma + ticket.messageCount, 0)
              .toLocaleString('it-IT')}
          />
        </div>
      )}

      <Card>
        <p className="text-sm leading-relaxed text-neutral-300">
          Alla chiusura di un ticket ANGEL salva una trascrizione completa —
          messaggi, allegati, link, chi è stato invitato nel canale, chi lo ha preso in carico, chi
          lo ha chiuso e con quale motivazione. Una copia va nel canale{' '}
          <code>angel-trascrizioni</code>, l'originale resta qui sul server.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          Vale anche quando il canale del ticket viene <strong>eliminato</strong> invece che chiuso:
          la trascrizione si costruisce dall'archivio dei messaggi, non dal canale, e quindi
          sopravvive alla sua sparizione.
        </p>
      </Card>

      <Card
        title="Elenco"
        subtitle="Dal più recente. La trascrizione si apre in una nuova scheda."
        action={
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm"
            value={filtro}
            onChange={(event) => setFiltro(event.target.value as '' | Ticket['status'])}
          >
            <option value="">Tutti</option>
            <option value="OPEN">Aperti</option>
            <option value="ARCHIVED">Archiviati</option>
            <option value="CLOSED">Chiusi</option>
          </select>
        }
      >
        {!data ? (
          <Loading />
        ) : data.tickets.length === 0 ? (
          <Empty>Nessun ticket.</Empty>
        ) : (
          <div className="space-y-2">
            {data.tickets.map((ticket) => (
              <div
                key={ticket.number}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-neutral-400">
                    #{String(ticket.number).padStart(4, '0')}
                  </span>
                  <span className="text-sm font-medium">{ticket.subject}</span>
                  <Badge tone={STATI[ticket.status].tone}>{STATI[ticket.status].label}</Badge>
                  {ticket.status === 'OPEN' && ticket.claimedBy && (
                    <Badge tone="warning">Preso in carico</Badge>
                  )}
                  <span className="ml-auto text-xs text-neutral-500">
                    {formatDate(ticket.createdAt)}
                  </span>
                  <Button onClick={() => apri(ticket.number)}>Trascrizione</Button>
                </div>

                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-400">
                  <span>Aperto da &lt;@{ticket.openerId}&gt;</span>
                  {ticket.claimedBy && <span>Preso in carico da &lt;@{ticket.claimedBy}&gt;</span>}
                  {ticket.closedBy && (
                    <span>
                      Chiuso da &lt;@{ticket.closedBy}&gt;
                      {ticket.closedAt ? ` il ${formatDate(ticket.closedAt)}` : ''}
                    </span>
                  )}
                  {ticket.messageCount > 0 && <span>{ticket.messageCount} messaggi</span>}
                  {!ticket.hasTranscript && ticket.status === 'CLOSED' && (
                    <span className="text-[var(--color-warning)]">
                      Nessun file salvato: verrà ricostruita dall'archivio
                    </span>
                  )}
                </div>

                {ticket.closeReason && (
                  <p className="mt-2 text-xs text-neutral-300">
                    <span className="text-neutral-500">Motivazione: </span>
                    {ticket.closeReason}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
