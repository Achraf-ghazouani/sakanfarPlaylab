// lib/agent.mjs — the PlayLab Studio game agent: Muse Spark designs and edits levels through function tools.
// SERVER-SIDE ONLY (reads keys through lib/ai.mjs).
//
// Meta Model API facts this relies on (dev.meta.ai/docs/tool-calling, checked Oct 31 2026):
//   - POST https://api.meta.ai/v1/chat/completions, tools in the OpenAI shape ({type:"function", function:{name, description, parameters}})
//   - tool_choice: only "auto" is accepted ("none", "required" and named functions return HTTP 400)
//   - parallel_tool_calls:false limits the model to one call per turn
//   - the reply carries message.tool_calls[].function.arguments as a JSON string that must be validated by the caller
//   - reasoning_effort: minimal | low | medium | high | xhigh | max ("none" is rejected, Muse Spark always reasons)
// Muse Spark Open on Baseten is the fallback; it gets the same brief but answers with a JSON object instead of a tool call.

import { complete as aiComplete, defaultProviderName, isConfigured } from "./ai.mjs";
import { normalizeLevel, extractJson, TYPES } from "./scan-level.mjs";
import { playtestAndFix } from "./fix-level.mjs";
import { diffLevels } from "../shared/diff.mjs";
import { GAME_KNOWLEDGE } from "./game-knowledge.mjs";
import { ARENA_TYPES, ARENA_WORDS, VIEWS, normalizeArena, playtestArena, generateArena, diffArena, genreWanted, genreOf, viewWanted } from "../shared/arena.mjs";
import { codeKind, CODE_KINDS } from "../shared/codekinds.mjs";

const OBJECT_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: TYPES },
    label: { type: "string", description: "1-3 words that fit the theme, e.g. 'lava rock'" },
    x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
  },
  required: ["type", "label", "x", "y", "w", "h"],
};
const LEVEL_PARAMS = {
  type: "object",
  properties: {
    theme: { type: "string", description: "2-5 words describing the world, e.g. 'lava castle'" },
    note: { type: "string", description: "3-8 words naming this version, e.g. 'lava castle, 3 ledges' or 'harder: two more spikes'" },
    objects: { type: "array", items: OBJECT_SCHEMA, description: "The FULL list of objects of the level" },
  },
  required: ["theme", "note", "objects"],
};

const ARENA_OBJECT_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ARENA_TYPES },
    label: { type: "string", description: "1-3 words that fit the theme, e.g. 'crypt wall', 'zombie gate', 'medkit'" },
    x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
  },
  required: ["type", "label", "x", "y", "w", "h"],
};
const ARENA_PARAMS = {
  type: "object",
  properties: {
    view: { type: "string", enum: VIEWS, description: "fps = first person, tps = third person (camera behind the player), top = top-down" },
    theme: { type: "string", description: "2-5 words describing the place, e.g. 'zombie graveyard'" },
    note: { type: "string", description: "3-8 words naming this version, e.g. 'graveyard, 5 waves' or 'harder: 8 waves, 2 more gates'" },
    waves: { type: "integer", description: "how many waves of enemies to survive, 1-20" },
    objects: { type: "array", items: ARENA_OBJECT_SCHEMA, description: "The FULL list of objects of the arena" },
  },
  required: ["view", "theme", "note", "waves", "objects"],
};

export const TOOLS = [
  { type: "function", function: { name: "create_level", description: "Build a brand new 2D PLATFORMER level (run, jump, coins, reach the flag) from the description. Replaces the current game.", parameters: LEVEL_PARAMS } },
  { type: "function", function: { name: "edit_level", description: "Change the current 2D platformer level. Return the FULL updated object list: keep everything the person did not ask to change, with the same coordinates and labels.", parameters: LEVEL_PARAMS } },
  { type: "function", function: { name: "create_arena", description: "Build a brand new 3D ARENA SHOOTER (first person, third person or top-down: the player shoots waves of enemies that walk toward them) from the description. Use it for shooters, FPS/TPS, zombies, hordes, waves, survival. Replaces the current game.", parameters: ARENA_PARAMS } },
  { type: "function", function: { name: "edit_arena", description: "Change the current 3D arena shooter. Return the FULL updated object list: keep everything the person did not ask to change.", parameters: ARENA_PARAMS } },
  { type: "function", function: { name: "playtest_level", description: "Run the playtest agent on the current game: a platformer is checked for unreachable platforms, coins and goal; an arena for walled-off spawners and pickups. Repairs what it finds.", parameters: { type: "object", properties: {} } } },
];

