import { useCallback, useState } from 'react';
import { api, ApiError } from '../api.js';
import { useInventario } from './pickers.js';

/* ═══════════════════════════════════════════════════════════════════════
   L'ESITO DI UN'AZIONE

   Prima ogni pulsante che chiedeva qualcosa al bot riceveva «ok» un istante
   dopo il clic, prima ancora che il bot sapesse di doverlo fare. Un lockdown
   fallito per un permesso mancante, una quarantena rifiutata da Discord, un
   messaggio in un canale dove il bot non può scrivere: tutto sembrava
   riuscito. Ora il pannello mostra quello che il bot ha risposto davvero.

   Un comando che dura più dell'attesa della richiesta — una predisposizione
   su un server grande — risponde «in corso» con un identificativo, e qui si
   torna a chiedere finché non c'è l'esito.
   ═══════════════════════════════════════════════════════════════════════ */

export interface RispostaAzione {
  ok?: boolean;
  stato?: 'fatto' | 'in-corso' | 'fallito' | 'scaduto';
  messaggio?: string | null;
  id?: string;
  botInLinea?: boolean;
  error?: string;
}

export interface StatoAzione {
  tono: 'ok' | 'attesa' | 'errore';
  testo: string;
}

const pausa = (ms: number): Promise<void> => new Promise((risolvi) => setTimeout(risolvi, ms));

async function seguiEsito(guildId: string, id: string): Promise<RispostaAzione> {
  const fine = Date.now() + 90_000;
  while (Date.now() < fine) {
    await pausa(1_500);
    try {
      const risposta = await api.get<RispostaAzione>(`/api/guilds/${guildId}/bot/esiti/${id}`);
      if (risposta.stato !== 'in-corso') return risposta;
    } catch (errore) {
      // Fallito o scaduto arrivano come errore HTTP con il motivo: sono un
      // esito, non un problema di rete, e vanno mostrati.
      if (errore instanceof ApiError && errore.status !== 401) throw errore;
    }
  }
  return {
    stato: 'in-corso',
    messaggio:
      'Ancora in corso dopo un minuto e mezzo. Il risultato comparirà nel registro eventi.',
  };
}

export function useAzione(guildId: string) {
  const [stato, setStato] = useState<StatoAzione | null>(null);
  const [occupato, setOccupato] = useState(false);

  const esegui = useCallback(
    async (
      richiesta: () => Promise<RispostaAzione | unknown>,
      opzioni: { riuscita?: string; dopo?: () => void } = {},
    ): Promise<boolean> => {
      setOccupato(true);
      setStato(null);
      try {
        let risposta = ((await richiesta()) ?? {}) as RispostaAzione;
        if (risposta.stato === 'in-corso' && risposta.id) {
          setStato({ tono: 'attesa', testo: risposta.messaggio ?? 'In corso…' });
          risposta = await seguiEsito(guildId, risposta.id);
        }
        if (risposta.stato === 'in-corso') {
          setStato({ tono: 'attesa', testo: risposta.messaggio ?? 'In corso…' });
        } else {
          setStato({
            tono: 'ok',
            testo: risposta.messaggio || opzioni.riuscita || 'Fatto.',
          });
        }
        opzioni.dopo?.();
        return true;
      } catch (errore) {
        setStato({ tono: 'errore', testo: (errore as Error).message });
        opzioni.dopo?.();
        return false;
      } finally {
        setOccupato(false);
      }
    },
    [guildId],
  );

  return { esegui, stato, occupato, azzera: () => setStato(null) };
}

const TONI: Record<StatoAzione['tono'], string> = {
  ok: 'border-[var(--color-success,#5fbf8b)]/40 bg-[var(--color-success,#5fbf8b)]/10 text-[#a8e6c3]',
  attesa:
    'border-[var(--color-warning,#d8b45f)]/40 bg-[var(--color-warning,#d8b45f)]/10 text-[#ecd9a3]',
  errore: 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-[#f2a3ad]',
};

/**
 * Il riquadro dell'esito.
 *
 * I messaggi del bot sono scritti per Discord, dove `<#123…>` diventa il nome
 * del canale. Qui lo si traduce con l'inventario, altrimenti chi legge vede
 * una fila di numeri al posto del canale che non si è riusciti a chiudere.
 */
export function EsitoAzione({
  guildId,
  stato,
  onChiudi,
}: {
  guildId: string;
  stato: StatoAzione | null;
  onChiudi?: () => void;
}) {
  const inventario = useInventario(guildId);
  if (!stato) return null;

  const testo = stato.testo
    .replace(/<#(\d+)>/g, (_, id: string) => {
      const canale = inventario.channels.find((c) => c.id === id);
      return canale ? `#${canale.name}` : '#canale';
    })
    .replace(/<@&(\d+)>/g, (_, id: string) => {
      const ruolo = inventario.roles.find((r) => r.id === id);
      return ruolo ? `@${ruolo.name}` : '@ruolo';
    })
    .replace(/<@!?(\d+)>/g, '@utente')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^-# /gm, '');

  return (
    <div
      role={stato.tono === 'errore' ? 'alert' : 'status'}
      className={`flex items-start justify-between gap-3 whitespace-pre-line rounded-lg border p-3 text-sm ${TONI[stato.tono]}`}
    >
      <span>{testo}</span>
      {onChiudi && stato.tono !== 'attesa' && (
        <button
          type="button"
          onClick={onChiudi}
          className="shrink-0 text-xs opacity-70 hover:opacity-100"
          aria-label="Chiudi"
        >
          ✕
        </button>
      )}
    </div>
  );
}
