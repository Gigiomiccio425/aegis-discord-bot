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

  useEffect(() => {
    api
      .get<Me>('/api/auth/me')
      .then(setMe)
      .catch((error: unknown) => {
        // 401 non è un errore da mostrare: significa semplicemente che non si
        // è ancora fatto l'accesso.
        if (!(error instanceof ApiError) || error.status !== 401) {
          console.error(error);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading />;
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
