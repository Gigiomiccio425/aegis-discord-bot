import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, type Me } from '../api.js';
import { useGuildId } from '../App.js';

const NAV = [
  { to: '', label: 'Dashboard', end: true },
  { to: 'log', label: 'Registro eventi' },
  { to: 'casi', label: 'Provvedimenti' },
  { to: 'sicurezza', label: 'Sicurezza' },
  { to: 'backup', label: 'Backup' },
  { to: 'archivio', label: 'Archivio messaggi' },
  { to: 'integrazioni', label: 'Integrazioni' },
  { to: 'comandi', label: 'Comandi e personas' },
  { to: 'impostazioni', label: 'Configurazione' },
  { to: 'accessi', label: 'Accessi al pannello' },
];

export function Layout({ me }: { me: Me }) {
  const guildId = useGuildId();
  const navigate = useNavigate();
  const guild = me.guilds.find((entry) => entry.id === guildId);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--color-border)] p-4">
          <div className="text-lg font-semibold">Aegis</div>
          <select
            className="mt-3 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm"
            value={guildId}
            onChange={(event) => navigate(`/g/${event.target.value}`)}
          >
            {me.guilds.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          {guild && (
            <div className="mt-2 text-xs text-neutral-500">
              {guild.memberCount.toLocaleString('it-IT')} membri · ruolo {guild.role}
            </div>
          )}
        </div>

        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-[var(--color-accent)]/15 text-[#a5adff]'
                    : 'text-neutral-300 hover:bg-[var(--color-surface-2)]'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-[var(--color-border)] p-3">
          <div className="mb-2 truncate text-xs text-neutral-400">{me.user.tag}</div>
          <button
            onClick={() => {
              void api.post('/api/auth/logout').then(() => location.reload());
            }}
            className="w-full rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-neutral-300 hover:bg-[var(--color-surface-2)]"
          >
            Esci
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-x-hidden p-6">
        <Outlet />
      </main>
    </div>
  );
}
