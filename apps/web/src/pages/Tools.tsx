import { useEffect, useState } from 'react';
import { COMMAND_DOCS, type CommandDoc } from '@angel/shared/docs';
import { api } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, Empty, ErrorBox, formatDate } from '../components/ui.js';

/* ═══════════════════════════════════════════════════════════════════════
   STRUMENTI

   Tre cose che si fanno a mano e che prima richiedevano di aprire Discord,
   ricordarsi il comando giusto e sperare di non sbagliare un argomento:
   far parlare il bot, sorvegliare qualcuno, sapere cosa il bot sa fare.
   ═══════════════════════════════════════════════════════════════════════ */

export function Tools() {
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Strumenti</h1>
      <SayAsBot />
      <WatchedUsers />
      <CommandReference />
    </div>
  );
}

/* ── Voce del bot ─────────────────────────────────────────────────────── */

function SayAsBot() {
  const guildId = useGuildId();
  const [channelId, setChannelId] = useState('');
  const [text, setText] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [embed, setEmbed] = useState(false);
  const [title, setTitle] = useState('');
  const [editMessageId, setEditMessageId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await api.post(`/api/guilds/${guildId}/say`, {
        channelId: channelId.trim(),
        text,
        imageUrl: imageUrl.trim() || null,
        embed,
        title: title.trim() || null,
        editMessageId: editMessageId.trim() || null,
      });
      setDone(true);
      setText('');
      setImageUrl('');
      setTitle('');
      setEditMessageId('');
      setTimeout(() => setDone(false), 4000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Card
      title="Scrivi come il bot"
      subtitle="Annunci e avvisi senza il nome di una persona sopra. Un annuncio firmato da un moderatore diventa il suo annuncio, e chi non è d'accordo scrive a lui."
    >
      {error && <ErrorBox message={error} />}
      {done && (
        <div className="mb-3 rounded-lg border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-sm text-[#8fe0b4]">
          Inviato al bot. Compare nel canale entro un istante.
        </div>
      )}

      <div className="space-y-3">
        <Field label="ID del canale" help="Tasto destro sul canale in Discord → Copia ID.">
          <input
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
            placeholder="123456789012345678"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
          />
        </Field>

        <Field label="Testo">
          <textarea
            value={text}
            rows={4}
            onChange={(event) => setText(event.target.value)}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
          />
        </Field>

        <Field
          label="Immagine o GIF"
          help="Indirizzo https che finisce con .png, .jpg, .gif, .webp. Solo immagini: un file pubblicato dal bot sembra venire dallo staff."
        >
          <input
            value={imageUrl}
            onChange={(event) => setImageUrl(event.target.value)}
            placeholder="https://…/immagine.gif"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
          />
        </Field>

        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={embed}
            onChange={(event) => setEmbed(event.target.checked)}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          <span className="text-neutral-200">Riquadro colorato</span>
        </label>

        {embed && (
          <Field label="Titolo del riquadro">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
            />
          </Field>
        )}

        <Field
          label="Riscrivi un messaggio esistente"
          help="ID di un messaggio già pubblicato dal bot. Vuoto = ne pubblica uno nuovo."
        >
          <input
            value={editMessageId}
            onChange={(event) => setEditMessageId(event.target.value)}
            placeholder="vuoto = nuovo messaggio"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
          />
        </Field>

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={sending || !channelId.trim() || (!text.trim() && !imageUrl.trim())}
            onClick={() => void send()}
          >
            {sending ? 'Invio…' : editMessageId ? 'Riscrivi' : 'Pubblica'}
          </Button>
          <span className="text-xs text-neutral-500">
            Nessuna menzione di massa parte da qui, e l&apos;invio resta tracciato nel registro con
            il tuo nome.
          </span>
        </div>
      </div>
    </Card>
  );
}

/* ── Utenti attenzionati ──────────────────────────────────────────────── */

interface WatchedUser {
  userId: string;
  username: string | null;
  displayName: string | null;
  riskScore: number;
  watchedAt: string;
  watchedBy: string | null;
  watchReason: string | null;
  watchExpiresAt: string | null;
}

function WatchedUsers() {
  const guildId = useGuildId();
  const [users, setUsers] = useState<WatchedUser[] | null>(null);
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api
      .get<WatchedUser[]>(`/api/guilds/${guildId}/users/watched`)
      .then(setUsers)
      .catch((err: Error) => setError(err.message));
  };

  useEffect(load, [guildId]);

  const add = async () => {
    setError(null);
    try {
      await api.post(`/api/guilds/${guildId}/users/${userId.trim()}/watch`, { reason, hours });
      setUserId('');
      setReason('');
      // Il bot riceve il comando via Redis e scrive nel database: un istante
      // dopo. Ricaricare subito mostrerebbe l'elenco di prima.
      setTimeout(load, 800);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (target: string) => {
    await api.delete(`/api/guilds/${guildId}/users/${target}/watch`).catch(() => undefined);
    setTimeout(load, 800);
  };

  return (
    <Card
      title="Utenti attenzionati"
      subtitle="Sorveglianza senza sanzione: ogni azione di questa persona finisce in evidenza nel registro e nel canale degli avvisi. Non se ne accorge e non perde nulla."
    >
      {error && <ErrorBox message={error} />}

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_2fr_auto_auto]">
        <input
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          placeholder="ID utente"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
        />
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Perché lo stai sorvegliando"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
        />
        <input
          type="number"
          value={hours}
          min={0}
          onChange={(event) => setHours(Number(event.target.value))}
          title="Ore. 0 = finché non lo togli"
          className="w-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
        />
        <Button disabled={!userId.trim() || !reason.trim()} onClick={() => void add()}>
          Sorveglia
        </Button>
      </div>

      {!users || users.length === 0 ? (
        <Empty>Nessuno sotto sorveglianza.</Empty>
      ) : (
        <ul className="space-y-2 text-sm">
          {users.map((user) => (
            <li
              key={user.userId}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)]/50 pb-2 last:border-0"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-neutral-200">
                    {user.displayName ?? user.username ?? user.userId}
                  </span>
                  {user.riskScore >= 40 && <Badge tone="warning">rischio {user.riskScore}</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {user.watchReason ?? 'senza motivo indicato'} · dal{' '}
                  {formatDate(user.watchedAt)}
                  {user.watchExpiresAt && ` · fino al ${formatDate(user.watchExpiresAt)}`}
                </div>
              </div>
              <Button onClick={() => void remove(user.userId)}>Togli</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ── Comandi ──────────────────────────────────────────────────────────── */

const GROUPS: CommandDoc['group'][] = [
  'Moderazione',
  'Sicurezza',
  'Registro e dati',
  'Comunità',
  'Utilità',
];

/**
 * Elenco dei comandi.
 *
 * Sta nel pannello e non solo su Discord perché la domanda «cosa sa fare
 * questo bot» arriva prima di aprire Discord, e la risposta non deve
 * richiedere di scorrere un menu a tentoni.
 */
function CommandReference() {
  const [group, setGroup] = useState<CommandDoc['group']>('Moderazione');
  const commands = COMMAND_DOCS.filter((command) => command.group === group);

  return (
    <Card
      title="Comandi"
      subtitle="Cosa il bot sa fare, chi può usarlo e cosa conviene sapere prima."
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {GROUPS.map((name) => (
          <button
            key={name}
            onClick={() => setGroup(name)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              group === name
                ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent-soft)]'
                : 'text-neutral-400 hover:bg-[var(--color-surface-2)]'
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      <ul className="space-y-3">
        {commands.map((command) => (
          <li
            key={command.name}
            className="border-b border-[var(--color-border)]/50 pb-3 last:border-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-[var(--color-surface-2)] px-2 py-0.5 text-sm text-[var(--color-accent-soft)]">
                {command.name}
              </code>
              <Badge tone="neutral">{command.permission}</Badge>
            </div>
            <p className="mt-1 text-sm text-neutral-300">{command.summary}</p>
            {command.example && (
              <p className="mt-1 font-mono text-xs text-neutral-500">{command.example}</p>
            )}
            {command.caution && (
              <p className="mt-1 text-xs text-[#ffd479]">⚠ {command.caution}</p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-neutral-300">{label}</span>
      {children}
      {help && <span className="mt-0.5 block text-xs text-neutral-500">{help}</span>}
    </label>
  );
}
