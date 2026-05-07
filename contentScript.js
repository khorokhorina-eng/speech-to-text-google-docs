const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
const HAS_RECOGNITION_SUPPORT = Boolean(SpeechRecognitionCtor);

const state = {
  connected: true,
  supported: HAS_RECOGNITION_SUPPORT,
  isDocsPage: location.href.startsWith("https://docs.google.com/document/"),
  status: HAS_RECOGNITION_SUPPORT ? "idle" : "unsupported",
  message: HAS_RECOGNITION_SUPPORT
    ? "Click inside Google Docs and start dictation."
    : "This browser does not support speech recognition for this extension.",
  transcript: "",
  interimTranscript: "",
  docTitle: document.title.replace(/\s*-\s*Google Docs\s*$/, ""),
  language: navigator.language || "en-US",
  insertedChars: 0,
  sessionSeconds: 0,
  cursorReady: false,
};

const SPOKEN_PUNCTUATION = {
  am: {
    newParagraph: ["አዲስ አንቀጽ"],
    newLine: ["አዲስ መስመር"],
    listItem: ["የዝርዝር ንጥል"],
    comma: ["ኮማ"],
    period: ["ነጥብ"],
    questionMark: ["ጥያቄ ምልክት"],
    exclamationMark: ["ቃለ አጋንንት ምልክት"],
    colon: ["ሁለት ነጥብ"],
    semicolon: ["ሴሚኮሎን"],
    quote: ["ትርኢት ምልክት", "ጥቅስ"],
    dash: ["ሰረዝ"],
  },
  ar: {
    newParagraph: ["فقرة جديدة"],
    newLine: ["سطر جديد"],
    listItem: ["عنصر قائمة", "تعداد نقطي"],
    comma: ["فاصلة"],
    period: ["نقطة"],
    questionMark: ["علامة استفهام"],
    exclamationMark: ["علامة تعجب"],
    colon: ["نقطتان"],
    semicolon: ["فاصلة منقوطة"],
    quote: ["علامة اقتباس", "اقتباس"],
    dash: ["شرطة", "واصلة"],
  },
  bg: {
    newParagraph: ["нов абзац"],
    newLine: ["нов ред"],
    listItem: ["елемент от списък", "точка от списък"],
    comma: ["запетая"],
    period: ["точка"],
    questionMark: ["въпросителен знак"],
    exclamationMark: ["удивителен знак"],
    colon: ["двоеточие"],
    semicolon: ["точка и запетая"],
    quote: ["кавички", "кавычка"],
    dash: ["тире", "дефис"],
  },
  bn: {
    newParagraph: ["নতুন অনুচ্ছেদ"],
    newLine: ["নতুন লাইন"],
    listItem: ["তালিকার আইটেম", "বুলেট পয়েন্ট"],
    comma: ["কমা"],
    period: ["দাঁড়ি", "পূর্ণচ্ছেদ"],
    questionMark: ["প্রশ্নবোধক চিহ্ন"],
    exclamationMark: ["বিস্ময়বোধক চিহ্ন"],
    colon: ["কোলন"],
    semicolon: ["সেমিকোলন"],
    quote: ["উদ্ধৃতি চিহ্ন", "কোট"],
    dash: ["ড্যাশ", "হাইফেন"],
  },
  ca: {
    newParagraph: ["paràgraf nou"],
    newLine: ["línia nova"],
    listItem: ["element de llista", "vinyeta"],
    comma: ["coma"],
    period: ["punt"],
    questionMark: ["signe d'interrogació"],
    exclamationMark: ["signe d'exclamació"],
    colon: ["dos punts"],
    semicolon: ["punt i coma"],
    quote: ["cometes", "cometa"],
    dash: ["guió"],
  },
  cs: {
    newParagraph: ["nový odstavec"],
    newLine: ["nový řádek"],
    listItem: ["položka seznamu", "odrážka"],
    comma: ["čárka"],
    period: ["tečka"],
    questionMark: ["otazník"],
    exclamationMark: ["vykřičník"],
    colon: ["dvojtečka"],
    semicolon: ["středník"],
    quote: ["uvozovky", "uvozovka"],
    dash: ["pomlčka", "spojovník"],
  },
  da: {
    newParagraph: ["nyt afsnit"],
    newLine: ["ny linje"],
    listItem: ["listepunkt", "punkttegn"],
    comma: ["komma"],
    period: ["punktum"],
    questionMark: ["spørgsmålstegn"],
    exclamationMark: ["udråbstegn"],
    colon: ["kolon"],
    semicolon: ["semikolon"],
    quote: ["anførselstegn", "citattegn"],
    dash: ["tankestreg", "bindestreg"],
  },
  de: {
    newParagraph: ["neuer absatz"],
    newLine: ["neue zeile"],
    listItem: ["listenelement", "aufzählungspunkt"],
    comma: ["komma"],
    period: ["punkt"],
    questionMark: ["fragezeichen"],
    exclamationMark: ["ausrufezeichen"],
    colon: ["doppelpunkt"],
    semicolon: ["semikolon"],
    quote: ["anführungszeichen", "zitatzeichen"],
    dash: ["gedankenstrich", "bindestrich"],
  },
  el: {
    newParagraph: ["νέα παράγραφος"],
    newLine: ["νέα γραμμή"],
    listItem: ["στοιχείο λίστας", "κουκκίδα"],
    comma: ["κόμμα"],
    period: ["τελεία"],
    questionMark: ["ερωτηματικό"],
    exclamationMark: ["θαυμαστικό"],
    colon: ["άνω κάτω τελεία"],
    semicolon: ["άνω τελεία"],
    quote: ["εισαγωγικά", "εισαγωγικό"],
    dash: ["παύλα", "ενωτικό"],
  },
  en: {
    newParagraph: ["new paragraph"],
    newLine: ["new line", "next line"],
    listItem: ["list item", "bullet point"],
    comma: ["comma"],
    period: ["period", "full stop"],
    questionMark: ["question mark"],
    exclamationMark: ["exclamation mark", "exclamation point"],
    colon: ["colon"],
    semicolon: ["semicolon"],
    quote: ["quote", "open quote", "close quote"],
    dash: ["dash", "hyphen"],
  },
  es: {
    newParagraph: ["nuevo párrafo", "nuevo parrafo"],
    newLine: ["nueva línea", "nueva linea"],
    listItem: ["elemento de lista", "viñeta", "vineta"],
    comma: ["coma"],
    period: ["punto"],
    questionMark: ["signo de interrogación", "signo de interrogacion"],
    exclamationMark: ["signo de exclamación", "signo de exclamacion"],
    colon: ["dos puntos"],
    semicolon: ["punto y coma"],
    quote: ["comillas", "comilla"],
    dash: ["guion", "guión", "raya"],
  },
  es_419: {
    newParagraph: ["nuevo párrafo", "nuevo parrafo"],
    newLine: ["nueva línea", "nueva linea"],
    listItem: ["elemento de lista", "viñeta", "vineta"],
    comma: ["coma"],
    period: ["punto"],
    questionMark: ["signo de interrogación", "signo de interrogacion"],
    exclamationMark: ["signo de exclamación", "signo de exclamacion"],
    colon: ["dos puntos"],
    semicolon: ["punto y coma"],
    quote: ["comillas", "comilla"],
    dash: ["guion", "guión", "raya"],
  },
  et: {
    newParagraph: ["uus lõik"],
    newLine: ["uus rida"],
    listItem: ["loendi element", "täpp"],
    comma: ["koma"],
    period: ["punkt"],
    questionMark: ["küsimärk"],
    exclamationMark: ["hüüumärk"],
    colon: ["koolon"],
    semicolon: ["semikoolon"],
    quote: ["jutumärgid", "jutumärk"],
    dash: ["mõttekriips", "sidekriips"],
  },
  fa: {
    newParagraph: ["پاراگراف جدید"],
    newLine: ["خط جدید"],
    listItem: ["مورد فهرست", "بولت"],
    comma: ["ویرگول"],
    period: ["نقطه"],
    questionMark: ["علامت سوال"],
    exclamationMark: ["علامت تعجب"],
    colon: ["دو نقطه"],
    semicolon: ["نقطه ویرگول"],
    quote: ["گیومه", "علامت نقل قول"],
    dash: ["خط تیره", "هایفن"],
  },
  fi: {
    newParagraph: ["uusi kappale"],
    newLine: ["uusi rivi"],
    listItem: ["luettelokohta", "bullet point"],
    comma: ["pilkku"],
    period: ["piste"],
    questionMark: ["kysymysmerkki"],
    exclamationMark: ["huutomerkki"],
    colon: ["kaksoispiste"],
    semicolon: ["puolipiste"],
    quote: ["lainausmerkki", "lainausmerkit"],
    dash: ["ajatusviiva", "tavuviiva"],
  },
  fil: {
    newParagraph: ["bagong talata"],
    newLine: ["bagong linya"],
    listItem: ["item sa listahan", "bullet point"],
    comma: ["kuwit"],
    period: ["tuldok"],
    questionMark: ["tandang pananong"],
    exclamationMark: ["tandang padamdam"],
    colon: ["kolon"],
    semicolon: ["semikolon"],
    quote: ["panipi", "panandang sipi"],
    dash: ["gitling", "dash"],
  },
  fr: {
    newParagraph: ["nouveau paragraphe"],
    newLine: ["nouvelle ligne"],
    listItem: ["élément de liste", "element de liste", "puce"],
    comma: ["virgule"],
    period: ["point"],
    questionMark: ["point d'interrogation"],
    exclamationMark: ["point d'exclamation"],
    colon: ["deux-points", "deux points"],
    semicolon: ["point-virgule", "point virgule"],
    quote: ["guillemets", "guillemet"],
    dash: ["tiret"],
  },
  gu: {
    newParagraph: ["નવો પરિચ્છેદ"],
    newLine: ["નવી લીટી"],
    listItem: ["યાદીનું આઇટમ", "બુલેટ પોઇન્ટ"],
    comma: ["અલ્પવિરામ"],
    period: ["પૂર્ણવિરામ"],
    questionMark: ["પ્રશ્નચિહ્ન"],
    exclamationMark: ["વિસ્મયાદિબોધક ચિહ્ન"],
    colon: ["કોલન"],
    semicolon: ["સેમીકોલન"],
    quote: ["ઉદ્ધરણ ચિહ્ન", "ક્વોટ"],
    dash: ["ડેશ", "હાઇફન"],
  },
  he: {
    newParagraph: ["פסקה חדשה"],
    newLine: ["שורה חדשה"],
    listItem: ["פריט רשימה", "נקודת תבליט"],
    comma: ["פסיק"],
    period: ["נקודה"],
    questionMark: ["סימן שאלה"],
    exclamationMark: ["סימן קריאה"],
    colon: ["נקודתיים"],
    semicolon: ["נקודה פסיק"],
    quote: ["מרכאות", "ציטוט"],
    dash: ["מקף", "קו מפריד"],
  },
  hi: {
    newParagraph: ["नया पैराग्राफ", "नया अनुच्छेद"],
    newLine: ["नई पंक्ति", "नई लाइन"],
    listItem: ["सूची आइटम", "बुलेट पॉइंट"],
    comma: ["अल्पविराम", "कॉमा"],
    period: ["पूर्ण विराम", "विराम", "डॉट"],
    questionMark: ["प्रश्नवाचक चिन्ह"],
    exclamationMark: ["विस्मयादिबोधक चिन्ह"],
    colon: ["कोलन"],
    semicolon: ["सेमीकोलन"],
    quote: ["उद्धरण चिन्ह", "कोट"],
    dash: ["डैश", "हाइफ़न", "हाइफन"],
  },
  hr: {
    newParagraph: ["novi odlomak"],
    newLine: ["novi redak"],
    listItem: ["stavka popisa", "točka popisa"],
    comma: ["zarez"],
    period: ["točka"],
    questionMark: ["upitnik"],
    exclamationMark: ["uskličnik"],
    colon: ["dvotočka"],
    semicolon: ["točka sa zarezom"],
    quote: ["navodnici", "navodnik"],
    dash: ["crtica", "spojnica"],
  },
  hu: {
    newParagraph: ["új bekezdés"],
    newLine: ["új sor"],
    listItem: ["listaelem", "felsorolásjel"],
    comma: ["vessző"],
    period: ["pont"],
    questionMark: ["kérdőjel"],
    exclamationMark: ["felkiáltójel"],
    colon: ["kettőspont"],
    semicolon: ["pontosvessző"],
    quote: ["idézőjel", "idézőjelek"],
    dash: ["gondolatjel", "kötőjel"],
  },
  id: {
    newParagraph: ["paragraf baru"],
    newLine: ["baris baru"],
    listItem: ["item daftar", "poin bullet"],
    comma: ["koma"],
    period: ["titik"],
    questionMark: ["tanda tanya"],
    exclamationMark: ["tanda seru"],
    colon: ["titik dua"],
    semicolon: ["titik koma"],
    quote: ["tanda kutip", "kutip"],
    dash: ["tanda pisah", "strip"],
  },
  it: {
    newParagraph: ["nuovo paragrafo"],
    newLine: ["nuova riga"],
    listItem: ["elemento elenco", "punto elenco"],
    comma: ["virgola"],
    period: ["punto"],
    questionMark: ["punto interrogativo"],
    exclamationMark: ["punto esclamativo"],
    colon: ["due punti"],
    semicolon: ["punto e virgola"],
    quote: ["virgolette", "virgoletta"],
    dash: ["trattino"],
  },
  ja: {
    newParagraph: ["新しい段落"],
    newLine: ["改行", "新しい行"],
    listItem: ["箇条書き", "リスト項目"],
    comma: ["読点", "コンマ"],
    period: ["句点", "ピリオド"],
    questionMark: ["疑問符", "クエスチョンマーク"],
    exclamationMark: ["感嘆符", "エクスクラメーションマーク"],
    colon: ["コロン"],
    semicolon: ["セミコロン"],
    quote: ["引用符", "かぎかっこ"],
    dash: ["ダッシュ", "ハイフン"],
  },
  kn: {
    newParagraph: ["ಹೊಸ ಪ್ಯಾರಾಗ್ರಾಫ್"],
    newLine: ["ಹೊಸ ಸಾಲು"],
    listItem: ["ಪಟ್ಟಿ ಐಟಂ", "ಬುಲೆಟ್ ಪಾಯಿಂಟ್"],
    comma: ["ಅಲ್ಪ ವಿರಾಮ"],
    period: ["ಪೂರ್ಣ ವಿರಾಮ"],
    questionMark: ["ಪ್ರಶ್ನಾರ್ಥಕ ಚಿಹ್ನೆ"],
    exclamationMark: ["ವಿಸ್ಮಯ ಸೂಚಕ ಚಿಹ್ನೆ"],
    colon: ["ಕೋಲನ್"],
    semicolon: ["ಸೆಮಿಕೋಲನ್"],
    quote: ["ಉದ್ಧರಣ ಚಿಹ್ನೆ", "ಕೋಟ್"],
    dash: ["ಡ್ಯಾಶ್", "ಹೈಫನ್"],
  },
  ko: {
    newParagraph: ["새 문단"],
    newLine: ["새 줄"],
    listItem: ["목록 항목", "글머리 기호"],
    comma: ["쉼표"],
    period: ["마침표"],
    questionMark: ["물음표"],
    exclamationMark: ["느낌표"],
    colon: ["콜론"],
    semicolon: ["세미콜론"],
    quote: ["따옴표", "인용 부호"],
    dash: ["대시", "하이픈"],
  },
  lt: {
    newParagraph: ["nauja pastraipa"],
    newLine: ["nauja eilutė", "nauja eilute"],
    listItem: ["sąrašo elementas", "saraso elementas", "ženklelis", "zenklelis"],
    comma: ["kablelis"],
    period: ["taškas", "taskas"],
    questionMark: ["klaustukas"],
    exclamationMark: ["šauktukas", "sauktukas"],
    colon: ["dvitaškis", "dvitaskis"],
    semicolon: ["kabliataškis", "kabliataskis"],
    quote: ["kabutės", "kabutes"],
    dash: ["brūkšnys", "bruksnys", "brūkšnelis", "bruksnelis"],
  },
  lv: {
    newParagraph: ["jauna rindkopa"],
    newLine: ["jauna rinda"],
    listItem: ["saraksta vienums", "aizzīme", "aizzime"],
    comma: ["komats"],
    period: ["punkts"],
    questionMark: ["jautājuma zīme", "jautajuma zime"],
    exclamationMark: ["izsaukuma zīme", "izsaukuma zime"],
    colon: ["kols"],
    semicolon: ["semikols"],
    quote: ["pēdiņas", "pedinas"],
    dash: ["domuzīme", "domuzime", "defise"],
  },
  ml: {
    newParagraph: ["പുതിയ അനുച്ഛേദം"],
    newLine: ["പുതിയ വരി"],
    listItem: ["പട്ടിക ഇനം", "ബുള്ളറ്റ് പോയിന്റ്"],
    comma: ["അल्पവിരാമം"],
    period: ["പൂർണ്ണവിരാമം"],
    questionMark: ["ചോദ്യംചിഹ്നം"],
    exclamationMark: ["വിശ്മയാദിബോധക ചിഹ്നം"],
    colon: ["കോളൺ"],
    semicolon: ["സെമിക്കോളൺ"],
    quote: ["ഉദ്ധരണി ചിഹ്നം", "ക്വോട്ട്"],
    dash: ["ഡാഷ്", "ഹൈഫൺ"],
  },
  mr: {
    newParagraph: ["नवा परिच्छेद"],
    newLine: ["नवी ओळ"],
    listItem: ["यादी घटक", "बुलेट पॉइंट"],
    comma: ["स्वल्पविराम"],
    period: ["पूर्णविराम"],
    questionMark: ["प्रश्नचिन्ह"],
    exclamationMark: ["उद्गारवाचक चिन्ह"],
    colon: ["कोलन"],
    semicolon: ["अर्धविराम"],
    quote: ["अवतरण चिन्ह", "कोट"],
    dash: ["डॅश", "हायफन"],
  },
  ms: {
    newParagraph: ["perenggan baharu"],
    newLine: ["baris baharu"],
    listItem: ["item senarai", "poin peluru"],
    comma: ["koma"],
    period: ["titik"],
    questionMark: ["tanda soal"],
    exclamationMark: ["tanda seru"],
    colon: ["titik bertindih"],
    semicolon: ["titik koma"],
    quote: ["tanda petik", "petikan"],
    dash: ["sempang", "dash"],
  },
  nl: {
    newParagraph: ["nieuwe alinea"],
    newLine: ["nieuwe regel"],
    listItem: ["lijstitem", "opsommingsteken"],
    comma: ["komma"],
    period: ["punt"],
    questionMark: ["vraagteken"],
    exclamationMark: ["uitroepteken"],
    colon: ["dubbele punt"],
    semicolon: ["puntkomma"],
    quote: ["aanhalingstekens", "aanhalingsteken"],
    dash: ["gedachtestreepje", "koppelteken"],
  },
  no: {
    newParagraph: ["nytt avsnitt"],
    newLine: ["ny linje"],
    listItem: ["listepunkt", "punkttegn"],
    comma: ["komma"],
    period: ["punktum"],
    questionMark: ["spørsmålstegn", "sporsmalstegn"],
    exclamationMark: ["utropstegn"],
    colon: ["kolon"],
    semicolon: ["semikolon"],
    quote: ["anførselstegn", "anforselstegn"],
    dash: ["tankestrek", "bindestrek"],
  },
  pl: {
    newParagraph: ["nowy akapit"],
    newLine: ["nowa linia"],
    listItem: ["element listy", "punkt listy"],
    comma: ["przecinek"],
    period: ["kropka"],
    questionMark: ["znak zapytania"],
    exclamationMark: ["wykrzyknik"],
    colon: ["dwukropek"],
    semicolon: ["średnik", "srednik"],
    quote: ["cudzysłów", "cudzyslow"],
    dash: ["myślnik", "myslnik", "łącznik", "lacznik"],
  },
  pt_BR: {
    newParagraph: ["novo parágrafo", "novo paragrafo"],
    newLine: ["nova linha"],
    listItem: ["item da lista", "marcador"],
    comma: ["vírgula", "virgula"],
    period: ["ponto"],
    questionMark: ["ponto de interrogação", "ponto de interrogacao"],
    exclamationMark: ["ponto de exclamação", "ponto de exclamacao"],
    colon: ["dois pontos"],
    semicolon: ["ponto e vírgula", "ponto e virgula"],
    quote: ["aspas", "citação", "citacao"],
    dash: ["travessão", "travessao", "hífen", "hifen"],
  },
  pt_PT: {
    newParagraph: ["novo parágrafo", "novo paragrafo"],
    newLine: ["nova linha"],
    listItem: ["item da lista", "marcador"],
    comma: ["vírgula", "virgula"],
    period: ["ponto"],
    questionMark: ["ponto de interrogação", "ponto de interrogacao"],
    exclamationMark: ["ponto de exclamação", "ponto de exclamacao"],
    colon: ["dois pontos"],
    semicolon: ["ponto e vírgula", "ponto e virgula"],
    quote: ["aspas", "citação", "citacao"],
    dash: ["travessão", "travessao", "hífen", "hifen"],
  },
  ro: {
    newParagraph: ["paragraf nou"],
    newLine: ["linie nouă", "linie noua"],
    listItem: ["element de listă", "element de lista", "punct de listă", "punct de lista"],
    comma: ["virgulă", "virgula"],
    period: ["punct"],
    questionMark: ["semn de întrebare", "semn de intrebare"],
    exclamationMark: ["semn de exclamare"],
    colon: ["două puncte", "doua puncte"],
    semicolon: ["punct și virgulă", "punct si virgula"],
    quote: ["ghilimele", "ghilimea"],
    dash: ["liniuță", "liniuta", "cratimă", "cratima"],
  },
  ru: {
    newParagraph: ["новый абзац"],
    newLine: ["новая строка", "следующая строка"],
    listItem: ["элемент списка", "маркер списка", "пункт списка"],
    comma: ["запятая"],
    period: ["точка"],
    questionMark: ["вопросительный знак"],
    exclamationMark: ["восклицательный знак"],
    colon: ["двоеточие"],
    semicolon: ["точка с запятой"],
    quote: ["кавычки", "открыть кавычки", "закрыть кавычки"],
    dash: ["тире", "дефис"],
  },
  sk: {
    newParagraph: ["nový odsek"],
    newLine: ["nový riadok"],
    listItem: ["položka zoznamu", "odrážka"],
    comma: ["čiarka", "ciarka"],
    period: ["bodka"],
    questionMark: ["otáznik", "otaznik"],
    exclamationMark: ["výkričník", "vykricnik"],
    colon: ["dvojbodka"],
    semicolon: ["bodkočiarka", "bodkociarka"],
    quote: ["úvodzovky", "uvodzovky"],
    dash: ["pomlčka", "pomlcka", "spojovník", "spojovnik"],
  },
  sl: {
    newParagraph: ["nov odstavek"],
    newLine: ["nova vrstica"],
    listItem: ["element seznama", "oznaka"],
    comma: ["vejica"],
    period: ["pika"],
    questionMark: ["vprašaj", "vprasaj"],
    exclamationMark: ["klicaj"],
    colon: ["dvopičje", "dvopicje"],
    semicolon: ["podpičje", "podpicje"],
    quote: ["narekovaji", "narekovaj"],
    dash: ["pomišljaj", "pomisljaj", "vezaj"],
  },
  sr: {
    newParagraph: ["нови пасус", "novi pasus"],
    newLine: ["нови ред", "novi red"],
    listItem: ["ставка листе", "stavka liste", "тачка листе", "tacka liste"],
    comma: ["зарез", "zarez"],
    period: ["тачка", "tacka"],
    questionMark: ["упитник", "upitnik"],
    exclamationMark: ["узвичник", "uzvicnik"],
    colon: ["двотачка", "dvotacka"],
    semicolon: ["тачка и зарез", "tacka i zarez"],
    quote: ["наводници", "navodnici"],
    dash: ["цртица", "crtica", "црта", "crta"],
  },
  sv: {
    newParagraph: ["nytt stycke"],
    newLine: ["ny rad"],
    listItem: ["listpunkt", "punktlista"],
    comma: ["komma"],
    period: ["punkt"],
    questionMark: ["frågetecken", "fragetecken"],
    exclamationMark: ["utropstecken"],
    colon: ["kolon"],
    semicolon: ["semikolon"],
    quote: ["citationstecken", "citattecken"],
    dash: ["tankstreck", "bindestreck"],
  },
  sw: {
    newParagraph: ["aya mpya"],
    newLine: ["mstari mpya"],
    listItem: ["kipengee cha orodha", "alama ya risasi"],
    comma: ["koma"],
    period: ["nukta"],
    questionMark: ["alama ya swali"],
    exclamationMark: ["alama ya mshangao"],
    colon: ["koloni"],
    semicolon: ["nukta mkato"],
    quote: ["alama za nukuu", "nukuu"],
    dash: ["mstari", "deshi"],
  },
  ta: {
    newParagraph: ["புதிய பத்தி"],
    newLine: ["புதிய வரி"],
    listItem: ["பட்டியல் உருப்பு", "புல்லெட் பாயிண்ட்"],
    comma: ["காற்புள்ளி"],
    period: ["முற்றுப்புள்ளி"],
    questionMark: ["கேள்விக்குறி"],
    exclamationMark: ["உயிர்ப்பு குறி", "வியப்புக்குறி"],
    colon: ["கோலன்"],
    semicolon: ["செமிகோலன்"],
    quote: ["மேற்கோள் குறி", "கோட்"],
    dash: ["டாஷ்", "ஹைபன்"],
  },
  te: {
    newParagraph: ["కొత్త పేరాగ్రాఫ్"],
    newLine: ["కొత్త పంక్తి"],
    listItem: ["జాబితా అంశం", "బుల్లెట్ పాయింట్"],
    comma: ["కామా"],
    period: ["పూర్తి విరామం", "చుక్క"],
    questionMark: ["ప్రశ్నార్థక చిహ్నం"],
    exclamationMark: ["ఆశ్చర్యార్థక చిహ్నం"],
    colon: ["కోలన్"],
    semicolon: ["సెమీకోలన్"],
    quote: ["ఉద్ధరణ చిహ్నం", "కోట్"],
    dash: ["డ్యాష్", "హైఫెన్"],
  },
  th: {
    newParagraph: ["ย่อหน้าใหม่"],
    newLine: ["บรรทัดใหม่"],
    listItem: ["รายการใหม่", "หัวข้อย่อย"],
    comma: ["จุลภาค", "คอมมา"],
    period: ["จุด", "มหัพภาค"],
    questionMark: ["เครื่องหมายคำถาม"],
    exclamationMark: ["เครื่องหมายอัศเจรีย์"],
    colon: ["โคลอน"],
    semicolon: ["เซมิโคลอน"],
    quote: ["เครื่องหมายอัญประกาศ", "อัญประกาศ"],
    dash: ["ขีดกลาง", "แดช"],
  },
  tr: {
    newParagraph: ["yeni paragraf"],
    newLine: ["yeni satır", "yeni satir"],
    listItem: ["liste öğesi", "liste ogesi", "madde imi"],
    comma: ["virgül", "virgul"],
    period: ["nokta"],
    questionMark: ["soru işareti", "soru isareti"],
    exclamationMark: ["ünlem işareti", "unlem isareti"],
    colon: ["iki nokta"],
    semicolon: ["noktalı virgül", "noktali virgul"],
    quote: ["tırnak işareti", "tirnak isareti", "tırnak", "tirnak"],
    dash: ["tire", "kısa çizgi", "kisa cizgi"],
  },
  uk: {
    newParagraph: ["новий абзац"],
    newLine: ["новий рядок"],
    listItem: ["елемент списку", "маркер списку"],
    comma: ["кома"],
    period: ["крапка"],
    questionMark: ["знак питання"],
    exclamationMark: ["знак оклику"],
    colon: ["двокрапка"],
    semicolon: ["крапка з комою"],
    quote: ["лапки", "відкрити лапки", "закрити лапки"],
    dash: ["тире", "дефіс"],
  },
  vi: {
    newParagraph: ["đoạn mới", "doan moi"],
    newLine: ["dòng mới", "dong moi"],
    listItem: ["mục danh sách", "muc danh sach", "dấu đầu dòng", "dau dau dong"],
    comma: ["dấu phẩy", "dau phay"],
    period: ["dấu chấm", "dau cham"],
    questionMark: ["dấu hỏi", "dau hoi"],
    exclamationMark: ["dấu chấm than", "dau cham than"],
    colon: ["dấu hai chấm", "dau hai cham"],
    semicolon: ["dấu chấm phẩy", "dau cham phay"],
    quote: ["dấu ngoặc kép", "dau ngoac kep", "trích dẫn", "trich dan"],
    dash: ["dấu gạch ngang", "dau gach ngang"],
  },
  zh_CN: {
    newParagraph: ["新段落"],
    newLine: ["换行", "新的一行"],
    listItem: ["列表项", "项目符号"],
    comma: ["逗号"],
    period: ["句号", "点号"],
    questionMark: ["问号"],
    exclamationMark: ["感叹号"],
    colon: ["冒号"],
    semicolon: ["分号"],
    quote: ["引号"],
    dash: ["破折号", "连字符"],
  },
  zh_TW: {
    newParagraph: ["新段落"],
    newLine: ["換行", "新的一行"],
    listItem: ["列表項", "項目符號"],
    comma: ["逗號"],
    period: ["句號", "點號"],
    questionMark: ["問號"],
    exclamationMark: ["驚嘆號", "感嘆號"],
    colon: ["冒號"],
    semicolon: ["分號"],
    quote: ["引號"],
    dash: ["破折號", "連字號"],
  },
};

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createPhrasePattern(phrases) {
  return new RegExp(`(${phrases.map(escapeForRegex).sort((a, b) => b.length - a.length).join("|")})`, "giu");
}

