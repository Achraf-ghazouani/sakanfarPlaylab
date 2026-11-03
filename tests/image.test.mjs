// Checks for lib/image.mjs and lib/segment.mjs: reading Muse Spark's classification (every asset role, older answers, hints),
// the Muse Image sprite prompt, SAM 3.1's output grammar and prompts (no network), then live calls when MODEL_API_KEY is
// set (.env): SAM 3.1 on the logo, and Muse Spark classifying two of the sample pictures in tests/samples/.
import fs from "node:fs";
import { parseClassification, classifyPicture, spritePrompt, ASSET_ROLES, OBJECT_SLOT } from "../lib/image.mjs";
import { parseSegmentation, pickSubject, pointPrompt, conceptPhrase, findSubject } from "../lib/segment.mjs";
try { process.loadEnvFile(".env"); } catch {}

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 240) : ""}`); if (!cond) fails++; }

// ---- classification: the new roles ----
const c1 = parseClassification('{"role":"player","name":"Elf Alchemist Mascot","confidence":0.85,"hint":""}');
check("a player: kind character, no object slot", c1.role === "player" && c1.kind === "character" && c1.objRole === null && c1.name === "Elf Alchemist Mascot" && c1.confidence === 0.85, c1);
const c2 = parseClassification('Sure! ```json\n{"role":"collectible","name":"golden apple","confidence":0.7}\n```');
check("a collectible fills the coin slot (JSON inside prose and a code fence)", c2.role === "collectible" && c2.kind === "object" && c2.objRole === "coin" && c2.name === "golden apple", c2);
const c3 = parseClassification('{"role":"ui_button","name":"pause button","confidence":0.9,"hint":"Pause"}');
check("a UI button with its hint, kind asset", c3.role === "ui_button" && c3.kind === "asset" && c3.objRole === null && c3.hint === "pause", c3);
const c4 = parseClassification('{"role":"ui_icon","name":"red heart","confidence":0.8,"hint":"a heart for health"}');
check("a hint sentence is reduced to the hint word", c4.role === "ui_icon" && c4.hint === "heart", c4);
const c5 = parseClassification('{"role":"ui_hud","name":"coin counter","confidence":0.6,"hint":"banana"}');
check("an unknown hint becomes empty", c5.role === "ui_hud" && c5.hint === "", c5);
for (const role of ASSET_ROLES) { const c = parseClassification(JSON.stringify({ role, name: "x y", confidence: 0.9 })); if (c.role !== role) check(`role ${role} round-trips`, false, c); }
check("every asset role round-trips", true);
check("the object slots: enemy, collectible -> coin, hazard -> spike, goal, decoration", OBJECT_SLOT.collectible === "coin" && OBJECT_SLOT.hazard === "spike" && Object.keys(OBJECT_SLOT).length === 5);
// older answers and bad ones
const o1 = parseClassification('{"kind":"character","role":null,"name":"hero","confidence":0.8}');
check("an older character answer becomes player", o1.role === "player" && o1.kind === "character", o1);
const o2 = parseClassification('{"kind":"object","role":"spike","name":"saw","confidence":0.7}');
check("an older object answer maps its slot (spike -> hazard)", o2.role === "hazard" && o2.objRole === "spike" && o2.kind === "object", o2);
const o3 = parseClassification('{"role":"laser","name":"thing"}');
check("an unknown role is treated as a level (the scanner decides)", o3.role === "level" && o3.kind === "level", o3);
const o4 = parseClassification("I am not sure what this is.");
check("no JSON: a level", o4.role === "level" && o4.confidence === 0.5, o4);
const o5 = parseClassification('{"role":"player","name":"<script>x</script>","confidence":7}');
check("names are cleaned, confidence is capped", !/[<>]/.test(o5.name) && o5.confidence === 1, o5);

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

// ---- live (skipped without a key) ----
if (process.env.MODEL_API_KEY) {
  const png = fs.readFileSync("assets/apple-touch-icon.png");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const imageDataUrl = "data:image/png;base64," + png.toString("base64");
  try {
    const byName = await findSubject({ imageDataUrl, phrase: "cartoon character", width, height });
    const bw = byName.box.x2 - byName.box.x1 + 1, bh = byName.box.y2 - byName.box.y1 + 1;
    check("live SAM: the phrase finds the character (box inside the picture, mask over the box, one_bit payload)", byName.how === "phrase" && byName.box.w === width && byName.box.h === height && bw > 40 && bh > 40 && byName.mask.width === bw && byName.mask.height === bh && byName.mask.encoding === "one_bit" && byName.mask.payload.length > 20, { how: byName.how, box: byName.box, mask: [byName.mask.height, byName.mask.width, byName.mask.payload.length], ms: byName.ms });
    const byPoint = await findSubject({ imageDataUrl, phrase: "", width, height });
    check("live SAM: with no name, the point in the middle finds something", byPoint.how === "point" && byPoint.mask.payload.length > 20, { how: byPoint.how, box: byPoint.box, ms: byPoint.ms });
  } catch (err) { check("live SAM 3.1 call", false, err.message); }
  // Muse Spark classifies two samples the local checks are not sure about, with the local facts as hints
  const sample = (name) => fs.readFileSync(`tests/samples/${name}`).toString("base64");
  try {
    const hero = await classifyPicture({ base64: sample("character.png"), mime: "image/png", facts: "96 x 128 px, transparent background (60% clear), about 5 colour bins" });
    check("live Muse Spark: the character sample is a player or a decoration-like figure, not a level or UI", ["player", "enemy", "decoration"].includes(hero.role) && hero.confidence >= 0.4, { role: hero.role, name: hero.name, confidence: hero.confidence, ms: hero.ms, model: hero.model });
    const heart = await classifyPicture({ base64: sample("icon_heart.png"), mime: "image/png", hint: "this is a UI icon", facts: "64 x 64 px, transparent background (55% clear), about 2 colour bins" });
    check("live Muse Spark: the heart with the words 'UI icon' is a ui_icon with the heart hint", heart.role === "ui_icon" && heart.hint === "heart", { role: heart.role, name: heart.name, hint: heart.hint, confidence: heart.confidence, ms: heart.ms });
  } catch (err) { check("live classify call", false, err.message); }
} else console.log("skip  live SAM 3.1 and Muse Spark checks (no MODEL_API_KEY)");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
