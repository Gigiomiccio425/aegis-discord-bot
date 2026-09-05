import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, type Me, type VersionInfo } from '../api.js';
import { useGuildId } from '../App.js';

/**
 * Ogni minuto: è la cadenza con cui i processi riaffermano la propria
 * versione in Redis, e chiedere più spesso non anticiperebbe nulla.
 */
const VERSION_REFRESH_MS = 60_000;

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
              <span className="font-medium">
                {version.stale.every((s) => version.services[s as 'bot'] === null)
                  ? 'Un processo non è in piedi'
                  : 'Versioni non allineate'}
              </span>
              <span className="mt-1 block text-[11px] leading-relaxed text-neutral-400">
                {version.stale
                  .map((service) => `${service}: ${version.services[service as 'bot'] ?? 'fermo'}`)
                  .join(' · ')}
                <br />
                {/*
                  * Il consiglio dipende da quale dei due guasti è: un processo
                  * fermo e un processo vecchio si somigliano solo qui dentro.
                  * Ricreare il container non serve a niente se il processo
                  * esce da solo a ogni avvio — e il rimedio sta nei log, dove
                  * c'è scritto perché.
                  */}
                {version.stale.some((s) => version.services[s as 'bot'] === null)
                  ? 'Riparte da solo ogni 30 secondi: se resta fermo, il motivo è nei log del container.'
                  : `Attesa ${version.running}. Ricrea i container rimasti indietro.`}
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
 * Si richiede a intervalli, e non una volta sola al montaggio come faceva
 * prima. Il pannello è la finestra da cui si guarda mentre si sistema
 * qualcosa sul server, e Layout è il guscio dell'applicazione: montato una
 * volta per caricamento, non si rimonta navigando fra le pagine. Il risultato
 * era un avviso congelato al momento in cui la scheda è stata aperta, che
 * continuava ad accusare un servizio già rimesso in piedi — e a mandare a
 * ricreare container sani.
 *
 * Il minuto è la cadenza con cui i processi riaffermano la propria versione,
 * quindi non c'è niente da guadagnare a chiedere più spesso. La chiamata è
 * economica: il confronto con GitHub dentro la rotta è in cache per sei ore.
 *
 * Il ritorno sulla scheda fa da secondo innesco, perché è lì che sta il caso
 * vero: si va a sistemare qualcosa altrove, si torna, e la risposta dev'essere
 * quella di adesso.
 *
 * L'errore viene ignorato di proposito: se GitHub non risponde o la sessione
 * scade proprio durante questa chiamata, il pannello non deve mostrare un
 * avviso per una informazione accessoria.
 */
function useVersion(): VersionInfo | null {
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    let attivo = true;

    const chiedi = (): void => {
      void api
        .get<VersionInfo>('/api/version')
        .then((data) => {
          if (attivo) setVersion(data);
        })
        .catch(() => undefined);
    };

    chiedi();
    const timer = setInterval(chiedi, VERSION_REFRESH_MS);

    const alRitorno = (): void => {
      if (document.visibilityState === 'visible') chiedi();
    };
    document.addEventListener('visibilitychange', alRitorno);

    return () => {
      attivo = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', alRitorno);
    };
  }, []);

  return version;
}
