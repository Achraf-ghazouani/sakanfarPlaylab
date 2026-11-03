// Unit checks for shared/arena.mjs (no network): the format, the reachability check and fix, the generator, the word parsing.
import { normalizeArena, checkArena, autoFixArena, playtestArena, generateArena, genreWanted, viewWanted, diffArena, ARENA_TYPES, enemyKind, ENEMY_KINDS } from "../shared/arena.mjs";

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`); if (!cond) fails++; }

// words
check("shooter words ask for an arena", ["first person shooter with zombie waves", "a top down survival game", "TPS with aliens", "shoot hordes of robots"].every((t) => genreWanted(t) === "arena"));
check("platformer words ask for a platformer", ["a lava castle with moving platforms and coins", "a jungle platformer", "add more coins"].every((t) => genreWanted(t) === "platformer"));
check("a platformer with zombies stays a platformer", genreWanted("a platformer with zombies") === "platformer");
check("no genre words: null", genreWanted("make it harder") === null && genreWanted("change theme") === null);
check("views from words", viewWanted("first person shooter") === "fps" && viewWanted("third-person zombie game") === "tps" && viewWanted("top down shooter") === "top" && viewWanted("a shooter") === null);

// normalize
const n = normalizeArena({ theme: " Graveyard ", view: "top", waves: 99, objects: [
  { type: "player", x: 500, y: 500, w: 10, h: 10 }, { type: "zombie gate", x: 20, y: 20 }, { type: "crate", x: 300, y: 300, w: 60, h: 60 },
  { type: "Wall", x: 990, y: 100, w: 200, h: 40 }, { type: "medkit", x: 700, y: 700 }, { type: "laser", x: 100, y: 100 }, { type: "start", x: 0, y: 0 },
] });
check("genre, view, theme, waves capped", n.genre === "arena" && n.view === "top" && n.theme === "Graveyard" && n.waves === 20, { view: n.view, waves: n.waves });
check("synonyms and sizes", n.objects[0].type === "start" && n.objects[0].w === 40 && n.objects[1].type === "spawner" && n.objects[2].type === "prop" && n.objects[4].type === "health" && n.objects[4].w === 30, n.objects.map((o) => o.type));
check("a wall past the edge is clamped", n.objects[3].x + n.objects[3].w <= 1000, n.objects[3]);
check("unknown types become props, a second start too", n.objects[5].type === "prop" && n.objects[6].type === "prop");
const e = normalizeArena({ objects: [] });
check("an empty arena gets a start and two spawners", e.objects.filter((o) => o.type === "start").length === 1 && e.objects.filter((o) => o.type === "spawner").length === 2 && e.view === "fps" && e.waves === 5);
check("every type is known", ARENA_TYPES.length === 6);

// check + fix: a spawner boxed in by walls
const boxed = normalizeArena({ objects: [
  { type: "start", x: 480, y: 480 }, { type: "spawner", label: "east gate", x: 900, y: 480 },
  { type: "wall", label: "north wall", x: 820, y: 380, w: 180, h: 40 }, { type: "wall", label: "south wall", x: 820, y: 600, w: 180, h: 40 }, { type: "wall", label: "west wall", x: 820, y: 380, w: 40, h: 260 },
  { type: "ammo", label: "ammo", x: 200, y: 200 }, { type: "spawner", label: "open gate", x: 60, y: 60 },
] });
const c1 = checkArena(boxed);
check("a walled-off spawner is a problem", !c1.ok && c1.problems.length === 1 && /east gate.*cannot reach/.test(c1.problems[0]), c1.problems);
const f1 = autoFixArena(boxed);
check("the fix moves it to open ground and the arena passes", f1.fixes.length === 1 && /moved spawner "east gate"/.test(f1.fixes[0]) && checkArena(f1.level).ok, f1.fixes);
check("walls are untouched by the fix", f1.level.objects.filter((o) => o.type === "wall").length === 3);
const pt = playtestArena(boxed);
check("playtest marks the level", pt.level.checked === true && pt.level.fixes.length === 1 && pt.report.after.ok);
const inWall = normalizeArena({ objects: [{ type: "start", x: 480, y: 480 }, { type: "wall", label: "big block", x: 400, y: 400, w: 200, h: 200 }, { type: "spawner", x: 60, y: 60 }] });
check("a start inside a wall is a problem", !checkArena(inWall).ok && /inside a wall/.test(checkArena(inWall).problems[0]));
check("the fix removes that wall", autoFixArena(inWall).fixes.length === 1 && checkArena(autoFixArena(inWall).level).ok, autoFixArena(inWall).fixes);

// generator
const g1 = generateArena("create first person shooter game that shoot zombie waves");
check("fps zombie arena from words", g1.genre === "arena" && g1.view === "fps" && /zombie/.test(g1.theme) && g1.waves === 5 && g1.objects.length >= 14, { view: g1.view, theme: g1.theme, waves: g1.waves, n: g1.objects.length });
check("it has one start, 3-4 gates, walls, cover, pickups", g1.objects.filter((o) => o.type === "start").length === 1 && [3, 4].includes(g1.objects.filter((o) => o.type === "spawner").length) && g1.objects.filter((o) => o.type === "wall").length >= 4 && g1.objects.some((o) => o.type === "ammo") && g1.objects.some((o) => o.type === "health"));
check("every gate can reach the player", checkArena(g1).ok && g1.checked === true);
const g2 = generateArena("top down alien survival, 8 waves");
check("top-down alien arena with 8 waves", g2.view === "top" && /alien/.test(g2.theme) && g2.waves === 8, { view: g2.view, theme: g2.theme, waves: g2.waves });
check("same words, same arena; other words, another one", JSON.stringify(generateArena("zombies fps")) === JSON.stringify(generateArena("zombies fps")) && JSON.stringify(generateArena("zombies fps")) !== JSON.stringify(generateArena("robots tps")));
check("labels fit the theme", g1.objects.some((o) => /zombie gate/.test(o.label)) && g1.objects.some((o) => /tombstone|coffin|dead tree|crypt|fence|mausoleum/.test(o.label)));

// enemy kinds from the gate's label
check("gate labels pick the enemy kind", enemyKind("runner zombie gate") === "runner" && enemyKind("brute gate") === "brute" && enemyKind("zombie gate") === "walker" && enemyKind("boss door") === "brute" && enemyKind("hound pen") === "runner");
check("runners are fast and fragile, brutes slow and tough", ENEMY_KINDS.runner.hp === 1 && ENEMY_KINDS.runner.speed > 1.4 && ENEMY_KINDS.brute.hp === 4 && ENEMY_KINDS.brute.speed < 0.7);
check("the generator mixes a runner gate and a brute gate in a 4-gate arena", (() => { const g = generateArena("zombie fps 4 gates please"); const kinds = g.objects.filter((o) => o.type === "spawner").map((o) => enemyKind(o.label)); return kinds.includes("runner") && (kinds.length < 4 || kinds.includes("brute")); })());

// diff
const d = diffArena(g1, { ...g1, view: "top", waves: 7, objects: [...g1.objects, { type: "health", label: "m", x: 1, y: 1, w: 30, h: 30 }] });
check("diff in a few words", /\+1 health/.test(d) && /view top/.test(d) && /7 waves/.test(d), d);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
