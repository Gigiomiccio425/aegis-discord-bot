import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useGuildId } from '../App.js';
import { ChannelPicker, RolePicker, UserPicker, useInventario } from '../components/pickers.js';
import { MentionInput } from '../components/MentionInput.js';
import { Badge, Button, Card, ErrorBox, Loading, NumberInput } from '../components/ui.js';

/* ═══════════════════════════════════════════════════════════════════════
   ANNUNCI

   Una pagina sola per tutte le fonti: Twitch, YouTube e i feed. Prima erano
   tre elenchi dentro la configurazione, in mezzo a soglie e interruttori —
   sotto forma di JSON, per giunta.

   Sono la cosa che si tocca più spesso e la sola che non riguarda la
   sicurezza: aggiungere uno streamer non deve costringere a passare davanti
   alle impostazioni dell'anti-nuke.
   ═══════════════════════════════════════════════════════════════════════ */

type Json = Record<string, unknown>;

interface ConfigResponse {
  config: Json;
  objectArrayTemplates: Record<string, unknown>;
}

interface Voce extends Json {
  enabled: boolean;
  announceChannelId: string | null;
  mentionRoleId: string | null;
  template: string;
}

interface Piattaforma {
  chiave: 'twitch' | 'youtube' | 'rss';
  nome: string;
  elenco: 'streamers' | 'channels' | 'feeds';
  /** Campo che identifica la voce, e come si presenta nel modulo. */
  campoNome: string;
  etichettaNome: string;
  prefisso: string | null;
  aiutoNome: string;
  variabili: { nome: string; descrizione: string }[];
  icona: string;
}

const PIATTAFORME: Piattaforma[] = [
  {
    chiave: 'twitch',
    nome: 'Twitch',
    elenco: 'streamers',
    campoNome: 'login',
    etichettaNome: 'Streamer',
    prefisso: 'twitch.tv/',
    aiutoNome: "Il nome com'è scritto nell'indirizzo del canale, non quello mostrato.",
    variabili: [
      { nome: 'streamer', descrizione: 'Nome dello streamer' },
      { nome: 'title', descrizione: 'Titolo della diretta' },
      { nome: 'game', descrizione: 'Categoria o gioco' },
      { nome: 'url', descrizione: 'Link alla diretta' },
      { nome: 'viewers', descrizione: 'Spettatori al momento dell’annuncio' },
    ],
    icona: '🟣',
  },
  {
    chiave: 'youtube',
    nome: 'YouTube',
    elenco: 'channels',
    campoNome: 'channel',
    etichettaNome: 'Canale',
    prefisso: 'youtube.com/',
    aiutoNome: 'L’@handle del canale oppure il suo ID, quello che comincia per UC.',
    variabili: [
      { nome: 'autore', descrizione: 'Nome del canale' },
      { nome: 'titolo', descrizione: 'Titolo del video' },
      { nome: 'url', descrizione: 'Link al video' },
      { nome: 'tipo', descrizione: 'Video o diretta' },
    ],
    icona: '🔴',
  },
  {
    chiave: 'rss',
    nome: 'Feed RSS',
    elenco: 'feeds',
    campoNome: 'url',
    etichettaNome: 'Indirizzo del feed',
    prefisso: null,
    aiutoNome: 'Il link RSS o Atom. Funziona con blog, Reddit, Mastodon, release GitHub, podcast.',
    variabili: [
      { nome: 'fonte', descrizione: 'Nome della fonte' },
      { nome: 'titolo', descrizione: 'Titolo della voce' },
      { nome: 'url', descrizione: 'Link alla voce' },
      { nome: 'autore', descrizione: 'Autore, se il feed lo dichiara' },
      { nome: 'descrizione', descrizione: 'Estratto del contenuto' },
    ],
    icona: '📰',
  },
];

/** Valori d'esempio per l'anteprima e per la prova: non arrivano da Discord. */
const ESEMPI: Record<string, Record<string, string>> = {
  twitch: {
    streamer: 'nome_streamer',
    title: 'Prova di annuncio dal pannello',
    game: 'Just Chatting',
    url: 'https://twitch.tv/nome_streamer',
    viewers: '128',
  },
  youtube: {
    autore: 'Nome del canale',
    titolo: 'Prova di annuncio dal pannello',
    url: 'https://youtube.com/watch?v=esempio',
    tipo: 'video',
  },
  rss: {
    fonte: 'Nome della fonte',
    titolo: 'Prova di annuncio dal pannello',
    url: 'https://esempio.it/articolo',
    autore: 'Redazione',
    descrizione: 'Prime righe del contenuto.',
  },
};

