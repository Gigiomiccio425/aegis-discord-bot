import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuildId } from '../App.js';
import { Badge, Button, Card, Empty, ErrorBox, Loading, formatDate } from '../components/ui.js';

interface Snapshot {
  id: string;
  kind: string;
  createdAt: string;
  createdBy: string | null;
  sizeBytes: number;
  restoredAt: string | null;
}

interface Diff {
  missingRoles: { name: string }[];
  missingChannels: { name: string }[];
  addedSince: { roles: { name: string }[]; channels: { name: string }[] };
  note: string;
}

export function Backups() {
  const guildId = useGuildId();
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [diff, setDiff] = useState<{ id: string; data: Diff } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .get<Snapshot[]>(`/api/guilds/${guildId}/backups`)
      .then(setSnapshots)
      .catch((err: Error) => setError(err.message));
  };

  useEffect(load, [guildId]);

  const createBackup = async () => {
    setBusy(true);
    try {
      await api.post(`/api/guilds/${guildId}/backups`);
      // Il bot esegue lo snapshot in modo asincrono: si attende qualche istante
      // prima di rileggere l'elenco.
      setTimeout(load, 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorBox message={error} />;
  if (!snapshots) return <Loading />;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Backup</h1>
        <Button variant="primary" disabled={busy} onClick={() => void createBackup()}>
          Crea backup ora
        </Button>
      </div>

      <Card>
        <p className="text-sm leading-relaxed text-neutral-300">
          Un backup conserva ruoli con i loro permessi, canali con gli overwrite, categorie, emoji,
          sticker, impostazioni del server, regole AutoMod e l'elenco dei ruoli di ogni membro.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-warning)]">
          Discord non consente di ripristinare la cronologia dei messaggi. Dopo un nuke tornano
          struttura e permessi; i messaggi restano consultabili solo nel registro di ANGEL, come
          archivio, e non tornano nei canali.
        </p>
      </Card>

      <Card subtitle="Ultimi 50 backup. Quelli d'emergenza vengono conservati più a lungo degli altri.">
        {snapshots.length === 0 ? (
          <Empty>Nessun backup presente.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {snapshots.map((snapshot) => (
              <li
                key={snapshot.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)]/50 pb-2"
              >
                <div className="flex items-center gap-3">
                  <Badge
                    tone={
                      snapshot.kind === 'EMERGENCY'
                        ? 'danger'
                        : snapshot.kind === 'MANUAL'
                          ? 'accent'
                          : 'neutral'
                    }
                  >
                    {snapshot.kind}
                  </Badge>
                  <span className="text-neutral-300">{formatDate(snapshot.createdAt)}</span>
                  <span className="text-xs text-neutral-500">
                    {Math.round(snapshot.sizeBytes / 1024)} KB
                  </span>
                  {snapshot.restoredAt && (
                    <span className="text-xs text-[var(--color-success)]">
                      ripristinato il {formatDate(snapshot.restoredAt)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-neutral-600">{snapshot.id.slice(0, 8)}</code>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void api
                        .get<Diff>(`/api/guilds/${guildId}/backups/${snapshot.id}/diff`)
                        .then((data) => setDiff({ id: snapshot.id, data }))
                        .catch((err: Error) => setError(err.message))
                    }
                  >
                    Anteprima
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CopieInstallazione />

      {diff && (
        <Card
          title="Anteprima del ripristino"
          subtitle="Cosa verrebbe ricreato rispetto allo stato attuale"
          action={
            <Button variant="ghost" onClick={() => setDiff(null)}>
              Chiudi
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-medium text-neutral-200">Ruoli da ricreare</h3>
              {diff.data.missingRoles.length === 0 ? (
                <p className="text-sm text-neutral-500">Nessuno: i ruoli ci sono tutti.</p>
              ) : (
                <ul className="space-y-1 text-sm text-neutral-300">
                  {diff.data.missingRoles.map((role) => (
                    <li key={role.name}>• {role.name}</li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium text-neutral-200">Canali da ricreare</h3>
              {diff.data.missingChannels.length === 0 ? (
                <p className="text-sm text-neutral-500">Nessuno: i canali ci sono tutti.</p>
              ) : (
                <ul className="space-y-1 text-sm text-neutral-300">
                  {diff.data.missingChannels.map((channel) => (
                    <li key={channel.name}>• {channel.name}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <p className="mt-4 text-xs text-neutral-500">{diff.data.note}</p>
          <p className="mt-3 text-xs text-neutral-400">
            Il ripristino vero e proprio si esegue dal server con{' '}
            <code className="rounded bg-[var(--color-surface-2)] px-1">
              /backup ripristina id:{diff.id.slice(0, 8)}…
            </code>
            . È volutamente un comando e non un pulsante: è un'operazione che modifica la struttura
            del server e va lanciata da chi ha i permessi di amministratore su Discord.
          </p>
        </Card>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   COPIE DELL'INTERA INSTALLAZIONE

   Un'altra cosa rispetto agli snapshot qui sopra, e vale la pena dirlo nel
   pannello e non solo nel codice: lo snapshot salva la *forma* di un server
   Discord — ruoli, canali, permessi. Questa salva ANGEL: database,
   configurazione, registro, archivio, trascrizioni, per tutti i server.

   Il pulsante che conta è «Scarica». Una copia che sta solo sul server di cui
   è la copia protegge da un volume cancellato per sbaglio e da nient'altro.
   ═══════════════════════════════════════════════════════════════════════ */

interface Copia {
  nome: string;
  quando: string | null;
  versione: string | null;
  righe: number;
  tabelle: number;
  archivio: { incluso: boolean; file: number; byte: number; motivo?: string };
  byte: number;
  ripristinata: boolean;
  parti: string[];
  errori: string[];
}

interface ElencoCopie {
  cartella: string;
  montata: boolean;
  copie: Copia[];
  avviso?: string;
}

function peso(byte: number): string {
  if (byte >= 1024 * 1024 * 1024) return `${(byte / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (byte >= 1024 * 1024) return `${Math.round(byte / 1024 / 1024)} MB`;
  return `${Math.round(byte / 1024)} KB`;
}

function CopieInstallazione() {
  const [elenco, setElenco] = useState<ElencoCopie | null>(null);
  // 403 significa «non sei il proprietario del bot»: la sezione sparisce
  // invece di mostrare un errore. Non è un guasto, è che non la riguarda.
  const [nascosta, setNascosta] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [occupato, setOccupato] = useState(false);

  const carica = () => {
    api
      .get<ElencoCopie>('/api/copie')
      .then(setElenco)
      .catch((err: Error & { status?: number }) => {
        if (err.status === 403) setNascosta(true);
        else setErrore(err.message);
      });
  };

  useEffect(carica, []);

  const creaOra = async () => {
    setOccupato(true);
    setErrore(null);
    try {
      await api.post('/api/copie');
      // L'esportazione la fa il worker e può durare minuti su un archivio
      // grande: si rilegge dopo un po', e chi ha fretta ricarica la pagina.
      setTimeout(carica, 10_000);
    } catch (err) {
      setErrore((err as Error).message);
    } finally {
      setOccupato(false);
    }
  };

  if (nascosta) return null;

  return (
    <Card
      title="Copia completa dell'installazione"
      subtitle="Database, configurazione, registro, archivio e trascrizioni di tutti i server. Prodotta ogni notte alle 4:15."
      action={
        <Button variant="primary" disabled={occupato} onClick={() => void creaOra()}>
          Crea copia ora
        </Button>
      }
    >
      {errore && <ErrorBox message={errore} />}

      {elenco && !elenco.montata && (
        <div className="mb-3 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-sm text-[var(--color-warning)]">
          {elenco.avviso}
        </div>
      )}

      {elenco && elenco.montata && elenco.copie.length === 0 && (
        <Empty>
          Nessuna copia ancora. La prima arriva stanotte, oppure premi «Crea copia ora».
        </Empty>
      )}

      {elenco && elenco.copie.length > 0 && (
        <ul className="space-y-2 text-sm">
          {elenco.copie.map((copia) => (
            <li
              key={copia.nome}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)]/50 pb-2"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-neutral-300">
                  {copia.quando ? formatDate(copia.quando) : copia.nome}
                </span>
                {copia.versione && <Badge tone="neutral">{copia.versione}</Badge>}
                <span className="text-xs text-neutral-500">
                  {copia.righe.toLocaleString('it-IT')} righe in {copia.tabelle} tabelle
                </span>
                <span className="text-xs text-neutral-500">{peso(copia.byte)}</span>
                {copia.archivio.incluso ? (
                  <span className="text-xs text-neutral-500">
                    {copia.archivio.file} file archiviati
                  </span>
                ) : (
                  <span className="text-xs text-[var(--color-warning)]">
                    senza archivio: {copia.archivio.motivo ?? 'non incluso'}
                  </span>
                )}
                {copia.ripristinata && (
                  <span className="text-xs text-[var(--color-success)]">già ripristinata</span>
                )}
                {copia.errori.length > 0 && (
                  <span className="text-xs text-[var(--color-danger)]">
                    {copia.errori.join(', ')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {copia.parti.includes('dati') && (
                  <a
                    className="rounded-md px-2 py-1 text-xs text-neutral-300 hover:bg-[var(--color-surface-2)]"
                    href={`/api/copie/${copia.nome}/dati`}
                  >
                    Scarica dati
                  </a>
                )}
                {copia.parti.includes('archivio') && (
                  <a
                    className="rounded-md px-2 py-1 text-xs text-neutral-300 hover:bg-[var(--color-surface-2)]"
                    href={`/api/copie/${copia.nome}/archivio`}
                  >
                    Scarica archivio
                  </a>
                )}
                {/* Il manifesto serve per il ripristino tanto quanto i dati:
                    senza, chi rilegge la copia non sa quali campi sono date e
                    quali BigInt, e il ripristino si ferma prima di cominciare. */}
                {copia.parti.includes('manifesto') && (
                  <a
                    className="rounded-md px-2 py-1 text-xs text-neutral-300 hover:bg-[var(--color-surface-2)]"
                    href={`/api/copie/${copia.nome}/manifesto`}
                  >
                    Manifesto
                  </a>
                )}
                {copia.parti.includes('istruzioni') && (
                  <a
                    className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-[var(--color-surface-2)]"
                    href={`/api/copie/${copia.nome}/istruzioni`}
                  >
                    Istruzioni
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs leading-relaxed text-neutral-500">
        Per spostare ANGEL su un'altra macchina: scarica «dati», «archivio» e «manifesto», rimettili
        in una cartella <code className="rounded bg-[var(--color-surface-2)] px-1">angel-…</code>{' '}
        dentro BACKUP_DIR sulla macchina nuova — con i nomi originali{' '}
        <code className="rounded bg-[var(--color-surface-2)] px-1">dati.tar.gz</code>,{' '}
        <code className="rounded bg-[var(--color-surface-2)] px-1">archivio.tar.gz</code> e{' '}
        <code className="rounded bg-[var(--color-surface-2)] px-1">MANIFESTO.json</code>, togliendo
        il prefisso che il browser aggiunge — poi aggiungi{' '}
        <code className="rounded bg-[var(--color-surface-2)] px-1">RESTORE_FROM</code> al compose e
        riavvia. La <code className="rounded bg-[var(--color-surface-2)] px-1">ENCRYPTION_KEY</code>{' '}
        deve essere la stessa, altrimenti i token delle integrazioni restano illeggibili — e il
        ripristino si ferma per dirtelo.
      </p>
    </Card>
  );
}