export const BRIEF = `You are the game designer inside PlayLab Studio. People chat with you to build and change a game that appears live next to the chat. Be playful, concrete and short.
Answer in the language the person writes in (French in, French out; Arabic in, Arabic out; English otherwise). The level JSON, object types and labels stay in English.
Your tools make exactly two kinds of games: 2D platformers and 3D arena shooters. Every other kind (a racing or driving game, a puzzle, cards, a board game, sports, strategy, an RPG, a rhythm or fighting game, snake, a runner...) is written as code by the custom game builder (Muse Wonder) instead. If the person asks for one of those, do NOT build anything and never dress a shooter or a platformer up as that game: say in one sentence that the AI code builder makes that kind (the "AI code" switch next to the 2D / 3D buttons turns it on) and stop.

TWO KINDS OF GAME. Read the words and pick the kind the person asks for; never turn one into the other:
- A 2D PLATFORMER (create_level / edit_level): running, jumping, platforms, coins, a flag to reach, Mario-like, side-scroller, or a drawing of a level.
- A 3D ARENA SHOOTER (create_arena / edit_arena): shooter, FPS, first person, third person, top-down, guns, zombies, aliens, hordes, waves of enemies, survive. The player stands in an arena and shoots enemies that come from spawners in waves. "First person shooter with zombie waves" is an ARENA with view fps: never a platformer.
When a game already exists, edit THAT kind unless the person clearly asks for the other kind.

PLATFORMER FORMAT: a 1000 x 1000 grid, y goes DOWN, (0,0) is the top-left corner. Each object is {type, label, x, y, w, h}: x,y is the top-left corner of its box, w,h its size. Types:
- start (exactly one): where the player appears, standing on a platform near the left edge. w 40, h 60.
- goal (at least one): the exit, standing on a platform near the right edge. w 40, h 60.
- platform: solid ground. The player stands on top and can jump up through it from below. Ground: h 40-60, full width (x 0, w 1000, y 900-950). Ledges: h 20-40, w 80-400.
- moving_platform: slides left and right by about 150 units each way. Use it to cross wide gaps. w 120-200, h 25-35.
- coin: collectible. w 30, h 30, floating 40-150 above a platform.
- enemy: walks back and forth on its platform, hurts on touch, can be stomped. w 40, h 50, standing on a platform. At most one per ledge.
- spike: static hazard. w 40-200, h 30, standing on a platform or at the bottom of a gap. Never under the start or the goal.
- decoration: background only (sun, trees, clouds high in the sky), no gameplay.

PHYSICS (the player is 36 wide, 54 tall): max jump height 240 from feet to the top of the next ledge; max horizontal jump about 280 between ledge edges at the same height, less when jumping up. Keep each step up under 200 and each gap under 240, otherwise add a stepping ledge or a moving platform. Things standing on a platform have y + h equal to the platform's y.

PLATFORMER DESIGN: left to right. 6 to 25 objects. Usually one ground platform plus 2-6 ledges; for harder levels, islands with gaps, more enemies and spikes, fewer safe ledges, still within the physics limits. Spread 2-8 coins along the path. Give every object a short label that fits the theme.

ARENA FORMAT: a top-down map on a 1000 x 1000 grid, x goes right, y goes DOWN (south). Each object is {type, label, x, y, w, h}: x,y is the top-left corner of its footprint. The whole grid is fenced in by the engine. Types:
- start (exactly one): where the player stands, usually near the middle. w 40, h 40.
- spawner (2-6): where enemies come from, spread around the edges, at least 250 away from the start. w 40, h 40. The label picks the enemy kind: "runner gate" (fast, 1 hit), "brute gate" (slow, 4 hits), anything else = walker (2 hits).
- wall: solid and tall. Thickness 40-60, length 100-400. Leave corridors at least 80 wide. Never box in the start or a spawner: every spawner must be able to walk to the player.
- prop: solid, low cover (crate, barrel, rock, tombstone, dead tree). 40-80 square, 3-8 of them, some near the middle.
- ammo (2-4) and health (1-3): pickups, w 30, h 30, on open ground.
Also: view ("fps" first person, "tps" third person, "top" top-down: use what the person says, default fps), waves (how many waves to survive: 3-10, "endless" or "many" = 15, "short" = 3), theme (2-5 words). Waves grow by themselves (wave n has 3 + 2n enemies).

ARENA DESIGN: 12 to 35 objects, walls that make lanes and cover, not a maze. Labels that fit the theme (crypt wall, zombie gate, medkit). "Make it harder": more waves and spawners, less cover and health. "Add more cover": more props and walls near the middle.

TOOLS: call create_level (platformer) or create_arena (shooter) for a new game or when the person describes a whole game. Call edit_level / edit_arena to change the current game: keep everything they did not ask to change (same coordinates and labels) and return the FULL updated list. Call playtest_level when they ask to test or check the game. Alongside a tool call, answer with one or two friendly sentences saying what you built or changed. "Make it harder": more enemies and spikes, longer gaps within the limits. "Add more coins": add 3-5 coins on the path. "Change theme" without a theme given: pick a fun new one and rename the theme and the labels; keep the layout. Questions or chit-chat: answer in text only, no tool.`;

