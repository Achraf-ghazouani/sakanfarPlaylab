// shared/i18n.js — the interface in English, French and Arabic (window.I18N). The language comes from localStorage
// (playlab.lang), else the browser; Arabic turns the page right-to-left. Static text carries data-i18n="key" (innerHTML),
// data-i18n-attr="placeholder|title|data-prompt" for attributes; pages call I18N.t(key, vars) for the rest.
// The plans and replies follow the language the person writes in (lib/code.mjs); this file is the chrome around them.
(function (root) {
  const LANGS = ["en", "fr", "ar"];
  const NAMES = { en: "English", fr: "Français", ar: "العربية" };
  const DICT = {
    en: {
      "studio.newGame": "&#10010; New game", "studio.myGames": "My games",
      "studio.sideFoot": 'Games are saved as you chat. <a href="index.html">Home</a> &middot; <a href="explore.html">Explore</a>',
      "studio.undo": "Undo", "studio.history": "History", "studio.noVersions": "No versions yet", "studio.phone": "Play with phone", "studio.publish": "Publish",
      "studio.profile": "Profile and credits", "studio.admin": "Admin panel", "studio.logout": "Log out", "studio.language": "Language",
      "studio.chat": "Chat", "studio.chatSub": "ask for changes, or redraw",
      "studio.placeholder": "Describe your game, or paste / drop a drawing...", "studio.placeholderChange": "Ask for a change...",
      "chip.harder": "Make it harder", "chip.coins": "Add more coins", "chip.theme": "Change theme", "chip.playtest": "Playtest it",
      "welcome.title": "What are we building today?", "welcome.sub": "Describe a game in the box below, or start from a drawing. It appears right here.",
      "start.sketch": "Sketch it", "start.sketchSub": "Draw a level here", "start.upload": "Upload a drawing", "start.uploadSub": "A photo of your paper",
      "start.camera": "Use the camera", "start.cameraSub": "Point your phone at it", "start.player": "Add your character", "start.playerSub": "A picture becomes the player",
      "ex.lava": "&#127969; A lava castle with moving platforms", "ex.lavaPrompt": "A lava castle with moving platforms",
      "ex.space": "&#128640; A space level with floating platforms", "ex.spacePrompt": "A space level with floating platforms and lots of coins",
      "ex.jungle": "&#127796; A jungle level for kids, easy", "ex.junglePrompt": "A jungle level for kids, easy",
      "ex.fps": "&#129503; First-person shooter, zombie waves", "ex.fpsPrompt": "A first-person shooter with 5 waves of zombies",
      "ex.race": "&#127950; A car race with 3 laps and 4 AI cars", "ex.racePrompt": "A car race with 3 laps and 4 AI cars",
      "welcome.continue": "Continue", "building.title": "Building your game...", "building.sub": "Muse Spark is placing platforms, coins and enemies", "preview.none": "no game yet",
      "pub.title": "&#128640; Publish your game", "pub.close": "Close", "pub.name": "Title", "pub.desc": "Description (optional)", "pub.cover": "Cover picture", "pub.who": "Who can see it",
      "pub.public": "Public: in Explore, for everyone", "pub.unlisted": "Unlisted: only people with the link", "pub.go": "Publish", "pub.unpublish": "Unpublish",
      "review.title": "&#128194; Review your files", "review.cancel": "Cancel", "review.apply": "Apply all",
      "credits.title": "Not enough credits", "credits.left": "credits left", "credits.more": "Get more credits", "credits.ok": "OK",
      "detected": "Detected", "gameIs": "Game is {d}.",
      "send.line": "Send · {n} {credits} ({what}) · you have {balance}", "send.newGame": "new game", "send.changeGame": "change the game", "send.new3d": "new 3D game", "send.change3d": "change the 3D game",
      "credit.one": "credit", "credit.many": "credits",
      "code.toggle": "AI code", "code.toggleTitle": "Custom game: the AI writes any kind of game as code (racing, puzzle, sports...)", "code.planTitle": "Game plan",
      "code.planReply": "Here is the plan for {title}. Say go to build it ({n} {credits}), or tell me what to change: the plan is free.", "chip.go": "Go, build it", "chip.simpler": "Make it simpler",
      "send.go": "Send · go = build it for {n} {credits}; anything else changes the plan (free)", "send.planFree": "Send · a free plan first, then {n} {credits} to build it (the AI writes the code)", "send.changeCode": "change the game: the AI rewrites its code",
      "pad.restart": "&#8635; Restart", "pad.pause": "❚❚ Pause", "pad.resume": "▶ Resume", "pad.sound": "🔊 Sound", "pad.muted": "🔇 Muted", "pad.noLevel": "no level yet",
      "preview.emptyTitle": "Your game appears here", "preview.emptySub": "Describe it, sketch it (2D) or send a picture: Muse Wonder writes it as code.", "sketch.title": "Sketch a 2D game", "sketch.hint": "Draw your 2D game like on paper: the ground, platforms, a track or a maze, the hero, enemies, coins, the goal. Muse Spark reads it into a free plan, then Muse Wonder writes the game.", "sketch.use": "Use drawing", "sketch.free": "free plan", "sketch.only2d": "Sketching works for 2D games: switch to 2D to draw one.",
      "pad.tapHere": "Tap here: the game sees where", "code.restart": "Restart", "code.pause": "Pause", "code.resume": "Resume", "code.sound": "Sound", "code.muted": "Muted",
      "pad.room": "Room", "pad.keepOpen": "Keep the game open on the computer.", "pad.jump": "JUMP", "pad.move": "MOVE", "pad.aim": "AIM", "pad.fire": "FIRE", "pad.rotate": "Rotate your phone",
      "nav.how": "How it works", "nav.explore": "Explore", "nav.play": "Play", "nav.waitlist": "Waitlist", "nav.login": "Log in",
      "hero.tag": "Describe any game, or sketch it. AI writes it as code. Play it in minutes.", "hero.start": "START CREATING", "hero.demo": "PLAY A DEMO",
      "hero.beta": 'Private beta. No invite yet? <a href="#waitlist">Join the waitlist</a>',
      "manifesto.title": "IF YOU CAN SAY IT,<br>YOU CAN PLAY IT.",
      "manifesto.lead": "Introducing Sakanfar PlayLab, an experimental game lab where a chat, a pen and a phone are the game engine. Racing, puzzles, platformers, shooters, sports: say it or sketch it, and Meta's Muse Wonder writes the whole game as code. No coding, no templates.",
    },
    fr: {
      "studio.newGame": "&#10010; Nouveau jeu", "studio.myGames": "Mes jeux",
      "studio.sideFoot": 'Les jeux sont enregistrés au fil du chat. <a href="index.html">Accueil</a> &middot; <a href="explore.html">Explorer</a>',
      "studio.undo": "Annuler", "studio.history": "Historique", "studio.noVersions": "Pas encore de version", "studio.phone": "Jouer au téléphone", "studio.publish": "Publier",
      "studio.profile": "Profil et crédits", "studio.admin": "Panneau admin", "studio.logout": "Se déconnecter", "studio.language": "Langue",
      "studio.chat": "Chat", "studio.chatSub": "demandez des changements, ou redessinez",
      "studio.placeholder": "Décrivez votre jeu, ou collez / déposez un dessin...", "studio.placeholderChange": "Demandez un changement...",
      "chip.harder": "Plus difficile", "chip.coins": "Plus de pièces", "chip.theme": "Changer le thème", "chip.playtest": "Tester le niveau",
      "welcome.title": "Qu'est-ce qu'on construit aujourd'hui ?", "welcome.sub": "Décrivez un jeu dans la boîte ci-dessous, ou partez d'un dessin. Il apparaît ici même.",
      "start.sketch": "Dessiner", "start.sketchSub": "Un niveau, ici", "start.upload": "Envoyer un dessin", "start.uploadSub": "Une photo de votre feuille",
      "start.camera": "Utiliser la caméra", "start.cameraSub": "Visez la feuille avec le téléphone", "start.player": "Ajouter votre personnage", "start.playerSub": "Une image devient le joueur",
      "ex.lava": "&#127969; Un château de lave avec des plateformes mobiles", "ex.lavaPrompt": "Un château de lave avec des plateformes mobiles",
      "ex.space": "&#128640; Un niveau spatial avec des plateformes flottantes", "ex.spacePrompt": "Un niveau spatial avec des plateformes flottantes et plein de pièces",
      "ex.jungle": "&#127796; Un niveau jungle pour enfants, facile", "ex.junglePrompt": "Un niveau jungle pour enfants, facile",
      "ex.fps": "&#129503; Shooter à la première personne, vagues de zombies", "ex.fpsPrompt": "Un shooter à la première personne avec 5 vagues de zombies",
      "ex.race": "&#127950; Une course de voitures, 3 tours et 4 voitures IA", "ex.racePrompt": "Une course de voitures avec 3 tours et 4 voitures contrôlées par l'IA",
      "welcome.continue": "Continuer", "building.title": "Construction de votre jeu...", "building.sub": "Muse Spark place les plateformes, les pièces et les ennemis", "preview.none": "pas encore de jeu",
      "pub.title": "&#128640; Publier votre jeu", "pub.close": "Fermer", "pub.name": "Titre", "pub.desc": "Description (facultatif)", "pub.cover": "Image de couverture", "pub.who": "Qui peut le voir",
      "pub.public": "Public : dans Explorer, pour tous", "pub.unlisted": "Non répertorié : seulement avec le lien", "pub.go": "Publier", "pub.unpublish": "Dépublier",
      "review.title": "&#128194; Vérifiez vos fichiers", "review.cancel": "Annuler", "review.apply": "Tout appliquer",
      "credits.title": "Pas assez de crédits", "credits.left": "crédits restants", "credits.more": "Obtenir des crédits", "credits.ok": "OK",
      "detected": "Détecté", "gameIs": "Le jeu est en {d}.",
      "send.line": "Envoyer · {n} {credits} ({what}) · il vous reste {balance}", "send.newGame": "nouveau jeu", "send.changeGame": "modifier le jeu", "send.new3d": "nouveau jeu 3D", "send.change3d": "modifier le jeu 3D",
      "credit.one": "crédit", "credit.many": "crédits",
      "code.toggle": "Code IA", "code.toggleTitle": "Jeu sur mesure : l'IA écrit n'importe quel jeu en code (course, puzzle, sport...)", "code.planTitle": "Plan du jeu",
      "code.planReply": "Voici le plan de {title}. Dites go pour le construire ({n} {credits}), ou dites-moi quoi changer : le plan est gratuit.", "chip.go": "Go, construis-le", "chip.simpler": "Plus simple",
      "send.go": "Envoyer · go = construire pour {n} {credits} ; tout autre texte change le plan (gratuit)", "send.planFree": "Envoyer · un plan gratuit d'abord, puis {n} {credits} pour le construire (l'IA écrit le code)", "send.changeCode": "modifier le jeu : l'IA réécrit son code",
      "pad.restart": "&#8635; Recommencer", "pad.pause": "❚❚ Pause", "pad.resume": "▶ Reprendre", "pad.sound": "🔊 Son", "pad.muted": "🔇 Coupé", "pad.noLevel": "pas encore de niveau",
      "preview.emptyTitle": "Votre jeu apparaît ici", "preview.emptySub": "Décrivez-le, dessinez-le (2D) ou envoyez une image : Muse Wonder l'écrit en code.", "sketch.title": "Dessiner un jeu 2D", "sketch.hint": "Dessinez votre jeu 2D comme sur papier : le sol, des plateformes, un circuit ou un labyrinthe, le héros, les ennemis, les pièces, l'arrivée. Muse Spark en fait un plan gratuit, puis Muse Wonder écrit le jeu.", "sketch.use": "Utiliser le dessin", "sketch.free": "plan gratuit", "sketch.only2d": "Le dessin fonctionne pour les jeux 2D : passez en 2D pour dessiner.",
      "pad.tapHere": "Touchez ici : le jeu voit où", "code.restart": "Recommencer", "code.pause": "Pause", "code.resume": "Reprendre", "code.sound": "Son", "code.muted": "Muet",
      "pad.room": "Salle", "pad.keepOpen": "Gardez le jeu ouvert sur l'ordinateur.", "pad.jump": "SAUT", "pad.move": "BOUGER", "pad.aim": "VISER", "pad.fire": "TIRER", "pad.rotate": "Tournez votre téléphone",
      "nav.how": "Comment ça marche", "nav.explore": "Explorer", "nav.play": "Jouer", "nav.waitlist": "Liste d'attente", "nav.login": "Connexion",
      "hero.tag": "Décrivez n'importe quel jeu, ou dessinez-le. L'IA l'écrit en code. Jouez-y en quelques minutes.", "hero.start": "COMMENCER À CRÉER", "hero.demo": "JOUER UNE DÉMO",
      "hero.beta": 'Bêta privée. Pas encore d\'invitation ? <a href="#waitlist">Rejoignez la liste d\'attente</a>',
      "manifesto.title": "SI VOUS POUVEZ LE DIRE,<br>VOUS POUVEZ Y JOUER.",
      "manifesto.lead": "Voici Sakanfar PlayLab, un laboratoire de jeu expérimental où un chat, un stylo et un téléphone sont le moteur de jeu. Course, puzzle, plateforme, tir, sport : dites-le ou dessinez-le, et Muse Wonder de Meta écrit tout le jeu en code. Pas de code à écrire, pas de modèles.",
    },
    ar: {
      "studio.newGame": "&#10010; لعبة جديدة", "studio.myGames": "ألعابي",
      "studio.sideFoot": 'تُحفظ الألعاب أثناء الدردشة. <a href="index.html">الرئيسية</a> &middot; <a href="explore.html">استكشف</a>',
      "studio.undo": "تراجع", "studio.history": "السجل", "studio.noVersions": "لا توجد نسخ بعد", "studio.phone": "العب بالهاتف", "studio.publish": "انشر",
      "studio.profile": "الملف الشخصي والرصيد", "studio.admin": "لوحة الإدارة", "studio.logout": "تسجيل الخروج", "studio.language": "اللغة",
      "studio.chat": "الدردشة", "studio.chatSub": "اطلب تغييرات، أو أعد الرسم",
      "studio.placeholder": "صِف لعبتك، أو الصق / أسقط رسمة...", "studio.placeholderChange": "اطلب تغييرًا...",
      "chip.harder": "اجعلها أصعب", "chip.coins": "المزيد من العملات", "chip.theme": "غيّر الموضوع", "chip.playtest": "اختبر المستوى",
      "welcome.title": "ماذا نبني اليوم؟", "welcome.sub": "صِف لعبة في المربع أدناه، أو ابدأ من رسمة. ستظهر هنا مباشرة.",
      "start.sketch": "ارسمها", "start.sketchSub": "ارسم مستوى هنا", "start.upload": "ارفع رسمة", "start.uploadSub": "صورة لورقتك",
      "start.camera": "استخدم الكاميرا", "start.cameraSub": "وجّه هاتفك نحو الورقة", "start.player": "أضف شخصيتك", "start.playerSub": "صورة تصبح اللاعب",
      "ex.lava": "&#127969; قلعة من الحمم بمنصات متحركة", "ex.lavaPrompt": "قلعة من الحمم بمنصات متحركة",
      "ex.space": "&#128640; مستوى فضائي بمنصات عائمة", "ex.spacePrompt": "مستوى فضائي بمنصات عائمة والكثير من العملات",
      "ex.jungle": "&#127796; مستوى في الغابة للأطفال، سهل", "ex.junglePrompt": "مستوى في الغابة للأطفال، سهل",
      "ex.fps": "&#129503; لعبة إطلاق نار بمنظور الشخص الأول، موجات زومبي", "ex.fpsPrompt": "لعبة إطلاق نار بمنظور الشخص الأول مع 5 موجات من الزومبي",
      "ex.race": "&#127950; سباق سيارات، 3 لفات و4 سيارات يقودها الذكاء الاصطناعي", "ex.racePrompt": "سباق سيارات مع 3 لفات و4 سيارات يقودها الذكاء الاصطناعي",
      "welcome.continue": "متابعة", "building.title": "جارٍ بناء لعبتك...", "building.sub": "Muse Spark يضع المنصات والعملات والأعداء", "preview.none": "لا توجد لعبة بعد",
      "pub.title": "&#128640; انشر لعبتك", "pub.close": "إغلاق", "pub.name": "العنوان", "pub.desc": "الوصف (اختياري)", "pub.cover": "صورة الغلاف", "pub.who": "من يمكنه رؤيتها",
      "pub.public": "عامة: في استكشف، للجميع", "pub.unlisted": "غير مدرجة: فقط لمن لديه الرابط", "pub.go": "انشر", "pub.unpublish": "إلغاء النشر",
      "review.title": "&#128194; راجع ملفاتك", "review.cancel": "إلغاء", "review.apply": "تطبيق الكل",
      "credits.title": "الرصيد غير كافٍ", "credits.left": "رصيد متبقٍ", "credits.more": "احصل على رصيد", "credits.ok": "حسنًا",
      "detected": "تم التعرف", "gameIs": "اللعبة {d}.",
      "send.line": "إرسال · {n} {credits} ({what}) · لديك {balance}", "send.newGame": "لعبة جديدة", "send.changeGame": "تعديل اللعبة", "send.new3d": "لعبة ثلاثية الأبعاد جديدة", "send.change3d": "تعديل اللعبة ثلاثية الأبعاد",
      "credit.one": "رصيد", "credit.many": "رصيد",
      "code.toggle": "كود الذكاء", "code.toggleTitle": "لعبة مخصصة: يكتب الذكاء الاصطناعي أي نوع من الألعاب كشيفرة (سباق، ألغاز، رياضة...)", "code.planTitle": "خطة اللعبة",
      "code.planReply": "هذه خطة {title}. قل go لبنائها ({n} {credits})، أو أخبرني بما تريد تغييره: الخطة مجانية.", "chip.go": "هيا، ابنِها", "chip.simpler": "اجعلها أبسط",
      "send.go": "إرسال · go = البناء مقابل {n} {credits}؛ أي نص آخر يغيّر الخطة (مجانًا)", "send.planFree": "إرسال · خطة مجانية أولًا، ثم {n} {credits} لبنائها (يكتب الذكاء الاصطناعي الشيفرة)", "send.changeCode": "تعديل اللعبة: يعيد الذكاء الاصطناعي كتابة شيفرتها",
      "pad.restart": "&#8635; إعادة", "pad.pause": "❚❚ إيقاف مؤقت", "pad.resume": "▶ استئناف", "pad.sound": "🔊 الصوت", "pad.muted": "🔇 صامت", "pad.noLevel": "لا يوجد مستوى بعد",
      "preview.emptyTitle": "ستظهر لعبتك هنا", "preview.emptySub": "صِفها أو ارسمها (ثنائية الأبعاد) أو أرسل صورة: يكتبها Muse Wonder كشيفرة.", "sketch.title": "ارسم لعبة ثنائية الأبعاد", "sketch.hint": "ارسم لعبتك ثنائية الأبعاد كما على الورق: الأرض، المنصات، مسار أو متاهة، البطل، الأعداء، العملات، الهدف. يحولها Muse Spark إلى خطة مجانية، ثم يكتب Muse Wonder اللعبة.", "sketch.use": "استخدم الرسم", "sketch.free": "خطة مجانية", "sketch.only2d": "الرسم يعمل مع الألعاب ثنائية الأبعاد: انتقل إلى 2D للرسم.",
      "pad.tapHere": "المس هنا: اللعبة ترى المكان", "code.restart": "إعادة", "code.pause": "إيقاف مؤقت", "code.resume": "استئناف", "code.sound": "الصوت", "code.muted": "صامت",
      "pad.room": "الغرفة", "pad.keepOpen": "أبقِ اللعبة مفتوحة على الحاسوب.", "pad.jump": "اقفز", "pad.move": "تحرك", "pad.aim": "صوّب", "pad.fire": "أطلق", "pad.rotate": "أدر هاتفك",
      "nav.how": "كيف يعمل", "nav.explore": "استكشف", "nav.play": "العب", "nav.waitlist": "قائمة الانتظار", "nav.login": "تسجيل الدخول",
      "hero.tag": "صِف أي لعبة، أو ارسمها. يكتبها الذكاء الاصطناعي كشيفرة. العبها خلال دقائق.", "hero.start": "ابدأ الإبداع", "hero.demo": "جرّب عرضًا",
      "hero.beta": 'نسخة تجريبية خاصة. لا دعوة بعد؟ <a href="#waitlist">انضم إلى قائمة الانتظار</a>',
      "manifesto.title": "إن استطعت قولها،<br>استطعت لعبها.",
      "manifesto.lead": "نقدّم Sakanfar PlayLab، مختبر ألعاب تجريبي حيث الدردشة والقلم والهاتف هي محرك اللعبة. سباق، ألغاز، منصات، تصويب، رياضة: قلها أو ارسمها، ويكتب Muse Wonder من Meta اللعبة كاملة كشيفرة. لا برمجة، ولا قوالب.",
    },
  };
  let lang = detect();
  function detect() {
    try { const s = localStorage.getItem("playlab.lang"); if (LANGS.includes(s)) return s; } catch {}
    const n = String((typeof navigator !== "undefined" && (navigator.language || (navigator.languages || [])[0])) || "en").toLowerCase();
    return n.startsWith("fr") ? "fr" : n.startsWith("ar") ? "ar" : "en";
  }
  /** A translated string; {vars} are filled in; a missing key falls back to English, then to the key itself. */
  function t(key, vars) {
    let s = (DICT[lang] && DICT[lang][key]) ?? DICT.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split("{" + k + "}").join(String(v));
    return s;
  }
  const ATTRS = ["placeholder", "title", "aria-label", "data-prompt"];
  /** Translates every data-i18n element under root and sets the page's language and direction. */
  function apply(scope) {
    const doc = typeof document !== "undefined" ? document : null;
    if (!doc) return;
    const r = scope || doc;
    r.querySelectorAll("[data-i18n]").forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
    for (const a of ATTRS) r.querySelectorAll(`[data-i18n-${a}]`).forEach((el) => { el.setAttribute(a, t(el.getAttribute(`data-i18n-${a}`))); });
    doc.documentElement.lang = lang;
    doc.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    doc.body?.classList.toggle("rtl", lang === "ar");
    r.querySelectorAll("[data-lang]").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
  }
  function set(l) {
    if (!LANGS.includes(l) || l === lang) return;
    lang = l;
    try { localStorage.setItem("playlab.lang", l); } catch {}
    apply();
    if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("playlab:lang", { detail: l }));
  }
  const api = { t, apply, set, get lang() { return lang; }, LANGS, NAMES, DICT };
  root.I18N = api;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply());
    else apply();
    document.addEventListener("click", (e) => { const b = e.target.closest?.("[data-lang]"); if (b) { e.preventDefault(); set(b.dataset.lang); } });
  }
})(typeof window !== "undefined" ? window : globalThis);
