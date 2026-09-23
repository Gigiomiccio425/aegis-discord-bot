import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpCircle,
  ChevronRight,
  LogOut,
  Menu,
  Palette,
  Search,
  X,
} from 'lucide-react';
import { api, type Me, type VersionInfo } from '../api.js';
import { useGuildId } from '../App.js';
import { NAVIGAZIONE, doveSiamo } from '../navigazione.js';
import { useTema } from '../tema.js';
import { Ricerca } from './Ricerca.js';
import { SceltaTema } from './SceltaTema.js';

/**
 * Ogni minuto: è la cadenza con cui i processi riaffermano la propria
 * versione in Redis, e chiedere più spesso non anticiperebbe nulla.
 */
const VERSION_REFRESH_MS = 60_000;

/** Sul Mac la scorciatoia si scrive ⌘K, altrove Ctrl K. */
const SUL_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Il tasto «/» apre la ricerca, ma non mentre si scrive in un campo. */
function staScrivendo(bersaglio: EventTarget | null): boolean {
  if (!(bersaglio instanceof HTMLElement)) return false;
  return (
    bersaglio.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(bersaglio.tagName)
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   IL GUSCIO DEL PANNELLO

   A sinistra le pagine, divise per quello che servono a fare. In alto dove
   ci si trova, la ricerca e il tema. Sul telefono la barra laterale diventa
   un menu che si apre dal pulsante in alto: il pannello si apre anche da lì,
   di corsa, quando arriva una notifica di raid.
   ═══════════════════════════════════════════════════════════════════════ */

export function Layout({ me }: { me: Me }) {
  const guildId = useGuildId();
  const { pathname } = useLocation();
  const version = useVersion();
  const { tema } = useTema();
  const [menuAperto, setMenuAperto] = useState(false);
  const [ricercaAperta, setRicercaAperta] = useState(false);
  const [temiAperti, setTemiAperti] = useState(false);
  const qui = doveSiamo(pathname);
  const guild = me.guilds.find((entry) => entry.id === guildId);

  // Cambiata pagina, il menu del telefono si richiude da solo: restare
  // aperto sopra la pagina appena scelta la nasconderebbe.
  const [paginaDelMenu, setPaginaDelMenu] = useState(pathname);
  if (paginaDelMenu !== pathname) {
    setPaginaDelMenu(pathname);
    setMenuAperto(false);
  }

  // Il nome della pagina nella scheda del browser: con tre schede del
  // pannello aperte, «ANGEL» tre volte non aiuta a sceglierne una.
  useEffect(() => {
    const titolo = qui?.voce.label ?? (pathname.includes('/utente/') ? 'Scheda utente' : null);
    document.title = titolo ? `${titolo} · ANGEL` : 'ANGEL';
  }, [qui, pathname]);

  useEffect(() => {
    const tasto = (evento: KeyboardEvent) => {
      if ((evento.ctrlKey || evento.metaKey) && evento.key.toLowerCase() === 'k') {
        evento.preventDefault();
        setRicercaAperta((aperta) => !aperta);
        return;
      }
      if (evento.key === '/' && !evento.ctrlKey && !evento.metaKey && !staScrivendo(evento.target)) {
        evento.preventDefault();
        setRicercaAperta(true);
      }
    };
    window.addEventListener('keydown', tasto);
    return () => window.removeEventListener('keydown', tasto);
  }, []);

  const chiudiRicerca = useCallback(() => setRicercaAperta(false), []);
  const chiudiTemi = useCallback(() => setTemiAperti(false), []);

  return (
    <div className="min-h-screen lg:flex">
      {/* Barra laterale, sempre visibile sugli schermi larghi. */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] lg:block">
        <BarraLaterale me={me} guildId={guildId} version={version} />
      </aside>

      {/* La stessa, come menu a scomparsa sul telefono. */}
      {menuAperto && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div aria-hidden className="absolute inset-0 bg-black/55" onClick={() => setMenuAperto(false)} />
          <aside
            aria-label="Menu"
            className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
          >
            <button
              type="button"
              onClick={() => setMenuAperto(false)}
              aria-label="Chiudi il menu"
              className="absolute right-3 top-3 z-10 rounded-lg p-1.5 text-neutral-400 hover:bg-[var(--color-surface-2)]"
            >
              <X size={18} />
            </button>
            <BarraLaterale me={me} guildId={guildId} version={version} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-base)]/85 px-3 backdrop-blur sm:gap-3 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setMenuAperto(true)}
            aria-label="Apri il menu"
            className="rounded-lg p-2 text-neutral-300 hover:bg-[var(--color-surface-2)] lg:hidden"
          >
            <Menu size={20} />
          </button>

          <nav aria-label="Percorso" className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="hidden max-w-[12rem] truncate text-neutral-500 md:inline">{guild?.name}</span>
            <ChevronRight aria-hidden size={14} className="hidden shrink-0 text-neutral-600 md:inline" />
            {qui ? (
              <>
                <span className="hidden text-neutral-500 sm:inline">{qui.gruppo.titolo}</span>
                <ChevronRight aria-hidden size={14} className="hidden shrink-0 text-neutral-600 sm:inline" />
                <span aria-current="page" className="truncate font-medium text-neutral-100">
                  {qui.voce.label}
                </span>
              </>
            ) : (
              <span aria-current="page" className="truncate font-medium text-neutral-100">
                Scheda utente
              </span>
            )}
          </nav>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => setRicercaAperta(true)}
            aria-label="Cerca nel pannello"
            aria-keyshortcuts={SUL_MAC ? 'Meta+K' : 'Control+K'}
            className="flex h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-neutral-500 transition-colors hover:border-neutral-500 hover:text-neutral-300 sm:w-64 sm:px-3"
          >
            <Search aria-hidden size={16} className="shrink-0" />
            <span className="hidden flex-1 text-left sm:inline">Cerca impostazioni…</span>
            <kbd className="hidden rounded border border-[var(--color-border)] px-1.5 text-[11px] font-sans text-neutral-500 md:inline">
              {SUL_MAC ? '⌘K' : 'Ctrl K'}
            </kbd>
          </button>

          <button
            type="button"
            onClick={() => setTemiAperti(true)}
            aria-label={`Tema: ${tema.nome}. Cambia tema`}
            title={`Tema: ${tema.nome}`}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-neutral-400 transition-colors hover:border-neutral-500 hover:text-[var(--color-accent-soft)]"
          >
            <Palette aria-hidden size={17} />
          </button>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>

      {ricercaAperta && <Ricerca guildId={guildId} onChiudi={chiudiRicerca} />}
      {temiAperti && <SceltaTema onChiudi={chiudiTemi} />}
    </div>
  );
}