const JSON_PROTOCOL = `You cannot call tools here. Instead reply with ONE JSON object and nothing else:
{"tool":"create_level"|"edit_level"|"create_arena"|"edit_arena"|"playtest_level"|"none","reply":"one or two sentences for the person","theme":"...","note":"3-8 words naming this version","view":"fps|tps|top (arena only)","waves":5,"objects":[{"type":"platform","label":"ground","x":0,"y":920,"w":1000,"h":50}, ...]}
Use "tool":"none" with only "reply" for answers that change nothing.`;

/** A message that only asks to switch between the 2D and the 3D view ("make it 3D", "switch to 2d"): "3d" | "2d" | null. */
export function viewSwitch(text) {
  const t = String(text || "").trim().toLowerCase();
  if (t.length > 40 || !/\b(2d|3d|three.?d|two.?d)\b/.test(t)) return null;
  if (!/^(please\s+)?(make|turn|switch|change|put|play|show|go|view|see|let'?s|i want|in)\b/.test(t) && !/^(2d|3d)[\s.!]*$/.test(t)) return null;
  return /\b(3d|three.?d)\b/.test(t) ? "3d" : "2d";
}

/** Short answers that need no model call: empty input, pictures, a view switch, things handled elsewhere. */
/** Kinds of game the engines cannot make (shared/codekinds.mjs): the code builder writes those. Exported for tests. */
export const OTHER_KINDS = CODE_KINDS;
/** "a racing game" when the words ask for a kind the engines do not have, else null. A shooter or platformer request with those words passes. */
export const unsupportedKind = codeKind;
/** The honest answer for a kind the engines do not have: nothing built here and nothing charged; the Studio runs the code builder (a free plan first). */
function otherKindReply(kind, text) {
  return {
    reply: `${kind[0].toUpperCase() + kind.slice(1)} is not one of the two built-in kinds (2D platformers, 3D arena shooters), so Muse Wonder will write it as code instead. First a short plan for you to check. Nothing was charged yet.`,
    actions: [{ type: "code", prompt: text, kind }], unsupported: kind,
  };
}

export function quickReply(text, hasLevel, attachments = [], level = null) {
  const hasImage = attachments.some((a) => a && String(a.type || "").startsWith("image/"));
  if (hasImage) return { reply: "Got your picture. I am reading it as a level now.", actions: [{ type: "scan" }] };
  const t = String(text || "").trim();
  if (!t) return { reply: "Tell me what to build, or attach a drawing.", actions: [] };
  const other = unsupportedKind(t);
  if (other) return otherKindReply(other, t);   // a racing game, a puzzle...: say so, build nothing, charge nothing
  const lower = t.toLowerCase();
  if (genreOf(level) === "arena") {
    const v = viewWanted(t);
    if (v && t.length < 60 && /^(please\s+)?(make|turn|switch|change|put|play|show|go|view|see|let'?s|i want|in|use|try|from|camera)\b/.test(lower)) {
      return { reply: { fps: "First person: you look through the player's eyes. Click the game to aim, Esc frees the mouse.", tps: "Third person: the camera follows behind the player.", top: "Top-down: you see the whole fight from above and aim with the mouse." }[v], actions: [{ type: "view", view: v }] };
    }
    if (viewSwitch(t) === "2d") return { reply: "Arena shooters are 3D games. Try first person, third person or top-down instead.", actions: [] };
    if (viewSwitch(t) === "3d") return { reply: "This arena is already 3D. Say first person, third person or top-down to change the camera.", actions: [] };
  }
  const view = viewSwitch(t);
  if (view) return { reply: view === "3d" ? "Switched to the 3D view: same level, same controls, now with depth. Use the 2D / 3D toggle to switch back." : "Back to the 2D view.", actions: [{ type: "mode", mode: view }] };
  if (/^generate art$/.test(lower) || /\b(generate|make|create|draw)\b.*\b(art|sprites?|graphics|skins?|ui kit|textures?)\b/.test(lower)) return { reply: "Attach a picture of a character or an object and Muse Image draws it as a game sprite: a character becomes the player, an object becomes every enemy, coin or flag.", actions: [] };
  if (/^share$/.test(lower) || /\bshare (it|this|the (game|level)|a link)\b/.test(lower)) return { reply: "Share links arrive in a later step. For now, use the Share button in the top bar once it is enabled.", actions: [] };
  return null;
}

/** The system prompt for this turn: the brief plus the current level. */
export function systemPrompt(level, { json = false } = {}) {
  const state = level?.objects?.length
    ? (genreOf(level) === "arena"
      ? `CURRENT GAME: a 3D ARENA SHOOTER (edit it with edit_arena). JSON: ${JSON.stringify({ view: level.view, waves: level.waves, theme: level.theme, objects: level.objects.map(({ type, label, x, y, w, h }) => ({ type, label, x, y, w, h })) })}`
      : `CURRENT GAME: a 2D PLATFORMER (edit it with edit_level). JSON: ${JSON.stringify({ theme: level.theme, objects: level.objects.map(({ type, label, x, y, w, h }) => ({ type, label, x, y, w, h })) })}`)
    : "There is no game yet: the first thing to do is create one (create_level for a platformer, create_arena for a shooter).";
  return `${BRIEF}\n\n${GAME_KNOWLEDGE}\n\n${state}${json ? `\n\n${JSON_PROTOCOL}` : ""}`;
}

/** Last turns of the chat, user and assistant only, trimmed. */
export function cleanHistory(history, max = 12) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-max)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 600) }));
}

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  const s = String(raw ?? "");
  try { return JSON.parse(s); } catch { return extractJson(s); }
}