function createTailPattern(phrases) {
  return new RegExp(`(?:^|\\s)(${phrases.map(escapeForRegex).sort((a, b) => b.length - a.length).join("|")})\\s*$`, "iu");
}

function punctuationWithTrailingSpace(sign) {
  return `${sign} `;
}

function buildVoiceCommands(locale) {
  const normalizedLocale = String(locale || "en").replace("-", "_");
  const baseLocale = normalizedLocale.split("_")[0];
  const dictionary =
    SPOKEN_PUNCTUATION[normalizedLocale] ||
    SPOKEN_PUNCTUATION[baseLocale] ||
    SPOKEN_PUNCTUATION.en;

  return [
    { pattern: createPhrasePattern(dictionary.newParagraph), value: "\n\n" },
    { pattern: createPhrasePattern(dictionary.newLine), value: "\n" },
    { pattern: createPhrasePattern(dictionary.listItem), value: "\n- " },
    {
      pattern: createPhrasePattern(dictionary.comma),
      value: punctuationWithTrailingSpace(","),
      tailPattern: createTailPattern(dictionary.comma),
    },
    {
      pattern: createPhrasePattern(dictionary.period),
      value: punctuationWithTrailingSpace("."),
      tailPattern: createTailPattern(dictionary.period),
    },
    {
      pattern: createPhrasePattern(dictionary.questionMark),
      value: punctuationWithTrailingSpace("?"),
      tailPattern: createTailPattern(dictionary.questionMark),
    },
    {
      pattern: createPhrasePattern(dictionary.exclamationMark),
      value: punctuationWithTrailingSpace("!"),
      tailPattern: createTailPattern(dictionary.exclamationMark),
    },
    {
      pattern: createPhrasePattern(dictionary.colon),
      value: punctuationWithTrailingSpace(":"),
      tailPattern: createTailPattern(dictionary.colon),
    },
    {
      pattern: createPhrasePattern(dictionary.semicolon),
      value: punctuationWithTrailingSpace(";"),
      tailPattern: createTailPattern(dictionary.semicolon),
    },
    { pattern: createPhrasePattern(dictionary.quote), value: '"' },
    {
      pattern: createPhrasePattern(dictionary.dash),
      value: " - ",
      tailPattern: createTailPattern(dictionary.dash),
    },
  ];
}

