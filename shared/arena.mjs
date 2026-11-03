// shared/arena.mjs — the second game kind: a 3D arena shooter (first person, third person or top-down) with waves of
// enemies. Pure JS, used by the server (lib/agent.mjs, api/) and the page (arena.html).
//
// ARENA FORMAT: a top-down map on a 1000 x 1000 grid, x goes right, y goes DOWN (south). Each object is
// {type, label, x, y, w, h} with x,y the top-left corner of its footprint. arena.html turns y into depth (z).
//   start     exactly one: where the player stands (40 x 40)
//   spawner   1-8: where the enemies come from, usually near the edges (40 x 40)
//   wall      solid, tall (the engine makes it 120 high): thickness 40-60, length 100-400
//   prop      solid, low: a crate, barrel, rock or tree (40-80 square)
//   ammo      pickup, +15 shots (30 x 30)
//   health    pickup, +25 health (30 x 30)
// Plus: genre "arena", view "fps" | "tps" | "top", theme, waves (1-20). The engine fences the whole grid.

export const ARENA_TYPES = ["start", "spawner", "wall", "prop", "ammo", "health"];
export const VIEWS = ["fps", "tps", "top"];
const SYNONYMS = {
  player: "start", hero: "start", spawn: "start", playerstart: "start",
  enemy: "spawner", enemies: "spawner", zombie: "spawner", zombies: "spawner", gate: "spawner", door: "spawner", portal: "spawner", enemyspawn: "spawner", enemy_spawn: "spawner", spawn_point: "spawner", spawnpoint: "spawner", monster: "spawner",
  block: "wall", barrier: "wall", fence: "wall", pillar: "wall", column: "wall", building: "wall", house: "wall",
  crate: "prop", box: "prop", barrel: "prop", rock: "prop", tree: "prop", car: "prop", obstacle: "prop", decoration: "prop", cover: "prop", bush: "prop", tombstone: "prop", grave: "prop",
  bullets: "ammo", gun: "ammo", weapon: "ammo", magazine: "ammo", ammobox: "ammo", ammo_box: "ammo",
  medkit: "health", heart: "health", potion: "health", first_aid: "health", firstaid: "health", healthpack: "health", health_pack: "health",
};
const MIN = { start: 40, spawner: 40, wall: 40, prop: 30, ammo: 30, health: 30 };
const CELL = 40, N = 1000 / CELL;   // 25 x 25 cells for the reachability check
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Words that ask for an arena shooter rather than a platformer. */
export const ARENA_WORDS = /\b(shooter|shooting|shoot|fps|tps|first.?person|third.?person|over.?the.?shoulder|top.?down|overhead|bird'?s.?eye|twin.?stick|zombies?|undead|horde|hordes|waves?\s+of|survive|survival|arena|battle royale|doom|call of duty|gun|guns)\b/i;
export const PLATFORMER_WORDS = /\b(platformer|platforms?|side.?scroll\w*|jump\w*|mario|ledges?|coins?|flag)\b/i;
/** "arena" | "platformer" | null (no genre words) from a message. Shooter words win when both appear ("a platformer with zombies" = platformer though). */
export function genreWanted(text) {
  const t = String(text || "");
  const arena = ARENA_WORDS.test(t), plat = PLATFORMER_WORDS.test(t);
  if (arena && plat) return /\bplatformer\b/i.test(t) ? "platformer" : "arena";
  return arena ? "arena" : plat ? "platformer" : null;
}
export const genreOf = (level) => (level && level.genre === "arena" ? "arena" : "platformer");
/** The camera view a message asks for, or null. */
export function viewWanted(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(top.?down|overhead|bird'?s.?eye|from above|twin.?stick)\b/.test(t)) return "top";
  if (/\b(third.?person|tps|over.?the.?shoulder|behind the player|behind me)\b/.test(t)) return "tps";
  if (/\b(first.?person|fps|through (my|the player'?s) eyes)\b/.test(t)) return "fps";
  return null;
}

export function normalizeArena(input) {
  const theme = typeof input?.theme === "string" && input.theme.trim() ? input.theme.trim().slice(0, 60) : "zombie arena";
  const view = VIEWS.includes(input?.view) ? input.view : "fps";
  const waves = clamp(Math.round(num(input?.waves, 5)), 1, 20);
  const list = Array.isArray(input?.objects) ? input.objects.slice(0, 120) : [];
  const objects = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    let type = String(o.type ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
    if (!ARENA_TYPES.includes(type)) {
      // "zombie gate", "enemy spawn point", "ammo box": the whole name, then any word of it
      const words = type.split("_");
      type = SYNONYMS[type] ?? SYNONYMS[type.replace(/_/g, "")] ?? words.map((w) => (ARENA_TYPES.includes(w) ? w : SYNONYMS[w])).find(Boolean) ?? "prop";
    }
    const min = MIN[type];
    let w = Math.max(min, num(o.w, min)), h = Math.max(min, num(o.h, min));
    if (type === "start" || type === "spawner") { w = 40; h = 40; }
    if (type === "ammo" || type === "health") { w = 30; h = 30; }
    let x = clamp(num(o.x, 0), 0, 1000 - w), y = clamp(num(o.y, 0), 0, 1000 - h);
    w = Math.min(w, 1000 - x); h = Math.min(h, 1000 - y);
    objects.push({ type, label: String(o.label ?? type).slice(0, 40), x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  }
  let seenStart = false;
  for (const o of objects) { if (o.type !== "start") continue; if (seenStart) o.type = "prop"; else seenStart = true; }
  if (!seenStart) objects.unshift({ type: "start", label: "you", x: 480, y: 480, w: 40, h: 40 });
  const spawners = objects.filter((o) => o.type === "spawner");
  if (!spawners.length) objects.push({ type: "spawner", label: "enemy gate", x: 60, y: 60, w: 40, h: 40 }, { type: "spawner", label: "enemy gate", x: 900, y: 900, w: 40, h: 40 });
  while (objects.filter((o) => o.type === "spawner").length > 8) { const i = objects.map((o) => o.type).lastIndexOf("spawner"); objects[i].type = "prop"; }
  const out = { genre: "arena", view, theme, waves, objects };
  for (const k of ["checked", "fixes", "note"]) if (input?.[k] !== undefined) out[k] = input[k];
  return out;
}

// ---------------------------------------------------------------- reachability: can every enemy walk to the player?
const solid = (o) => o.type === "wall" || o.type === "prop";
function blockedGrid(level) {
  const g = new Uint8Array(N * N);
  for (const o of level.objects) {
    if (!solid(o)) continue;
    const x0 = Math.floor(o.x / CELL), y0 = Math.floor(o.y / CELL), x1 = Math.min(N - 1, Math.floor((o.x + o.w - 1) / CELL)), y1 = Math.min(N - 1, Math.floor((o.y + o.h - 1) / CELL));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y * N + x] = 1;
  }
  return g;
}
const cellOf = (o) => [clamp(Math.floor((o.x + o.w / 2) / CELL), 0, N - 1), clamp(Math.floor((o.y + o.h / 2) / CELL), 0, N - 1)];
function reachFrom(g, cx, cy) {
  const seen = new Uint8Array(N * N), q = [cy * N + cx];
  if (g[cy * N + cx]) return seen;
  seen[cy * N + cx] = 1;
  while (q.length) {
    const p = q.shift(), x = p % N, y = (p / N) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const np = ny * N + nx; if (seen[np] || g[np]) continue;
      seen[np] = 1; q.push(np);
    }
  }
  return seen;
}
/** { ok, problems: [plain words] } */
export function checkArena(level) {
  const problems = [];
  const start = level.objects.find((o) => o.type === "start");
  if (!start) return { ok: false, problems: ["there is no player start"] };
  const g = blockedGrid(level);
  const [sx, sy] = cellOf(start);
  if (g[sy * N + sx]) { problems.push(`the player start "${start.label}" is inside a wall`); return { ok: false, problems }; }
  const reach = reachFrom(g, sx, sy);
  const free = reach.reduce((a, b) => a + b, 0);
  if (free < 40) problems.push("the player is boxed in: almost no room to move");
  for (const o of level.objects) {
    if (o.type === "start" || solid(o)) continue;
    const [cx, cy] = cellOf(o);
    if (g[cy * N + cx]) problems.push(`${o.type} "${o.label}" is inside a wall`);
    else if (!reach[cy * N + cx]) problems.push(o.type === "spawner" ? `enemies from "${o.label}" cannot reach the player (walled off)` : `${o.type} "${o.label}" cannot be reached`);
  }
  if (!level.objects.some((o) => o.type === "spawner")) problems.push("there is no enemy spawner");
  return { ok: !problems.length, problems };
}
/** Move walled-off spawners and pickups to the nearest cell the player can reach; a boxed-in start loses its walls. */
export function autoFixArena(level) {
  const fixes = [];
  const lvl = { ...level, objects: level.objects.map((o) => ({ ...o })) };
  const start = lvl.objects.find((o) => o.type === "start");
  if (!start) return { level: lvl, fixes };
  let g = blockedGrid(lvl);
  let [sx, sy] = cellOf(start);
  if (g[sy * N + sx]) {   // start inside a wall: drop the walls touching it
    for (const o of lvl.objects) if (solid(o) && o.x < start.x + start.w && o.x + o.w > start.x && o.y < start.y + start.h && o.y + o.h > start.y) { o.type = "ammo"; o.w = 30; o.h = 30; fixes.push(`removed ${o.label}: it covered the player start`); }
    g = blockedGrid(lvl);
  }
  let reach = reachFrom(g, sx, sy);
  if (reach.reduce((a, b) => a + b, 0) < 40) {   // boxed in: open the nearest walls
    for (const o of lvl.objects) if (solid(o) && Math.hypot(o.x + o.w / 2 - start.x - 20, o.y + o.h / 2 - start.y - 20) < 200) { o.type = "ammo"; o.w = 30; o.h = 30; fixes.push(`removed ${o.label}: it boxed the player in`); }
    g = blockedGrid(lvl); reach = reachFrom(g, sx, sy);
  }
  const cells = []; for (let i = 0; i < N * N; i++) if (reach[i]) cells.push(i);
  for (const o of lvl.objects) {
    if (o.type === "start" || solid(o)) continue;
    const [cx, cy] = cellOf(o);
    if (reach[cy * N + cx]) continue;
    let best = null, bd = Infinity;
    for (const i of cells) { const d = Math.hypot((i % N) - cx, ((i / N) | 0) - cy); if (d < bd) { bd = d; best = i; } }
    if (best == null) continue;
    const nx = (best % N) * CELL + (CELL - o.w) / 2, ny = ((best / N) | 0) * CELL + (CELL - o.h) / 2;
    fixes.push(`moved ${o.type} "${o.label}" to open ground at x${Math.round(nx)} y${Math.round(ny)}`);
    o.x = Math.round(nx); o.y = Math.round(ny);
  }
  return { level: lvl, fixes };
}
/** Check, fix, mark. Returns { level, report: { before, after, fixes } }. */
export function playtestArena(level) {
  const before = checkArena(level);
  if (before.ok) return { level: { ...level, checked: true, fixes: [] }, report: { before, after: before, fixes: [] } };
  const { level: fixed, fixes } = autoFixArena(level);
  const after = checkArena(fixed);
  return { level: { ...fixed, checked: true, fixes }, report: { before, after, fixes } };
}

// ---------------------------------------------------------------- a whole arena from words (no AI): the safety net
const THEMES = [
  [/zombie|undead|graveyard|cemetery|dead/, "zombie graveyard", "zombie"], [/alien|space|mars|ufo|galaxy/, "alien outpost", "alien"],
  [/robot|droid|factory|mech/, "robot factory", "robot"], [/skeleton|bone|crypt|dungeon/, "haunted crypt", "skeleton"],
  [/ghost|haunt|spooky|halloween/, "haunted mansion", "ghost"], [/pirate|ship|island/, "pirate cove", "pirate"],
  [/desert|sand|dune/, "desert outpost", "raider"], [/jungle|forest|wood/, "dark forest", "beast"], [/snow|ice|frozen|arctic/, "frozen base", "yeti"],
  [/city|street|urban|rooftop/, "city streets", "thug"], [/castle|knight|medieval/, "castle courtyard", "knight"],
];
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function generateArena(text = "", seed) {
  const t = String(text || "").toLowerCase();
  let r = (seed ?? hash(t)) || 1;
  const rnd = () => { r ^= r << 13; r >>>= 0; r ^= r >> 17; r ^= r << 5; r >>>= 0; return r / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const th = THEMES.find(([re]) => re.test(t)) || [null, "zombie arena", "zombie"];
  const view = viewWanted(t) || "fps";
  const wm = /(\d+)\s*(waves?|rounds?)/.exec(t);
  const waves = clamp(wm ? Number(wm[1]) : 5, 1, 20);
  const objects = [{ type: "start", label: "you", x: 480, y: 480, w: 40, h: 40 }];
  const spots = [[40, 40], [920, 40], [40, 920], [920, 920], [480, 20], [480, 940], [20, 480], [940, 480]];
  const nSpawn = 3 + Math.floor(rnd() * 2);
  for (let i = 0; i < nSpawn; i++) { const [x, y] = spots[(i * 2 + Math.floor(rnd() * 2)) % spots.length]; const kind = i === 1 ? "runner " : i === 3 ? "brute " : ""; objects.push({ type: "spawner", label: `${kind}${th[2]} gate`, x, y, w: 40, h: 40 }); }
  const taken = (x, y, w, h) => objects.some((o) => x < o.x + o.w + 60 && x + w + 60 > o.x && y < o.y + o.h + 60 && y + h + 60 > o.y) || (x < 640 && x + w > 320 && y < 640 && y + h > 320);
  const place = (type, label, w, h, tries = 30) => {
    for (let i = 0; i < tries; i++) {
      const x = 60 + Math.floor(rnd() * (880 - w)), y = 60 + Math.floor(rnd() * (880 - h));
      if (!taken(x, y, w, h)) { objects.push({ type, label, x, y, w, h }); return true; }
    }
    return false;
  };
  const wallNames = { "zombie graveyard": ["crypt wall", "iron fence", "mausoleum"], "alien outpost": ["hull plate", "containment wall", "reactor"], "robot factory": ["conveyor", "steel wall", "press"] };
  const names = wallNames[th[1]] || ["stone wall", "barricade", "ruin"];
  const nWalls = 6 + Math.floor(rnd() * 4);
  for (let i = 0; i < nWalls; i++) { const long = 120 + Math.floor(rnd() * 180); if (rnd() < 0.5) place("wall", pick(names), long, 40); else place("wall", pick(names), 40, long); }
  const propNames = th[1] === "zombie graveyard" ? ["tombstone", "coffin", "dead tree"] : th[1] === "alien outpost" ? ["supply pod", "crystal", "crate"] : ["crate", "barrel", "rock"];
  for (let i = 0; i < 4 + Math.floor(rnd() * 3); i++) place("prop", pick(propNames), 40 + Math.floor(rnd() * 2) * 20, 40 + Math.floor(rnd() * 2) * 20);
  for (let i = 0; i < 3; i++) place("ammo", "ammo box", 30, 30);
  for (let i = 0; i < 2; i++) place("health", "medkit", 30, 30);
  const level = normalizeArena({ genre: "arena", view, theme: th[1], waves, objects });
  return playtestArena(level).level;
}

/** The kind of enemy a gate sends, from its label: runner (fast, fragile), brute (slow, tough) or walker. */
export const ENEMY_KINDS = {
  walker: { hp: 2, speed: 1, size: 1, color: [0x4d7c0f, 0x65a30d, 0x3f6212] },
  runner: { hp: 1, speed: 1.7, size: 0.8, color: [0xca8a04, 0xeab308, 0xa16207] },
  brute: { hp: 4, speed: 0.55, size: 1.35, color: [0x7f1d1d, 0x991b1b, 0x6b1a1a] },
};
export function enemyKind(label) {
  const l = String(label || "").toLowerCase();
  if (/\b(runner|fast|sprinter|quick|dog|hound|swarm)\b/.test(l)) return "runner";
  if (/\b(brute|tank|heavy|giant|boss|big|ogre|golem)\b/.test(l)) return "brute";
  return "walker";
}

/** A few words about what changed between two arenas. */
export function diffArena(a, b) {
  const count = (l) => l.objects.reduce((m, o) => ((m[o.type] = (m[o.type] || 0) + 1), m), {});
  const ca = count(a), cb = count(b), parts = [];
  for (const t of ARENA_TYPES) { const d = (cb[t] || 0) - (ca[t] || 0); if (d) parts.push(`${d > 0 ? "+" : ""}${d} ${t}${Math.abs(d) > 1 ? "s" : ""}`); }
  if (a.view !== b.view) parts.push(`view ${b.view}`);
  if (a.waves !== b.waves) parts.push(`${b.waves} waves`);
  if (a.theme !== b.theme) parts.push("new theme");
  return parts.join(", ") || "small changes";
}
