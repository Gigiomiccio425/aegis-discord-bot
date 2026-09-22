import { describe, expect, it } from 'vitest';
import {
  componiDocumento,
  FORMATO_LEGGERO,
  impronta,
  leggiDocumento,
  segretiTrovati,
  type DocumentoLeggero,
} from '../backupLeggero.js';

/* ═══════════════════════════════════════════════════════════════════════
   LA COPIA CHE SOPRAVVIVE ALLA MACCHINA

   Un backup si scopre rotto nel momento in cui serve, e allora è tardi. Per
   questo la prova principale qui è il giro completo: quello che si scrive
   deve tornare indietro identico, campo per campo.

   L'altra metà è ciò che deve **rifiutare**. Un file di configurazione
   pubblicato in una chat e riletto senza controlli è un modo per spegnere le
   difese di un server: basta un documento ritoccato. Qui si verifica che un
   segreto non esca, che un file troncato si riconosca, e che un formato più
   nuovo non venga interpretato a metà.
   ═══════════════════════════════════════════════════════════════════════ */

/** Un documento di esempio, con dentro tutto quello che il formato prevede. */
function esempio(modifiche: Partial<DocumentoLeggero> = {}): DocumentoLeggero {
  return {
    formato: FORMATO_LEGGERO,
    angel: '1.29.8',
    guildId: '1272925031034523698',
    guildNome: 'Server di prova',
    creatoIl: '2026-09-21T04:15:00.000Z',
    configurazione: { general: { dryRun: true }, security: { antiRaid: { enabled: true } } },
    ruoli: [
      { id: '1', nome: 'Moderatore', colore: 3447003, posizione: 5, permessi: '8192' },
      { id: '2', nome: '@everyone', colore: 0, posizione: 0, permessi: '104324673' },
    ],
    canali: [
      { id: '10', nome: 'generale', tipo: 0, categoria: 'Chat' },
      { id: '11', nome: 'vocale', tipo: 2, categoria: null },
    ],
    comandi: [{ nome: 'regole', risposta: 'Le trovi in #regolamento', persona: 'seria' }],
    paroleVietate: ['parolaccia', 'insulto'],
    dominiAmmessi: ['discord.gg', 'github.com'],
    sorvegliati: ['586922655349866536'],
    ...modifiche,
  };
}

describe('copia leggera', () => {
  it('quello che scrive torna indietro identico', () => {
    const partenza = esempio();
    const { documento, problemi } = leggiDocumento(componiDocumento(partenza));

    expect(problemi).toEqual([]);
    expect(documento).toEqual(partenza);
  });

  /*
   * Il documento serve a due lettori. Questo è il primo: una persona che lo
   * apre fra un anno e deve capirlo senza strumenti.
   */
  it('si legge anche senza strumenti', () => {
    const testo = componiDocumento(esempio());

    expect(testo).toContain('Server di prova');
    expect(testo).toContain('2026-09-21');
    // I conteggi, non solo i dati grezzi: dicono a colpo d'occhio se il file
    // è quello giusto e se è completo.
    expect(testo).toContain('| Ruoli | 2 |');
    expect(testo).toContain('| Comandi personalizzati | 1 |');
  });

  /*
   * Il guasto peggiore che questo formato può produrre: pubblicare in una
   * chat le credenziali del bot. Meglio nessuna copia.
   */
  it('si rifiuta di comporre se ci finisce dentro un segreto', () => {
    const conSegreto = esempio({
      comandi: [{ nome: 'oops', risposta: 'il token è DISCORD_TOKEN=abc' }],
    });

    expect(() => componiDocumento(conSegreto)).toThrow(/DISCORD_TOKEN/);
  });

  /*
   * E il caso più insidioso: un token senza il nome della variabile accanto,
   * incollato per sbaglio nella risposta di un comando. Nessuna parola chiave
   * da cercare, solo la forma.
   */
  it('riconosce un token anche senza il nome della variabile', () => {
    /*
     * Costruito pezzo per pezzo, e non scritto per intero.
     *
     * Un token di prova scritto intero in un file è un token per GitHub: la
     * protezione sui segreti riconosce la forma, non l'intenzione, e rifiuta
     * il push con GH013. È successo esattamente qui. Assemblandolo a
     * esecuzione, il file non contiene mai quella stringa e il controllo che
     * conta — quello di ANGEL, che gira sul valore — resta identico.
     */
    const finto = ['A'.repeat(24), 'B'.repeat(6), 'C'.repeat(30)].join('.');
    const conToken = esempio({ comandi: [{ nome: 'oops', risposta: `ecco: ${finto}` }] });

    expect(() => componiDocumento(conToken)).toThrow(/token/);
    expect(segretiTrovati(finto)).not.toEqual([]);
  });

  it('un documento pulito non fa scattare il controllo', () => {
    // La controprova: senza, un controllo troppo largo rifiuterebbe tutto e
    // il formato non servirebbe a niente.
    expect(segretiTrovati(componiDocumento(esempio()))).toEqual([]);
  });

  it('un file troncato si riconosce invece di essere letto a metà', () => {
    const intero = componiDocumento(esempio());
    const tagliato = intero.slice(0, Math.floor(intero.length * 0.6));

    const { documento, problemi } = leggiDocumento(tagliato);
    expect(documento).toBeNull();
    expect(problemi.join(' ')).toMatch(/troncato|non è chiuso/);
  });

  it('un file ritoccato lo dice', () => {
    const testo = componiDocumento(esempio()).replace('"dryRun": true', '"dryRun": false');

    const { problemi } = leggiDocumento(testo);
    expect(problemi.join(' ')).toContain('impronta');
  });

  /*
   * Un formato più nuovo si rifiuta. Applicarne metà significherebbe una
   * configurazione che nessuno ha mai deciso — peggio di non ripristinare.
   */
  it('non prova a indovinare un formato più nuovo', () => {
    const futuro = componiDocumento(esempio({ formato: FORMATO_LEGGERO + 1 }));

    const { documento, problemi } = leggiDocumento(futuro);
    expect(documento).toBeNull();
    expect(problemi.join(' ')).toContain('Aggiorna ANGEL');
  });

  it('un file che non è una copia leggera si riconosce subito', () => {
    const { documento, problemi } = leggiDocumento('# Appunti\n\nniente di che');
    expect(documento).toBeNull();
    expect(problemi.join(' ')).toContain('manca il blocco dei dati');
  });

  it('l’impronta cambia se cambia il contenuto', () => {
    expect(impronta('a')).not.toBe(impronta('b'));
    expect(impronta('stesso')).toBe(impronta('stesso'));
  });

  /*
   * Il documento finisce in un allegato Discord. Il limite per un server non
   * migliorato è 10 MB: se la configurazione crescesse fino a sfiorarlo, il
   * backup smetterebbe di essere pubblicato — e nessuno se ne accorgerebbe
   * finché non serve.
   */
  it('un documento normale sta largamente dentro un allegato', () => {
    const grosso = esempio({
      ruoli: Array.from({ length: 200 }, (_, i) => ({
        id: String(i),
        nome: `ruolo-${i}`,
        colore: 0,
        posizione: i,
        permessi: '0',
      })),
      paroleVietate: Array.from({ length: 5_000 }, (_, i) => `parola${i}`),
    });

    const byte = Buffer.byteLength(componiDocumento(grosso), 'utf8');
    expect(byte).toBeLessThan(8 * 1024 * 1024);
  });
});