const COMMAND_PATTERNS = {
  undo: /^(undo|go back)$/i,
  deleteLastSentence: /^(delete last sentence|remove last sentence)$/i,
};

let recognition = null;
let desiredRunning = false;
let sessionStartedAtMs = 0;
let sessionSecondsTimer = null;
let lastFocusedTarget = null;
let lastKnownSelectionRange = null;
let iframeListenersBound = false;
let transcriptOverlay = null;
let insertionQueue = Promise.resolve();
let restartTimer = null;
let insertionHistory = [];
let manualStopMessage = "Dictation stopped.";
let terminalEndState = null;
let pendingInterimText = "";
const ACTIVE_VOICE_COMMANDS = buildVoiceCommands(state.language);

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed."));
        return;
      }
      resolve(response);
    });
  });
}

function sendStateUpdate() {
  chrome.runtime.sendMessage({
    type: "dictationStateUpdate",
    state: {
      ...state,
      docTitle: document.title.replace(/\s*-\s*Google Docs\s*$/, ""),
    },
  });
}

function setStatus(status, message = "") {
  state.status = status;
  state.message = message;
  sendStateUpdate();
}

function clearSessionSecondsTimer() {
  if (sessionSecondsTimer) {
    clearInterval(sessionSecondsTimer);
    sessionSecondsTimer = null;
  }
}

