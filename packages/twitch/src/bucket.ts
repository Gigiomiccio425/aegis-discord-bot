/* ═══════════════════════════════════════════════════════════════════════
   SECCHIELLI A GETTONI

   Twitch conta tre cose diverse con tre limiti diversi, e sforare uno
   qualsiasi non produce un errore leggibile: produce un silenzio. I messaggi
   spariscono, l'API risponde 429, e nella chat non compare niente — che
   durante un raid è indistinguibile dal bot che ha smesso di funzionare.

   I limiti che contano:

   • **Messaggi in chat**: 20 ogni 30 secondi da account normale, 100 ogni 30
     secondi se il bot è moderatore del canale. La differenza è enorme e
     dipende da una spunta che lo streamer può togliere in qualsiasi momento:
     il secchiello si ridimensiona quando lo stato cambia, invece di dare per
     scontato quello di ieri.

   • **Chiamate Helix**: 800 punti al minuto per applicazione, condivisi fra
     tutti i canali. È il limite che si esaurisce davvero, ed è quello che si
     esaurisce nel momento peggiore — cento timeout in dieci secondi durante
     un'ondata.

   • **Sottoscrizioni EventSub**: non è un limite di frequenza ma di numero,
     e lo gestisce `eventsub.ts`.

   L'attesa è una promessa, non un rifiuto: chi chiede un gettone e non lo
   trova aspetta. Rifiutare significherebbe che il codice chiamante deve
   gestire il caso, e prima o poi da qualche parte non lo gestirebbe.
   ═══════════════════════════════════════════════════════════════════════ */

export interface OpzioniSecchiello {
  /** Gettoni disponibili in una finestra. */
  capacita: number;
  /** Durata della finestra, in millisecondi. */
  finestraMs: number;
  /**
   * Quanto si è disposti ad aspettare prima di rinunciare.
   *
   * Serve per non accumulare una coda infinita: se durante un raid arrivano
   * mille richieste di timeout, quelle che aspetterebbero più di questo
   * tempo vengono lasciate cadere con un errore, perché eseguirle fra due
   * minuti non serve più a niente.
   */
  attesaMassimaMs?: number;
}

export class LimiteSuperato extends Error {
  constructor(attesaMs: number) {
    super(`limite di frequenza: servirebbero ${Math.round(attesaMs / 1000)}s di attesa`);
    this.name = 'LimiteSuperato';
  }
}

/**
 * Secchiello a gettoni con ricarica continua.
 *
 * Continua e non a scatti: con la ricarica a scatti tutti i gettoni tornano
 * insieme allo scadere della finestra, e il bot manda venti messaggi nello
 * stesso millisecondo — che è tecnicamente dentro il limite e in pratica
 * indistinguibile da uno spammer.
 */
export class Secchiello {
  private gettoni: number;
  private ultimoRicarico = Date.now();
  private capacita: number;
  private readonly finestraMs: number;
  private readonly attesaMassimaMs: number;
  /** Coda delle attese, per servirle in ordine di arrivo. */
  private coda: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(opzioni: OpzioniSecchiello) {
    this.capacita = opzioni.capacita;
    this.finestraMs = opzioni.finestraMs;
    this.attesaMassimaMs = opzioni.attesaMassimaMs ?? 30_000;
    this.gettoni = opzioni.capacita;
  }

  /**
   * Cambia la capacità senza perdere lo stato.
   *
   * Succede quando il bot diventa moderatore di un canale: il limite passa da
   * venti a cento messaggi ogni trenta secondi, e ricreare il secchiello
   * regalerebbe cento gettoni immediati a chi ne aveva appena usati venti.
   */
  ridimensiona(capacita: number): void {
    if (capacita === this.capacita) return;
    this.ricarica();
    // I gettoni disponibili crescono della differenza, non fino al massimo.
    this.gettoni = Math.min(capacita, this.gettoni + Math.max(0, capacita - this.capacita));
    this.capacita = capacita;
  }

