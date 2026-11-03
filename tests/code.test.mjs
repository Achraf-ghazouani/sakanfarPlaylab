// Unit checks for "any game from a prompt" (lib/code.mjs, shared/codekinds.mjs, shared/codescan.mjs), no network: the
// router between the engines and the code builder, the plan normaliser, the HTML parser and its notes, the engine
// detector, the validator the projects API uses, the system prompt. Then live calls when MODEL_API_KEY is set: a plan from
// Muse Spark (a few seconds) and, with PLAYLAB_LIVE_CODE=1, a whole game from Muse Wonder (about a minute).
//   node tests/code.test.mjs
import { codeKind, normalizePlan, parseGameHtml, engineOf, validateCodeLevel, systemPrompt, planGame, generateGame, actionFor, describePlan, ENGINES, LAYOUTS, makeFixToken, readFixToken, MAX_FIXES, cleanReport, describeFailure, repairGame, lookAtGame, LOOK_BRIEF, parsePatches, applyPatches, lineDiff, changeGame, describeAssets } from "../lib/code.mjs";
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

// ---- the self-healing loop: tokens, the failure report, the repair prompt, the vision check (no network) ----
if (!process.env.PLAYLAB_SERVER_KEY) process.env.PLAYLAB_SERVER_KEY = "test-secret-for-tokens-only";
const tok = makeFixToken({ ledger: 42, n: 0, project: "p1" });
const read = readFixToken(tok);
check("fix tokens: a build hands out a signed token that reads back with its ledger, attempt 0 and project", !!tok && tok.includes(".") && read?.ledger === 42 && read.n === 0 && read.project === "p1" && read.exp > Date.now(), read);
check("fix tokens: a tampered, a garbage and an expired token are refused; the attempt count carries over", readFixToken(tok.slice(0, -2) + "xx") === null && readFixToken("nope") === null && readFixToken(makeFixToken({ ledger: 1, n: 2, ttl: -1000 })) === null && readFixToken(makeFixToken({ ledger: 1, n: 2 })).n === 2 && MAX_FIXES === 3);
const rep = cleanReport({ errors: [{ kind: "exception", message: "x".repeat(700), line: "9", col: 1, stack: "s" }, "junk"], blank: "one flat colour", ready: true, responds: false, restart: "yes", scan: { ok: false, problems: ["uses eval / new Function"] }, feedback: "f" });
check("cleanReport: errors capped and typed, booleans kept only when booleans, the scan and feedback kept", rep.errors.length === 1 && rep.errors[0].message.length === 600 && rep.errors[0].line === 9 && rep.blank === "one flat colour" && rep.ready === true && rep.responds === false && rep.restart === null && rep.scan.ok === false && rep.feedback === "f", rep);
const failLines = describeFailure({ errors: [{ kind: "exception", message: "notAFunction is not defined", line: 9, col: 1, stack: "ReferenceError: notAFunction is not defined\n    at about:srcdoc:9:1" }], responds: false, restart: false, feedback: "match 30%: a black screen" });
check("describeFailure: one line per problem with the line number, the input and restart advice, the look's feedback", failLines.length === 4 && /exception: notAFunction is not defined \(line 9:1/.test(failLines[0]) && /PlayLab\.input every frame/.test(failLines[1]) && /PlayLab\.onRestart/.test(failLines[2]) && /match 30%/.test(failLines[3]), failLines);
let seen = null;
const fakeStream = async ({ messages }) => { seen = messages; return { content: EXAMPLES.snake, finishReason: "stop", usage: {}, provider: "meta", model: "muse-wonder-1.0", ms: 1 }; };
const fixed = await repairGame({ plan: { title: "Snake", engine: "canvas" }, prompt: "a snake game", html: "<html><body><canvas></canvas><script>notAFunction()</script></body></html>", report: { errors: [{ kind: "exception", message: "notAFunction is not defined", line: 1 }] } }, { stream: fakeStream, provider: { name: "meta", url: "x", key: "k", model: "m" } });
check("repairGame: the system prompt, the report and the whole file go to the model; the answer is parsed like a build", seen?.length === 2 && seen[0].content === systemPrompt() && /WHAT WENT WRONG:\n- exception: notAFunction is not defined/.test(seen[1].content) && /THE FILE:\n<html>/.test(seen[1].content) && /COMPLETE corrected file/.test(seen[1].content) && fixed.html === EXAMPLES.snake && fixed.scan.ok && fixed.engine === "canvas", seen?.[1]?.content?.slice(0, 200));
const fakeChat = async ({ system, prompt, imageBase64, mime }) => ({ text: `Here: {"match": 0.85, "looks_like": "a green snake on a dark grid with a score", "problems": [], "suggestion": ""}`, model: "muse-spark-1.3", ms: 1, system, prompt, imageBase64, mime });
const look = await lookAtGame({ plan: { title: "Snake" }, prompt: "a snake game", snapshot: "data:image/jpeg;base64,/9j/4AAQ" }, { chatFn: fakeChat });
check("lookAtGame: the screenshot goes to Muse Spark with the brief, the JSON verdict is parsed and clamped", look.match === 0.85 && /green snake/.test(look.looksLike) && look.problems.length === 0 && look.suggestion === "" && look.model === "muse-spark-1.3" && /JSON object only/.test(LOOK_BRIEF), look);
let bad = null; try { await lookAtGame({ plan: {}, prompt: "", snapshot: "not an image" }, { chatFn: fakeChat }); } catch (e) { bad = e.message; }
check("lookAtGame refuses a missing screenshot", /screenshot is required/.test(bad || ""));

// ---- step 5: changes and fixes as patches ----
const SRC = EXAMPLES.snake;
const parsed = parsePatches("noise\n<<<<<<< SEARCH\nconst cv = document.getElementById(\"c\"), ctx = cv.getContext(\"2d\"), N = 20, CELL = 20;\n=======\nconst cv = document.getElementById(\"c\"), ctx = cv.getContext(\"2d\"), N = 20, CELL = 20, BLUE = \"#3b82f6\";\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n  ctx.fillStyle = \"#ef4444\";\n=======\n  ctx.fillStyle = BLUE;\n>>>>>>> REPLACE\nNOTES {\"note\":\"blue apples\",\"built\":\"Apples are blue now.\",\"missing\":\"\"}");
check("parsePatches: two blocks and the NOTES line", parsed.patches.length === 2 && parsed.notes.note === "blue apples" && parsed.notes.built === "Apples are blue now.", parsed);
const applied = applyPatches(SRC, parsed.patches);
check("applyPatches: both blocks fit, the file changed only there, the scan stays clean", applied.failed.length === 0 && applied.applied === 2 && /BLUE = "#3b82f6"/.test(applied.html) && /ctx\.fillStyle = BLUE;/.test(applied.html) && applied.html.length - SRC.length < 40 && scan(applied.html).ok, applied.failed);
check("lineDiff counts the changed lines", JSON.stringify(lineDiff(SRC, applied.html)) === JSON.stringify({ added: 2, removed: 2 }), lineDiff(SRC, applied.html));
const fuzzy = applyPatches(SRC, [{ search: "function placeApple() {\n do {", replace: "x" }, { search: "if (dead && PlayLab.input.pressed(1, \"A\")) reset();", replace: "  if (dead && PlayLab.input.pressed(1, \"B\")) reset();" }]);
check("applyPatches: a SEARCH that is not in the file fails the whole set and changes nothing", fuzzy.failed.length === 1 && fuzzy.failed[0].i === 0 && /not in the file/.test(fuzzy.failed[0].error) && fuzzy.html === SRC);
const indented = applyPatches(SRC, [{ search: "if (dead && PlayLab.input.pressed(1, \"A\")) reset();", replace: "  if (dead && PlayLab.input.pressed(1, \"B\")) reset();" }]);
check("applyPatches: a SEARCH copied without its indentation is replaced with the indentation of the REPLACE (no doubled spaces)", indented.failed.length === 0 && /\n  if \(dead && PlayLab\.input\.pressed\(1, "B"\)\) reset\(\);/.test(indented.html) && !/\n    if \(dead/.test(indented.html));
const loose = applyPatches(SRC, [{ search: "function reset() {   \n", replace: "x" }]);
const byLines = applyPatches("a\n    let speed = 3;\n    let y = 1;\nb", [{ search: "let speed = 3;\n  let y = 1;", replace: "    let speed = 5;\n    let y = 2;" }]);
check("applyPatches: lines match ignoring indentation and trailing spaces; an ambiguous SEARCH fails", byLines.failed.length === 0 && byLines.html === "a\n    let speed = 5;\n    let y = 2;\nb" && applyPatches("x\ny\nx", [{ search: "x", replace: "z" }]).failed[0]?.error === "the SEARCH appears more than once", [byLines, loose.failed]);
// changeGame: patches first; the whole file when they do not fit
const PATCH_ANSWER = "<<<<<<< SEARCH\n  ctx.fillStyle = \"#ef4444\";\n=======\n  ctx.fillStyle = \"#3b82f6\";\n>>>>>>> REPLACE\nNOTES {\"note\":\"blue apples\",\"built\":\"Blue apples.\",\"missing\":\"\"}";
const calls = [];
const fakeChange = (answers) => async ({ messages, maxTokens }) => { calls.push({ user: messages[1].content, maxTokens }); return { content: answers.shift(), finishReason: "stop", usage: {}, provider: "meta", model: "muse-wonder-1.0", ms: 1 }; };
const prov = { name: "meta", url: "x", key: "k", model: "m" };
const ch = await changeGame({ plan: { title: "Snake", engine: "canvas" }, prompt: "a snake game", html: SRC, change: "make the apples blue" }, { stream: fakeChange([PATCH_ANSWER]), provider: prov });
check("changeGame: one call that asks for patches with the current file; the patch is applied, mode patch, the diff counted", calls.length === 1 && /ANSWER WITH PATCHES/.test(calls[0].user) && /THE CURRENT FILE:\n<!doctype html>/.test(calls[0].user) && calls[0].maxTokens === 12_000 && ch.patch.mode === "patch" && ch.patch.count === 1 && ch.patch.added === 1 && ch.patch.removed === 1 && /#3b82f6/.test(ch.html) && ch.notes.note === "blue apples" && ch.scan.ok, ch.patch);
calls.length = 0;
const progress = [];
const rw = await changeGame({ plan: { title: "Snake", engine: "canvas" }, prompt: "a snake game", html: SRC, change: "make the apples blue" }, { stream: fakeChange(["<<<<<<< SEARCH\nnot in the file\n=======\nx\n>>>>>>> REPLACE", applied.html]), provider: prov, onProgress: (p) => progress.push(p) });
check("changeGame: a patch that does not fit falls back to the whole file, says why, and tells the progress", calls.length === 2 && /COMPLETE updated file/.test(calls[1].user) && rw.patch.mode === "rewrite" && /did not fit \(the SEARCH is not in the file\)/.test(rw.patch.why) && progress.some((p) => p.rewrite) && rw.html === applied.html, rw.patch);
calls.length = 0;
const evilPatch = await changeGame({ plan: { title: "Snake" }, prompt: "", html: SRC, change: "x" }, { stream: fakeChange(["<<<<<<< SEARCH\n  ctx.fillStyle = \"#ef4444\";\n=======\n  fetch(\"https://x.y\"); ctx.fillStyle = \"#ef4444\";\n>>>>>>> REPLACE", SRC]), provider: prov });
check("changeGame: a patch that would add something forbidden is not used (the whole file is asked for instead)", evilPatch.patch.mode === "rewrite" && /uses network calls/.test(evilPatch.patch.why) && evilPatch.scan.ok);
calls.length = 0;
const rp = await repairGame({ plan: { title: "Snake" }, prompt: "a snake game", html: SRC, report: { errors: [{ kind: "exception", message: "x is not defined", line: 3 }] } }, { stream: fakeChange([PATCH_ANSWER]), provider: prov });
check("repairGame: a fix is a patch too (the error list and patch rules in the request)", calls.length === 1 && /failed in the sandbox/.test(calls[0].user) && /x is not defined/.test(calls[0].user) && /ANSWER WITH PATCHES/.test(calls[0].user) && rp.patch.mode === "patch", rp.patch);

// ---- AI code always on: the 2D / 3D choice in the plan, a picture to improve on, models named in the prompts ----
let planSeen = null;
const fakePlan = async ({ messages }) => { planSeen = messages[messages.length - 1].content; return { content: JSON.stringify({ title: "T", genre: "g", engine: "three", goal: "", controls: "", controller: "tap", win: "", lose: "", entities: [], opponents: "none", levels: "", players: 1, notes: "", picture: "a drawn oval track" }), model: "m", provider: "meta", ms: 1 }; };
await planGame({ message: "a racing game", dimension: "3d" }, { complete: fakePlan });
check("planGame: the 3D switch asks for the three engine", /chose 3D: the engine must be "three"/.test(planSeen), planSeen);
await planGame({ message: "a racing game", dimension: "2d" }, { complete: fakePlan });
check("planGame: the 2D switch asks for phaser or canvas", /chose 2D/.test(planSeen));
const withPic = await planGame({ message: "a race on this", image: "data:image/jpeg;base64,/9j/4AAQ", dimension: "3d" }, { complete: fakePlan });
check("planGame: a picture goes as an image part with the ask to improve on a rough drawing; the plan keeps the picture field", Array.isArray(planSeen) && planSeen[1].image_url.url.startsWith("data:image/jpeg") && /improve on/.test(planSeen[0].text) && withPic.plan.picture === "a drawn oval track");
check("describeAssets: models with their format, pictures as pictures", describeAssets({ player: { kind: "model", name: "hero.fbx" }, enemy: { kind: "model", name: "x" }, background: { kind: "image", name: "bg" } }) === "player (3D model, FBX), enemy (3D model, GLB), background (picture)");
check("the SDK docs say how to load an FBX and a GLB", /FBXLoader/.test(systemPrompt()) && /GLTFLoader/.test(systemPrompt()));

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
