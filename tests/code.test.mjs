// Unit checks for "any game from a prompt" (lib/code.mjs, shared/codekinds.mjs, shared/codescan.mjs), no network: the
// router between the engines and the code builder, the plan normaliser, the HTML parser and its notes, the engine
// detector, the validator the projects API uses, the system prompt. Then live calls when MODEL_API_KEY is set: a plan from
// Muse Spark (a few seconds) and, with PLAYLAB_LIVE_CODE=1, a whole game from Muse Wonder (about a minute).
//   node tests/code.test.mjs
import { codeKind, normalizePlan, parseGameHtml, engineOf, validateCodeLevel, systemPrompt, planGame, generateGame, actionFor, describePlan, ENGINES, LAYOUTS } from "../lib/code.mjs";
import { EXAMPLES } from "../lib/code-examples.mjs";
import { scan, wrap, csp } from "../shared/codescan.mjs";
try { process.loadEnvFile(".env"); } catch {}

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 260) : ""}`); if (!cond) fails++; }

// ---- the router: the nine test prompts go to the code builder, platformers and shooters stay on the engines ----
const NINE = ["car racing with 3 laps and 4 AI cars", "a match-3 puzzle", "tower defense with 3 waves", "an endless runner", "a simple flight game through rings", "2-player soccer with phone controllers", "snake", "a dungeon crawler with keys and doors", "a memory card game"];
check("every test prompt is routed to the code builder", NINE.every((t) => codeKind(t)), NINE.map((t) => [t, codeKind(t)]));
check("platformers and shooters stay on the engines, even with race or car words", ["a lava castle with 3 ledges", "first person zombie shooter", "a platformer where you drive a car", "race to the flag in a lava castle", "A space level with floating platforms and lots of coins"].every((t) => codeKind(t) === null));
check("kinds are named for people", codeKind("a tetris puzzle game") === "a puzzle game" && codeKind("chess against the computer") === "a board game" && codeKind("flappy bird") === "a classic arcade game" && codeKind("an rpg with quests") === "a role-playing game");

// ---- the plan ----
const p = normalizePlan({ title: "  Lap   Dash ", genre: "racing", engine: "3D", players: 9, entities: ["car", "", "track"], controller: "nope" });
check("normalizePlan: engine from words, players clamped to 4, empty entities dropped, a default controller for 3D", p.title === "Lap Dash" && p.engine === "three" && p.players === 4 && p.entities.length === 2 && p.controller === "stick+2buttons" && p.opponents === "none", p);
check("normalizePlan: a 2D default controller, unknown engine -> phaser", normalizePlan({ engine: "unity" }).engine === "phaser" && normalizePlan({}).controller === "dpad+2buttons" && ENGINES.includes(normalizePlan({ engine: "canvas" }).engine) && LAYOUTS.includes(normalizePlan({ controller: "tap" }).controller));
check("actionFor: 3D creates cost code_create_3d, 2D code_create_2d, a change code_edit", actionFor({ engine: "three" }) === "code_create_3d" && actionFor({ engine: "canvas" }) === "code_create_2d" && actionFor({ engine: "three" }, true) === "code_edit");
const lines = describePlan({ title: "Lap Dash", genre: "racing", engine: "three", goal: "win 3 laps", controls: "steer, A gas", win: "first", lose: "last", entities: ["car"], opponents: "4 AI cars", levels: "3 laps", players: 2, notes: "" });
check("describePlan: the card lines", lines.length === 7 && /Lap Dash · racing · three\.js · 2 players/.test(lines[0]) && /Opponents: 4 AI cars/.test(lines[5]), lines);

// ---- the answer parser ----
const fenced = parseGameHtml("Here is the game:\n```html\n<!doctype html>\n<!-- playlab {\"note\":\"snake v1\",\"built\":\"Eat apples.\",\"missing\":\"no sound\"} -->\n<html><body><canvas></canvas><script>1</script></body></html>\n```\nEnjoy!");
check("parseGameHtml: fences and words around the file are dropped, the notes comment is read", fenced.html.startsWith("<!doctype html>") && fenced.html.endsWith("</html>") && fenced.notes.note === "snake v1" && fenced.notes.built === "Eat apples." && fenced.notes.missing === "no sound", fenced);
check("parseGameHtml: no notes -> empty strings, the html stays", parseGameHtml("<html><body><canvas></canvas></body></html>").notes.note === "" && parseGameHtml("<html><body><canvas></canvas></body></html>").html.startsWith("<html>"));
check("engineOf: canvas, phaser, three from the examples", engineOf(EXAMPLES.snake) === "canvas" && engineOf(EXAMPLES.phaser) === "phaser" && engineOf(EXAMPLES.three) === "three");