  /** Gettoni disponibili adesso. Per la diagnostica, non per decidere. */
  disponibili(): number {
    this.ricarica();
    return Math.floor(this.gettoni);
  }

  /** Consuma un gettone se c'è, senza aspettare. */
  provaSubito(costo = 1): boolean {
    this.ricarica();
    if (this.gettoni < costo) return false;
    this.gettoni -= costo;
    return true;
  }

  /** Consuma un gettone, aspettando il tempo necessario. */
  async prendi(costo = 1): Promise<void> {
    this.ricarica();

    if (this.coda.length === 0 && this.gettoni >= costo) {
      this.gettoni -= costo;
      return;
    }

    const attesa = this.attesaStimataMs(costo);
    if (attesa > this.attesaMassimaMs) throw new LimiteSuperato(attesa);

    await new Promise<void>((risolvi) => {
      this.coda.push(risolvi);
      this.avviaTimer();
    });

    this.gettoni -= costo;
  }

  /** Quanto ci vorrebbe, in millisecondi, per servire chi chiede adesso. */
  attesaStimataMs(costo = 1): number {
    this.ricarica();
    const richiesti = this.coda.length * costo + costo;
    const mancanti = richiesti - this.gettoni;
    if (mancanti <= 0) return 0;
    return Math.ceil((mancanti * this.finestraMs) / this.capacita);
  }

  private ricarica(): void {
    const adesso = Date.now();
    const trascorso = adesso - this.ultimoRicarico;
    if (trascorso <= 0) return;

    this.gettoni = Math.min(
      this.capacita,
      this.gettoni + (trascorso * this.capacita) / this.finestraMs,
    );
    this.ultimoRicarico = adesso;
  }

  /**
   * Sveglia chi è in coda appena c'è un gettone.
   *
   * Un timer solo per tutta la coda, non uno per attesa: durante un'ondata la
   * coda può avere centinaia di elementi, e centinaia di `setTimeout`
   * costerebbero più della cosa che stanno aspettando.
   */
  private avviaTimer(): void {
    if (this.timer) return;

    const passo = Math.max(20, Math.ceil(this.finestraMs / this.capacita));
    this.timer = setInterval(() => {
      this.ricarica();

      while (this.coda.length > 0 && this.gettoni >= 1) {
        // Il gettone lo sottrae chi si sveglia, non questo ciclo: qui si
        // conta solo per non svegliare più gente di quanta ne possa passare.
        this.gettoni -= 1;
        this.coda.shift()?.();
        this.gettoni += 1;
        break;
      }

      if (this.coda.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, passo);

    // Il timer non deve tenere vivo il processo: se non resta altro da fare,
    // il bot deve poter uscire.
    this.timer.unref?.();
  }

  /** Ferma il timer. Da chiamare in chiusura. */
  ferma(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const risolvi of this.coda.splice(0)) risolvi();
  }
}

/* ── Limiti dichiarati da Twitch ──────────────────────────────────────── */

/** Messaggi in chat: cambia se il bot è moderatore del canale. */
export function secchielloChat(moderatore: boolean): Secchiello {
  return new Secchiello({
    capacita: moderatore ? 100 : 20,
    finestraMs: 30_000,
    // Un messaggio di chat che arriva dopo venti secondi è fuori contesto:
    // meglio perderlo e dirlo nei log che pubblicarlo quando non c'entra più.
    attesaMassimaMs: 20_000,
  });
}

/**
 * Chiamate Helix: 800 punti al minuto, per applicazione.
 *
 * Uno solo per tutto il processo, non uno per canale: il limite è
 * dell'applicazione, e secchielli separati per canale lo sforerebbero
 * sommandosi senza che nessuno dei due se ne accorga.
 */
export function secchielloHelix(): Secchiello {
  return new Secchiello({ capacita: 800, finestraMs: 60_000, attesaMassimaMs: 45_000 });
}
