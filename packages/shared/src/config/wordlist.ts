/* ═══════════════════════════════════════════════════════════════════════
   ELENCO PREDEFINITO DELLE ESPRESSIONI OFFENSIVE (italiano)

   ── Da dove viene ────────────────────────────────────────────────────────

   La ripartizione in categorie segue **HurtLex** (Università di Torino,
   Bassignana–Basile–Patti), che a sua volta parte dal lessico di Tullio De
   Mauro: 17 categorie fra cui slur etnici, disabilità fisiche e cognitive,
   omosessualità, prostituzione, termini derogatori. Il lessico è distribuito
   con licenza CC BY-NC-SA, quindi **non ne è stato copiato il contenuto**: la
   share-alike si propagherebbe a tutto il progetto e la clausola non
   commerciale ne limiterebbe l'uso. Ciò che se ne prende è l'idea che le
   offese non siano tutte la stessa cosa.

   Le gravità seguono le attribuzioni di Perspective API — insulto, attacco
   all'identità, minaccia, volgarità — semplificate a tre livelli, perché uno
   staff deve poter decidere guardando una spunta e non un modello.

   L'elenco LDNOOBW (CC BY 4.0) è stato consultato come repertorio. **Non è
   stato ripreso così com'è**, e la ragione merita di essere scritta perché è
   la stessa che governa tutto questo file: quell'elenco contiene `pesce`,
   `regina`, `cadavere`, `balle`, `monta`, `tirare`, `battere`, `cacca`,
   `pipì`, `mannaggia`, `boiata` e `nave scuola`. Sono parole che in un
   contesto valgono come volgarità e in novantanove no. Un filtro che le
   blocca produce un falso positivo al minuto, e a quel punto lo staff lo
   spegne — ottenendo zero protezione invece che una protezione parziale.

   ── Criteri di inclusione ────────────────────────────────────────────────

   Ogni voce è stata valutata su tre domande:

     1. È offensiva **fuori** da un contesto specifico? Se serve il contesto,
        non entra: il filtro il contesto non ce l'ha.
     2. Esiste una parola legittima che la contiene o le somiglia? Se sì, o si
        aggiunge l'eccezione, o la voce resta fuori.
     3. La gravità corrisponde a ciò che uno staff farebbe? `cazzo` detto per
        stizza non merita la stessa risposta di un insulto razzista.

   Il confronto è **per parola intera**: `substring` non è usato in nessuna
   voce di questo elenco, perché non ce n'è una per cui il guadagno superi il
   rischio.

   ── Perché è modificabile ────────────────────────────────────────────────

   Nessun elenco è giusto per tutti i server. Questo è un punto di partenza
   ragionevole, non una verità: si aggiunge, si toglie, si spengono intere
   categorie dal pannello. Un elenco imposto è un elenco che verrà aggirato o
   disattivato.
   ═══════════════════════════════════════════════════════════════════════ */

export type LanguageSeverity = 'LIEVE' | 'MEDIA' | 'GRAVE';

export type LanguageCategory =
  | 'VOLGARITA'
  | 'INSULTO'
  | 'DISCRIMINAZIONE'
  | 'MINACCIA'
  | 'AUTOLESIONISMO'
  | 'BESTEMMIA'
  | 'SESSUALE';

export interface WordEntry {
  term: string;
  severity: LanguageSeverity;
  category: LanguageCategory;
  substring?: boolean;
}

/** Scorciatoia: rende l'elenco leggibile a colpo d'occhio invece di un muro di oggetti. */
const v = (
  category: LanguageCategory,
  severity: LanguageSeverity,
  ...terms: string[]
): WordEntry[] => terms.map((term) => ({ term, severity, category, substring: false }));