// ---- the validator the projects API uses ----
for (const [name, html] of Object.entries(EXAMPLES)) {
  const v = validateCodeLevel({ genre: "code", html, plan: { title: "T", engine: engineOf(html) }, notes: parseGameHtml(html).notes, prompt: "x" });
  check(`validateCodeLevel accepts the ${name} example with its plan, notes and an empty objects list`, !v.error && v.level.genre === "code" && v.level.engine === engineOf(html) && Array.isArray(v.level.objects) && v.level.objects.length === 0 && v.level.notes.note.length > 0 && v.level.plan.title === "T", v.error);
}
check("validateCodeLevel refuses code that reaches out", /forbids/.test(validateCodeLevel({ genre: "code", html: EXAMPLES.snake.replace("<script>", "<script>fetch('https://x.y');") }).error || ""));
check("validateCodeLevel refuses an empty game and a non-code level", /missing/.test(validateCodeLevel({ genre: "code", html: "<html></html>" }).error) && /Not a code game/.test(validateCodeLevel({ genre: "arena" }).error));

// ---- the rules shared with the page ----
const s = scan(EXAMPLES.phaser);
check("scan: the examples are clean; the SDK src is allowed only from the site origin", s.ok && scan('<script src="https://playlab.test/shared/playlab-sdk.js"></script>', { origin: "https://playlab.test" }).ok && !scan('<script src="https://playlab.test/shared/playlab-sdk.js"></script>').ok);
const w = wrap("<html><head></head><body></body></html>", { origin: "https://playlab.test", assets: { player: { src: "data:,x" } } });
check("wrap: the policy names the origin for the SDK and pictures, the assets script comes before the SDK script", /https:\/\/playlab\.test\/shared\/playlab-sdk\.js/.test(w) && w.indexOf("__playlabAssets") < w.indexOf('<script src="https://playlab.test/shared/playlab-sdk.js"') && !/undefined/.test(csp("")), w.slice(0, 160));

// ---- the system prompt ----
const sp = systemPrompt();
const apis = ["PlayLab.input.axis", "PlayLab.input.button", "PlayLab.input.pressed", "PlayLab.input.aim", "PlayLab.input.pointer", "PlayLab.players", "PlayLab.controller", "PlayLab.onRestart", "PlayLab.paused", "PlayLab.start()", "PlayLab.gameOver", "PlayLab.event", "PlayLab.hud.set", "PlayLab.assets.get", "PlayLab.env"];
check("the system prompt documents every SDK call", apis.every((a) => sp.includes(a)), apis.filter((a) => !sp.includes(a)));
check("the system prompt pins the exact library addresses and includes the three examples and the notes format", sp.includes("https://cdnjs.cloudflare.com/ajax/libs/phaser/3.80.1/phaser.min.js") && sp.includes("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js") && sp.includes(EXAMPLES.snake) && sp.includes(EXAMPLES.phaser) && sp.includes(EXAMPLES.three) && /<!-- playlab \{"note"/.test(sp) && sp.length < 40_000, sp.length);

// ---- live (skipped without a key) ----
if (process.env.MODEL_API_KEY) {
  try {
    const t0 = Date.now();
    const out = await planGame({ message: "a snake game" });
    const plan = out.plan;
    check("live Muse Spark: a plan for a snake game (title, engine, controller, win and lose)", plan.title.length > 1 && ENGINES.includes(plan.engine) && LAYOUTS.includes(plan.controller) && plan.goal.length > 5 && plan.win.length > 2 && plan.lose.length > 2 && plan.players === 1, { plan, ms: Date.now() - t0, model: out.model });
    const t1 = Date.now();
    const changed = await planGame({ message: "make it 2 players", previousPlan: plan });
    check("live Muse Spark: a change to the plan keeps it a snake game and makes it 2 players", changed.plan.players === 2 && /snake/i.test(changed.plan.title + changed.plan.genre + changed.plan.goal), { plan: changed.plan, ms: Date.now() - t1 });
  } catch (err) { check("live plan call", false, err.message); }
  if (process.env.PLAYLAB_LIVE_CODE) {
    try {
      const t0 = Date.now();
      let progress = 0;
      const plan = normalizePlan({ title: "Snake", genre: "snake", engine: "canvas", goal: "eat apples, grow, do not hit walls or yourself", controls: "d-pad or arrows steer, A plays again", controller: "dpad+jump", win: "reach 20 apples", lose: "hit a wall or yourself", entities: ["snake", "apple", "grid"], opponents: "none", levels: "speed rises every 5 apples", players: 1, notes: "" });
      const g = await generateGame({ plan, prompt: "a snake game" }, { onProgress: () => progress++ });
      check("live Muse Wonder: a whole snake game as one HTML file that passes the scan, with notes, streamed with progress", g.scan.ok && g.html.length > 1500 && g.engine === "canvas" && g.notes.built.length > 5 && progress > 0 && /PlayLab\.input\.axis/.test(g.html) && /PlayLab\.controller/.test(g.html), { ms: Date.now() - t0, bytes: g.html.length, progress, notes: g.notes, usage: g.usage, finish: g.finishReason });
    } catch (err) { check("live Muse Wonder generation", false, err.message); }
  } else console.log("skip  live Muse Wonder generation (set PLAYLAB_LIVE_CODE=1; it takes about a minute)");
} else console.log("skip  live plan and generation checks (no MODEL_API_KEY)");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
await new Promise((r) => setTimeout(r, 100));   // let the API sockets close before exit
process.exit(fails ? 1 : 0);