const KIND = { create_level: "create", edit_level: "edit", create_arena: "create", edit_arena: "edit", playtest_level: "playtest" };
const GENRE = { create_arena: "arena", edit_arena: "arena" };

/** Meta: real function tools. */
async function decideWithTools(complete, messages, { timeoutMs, effort }) {
  const r = await complete({ provider: "meta", messages, tools: TOOLS, parallelToolCalls: false, maxTokens: 8000, timeoutMs, reasoningEffort: effort });
  const call = r.toolCalls[0];
  const name = call?.function?.name;
  const kind = call ? KIND[name] || "reply" : "reply";
  return { kind, genre: GENRE[name] || "platformer", args: call && kind !== "reply" ? parseArgs(call.function.arguments) : null, text: r.content, model: r.model, ms: r.ms, usage: r.usage };
}

/** Baseten (Muse Spark Open): same brief, JSON answer instead of a tool call. */
async function decideWithJson(complete, messages, { timeoutMs }) {
  const r = await complete({ provider: "baseten", messages, maxTokens: 8000, timeoutMs });
  const obj = extractJson(r.content);
  if (!obj) return { kind: "reply", args: null, text: r.content, model: r.model, ms: r.ms, usage: r.usage };
  const kind = KIND[obj.tool] || "reply";
  return { kind, genre: GENRE[obj.tool] || "platformer", args: kind === "reply" ? null : obj, text: typeof obj.reply === "string" ? obj.reply : "", model: r.model, ms: r.ms, usage: r.usage };
}