export const DEFAULT_WORDLIST: WordEntry[] = [
  /* ── VOLGARITÀ ────────────────────────────────────────────────────────
     Imprecazioni. Non sono rivolte a nessuno e in molti server fanno parte
     del tono: gravità lieve, e la categoria si spegne in un clic. */
  ...v(
    'VOLGARITA',
    'LIEVE',
    'cazzo',
    'cazzata',
    'cazzate',
    'incazzato',
    'incazzata',
    'minchia',
    'minchiata',
    'merda',
    'merdoso',
    'stronzata',
    'stronzate',
    'puttanata',
    'puttanate',
    'porcata',
    'schifezza',
    'fottuto',
    'fottuta',
    'cesso',
    'palle',
    'coglioni',
    'rottura di coglioni',
    'che palle',
    'porca puttana',
    'porca troia',
    'porca vacca',
    'madonna santa',
    'zoccola',
    'sticazzi',
    'vaffanculo',
    'vaffanbagno',
    'fanculo',
    'affanculo',
    'stocazzo',
    'che cazzo',
    'del cazzo',
    'di merda',
    'una merda',
  ),

  /* ── INSULTI ──────────────────────────────────────────────────────────
     Il nucleo del flame: parole che esistono per essere dette a qualcuno.
     Gravità media, che sommata al supplemento per «rivolto a una persona»
     supera la soglia dell'avvertimento. */
  ...v(
    'INSULTO',
    'MEDIA',
    'stronzo',
    'stronza',
    'coglione',
    'coglionazzo',
    'idiota',
    'imbecille',
    'deficiente',
    'cretino',
    'cretina',
    'scemo',
    'scema',
    'stupido',
    'stupida',
    'demente',
    'idiot',
    'bastardo',
    'bastarda',
    'infame',
    'verme',
    'schifoso',
    'schifosa',
    'pezzo di merda',
    'testa di cazzo',
    'faccia di merda',
    'sacco di merda',
    'pezzo di stronzo',
    'figlio di puttana',
    'figlia di puttana',
    'figlio di troia',
    'mongoloide',
    'babbeo',
    'zuccone',
    'somaro',
    'incapace',
    'buffone',
    'pagliaccio',
    'sfigato',
    'sfigata',
    'sfigati',
    'perdente',
    'fallito',
    'fallita',
    'nullita',
    'inutile di merda',
    'parassita',
    'pezzente',
    'morto di fame',
    'rincoglionito',
    'rincoglionita',
    'ritardato',
    'ritardata',
    'idiota patentato',
    'stronzo patentato',
    'lecchino',
    'leccaculo',
    'ruffiano',
    'traditore',
    'venduto',
    'noob',
    'trash',
    'cancro',
    'cesso umano',
    'obbrobrio',
    'troglodita',
    'primitivo',
    'ignorante di merda',
    'analfabeta',
    'subumano',
    'inferiore',
    'nessuno ti vuole',
    'nessuno ti sopporta',
    'fai schifo',
    'fai pena',
    'non vali niente',
    'non conti niente',
    'sei una merda',
    'sei un cesso',
    'sei ridicolo',
    'sei ridicola',
    'sei patetico',
    'sei patetica',
    'sei uno sfigato',
    'ma vai a cagare',
    'vai a cagare',
    'vai a farti fottere',
    'vai a quel paese',
    'chiudi quella bocca',
    'stai zitto coglione',
    'muto',
  ),

  /* ── DISCRIMINAZIONE ──────────────────────────────────────────────────
     Attacchi all'identità: origine, colore della pelle, orientamento,
     disabilità, genere, religione.

     Gravità grave e sempre, in ogni server. Non è una questione di tono: è
     la ragione per cui una persona se ne va e non torna, e a differenza di
     un insulto generico colpisce chiunque legga e si riconosca in quella
     categoria — non solo il destinatario. */
  ...v(
    'DISCRIMINAZIONE',
    'GRAVE',
    // origine ed etnia
    'negro',
    'negra',
    'negri',
    'negretto',
    'sporco negro',
    'terrone',
    'terroni',
    'terrona',
    'polentone',
    'polentoni',
    'zingaro',
    'zingara',
    'zingari',
    'zingaraccio',
    'marocchino di merda',
    'extracomunitario di merda',
    'clandestino di merda',
    'crucco',
    'muso giallo',
    'scimmia africana',
    'torna al tuo paese',
    'tornatene a casa tua',
    'tornate a casa vostra',
    // orientamento e identità di genere
    'frocio',
    'froci',
    'finocchio',
    'ricchione',
    'recchione',
    'checca',
    'culattone',
    'culattoni',
    'lesbicaccia',
    'travione',
    'trav',
    'gay di merda',
    'schifoso frocio',
    // disabilità
    'handicappato',
    'handicappata',
    'mongolo',
    'spastico',
    'spastica',
    'invalido di merda',
    'sei down',
    'sindrome di down',
    'autistico di merda',
    // genere
    'troia',
    'troie',
    'puttana',
    'puttane',
    'mignotta',
    'baldracca',
    'sgualdrina',
    'donna di merda',
    'zitta donna',
    'torna in cucina',
    'vai in cucina',
    // religione
    'sporco ebreo',
    'ebreo di merda',
    'forno crematorio',
    'camera a gas',
    'terrorista islamico',
    'sporco musulmano',
  ),

  /* ── MINACCE ──────────────────────────────────────────────────────────
     Dichiarazioni di intenzione a fare del male. Gravità grave: sono la
     categoria che va vista da uno staff umano, non solo sanzionata. */
  ...v(
    'MINACCIA',
    'GRAVE',
    'ti ammazzo',
    'ti uccido',
    'ti spacco la faccia',
    'ti spacco il culo',
    'ti rompo la faccia',
    'ti gonfio',
    'ti meno',
    'ti sfondo',
    'ti vengo a prendere',
    'so dove abiti',
    'so dove vivi',
    'ti trovo',
    'ti aspetto sotto casa',
    'ti faccio del male',
    'ti faccio fuori',
    'ti stacco la testa',
    'ti brucio la casa',
    'devi morire',
    'meriti di morire',
    'spero che tu muoia',
    'spero che muori',
    'sarebbe meglio se morissi',
    'ti denuncio e ti rovino',
    'ti rovino la vita',
    'ti stupro',
    'ti violento',
  ),

  /* ── AUTOLESIONISMO ───────────────────────────────────────────────────
     Categoria a sé, e la risposta giusta non è la stessa delle altre.

     Chi scrive «ammazzati» a qualcuno va fermato subito. Ma la stessa
     espressione può comparire in un messaggio di chi sta parlando di sé, e
     lì una sanzione automatica è la cosa peggiore che possa succedere: la
     persona viene zittita nel momento in cui stava chiedendo aiuto.

     Per questo la categoria esiste separata: chi configura può portarla al
     solo avviso allo staff invece che alla sanzione, e la scelta si vede. */
  ...v(
    'AUTOLESIONISMO',
    'GRAVE',
    'ammazzati',
    'uccidersi',
    'uccidetevi',
    'impiccati',
    'suicidati',
    'buttati dal balcone',
    'buttati sotto un treno',
    'taglia le vene',
    'tagliati le vene',
    'kys',
    'kill yourself',
    'ammazzatevi',
    'perche non ti ammazzi',
    'fatti fuori',
  ),

  /* ── BESTEMMIE ────────────────────────────────────────────────────────
     In molti server italiani è la sola regola davvero non negoziabile, e
     spesso l'unica che porta al ban immediato.

     Sono elencate le forme, non le combinazioni: le bestemmie si costruiscono
     accostando un nome sacro a un termine volgare, e le varianti sono
     virtualmente infinite. Elencarle tutte è impossibile; queste coprono le
     forme ricorrenti, e chi ne trova altre le aggiunge dal pannello. */
  ...v(
    'BESTEMMIA',
    'GRAVE',
    'porco dio',
    'porcodio',
    'porcoddio',
    'dio porco',
    'dio cane',
    'diocane',
    'dio boia',
    'dioboia',
    'dio bestia',
    'diobestia',
    'dio maiale',
    'dio merda',
    'dio stronzo',
    'dio infame',
    'dio ladro',
    'dio serpente',
    'madonna puttana',
    'madonna troia',
    'madonna maiala',
    'porca madonna',
    'porcamadonna',
    'madonna impestata',
    'cristo di dio',
    'gesu cristo porco',
    'porco gesu',
    'santo dio porco',
    'dio can',
    'dio caro',
  ),

  /* ── SESSUALE ─────────────────────────────────────────────────────────
     Spenta di default. Su un server di adulti la conversazione sessuale può
     essere legittima, e accenderla senza chiedere significa moderare una
     comunità che non si conosce.

     Restano fuori i termini anatomici usati anche in contesto medico o
     educativo: bloccarli è il caso da manuale del filtro che fa danno. */
  ...v(
    'SESSUALE',
    'MEDIA',
    'pompino',
    'bocchino',
    'ditalino',
    'sborra',
    'sborrata',
    'scopata',
    'scopare',
    'trombare',
    'inculare',
    'inculata',
    'sega mentale',
    'farsi una sega',
    'porno',
    'pornazzo',
    'nudes',
    'mandami le tette',
    'mandami foto',
    'mostrami le tette',
  ),

  /* ── SECONDA ONDATA ───────────────────────────────────────────────────
     L'elenco iniziale copriva l'italiano più comune e si fermava lì. Le
     aggiunte qui sotto seguono gli stessi tre criteri: offensivo fuori
     contesto, nessuna parola legittima che lo contenga, gravità pari a ciò
     che uno staff farebbe davvero.

     Restano fuori, e vale la pena scriverlo: «muori» (muori dal ridere),
     «crepa» (una crepa nel muro), «sega» (l'attrezzo), «figa» (in mezza
     Italia significa «bello»), «mona» (cognome diffuso al nord-est). Sono
     parole che il filtro non può distinguere senza contesto, e ogni falso
     positivo costa più di ciò che il blocco guadagna. */

  /* Volgarità: italiano regionale e inglese corrente. */
  ...v(
    'VOLGARITA',
    'LIEVE',
    'cagata',
    'cagate',
    'stracazzo',
    'col cazzo',
    'sti cazzi',
    'cazzo me ne frega',
    'chi se ne fotte',
    'me ne fotto',
    'fottiti',
    'fottetevi',
    'vaffanbrodo',
    'porco cane',
    'porco zio',
    'porcozio',
    'mannaggia al cazzo',
    'merdata',
    'merdaio',
    'puttanaio',
    'casino del cazzo',
    'che schifo di',
    'fuck',
    'fucking',
    'fucked',
    'fuck off',
    'fuck you',
    'shit',
    'bullshit',
    'holy shit',
    'wtf',
    'stfu',
    'shut the fuck up',
  ),

  /* Insulti generici. */
  ...v(
    'INSULTO',
    'MEDIA',
    'brutto stronzo',
    'brutta stronza',
    'brutto coglione',
    'brutto scemo',
    'brutta scema',
    'stronzo di merda',
    'coglione di merda',
    'testa di minchia',
    'testa di rapa',
    'faccia di culo',
    'pezzo di cesso',
    'cesso ambulante',
    'scemo del villaggio',
    'coglionaccio',
    'minchione',
    'cazzone',
    'cazzaro',
    'sborone',
    'sbruffone',
    'pirla',
    'pirlone',
    'bischero',
    'citrullo',
    'tontolone',
    'beota',
    'scemunito',
    'sciroccato',
    'lurido',
    'sudicione',
    'cornuto',
    'cornuta',
    'figlio di mignotta',
    'pezzo di merda ambulante',
    'sacco di letame',
    'feccia',
    'sei feccia',
    'spazzatura umana',
    'immondizia umana',
    'rifiuto umano',
    'sottospecie',
    'degenerato',
    'vermiciattolo',
    'verme schifoso',
    'sanguisuga',
    'pelandrone',
    'buono a nulla',
    'sei un fallito',
    'sei un incapace',
    'sei inutile',
    'non servi a niente',
    'nessuno ti caga',
    'sparisci dalla faccia della terra',
    'levati dai coglioni',
    'togliti dai coglioni',
    'sparisci coglione',
    'stai zitta stronza',
    'chiudi il becco',
    'asshole',
    'assholes',
    'dickhead',
    'dumbass',
    'jackass',
    'motherfucker',
    'son of a bitch',
    'bitch',
    'bitches',
    'moron',
    'loser',
    'scumbag',
    'piece of shit',
    'trash human',
  ),

  /* Insulti che pesano quanto un attacco. */
  ...v('INSULTO', 'GRAVE', 'cunt', 'whore', 'slut'),

  /* Discriminazione: origine, etnia, religione. */
  ...v(
    'DISCRIMINAZIONE',
    'GRAVE',
    'nero di merda',
    'sporco nero',
    'sporco arabo',
    'sporco cinese',
    'sporco rumeno',
    'sporco albanese',
    'sporco zingaro',
    'sporco marocchino',
    'sporco terrone',
    'rom di merda',
    'zingaro di merda',
    'albanese di merda',
    'rumeno di merda',
    'cinese di merda',
    'arabo di merda',
    'africano di merda',
    'sporco immigrato',
    'immigrato di merda',
    'nigger',
    'niggers',
    'nigga',
    'chink',
    'paki',
    'wetback',
    'sporco giudeo',
    'giudeo di merda',
    'gasa gli ebrei',
    'gasare gli ebrei',
    'forno per ebrei',
    'nel forno con gli ebrei',
    'heil hitler',
    'sieg heil',
    'white power',
    'hitler aveva ragione',
    'razza inferiore',
    'razza superiore',
    'sporca razza',
  ),

  /* Discriminazione: orientamento e identità. */
  ...v(
    'DISCRIMINAZIONE',
    'GRAVE',
    'frocio di merda',
    'froci di merda',
    'brutto frocio',
    'sporco frocio',
    'finocchio di merda',
    'ricchione di merda',
    'culattone di merda',
    'checca isterica',
    'invertito',
    'lesbica di merda',
    'trans di merda',
    'travestito di merda',
    'faggot',
    'faggots',
    'tranny',
    'dyke',
    'i froci vanno bruciati',
    'i froci al rogo',
  ),

  /* Discriminazione: disabilità e salute mentale. */
  ...v(
    'DISCRIMINAZIONE',
    'GRAVE',
    'ritardato mentale',
    'ritardata mentale',
    'malato mentale',
    'malata di mente',
    'cerebroleso',
    'cerebrolesa',
    'subnormale',
    'deficiente mentale',
    'handicappato di merda',
    'sei un mongolo',
    'mongoloide di merda',
    'sei down forte',
    'da manicomio',
    'retard',
    'retarded',
    'spastic',
  ),

  /* Minacce. */
  ...v(
    'MINACCIA',
    'GRAVE',
    'ti sparo',
    'ti accoltello',
    'ti taglio la gola',
    'ti squarto',
    'ti faccio a pezzi',
    'ti spezzo le gambe',
    'ti rompo le ossa',
    'ti spacco la testa',
    'ti apro la testa',
    'ti ammazzo di botte',
    'ti gonfio di botte',
    'ti riempio di botte',
    'ti prendo a calci in faccia',
    'ti brucio vivo',
    'ti faccio saltare in aria',
    'ti seppellisco',
    'vengo a casa tua',
    'so dove lavori',
    'so dove studi',
    'so chi sei e dove stai',
    'ti trovo e ti ammazzo',
    'finisci male',
    'farai una brutta fine',
    'ti conviene sparire',
    'i will kill you',
    'ill kill you',
    'i will find you',
    'watch your back',
  ),

  /* Istigazione all'autolesionismo. */
  ...v(
    'AUTOLESIONISMO',
    'GRAVE',
    'uccidi te stesso',
    'ammazzati subito',
    'ammazzati per favore',
    'fatti del male',
    'tagliati',
    'impiccatevi',
    'suicidatevi',
    'suicidati subito',
    'spero che ti suicidi',
    'spero ti ammazzi',
    'vai a morire',
    'vai a morire ammazzato',
    'nessuno piangerebbe se morissi',
    'il mondo starebbe meglio senza di te',
    'go kill yourself',
    'hang yourself',
    'neck yourself',
    'end yourself',
    'kys now',
  ),

  /* Bestemmie: la forma unita non si ottiene dalla normalizzazione, perché
     unire due parole non è un'evasione ma un modo di scriverle. Vanno quindi
     elencate entrambe. */
  ...v(
    'BESTEMMIA',
    'GRAVE',
    'dioporco',
    'porco cristo',
    'porcocristo',
    'cristo porco',
    'cristoporco',
    'dio cristo',
    'diocristo',
    'cristo dio',
    'dio cagna',
    'diocagna',
    'dio schifoso',
    'dio marcio',
    'dio impestato',
    'dio bastardo',
    'diobastardo',
    'dio maledetto',
    'diomaiale',
    'diomerda',
    'dioladro',
    'dioinfame',
    'diostronzo',
    'dio zozzo',
    'dio mona',
    'diomona',
    'dio bono',
    'diobono',
    'dio santo porco',
    'madonna ladra',
    'madonna cane',
    'madonnacane',
    'madonna zoccola',
    'madonnaputtana',
    'madonna sconcia',
    'porca la madonna',
    'madonna del cazzo',
    'gesu di merda',
    'gesu bastardo',
    'cristo di merda',
    'dio di merda',
    'santissimo dio porco',
  ),

  /* Bestemmie attenuate: molti server le tollerano, altri no. Gravità media
     per poterle distinguere senza doverle togliere dall'elenco. */
  ...v('BESTEMMIA', 'MEDIA', 'dio santo', 'madonna mia che', 'porco il mondo', 'dio buono'),

  /* Sessuale: la categoria resta spenta di partenza. */
  ...v(
    'SESSUALE',
    'MEDIA',
    'succhiamelo',
    'succhiami il cazzo',
    'leccami il culo',
    'fammi un pompino',
    'voglio scoparti',
    'ti scoperei',
    'mandami nudes',
    'mandami una foto nuda',
    'manda le tette',
    'mostrami il culo',
    'mostrami la figa',
    'foto senza vestiti',
    'masturbarsi',
    'masturbazione',
    'sborrata in faccia',
    'gang bang',
    'blowjob',
    'handjob',
    'dick pic',
    'send nudes',
  ),

];