function startSessionTimer() {
  sessionStartedAtMs = Date.now();
  state.sessionSeconds = 0;
  clearSessionSecondsTimer();
  sessionSecondsTimer = setInterval(() => {
    state.sessionSeconds = Math.max(0, Math.floor((Date.now() - sessionStartedAtMs) / 1000));
    sendStateUpdate();
  }, 1000);
}

function stopSessionTimer() {
  sessionStartedAtMs = 0;
  state.sessionSeconds = 0;
  clearSessionSecondsTimer();
}

function isTextInputTarget(target) {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && /^(text|search|url|email|tel)$/i.test(target.type))
  );
}

function isValidInsertionTarget(target) {
  if (!target) {
    return false;
  }

  if (isTextInputTarget(target)) {
    return true;
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }

  if (target.ownerDocument && target.ownerDocument !== document) {
    return true;
  }

  return false;
}

function rememberFocusedTarget(target) {
  if (!target || !isValidInsertionTarget(target)) {
    return;
  }

  lastFocusedTarget = target;
  captureSelection(target);
  state.cursorReady = true;
  sendStateUpdate();
}

function captureSelection(target) {
  const ownerDocument = target?.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const selection = ownerWindow.getSelection ? ownerWindow.getSelection() : null;
  if (!selection || !selection.rangeCount) {
    return false;
  }

  try {
    lastKnownSelectionRange = selection.getRangeAt(0).cloneRange();
    return true;
  } catch (_error) {
    return false;
  }
}

