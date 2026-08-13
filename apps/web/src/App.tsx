import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { api, ApiError, type Me } from './api.js';
import { Layout } from './components/Layout.js';
import { Login } from './pages/Login.js';
import { Dashboard } from './pages/Dashboard.js';
import { Logs } from './pages/Logs.js';
import { Cases } from './pages/Cases.js';
import { Security } from './pages/Security.js';
import { Backups } from './pages/Backups.js';
import { Builder } from './pages/Builder.js';
import { Settings } from './pages/Settings.js';
import { Integrations } from './pages/Integrations.js';
import { Archive } from './pages/Archive.js';
import { Tickets } from './pages/Tickets.js';
import { Annunci } from './pages/Annunci.js';
import { User } from './pages/User.js';
import { Access } from './pages/Access.js';
import { Tools } from './pages/Tools.js';
import { Loading } from './components/ui.js';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [ridotto, setRidotto] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Me>('/api/auth/me')
      .then(setMe)
      .catch((error: unknown) => {
        // 401 non è un errore da mostrare: significa semplicemente che non si
        // è ancora fatto l'accesso.
        if (error instanceof ApiError && error.status === 503) {
          // Il server c'è ma il database no. Mostrarlo qui è tutto il punto:
          // senza, il pannello sembrerebbe rotto e non c'è modo di sapere
          // perché — che è esattamente la situazione da cui si vuole uscire.
          setRidotto(error.message);
          return;
        }
        if (!(error instanceof ApiError) || error.status !== 401) {
          console.error(error);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;
  if (ridotto) return <ModalitaRidotta messaggio={ridotto} />;
  if (!me) return <Login />;

  return (
    <Routes>
      <Route path="/" element={<GuildRedirect me={me} />} />
      <Route path="/g/:guildId" element={<Layout me={me} />}>
        <Route index element={<Dashboard />} />
        <Route path="log" element={<Logs />} />
        <Route path="utente/:userId" element={<User />} />
        <Route path="casi" element={<Cases />} />
        <Route path="sicurezza" element={<Security />} />
        <Route path="backup" element={<Backups />} />
        <Route path="archivio" element={<Archive />} />
        <Route path="ticket" element={<Tickets />} />
        <Route path="annunci" element={<Annunci />} />
        <Route path="integrazioni" element={<Integrations />} />
        <Route path="comandi" element={<Builder />} />
        <Route path="impostazioni" element={<Settings />} />
        <Route path="strumenti" element={<Tools />} />
        <Route path="accessi" element={<Access />} />
      </Route>
      <Route path="*" element={<GuildRedirect me={me} />} />
    </Routes>
  );
}

/**
 * Il pannello quando il database non risponde.
 *
 * Non è una pagina d'errore: è l'unica pagina utile in quel momento. Dice cosa
 * è successo, cosa fare, e che non serve riavviare niente — appena il database
 * torna, il pannello torna da solo.
 */
function ModalitaRidotta({ messaggio }: { messaggio: string }) {
  return (
    <div className="mx-auto max-w-xl p-10">
      <h1 className="text-xl font-semibold text-[var(--color-warning)]">
        Il database non risponde
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-neutral-300">{messaggio}</p>

      <div className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p className="text-sm font-medium text-neutral-200">Nove volte su dieci è il disco pieno.</p>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          Sulla macchina che ospita il bot:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-[var(--color-surface-2)] p-3 text-xs text-neutral-300">
{`df -h            # spazio
df -i            # inode: possono finire con spazio libero
docker system prune -af`}
        </pre>
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          Fatto spazio, non serve riavviare nulla: il pannello riprova da solo ogni trenta secondi.
        </p>
      </div>

      <button
        onClick={() => location.reload()}
        className="mt-4 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-neutral-300"
      >
        Ricontrolla adesso
      </button>
    </div>
  );
}

/** Porta al primo server disponibile, o spiega perché non ce ne sono. */
function GuildRedirect({ me }: { me: Me }) {
  const first = me.guilds[0];
  if (first) return <Navigate to={`/g/${first.id}`} replace />;

  return (
    <div className="mx-auto max-w-lg p-10 text-center">
      <h1 className="text-xl font-semibold">Nessun server disponibile</h1>
      <p className="mt-3 text-sm text-neutral-400">
        ANGEL non è presente in nessuno dei server che amministri.
      </p>
      {me.pendingInvite.length > 0 && (
        <div className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left">
          <p className="text-sm text-neutral-300">
            Puoi aggiungerlo a: {me.pendingInvite.map((guild) => guild.name).join(', ')}
          </p>
        </div>
      )}
    </div>
  );
}

/** Ricava l'ID del server dalla rotta corrente. */
export function useGuildId(): string {
  const { guildId } = useParams<{ guildId: string }>();
  if (!guildId) throw new Error('rotta senza guildId');
  return guildId;
}
