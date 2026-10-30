// Unit checks for the playtest agent (shared/reach.mjs).  Run: npm test
import fs from "node:fs/promises";
import { checkLevel, autoFixLevel, jumpReach, MAX_JUMP_H, canJump } from "../shared/reach.mjs";

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 240) : ""}`);
  if (!cond) fails++;
}
const ground = { type: "platform", label: "ground", x: 0, y: 900, w: 1000, h: 50 };
const start = { type: "start", label: "stick figure", x: 40, y: 840, w: 40, h: 60 };
const lvl = (...objects) => ({ theme: "test", objects });

// physics helpers
check("max jump height is ~252", Math.abs(MAX_JUMP_H - 252) < 1, MAX_JUMP_H);
check("flat jump reach ~302", Math.abs(jumpReach(0) - 302) < 2, jumpReach(0));
check("reach shrinks when jumping up", jumpReach(200) < jumpReach(0) && jumpReach(200) > 100, jumpReach(200));
check("reach grows when dropping down", jumpReach(-300) > jumpReach(0), jumpReach(-300));
check("too high -> -1", jumpReach(300) === -1);

// real levels
const sample = JSON.parse(await fs.readFile("levels/sample.json", "utf8"));
const level1 = JSON.parse(await fs.readFile("levels/level1.json", "utf8"));
const rs = checkLevel(sample), r1 = checkLevel(level1);
check("sample.json is fully reachable", rs.ok && rs.goalReachable, rs.problems.map((p) => p.message));
check("level1.json (notebook photo) is fully reachable", r1.ok && r1.goalReachable, r1.problems.map((p) => p.message));

// an easy ledge
let r = checkLevel(lvl(ground, start, { type: "platform", label: "ledge", x: 300, y: 760, w: 200, h: 20 }, { type: "goal", label: "flag", x: 450, y: 700, w: 40, h: 60 }));
check("ledge 140 up with room beside it is reachable", r.ok && r.goalReachable, r.problems);

// too high
r = checkLevel(lvl(ground, start, { type: "platform", label: "sky ledge", x: 300, y: 500, w: 200, h: 20 }, { type: "goal", label: "flag", x: 900, y: 840, w: 40, h: 60 }));
check("ledge 400 up is flagged too high", !r.ok && r.problems.length === 1 && r.problems[0].why === "too high" && r.problems[0].label === "sky ledge", r.problems[0]?.message);
check("goal on the ground still reachable", r.goalReachable);

// too far
r = checkLevel(lvl({ ...ground, w: 300 }, start, { type: "platform", label: "island", x: 800, y: 900, w: 200, h: 50 }, { type: "goal", label: "flag", x: 950, y: 840, w: 40, h: 60 }));
check("island 500 across is flagged too far, goal unreachable", !r.ok && !r.goalReachable && r.problems.some((p) => p.label === "island" && p.why === "too far"), r.problems.map((p) => p.message));

// head-bonk: platform directly above a narrow base with no room beside it
r = checkLevel(lvl({ type: "platform", label: "pillar", x: 400, y: 900, w: 100, h: 100 }, { type: "start", x: 430, y: 840, w: 40, h: 60 }, { type: "platform", label: "lid", x: 350, y: 750, w: 200, h: 20 }, { type: "goal", x: 430, y: 690, w: 40, h: 60 }));
check("platform right above with no side room is unreachable", !r.ok && r.problems[0]?.why === "no room beside it to jump from", r.problems[0]?.message);
check("canJump returns details", canJump({ left: 0, right: 100, top: 900 }, { left: 500, right: 600, top: 900 }).why === "too far");

// coins
r = checkLevel(lvl(ground, start, { type: "coin", label: "circle", x: 500, y: 780, w: 30, h: 30 }, { type: "coin", label: "sky coin", x: 500, y: 300, w: 30, h: 30 }, { type: "goal", x: 900, y: 840, w: 40, h: 60 }));
check("coin within jump height is reachable, sky coin is not", !r.ok && r.problems.length === 1 && r.problems[0].label === "sky coin", r.problems.map((p) => p.message));

// aspect: horizontal distances scale with the photo aspect
const wide = lvl({ ...ground, w: 300 }, start, { type: "platform", label: "far", x: 520, y: 900, w: 200, h: 50 }, { type: "goal", x: 650, y: 840, w: 40, h: 60 });
check("220 grid gap reachable at aspect 1", checkLevel(wide).ok);
check("same gap at aspect 1.333 is still reachable (reach scales too)", checkLevel({ ...wide, aspect: 1.333 }).ok);

// auto fix
const broken = lvl({ ...ground, w: 300 }, start, { type: "platform", label: "sky ledge", x: 300, y: 450, w: 150, h: 20 }, { type: "platform", label: "island", x: 850, y: 900, w: 150, h: 50 }, { type: "coin", label: "sky coin", x: 600, y: 250, w: 30, h: 30 }, { type: "goal", label: "flag", x: 950, y: 840, w: 40, h: 60 });
const before = checkLevel(broken);
check("broken level has 4 problems (ledge, island, coin, goal on the island)", before.problems.length === 4, before.problems.map((p) => p.message));
const fixed = autoFixLevel(broken);
const after = checkLevel(fixed.level);
check("autoFix makes it fully reachable", after.ok && after.goalReachable, { changes: fixed.changes, left: after.problems.map((p) => p.message) });
check("autoFix only adds platforms, keeps every original object", fixed.level.objects.length > broken.objects.length && broken.objects.every((o, i) => JSON.stringify(fixed.level.objects[i]) === JSON.stringify(o)));
check("autoFix labels its steps", fixed.level.objects.slice(broken.objects.length).every((o) => o.type === "platform" && o.label.startsWith("step (auto)")));
check("autoFix keeps steps inside the grid", fixed.level.objects.every((o) => o.x >= 0 && o.y >= 0 && o.x + o.w <= 1000 && o.y + o.h <= 1000));
check("autoFix on a good level changes nothing", autoFixLevel(sample).changes.length === 0);

// the hand-made impossible demo level: a 470-high ledge, a sky coin and a far island
const impossible = JSON.parse(await fs.readFile("levels/impossible.json", "utf8"));
const impFix = autoFixLevel(impossible);
const impAfter = checkLevel(impFix.level);
check("impossible.json: autoFix makes it beatable", impAfter.ok && impAfter.goalReachable, { steps: impFix.changes.length, left: impAfter.problems.map((p) => p.message) });
check("impossible.json: fixed with few steps", impFix.changes.length <= 7, impFix.changes);

// the head-bonk case is also fixable
const bonk = lvl({ type: "platform", label: "pillar", x: 400, y: 900, w: 100, h: 100 }, { type: "start", x: 430, y: 840, w: 40, h: 60 }, { type: "platform", label: "lid", x: 350, y: 750, w: 200, h: 20 }, { type: "goal", x: 430, y: 690, w: 40, h: 60 });
const bonkFix = autoFixLevel(bonk);
check("lid above a pillar gets a side perch", checkLevel(bonkFix.level).ok, bonkFix.changes);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
