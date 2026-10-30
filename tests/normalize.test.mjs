// Unit checks for normalizeLevel / extractJson / imageSize.  Run: npm test
import { normalizeLevel, extractJson, imageSize } from "../lib/scan-level.mjs";

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`);
  if (!cond) fails++;
}

// extractJson: fenced JSON with prose around it
const fenced = "Sure! Here it is:\n```json\n{\"theme\":\"x\",\"objects\":[]}\n```\nDone.";
check("extractJson strips fences + prose", extractJson(fenced)?.theme === "x");
check("extractJson plain", extractJson("{\"theme\":\"y\",\"objects\":[]}")?.theme === "y");
check("extractJson garbage -> null", extractJson("no json here") === null);

// empty level gets ground, start, goal
const empty = normalizeLevel({});
const types = (lvl) => lvl.objects.map((o) => o.type);
check("empty -> ground+start+goal", types(empty).sort().join() === "goal,platform,start", types(empty));
check("empty theme fallback", empty.theme === "hand-drawn level");
check("no aspect unless given", empty.aspect === undefined);

// synonyms, clamping, duplicates
const messy = normalizeLevel({
  theme: "  Desert  ",
  objects: [
    { type: "Player", label: "stick", x: -50, y: 2000, w: 5, h: 5 },
    { type: "start", label: "second start", x: 100, y: 100, w: 40, h: 40 },
    { type: "FLAG", x: "990", y: "990", w: 500, h: 500 },
    { type: "moving platform", x: 10, y: 10, w: 100, h: 20 },
    { type: "Cloud", x: 10, y: 50, w: 100, h: 20 },
    { type: "unicorn", x: 1, y: 1, w: 10, h: 10 },
    { type: "ground", x: 0, y: 900, w: 1000, h: 50 },
    null, "junk",
  ],
}, { aspect: 4 / 3 });
const m = messy.objects;
check("Player -> start", m[0].type === "start");
check("negative/overflow clamped", m[0].x === 0 && m[0].y <= 1000 - 30 && m[0].w >= 30, m[0]);
check("second start demoted", m[1].type === "decoration");
check("FLAG -> goal, string coords, clamped inside grid", m[2].type === "goal" && m[2].x + m[2].w <= 1000 && m[2].y + m[2].h <= 1000, m[2]);
check("moving platform (space) -> moving_platform", m[3].type === "moving_platform");
check("Cloud -> moving_platform", m[4].type === "moving_platform");
check("unknown -> decoration", m[5].type === "decoration");
check("ground -> platform", m[6].type === "platform");
check("junk entries dropped", m.length === 7, m.length);
check("theme trimmed", messy.theme === "Desert");
check("all ints", m.every((o) => [o.x, o.y, o.w, o.h].every(Number.isInteger)));
check("aspect kept and rounded", messy.aspect === 1.333, messy.aspect);
check("silly aspect dropped", normalizeLevel({ aspect: 42 }).aspect === undefined);

// auto goal placed on rightmost platform
const noGoal = normalizeLevel({ objects: [{ type: "platform", x: 0, y: 900, w: 300, h: 30 }, { type: "platform", x: 600, y: 500, w: 300, h: 30 }, { type: "start", x: 10, y: 840, w: 40, h: 60 }] });
const g = noGoal.objects.find((o) => o.type === "goal");
check("auto goal on rightmost platform", g && g.x >= 600 && g.y === 440, g);

// imageSize: PNG header and a minimal JPEG SOF0
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
check("imageSize PNG 1x1", JSON.stringify(imageSize(png)) === JSON.stringify({ width: 1, height: 1, orientation: 1 }), imageSize(png));
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x00, 0x08, 0x00, 0x03, ...Array(10).fill(0), 0xff, 0xda, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
check("imageSize JPEG SOF0 2048x1536", (() => { const d = imageSize(jpg); return d && d.width === 2048 && d.height === 1536; })(), imageSize(jpg));
check("imageSize garbage -> null", imageSize(Buffer.from("hello world, not an image at all")) === null);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
