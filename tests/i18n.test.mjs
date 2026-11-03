// Unit checks for shared/i18n.js (no browser): every key exists in every language with the same placeholders, lookups fall
// back to English, variables fill in, the switch takes only known languages.
import fs from "node:fs";
import vm from "node:vm";

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 240) : ""}`); if (!cond) fails++; }

// the script in a bare sandbox: no window, no document, a French browser
const sandbox = { navigator: { language: "fr-FR" }, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("shared/i18n.js", "utf8"), sandbox);
const I18N = sandbox.I18N;
check("the script defines I18N on the global of the sandbox", !!I18N && typeof I18N.t === "function" && Array.isArray(I18N.LANGS));
check("a French browser starts in French", I18N.lang === "fr");

const en = Object.keys(I18N.DICT.en);
for (const l of ["fr", "ar"]) {
  const missing = en.filter((k) => !(k in I18N.DICT[l])), extra = Object.keys(I18N.DICT[l]).filter((k) => !(k in I18N.DICT.en));
  check(`${l}: every English key is translated, nothing extra`, missing.length === 0 && extra.length === 0, { missing, extra });
  const empty = en.filter((k) => !String(I18N.DICT[l][k]).trim());
  check(`${l}: no empty strings`, empty.length === 0, empty);
  const vars = (s) => (String(s).match(/\{[a-z]+\}/g) || []).sort().join();
  const badVars = en.filter((k) => vars(I18N.DICT.en[k]) !== vars(I18N.DICT[l][k]));
  check(`${l}: the same {placeholders} as English`, badVars.length === 0, badVars);
}
check("the dictionary covers the Studio, the pad and the landing page", en.length >= 90 && en.some((k) => k.startsWith("pad.")) && en.some((k) => k.startsWith("nav.")) && en.some((k) => k.startsWith("welcome.")), en.length);

check("t() reads the current language", I18N.t("studio.undo") === "Annuler" && I18N.t("chip.harder") === "Plus difficile");
check("variables fill in", I18N.t("send.line", { n: 2, credits: I18N.t("credit.many"), what: I18N.t("send.newGame"), balance: 30 }) === "Envoyer · 2 crédits (nouveau jeu) · il vous reste 30");
check("an unknown key comes back as itself", I18N.t("no.such.key") === "no.such.key");
I18N.set("ar");
check("Arabic: switched, the pad's JUMP is Arabic", I18N.lang === "ar" && I18N.t("pad.jump") === "اقفز");
I18N.set("xx");
check("an unknown language is ignored", I18N.lang === "ar");
I18N.set("en");
check("back to English", I18N.lang === "en" && I18N.t("welcome.title") === "What are we building today?");
check("names for the switch", I18N.NAMES.fr === "Français" && I18N.NAMES.ar === "العربية");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
