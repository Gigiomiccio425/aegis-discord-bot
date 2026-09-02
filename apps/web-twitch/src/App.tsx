import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, type Io } from './api.js';
import { Bottone, Caricamento, Errore, Riquadro } from './componenti/ui.js';
import { Canale } from './pagine/Canale.js';

/* ═══════════════════════════════════════════════════════════════════════
   Il guscio.

   Tre stati e basta: sto caricando, non sei entrato, ecco il tuo canale. Chi
   arriva qui non ha bisogno di una navigazione: ha un canale, o al massimo
   due se modera per qualcun altro.
   ═══════════════════════════════════════════════════════════════════════ */

export function App() {
  const [io, setIo] = useState<Io | null>(null);
  const [errore, setErrore] = useState<string | null>(null);

  const carica = () => {
    api
      .get<Io>('/api/io')
      .then(setIo)
      .catch((err: Error) => setErrore(err.message));
  };

  useEffect(carica, []);

  if (errore) {
    return (
      <Contenitore>
        <Errore messaggio={errore} />
      </Contenitore>
    );
  }
  if (!io) {
    return (
      <Contenitore>
        <Caricamento />
      </Contenitore>
    );
  }
  if (!io.autenticato) return <Accesso />;

  return (
    <Contenitore>
      <Intestazione io={io} />
      <Routes>
        <Route path="/" element={<Scelta io={io} />} />
        <Route path="/c/:canaleId" element={<PaginaCanale io={io} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Contenitore>
  );
}

function Contenitore({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12">{children}</div>;
}

/* ── Accesso ──────────────────────────────────────────────────────────── */

/**
 * La pagina che vedono gli sconosciuti.
 *
 * È l'unica pagina pubblica del progetto, e vale la pena che dica cosa fa il
 * bot prima di chiedere di autorizzarlo: la schermata di Twitch elenca
 * permessi come «bandire utenti», e chi ci arriva senza sapere perché la
 * chiude. Le tre righe qui sotto sono quelle che decidono se il bot verrà
 * usato o no.
 */
function Accesso() {
  const parametri = new URLSearchParams(window.location.search);
  const problema = parametri.get('errore');

  const messaggi: Record<string, string> = {
    'autorizzazione-negata': 'Hai annullato su Twitch. Nessun problema: puoi riprovare quando vuoi.',
    'stato-non-valido':
      'La sessione di accesso è scaduta mentre eri sulla pagina di Twitch. Riprova.',
    'scambio-fallito': 'Twitch non ha accettato l’autorizzazione. Riprova fra qualche minuto.',
    'utente-sconosciuto': 'Non sono riuscito a leggere il tuo profilo Twitch. Riprova.',
  };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-6 py-16">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--color-accento)]/15 text-3xl">
          ☁︎
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">ANGEL per Twitch</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-fioco)]">
          Tiene pulita la chat mentre trasmetti: bot che vendono visualizzatori, link truffa,
          ondate di account creati apposta. E fa quello che fa un bot di chat — messaggi a tempo,
          comandi, saluti.
        </p>
      </div>

      {problema && <Errore messaggio={messaggi[problema] ?? 'Qualcosa è andato storto.'} />}

      <a
        href="/api/auth/entra"
        className="block rounded-xl bg-[var(--color-accento)] px-6 py-4 text-center font-medium text-[#160f24] transition-colors hover:bg-[var(--color-accento-forte)]"
      >
        Entra con Twitch
      </a>

      <div className="mt-8 space-y-3 text-xs leading-relaxed text-[var(--color-fioco)]">
        <p>
          <strong className="text-[var(--color-testo)]">Cosa chiede e perché.</strong> Leggere la
          chat per poterla moderare, scrivere per rispondere ai comandi, cancellare e silenziare
          per fare il proprio lavoro. Niente che riguardi il tuo account, i tuoi guadagni o le tue
          impostazioni.
        </p>
        <p>
          <strong className="text-[var(--color-testo)]">Cosa conserva.</strong> Chi è stato
          sanzionato, quando e perché. Il testo dei soli messaggi rimossi, per trenta giorni, così
          si può verificare se la decisione era giusta. Nient'altro — e chi scrive in chat può
          farsi cancellare con <code>!angel dimenticami</code>.
        </p>
        <p>
          Si stacca in qualsiasi momento da questo pannello, e l'autorizzazione viene revocata
          anche dal lato di Twitch.
        </p>
      </div>
    </div>
  );
}

/* ── Intestazione ─────────────────────────────────────────────────────── */

function Intestazione({ io }: { io: Io }) {
  const naviga = useNavigate();

  return (
    <header className="mb-8 flex items-center justify-between gap-4">
      <button
        type="button"
        onClick={() => naviga('/')}
        className="flex items-center gap-2 text-sm font-medium tracking-tight"
      >
        <span className="text-lg">☁︎</span> ANGEL
      </button>

      <div className="flex items-center gap-3">
        {io.utente?.avatar && (
          <img
            src={io.utente.avatar}
            alt=""
            className="h-8 w-8 rounded-full border border-[var(--color-bordo)]"
          />
        )}
        <span className="hidden text-sm text-[var(--color-fioco)] sm:inline">
          {io.utente?.nome}
        </span>
        <Bottone
          variante="fantasma"
          onClick={() => void api.post('/api/auth/esci').then(() => window.location.reload())}
        >
          Esci
        </Bottone>
      </div>
    </header>
  );
}

/* ── Scelta del canale ────────────────────────────────────────────────── */

/**
 * Chi ha un canale solo non deve scegliere niente.
 *
 * Un elenco con dentro una voce è un passaggio in più che non informa: si va
 * dritti al canale. La schermata di scelta compare solo a chi modera davvero
 * per più di una persona.
 */
function Scelta({ io }: { io: Io }) {
  const naviga = useNavigate();
  const primo = io.canali[0];

  useEffect(() => {
    if (io.canali.length === 1 && primo) naviga(`/c/${primo.id}`, { replace: true });
  }, [io.canali.length, primo, naviga]);

  if (io.canali.length === 0) {
    return (
      <Riquadro
        titolo="Nessun canale collegato"
        sottotitolo="Hai fatto l’accesso ma il bot non è ancora entrato nella tua chat."
      >
        <a
          href="/api/auth/entra"
          className="inline-block rounded-lg bg-[var(--color-accento)] px-4 py-2 text-sm font-medium text-[#160f24]"
        >
          Collega il mio canale
        </a>
      </Riquadro>
    );
  }

  return (
    <Riquadro titolo="I tuoi canali">
      <ul className="space-y-2">
        {io.canali.map((canale) => (
          <li key={canale.id}>
            <button
              type="button"
              onClick={() => naviga(`/c/${canale.id}`)}
              className="flex w-full items-center gap-3 rounded-lg border border-[var(--color-bordo)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-superficie-2)]"
            >
              {canale.avatarUrl && (
                <img src={canale.avatarUrl} alt="" className="h-9 w-9 rounded-full" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{canale.displayName ?? canale.login}</span>
                <span className="block text-xs text-[var(--color-fioco)]">
                  {canale.ruolo.toLowerCase()}
                </span>
              </span>
              {canale.daRiautorizzare && (
                <span className="text-xs text-[var(--color-attenzione)]">da riautorizzare</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </Riquadro>
  );
}

function PaginaCanale({ io }: { io: Io }) {
  const { canaleId } = useParams();
  if (!canaleId) return <Navigate to="/" replace />;
  return <Canale canaleId={canaleId} livelli={io.livelli ?? {}} />;
}
