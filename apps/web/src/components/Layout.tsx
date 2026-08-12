import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, type Me, type VersionInfo } from '../api.js';
import { useGuildId } from '../App.js';

const NAV = [
  { to: '', label: 'Dashboard', end: true },
  { to: 'log', label: 'Registro eventi' },
  { to: 'casi', label: 'Provvedimenti' },
  { to: 'sicurezza', label: 'Sicurezza' },
  { to: 'backup', label: 'Backup' },
  { to: 'archivio', label: 'Archivio messaggi' },
  { to: 'ticket', label: 'Ticket e trascrizioni' },
  { to: 'annunci', label: 'Annunci' },
  { to: 'integrazioni', label: 'Integrazioni' },
  { to: 'comandi', label: 'Comandi e personas' },
  { to: 'strumenti', label: 'Strumenti' },
  { to: 'impostazioni', label: 'Configurazione' },
  { to: 'accessi', label: 'Accessi al pannello' },
];

export function Layout({ me }: { me: Me }) {
  const guildId = useGuildId();
  const navigate = useNavigate();
  const guild = me.guilds.find((entry) => entry.id === guildId);
  const version = useVersion();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--color-border)] p-4">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tracking-wide text-[var(--color-accent-soft)]">
              ANGEL
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-600">custode</span>
          </div>
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
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent-soft)]'
                    : 'text-neutral-300 hover:bg-[var(--color-surface-2)]'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-[var(--color-border)] p-3">
          {version && !version.aligned && (
            /*
             * Il disallineamento va detto prima dell'aggiornamento disponibile.
             * È il guasto che non assomiglia a un guasto: il pannello mostra la
             * versione nuova, un altro container gira ancora quella vecchia, e
             * la conclusione naturale è che la correzione non funzioni.
             */
            <div className="mb-2 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2 py-1.5 text-xs text-[#f2a3ad]">
              <span className="font-medium">Versioni non allineate</span>
              <span className="mt-1 block text-[11px] leading-relaxed text-neutral-400">
                {version.stale
                  .map(
                    (service) =>
                      `${service}: ${version.services[service as 'bot'] ?? 'non risponde'}`,
                  )
                  .join(' · ')}
                <br />
                Attesa {version.running}. Ricrea i container rimasti indietro.
              </span>
            </div>
          )}

          {version && (
            <div className="mb-2 text-xs">
              {version.updateAvailable ? (
                <a
                  href={version.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-2 py-1.5 text-[#ffd479] hover:bg-[var(--color-warning)]/20"
                >
                  Aggiornamento disponibile: {version.latest}
                  <span className="mt-0.5 block text-[11px] text-neutral-400">
                    in esecuzione {version.running}
                  </span>
                </a>
              ) : (
                <span className="text-neutral-500">versione {version.running}</span>
              )}
            </div>
          )}
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

/**
 * Versione in esecuzione e confronto con l'ultima release.
 *
 * L'errore viene ignorato di proposito: se GitHub non risponde o la sessione
 * scade proprio durante questa chiamata, il pannello non deve mostrare un
 * avviso per una informazione accessoria.
 */
function useVersion(): VersionInfo | null {
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    let attivo = true;
    void api
      .get<VersionInfo>('/api/version')
      .then((data) => {
        if (attivo) setVersion(data);
      })
      .catch(() => undefined);
    return () => {
      attivo = false;
    };
  }, []);

  return version;
}