/* ═══════════════════════════════════════════════════════════════════════
   ECCEZIONI

   Parole legittime che contengono o somigliano a una voce dell'elenco.
   Vincono sempre, sull'elenco proprio e su quello di Discord.

   Ogni voce qui dentro è un falso positivo che non capiterà. È metà del
   lavoro, non un ripensamento: un filtro che blocca chi parla di edilizia o
   nomina una città insegna in un pomeriggio che il bot va ignorato, e da quel
   momento non serve più nemmeno per gli insulti veri.
   ═══════════════════════════════════════════════════════════════════════ */
export const DEFAULT_ALLOWLIST: string[] = [
  // introdotte con la seconda ondata di termini
  'shitake',
  'shiatsu',
  'fucus',
  'moronico',
  'morone',
  'bitchon',
  'slutsk',
  'cunta',
  'niger',
  'nigeria',
  'nigeriano',
  'nigeriana',
  'paking',
  'chinotto',
  'dyker',
  'spastico muscolare',
  'retardante',
  'ritardo',
  'ritardatario',
  'cagata di piccione',
  'feccia di vino',
  'sanguisuga medicinale',
  // contengono «cazzo» o «cazz»
  'cazzuola',
  'cazzuole',
  'scazzottata',
  'incazzatura',
  'scazzo',
  // contengono «merd»
  'merletto',
  'merletti',
  'merluzzo',
  // contengono «troia» o «puttan»
  'troiaio',
  'cavallo di troia',
  'guerra di troia',
  // contengono «negr»
  'negrita',
  'denegrire',
  // contengono «frocio» o «finocchio» in senso proprio
  'finocchi',
  'finocchietto',
  'risotto ai finocchi',
  // luoghi e nomi propri
  'cagliari',
  'arsenale',
  'porcari',
  'montecchio',
  'cazzago',
  // termini comuni che l'elenco LDNOOBW segnalerebbe
  'pesce',
  'pesci',
  'regina',
  'cadavere',
  'balle',
  'montare',
  'monta',
  'tirare',
  'battere',
  'sbattere',
  'quaglia',
  'boiata',
  'mannaggia',
  'porca miseria',
  'cacca',
  'pipi',
  'anale',
  'analisi',
  'canale',
  'banale',
  'penale',
  'segale',
  'seghetto',
  'passera',
  'fava',
  'fave',
  'topa',
  'topo',
  'culatello',
  'cozze',
  'vacca',
  'vacche',
];
