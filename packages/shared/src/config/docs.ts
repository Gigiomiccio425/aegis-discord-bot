/* ═══════════════════════════════════════════════════════════════════════
   SPIEGAZIONI DELLA CONFIGURAZIONE

   Il pannello genera i form percorrendo l'oggetto di configurazione: sa il
   nome del campo e il suo tipo, non cosa significa. Il risultato senza questo
   file è una spunta chiamata «Dry run» che nessuno sa se attivare.

   Qui vive il significato. Ogni opzione ha un'etichetta in italiano e una riga
   che dice **cosa succede accendendola** — non una parafrasi del nome. «Dry
   run: modalità prova» non aiuta nessuno; «valuta tutto e registra tutto ma
   non sanziona nessuno» sì.

   La ricerca procede dal più specifico al più generale:

     1. percorso esatto            security.antiRaid.enabled
     2. genitore + chiave          clustering.windowSec
     3. sola chiave                enabled

   Così le decine di campi che si ripetono identici in ogni modulo — le
   esenzioni, le soglie, gli interruttori — sono descritti una volta sola, e
   restano descrivibili singolarmente dove il contesto cambia il senso.

   Un test verifica che ogni singolo campo della configurazione predefinita
   trovi una spiegazione. Aggiungere un'opzione senza descriverla fa fallire la
   suite: è l'unico modo perché questo file non resti indietro.
   ═══════════════════════════════════════════════════════════════════════ */

export interface FieldDoc {
  /** Etichetta mostrata al posto del nome tecnico. */
  label: string;
  /** Riga di spiegazione sotto il controllo. Dice cosa cambia, non cos'è. */
  help: string;
}

/* ── Percorsi esatti ───────────────────────────────────────────────────
   Solo dove la stessa parola significa cose diverse a seconda di dove si
   trova, o dove il campo merita una spiegazione più lunga della media. */