function BarraLaterale({
  me,
  guildId,
  version,
}: {
  me: Me;
  guildId: string;
  version: VersionInfo | null;
}) {
  const navigate = useNavigate();
  const guild = me.guilds.find((entry) => entry.id === guildId);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-[var(--color-border)] p-4">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-wide text-[var(--color-accent-soft)]">ANGEL</span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">custode</span>
        </div>
        <label className="mt-3 block">
          <span className="sr-only">Server</span>
          <select
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm"
            value={guildId}
            onChange={(event) => navigate(`/g/${event.target.value}`)}
          >
            {me.guilds.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        {guild && (
          <div className="mt-2 text-xs text-neutral-500">
            {guild.memberCount.toLocaleString('it-IT')} membri · ruolo {guild.role}
          </div>
        )}
      </div>

      <nav aria-label="Pagine del pannello" className="flex-1 space-y-5 px-3 py-4">
        {NAVIGAZIONE.map((gruppo) => (
          <div key={gruppo.titolo}>
            <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
              {gruppo.titolo}
            </div>
            <ul className="space-y-0.5">
              {gruppo.voci.map((voce) => {
                const Icona = voce.icona;
                return (
                  <li key={voce.to}>
                    <NavLink
                      to={voce.to}
                      end={voce.end}
                      className={({ isActive }) =>
                        `relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                          isActive
                            ? 'bg-[var(--color-accent)]/12 font-medium text-[var(--color-accent-soft)] before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-[var(--color-accent)]'
                            : 'text-neutral-300 hover:bg-[var(--color-surface-2)] hover:text-neutral-100'
                        }`
                      }
                    >
                      <Icona aria-hidden size={17} strokeWidth={1.8} className="shrink-0" />
                      <span className="truncate">{voce.label}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
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
          <div className="mb-2 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2.5 py-2 text-xs text-[var(--color-danger-text)]">
            <span className="flex items-center gap-1.5 font-medium">
              <AlertTriangle aria-hidden size={14} className="shrink-0" />
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
                className="flex items-start gap-1.5 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-2.5 py-2 text-[var(--color-warning-text)] hover:bg-[var(--color-warning)]/20"
              >
                <ArrowUpCircle aria-hidden size={14} className="mt-px shrink-0" />
                <span>
                  Aggiornamento disponibile: {version.latest}
                  <span className="mt-0.5 block text-[11px] text-neutral-400">
                    in esecuzione {version.running}
                  </span>
                </span>
              </a>
            ) : (
              <span className="px-1 text-neutral-500">versione {version.running}</span>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-neutral-400">{me.user.tag}</span>
          <button
            type="button"
            onClick={() => {
              void api.post('/api/auth/logout').then(() => location.reload());
            }}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-[var(--color-surface-2)]"
          >
            <LogOut aria-hidden size={13} />
            Esci
          </button>
        </div>
      </div>
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
