# ═══════════════════════════════════════════════════════════════════════
#  ANGEL — sorvegliante del nodo di emergenza
#
#  Tiene d'occhio il server principale e accende il nodo locale solo quando
#  serve. La regola che governa tutto è una sola:
#
#      IL SERVER PRINCIPALE HA SEMPRE LA PRIORITÀ.
#
#  Non è una preferenza, è un vincolo tecnico. Due bot collegati con lo stesso
#  token ricevono entrambi gli stessi eventi e agiscono entrambi: doppie
#  sanzioni, doppi messaggi, doppie righe di registro. Il nodo locale quindi
#  non si accende finché il principale risponde, e si spegne appena torna —
#  senza chiedere conferma, perché nel tempo che ci vuole a rispondere il
#  danno è già fatto.
#
#  ── Ritmo dei controlli ────────────────────────────────────────────────
#
#  A riposo ogni 30 minuti: il principale sta lavorando, non c'è fretta.
#  In emergenza ogni 2 minuti, perché lì il ritardo ha un costo — è il tempo
#  in cui entrambi i nodi potrebbero risultare attivi insieme.
# ═══════════════════════════════════════════════════════════════════════

param(
  [switch]$auto,
  [switch]$stato
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# ── Impostazioni ─────────────────────────────────────────────────────────
$config = Join-Path $PSScriptRoot 'impostazioni.txt'
$urlPrincipale = 'http://IP_O_NOME_DELLA_TUA_VPS:780'
$attesaNormale = 30      # minuti, quando il principale risponde
$attesaEmergenza = 2     # minuti, quando il nodo locale sta lavorando
$timeoutSec = 8
$tentativiPrimaDiAccendere = 3

if (Test-Path $config) {
  foreach ($riga in Get-Content $config) {
    if ($riga -match '^\s*#') { continue }
    if ($riga -match '^\s*(\w+)\s*=\s*(.+?)\s*$') {
      switch ($Matches[1]) {
        'urlPrincipale' { $urlPrincipale = $Matches[2] }
        'attesaNormale' { $attesaNormale = [int]$Matches[2] }
        'attesaEmergenza' { $attesaEmergenza = [int]$Matches[2] }
        'tentativi' { $tentativiPrimaDiAccendere = [int]$Matches[2] }
      }
    }
  }
}

# La copia personale ha la precedenza: contiene le credenziali vere ed è
# esclusa da git, mentre il file col nome semplice resta il modello con i
# segnaposto. Senza questa distinzione, compilare il modello significherebbe
# ritrovarsi il token in un commit.
$compose = Join-Path $PSScriptRoot 'docker-compose.emergenza.local.yml'
if (-not (Test-Path $compose)) {
  $compose = Join-Path $PSScriptRoot 'docker-compose.emergenza.yml'
}
$registro = Join-Path $PSScriptRoot 'sorveglianza.log'

function Scrivi([string]$testo, [string]$colore = 'Gray') {
  $riga = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $testo
  Write-Host $riga -ForegroundColor $colore
  Add-Content -Path $registro -Value $riga -Encoding utf8
}

# ── Stato del server principale ──────────────────────────────────────────
#
# Un solo tentativo non basta a dichiarare morto un server: una richiesta può
# fallire per un pacchetto perso, per Tailscale che sta riconnettendo, o
# perché il bot si sta riavviando dopo un aggiornamento. Accendere un secondo
# bot per una di queste è peggio del disservizio che si vuole coprire.
function Test-Principale {
  param([int]$tentativi = 1)

  for ($i = 1; $i -le $tentativi; $i++) {
    try {
      $risposta = Invoke-RestMethod -Uri "$urlPrincipale/health" -TimeoutSec $timeoutSec -Method Get
      if ($risposta.ok -eq $true) {
        return @{ vivo = $true; ruolo = $risposta.ruolo; versione = $risposta.versione }
      }
    } catch {
      if ($i -lt $tentativi) { Start-Sleep -Seconds 10 }
    }
  }
  return @{ vivo = $false }
}

function Test-NodoLocale {
  $nomi = docker ps --format '{{.Names}}' 2>$null
  if ($null -eq $nomi) { return $false }
  return ($nomi -contains 'angel-emergenza')
}

# ── Accensione e spegnimento ─────────────────────────────────────────────

function Avvia-Nodo {
  Scrivi 'Il principale non risponde: accendo il nodo di emergenza.' 'Yellow'
  docker compose -f $compose up -d 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Scrivi 'Nodo di emergenza attivo. Pannello locale: http://localhost:781' 'Green'
  } else {
    Scrivi 'Avvio del nodo fallito. Controlla che Docker Desktop sia in esecuzione.' 'Red'
  }
}

function Ferma-Nodo {
  param([switch]$conSincronizzazione)

  if ($conSincronizzazione) {
    Scrivi 'Il principale e tornato: esporto i dati raccolti prima di spegnere.' 'Cyan'
    Esporta-Dati
  }

  Scrivi 'Spengo il nodo di emergenza: la priorita torna al server.' 'Cyan'
  docker compose -f $compose stop 2>&1 | Out-Null

  if ($conSincronizzazione) { Sincronizza }
}

# ── Esportazione e rientro ───────────────────────────────────────────────
#
# L'esportazione la produce il nodo stesso, con lo stesso meccanismo dei
# backup notturni: NDJSON, una riga per record, nella cartella `dati`.
function Esporta-Dati {
  # Il worker esporta all'avvio quando la versione cambia; qui si forza il
  # lavoro subito, perché sta per spegnersi e dopo non ci sarebbe più modo.
  docker exec angel-emergenza node -e "import('/app/apps/worker/dist/jobs/selfBackup.js').then(m => m.runSelfBackup()).then(r => console.log(JSON.stringify(r)))" 2>&1 | Out-Null

  if ($LASTEXITCODE -ne 0) {
    Scrivi 'Esportazione non riuscita: i dati restano nel database locale, che non viene cancellato.' 'Yellow'
  }
}