const BY_PATH: Record<string, FieldDoc> = {
  version: {
    label: 'Versione dello schema',
    help: 'Numero interno usato dalle migrazioni della configurazione. Non modificarlo.',
  },

  'general.masterEnabled': {
    label: 'Protezione attiva',
    help:
      'Interruttore generale. Spento, ogni modulo smette di valutare e nessuna sanzione parte, ' +
      'ma la configurazione resta intatta e il registro continua a scrivere. Diverso dalla ' +
      'modalità prova: quella fa girare tutto e trattiene solo la sanzione finale.',
  },
  'general.dryRun': {
    label: 'Modalità prova',
    help:
      'I moduli valutano e registrano tutto ma non sanzionano nessuno. Serve a tarare le soglie ' +
      'per qualche giorno guardando cosa *avrebbe* fatto il bot, prima di lasciarlo agire davvero.',
  },
  'general.staffRoleIds': {
    label: 'Ruoli dello staff',
    help:
      'Chi ha uno di questi ruoli è esente dai moduli e riceve gli avvisi. Servono anche al ' +
      'confronto anti-impersonificazione: un nuovo arrivato con un nome simile viene segnalato.',
  },
  'general.quarantineRoleId': {
    label: 'Ruolo di quarantena',
    help:
      'Il ruolo assegnato a chi viene isolato: deve poter solo leggere. Senza, la quarantena ' +
      'non si applica e nel registro compare un avviso invece della sanzione.',
  },
  'general.alertChannelId': {
    label: 'Canale degli avvisi urgenti',
    help:
      'Dove finiscono raid, nuke, quarantene e utenti attenzionati, separati dal registro ' +
      'ordinario. Va tenuto privato: contiene il dettaglio di ciò che le difese hanno visto.',
  },
  'general.alertRoleId': {
    label: 'Ruolo da menzionare',
    help: 'Menzionato solo sugli eventi critici. Se lo si menziona per tutto, smette di funzionare.',
  },
  'general.staffCodeword': {
    label: 'Parola d\'ordine dello staff',
    help:
      'Verificabile con /verifica-staff. È la sola difesa pratica contro la voce clonata: ' +
      'nessun software distingue un deepfake vocale, una parola concordata in anticipo sì.',
  },
  'general.locale': { label: 'Lingua', help: 'Lingua dei messaggi del bot: italiano o inglese.' },
  'general.timezone': {
    label: 'Fuso orario',
    help: 'Usato per gli orari nei log e negli annunci. Formato IANA, es. Europe/Rome.',
  },

  'general.actionNotice.enabled': {
    label: 'Avvisa in chat le sanzioni',
    help:
      'Scrive nel canale cosa è stato fatto e perché. Serve perché il DM da un bot spesso non ' +
      'arriva: senza, chi viene zittito non sa perché, e chi guarda vede solo un messaggio sparire.',
  },
  'general.actionNotice.channelId': {
    label: 'Canale dell\'avviso',
    help: 'Vuoto = nello stesso canale del fatto, che è quasi sempre la scelta giusta.',
  },
  'general.actionNotice.deleteAfterSec': {
    label: 'Cancella l\'avviso dopo',
    help: 'Secondi dopo i quali il cartellino sparisce. 0 = resta. Serve a non riempire la cronologia.',
  },

  'general.autoProvision': {
    label: 'Prepara il server da solo',
    help:
      'Crea i ruoli e i canali che servono alle funzioni, e ne compila gli ID qui. ' +
      'Entrando in un server nuovo crea tutto; agli avvii successivi riempie solo i campi ' +
      'rimasti vuoti, senza ricreare ciò che hai eliminato di proposito.',
  },

  'general.identity.username': {
    label: 'Nome del bot',
    help:
      'Cambia il nome in **tutti** i server dove il bot è presente, non solo in questo: Discord ' +
      'non permette un nome per server. Vuoto = non lo tocca. Massimo due cambi all\'ora.',
  },
  'general.identity.avatarUrl': {
    label: 'Immagine del profilo',
    help: 'Indirizzo https di un\'immagine. Anche questa è globale. Vuoto = non la tocca.',
  },
  'general.identity.bannerUrl': {
    label: 'Banner del profilo',
    help: 'Richiede che l\'applicazione supporti il banner. Vuoto = non lo tocca.',
  },
  'general.identity.nickname': {
    label: 'Soprannome in questo server',
    help:
      'L\'unica parte dell\'identità che vale solo qui: se vuoi che il bot si chiami diversamente ' +
      'da un server all\'altro, è questo il campo. Vuoto = usa il nome globale.',
  },
  'general.identity.status': {
    label: 'Stato',
    help: 'Il pallino accanto al nome: online, assente, non disturbare, invisibile.',
  },
  'general.identity.activityType': {
    label: 'Tipo di attività',
    help:
      'CUSTOM mostra solo il testo. Le altre antepongono «Sta giocando a», «Sta guardando», ' +
      '«Sta ascoltando», «In competizione in».',
  },
  'general.identity.activityText': {
    label: 'Testo dell\'attività',
    help: 'Cosa compare sotto il nome. Variabili: {server} e {membri}.',
  },

  'general.ownerRole.enabled': {
    label: 'Ruolo del proprietario',
    help:
      'Crea un ruolo e lo assegna a chi è elencato in OWNER_IDS, ricreandolo se qualcuno lo ' +
      'elimina. Serve a non restare chiusi fuori dal proprio server. Attenzione: vale in **ogni** ' +
      'server dove il bot entra, senza che il proprietario di quel server debba approvare.',
  },
  'general.ownerRole.name': {
    label: 'Nome del ruolo',
    help: 'Il ruolo viene cercato per nome: rinominandolo qui, alla prossima verifica ne nasce uno nuovo.',
  },
  'general.ownerRole.color': {
    label: 'Colore',
    help: 'Formato #rrggbb. Determina anche il colore del nome nella lista membri.',
  },
  'general.ownerRole.hoist': {
    label: 'Mostra separatamente',
    help: 'Chi ha il ruolo compare in una sezione a parte nella lista dei membri.',
  },
  'general.ownerRole.permissions': {
    label: 'Poteri del ruolo',
    help:
      'NESSUNO è solo un contrassegno e per quasi tutti i casi basta: i poteri li dà già l\'essere ' +
      'proprietario del server. AMMINISTRATORE significa che un token rubato del bot equivale al ' +
      'server perso, ed è il motivo per cui non è predefinito.',
  },
  'general.ownerRole.reapply': {
    label: 'Ricrea se eliminato',
    help:
      'Rimette il ruolo e lo riassegna a ogni avvio. È il punto del modulo: senza, basta ' +
      'eliminarlo una volta perché non torni mai più.',
  },

  'security.language.categories.VOLGARITA': {
    label: 'Volgarita',
    help:
      'Imprecazioni non rivolte a nessuno. Su molti server fanno parte del tono, e vietarle '
      + 'significa moderare una comunita che non esiste: si spegne qui, senza toccare il resto.',
  },
  'security.language.categories.INSULTO': {
    label: 'Insulti',
    help: 'Parole che esistono per essere dette a qualcuno. E il nucleo del flame.',
  },
  'security.language.categories.DISCRIMINAZIONE': {
    label: 'Discriminazione',
    help:
      'Attacchi a origine, orientamento, disabilita, genere, religione. Non e una questione di '
      + 'tono: colpisce chiunque legga e si riconosca in quella categoria, non solo chi era il '
      + 'bersaglio, ed e la ragione per cui le persone se ne vanno e non tornano.',
  },
  'security.language.categories.MINACCIA': {
    label: 'Minacce',
    help: 'Dichiarazioni di intenzione a fare del male. Vanno viste da una persona, non solo sanzionate.',
  },
  'security.language.categories.AUTOLESIONISMO': {
    label: 'Autolesionismo',
    help:
      'Le stesse parole possono essere un insulto o la richiesta di aiuto di chi parla di se. '
      + 'Categoria separata proprio per questo: conviene portarla al solo avviso allo staff, '
      + 'perche zittire chi stava chiedendo aiuto e la cosa peggiore che il bot possa fare.',
  },
  'security.language.categories.BESTEMMIA': {
    label: 'Bestemmie',
    help:
      'In molti server italiani e la sola regola non negoziabile. Le combinazioni sono infinite: '
      + 'l elenco copre le forme ricorrenti, le altre si aggiungono qui.',
  },
  'security.language.categories.SESSUALE': {
    label: 'Contenuto sessuale',
    help:
      'Spenta di default: su un server di adulti la conversazione sessuale puo essere legittima, '
      + 'e accenderla senza chiedere significa moderare una comunita che non si conosce.',
  },
  'security.flame.messaggio': {
    label: 'Testo dell avviso',
    help:
      'Cosa scrive il bot quando rallenta il canale. Variabile disponibile: {secondi}. Conviene ' +
      'un tono che non accusi nessuno: chi litiga e gia sulla difensiva, e un cartellino che ' +
      'suona come un rimprovero riaccende invece di spegnere.',
  },

  'security.verification.unverifiedRoleId': {
    label: 'Ruolo di chi non ha verificato',
    help:
      'Assegnato a chiunque entri, finche non preme il pulsante. E distinto dal ruolo di ' +
      'quarantena di proposito: non aver ancora verificato e la condizione normale di chi arriva, ' +
      'la quarantena e un provvedimento. Usare lo stesso ruolo accoglierebbe ogni nuovo membro ' +
      'con un ruolo che dice «sospetto», e riempirebbe l elenco dei quarantenati di persone che ' +
      'non hanno fatto nulla.',
  },
  'security.verification.quarantineRoleId': {
    label: 'Ruolo d ingresso (vecchio campo)',
    help:
      'Usato solo se il campo qui sopra e vuoto, per le configurazioni salvate prima della 1.8, ' +
      'quando i due ruoli erano lo stesso. Su un server nuovo lascialo vuoto.',
  },

  'security.language.rimuoviSempre': {
    label: 'Rimuovi sempre il messaggio',
    help:
      'Il messaggio sparisce qualunque sia il punteggio. Non e una sanzione: finche la frase ' +
      'resta pubblicata continua a fare quello che faceva. Spegnerlo significa lasciare in chat ' +
      'cio che il filtro ha appena riconosciuto come offensivo.',
  },
  'security.language.recidiva.finestraMinuti': {
    label: 'Per quanto si ricorda un episodio',
    help:
      'Minuti. La finestra si rinnova a ogni infrazione: e «dall ultima volta», non «dalla prima», ' +
      'altrimenti chi continua uscirebbe dal conteggio solo perche il primo episodio e lontano. ' +
      'Chi ha detto una parolaccia il mese scorso ricomincia da capo.',
  },
  'security.language.recidiva.scala': {
    label: 'Cosa fare alla n-esima volta',
    help:
      'La progressione. La prima volta non compare qui di proposito: il messaggio e gia stato ' +
      'rimosso, e aggiungere una sanzione a chi si e lasciato sfuggire una parola insegna solo ' +
      'che il bot e ostile. Le durate vengono moltiplicate per la gravita.',
  },

  'security.antiRaid.autoLiftAfterSec': {
    label: 'Revoca automatica del blocco',
    help:
      'Secondi dopo i quali il lockdown scattato da solo si revoca da solo. 0 = resta finché ' +
      'qualcuno interviene. Il conto alla rovescia sopravvive al riavvio del bot.',
  },
  'security.antiRaid.lockdownBatchSize': {
    label: 'Canali per lotto',
    help:
      'Quanti canali bloccare insieme. Discord accetta poche modifiche di permessi al secondo: ' +
      'mandarne duecento in una volta le accoda tutte e le ultime arrivano a raid finito.',
  },
  'security.antiRaid.clustering.windowSec': {
    label: 'Finestra del gruppo',
    help: 'Secondi entro cui gli ingressi simili fra loro contano come un unico gruppo sospetto.',
  },
  'security.antiRaid.clustering.newAccountHours': {
    label: 'Account nuovo sotto le',
    help: 'Ore dalla creazione sotto le quali un account entra nel conteggio del gruppo sospetto.',
  },

  'security.antiSpam.maxAttachmentsPerMessage': {
    label: 'Allegati per messaggio',
    help: 'Oltre questo numero il messaggio conta come spam. Discord ne consente dieci.',
  },
  'security.antiSpam.imageRate.count': {
    label: 'Allegati consentiti',
    help:
      'Quanti allegati puo inviare una persona nella finestra qui sotto. Si contano gli allegati ' +
      'e non i messaggi: dieci immagini in un messaggio e dieci messaggi da un immagine hanno lo ' +
      'stesso effetto su chi legge.',
  },
  'security.antiSpam.purgeOnMuteMinutes': {
    label: 'Minuti da ripulire al silenziamento',
    help:
      'Quando qualcuno viene silenziato, espulso o bandito per spam, i suoi messaggi degli ultimi ' +
      'N minuti vengono eliminati. Silenziare ferma il seguito ma lascia in piedi il muro gia ' +
      'scritto: il canale resta illeggibile e chi arriva dopo lo trova comunque. 0 = non elimina.',
  },

  'security.antiSpam.messageRate.count': {
    label: 'Messaggi consentiti',
    help: 'Quanti messaggi può inviare una persona nella finestra qui sotto prima di essere fermata.',
  },
  'security.antiSpam.duplicateMessages.count': {
    label: 'Ripetizioni consentite',
    help: 'Quante volte lo stesso testo può comparire prima che scatti la scala di risposta.',
  },
  'security.antiSpam.crossChannelSpam.count': {
    label: 'Canali consentiti',
    help:
      'In quanti canali diversi può comparire lo stesso messaggio. È la firma tipica dell\'account ' +
      'compromesso che sta diffondendo uno scam.',
  },
  'security.antiSpam.mentionRate.count': {
    label: 'Menzioni consentite in totale',
    help: 'Quante menzioni può fare una persona nella finestra, sommando tutti i suoi messaggi.',
  },

  'security.accountGuard.staffRoleIds': {
    label: 'Ruoli da proteggere dall\'imitazione',
    help:
      'I nomi e gli avatar dei nuovi arrivati vengono confrontati con quelli di chi ha questi ' +
      'ruoli. Chi somiglia troppo a un moderatore prende punti di rischio.',
  },
  'security.accountGuard.newAccountHours': {
    label: 'Account nuovo sotto le',
    help: 'Ore dalla creazione sotto le quali l\'account è considerato nuovo e prende punti di rischio.',
  },

  'scanner.image.enabled': {
    label: 'Analizza le immagini',
    help:
      'Un PNG su Discord non esegue codice: le immagini truffa sono veicoli di *link*, scritti ' +
      'sopra o dentro un QR. Lo scanner estrae quei link e li verifica.',
  },
  'scanner.file.enabled': {
    label: 'Analizza gli allegati',
    help:
      'Qui il controllo è reale e non sui link: si verifica che il contenuto del file corrisponda ' +
      'all\'estensione dichiarata.',
  },
  'scanner.clickfix.enabled': {
    label: 'Rileva ClickFix',
    help:
      'La finta CAPTCHA che dice «premi Win+R, incolla, Invio»: negli appunti c\'è già PowerShell ' +
      'offuscato. Cercato nel testo e dentro gli screenshot, perché arriva in entrambe le forme.',
  },
  'scanner.url.enabled': {
    label: 'Analizza i link',
    help: 'Estrae ogni indirizzo dai messaggi, ne segue i redirect e ne verifica la reputazione.',
  },

  'logging.enabled': {
    label: 'Registro attivo',
    help:
      'Spegnendolo restano solo gli eventi critici. Gli altri non vengono più salvati da nessuna ' +
      'parte: è una perdita definitiva, non una pausa.',
  },
  'logging.retentionDays': {
    label: 'Conservazione per categoria',
    help: 'Giorni di permanenza nel database, categoria per categoria. 0 = per sempre.',
  },
};

/* ── Chiavi ricorrenti ─────────────────────────────────────────────────
   Descritte una volta e valide ovunque compaiano. */
