export function Login() {
  const error = new URLSearchParams(location.search).get('errore');

  const messages: Record<string, string> = {
    accesso_negato: 'Hai annullato l\'accesso.',
    parametri_mancanti: 'Risposta incompleta da Discord. Riprova.',
    stato_non_valido: 'La richiesta è scaduta o non proviene da questo pannello. Riprova.',
    scambio_fallito: 'Discord ha rifiutato lo scambio del codice. Controlla la configurazione OAuth.',
    utente_non_recuperato: 'Non è stato possibile leggere il tuo profilo Discord.',
    non_autorizzato:
      'Questo pannello è riservato ai proprietari del bot. Il tuo account non è fra quelli abilitati.',
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
        <h1 className="text-2xl font-semibold tracking-wide text-[var(--color-accent-soft)]">
          ANGEL
        </h1>
        <p className="mt-1 text-xs uppercase tracking-[0.2em] text-neutral-500">
          custode del server
        </p>
        <p className="mt-3 text-sm text-neutral-400">
          Veglia, riconosce e interviene. Pannello di controllo per la sicurezza e la moderazione
          del tuo server Discord.
        </p>

        {error && (
          <div className="mt-5 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-sm text-[#f2a3ad]">
            {messages[error] ?? 'Accesso non riuscito.'}
          </div>
        )}

        <a
          href="/api/auth/login"
          className="mt-6 block rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-center text-sm font-medium text-[#14161e] transition-colors hover:bg-[#c2a052]"
        >
          Accedi con Discord
        </a>

        <p className="mt-6 text-xs leading-relaxed text-neutral-500">
          L'accesso richiede i soli permessi <code>identify</code> e <code>guilds</code>: servono a
          sapere chi sei e quali server amministri. Non viene richiesta l'email e non viene letto
          alcun messaggio tramite il tuo account.
        </p>
      </div>
    </main>
  );
}
