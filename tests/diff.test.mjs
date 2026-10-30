// Unit checks for shared/diff.mjs.  Run: npm test
import { diffLevels } from "../shared/diff.mjs";

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 200) : ""}`);
  if (!cond) fails++;
}
const o = (type, x, y, w, h, label) => ({ type, label: label || type, x, y, w, h });
const prev = { objects: [o("platform", 0, 900, 1000, 50, "ground"), o("start", 40, 840, 40, 60), o("coin", 500, 700, 30, 30), o("spike", 300, 870, 60, 30), o("goal", 900, 840, 40, 60)] };

// identical
let d = diffLevels(prev, prev);
check("identical -> all same", d.same.length === 5 && !d.added.length && !d.removed.length && !d.moved.length && d.summary === "no changes spotted", d.summary);

// small jitter from a new photo is still "same"
const jitter = { objects: prev.objects.map((p) => ({ ...p, x: p.x + 12, y: p.y - 8 })) };
d = diffLevels(prev, jitter);
check("small jitter -> same", d.same.length === 5 && !d.moved.length, d.summary);

// added a platform and a coin, erased the spike, moved the goal
const next = { objects: [o("platform", 0, 900, 1000, 50, "ground"), o("start", 40, 840, 40, 60), o("coin", 500, 700, 30, 30), o("goal", 700, 600, 40, 60), o("platform", 400, 650, 200, 25, "bridge"), o("coin", 450, 600, 30, 30)] };
d = diffLevels(prev, next);
check("added 1 platform + 1 coin", d.added.length === 2 && d.added.map((i) => next.objects[i].type).sort().join() === "coin,platform", d.added);
check("removed the spike", d.removed.length === 1 && prev.objects[d.removed[0]].type === "spike");
check("moved the goal", d.moved.length === 1 && next.objects[d.moved[0].next].type === "goal");
check("summary reads well", d.summary === "added 1 platform, 1 coin · removed 1 spike · moved 1 goal", d.summary);

// auto steps are named "step"
d = diffLevels(prev, { objects: [...prev.objects, o("platform", 200, 700, 100, 18, "step (auto) to ledge")] });
check("auto step counted as step", d.summary === "added 1 step", d.summary);

// type must match: a coin does not become a platform
d = diffLevels({ objects: [o("coin", 500, 700, 30, 30)] }, { objects: [o("platform", 500, 700, 30, 30)] });
check("different types never match", d.added.length === 1 && d.removed.length === 1);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