function restoreSelection(target) {
  if (!lastKnownSelectionRange) {
    return null;
  }

  const ownerDocument =
    lastKnownSelectionRange.startContainer?.ownerDocument || target?.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const selection = ownerWindow.getSelection ? ownerWindow.getSelection() : null;
  if (!selection) {
    return null;
  }

  try {
    selection.removeAllRanges();
    selection.addRange(lastKnownSelectionRange.cloneRange());
    return selection;
  } catch (_error) {
    return null;
  }
}

function getIframeBody() {
  const iframe = document.querySelector(".docs-texteventtarget-iframe");
  return iframe?.contentDocument?.body || null;
}

function bindIframeListeners() {
  const iframe = document.querySelector(".docs-texteventtarget-iframe");
  const iframeDocument = iframe?.contentDocument || null;
  if (!iframeDocument || iframeListenersBound) {
    return;
  }

  const markReady = () => {
    const target = iframeDocument.activeElement || iframeDocument.body;
    rememberFocusedTarget(target);
  };

  iframeDocument.addEventListener("focusin", markReady, true);
  iframeDocument.addEventListener("mouseup", markReady, true);
  iframeDocument.addEventListener("keyup", markReady, true);
  iframeListenersBound = true;
}

function dispatchSyntheticInput(target, text = "") {
  const ownerWindow = target?.ownerDocument?.defaultView || window;
  try {
    target?.dispatchEvent(
      new ownerWindow.InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: "insertText",
      })
    );
  } catch (_error) {
    // Ignore browsers that do not allow constructing InputEvent here.
  }

  target?.dispatchEvent(new Event("input", { bubbles: true }));
}

