import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applicaTema,
  salvaScelta,
  sceltaSalvata,
  temaPerScelta,
  type Tema,
} from './temi.js';

/*
 * Lo stato del tema, per tutto il pannello.
 *
 * Il tema si applica anche prima di React, in `main.tsx`, così la pagina non
 * lampeggia col tema predefinito mentre carica. Qui c'è quello che serve
 * dopo: cambiarlo, e seguire il sistema quando la scelta è «Automatico».
 */

const QUERY_CHIARO = '(prefers-color-scheme: light)';

interface StatoTema {
  /** L'id del tema scelto, oppure «auto». */
  scelta: string;
  /** Il tema che si vede davvero. */
  tema: Tema;
  scegli: (scelta: string) => void;
}

const Contesto = createContext<StatoTema | null>(null);

function sistemaChiaro(): boolean {
  return typeof matchMedia === 'function' && matchMedia(QUERY_CHIARO).matches;
}

/** Il tema giusto per il primo disegno, prima che React parta. */
export function applicaTemaIniziale(): void {
  applicaTema(temaPerScelta(sceltaSalvata(), sistemaChiaro()));
}

export function TemaProvider({ children }: { children: ReactNode }) {
  const [scelta, setScelta] = useState(sceltaSalvata);
  const [chiaro, setChiaro] = useState(sistemaChiaro);

  // Il sistema passa da chiaro a scuro — il tramonto, un cambio a mano —
  // e con «Automatico» il pannello lo segue senza ricaricare.
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(QUERY_CHIARO);
    const cambia = (evento: MediaQueryListEvent) => setChiaro(evento.matches);
    query.addEventListener('change', cambia);
    return () => query.removeEventListener('change', cambia);
  }, []);

  const tema = useMemo(() => temaPerScelta(scelta, chiaro), [scelta, chiaro]);

  useEffect(() => {
    applicaTema(tema);
  }, [tema]);

  const valore = useMemo<StatoTema>(
    () => ({
      scelta,
      tema,
      scegli: (nuova) => {
        salvaScelta(nuova);
        setScelta(nuova);
      },
    }),
    [scelta, tema],
  );

  return <Contesto.Provider value={valore}>{children}</Contesto.Provider>;
}

export function useTema(): StatoTema {
  const stato = useContext(Contesto);
  if (!stato) throw new Error('useTema fuori da TemaProvider');
  return stato;
}
