import { useCallback, useEffect, useState } from 'react';
import type { LivelloSicurezza, TwitchChannelConfig } from '@angel/shared';
import { api, type Canale as CanaleDati, type Evento } from '../api.js';
import {
  Bottone,
  Caricamento,
  Elenco,
  Errore,
  Etichetta,
  Interruttore,
  Numero,
  Riquadro,
  Testo,
  Vuoto,
  quando,
} from '../componenti/ui.js';

/* ═══════════════════════════════════════════════════════════════════════
   LA PAGINA DEL CANALE

   Una pagina sola con tre schede, e l'ordine non è casuale: si apre su
   **Sicurezza**, perché è il motivo per cui il bot è stato installato, e
   perché la prima cosa che deve succedere è scegliere un livello. Tutto il
   resto — comandi, messaggi a tempo — è ciò che si configura la seconda
   volta che si apre il pannello.

   Il salvataggio è esplicito. La tentazione era salvare a ogni modifica,
   com'è di moda: qui però un campo cambiato per sbaglio è una chat che si
   comporta diversamente stasera, e un pulsante «Salva» che si accende quando
   c'è qualcosa da salvare è un contratto più chiaro di un salvataggio
   silenzioso di cui non si è certi.
   ═══════════════════════════════════════════════════════════════════════ */

type Scheda = 'sicurezza' | 'chat' | 'registro';

