// Unit checks for lib/image.mjs (no network): reading Muse Spark's classification, and the Muse Image sprite prompt.
import { parseClassification, spritePrompt } from "../lib/image.mjs";

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`); if (!cond) fails++; }

const c1 = parseClassification('{"kind":"character","role":null,"name":"Elf Alchemist Mascot","confidence":0.85}');
check("a character", c1.kind === "character" && c1.role === null && c1.name === "Elf Alchemist Mascot" && c1.confidence === 0.85, c1);
const c2 = parseClassification('Sure! ```json\n{"kind":"object","role":"enemy","name":"red blob","confidence":0.7}\n```');
check("JSON inside prose and a code fence", c2.kind === "object" && c2.role === "enemy" && c2.name === "red blob", c2);
const c3 = parseClassification('{"kind":"object","role":"laser","name":"thing"}');
check("an unknown role becomes decoration", c3.kind === "object" && c3.role === "decoration", c3);
const c4 = parseClassification("I am not sure what this is.");
check("no JSON: treat it as a level (the scanner decides)", c4.kind === "level" && c4.role === null, c4);
const c5 = parseClassification('{"kind":"character","role":"enemy","name":"<script>x</script>","confidence":7}');
check("a character never has a role, names are cleaned, confidence is capped", c5.role === null && !/[<>]/.test(c5.name) && c5.confidence === 1, c5);

const p1 = spritePrompt({ kind: "character", name: "purple elf" });
check("character prompt: hero, full body, facing right, flat white background", /playable hero/.test(p1) && /full body/.test(p1) && /facing right/.test(p1) && /pure white background/.test(p1) && /purple elf/.test(p1));
const p2 = spritePrompt({ kind: "object", role: "coin", name: "golden apple", wish: "make it shiny" });
check("object prompt: the role, the name and the wish", /collectible coin/.test(p2) && /golden apple/.test(p2) && /make it shiny/.test(p2) && /no shadow/.test(p2));

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
