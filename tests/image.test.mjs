// Checks for lib/image.mjs and lib/segment.mjs: reading Muse Spark's classification, the Muse Image sprite prompt, SAM 3.1's
// output grammar and prompts (no network), then one live SAM 3.1 call on the logo when MODEL_API_KEY is set (.env).
import fs from "node:fs";
import { parseClassification, spritePrompt } from "../lib/image.mjs";
import { parseSegmentation, pickSubject, pointPrompt, conceptPhrase, findSubject } from "../lib/segment.mjs";
try { process.loadEnvFile(".env"); } catch {}

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 240) : ""}`); if (!cond) fails++; }

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

// ---- SAM 3.1 output grammar (dev.meta.ai/docs/sam/reading-segmentation) ----
const LINE = "<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~ab!c~d|>,1<|box;x1=260;y1=382;x2=340;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,81,!xyz|>,2<|box;x1=516;y1=117;x2=536;y2=150;w=537;h=561|><|mask;x=0;y=0;data=34,21,~qq|>";
const recs = parseSegmentation(LINE);
check("three records: ids, boxes in source pixels, mask height x width", recs.length === 3 && recs.map((r) => r.id).join() === "0,1,2" && recs[0].box.x1 === 353 && recs[0].box.w === 537 && recs[0].mask.height === 46 && recs[0].mask.width === 101, recs.map((r) => [r.id, r.box, r.mask.height, r.mask.width]));
check("the encoding marker is read from the payload's first character, and kept on the payload (! and ~ may appear inside)", recs[0].mask.encoding === "lossless" && recs[0].mask.payload === "~ab!c~d" && recs[1].mask.encoding === "one_bit" && recs[1].mask.payload === "!xyz");
const conf = parseSegmentation("<0f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200;c=0.9609375|><|mask;x=0;y=0;c=0.9609375;data=226,236,!AAA|>");
check("confidence fields do not break the record and are kept on the box", conf.length === 1 && conf[0].box.c === 0.9609375 && conf[0].mask.payload === "!AAA", conf[0]);
check("an empty answer (zero matches) gives no records", parseSegmentation("").length === 0 && parseSegmentation("<0f>").length === 0);
check("a box outside its frame is dropped", parseSegmentation("<0f>0<|box;x1=10;y1=10;x2=600;y2=20;w=537;h=561|><|mask;x=0;y=0;data=4,4,!AA|>").length === 0);
const best = pickSubject(recs);
check("the subject is the biggest box (the small one in the corner loses)", best.id === 0, best && best.id);
const centered = pickSubject(parseSegmentation("<0f>0<|box;x1=0;y1=0;x2=99;y2=99;w=400;h=400|><|mask;x=0;y=0;data=4,4,!AA|>,1<|box;x1=150;y1=150;x2=249;y2=249;w=400;h=400|><|mask;x=0;y=0;data=4,4,!AA|>"));
check("same size: the one in the middle wins", centered.id === 1);
check("no records: no subject", pickSubject([]) === null);
check("point prompt: the middle, in SAM's token grammar", pointPrompt(640, 480) === "<0f>1<|point;x=320;y=240;w=640;h=480|>");
check("point prompt: a chosen point is clamped into the picture", pointPrompt(640, 480, { x: 9000, y: -4 }) === "<0f>1<|point;x=639;y=0;w=640;h=480|>");
check("concept phrase: a short lower-case noun phrase", conceptPhrase("Elf Alchemist Mascot!") === "elf alchemist mascot" && conceptPhrase("  Red   Robot ") === "red robot");
check("concept phrase: placeholders give nothing (then the point prompt is used)", conceptPhrase("your character") === "" && conceptPhrase("enemy") === "" && conceptPhrase("") === "" && conceptPhrase("a level") === "");
let badSize = null; try { await findSubject({ imageDataUrl: "data:image/png;base64,AA==", width: 0, height: 10 }); } catch (e) { badSize = e; }
check("findSubject refuses a bad picture size before calling SAM", badSize?.status === 400);

// ---- live: SAM 3.1 on the logo (skipped without a key) ----
if (process.env.MODEL_API_KEY) {
  const png = fs.readFileSync("assets/apple-touch-icon.png");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const imageDataUrl = "data:image/png;base64," + png.toString("base64");
  try {
    const byName = await findSubject({ imageDataUrl, phrase: "cartoon character", width, height });
    const bw = byName.box.x2 - byName.box.x1 + 1, bh = byName.box.y2 - byName.box.y1 + 1;
    check("live: the phrase finds the character (box inside the picture, mask over the box, one_bit payload)", byName.how === "phrase" && byName.box.w === width && byName.box.h === height && bw > 40 && bh > 40 && byName.mask.width === bw && byName.mask.height === bh && byName.mask.encoding === "one_bit" && byName.mask.payload.length > 20, { how: byName.how, box: byName.box, mask: [byName.mask.height, byName.mask.width, byName.mask.payload.length], ms: byName.ms });
    const byPoint = await findSubject({ imageDataUrl, phrase: "", width, height });
    check("live: with no name, the point in the middle finds something", byPoint.how === "point" && byPoint.mask.payload.length > 20, { how: byPoint.how, box: byPoint.box, ms: byPoint.ms });
    const nothing = await findSubject({ imageDataUrl, phrase: "yellow school bus", width, height });
    check("live: a phrase that matches nothing falls back to the point", nothing.how === "point", { how: nothing.how, ms: nothing.ms });
  } catch (err) { check("live SAM 3.1 call", false, err.message); }
} else console.log("skip  live SAM 3.1 check (no MODEL_API_KEY)");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