export function Canale({
  canaleId,
  livelli,
}: {
  canaleId: string;
  livelli: Record<string, string>;
}) {
  const [dati, setDati] = useState<CanaleDati | null>(null);
  const [bozza, setBozza] = useState<TwitchChannelConfig | null>(null);
  const [scheda, setScheda] = useState<Scheda>('sicurezza');
  const [errore, setErrore] = useState<string | null>(null);
  const [salvataggio, setSalvataggio] = useState<'fermo' | 'invio' | 'fatto'>('fermo');

  const carica = useCallback(() => {
    api
      .get<CanaleDati>(`/api/canali/${canaleId}`)
      .then((risposta) => {
        setDati(risposta);
        setBozza(structuredClone(risposta.config));
      })
      .catch((err: Error) => setErrore(err.message));
  }, [canaleId]);

  useEffect(carica, [carica]);

  if (errore) return <Errore messaggio={errore} />;
  if (!dati || !bozza) return <Caricamento />;

  const modificato = JSON.stringify(bozza) !== JSON.stringify(dati.config);
  const soloLettura = dati.ruolo === 'LETTURA';

  const modifica = (ritocchi: (config: TwitchChannelConfig) => void): void => {
    const nuova = structuredClone(bozza);
    ritocchi(nuova);
    setBozza(nuova);
    setSalvataggio('fermo');
  };

  const salva = async (): Promise<void> => {
    setSalvataggio('invio');
    setErrore(null);
    try {
      await api.put(`/api/canali/${canaleId}/config`, bozza);
      setSalvataggio('fatto');
      carica();
      setTimeout(() => setSalvataggio('fermo'), 3000);
    } catch (err) {
      setErrore((err as Error).message);
      setSalvataggio('fermo');
    }
  };

  const cambiaLivello = async (livello: LivelloSicurezza): Promise<void> => {
    setErrore(null);
    try {
      await api.post(`/api/canali/${canaleId}/livello`, { livello });
      carica();
    } catch (err) {
      setErrore((err as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <Testata dati={dati} onRicarica={carica} />

      {dati.daRiautorizzare && (
        <Riquadro tono="pericolo" titolo="Il collegamento con Twitch è scaduto">
          <p className="mb-4 text-sm leading-relaxed text-[var(--color-fioco)]">
            Succede se hai cambiato password o revocato l&apos;accesso. Il bot legge ancora la chat
            ma non può più cancellare né silenziare nessuno. Si risolve in un clic.
          </p>
          <a
            href="/api/auth/entra"
            className="inline-block rounded-lg bg-[var(--color-accento)] px-4 py-2 text-sm font-medium text-[#160f24]"
          >
            Riautorizza
          </a>
        </Riquadro>
      )}

      <nav className="flex gap-1 rounded-xl border border-[var(--color-bordo)] bg-[var(--color-superficie)]/60 p-1">
        {(
          [
            ['sicurezza', 'Sicurezza'],
            ['chat', 'Chat'],
            ['registro', 'Registro'],
          ] as const
        ).map(([chiave, nome]) => (
          <button
            key={chiave}
            type="button"
            onClick={() => setScheda(chiave)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm transition-colors ${
              scheda === chiave
                ? 'bg-[var(--color-accento)]/15 text-[var(--color-accento-forte)]'
                : 'text-[var(--color-fioco)] hover:text-[var(--color-testo)]'
            }`}
          >
            {nome}
          </button>
        ))}
      </nav>

      {scheda === 'sicurezza' && (
        <Sicurezza
          config={bozza}
          livelli={livelli}
          soloLettura={soloLettura}
          onLivello={cambiaLivello}
          onModifica={modifica}
        />
      )}
      {scheda === 'chat' && (
        <Chat config={bozza} soloLettura={soloLettura} onModifica={modifica} />
      )}
      {scheda === 'registro' && <Registro canaleId={canaleId} />}

      {modificato && !soloLettura && (
        <div className="sticky bottom-4 flex items-center justify-between gap-4 rounded-xl border border-[var(--color-accento)]/40 bg-[var(--color-superficie)] px-5 py-4 shadow-lg shadow-black/40">
          <span className="text-sm text-[var(--color-fioco)]">
            Ci sono modifiche non salvate.
          </span>
          <span className="flex gap-2">
            <Bottone variante="fantasma" onClick={() => setBozza(structuredClone(dati.config))}>
              Annulla
            </Bottone>
            <Bottone
              variante="principale"
              disabled={salvataggio === 'invio'}
              onClick={() => void salva()}
            >
              {salvataggio === 'invio' ? 'Salvo…' : 'Salva'}
            </Bottone>
          </span>
        </div>
      )}

      {salvataggio === 'fatto' && (
        <p className="text-center text-sm text-[var(--color-ok)]">
          Salvato. È già attivo in chat.
        </p>
      )}
    </div>
  );
}

/* ── Testata ──────────────────────────────────────────────────────────── */

function Testata({ dati, onRicarica }: { dati: CanaleDati; onRicarica: () => void }) {
  const [occupato, setOccupato] = useState(false);

  const scudo = async (attivo: boolean): Promise<void> => {
    setOccupato(true);
    await api.post(`/api/canali/${dati.id}/scudo`, { attivo }).catch(() => undefined);
    setOccupato(false);
    onRicarica();
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        {dati.avatar && <img src={dati.avatar} alt="" className="h-12 w-12 rounded-full" />}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{dati.nome}</h1>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-fioco)]">
            <Etichetta tono={dati.online ? 'ok' : 'neutro'}>
              {dati.online ? 'in diretta' : 'offline'}
            </Etichetta>
            {dati.config.modalitaProva && <Etichetta tono="attenzione">modalità prova</Etichetta>}
            {dati.scudoFinoA && <Etichetta tono="pericolo">scudo attivo</Etichetta>}
          </p>
        </div>
      </div>

      {/*
        Il pulsante dello scudo sta qui, in alto, sempre visibile.

        È l'unica cosa di questo pannello che si preme di corsa: quando arriva
        un'ondata non si ha tempo di cercarla dentro una scheda.
      */}
      <Bottone
        variante={dati.scudoFinoA ? 'normale' : 'pericolo'}
        disabled={occupato || dati.ruolo === 'LETTURA'}
        onClick={() => void scudo(!dati.scudoFinoA)}
      >
        {dati.scudoFinoA ? 'Togli lo scudo' : 'Chiudi la chat adesso'}
      </Bottone>
    </div>
  );
}

/* ── Sicurezza ────────────────────────────────────────────────────────── */

const COLORE_LIVELLO: Record<string, string> = {
  OSSERVA: 'var(--color-informazione)',
  LEGGERO: 'var(--color-ok)',
  NORMALE: 'var(--color-accento)',
  ALTO: 'var(--color-attenzione)',
  BLINDATO: 'var(--color-pericolo)',
  PERSONALIZZATO: 'var(--color-fioco)',
};

function Sicurezza({
  config,
  livelli,
  soloLettura,
  onLivello,
  onModifica,
}: {
  config: TwitchChannelConfig;
  livelli: Record<string, string>;
  soloLettura: boolean;
  onLivello: (livello: LivelloSicurezza) => Promise<void>;
  onModifica: (ritocchi: (config: TwitchChannelConfig) => void) => void;
}) {
  const scelte: LivelloSicurezza[] = ['OSSERVA', 'LEGGERO', 'NORMALE', 'ALTO', 'BLINDATO'];

  return (
    <div className="space-y-6">
      <Riquadro
        titolo="Livello di sicurezza"
        sottotitolo="Una scelta sola imposta tutto il resto. Puoi sempre affinare i dettagli qui sotto: il livello diventa «personalizzato» e nessun preset lo tocca più."
      >
        <div className="grid gap-2 sm:grid-cols-5">
          {scelte.map((livello) => {
            const scelto = config.livello === livello;
            return (
              <button
                key={livello}
                type="button"
                disabled={soloLettura}
                onClick={() => void onLivello(livello)}
                style={scelto ? { borderColor: COLORE_LIVELLO[livello] } : undefined}
                className={`rounded-xl border-2 px-3 py-4 text-center transition-colors disabled:opacity-50 ${
                  scelto
                    ? 'bg-[var(--color-superficie-2)]'
                    : 'border-[var(--color-bordo)] hover:bg-[var(--color-superficie-2)]'
                }`}
              >
                <span
                  className="mx-auto mb-2 block h-2 w-2 rounded-full"
                  style={{ background: COLORE_LIVELLO[livello] }}
                />
                <span className="block text-xs font-medium capitalize">
                  {livello.toLowerCase()}
                </span>
              </button>
            );
          })}
        </div>

        <p className="mt-4 text-sm leading-relaxed text-[var(--color-fioco)]">
          {livelli[config.livello] ?? ''}
        </p>
      </Riquadro>

      <Riquadro
        titolo="Modalità prova"
        sottotitolo="Il bot valuta tutto e registra cosa avrebbe fatto, senza sanzionare nessuno. È il modo di accendere un livello nuovo su un canale vero senza rischiare."
      >
        <Interruttore
          acceso={config.modalitaProva}
          disabilitato={soloLettura}
          titolo="Non sanzionare nessuno"
          descrizione="Nel registro compaiono gli eventi come «prova»: si vede esattamente cosa sarebbe successo."
          onCambia={(valore) => onModifica((c) => void (c.modalitaProva = valore))}
        />
      </Riquadro>

      <Riquadro titolo="Cosa controllare">
        <div className="divide-y divide-[var(--color-bordo)]/60">
          <Interruttore
            acceso={config.sicurezza.botSpam.attivo}
            disabilitato={soloLettura}
            titolo="Bot che vendono visualizzatori"
            descrizione="I messaggi commerciali automatici: «cheap viewers», «buy followers», i finti grafici. Riconosciuti anche scritti in Unicode strano per aggirare i filtri."
            onCambia={(v) => onModifica((c) => void (c.sicurezza.botSpam.attivo = v))}
          />
          <Interruttore
            acceso={config.sicurezza.link.attivo}
            disabilitato={soloLettura}
            titolo="Link"
            descrizione="Domini truffa, imitazioni di Twitch e Steam, portafogli cripto. Usa le stesse blocklist del bot Discord, aggiornate ogni sei ore."
            onCambia={(v) => onModifica((c) => void (c.sicurezza.link.attivo = v))}
          />
          <Interruttore
            acceso={config.sicurezza.linguaggio.attivo}
            disabilitato={soloLettura}
            titolo="Linguaggio"
            descrizione="La stessa lista di parole del bot Discord: quello che aggiungi da una parte vale anche dall’altra."
            onCambia={(v) => onModifica((c) => void (c.sicurezza.linguaggio.attivo = v))}
          />
          <Interruttore
            acceso={config.sicurezza.antiSpam.attivo}
            disabilitato={soloLettura}
            titolo="Anti-spam"
            descrizione="Messaggi ripetuti, troppo veloci, tutto maiuscolo, muri di emote, ASCII art."
            onCambia={(v) => onModifica((c) => void (c.sicurezza.antiSpam.attivo = v))}
          />
          <Interruttore
            acceso={config.sicurezza.antiRaid.attivo}
            disabilitato={soloLettura}
            titolo="Ondate ostili"
            descrizione="Molti sconosciuti insieme che scrivono cose simili. Un raid amichevole non fa scattare niente: servono entrambi i segnali."
            onCambia={(v) => onModifica((c) => void (c.sicurezza.antiRaid.attivo = v))}
          />
          <Interruttore
            acceso={config.sicurezza.impersonazione.attivo}
            disabilitato={soloLettura}
            titolo="Chi si spaccia per te"
            descrizione="Nomi quasi identici al tuo o a quelli dei moderatori, anche scritti con lettere cirilliche."
            onCambia={(v) => onModifica((c) => void (c.sicurezza.impersonazione.attivo = v))}
          />
          <Interruttore
            acceso={config.sicurezza.primoMessaggio.attivo}
            disabilitato={soloLettura}
            titolo="Primo messaggio di chi non ha mai scritto"
            descrizione="La fascia in cui sta quasi tutto lo spam, e quasi nessuno degli spettatori affezionati."
            onCambia={(v) => onModifica((c) => void (c.sicurezza.primoMessaggio.attivo = v))}
          />
        </div>
      </Riquadro>

      <Riquadro
        titolo="Link"
        sottotitolo="I domini che scrivi qui vincono su tutto il resto, blocklist comprese."
      >
        <Elenco
          valori={config.sicurezza.link.dominiAmmessi}
          titolo="Sempre ammessi"
          descrizione="Il tuo Discord, il tuo negozio, i tuoi social. Mettili qui subito: senza, il bot potrebbe cancellarli quando li posta qualcun altro."
          segnaposto="discord.gg, youtube.com, ilmiosito.it"
          onCambia={(v) => onModifica((c) => void (c.sicurezza.link.dominiAmmessi = v))}
        />
        <Elenco
          valori={config.sicurezza.link.dominiVietati}
          titolo="Sempre bloccati"
          segnaposto="sitobrutto.com"
          onCambia={(v) => onModifica((c) => void (c.sicurezza.link.dominiVietati = v))}
        />
        <div className="mt-2 divide-y divide-[var(--color-bordo)]/60">
          <Interruttore
            acceso={config.sicurezza.link.bloccaPrimoMessaggio}
            disabilitato={soloLettura}
            titolo="Niente link nel primo messaggio"
            descrizione="La regola che ferma di più, e che quasi nessuno nota."
            onCambia={(v) => onModifica((c) => void (c.sicurezza.link.bloccaPrimoMessaggio = v))}
          />
          <Interruttore
            acceso={config.sicurezza.link.soloPermessi}
            disabilitato={soloLettura}
            titolo="Link solo per abbonati e VIP"
            descrizione="Drastico. Utile nelle serate difficili, scomodo tutti gli altri giorni."
            onCambia={(v) => onModifica((c) => void (c.sicurezza.link.soloPermessi = v))}
          />
        </div>
      </Riquadro>

      <Riquadro titolo="Anti-spam — le soglie">
        <div className="divide-y divide-[var(--color-bordo)]/60">
          <Numero
            valore={config.sicurezza.antiSpam.messaggiMax}
            titolo="Messaggi consentiti nella finestra"
            min={2}
            max={50}
            onCambia={(v) => onModifica((c) => void (c.sicurezza.antiSpam.messaggiMax = v))}
          />
          <Numero
            valore={config.sicurezza.antiSpam.finestraSec}
            titolo="Durata della finestra"
            suffisso="s"
            min={2}
            max={120}
            onCambia={(v) => onModifica((c) => void (c.sicurezza.antiSpam.finestraSec = v))}
          />
          <Numero
            valore={config.sicurezza.antiSpam.ripetizioniMax}
            titolo="Ripetizioni dello stesso messaggio"
            min={2}
            max={20}
            onCambia={(v) => onModifica((c) => void (c.sicurezza.antiSpam.ripetizioniMax = v))}
          />
          <Numero
            valore={config.sicurezza.antiSpam.emoteMax}
            titolo="Emote per messaggio"
            min={1}
            max={100}
            onCambia={(v) => onModifica((c) => void (c.sicurezza.antiSpam.emoteMax = v))}
          />
        </div>
      </Riquadro>

      <Riquadro
        titolo="Ondate — cosa fare quando arrivano"
        sottotitolo="Le restrizioni si tolgono da sole alla scadenza. Una chat rimasta chiusa perché nessuno se n’è ricordato fa più danno dell’ondata."
      >
        <div className="divide-y divide-[var(--color-bordo)]/60">
          <Numero
            valore={config.sicurezza.antiRaid.nuoviMax}
            titolo="Sconosciuti che fanno scattare l’allarme"
            min={3}
            max={200}
            onCambia={(v) => onModifica((c) => void (c.sicurezza.antiRaid.nuoviMax = v))}
          />
          <Numero
            valore={config.sicurezza.antiRaid.soloSeguaciDaMinuti}
            titolo="Riservata a chi segue da almeno"
            suffisso="min"
            min={0}
            max={129600}
            onCambia={(v) =>
              onModifica((c) => void (c.sicurezza.antiRaid.soloSeguaciDaMinuti = v))
            }
          />
          <Numero
            valore={config.sicurezza.antiRaid.rallentaSec}
            titolo="Un messaggio ogni"
            suffisso="s"
            min={0}
            max={120}
            onCambia={(v) => onModifica((c) => void (c.sicurezza.antiRaid.rallentaSec = v))}
          />
          <Numero
            valore={config.sicurezza.antiRaid.durataSec}
            titolo="Per quanto restano le restrizioni"
            suffisso="s"
            min={60}
            max={86400}
            onCambia={(v) => onModifica((c) => void (c.sicurezza.antiRaid.durataSec = v))}
          />
        </div>
      </Riquadro>
    </div>
  );
}

/* ── Chat ─────────────────────────────────────────────────────────────── */

function Chat({
  config,
  soloLettura,
  onModifica,
}: {
  config: TwitchChannelConfig;
  soloLettura: boolean;
  onModifica: (ritocchi: (config: TwitchChannelConfig) => void) => void;
}) {
  return (
    <div className="space-y-6">
      <Riquadro
        titolo="Messaggi a tempo"
        sottotitolo="Escono a intervalli regolari, ma solo se la chat si è mossa: senza quella condizione il bot finisce per parlare da solo tutta la sera."
        azione={
          !soloLettura && (
            <Bottone
              onClick={() =>
                onModifica((c) =>
                  c.chat.timer.push({
                    nome: `messaggio ${c.chat.timer.length + 1}`,
                    messaggi: [''],
                    intervalloSec: 900,
                    minRighe: 5,
                    ancheOffline: false,
                    attivo: true,
                  }),
                )
              }
            >
              Aggiungi
            </Bottone>
          )
        }
      >
        {config.chat.timer.length === 0 ? (
          <Vuoto>Nessun messaggio a tempo.</Vuoto>
        ) : (
          <ul className="space-y-4">
            {config.chat.timer.map((timer, indice) => (
              <li
                key={indice}
                className="rounded-lg border border-[var(--color-bordo)] p-4"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <Interruttore
                    acceso={timer.attivo}
                    disabilitato={soloLettura}
                    titolo={timer.nome || 'senza nome'}
                    onCambia={(v) => onModifica((c) => void (c.chat.timer[indice]!.attivo = v))}
                  />
                  {!soloLettura && (
                    <Bottone
                      variante="pericolo"
                      onClick={() => onModifica((c) => void c.chat.timer.splice(indice, 1))}
                    >
                      Togli
                    </Bottone>
                  )}
                </div>

                <Testo
                  valore={timer.nome}
                  titolo="Nome"
                  onCambia={(v) => onModifica((c) => void (c.chat.timer[indice]!.nome = v))}
                />
                <Testo
                  valore={timer.messaggi.join('\n')}
                  titolo="Messaggi"
                  descrizione="Uno per riga: escono a rotazione, così non è sempre lo stesso testo. Puoi usare {canale}."
                  righe={3}
                  onCambia={(v) =>
                    onModifica(
                      (c) =>
                        void (c.chat.timer[indice]!.messaggi = v.split('\n').filter(Boolean)),
                    )
                  }
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Numero
                    valore={timer.intervalloSec}
                    titolo="Ogni"
                    suffisso="s"
                    min={60}
                    max={86400}
                    onCambia={(v) =>
                      onModifica((c) => void (c.chat.timer[indice]!.intervalloSec = v))
                    }
                  />
                  <Numero
                    valore={timer.minRighe}
                    titolo="Solo dopo almeno"
                    suffisso="righe"
                    min={0}
                    max={500}
                    onCambia={(v) => onModifica((c) => void (c.chat.timer[indice]!.minRighe = v))}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Riquadro>

      <Riquadro
        titolo="Comandi"
        sottotitolo="Nella risposta puoi usare {utente}, {canale}, {argomento}, {uptime}."
        azione={
          !soloLettura && (
            <Bottone
              onClick={() =>
                onModifica((c) =>
                  c.chat.comandi.push({
                    nome: `comando${c.chat.comandi.length + 1}`,
                    alias: [],
                    risposta: '',
                    livello: 'TUTTI',
                    cooldownSec: 10,
                    cooldownCanaleSec: 3,
                    attivo: true,
                  }),
                )
              }
            >
              Aggiungi
            </Bottone>
          )
        }
      >
        {config.chat.comandi.length === 0 ? (
          <Vuoto>Nessun comando personalizzato.</Vuoto>
        ) : (
          <ul className="space-y-4">
            {config.chat.comandi.map((comando, indice) => (
              <li key={indice} className="rounded-lg border border-[var(--color-bordo)] p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <code className="text-sm text-[var(--color-accento-forte)]">
                    {config.prefisso}
                    {comando.nome}
                  </code>
                  {!soloLettura && (
                    <Bottone
                      variante="pericolo"
                      onClick={() => onModifica((c) => void c.chat.comandi.splice(indice, 1))}
                    >
                      Togli
                    </Bottone>
                  )}
                </div>
                <Testo
                  valore={comando.nome}
                  titolo="Nome"
                  onCambia={(v) =>
                    onModifica(
                      (c) => void (c.chat.comandi[indice]!.nome = v.toLowerCase().trim()),
                    )
                  }
                />
                <Testo
                  valore={comando.risposta}
                  titolo="Risposta"
                  righe={2}
                  max={450}
                  onCambia={(v) => onModifica((c) => void (c.chat.comandi[indice]!.risposta = v))}
                />
                <Numero
                  valore={comando.cooldownSec}
                  titolo="Attesa per chi lo usa"
                  suffisso="s"
                  min={0}
                  max={3600}
                  onCambia={(v) =>
                    onModifica((c) => void (c.chat.comandi[indice]!.cooldownSec = v))
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Riquadro>

      <Riquadro titolo="Saluti">
        <Testo
          valore={config.sicurezza.primoMessaggio.saluto}
          titolo="A chi scrive per la prima volta"
          descrizione="Lascialo vuoto per non salutare nessuno. Puoi usare {utente}."
          segnaposto="Benvenuto {utente}! ☁︎"
          max={400}
          onCambia={(v) => onModifica((c) => void (c.sicurezza.primoMessaggio.saluto = v))}
        />
        <Testo
          valore={config.chat.salutoRaid}
          titolo="Quando arriva un raid"
          descrizione="Puoi usare {utente} per chi raida e {spettatori} per quanti sono."
          segnaposto="Benvenuti dai {utente}! Siete in {spettatori} ☁︎"
          max={400}
          onCambia={(v) => onModifica((c) => void (c.chat.salutoRaid = v))}
        />
      </Riquadro>

      <Riquadro
        titolo="Comandi del bot in chat"
        sottotitolo="Chi può guidare ANGEL scrivendo !angel in chat. Funziona anche quando questo pannello non è raggiungibile — ed è il motivo per cui esiste."
      >
        <p className="rounded-lg bg-[var(--color-superficie-2)] p-4 font-mono text-xs leading-relaxed text-[var(--color-fioco)]">
          !angel stato · livello alto · prova on · scudo on · permetti discord.gg
          <br />
          !angel silenzia @tizio 600 · bandisci @tizio · timer off
        </p>
      </Riquadro>
    </div>
  );
}

/* ── Registro ─────────────────────────────────────────────────────────── */

function Registro({ canaleId }: { canaleId: string }) {
  const [eventi, setEventi] = useState<Evento[] | null>(null);
  const [errore, setErrore] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Evento[]>(`/api/canali/${canaleId}/eventi?quanti=100`)
      .then(setEventi)
      .catch((err: Error) => setErrore(err.message));
  }, [canaleId]);

  if (errore) return <Errore messaggio={errore} />;
  if (!eventi) return <Caricamento />;

  return (
    <Riquadro
      titolo="Cosa è successo"
      sottotitolo="Ultimi 100 fatti. Il testo dei messaggi rimossi si conserva trenta giorni, poi sparisce da solo."
    >
      {eventi.length === 0 ? (
        <Vuoto>Ancora niente. È una buona notizia.</Vuoto>
      ) : (
        <ul className="divide-y divide-[var(--color-bordo)]/60">
          {eventi.map((evento) => (
            <li key={evento.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
              <span className="w-28 shrink-0 text-xs tabular-nums text-[var(--color-fioco)]">
                {quando(evento.createdAt)}
              </span>
              <Etichetta
                tono={
                  evento.simulated
                    ? 'neutro'
                    : evento.severity >= 70
                      ? 'pericolo'
                      : evento.severity >= 35
                        ? 'attenzione'
                        : 'neutro'
                }
              >
                {evento.simulated ? `${evento.type} (prova)` : evento.type}
              </Etichetta>
              {evento.actorLogin && <span className="text-sm">{evento.actorLogin}</span>}
              {evento.reason && (
                <span className="w-full text-xs leading-relaxed text-[var(--color-fioco)] sm:w-auto sm:flex-1">
                  {evento.reason}
                </span>
              )}
              {evento.text && (
                <code className="w-full rounded bg-[var(--color-superficie-2)] px-2 py-1 text-xs break-all text-[var(--color-fioco)]">
                  {evento.text}
                </code>
              )}
            </li>
          ))}
        </ul>
      )}
    </Riquadro>
  );
}