/** Turn the model's decision into a validated, playable result for the page. */
export async function applyDecision(decision, previous, message = "") {
  const hasLevel = !!(previous && Array.isArray(previous.objects) && previous.objects.length);
  const prevGenre = hasLevel ? genreOf(previous) : null;
  const text = String(decision.text || "").trim();
  if (decision.kind === "playtest") {
    if (!hasLevel) return { reply: "There is no game yet. Describe one, or attach a drawing, and I will playtest it.", actions: [] };
    if (prevGenre === "arena") {
      const { level, report } = playtestArena(previous);
      if (report.before.ok) return { reply: text || "All good: every enemy gate and pickup can reach the player.", actions: [], playtest: { ok: true, fixed: 0, fixes: [] } };
      return { reply: `I found ${report.before.problems.length} problem${report.before.problems.length > 1 ? "s" : ""} (${report.before.problems.join("; ")}) and fixed ${report.before.problems.length > 1 ? "them" : "it"}.`, level, kind: "edit", note: "playtest fix", diff: report.fixes.join(" · "), playtest: { ok: report.after.ok, fixed: report.before.problems.length, fixes: report.fixes }, actions: [] };
    }
    return { reply: text || "Running the playtest agent: checking every jump and fixing what is impossible.", actions: [{ type: "playtest" }] };
  }
  if (decision.kind !== "create" && decision.kind !== "edit") return { reply: text || "...", actions: [] };

  // Genre guard: a shooter request never becomes a platformer. If the model picked the wrong kind, the arena is
  // generated from the words instead (and the other way round: an arena edit on a platformer is a new arena).
  const wanted = genreWanted(message);
  let genre = decision.genre || "platformer";
  if (wanted === "arena" && genre !== "arena") {
    const level = generateArena(message);
    return { reply: `${text ? text.replace(/\b(2D|platformer|side.?scroller|survivor run)\b[^.!]*[.!]?/gi, "").trim() + " " : ""}Here is your ${level.view === "top" ? "top-down" : level.view === "tps" ? "third-person" : "first-person"} shooter: ${level.theme}, ${level.waves} waves. Click the game to aim, shoot with the mouse.`.trim(), level, kind: "create", note: `${level.theme}, ${level.waves} waves`, diff: null, playtest: { ok: true, fixed: 0, fixes: level.fixes || [] }, actions: [], guard: "arena" };
  }
  if (genre === "arena") return applyArena(decision, previous, prevGenre === "arena" ? previous : null, text);
  if (prevGenre === "arena" && decision.kind === "edit" && wanted !== "platformer") {
    return { reply: "I could not change the arena that way. Try saying it differently (more waves, more cover, another view...).", actions: [], error: "platformer edit on an arena" };
  }

  const a = decision.args;
  if (!a || !Array.isArray(a.objects) || a.objects.length < 3) {
    return { reply: `${text ? text + " " : ""}I could not put that level together. Can you say it differently?`, actions: [], error: "bad tool arguments" };
  }
  const kind = decision.kind === "edit" && !hasLevel ? "create" : decision.kind;
  const aspect = (kind === "edit" && previous?.aspect) || 4 / 3;
  let level = normalizeLevel({ theme: a.theme || previous?.theme, objects: a.objects }, { aspect });
  const fixed = await playtestAndFix(level, { useAI: false });     // instant algorithmic repair; the AI repair stays behind "Playtest it"
  level = fixed.level;
  const before = fixed.report.before;
  const patched = before.ok ? 0 : before.problems.length;
  const diff = kind === "edit" ? diffLevels(previous, level) : null;
  const note = String(a.note || (kind === "create" ? "new level" : "edited")).trim().slice(0, 60);
  let reply = text || (kind === "create" ? `Built "${level.theme}" with ${level.objects.length} objects.` : `Done: ${note}.`);
  if (patched) reply += ` The playtest found ${patched} impossible spot${patched > 1 ? "s" : ""} and I patched ${patched > 1 ? "them" : "it"}.`;
  return { reply, level, kind, note, diff: diff?.short || null, playtest: { ok: before.ok, fixed: patched, fixes: fixed.report.fixes || [] }, actions: [] };
}