function riempi(template: string, valori: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (intero, chiave: string) => valori[chiave] ?? intero);
}

export function Annunci() {
  const guildId = useGuildId();
  const [config, setConfig] = useState<Json | null>(null);
  const [modelli, setModelli] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [avviso, setAvviso] = useState<string | null>(null);
  const [inModifica, setInModifica] = useState<{ piattaforma: Piattaforma; indice: number } | null>(
    null,
  );

  useEffect(() => {
    api
      .get<ConfigResponse>(`/api/guilds/${guildId}/config`)
      .then((risultato) => {
        setConfig(structuredClone(risultato.config));
        setModelli(risultato.objectArrayTemplates ?? {});
      })
      .catch((err: Error) => setError(err.message));
  }, [guildId]);

  if (error && !config) return <ErrorBox message={error} />;
  if (!config) return <Loading />;

  const integrazioni = config.integrations as Record<string, Json>;

  const salva = async (prossimo: Json, messaggio: string): Promise<void> => {
    setConfig(prossimo);
    try {
      await api.put(`/api/guilds/${guildId}/config`, prossimo);
      setError(null);
      setAvviso(messaggio);
      setTimeout(() => setAvviso(null), 4000);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const scriviElenco = (piattaforma: Piattaforma, voci: Voce[], messaggio: string): void => {
    const prossimo = structuredClone(config);
    const sezione = (prossimo.integrations as Record<string, Json>)[piattaforma.chiave]!;
    sezione[piattaforma.elenco] = voci;
    void salva(prossimo, messaggio);
  };

  const commutaModulo = (piattaforma: Piattaforma, acceso: boolean): void => {
    const prossimo = structuredClone(config);
    const sezione = (prossimo.integrations as Record<string, Json>)[piattaforma.chiave]!;
    sezione.enabled = acceso;
    void salva(prossimo, acceso ? `${piattaforma.nome} attivato.` : `${piattaforma.nome} spento.`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Annunci</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Dirette, video e notizie pubblicate nei canali del server. Ogni voce ha il suo canale, il
          suo messaggio e il suo ruolo da menzionare.
        </p>
      </div>

      {error && <ErrorBox message={error} />}
      {avviso && (
        <div className="rounded-lg border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-sm text-[#8fe0b4]">
          {avviso}
        </div>
      )}

      {PIATTAFORME.map((piattaforma) => {
        const sezione = integrazioni[piattaforma.chiave] ?? {};
        const voci = (sezione[piattaforma.elenco] as Voce[] | undefined) ?? [];
        const acceso = Boolean(sezione.enabled);

        return (
          <Card
            key={piattaforma.chiave}
            title={`${piattaforma.icona}  ${piattaforma.nome}`}
            subtitle={
              acceso
                ? `${voci.length} ${voci.length === 1 ? 'voce configurata' : 'voci configurate'}`
                : 'Modulo spento: nessun annuncio parte, anche se le voci restano configurate.'
            }
            action={
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-neutral-400">
                  <input
                    type="checkbox"
                    checked={acceso}
                    onChange={(event) => commutaModulo(piattaforma, event.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  attivo
                </label>
                <Button
                  variant="primary"
                  onClick={() => {
                    const modello = modelli[
                      `integrations.${piattaforma.chiave}.${piattaforma.elenco}`
                    ] as Voce | undefined;
                    scriviElenco(
                      piattaforma,
                      [...voci, structuredClone(modello ?? ({} as Voce))],
                      'Voce aggiunta: compilala e salva.',
                    );
                    setInModifica({ piattaforma, indice: voci.length });
                  }}
                >
                  Aggiungi
                </Button>
              </div>
            }
          >
            {voci.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-6 text-center text-sm text-neutral-500">
                Niente ancora. «Aggiungi» crea una voce già impostata: resta da scegliere il nome e
                il canale.
              </p>
            ) : (
              <div className="space-y-2">
                {voci.map((voce, indice) => (
                  <RigaVoce
                    key={indice}
                    guildId={guildId}
                    piattaforma={piattaforma}
                    voce={voce}
                    onModifica={() => setInModifica({ piattaforma, indice })}
                    onCommuta={() =>
                      scriviElenco(
                        piattaforma,
                        voci.map((altra, posizione) =>
                          posizione === indice ? { ...altra, enabled: !altra.enabled } : altra,
                        ),
                        voce.enabled ? 'Voce sospesa.' : 'Voce riattivata.',
                      )
                    }
                    onRimuovi={() =>
                      scriviElenco(
                        piattaforma,
                        voci.filter((_, posizione) => posizione !== indice),
                        'Voce rimossa.',
                      )
                    }
                    onErrore={setError}
                  />
                ))}
              </div>
            )}
          </Card>
        );
      })}

      {inModifica && (
        <EditorVoce
          guildId={guildId}
          piattaforma={inModifica.piattaforma}
          voce={
            ((integrazioni[inModifica.piattaforma.chiave]?.[inModifica.piattaforma.elenco] as
              | Voce[]
              | undefined) ?? [])[inModifica.indice]
          }
          onChiudi={() => setInModifica(null)}
          onSalva={(aggiornata) => {
            const voci =
              ((integrazioni[inModifica.piattaforma.chiave]?.[inModifica.piattaforma.elenco] as
                | Voce[]
                | undefined) ?? []).map((altra, posizione) =>
                posizione === inModifica.indice ? aggiornata : altra,
              );
            scriviElenco(inModifica.piattaforma, voci, 'Salvato.');
            setInModifica(null);
          }}
        />
      )}
    </div>
  );
}

/* ── Riga dell'elenco ─────────────────────────────────────────────────── */

function RigaVoce({
  guildId,
  piattaforma,
  voce,
  onModifica,
  onCommuta,
  onRimuovi,
  onErrore,
}: {
  guildId: string;
  piattaforma: Piattaforma;
  voce: Voce;
  onModifica: () => void;
  onCommuta: () => void;
  onRimuovi: () => void;
  onErrore: (messaggio: string) => void;
}) {
  const inventario = useInventario(guildId);
  const [provaFatta, setProvaFatta] = useState(false);

  const nome = String(voce[piattaforma.campoNome] ?? '').trim();
  const canale = inventario.channels.find((voce2) => voce2.id === voce.announceChannelId);
  const ruolo = inventario.roles.find((voce2) => voce2.id === voce.mentionRoleId);

  /**
   * Pubblica il messaggio com'è, con valori d'esempio.
   *
   * È l'unico modo di sapere prima se il testo viene come si pensava, se il
   * bot può scrivere in quel canale e se la menzione funziona. Scoprirlo alla
   * prima diretta vera significa scoprirlo davanti a tutti.
   */
  const prova = async (): Promise<void> => {
    if (!voce.announceChannelId) {
      onErrore('Scegli prima il canale dove pubblicare.');
      return;
    }
    try {
      const testo = riempi(voce.template ?? '', {
        ...ESEMPI[piattaforma.chiave]!,
        ...(nome ? { streamer: nome, autore: nome, fonte: nome } : {}),
      });
      await api.post(`/api/guilds/${guildId}/say`, {
        channelId: voce.announceChannelId,
        text: `${voce.mentionRoleId ? `<@&${voce.mentionRoleId}> ` : ''}${testo}\n-# messaggio di prova`,
      });
      setProvaFatta(true);
      setTimeout(() => setProvaFatta(false), 4000);
    } catch (err) {
      onErrore((err as Error).message);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {piattaforma.prefisso && <span className="text-neutral-600">{piattaforma.prefisso}</span>}
          {nome || <span className="text-[var(--color-warning)]">da compilare</span>}
        </span>

        {!voce.enabled && <Badge tone="neutral">sospesa</Badge>}
        {voce.enabled && !voce.announceChannelId && <Badge tone="warning">senza canale</Badge>}
        {Number(voce.clipMinViews ?? 0) > 0 && <Badge tone="accent">clip</Badge>}
        {voce.liveRoleId ? <Badge tone="accent">ruolo live</Badge> : null}

        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onCommuta} className="text-xs text-neutral-400 underline">
            {voce.enabled ? 'Sospendi' : 'Riattiva'}
          </button>
          <button type="button" onClick={() => void prova()} className="text-xs text-neutral-400 underline">
            {provaFatta ? 'inviato' : 'Prova'}
          </button>
          <Button onClick={onModifica}>Modifica</Button>
          <button
            type="button"
            onClick={onRimuovi}
            className="text-xs text-[var(--color-danger)] underline"
          >
            Rimuovi
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
        <span>
          Pubblica in{' '}
          {canale ? (
            <span className="text-neutral-300">#{canale.name}</span>
          ) : voce.announceChannelId ? (
            <span className="text-neutral-400">canale non trovato</span>
          ) : (
            <span className="text-[var(--color-warning)]">nessun canale</span>
          )}
        </span>
        {ruolo && <span>Menziona @{ruolo.name}</span>}
      </div>
    </div>
  );
}

/* ── Modulo di modifica ───────────────────────────────────────────────── */

function EditorVoce({
  guildId,
  piattaforma,
  voce,
  onSalva,
  onChiudi,
}: {
  guildId: string;
  piattaforma: Piattaforma;
  voce: Voce | undefined;
  onSalva: (voce: Voce) => void;
  onChiudi: () => void;
}) {
  const [bozza, setBozza] = useState<Voce>(structuredClone(voce ?? ({} as Voce)));
  const [avanzate, setAvanzate] = useState(false);

  const campo = (chiave: string, valore: unknown): void =>
    setBozza((corrente) => ({ ...corrente, [chiave]: valore }) as Voce);

  const anteprima = riempi(String(bozza.template ?? ''), ESEMPI[piattaforma.chiave]!);

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/70 p-6">
      <div className="w-full max-w-2xl rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h2 className="text-lg font-semibold">
          {piattaforma.icona} Annuncio {piattaforma.nome}
        </h2>

        <label className="mt-4 block text-sm">
          <span className="mb-1 block text-neutral-300">{piattaforma.etichettaNome}</span>
          <div className="flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]">
            {piattaforma.prefisso && (
              <span className="pl-3 text-sm text-neutral-600">{piattaforma.prefisso}</span>
            )}
            <input
              type="text"
              value={String(bozza[piattaforma.campoNome] ?? '')}
              onChange={(event) => campo(piattaforma.campoNome, event.target.value.trim())}
              className="w-full bg-transparent px-2 py-1.5 text-sm outline-none"
            />
          </div>
          <p className="mt-0.5 text-xs text-neutral-500">{piattaforma.aiutoNome}</p>
        </label>

        <label className="mt-4 block text-sm">
          <span className="mb-1 block text-neutral-300">Dove pubblicare</span>
          <ChannelPicker
            guildId={guildId}
            value={(bozza.announceChannelId as string | null) ?? null}
            onChange={(valore) => campo('announceChannelId', valore)}
          />
        </label>

        <label className="mt-4 block text-sm">
          <span className="mb-1 block text-neutral-300">Ruolo da menzionare</span>
          <RolePicker
            guildId={guildId}
            value={(bozza.mentionRoleId as string | null) ?? null}
            onChange={(valore) => campo('mentionRoleId', valore)}
          />
        </label>

        <div className="mt-4 text-sm">
          <span className="mb-1 block text-neutral-300">Messaggio</span>
          <MentionInput
            guildId={guildId}
            value={String(bozza.template ?? '')}
            onChange={(valore) => campo('template', valore)}
            maxLength={2000}
            rows={5}
            variabili={piattaforma.variabili}
          />
          <p className="mt-1 text-xs text-neutral-500">
            <span className="text-neutral-600">Anteprima: </span>
            {anteprima.slice(0, 200) || '—'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setAvanzate(!avanzate)}
          className="mt-4 flex w-full items-center justify-between border-t border-[var(--color-border)] pt-3 text-sm text-neutral-300"
        >
          Impostazioni avanzate
          <span className="text-neutral-600">{avanzate ? '▴' : '▾'}</span>
        </button>

        {avanzate && (
          <div className="mt-3 space-y-4">
            {piattaforma.chiave === 'twitch' && (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-300">Ruolo mentre è in diretta</span>
                  <RolePicker
                    guildId={guildId}
                    value={(bozza.liveRoleId as string | null) ?? null}
                    onChange={(valore) => campo('liveRoleId', valore)}
                  />
                  <p className="mt-0.5 text-xs text-neutral-500">
                    Assegnato quando la diretta comincia, tolto quando finisce.
                  </p>
                </label>

                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-300">
                    Chi è questo streamer su Discord
                  </span>
                  <UserPicker
                    guildId={guildId}
                    value={(bozza.discordUserId as string | null) ?? null}
                    onChange={(valore) => campo('discordUserId', valore)}
                  />
                  <p className="mt-0.5 text-xs text-neutral-500">
                    Twitch e Discord non hanno niente in comune: senza questo collegamento il bot sa
                    che il canale è in diretta, ma non a chi dare il ruolo.
                  </p>
                </label>

                {Boolean(bozza.liveRoleId) && !bozza.discordUserId && (
                  <p className="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-warning)]">
                    Hai scelto un ruolo «in diretta» ma non la persona a cui darlo: così il ruolo non
                    verrà assegnato a nessuno.
                  </p>
                )}
                <label className="flex items-center justify-between text-sm">
                  <span className="text-neutral-300">Non riannunciare per (minuti)</span>
                  <NumberInput
                    value={Number(bozza.cooldownMinutes ?? 60)}
                    onChange={(valore) => campo('cooldownMinutes', valore)}
                  />
                </label>
                <label className="flex items-center justify-between text-sm">
                  <span className="text-neutral-300">Pubblica i clip sopra (visualizzazioni)</span>
                  <NumberInput
                    value={Number(bozza.clipMinViews ?? 0)}
                    onChange={(valore) => campo('clipMinViews', valore)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-300">Canale dei clip</span>
                  <ChannelPicker
                    guildId={guildId}
                    value={(bozza.clipChannelId as string | null) ?? null}
                    onChange={(valore) => campo('clipChannelId', valore)}
                  />
                </label>
              </>
            )}

            {piattaforma.chiave === 'youtube' && (
              <label className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={Boolean(bozza.announceLive ?? true)}
                  onChange={(event) => campo('announceLive', event.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span className="text-neutral-300">
                  Annuncia anche le dirette, non solo i video caricati
                </span>
              </label>
            )}

            {piattaforma.chiave === 'rss' && (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-300">Nome della fonte</span>
                  <input
                    type="text"
                    value={String(bozza.label ?? '')}
                    onChange={(event) => campo('label', event.target.value)}
                    placeholder="vuoto = il titolo dichiarato dal feed"
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
                  />
                </label>
                <ListaParole
                  etichetta="Pubblica solo se il titolo contiene"
                  valore={(bozza.includeKeywords as string[] | undefined) ?? []}
                  onChange={(valori) => campo('includeKeywords', valori)}
                />
                <ListaParole
                  etichetta="Scarta se il titolo contiene"
                  valore={(bozza.excludeKeywords as string[] | undefined) ?? []}
                  onChange={(valori) => campo('excludeKeywords', valori)}
                />
                <label className="flex items-center justify-between text-sm">
                  <span className="text-neutral-300">Al massimo per controllo</span>
                  <NumberInput
                    value={Number(bozza.maxPerCheck ?? 3)}
                    onChange={(valore) => campo('maxPerCheck', valore)}
                  />
                </label>
              </>
            )}
          </div>
        )}

        <div className="mt-6 flex items-center gap-3">
          <Button variant="primary" onClick={() => onSalva(bozza)}>
            Salva
          </Button>
          <Button onClick={onChiudi}>Annulla</Button>
        </div>
      </div>
    </div>
  );
}

/** Parole chiave, una per riga o separate da virgola. */
function ListaParole({
  etichetta,
  valore,
  onChange,
}: {
  etichetta: string;
  valore: string[];
  onChange: (valore: string[]) => void;
}) {
  const [testo, setTesto] = useState(valore.join(', '));

  return (
    <label className="block text-sm">
      <span className="mb-1 block text-neutral-300">{etichetta}</span>
      <input
        type="text"
        value={testo}
        placeholder="vuoto = nessun filtro"
        onChange={(event) => {
          setTesto(event.target.value);
          onChange(
            event.target.value
              .split(',')
              .map((parola) => parola.trim())
              .filter(Boolean),
          );
        }}
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
      />
    </label>
  );
}