function copyTextToClipboard(text) {
  const normalized = String(text || "");
  if (!normalized.trim()) {
    return Promise.resolve(false);
  }

  return navigator.clipboard
    .writeText(normalized)
    .then(() => true)
    .catch(() => false);
}

function removeTranscriptOverlay() {
  if (transcriptOverlay?.isConnected) {
    transcriptOverlay.remove();
  }
  transcriptOverlay = null;
}

function ensureTranscriptOverlay() {
  if (transcriptOverlay?.isConnected) {
    return transcriptOverlay;
  }

  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.right = "16px";
  overlay.style.bottom = "16px";
  overlay.style.zIndex = "2147483647";
  overlay.style.width = "320px";
  overlay.style.maxWidth = "calc(100vw - 32px)";
  overlay.style.padding = "14px";
  overlay.style.borderRadius = "16px";
  overlay.style.background = "#fffdf8";
  overlay.style.border = "1px solid rgba(24, 20, 13, 0.12)";
  overlay.style.boxShadow = "0 18px 40px rgba(24, 20, 13, 0.18)";
  overlay.style.fontFamily = "Arial, sans-serif";
  overlay.style.color = "#1f1b16";

  const title = document.createElement("div");
  title.textContent = "Recognized text is ready";
  title.style.fontSize = "14px";
  title.style.fontWeight = "700";
  title.style.marginBottom = "8px";

  const body = document.createElement("div");
  body.style.fontSize = "13px";
  body.style.lineHeight = "1.45";
  body.style.whiteSpace = "pre-wrap";
  body.style.maxHeight = "180px";
  body.style.overflowY = "auto";
  body.style.marginBottom = "10px";
  body.dataset.role = "transcript-body";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy text";
  copyBtn.style.flex = "1";
  copyBtn.style.border = "0";
  copyBtn.style.borderRadius = "10px";
  copyBtn.style.background = "#1f1b16";
  copyBtn.style.color = "#fff";
  copyBtn.style.padding = "10px 12px";
  copyBtn.style.cursor = "pointer";
  copyBtn.addEventListener("click", async () => {
    const copied = await copyTextToClipboard(body.textContent || "");
    copyBtn.textContent = copied ? "Copied" : "Copy failed";
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.style.border = "1px solid rgba(24, 20, 13, 0.12)";
  closeBtn.style.borderRadius = "10px";
  closeBtn.style.background = "#fff";
  closeBtn.style.color = "#1f1b16";
  closeBtn.style.padding = "10px 12px";
  closeBtn.style.cursor = "pointer";
  closeBtn.addEventListener("click", () => {
    removeTranscriptOverlay();
  });

  actions.append(copyBtn, closeBtn);
  overlay.append(title, body, actions);
  document.documentElement.appendChild(overlay);
  transcriptOverlay = overlay;
  return overlay;
}

function showTranscriptOverlay(text) {
  const overlay = ensureTranscriptOverlay();
  const body = overlay.querySelector('[data-role="transcript-body"]');
  if (body) {
    body.textContent = text;
  }
}

function focusGoogleDocsSurface() {
  bindIframeListeners();

  if (lastFocusedTarget?.isConnected) {
    if (lastFocusedTarget instanceof HTMLElement) {
      lastFocusedTarget.focus();
    }
    return lastFocusedTarget;
  }

  const iframeBody = getIframeBody();
  if (iframeBody) {
    iframeBody.focus();
    return iframeBody;
  }

  const active = document.activeElement;
  if (active instanceof HTMLElement && isValidInsertionTarget(active)) {
    active.focus();
    return active;
  }

  const editable = document.querySelector('[contenteditable="true"]');
  if (editable instanceof HTMLElement) {
    editable.focus();
    return editable;
  }

  return null;
}

function ensureCollapsedSelection(target) {
  const ownerDocument = target.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;
  const selection =
    restoreSelection(target) || (ownerWindow.getSelection ? ownerWindow.getSelection() : null);
  if (!selection) {
    return null;
  }

  if (selection.rangeCount > 0) {
    return selection;
  }

  const range = ownerDocument.createRange();
  if (target.nodeType === Node.TEXT_NODE) {
    range.setStart(target, target.textContent?.length || 0);
  } else {
    range.selectNodeContents(target);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
  captureSelection(target);
  return selection;
}

function normalizeTranscriptChunk(text) {
  if (!text) {
    return "";
  }

  let normalized = text.replace(/\s+/g, " ").trim();
  ACTIVE_VOICE_COMMANDS.forEach(({ pattern, value }) => {
    normalized = normalized.replace(pattern, value);
  });

  normalized = normalized
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([(\[{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/\s+"/g, ' "')
    .replace(/"\s*([,.;:!?])/g, '"$1')
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ");

  const previous = state.transcript.trim();
  const shouldCapitalize = !previous || /[.!?\n]\s*$/.test(previous);
  if (shouldCapitalize && /^\p{Ll}/u.test(normalized)) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }

  return normalized;
}

function endsWithSpokenPunctuationCommand(rawText) {
  const candidate = String(rawText || "").trim();
  if (!candidate) {
    return false;
  }
  return ACTIVE_VOICE_COMMANDS.some(
    (command) => command.tailPattern && command.tailPattern.test(candidate)
  );
}

function shouldAppendTrailingSpace(text, rawText = "") {
  if (endsWithSpokenPunctuationCommand(rawText)) {
    return true;
  }
  return !/[\s\n,.;:!?"]$/.test(text);
}

function undoLastInsertion() {
  const lastInserted = insertionHistory.pop();
  if (!lastInserted) {
    setStatus("error", "Nothing to undo yet.");
    return false;
  }

  if (typeof document.execCommand === "function") {
    try {
      if (document.execCommand("undo")) {
        state.transcript = state.transcript.replace(
          new RegExp(`${lastInserted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`),
          ""
        ).trimEnd();
        state.insertedChars = Math.max(0, state.insertedChars - lastInserted.length);
        state.interimTranscript = "";
        setStatus(desiredRunning ? "listening" : "idle", "Undid the last dictated text.");
        return true;
      }
    } catch (_error) {
      // Ignore and fall through.
    }
  }

  return false;
}

function insertTextWithSelection(target, text) {
  if (!target || !text || !isValidInsertionTarget(target)) {
    return false;
  }

  const ownerDocument = target.ownerDocument || document;
  const ownerWindow = ownerDocument.defaultView || window;

  if (isTextInputTarget(target)) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    target.focus();
    target.setRangeText(text, start, end, "end");
    dispatchSyntheticInput(target, text);
    return true;
  }

  target.focus();

  if (typeof ownerDocument.execCommand === "function") {
    try {
      if (ownerDocument.execCommand("insertText", false, text)) {
        captureSelection(target);
        dispatchSyntheticInput(target, text);
        return true;
      }
    } catch (_error) {
      // Fall through.
    }
  }

  const selection =
    ensureCollapsedSelection(target) || (ownerWindow.getSelection ? ownerWindow.getSelection() : null);
  if (!selection || !selection.rangeCount) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = ownerDocument.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  captureSelection(node);
  dispatchSyntheticInput(target, text);
  return true;
}

function insertTextIntoDocument(text, rawText = "") {
  if (!text) {
    return false;
  }

  const normalizedTranscript = normalizeTranscriptChunk(text);
  if (!normalizedTranscript) {
    return false;
  }

  const appendTrailingSpace = shouldAppendTrailingSpace(normalizedTranscript, rawText);
  const normalized = appendTrailingSpace ? `${normalizedTranscript} ` : normalizedTranscript;

  const activeElement = document.activeElement;
  if (activeElement && insertTextWithSelection(activeElement, normalized)) {
    rememberFocusedTarget(activeElement);
    return true;
  }

  const docsSurface = focusGoogleDocsSurface();
  if (docsSurface && insertTextWithSelection(docsSurface, normalized)) {
    rememberFocusedTarget(docsSurface);
    return true;
  }

  state.cursorReady = false;
  return false;
}

async function insertTextIntoGoogleDocs(text, rawText = "") {
  if (!text) {
    return false;
  }

  const normalizedTranscript = normalizeTranscriptChunk(text);
  if (!normalizedTranscript) {
    return false;
  }

  const appendTrailingSpace = shouldAppendTrailingSpace(normalizedTranscript, rawText);
  const normalized = appendTrailingSpace ? `${normalizedTranscript} ` : normalizedTranscript;

  try {
    const response = await sendRuntimeMessage({
      type: "nativeTypeText",
      text: normalized,
    });
    if (response?.inserted) {
      return true;
    }
  } catch (_error) {
    // Fall back to in-page insertion.
  }

  return insertTextIntoDocument(normalizedTranscript, rawText);
}

async function handleRecognizedText(text) {
  const normalizedTranscript = normalizeTranscriptChunk(text);
  if (!normalizedTranscript) {
    return;
  }

  if (COMMAND_PATTERNS.undo.test(normalizedTranscript) || COMMAND_PATTERNS.deleteLastSentence.test(normalizedTranscript)) {
    undoLastInsertion();
    return;
  }

  const inserted = await insertTextIntoGoogleDocs(normalizedTranscript, text);
  if (!inserted) {
    state.transcript = `${state.transcript} ${normalizedTranscript}`.trim();
    state.insertedChars += normalizedTranscript.length;
    state.interimTranscript = "";
    showTranscriptOverlay(state.transcript);
    setStatus(
      desiredRunning ? "listening" : "idle",
      "Recognized text is available, but Google Docs did not accept automatic insertion."
    );
    return;
  }

  removeTranscriptOverlay();
  state.transcript = `${state.transcript} ${normalizedTranscript}`.trim();
  state.insertedChars += normalizedTranscript.length;
  state.interimTranscript = "";
  insertionHistory.push(normalizedTranscript);
  setStatus(
    desiredRunning ? "listening" : "idle",
    desiredRunning
      ? "Listening with Google speech recognition..."
      : "Dictation stopped."
  );
}

function queueRecognizedText(text) {
  insertionQueue = insertionQueue
    .then(() => handleRecognizedText(text))
    .catch((error) => {
      setStatus("error", error.message || "Unable to insert recognized text.");
    });
  return insertionQueue;
}

function flushPendingInterimText() {
  const pending = normalizeTranscriptChunk(pendingInterimText || state.interimTranscript || "");
  pendingInterimText = "";
  state.interimTranscript = "";
  sendStateUpdate();
  if (!pending) {
    return Promise.resolve();
  }
  return queueRecognizedText(pending);
}

function clearRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function stopRecognitionInternally(message = "Dictation stopped.") {
  desiredRunning = false;
  manualStopMessage = message;
  terminalEndState = null;
  clearRestartTimer();
  if (recognition) {
    try {
      recognition.stop();
    } catch (_error) {
      // Ignore invalid state.
    }
  } else {
    stopSessionTimer();
    setStatus("idle", manualStopMessage);
  }
}

function createRecognition() {
  if (!SpeechRecognitionCtor) {
    return null;
  }

  const next = new SpeechRecognitionCtor();
  next.continuous = true;
  next.interimResults = true;
  next.lang = navigator.language || "en-US";

  next.onstart = () => {
    setStatus("listening", "Listening with Google speech recognition...");
  };

  next.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript || "";
      if (!transcript.trim()) {
        continue;
      }

      if (result.isFinal) {
        pendingInterimText = "";
        void queueRecognizedText(transcript);
      } else {
        interim += ` ${transcript}`;
      }
    }

    state.interimTranscript = interim.trim();
    pendingInterimText = state.interimTranscript;
    sendStateUpdate();
  };

  next.onerror = (event) => {
    const code = String(event?.error || "");
    if (code === "no-speech") {
      pendingInterimText = "";
      state.interimTranscript = "";
      sendStateUpdate();
      return;
    }

    if (code === "not-allowed" || code === "service-not-allowed") {
      desiredRunning = false;
      stopSessionTimer();
      terminalEndState = {
        status: "error",
        message: "Microphone access was blocked. Allow microphone access and try again.",
      };
      setStatus(terminalEndState.status, terminalEndState.message);
      return;
    }

    if (code === "audio-capture") {
      desiredRunning = false;
      stopSessionTimer();
      terminalEndState = {
        status: "error",
        message: "No microphone was found. Check your input device and try again.",
      };
      setStatus(terminalEndState.status, terminalEndState.message);
      return;
    }

    if (code === "network") {
      desiredRunning = false;
      stopSessionTimer();
      terminalEndState = {
        status: "error",
        message: "Speech recognition lost its network connection. Try again.",
      };
      setStatus(terminalEndState.status, terminalEndState.message);
      return;
    }

    desiredRunning = false;
    stopSessionTimer();
    terminalEndState = {
      status: "error",
      message: "Speech recognition stopped unexpectedly.",
    };
    setStatus(terminalEndState.status, terminalEndState.message);
  };

  next.onend = () => {
    if (desiredRunning) {
      pendingInterimText = "";
      state.interimTranscript = "";
      sendStateUpdate();
      clearRestartTimer();
      restartTimer = setTimeout(() => {
        try {
          next.start();
        } catch (_error) {
          desiredRunning = false;
          stopSessionTimer();
          setStatus("error", "Unable to restart speech recognition. Try again.");
        }
      }, 250);
      return;
    }

    void flushPendingInterimText()
      .catch(() => null)
      .finally(() => {
        stopSessionTimer();
        if (terminalEndState) {
          const finalState = terminalEndState;
          terminalEndState = null;
          setStatus(finalState.status, finalState.message);
          return;
        }
        setStatus("idle", manualStopMessage);
      });
  };

  return next;
}

async function startDictation() {
  if (!HAS_RECOGNITION_SUPPORT) {
    throw new Error("This browser does not support speech recognition.");
  }
  if (!state.isDocsPage) {
    throw new Error("Open a Google Docs document first.");
  }
  if (desiredRunning || state.status === "starting" || state.status === "listening") {
    return {
      started: true,
      alreadyRunning: true,
      state,
    };
  }

  const target = focusGoogleDocsSurface();
  if (!target) {
    state.cursorReady = false;
    sendStateUpdate();
    throw new Error("Click inside Google Docs first so the text cursor is ready.");
  }

  rememberFocusedTarget(target);
  removeTranscriptOverlay();
  pendingInterimText = "";
  state.interimTranscript = "";
  clearRestartTimer();

  if (!recognition) {
    recognition = createRecognition();
  }
  if (!recognition) {
    throw new Error("Speech recognition is unavailable in this browser.");
  }

  desiredRunning = true;
  manualStopMessage = "Dictation stopped.";
  startSessionTimer();
  setStatus("starting", "Starting Google speech recognition...");

  try {
    recognition.start();
  } catch (error) {
    desiredRunning = false;
    stopSessionTimer();
    if ((error?.message || "").toLowerCase().includes("already started")) {
      setStatus("listening", "Listening with Google speech recognition...");
      return {
        started: true,
        alreadyRunning: true,
        state,
      };
    }
    throw error;
  }

  return {
    started: true,
    alreadyRunning: false,
    state,
  };
}

async function stopDictation() {
  if (!desiredRunning && state.status !== "listening" && state.status !== "starting") {
    return { state };
  }

  manualStopMessage = "Dictation stopped.";
  pendingInterimText = state.interimTranscript || "";
  stopRecognitionInternally(manualStopMessage);
  await insertionQueue.catch(() => null);
  return { state };
}

document.addEventListener(
  "focusin",
  (event) => {
    rememberFocusedTarget(event.target);
  },
  true
);

document.addEventListener(
  "mouseup",
  (event) => {
    rememberFocusedTarget(event.target);
  },
  true
);

document.addEventListener(
  "keyup",
  (event) => {
    rememberFocusedTarget(event.target);
  },
  true
);

window.addEventListener("beforeunload", () => {
  stopRecognitionInternally("Dictation stopped.");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "getDictationState") {
    sendResponse({
      ok: true,
      state: {
        ...state,
        docTitle: document.title.replace(/\s*-\s*Google Docs\s*$/, ""),
      },
    });
    return false;
  }

  if (message.type === "startDictation") {
    startDictation()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to start dictation." }));
    return true;
  }

  if (message.type === "stopDictation") {
    stopDictation()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "Failed to stop dictation." }));
    return true;
  }

  return false;
});

sendStateUpdate();