/** An arena create / edit from the model: normalize, fix walled-off spawners, describe. */
function applyArena(decision, previous, prevArena, text) {
  const a = decision.args;
  if (!a || !Array.isArray(a.objects) || a.objects.length < 3) {
    return { reply: `${text ? text + " " : ""}I could not put that arena together. Can you say it differently?`, actions: [], error: "bad tool arguments" };
  }
  const kind = decision.kind === "edit" && !prevArena ? "create" : decision.kind;
  const base = { genre: "arena", view: a.view || prevArena?.view, waves: a.waves ?? prevArena?.waves, theme: a.theme || prevArena?.theme, objects: a.objects };
  const { level, report } = playtestArena(normalizeArena(base));
  const patched = report.before.ok ? 0 : report.before.problems.length;
  const note = String(a.note || (kind === "create" ? "new arena" : "edited")).trim().slice(0, 60);
  let reply = text || (kind === "create" ? `Built "${level.theme}": a ${level.view === "top" ? "top-down" : level.view === "tps" ? "third-person" : "first-person"} shooter with ${level.waves} waves.` : `Done: ${note}.`);
  if (patched) reply += ` The playtest found ${patched} walled-off spot${patched > 1 ? "s" : ""} and I patched ${patched > 1 ? "them" : "it"}.`;
  return { reply, level, kind, note, diff: kind === "edit" ? diffArena(prevArena, level) : null, playtest: { ok: report.after.ok, fixed: patched, fixes: report.fixes }, actions: [] };
}

/**
 * One agent turn.
 * @param {{message?: string, level?: object|null, history?: Array<{role: string, content: string}>, attachments?: object[]}} input
 * @param {{complete?: Function, provider?: string, timeoutMs?: number, effort?: string}} [opts]  complete is injectable for tests
 * @returns {Promise<{reply: string, actions: object[], level?: object, kind?: string, note?: string, diff?: string|null, playtest?: object, meta?: object}>}
 */
export async function runAgent({ message = "", level = null, history = [], attachments = [] } = {}, { complete = aiComplete, provider, timeoutMs = 50_000, effort = process.env.PLAYLAB_AGENT_EFFORT || "low" } = {}) {
  const text = String(message || "").trim().slice(0, 2000);
  const hasLevel = !!(level && Array.isArray(level.objects) && level.objects.length);
  const quick = quickReply(text, hasLevel, attachments, level);
  if (quick) return quick;

  const primary = (provider || defaultProviderName()).toLowerCase();
  const order = [primary];
  for (const other of ["meta", "baseten"]) if (other !== primary && isConfigured(other)) order.push(other);

  let lastErr;
  for (const name of order) {
    try {
      const messages = [{ role: "system", content: systemPrompt(level, { json: name !== "meta" }) }, ...cleanHistory(history), { role: "user", content: text }];
      const decision = name === "meta" ? await decideWithTools(complete, messages, { timeoutMs, effort }) : await decideWithJson(complete, messages, { timeoutMs });
      const out = await applyDecision(decision, level, text);
      out.meta = { provider: name, model: decision.model, ms: decision.ms, usage: decision.usage, fallback: name !== primary };
      return out;
    } catch (err) {
      lastErr = err;
      if (name !== order[order.length - 1]) console.warn(`agent: ${name} failed (${String(err.message).slice(0, 120)}), trying next provider...`);
    }
  }
  throw lastErr;
}