const BY_KEY: Record<string, FieldDoc> = {
  /* Struttura comune a tutti i moduli */
  enabled: {
    label: 'Attivo',
    help: 'Accende o spegne questa funzione. Da spenta non valuta nulla e non consuma risorse.',
  },
  alertChannelId: {
    label: 'Canale degli avvisi',
    help: 'Canale dedicato a questo modulo. Vuoto = usa il canale avvisi generale.',
  },
  roleIds: { label: 'Ruoli esentati', help: 'Chi ha uno di questi ruoli non viene mai valutato.' },
  userIds: { label: 'Utenti esentati', help: 'Persone mai valutate da questo modulo.' },
  channelIds: { label: 'Canali esentati', help: 'Canali in cui questo modulo non interviene.' },
  verifiedBots: {
    label: 'Esenta i bot verificati',
    help: 'I bot con il badge ufficiale di Discord non vengono valutati.',
  },
  administrators: {
    label: 'Esenta gli amministratori',
    help:
      'Sconsigliato: un account amministratore compromesso è il vettore tipico dei nuke, ed è ' +
      'esattamente quello che questo modulo dovrebbe fermare.',
  },
  count: { label: 'Quantità', help: 'Quanti eventi servono, nella finestra qui sotto, per far scattare la regola.' },
  windowSec: { label: 'Finestra (secondi)', help: 'Arco di tempo su cui si contano gli eventi.' },
  action: { label: 'Cosa fare', help: 'Provvedimento applicato quando la regola scatta.' },
  ladder: {
    label: 'Scala di risposta',
    help:
      'A ogni soglia di punteggio corrisponde un provvedimento; si applica quello della soglia ' +
      'più alta raggiunta. Ordinata dal punteggio più basso al più alto.',
  },
  threshold: { label: 'Soglia', help: 'Valore oltre il quale la regola si considera superata.' },
  channelId: { label: 'Canale', help: 'Canale usato da questa funzione.' },
  mode: { label: 'Modalità', help: 'Come funziona la verifica all\'ingresso.' },
  format: { label: 'Formato', help: 'TXT si legge a occhio e con grep, JSONL si analizza con jq.' },
  patterns: {
    label: 'Espressioni riconosciute',
    help: 'Espressioni regolari cercate nel testo e nell\'OCR. Una riga per espressione.',
  },
  emoji: { label: 'Emoji', help: 'Emoji che conta come voto. Unicode oppure <:nome:id> per le personalizzate.' },

  /* Avviso pubblico delle sanzioni */
  mentionTarget: {
    label: 'Menziona la persona',
    help: 'Senza, l\'avviso resta più discreto e cita solo il nome.',
  },
  showReason: { label: 'Mostra il motivo', help: 'Include perché la sanzione è scattata.' },
  showModule: {
    label: 'Mostra il modulo',
    help: 'Indica quale difesa ha deciso. Utile mentre si tarano le soglie, rumoroso a regime.',
  },
  announceDeletions: {
    label: 'Avvisa anche per i messaggi rimossi',
    help: 'Spegnendolo, le semplici eliminazioni avvengono in silenzio.',
  },
  announceDryRun: {
    label: 'Avvisa anche in modalità prova',
    help: 'Pubblica il cartellino indicando che la sanzione è stata solo simulata.',
  },
  deleteAfterSec: { label: 'Cancella dopo (secondi)', help: '0 = il messaggio resta.' },

  /* Anti-raid */
  nameSimilarity: {
    label: 'Somiglianza fra i nomi',
    help:
      'Da 0 a 1. Quanto devono assomigliarsi due nomi per contare come stesso gruppo. 0,85 ' +
      'riconosce «utente_a1» e «utente_a2» senza accomunare nomi normali.',
  },
  minClusterSize: {
    label: 'Quanti simili fanno un gruppo',
    help: 'Numero di ingressi somiglianti fra loro sotto il quale non scatta nulla.',
  },
  responseLevel: {
    label: 'Livello di risposta',
    help:
      'Fin dove può spingersi il bot da solo: solo osservare, chiedere una verifica, isolare, ' +
      'oppure bloccare l\'intero server.',
  },
  raiderAction: {
    label: 'Cosa fare ai partecipanti',
    help: 'Provvedimento applicato a chi viene riconosciuto come parte del raid.',
  },
  pauseInvites: {
    label: 'Sospendi gli inviti',
    help:
      'La parte decisiva del blocco: senza, i nuovi account continuano ad arrivare mentre si ' +
      'ripulisce quanto è già entrato.',
  },
  lockChannels: {
    label: 'Metti i canali in sola lettura',
    help: 'Toglie a @everyone il permesso di scrivere, restituendolo alla revoca.',
  },
  lockdownExemptChannels: {
    label: 'Canali da non bloccare',
    help: 'Restano scrivibili durante il blocco. Utile per un canale di annunci o di emergenza.',
  },
  announceLockdown: {
    label: 'Annuncia il blocco nei canali',
    help:
      'Scrive in ogni canale bloccato cosa sta succedendo. Senza, chi stava scrivendo vede il ' +
      'campo diventare inerte e non sa se è stato zittito lui o se è rotto qualcosa.',
  },
  lockdownMessage: {
    label: 'Testo del blocco',
    help: 'Pubblicato in ogni canale chiuso. Variabili disponibili: {motivo} e {durata}.',
  },
  lockdownLiftMessage: {
    label: 'Testo della revoca',
    help: 'Prende il posto dell\'avviso precedente, nello stesso messaggio.',
  },
  useBulkBan: {
    label: 'Ban di massa in un\'unica chiamata',
    help:
      'Fino a 200 persone per chiamata invece di una per volta: evita il rate limit proprio ' +
      'quando la velocità conta.',
  },
  banDeleteMessageDays: {
    label: 'Giorni di messaggi da cancellare',
    help: 'Al ban di un raider elimina anche quanto ha scritto negli ultimi N giorni. Massimo 7.',
  },

  usePresetProfanity: {
    label: 'Parolacce (elenco Discord)',
    help:
      'Usa l\'elenco multilingue mantenuto da Discord. Vale piu di qualunque elenco proprio ' +
      'per una ragione sola: blocca il messaggio prima che venga pubblicato, mentre un bot lo ' +
      'vede solo dopo — e nel frattempo qualcuno lo ha gia letto.',
  },
  usePresetSlurs: {
    label: 'Insulti discriminatori (elenco Discord)',
    help: 'Elenco separato dalle parolacce comuni: copre gli insulti rivolti a categorie di persone.',
  },
  usePresetSexual: {
    label: 'Contenuti sessuali (elenco Discord)',
    help: 'Spento di default: su molti server produce falsi positivi in conversazioni normali.',
  },
  terms: {
    label: 'Elenco proprio',
    help:
      'Le tue parole, ciascuna con la sua gravita. Vengono riconosciute anche scritte in forma ' +
      'elusiva: c4zz0, c-a-z-z-o, cazzooooo, lettere spaziate.',
  },
  allowlist: {
    label: 'Parole sempre ammesse',
    help:
      'Parole legittime che ne contengono un\'altra: «cazzuola» contiene «cazzo». Vincono sempre, ' +
      'sia sull\'elenco proprio sia su quello di Discord. Un filtro che blocca chi parla di ' +
      'edilizia insegna in un pomeriggio che il bot va ignorato.',
  },
  targetedBonus: {
    label: 'Supplemento se rivolto a qualcuno',
    help:
      'Punti in piu quando il messaggio menziona una persona o risponde a lei. E la differenza fra ' +
      'imprecare e aggredire: senza, chi si e dato una martellata sul dito viene trattato come chi ' +
      'sta insultando un altro membro.',
  },
  exemptChannelIds: {
    label: 'Canali esclusi',
    help: 'Il filtro non interviene qui. Utile per un canale di sfogo fra adulti consenzienti.',
  },
  weights: {
    label: 'Peso delle gravita',
    help: 'Quanti punti vale ciascun livello. La somma decide quale gradino della scala scatta.',
  },
  LIEVE: { label: 'Lieve', help: 'Imprecazioni comuni, non rivolte a nessuno.' },
  MEDIA: { label: 'Media', help: 'Insulti veri e propri.' },
  GRAVE: { label: 'Grave', help: 'Insulti discriminatori e incitazioni all\'autolesionismo.' },
  severity: { label: 'Gravita', help: 'Quanto pesa questa voce nel punteggio del messaggio.' },
  substring: {
    label: 'Cerca dentro le parole',
    help:
      'Da usare con parsimonia: e l\'opzione che produce i falsi positivi. Serve solo per sequenze ' +
      'che non compaiono in nessuna parola legittima.',
  },
  term: { label: 'Parola', help: 'La voce da riconoscere. Gli accenti e le maiuscole non contano.' },

  sogliaMessaggio: {
    label: 'Soglia di ostilita del messaggio',
    help:
      'Quanto deve risultare aggressivo un messaggio per entrare nel conteggio. Alzarla riduce '
      + 'gli interventi ma lascia passare i litigi piu pacati; abbassarla li intercetta prima, '
      + 'con qualche rallentamento di troppo.',
  },
  messaggiPerScatto: {
    label: 'Messaggi ostili per intervenire',
    help:
      'Quanti ne servono nella finestra. Servono comunque almeno due persone diverse: uno che si '
      + 'sfoga da solo non e un litigio, ed e la distinzione che evita di rallentare un canale '
      + 'per una giornata storta.',
  },
  finestraSec: {
    label: 'Finestra di osservazione',
    help: 'Arco di tempo su cui si contano i messaggi ostili.',
  },
  rallentaCanale: {
    label: 'Rallenta il canale',
    help:
      'L intervento principale, e volutamente non una sanzione: silenziare chi litiga punisce '
      + 'allo stesso modo chi ha cominciato e chi ha risposto, e non impedisce che ricomincino '
      + 'altrove. Togliere la rapidita toglie cio di cui la spirale si nutre.',
  },
  slowmodeSec: {
    label: 'Secondi fra un messaggio e l altro',
    help: 'Quanto rallentare. Quindici secondi bastano a spezzare il ritmo senza fermare la conversazione.',
  },
  durataSlowmodeSec: {
    label: 'Durata del rallentamento',
    help: 'Dopo questo tempo il canale torna al valore che aveva prima.',
  },
  avvisaInCanale: {
    label: 'Spiega perche il canale rallenta',
    help:
      'Senza, il rallentamento sembra un guasto e qualcuno lo chiede allo staff. Con l avviso, '
      + 'la maggior parte delle discussioni si raffredda da sola.',
  },
  raffreddamentoSec: {
    label: 'Attesa fra due interventi',
    help:
      'Tempo minimo prima che il modulo possa intervenire di nuovo sullo stesso canale. Senza, '
      + 'un litigio che prosegue riempirebbe il canale di cartellini del bot invece che di '
      + 'conversazione — il contrario dell obiettivo.',
  },
  cancellaAvvisoSec: {
    label: 'Cancella l avviso dopo',
    help: 'Secondi dopo i quali il messaggio del bot sparisce. 0 = resta.',
  },
  infrazioni: {
    label: 'Alla volta numero',
    help: 'Quante infrazioni servono nella finestra perche scatti questo gradino.',
  },
  moltiplicatori: {
    label: 'Peso della gravita',
    help:
      'Moltiplica la durata del silenziamento. La stessa recidiva vale dieci minuti per una ' +
      'parolaccia e quaranta per un insulto razzista: la progressione e la stessa, il peso no.',
  },

  /* Anti-nuke */
  botIds: { label: 'Bot in lista bianca', help: 'Bot le cui azioni non fanno mai scattare le soglie.' },
  dangerousPermissions: {
    label: 'Permessi considerati pericolosi',
    help: 'Chi li possiede è sorvegliato e, se scatta una regola, li perde per primo.',
  },
  emergencySnapshot: {
    label: 'Backup immediato al primo allarme',
    help: 'Salva la struttura del server prima che il danno prosegua. Costa pochi secondi.',
  },
  autoRestore: {
    label: 'Ripristina da solo canali e ruoli',
    help:
      'Ricrea ciò che è stato appena cancellato usando l\'ultimo backup. Spento di default: un ' +
      'ripristino sbagliato durante un attacco in corso peggiora la confusione.',
  },
  banOffender: {
    label: 'Bandisci chi ha fatto scattare la regola',
    help:
      'Irreversibile, e spesso ingiusto: chi provoca un nuke è frequentemente la vittima di un ' +
      'furto di token, non l\'attaccante. Togliere i ruoli ferma il danno lo stesso.',
  },

  /* Anti-spam */
  mentionsPerMessage: { label: 'Menzioni per messaggio', help: 'Oltre questo numero il messaggio è spam.' },
  maxEmojisPerMessage: { label: 'Emoji per messaggio', help: 'Limite ai muri di emoji.' },
  maxLinesPerMessage: { label: 'Righe per messaggio', help: 'Limite ai messaggi che occupano l\'intero schermo.' },
  capsPercent: { label: 'Percentuale di maiuscole', help: 'Oltre questa quota il messaggio conta come urlato.' },
  capsMinLength: {
    label: 'Lunghezza minima per il controllo maiuscole',
    help: 'Sotto questa lunghezza le maiuscole sono ignorate: «OK» non è urlare.',
  },
  blockZalgo: {
    label: 'Blocca il testo deformato',
    help: 'I caratteri combinanti che invadono le righe vicine, usati per rendere illeggibile la chat.',
  },
  blockEveryoneAbuse: { label: 'Blocca l\'abuso di @everyone', help: 'Tentativi ripetuti di menzionare tutti.' },
  blockInvites: { label: 'Blocca gli inviti', help: 'Inviti Discord non autorizzati nei messaggi.' },
  newMemberMinutes: {
    label: 'Sorveglianza rafforzata per i primi',
    help: 'Minuti dall\'ingresso durante i quali le soglie sono più severe. Lo spam arriva quasi tutto lì.',
  },
  newMemberMultiplier: {
    label: 'Quanto più severe',
    help: 'Moltiplicatore del punteggio nei primi minuti. 2 significa il doppio del peso.',
  },

  /* Account compromessi */
  dormantDays: {
    label: 'Giorni di silenzio',
    help: 'Dopo quanti giorni di inattività un ritorno improvviso con link o immagini è sospetto.',
  },
  dormantThenLink: { label: 'Silenzio, poi un link', help: 'Punti per chi torna dopo mesi e il primo messaggio è un link.' },
  sameMessageManyChannels: { label: 'Stesso messaggio ovunque', help: 'Punti per lo stesso testo in più canali.' },
  imageWithUrl: { label: 'Immagine con link', help: 'Punti per un\'immagine accompagnata da un indirizzo.' },
  knownScamKeywords: { label: 'Parole delle campagne note', help: 'Punti per le frasi ricorrenti delle truffe.' },
  firstMessageIsLink: { label: 'Primo messaggio, un link', help: 'Punti per chi esordisce con un indirizzo.' },
  mentionsEveryoneWithLink: { label: '@everyone con link', help: 'Punti per la combinazione più usata dagli account rubati.' },
  containsQrCode: { label: 'Contiene un QR', help: 'Punti per un QR in chat: quasi mai innocuo in una conversazione scritta.' },
  scamKeywords: {
    label: 'Parole delle campagne',
    help: 'Elenco modificabile. Sono le frasi osservate nelle ondate reali degli ultimi mesi.',
  },
  quarantineAtScore: { label: 'Isola sopra il punteggio', help: 'Oltre questa soglia scattano quarantena e pulizia.' },
  purgeHours: { label: 'Ore di messaggi da rimuovere', help: 'Quanto indietro ripulire quando un account risulta compromesso.' },
  notifyUser: {
    label: 'Spiega all\'interessato cosa fare',
    help: 'Messaggio privato con le istruzioni per mettere in sicurezza l\'account.',
  },

  /* Controllo account */
  newAccount: { label: 'Account appena creato', help: 'Punti di rischio per un account recente.' },
  noAvatar: { label: 'Nessuna immagine del profilo', help: 'Punti per l\'avatar predefinito.' },
  generatedName: { label: 'Nome generato', help: 'Punti per nomi tipo «utente82736451».' },
  discordSpammerFlag: {
    label: 'Segnalato da Discord',
    help: 'Punti per il contrassegno «probabile spammer» che assegna Discord stessa.',
  },
  staffImpersonation: { label: 'Somiglia a un moderatore', help: 'Punti per nome o avatar simili a quelli dello staff.' },
  homoglyphName: { label: 'Caratteri camuffati nel nome', help: 'Punti per lettere cirilliche o greche travestite da latine.' },
  emptyProfile: { label: 'Profilo vuoto', help: 'Punti per nessun badge, nessuna attività, nulla.' },
  joinCluster: { label: 'Entrato in gruppo', help: 'Punti per chi ha la stessa impronta di altri entrati nello stesso minuto.' },
  rescanIntervalHours: {
    label: 'Riprofila i membri ogni',
    help: 'Ore fra un ricontrollo e l\'altro dei membri già presenti: nomi e avatar cambiano. 0 = mai.',
  },

  /* Inviti */
  resolvePostedInvites: {
    label: 'Risolvi gli inviti pubblicati',
    help: 'Mostra allo staff nome, età e dimensione del server verso cui punta ogni invito.',
  },
  blockUnknownInvites: { label: 'Blocca gli inviti verso server sconosciuti', help: 'Consentiti solo quelli in lista.' },
  allowedGuildIds: { label: 'Server consentiti', help: 'ID dei server verso cui gli inviti sono ammessi.' },
  allowOwnGuild: { label: 'Consenti gli inviti a questo server', help: 'Gli inviti verso casa propria passano sempre.' },
  watchOwnVanity: {
    label: 'Sorveglia i propri codici',
    help:
      'Avvisa se un vostro invito o vanity si libera: Discord permette di riusare codici scaduti, ' +
      'e un link storico pubblicato altrove può finire su un server ostile.',
  },
  watchedCodes: { label: 'Codici sorvegliati', help: 'I vostri codici invito da tenere d\'occhio.' },

  /* Webhook e bot */
  allowedWebhookIds: { label: 'Webhook approvati', help: 'Quelli delle personas vengono aggiunti da soli.' },
  autoDeleteUnknown: {
    label: 'Elimina i webhook sconosciuti',
    help:
      'Un webhook non approvato viene rimosso appena creato. Sono usati come canale di comando ' +
      'anche da pacchetti npm compromessi, e permettono messaggi dall\'aspetto ufficiale.',
  },
  auditIntervalHours: { label: 'Controllo periodico ogni', help: 'Ore fra un inventario e l\'altro. 0 = solo a richiesta.' },
  allowedCreatorIds: { label: 'Chi può creare webhook', help: 'Persone le cui creazioni non fanno scattare nulla.' },
  alertOnBotJoin: { label: 'Avvisa quando entra un bot', help: 'Con il riepilogo dei permessi che ha ottenuto.' },
  blockAdministrator: {
    label: 'Nega Administrator ai bot',
    help: 'Rimuove il permesso a ogni bot fuori lista. Un bot con Administrator equivale al server compromesso.',
  },
  allowedBotIds: { label: 'Bot consentiti', help: 'Bot che possono restare senza controlli.' },
  allowedInviterIds: { label: 'Chi può aggiungere bot', help: 'I bot aggiunti da altri vengono espulsi.' },
  applyAntiNukeToBots: {
    label: 'Applica l\'anti-nuke anche ai bot',
    help: 'Un bot compromesso agisce come un amministratore compromesso, e di solito più in fretta.',
  },

  /* Tutela */
  groomingPatterns: {
    label: 'Rileva l\'adescamento',
    help: 'Cerca nei canali pubblici gli schemi tipici: spostare in privato, chiedere età e foto.',
  },
  reportChannelId: { label: 'Canale delle segnalazioni', help: 'Privato: qui arrivano le segnalazioni con le prove congelate.' },
  escalationRoleId: { label: 'Ruolo da chiamare', help: 'Menzionato per le segnalazioni che non possono aspettare.' },
  blockIpGrabbers: {
    label: 'Blocca i raccoglitori di IP',
    help:
      'Il bot non può vedere gli IP di nessuno — l\'API di Discord non li espone — ma i link che ' +
      'li raccolgono funzionano, e quelli si bloccano.',
  },
  ipGrabberDomains: { label: 'Domini noti', help: 'Elenco dei servizi di raccolta IP da bloccare.' },
  preserveEvidence: { label: 'Congela le prove', help: 'Salva testo e metadati prima di eliminare il messaggio.' },

  /* Verifica */
  verifiedRoleId: { label: 'Ruolo dopo la verifica', help: 'Assegnato a chi supera il controllo d\'ingresso.' },
  quarantineRoleId: { label: 'Ruolo di attesa', help: 'Isola chi non ha ancora verificato.' },
  verifyChannelId: { label: 'Canale della verifica', help: 'Dove compare il pulsante.' },
  kickAfterMinutes: { label: 'Espelli chi non verifica entro', help: 'Minuti di attesa. 0 = nessuna scadenza.' },
  minDelaySec: {
    label: 'Attesa prima del pulsante',
    help: 'Secondi prima che il pulsante diventi premibile: blocca i bot che cliccano all\'istante.',
  },

  /* Ruoli appiccicosi */
  excludedRoleIds: { label: 'Ruoli da non restituire', help: 'Non vengono mai riassegnati al rientro.' },
  reapplyPunishments: {
    label: 'Riapplica anche i provvedimenti',
    help:
      'Restituisce quarantena e silenziamento a chi rientra. È il motivo principale del modulo: ' +
      'uscire e rientrare è il modo più banale per liberarsi di una sanzione.',
  },
  maxAgeDays: { label: 'Validità dei ruoli salvati', help: 'Oltre questi giorni dall\'uscita non vengono più restituiti.' },
  delaySec: { label: 'Attesa prima di riassegnare', help: 'Secondi dopo l\'ingresso. Evita di correre contro altri bot.' },

  /* AutoMod nativo */
  syncBlockedTerms: { label: 'Allinea le parole bloccate', help: 'Tiene le regole native di Discord al passo con le blocklist del bot.' },
  quarantineOnProfileMatch: {
    label: 'Isola sul profilo',
    help:
      'Regola nativa che blocca l\'utente prima ancora che possa scrivere, sul nome o sulla bio. ' +
      'È l\'unica difesa che agisce prima del messaggio. Richiede il permesso di moderare i membri.',
  },
  enableNativeSpamFilter: { label: 'Filtro spam nativo', help: 'Il filtro antispam di Discord, gestito da qui.' },
  enableMentionSpamFilter: { label: 'Filtro menzioni nativo', help: 'Blocca i messaggi con troppe menzioni prima della pubblicazione.' },
  mentionSpamLimit: { label: 'Menzioni massime', help: 'Soglia del filtro nativo.' },

  /* Scanner: link */
  expandShorteners: { label: 'Segui gli accorciatori', help: 'Apre i redirect per vedere la vera destinazione.' },
  maxRedirects: { label: 'Redirect massimi', help: 'Quante volte seguire una catena di rimandi.' },
  fetchTimeoutMs: { label: 'Attesa massima (ms)', help: 'Oltre questo tempo il controllo si arrende e non blocca il messaggio.' },
  detectHomoglyphs: {
    label: 'Rileva i domini camuffati',
    help: 'discοrd.com scritto con un omicron greco: identico a vedersi, diverso a leggersi.',
  },
  protectedDomains: { label: 'Domini da proteggere', help: 'I domini veri con cui confrontare quelli sospetti.' },
  useSafeBrowsing: { label: 'Usa Google Safe Browsing', help: 'Richiede una chiave API gratuita nelle variabili d\'ambiente.' },
  useThreatFeeds: { label: 'Usa le blocklist pubbliche', help: 'URLhaus e Phishing.Database, sincronizzate in locale ogni ora.' },
  blockedDomains: { label: 'Domini bloccati', help: 'Blocklist manuale del server.' },
  allowedDomains: { label: 'Domini consentiti', help: 'Passano sempre, anche se una blocklist li segnala.' },
  blockCdnExecutables: {
    label: 'Blocca gli eseguibili dalla CDN Discord',
    help: 'cdn.discordapp.com sembra affidabile ed è il canale documentato di distribuzione degli infostealer.',
  },
  flagOAuthLinks: {
    label: 'Segnala i link di autorizzazione',
    help: 'Chi autorizza un\'applicazione ostile le consegna l\'accesso al proprio account.',
  },
  allowedOAuthAppIds: { label: 'Applicazioni consentite', help: 'ID delle applicazioni la cui autorizzazione è legittima.' },

  /* Scanner: immagini */
  maxSizeMb: { label: 'Dimensione massima (MB)', help: 'Oltre, l\'immagine non viene analizzata.' },
  decodeQr: { label: 'Leggi i QR', help: 'Decodifica i codici e ne estrae la destinazione.' },
  blockDiscordRemoteAuthQr: {
    label: 'Blocca i QR di accesso Discord',
    help:
      'Un QR che punta a discord.com/ra/ è il flusso di accesso remoto: chi lo inquadra consegna ' +
      'il proprio account. Non esiste un uso legittimo di quel QR in una chat.',
  },
  ocr: { label: 'Leggi il testo nelle immagini', help: 'Trova link e frasi truffa scritti sopra l\'immagine.' },
  ocrLanguages: { label: 'Lingue del riconoscimento', help: 'Codici a tre lettere, es. ita e eng.' },
  ocrMinConfidence: { label: 'Confidenza minima', help: 'Sotto questa soglia il testo riconosciuto viene ignorato.' },
  perceptualHash: {
    label: 'Impronta visiva',
    help:
      'Riconosce la stessa immagine anche se ricompressa o ritagliata: blocca un\'intera campagna ' +
      'con una firma sola.',
  },
  phashMaxDistance: {
    label: 'Tolleranza dell\'impronta',
    help: 'Da 0 a 64. Più alto significa più permissivo, e più falsi positivi.',
  },
  compareAvatarsToStaff: { label: 'Confronta gli avatar con lo staff', help: 'Rileva chi copia l\'immagine di un moderatore.' },

  /* Scanner: file */
  verifyMagicBytes: {
    label: 'Verifica il contenuto reale',
    help: 'Controlla che il file sia davvero ciò che l\'estensione dichiara.',
  },
  blockDoubleExtension: { label: 'Blocca la doppia estensione', help: 'foto.png.exe, documento.pdf.scr.' },
  detectPolyglot: { label: 'Rileva i file ambigui', help: 'File validi contemporaneamente in due formati diversi.' },
  blockedExtensions: { label: 'Estensioni bloccate', help: 'Elenco delle estensioni rifiutate come allegato.' },
  inspectArchives: { label: 'Guarda dentro gli archivi', help: 'Cerca eseguibili dentro zip e rar.' },
  maxArchiveEntries: { label: 'File esaminati per archivio', help: 'Limite contro gli archivi con migliaia di voci.' },
  riskScore: { label: 'Punti di rischio', help: 'Quanto aggiunge al profilo di chi lo pubblica.' },
  scamPhrases: { label: 'Frasi delle truffe', help: 'Cercate sia nel testo sia nell\'OCR delle immagini.' },
  asyncDeepScan: {
    label: 'Analisi approfondita in background',
    help:
      'L\'OCR costa fino a due secondi per immagine: viene eseguito a parte, e se il verdetto ' +
      'arriva dopo il messaggio viene rimosso a posteriori.',
  },

  /* Registro */
  singleChannel: {
    label: 'Un solo canale per tutto',
    help:
      'Tutto il registro in un canale, ignorando le rotte per categoria senza cancellarle. ' +
      'Togliendo la spunta le rotte tornano valide esattamente com\'erano.',
  },
  defaultChannelId: { label: 'Canale del registro', help: 'Dove finisce tutto in modalità a canale unico.' },
  disabledCategories: { label: 'Categorie spente', help: 'Non vengono registrate affatto, in nessuna destinazione.' },
  ignoredChannelIds: { label: 'Canali ignorati', help: 'Ciò che vi accade non viene registrato.' },
  ignoredUserIds: { label: 'Utenti ignorati', help: 'Utile per i bot rumorosi. Non vale per gli eventi di sicurezza.' },
  ignoreBots: { label: 'Ignora i bot', help: 'Esclude gli eventi generati dalle applicazioni.' },
  messageContent: {
    label: 'Contenuto dei messaggi',
    help:
      'Quanto conservare: tutto, solo un\'impronta, solo i metadati, oppure nulla. Il contenuto ' +
      'è un dato personale e conservarlo va deciso, non subìto.',
  },
  archiveAttachments: {
    label: 'Archivia gli allegati',
    help: 'Li conserva sul disco della macchina: restano consultabili anche dopo l\'eliminazione del messaggio.',
  },
  maxAttachmentSizeMb: { label: 'Allegato massimo (MB)', help: 'Oltre, il file non viene archiviato.' },
  attachmentRetentionDays: { label: 'Conservazione degli allegati', help: 'Giorni prima della cancellazione dal disco.' },
  allowSelfErasure: {
    label: 'Consenti la cancellazione dei propri dati',
    help: 'Diritto previsto dal GDPR. I provvedimenti restano, pseudonimizzati.',
  },
  batchSeconds: {
    label: 'Accorpamento (secondi)',
    help:
      'Riunisce gli eventi frequenti — messaggi, reazioni, voce — in un unico invio. Moderazione ' +
      'e sicurezza restano sempre immediate. 0 = nessun accorpamento.',
  },
  showContentInChannel: { label: 'Mostra il testo nel canale', help: 'Oltre a conservarlo nel database.' },
  showUserIds: { label: 'Mostra gli ID', help: 'Utile per copiarli, rumoroso da leggere.' },
  trackInviteAttribution: { label: 'Traccia chi ha invitato chi', help: 'Ricostruisce da quale invito è entrato ogni membro.' },
  splitByCategory: { label: 'Un file per categoria', help: 'Invece di un unico file con tutto dentro.' },
  includeContent: { label: 'Includi il testo nei file', help: 'Se il registro lo conserva.' },
  retentionDays: { label: 'Giorni di conservazione', help: '0 = per sempre.' },
  flushIntervalMs: {
    label: 'Scrittura su disco ogni (ms)',
    help: 'Accumula prima di scrivere: una syscall per messaggio sarebbe spreco puro.',
  },

  /* Integrazioni */
  streamers: { label: 'Streamer seguiti', help: 'Canale Twitch, dove annunciare, quale ruolo menzionare e con quale testo.' },
  clipPollMinutes: { label: 'Controllo clip ogni', help: 'Minuti fra un controllo e l\'altro dei nuovi clip.' },
  channels: { label: 'Canali YouTube', help: 'Canale, dove annunciare, ruolo da menzionare e testo dell\'annuncio.' },
  feeds: { label: 'Feed seguiti', help: 'Indirizzo del feed, canale, filtri e testo dell\'annuncio.' },
  pollMinutes: { label: 'Controllo ogni', help: 'Minuti fra un controllo e l\'altro.' },
  creatorRoleIds: { label: 'Chi può creare sondaggi', help: 'Vuoto = chiunque possa gestire i messaggi.' },
  maxOptions: { label: 'Opzioni massime', help: 'Quante risposte può avere un sondaggio.' },
  maxDurationHours: { label: 'Durata massima (ore)', help: 'Limite alla durata di un sondaggio.' },
  allowAnonymous: { label: 'Consenti sondaggi anonimi', help: 'I voti non sono attribuibili nemmeno dal pannello.' },
  logVotes: { label: 'Registra i voti', help: 'Da spegnere se i sondaggi anonimi devono esserlo davvero.' },
  managerRoleIds: { label: 'Chi può gestire gli eventi', help: 'Ruoli abilitati a creare e modificare.' },
  announceChannelId: { label: 'Canale degli annunci', help: 'Dove pubblicare.' },
  reminderMinutes: { label: 'Promemoria', help: 'Minuti prima dell\'inizio a cui avvisare. Più valori separati da virgola.' },
  rsvpRoleId: { label: 'Ruolo per gli iscritti', help: 'Assegnato temporaneamente a chi conferma la presenza.' },
  hostRoleIds: { label: 'Chi può indire giveaway', help: 'Ruoli abilitati.' },
  mentionRoleId: {
    label: 'Ruolo da menzionare',
    help: 'Avvisato a ogni nuovo annuncio. Se lo si menziona per tutto, smette di funzionare.',
  },
  announceTemplate: {
    label: 'Testo di accompagnamento',
    help: 'Riga sopra il riquadro. Variabili disponibili: {premio}, {vincitori} e {fine}.',
  },
  minAccountAgeDays: {
    label: 'Età minima dell\'account',
    help: 'Senza requisiti, ogni giveaway attira account creati per l\'occasione.',
  },
  minMembershipDays: { label: 'Giorni minimi nel server', help: 'Da quanto deve essere iscritto chi partecipa.' },
  requiredRoleIds: { label: 'Ruoli richiesti', help: 'Servono per poter partecipare.' },
  blockedRoleIds: { label: 'Ruoli esclusi', help: 'Impediscono la partecipazione.' },
  maxWinners: { label: 'Vincitori massimi', help: 'Quante persone possono vincere lo stesso giveaway.' },
  maxDurationDays: { label: 'Durata massima (giorni)', help: 'Limite alla durata di un giveaway.' },
  blockPrivilegedRoles: {
    label: 'Vieta i ruoli con permessi',
    help: 'Impedisce di distribuire ruoli pericolosi con una reazione. Da tenere acceso.',
  },
  allowSelfStar: {
    label: 'Consenti di votare sé stessi',
    help: 'Spento di default: altrimenti bastano quattro amici e l\'autore, e la bacheca smette di dire qualcosa.',
  },
  removeBelowThreshold: { label: 'Rimuovi sotto soglia', help: 'Toglie dalla bacheca ciò che perde voti.' },
  ignoreNsfw: { label: 'Ignora i canali espliciti', help: 'I loro messaggi non finiscono mai in bacheca.' },
  categoryId: { label: 'Categoria dei ticket', help: 'Dove creare i canali privati.' },
  supportRoleIds: { label: 'Ruoli di supporto', help: 'Chi vede e gestisce i ticket.' },
  panelChannelId: { label: 'Canale del pulsante', help: 'Dove pubblicare il pulsante di apertura.' },
  maxOpenPerUser: { label: 'Ticket aperti per persona', help: 'Quanti se ne possono avere contemporaneamente.' },
  transcriptOnClose: { label: 'Salva la trascrizione', help: 'Conserva la conversazione prima di eliminare il canale.' },
  autoCloseHours: {
    label: 'Chiudi i ticket fermi da',
    help: 'Ore senza attività. 0 = mai. Un ticket dimenticato aperto per settimane nasconde quelli veri.',
  },
  welcomeMessage: { label: 'Messaggio di apertura', help: 'Mostrato nel canale appena creato.' },
  pingSupport: { label: 'Avvisa il supporto', help: 'Menziona i ruoli di supporto all\'apertura.' },
};