function Sincronizza {
  $cartelle = Get-ChildItem -Path (Join-Path $PSScriptRoot 'dati') -Directory -Filter 'angel-*' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending

  if (-not $cartelle) {
    Scrivi 'Nessuna esportazione da riportare.' 'Gray'
    return
  }

  $ultima = $cartelle[0].FullName
  Scrivi "Riporto sul server i dati raccolti in emergenza: $($cartelle[0].Name)" 'Cyan'
  Scrivi '' 'Gray'
  Scrivi 'Il rientro va confermato da te dal pannello del server:' 'White'
  Scrivi "  1. apri $urlPrincipale e accedi" 'White'
  Scrivi '  2. Strumenti -> Rientro dal nodo di emergenza' 'White'
  Scrivi "  3. carica la cartella: $ultima" 'White'
  Scrivi '' 'Gray'
  Scrivi 'Non e automatico di proposito: importare significa scrivere nel registro' 'Gray'
  Scrivi 'del server, e va fatto da chi sa cosa e successo mentre era giu.' 'Gray'
}

# ── Un giro di controllo ─────────────────────────────────────────────────

function Controlla {
  $principale = Test-Principale -tentativi $tentativiPrimaDiAccendere
  $locale = Test-NodoLocale

  if ($principale.vivo) {
    if ($principale.ruolo -eq 'emergenza') {
      # Sta rispondendo un nodo di emergenza, non il principale: non è un
      # motivo per spegnere il proprio, ma va detto perché significa che
      # qualcun altro sta già coprendo il disservizio.
      Scrivi 'Attenzione: allindirizzo del principale risponde un nodo di emergenza.' 'Yellow'
      return 'ambiguo'
    }

    if ($locale) {
      Ferma-Nodo -conSincronizzazione
      return 'rientrato'
    }

    Scrivi "Server principale attivo (versione $($principale.versione)). Nodo locale fermo, come deve essere." 'Green'
    return 'normale'
  }

  if ($locale) {
    Scrivi 'Principale ancora giu. Il nodo di emergenza sta lavorando.' 'Yellow'
    return 'emergenza'
  }

  Avvia-Nodo
  return 'attivato'
}

# ── Modalità d'uso ───────────────────────────────────────────────────────

if ($stato) {
  $esito = Controlla
  Write-Host ''
  Write-Host "Esito: $esito"
  exit 0
}

if ($auto) {
  Scrivi 'Sorveglianza avviata. Chiudere questa finestra la interrompe.' 'White'
  while ($true) {
    $esito = Controlla
    $attesa = if ($esito -eq 'emergenza' -or $esito -eq 'attivato') { $attesaEmergenza } else { $attesaNormale }
    Scrivi "Prossimo controllo fra $attesa minuti." 'DarkGray'
    Start-Sleep -Seconds ($attesa * 60)
  }
}

# ── Menu ─────────────────────────────────────────────────────────────────

while ($true) {
  Write-Host ''
  Write-Host '  ANGEL — nodo di emergenza' -ForegroundColor Cyan
  Write-Host '  ─────────────────────────' -ForegroundColor DarkGray
  Write-Host "  Server principale: $urlPrincipale"
  Write-Host ''
  Write-Host '  1  Controlla adesso'
  Write-Host '  2  Avvia la sorveglianza continua (controllo ogni 30 min)'
  Write-Host '  3  Accendi il nodo di emergenza (forzato)'
  Write-Host '  4  Spegni il nodo di emergenza'
  Write-Host '  5  Riporta i dati sul server principale'
  Write-Host '  6  Registro della sorveglianza'
  Write-Host '  0  Esci'
  Write-Host ''
  $scelta = Read-Host '  Scelta'

  switch ($scelta) {
    '1' { Controlla | Out-Null }
    '2' {
      Scrivi 'Sorveglianza avviata. Chiudere questa finestra la interrompe.' 'White'
      while ($true) {
        $esito = Controlla
        $attesa = if ($esito -eq 'emergenza' -or $esito -eq 'attivato') { $attesaEmergenza } else { $attesaNormale }
        Scrivi "Prossimo controllo fra $attesa minuti." 'DarkGray'
        Start-Sleep -Seconds ($attesa * 60)
      }
    }
    '3' {
      # L'accensione forzata esiste per il caso in cui il principale risponde
      # ma non funziona: risponde `/health` e non modera più nulla. Il
      # sorvegliante non può accorgersene, una persona sì.
      $principale = Test-Principale -tentativi 1
      if ($principale.vivo) {
        Write-Host ''
        Write-Host '  Il server principale RISPONDE.' -ForegroundColor Yellow
        Write-Host '  Accendendo il nodo avrai due bot collegati con lo stesso token:' -ForegroundColor Yellow
        Write-Host '  ogni sanzione verra applicata due volte.' -ForegroundColor Yellow
        $conferma = Read-Host '  Scrivi ACCENDI per procedere'
        if ($conferma -ne 'ACCENDI') { continue }
      }
      Avvia-Nodo
    }
    '4' { Ferma-Nodo }
    '5' { Sincronizza }
    '6' {
      if (Test-Path $registro) { Get-Content $registro -Tail 40 } else { Write-Host '  Nessun registro.' }
    }
    '0' { exit 0 }
    default { Write-Host '  Scelta non valida.' -ForegroundColor DarkGray }
  }
}