/** Le categorie del registro, usate come chiavi in `retentionDays`. */
const CATEGORY_LABEL: Record<string, string> = {
  MESSAGE: 'Messaggi',
  REACTION: 'Reazioni',
  MEMBER: 'Membri',
  VOICE: 'Canali vocali',
  CHANNEL: 'Canali',
  ROLE: 'Ruoli',
  SERVER: 'Server',
  INVITE: 'Inviti',
  WEBHOOK: 'Webhook',
  MODERATION: 'Moderazione',
  SECURITY: 'Sicurezza',
  AUTOMOD: 'AutoMod',
  BOT: 'Bot',
};

/**
 * Spiegazione di un campo, o `null` se non ne esiste una.
 *
 * Restituisce `null` invece di inventare un testo generico: un aiuto che non
 * aiuta è peggio della sua assenza, e il test si accorge solo di ciò che è
 * dichiaratamente mancante.
 */
export function describeField(path: string): FieldDoc | null {
  const parts = path.split('.');
  const key = parts[parts.length - 1]!;
  const parent = parts[parts.length - 2];

  const exact = BY_PATH[path] ?? (parent ? BY_PATH[`${parent}.${key}`] : undefined);
  if (exact) return exact;

  const generic = BY_KEY[key];
  if (generic) return generic;

  // Le categorie del registro compaiono come chiavi dentro `retentionDays`.
  const category = CATEGORY_LABEL[key];
  if (category) {
    return {
      label: category,
      help: 'Giorni di conservazione per questa categoria. 0 = per sempre.',
    };
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
   DESCRIZIONE DELLE SEZIONI

   Mostrata in cima a ogni pagina della configurazione. Risponde alla domanda
   che viene prima di ogni spunta: questa cosa a che serve, e mi serve?
   ═══════════════════════════════════════════════════════════════════════ */
export interface SectionDoc {
  /** Una riga: cosa fa. */
  summary: string;
  /** Qualche riga: come funziona e quando conviene accenderlo. */
  detail: string;
}

export const SECTION_DOCS: Record<string, SectionDoc> = {
  general: {
    summary: 'Impostazioni che valgono per tutto il resto.',
    detail:
      'Qui stanno i due interruttori che contano più di ogni altro. **Protezione attiva** spegne ' +
      'tutti i moduli insieme senza perdere la configurazione. **Modalità prova** li lascia ' +
      'lavorare e registrare, trattenendo solo la sanzione: è il modo giusto di iniziare, per ' +
      'qualche giorno, guardando cosa il bot avrebbe fatto prima di lasciarglielo fare.',
  },
  'security.antiRaid': {
    summary: 'Ferma le ondate di account che entrano insieme per fare danno.',
    detail:
      'Le reti di account automatici ne generano migliaia in pochi minuti, e i primi trenta ' +
      'secondi decidono l\'esito. Si sorvegliano due cose: quanti entrano in poco tempo, e quanto ' +
      'si somigliano fra loro — perché un raid lento resta un raid. Al superamento delle soglie ' +
      'il bot può limitarsi a osservare, isolare i partecipanti, o chiudere il server.',
  },
  'security.antiNuke': {
    summary: 'Ferma chi distrugge il server dall\'interno.',
    detail:
      'La causa numero uno delle compromissioni è l\'eccesso di permessi: un account con ' +
      'Administrator che finisce nelle mani sbagliate cancella tutto in un minuto. Qui si contano ' +
      'le azioni distruttive **per singola persona** e si reagisce togliendo i ruoli, non ' +
      'bandendo — chi provoca un nuke è spesso la vittima di un furto di token, non l\'attaccante.',
  },
  'security.antiSpam': {
    summary: 'Limita ritmo, ripetizioni, menzioni e muri di testo.',
    detail:
      'La risposta è graduata: prima si rimuove il messaggio, poi si avverte, poi si silenzia. ' +
      'Le soglie sono più severe nella prima ora dopo l\'ingresso, perché è lì che arriva quasi ' +
      'tutto lo spam.',
  },
  'security.compromise': {
    summary: 'Riconosce gli account veri finiti nelle mani sbagliate.',
    detail:
      'Le ondate di truffe non arrivano da account nuovi ma da account noti, di persone che ' +
      'frequentano il server da mesi e che di colpo cambiano comportamento: silenzio per settimane, ' +
      'poi un\'immagine con un link in cinque canali. Si confronta ciascuno con il proprio passato, ' +
      'non con una regola uguale per tutti.',
  },
  'security.accountGuard': {
    summary: 'Assegna un punteggio di rischio a chi entra.',
    detail:
      'Età dell\'account, avatar assente, nome generato, contrassegni di Discord, somiglianza con ' +
      'lo staff. Ogni segnale vale dei punti e la somma decide se limitarsi a registrare, ' +
      'avvisare, o chiedere una verifica. I pesi si tarano guardando il registro per qualche giorno.',
  },
  'security.inviteGuard': {
    summary: 'Sorveglia gli inviti pubblicati e i vostri codici.',
    detail:
      'Discord consente di riusare codici invito scaduti o liberati: un link pubblicato anni fa ' +
      'può portare oggi su un server ostile senza che nessuno se ne accorga. Il modulo risolve ogni ' +
      'invito pubblicato e avvisa se un vostro codice diventa rivendicabile.',
  },
  'security.webhookGuard': {
    summary: 'Tiene sotto controllo i webhook del server.',
    detail:
      'Un webhook permette di scrivere con nome e immagine qualunque, quindi di fingersi ' +
      'chiunque. Sono usati come canale di comando anche da pacchetti npm compromessi. Qui si ' +
      'tiene l\'inventario e si elimina quanto non è approvato.',
  },
  'security.botGuard': {
    summary: 'Controlla i permessi delle altre applicazioni.',
    detail:
      'Un bot con Administrator equivale al server compromesso, e il vettore può essere una ' +
      'dipendenza avvelenata o l\'account dello sviluppatore rubato — nessuna delle due cose è ' +
      'colpa vostra e nessuna delle due si vede in anticipo. Si sorveglia cosa possono fare.',
  },
  'security.language': {
    summary: 'Parolacce e insulti, con due difese sovrapposte.',
    detail:
      'La prima e AutoMod di Discord con i suoi elenchi predefiniti: agisce **prima che il ' +
      'messaggio esista**, e multilingue e la mantiene Discord. Nessun bot puo fare altrettanto, ' +
      'perche un bot il messaggio lo vede solo dopo la pubblicazione. La seconda e il tuo elenco, ' +
      'che vede cio che AutoMod lascia passare — le forme elusive, le espressioni locali, gli ' +
      'insulti che non sono parolacce — e distingue lo sfogo dall\'aggressione rivolta a qualcuno.',
  },
  'security.flame': {
    summary: 'Interrompe le discussioni che degenerano, prima che diventino un flame.',
    detail:
      'Il filtro delle parole guarda un messaggio alla volta; il flame non e un messaggio, e uno ' +
      'scambio. Una sola inciviltà basta a innescare una discussione che degenera, e da li ogni ' +
      'risposta e difensiva: chi assiste smette di partecipare e il canale resta alle voci piu ' +
      'aggressive. La prima risposta qui e **rallentare il canale**, non sanzionare — e l unica ' +
      'che non richiede di stabilire chi ha cominciato, cosa che in una discussione degenerata di ' +
      'solito non si puo stabilire affatto.',
  },
  'security.safety': {
    summary: 'Tutela delle persone: adescamento e raccolta di IP.',
    detail:
      'Il bot non vede i messaggi privati, quindi qui non c\'è prevenzione ma tre cose concrete: ' +
      'riconoscere gli schemi nei canali pubblici, offrire un percorso di segnalazione rapido con ' +
      'le prove congelate, e bloccare i link che raccolgono indirizzi IP.',
  },
  'security.verification': {
    summary: 'Filtro all\'ingresso prima di poter scrivere.',
    detail:
      'Chi entra resta isolato finché non compie un\'azione che un account automatico non compie ' +
      'volentieri. L\'attesa prima che il pulsante diventi premibile è la parte che ferma di più: ' +
      'i bot cliccano all\'istante.',
  },
  'security.stickyRoles': {
    summary: 'Chi esce e rientra ritrova i suoi ruoli.',
    detail:
      'Comodità e sicurezza insieme. Uscire e rientrare è il modo più banale per liberarsi di un ' +
      'silenziamento, e senza questo modulo funziona. I ruoli con permessi pericolosi non vengono ' +
      'mai restituiti in automatico.',
  },
  'security.autoMod': {
    summary: 'Pilota le regole native di Discord.',
    detail:
      'AutoMod è l\'unica difesa che agisce **prima** che il messaggio esista: nessun bot può ' +
      'farlo, perché un bot vede il messaggio solo dopo la pubblicazione. Complementare al resto, ' +
      'non sostitutivo.',
  },
  scanner: {
    summary: 'Analizza link, immagini e allegati.',
    detail:
      'Un PNG su Discord non esegue codice: le immagini truffa sono veicoli di link, scritti sopra ' +
      'o dentro un QR. Lo scanner estrae ogni indirizzo visibile o codificato, ne verifica la ' +
      'reputazione e riconosce le campagne dall\'impronta visiva. Per gli allegati il controllo è ' +
      'invece reale: contenuto contro estensione dichiarata.',
  },
  logging: {
    summary: 'Cosa registrare, dove e per quanto.',
    detail:
      'Tre destinazioni: il database, che il pannello interroga; i canali Discord, per leggere ' +
      'senza aprire il pannello; i file sul disco, per l\'archivio a lungo termine. Con **un solo ' +
      'canale per tutto** basta scegliere un canale e il registro funziona; le rotte per categoria ' +
      'restano lì per quando serviranno.',
  },
  'integrations.twitch': {
    summary: 'Avvisi di diretta e clip.',
    detail:
      'Gli avvisi arrivano dall\'evento ufficiale di Twitch, non da un controllo periodico: la ' +
      'notifica è immediata. Per ogni streamer si sceglie il canale, il ruolo da menzionare e il ' +
      'testo, con le variabili {streamer} {title} {game} {url} {viewers}.',
  },
  'integrations.polls': { summary: 'Sondaggi persistenti.', detail: 'A scadenza, ristretti a ruoli, anonimi, esportabili. I sondaggi nativi di Discord restano disponibili e più semplici.' },
  'integrations.events': { summary: 'Eventi programmati.', detail: 'Creazione, promemoria automatici e ruolo temporaneo per chi conferma la presenza.' },
  'integrations.giveaways': {
    summary: 'Estrazioni con requisiti.',
    detail: 'I requisiti non sono un vezzo: senza, ogni giveaway attira account creati per l\'occasione.',
  },
  'integrations.reactionRoles': { summary: 'Ruoli scelti dai membri.', detail: 'Menu a scelta invece delle reazioni: non si perdono, nessuno può aggiungerne di propri, e si può rispondere in privato.' },
  'integrations.starboard': {
    summary: 'Bacheca dei messaggi apprezzati.',
    detail: 'Sposta l\'attenzione su ciò che il server vuole premiare, invece di lasciarla solo su ciò che va punito.',
  },
  'integrations.tickets': {
    summary: 'Conversazioni private con lo staff.',
    detail:
      'Toglie dai messaggi privati le richieste di assistenza. Nei DM non c\'è registro, non c\'è ' +
      'passaggio di consegne, e soprattutto non c\'è modo di distinguere un moderatore vero da chi ' +
      'si finge tale.',
  },
  'integrations.youtube': { summary: 'Nuovi video e dirette.', detail: 'Usa il feed pubblico ufficiale: nessuna chiave API, nessuna quota da consumare, nessuna approvazione.' },
  'integrations.rss': {
    summary: 'Qualunque fonte con un feed.',
    detail: 'Blog, Reddit, Mastodon, release GitHub, notizie. Dove esiste un feed non serve un\'integrazione dedicata.',
  },
};

/* ═══════════════════════════════════════════════════════════════════════
   COMANDI

   Elencati qui e non solo su Discord perché la domanda «cosa sa fare questo
   bot» arriva prima di aprire Discord, e la risposta non deve richiedere di
   scorrere un menu a tentoni.
   ═══════════════════════════════════════════════════════════════════════ */
export interface CommandDoc {
  name: string;
  /** Cosa fa, in una riga. */
  summary: string;
  /** Permesso Discord necessario per vederlo. */
  permission: string;
  group: 'Moderazione' | 'Sicurezza' | 'Registro e dati' | 'Comunità' | 'Utilità';
  /** Un esempio reale, che si possa copiare. */
  example?: string;
  /** Avvertenza, dove c'è qualcosa che conviene sapere prima. */
  caution?: string;
}

export const COMMAND_DOCS: CommandDoc[] = [
  /* ── Moderazione ─────────────────────────────────────────── */
  { name: '/avverti', group: 'Moderazione', permission: 'Moderare i membri', summary: 'Registra un avvertimento e lo comunica alla persona.', example: '/avverti utente:@tizio motivo:insulti in chat generale' },
  { name: '/silenzia', group: 'Moderazione', permission: 'Moderare i membri', summary: 'Timeout nativo di Discord: la persona non può scrivere né parlare.', example: '/silenzia utente:@tizio durata:2h motivo:spam', caution: 'Il massimo consentito da Discord è 28 giorni.' },
  { name: '/rimuovi-silenzio', group: 'Moderazione', permission: 'Moderare i membri', summary: 'Toglie il timeout prima della scadenza.' },
  { name: '/espelli', group: 'Moderazione', permission: 'Espellere i membri', summary: 'Rimuove dal server. Può rientrare con un nuovo invito.' },
  { name: '/bandisci', group: 'Moderazione', permission: 'Bandire i membri', summary: 'Ban, con eliminazione facoltativa dei messaggi recenti.', example: '/bandisci utente:@tizio motivo:truffa giorni:1' },
  { name: '/revoca-ban', group: 'Moderazione', permission: 'Bandire i membri', summary: 'Toglie il ban a un ID utente.' },
  { name: '/pulisci', group: 'Moderazione', permission: 'Gestire i messaggi', summary: 'Elimina in blocco gli ultimi messaggi, anche di una sola persona.', caution: 'Discord non consente di eliminare in blocco messaggi più vecchi di 14 giorni.' },
  { name: '/quarantena', group: 'Moderazione', permission: 'Moderare i membri', summary: 'Isola una persona togliendole i ruoli, e glieli restituisce alla revoca.', example: '/quarantena applica utente:@tizio motivo:account probabilmente rubato', caution: 'Richiede un ruolo di quarantena configurato nella sezione Generale.' },
  { name: '/attenziona', group: 'Moderazione', permission: 'Moderare i membri', summary: 'Sorveglia una persona senza sanzionarla: ogni sua azione va in evidenza nel registro.', example: '/attenziona aggiungi utente:@tizio motivo:segnalato da due membri ore:48', caution: 'Non è visibile all\'interessato e non gli toglie nulla.' },
  { name: '/nota', group: 'Moderazione', permission: 'Moderare i membri', summary: 'Annota qualcosa sul profilo di una persona, visibile solo allo staff.' },
  { name: '/utente', group: 'Moderazione', permission: 'Moderare i membri', summary: 'Scheda completa: rischio, precedenti, ruoli, ingressi, note.' },

  /* ── Sicurezza ───────────────────────────────────────────── */
  { name: '/lockdown', group: 'Sicurezza', permission: 'Gestire il server', summary: 'Mette i canali in sola lettura e sospende gli inviti.', example: '/lockdown attiva motivo:raid in corso minuti:15', caution: 'Se i canali restano chiusi dopo la revoca, ripetere con l\'opzione forza.' },
  { name: '/panico', group: 'Sicurezza', permission: 'Gestire il server', summary: 'Blocca il server, salva un backup e avvisa lo staff, tutto insieme.', caution: 'Pensato per essere usato nel dubbio: un blocco ingiustificato costa dieci minuti, un nuke non fermato costa il server.' },
  { name: '/backup', group: 'Sicurezza', permission: 'Amministratore', summary: 'Salva o ripristina la struttura del server: ruoli, canali, permessi.', caution: 'La cronologia dei messaggi non è ripristinabile da Discord: si recupera solo ciò che il bot ha già archiviato.' },
  { name: '/audit', group: 'Sicurezza', permission: 'Gestire il server', summary: 'Revisione: webhook non approvati, bot con troppi permessi, inviti a rischio.' },
  { name: '/verifica-staff', group: 'Sicurezza', permission: 'Nessuno', summary: 'Conferma la parola d\'ordine dello staff.', caution: 'È la sola difesa pratica contro chi imita un moderatore con la voce clonata.' },
  { name: '/scansiona', group: 'Sicurezza', permission: 'Gestire i messaggi', summary: 'Analizza a richiesta un link o un\'immagine.' },

  /* ── Registro e dati ─────────────────────────────────────── */
  { name: '/archivio', group: 'Registro e dati', permission: 'Gestire i messaggi', summary: 'Cerca nei messaggi archiviati, anche in quelli già eliminati.' },
  { name: '/privacy', group: 'Registro e dati', permission: 'Nessuno', summary: 'Spiega quali dati il bot conserva e per quanto.' },
  { name: '/cancella-i-miei-dati', group: 'Registro e dati', permission: 'Nessuno', summary: 'Cancellazione dei propri dati, prevista dal GDPR.', caution: 'I provvedimenti di moderazione restano, in forma pseudonimizzata.' },

  /* ── Comunità ────────────────────────────────────────────── */
  { name: '/sondaggio', group: 'Comunità', permission: 'Gestire i messaggi', summary: 'Sondaggio a scadenza, anche anonimo o ristretto a ruoli.' },
  { name: '/giveaway', group: 'Comunità', permission: 'Gestire i messaggi', summary: 'Estrazione con requisiti di età dell\'account e di permanenza.' },
  { name: '/evento', group: 'Comunità', permission: 'Gestire gli eventi', summary: 'Evento programmato con promemoria automatici.' },
  { name: '/ticket', group: 'Comunità', permission: 'Nessuno', summary: 'Apre una conversazione privata con lo staff.' },

  /* ── Utilità ─────────────────────────────────────────────── */
  { name: '/dì', group: 'Utilità', permission: 'Gestire i messaggi', summary: 'Fa scrivere il bot in un canale: testo, immagini e GIF.', example: '/dì canale:#annunci testo:Manutenzione alle 21 riquadro:true', caution: 'Solo immagini e GIF, e nessuna menzione di massa: un messaggio del bot sembra venire dallo staff.' },
  { name: '/prova-filtro', group: 'Utilità', permission: 'Gestire i messaggi', summary: 'Mostra cosa riconoscerebbe il filtro in un testo, senza pubblicarlo.', example: '/prova-filtro testo:sei uno stronzo rivolto:true', caution: 'Serve perche in chat amministratori e proprietari del bot sono esenti: sono le persone piu probabili a voler provare il filtro, e le uniche che non possono.' },
  { name: '/prepara-server', group: 'Utilità', permission: 'Amministratore', summary: 'Crea ruoli, canali e configurazione mancanti per far funzionare tutto.', caution: 'Si può rieseguire quando si vuole: verifica cosa esiste già e non duplica nulla.' },
  { name: '/angel-master', group: 'Utilità', permission: 'Amministratore', summary: 'Ricrea il ruolo del proprietario del bot e lo riassegna.', caution: 'Funziona solo per gli ID elencati in OWNER_IDS: a chiunque altro risponde con un rifiuto.' },
  { name: '/stato', group: 'Utilità', permission: 'Gestire il server', summary: 'Quali moduli sono accesi e cosa hanno fatto di recente.' },
  { name: '/pannello', group: 'Utilità', permission: 'Gestire il server', summary: 'Link al pannello di controllo web.' },
  { name: '/ping', group: 'Utilità', permission: 'Nessuno', summary: 'Verifica che il bot risponda e con quale latenza.' },
];
