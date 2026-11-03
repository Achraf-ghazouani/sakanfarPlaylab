// lib/code.mjs — "any game from a prompt": Muse Spark writes a short plan, Muse Wonder writes the whole game as ONE HTML
// file on top of the PlayLab SDK (shared/playlab-sdk.js); the page runs it in a sandbox (shared/coderun.mjs). SERVER-SIDE ONLY.
//
// Meta Model API facts this relies on (dev.meta.ai/docs/models, checked Nov 3 2026): muse-wonder-1.0 is the strongest coding
// model on the Model API and answers on the same /v1/chat/completions endpoint as Muse Spark, with reasoning_effort and
// stream:true (chunks carry choices[0].delta.content, the last one the usage). "Muse Code" is a terminal product, not a model.
import { createHmac, timingSafeEqual } from "node:crypto";
import { complete as aiComplete, completeStream, resolveProvider, chat as aiChat } from "./ai.mjs";
import { extractJson } from "./scan-level.mjs";
import { scan as scanCode } from "../shared/codescan.mjs";
import { EXAMPLES } from "./code-examples.mjs";
export { codeKind, CODE_KINDS } from "../shared/codekinds.mjs";

export const CODE_MODEL = process.env.PLAYLAB_CODE_MODEL || "muse-wonder-1.0";
export const ENGINES = ["canvas", "phaser", "three"];
export const ENGINE_NAME = { canvas: "canvas", phaser: "Phaser 3", three: "three.js" };
export const LAYOUTS = ["dpad+jump", "dpad+2buttons", "stick+2buttons", "stick+fire", "steering+gas+brake", "tap"];
export const MAX_HTML = 200_000, MIN_HTML = 400;

// ---------------------------------------------------------------- the plan (Muse Spark 1.3, fast, free)
export const PLAN_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    title: { type: "string", description: "2-4 words" },
    genre: { type: "string", description: "e.g. racing, match-3 puzzle, tower defense" },
    engine: { type: "string", enum: ENGINES, description: "canvas for very simple 2D, phaser for 2D with physics and sprites, three for 3D" },
    goal: { type: "string", description: "one sentence: what the player tries to do" },
    controls: { type: "string", description: "one sentence: what the stick or d-pad, A and B do" },
    controller: { type: "string", enum: LAYOUTS, description: "the phone controller layout" },
    win: { type: "string" }, lose: { type: "string" },
    entities: { type: "array", items: { type: "string" }, description: "3-8 short items: the things in the game" },
    opponents: { type: "string", description: "AI opponents and how they behave, or 'none'" },
    levels: { type: "string", description: "levels, laps, waves or rounds and how they progress" },
    players: { type: "integer", description: "1 to 4 players on phones" },
    notes: { type: "string", description: "what stays simple so it runs well, or an empty string" },
  },
  required: ["title", "genre", "engine", "goal", "controls", "controller", "win", "lose", "entities", "opponents", "levels", "players", "notes"],
};
export const PLAN_BRIEF = `You are the game designer in PlayLab Studio. The person describes a game; Muse Wonder will then write it as ONE HTML file in the browser (Phaser 3 for 2D, three.js for 3D, plain canvas for very simple 2D games) on top of the PlayLab SDK, which gives unified input (keyboard, touch, up to 4 phones as controllers), pause / restart and a HUD.
Write a SHORT plan as one JSON object with exactly these fields: title (2-4 words), genre, engine ("canvas" | "phaser" | "three"), goal (one sentence), controls (one sentence: what the stick or d-pad, the A button and the B button do), controller (one of "dpad+jump", "dpad+2buttons", "stick+2buttons", "stick+fire", "steering+gas+brake", "tap"), win, lose, entities (3-8 short items), opponents (the AI opponents and how they behave, or "none"), levels (levels, laps, waves or rounds and how they progress), players (1-4), notes (what stays simple so it runs at 60 fps, or "").
Keep it buildable in one file under 40 KB with everything drawn in code: no network play, no saved progress, no files from the internet. Keep every number the person gave (laps, waves, players, opponents). Pick "three" only when the person asks for 3D or the genre needs depth (racing, flight, a dungeon crawler, sports on a field); "phaser" for 2D action and physics; "canvas" for grid and card games. Write the text fields in the language the person writes in. When the person asks for a change to an existing plan, return the whole updated plan. Answer with the JSON object only.`;

export function normalizePlan(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const s = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const engine = ENGINES.includes(p.engine) ? p.engine : (/3d|three/i.test(String(p.engine || p.dimension || "")) ? "three" : "phaser");
  const players = Math.min(4, Math.max(1, Math.round(Number(p.players) || 1)));
  return {
    title: s(p.title, 60) || "Untitled game", genre: s(p.genre, 60) || "game", engine,
    goal: s(p.goal, 300), controls: s(p.controls, 300), controller: LAYOUTS.includes(p.controller) ? p.controller : (engine === "three" ? "stick+2buttons" : "dpad+2buttons"),
    win: s(p.win, 200), lose: s(p.lose, 200), entities: (Array.isArray(p.entities) ? p.entities : []).map((e) => s(e, 80)).filter(Boolean).slice(0, 10),
    opponents: s(p.opponents, 300) || "none", levels: s(p.levels, 200), players, notes: s(p.notes, 300),
  };
}

/** The plan for a game from the person's words (or a change to the plan they were shown). Not charged. */
export async function planGame({ message, previousPlan = null, history = [] }, { provider, effort = "low", timeoutMs = 45_000, complete = aiComplete } = {}) {
  const text = String(message || "").trim().slice(0, 2000);
  const user = previousPlan ? `The plan so far:\n${JSON.stringify(normalizePlan(previousPlan))}\n\nThe person wants this change: ${text}\n\nReturn the whole updated plan.` : `The person asks for: ${text}`;
  const messages = [{ role: "system", content: PLAN_BRIEF }, ...history, { role: "user", content: user }];
  const schema = { type: "json_schema", json_schema: { name: "game_plan", schema: PLAN_SCHEMA } };
  let out;
  try { out = await complete({ provider, messages, responseFormat: schema, maxTokens: 3000, timeoutMs, reasoningEffort: effort }); }
  catch (err) { if (err.status !== 400) throw err; out = await complete({ provider, messages, maxTokens: 3000, timeoutMs, reasoningEffort: effort }); }   // a provider without structured output
  const json = extractJson(out.content);
  if (!json) throw new Error("The planner did not answer with a plan.");
  return { plan: normalizePlan(json), model: out.model, provider: out.provider, ms: out.ms, usage: out.usage };
}

/** The plan as the lines of a card in the chat. */
export function describePlan(plan) {
  const p = normalizePlan(plan);
  return [
    `${p.title} · ${p.genre} · ${ENGINE_NAME[p.engine]}${p.players > 1 ? ` · ${p.players} players` : ""}`,
    `Goal: ${p.goal}`, `Controls: ${p.controls}`, `Win: ${p.win} · Lose: ${p.lose}`,
    p.entities.length ? `In the game: ${p.entities.join(", ")}` : "", p.opponents && p.opponents !== "none" ? `Opponents: ${p.opponents}` : "",
    p.levels ? `Levels: ${p.levels}` : "", p.notes ? `Kept simple: ${p.notes}` : "",
  ].filter(Boolean);
}

// ---------------------------------------------------------------- the code (Muse Wonder 1.0, streamed, charged)
export const LIBS = `LIBRARIES (pick one per game; these are the only outside addresses the policy allows)
- plain <canvas> 2D for the simplest games (snake, pong, memory cards, quizzes, grids).
- Phaser 3.80.1 for 2D games with physics, sprites, tweens, particles:
  <script src="https://cdnjs.cloudflare.com/ajax/libs/phaser/3.80.1/phaser.min.js"></script>
  Use a fixed logical size (960 x 540) with scale { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, input: { keyboard: false } (the SDK owns the keyboard), Arcade physics, textures drawn with Graphics + generateTexture.
- three.js 0.160.0 for 3D (racing, flight, dungeons, sports fields, anything with depth): an import map
  <script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
  and <script type="module">import * as THREE from "three"</script>. Optional rigid-body physics: cannon-es 0.20.0, "cannon-es":"https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js" in the same import map.`;

export const SDK_DOCS = `THE PLAYLAB SDK (window.PlayLab, already defined before your first script runs: never load or redefine it). Use it for ALL input and game flow so the keyboard, touch screens and phones used as controllers all work:
PlayLab.input.axis(player, "x" | "y")   -> -1..1 from the arrow keys / WASD, the on-screen pad or a phone's stick / d-pad. y is -1 up, +1 down.
PlayLab.input.button(player, name)      -> true while held. Names: "A" (also jump / action / gas / select), "B" (also fire / brake / cancel).
PlayLab.input.pressed(player, name)     -> true once per press (menus, "play again", jumps).
PlayLab.input.aim(player)               -> { x, y } in -1..1: a phone's aim stick, or the mouse as a direction from the screen centre.
PlayLab.input.pointer                   -> { x, y, nx, ny, down }: the mouse / touch on the page (nx, ny in 0..1). Your own pointerdown listeners on the canvas are fine for tap and click games.
PlayLab.players()                       -> [1] or [1, 2, 3, 4]: the players present right now (player 1 is always there: the keyboard or the first phone).
PlayLab.controller({ type })            -> call it first: which controls the phones and the on-screen touch pad show:
    "dpad+jump"          a 4-way d-pad (axis x and y) and one A button labelled JUMP (platformers, snake, mazes, grid games)
    "dpad+2buttons"      a 4-way d-pad, A and B (action games, RPGs, puzzles moved with a cursor: A selects, B cancels)
    "stick+2buttons"     an analog stick (axis x and y) with A and B (top-down games, sports, flying)
    "stick+fire"         a move stick, an aim stick (input.aim) and a FIRE button that is B (twin-stick shooters)
    "steering+gas+brake" left / right steering (axis x), A labelled GAS, B labelled BRAKE (racing, driving)
    "tap"                a touch pad: the phone sends taps at a position, which reach the game as pointerdown / click events at that spot of the page (card games, match-3, tower placement, clickers)
PlayLab.onStart(fn) onPause(fn) onResume(fn) onRestart(fn) onMute(fn)   -> the host's menu and the P / R / M keys reach these.
PlayLab.paused                          -> true while paused: skip the update, keep drawing.
PlayLab.start()                         -> call it in your reset: a new round began.
PlayLab.gameOver({ win, score })        -> the round ended (the host hears it, the phones vibrate).
PlayLab.event("coin" | "hit" | "goal" | "jump" | "explode" | "win" | "lose")   -> a sound and a vibration on the host side.
PlayLab.hud.set({ score, lives, timer, laps, text }) / PlayLab.hud.clear()   -> a small HUD at the top left (timer in seconds, text is free: use it for the one-line help).
PlayLab.assets.get(role)                -> { src: data URL, kind: "image" | "model", name, width, height } or null: the person's own picture for "player", "enemy", "collectible", "background", "texture"... Always keep a drawn fallback.
PlayLab.env                             -> { touch, width, height, muted }.`;

export const RULES = `RULES OF A PLAYLAB GAME
1. It starts at once: playable within a second, a one-line help in the HUD text ("arrows to steer, A to jump"), no start screen that needs a click. The first input clears the help.
2. Every frame reads PlayLab.input (axis, button, pressed). Never addEventListener for keys. Clamp the frame delta to 50 ms.
3. Call PlayLab.controller({ type }) first, PlayLab.hud.set for score / lives / timer / laps, PlayLab.event on coins, hits, goals, wins and losses, PlayLab.gameOver({ win, score }) when the round ends, PlayLab.start() in your reset, and register PlayLab.onPause / onResume / onRestart.
4. After a game over, "A to play again" (PlayLab.input.pressed(1, "A")) resets everything, including the score and the HUD.
5. 60 fps on a laptop and a phone: a few hundred objects at most, reuse sprites and meshes, no shadows unless cheap, renderer.setPixelRatio(Math.min(devicePixelRatio, 2)), resize with the window, the canvas fills the window (html and body margin 0, overflow hidden).
6. AI opponents are simple and visible: waypoints, chasing, patrols, timers, a little randomness. Laps, waves or levels have a clear counter in the HUD and the numbers the person asked for.
7. Up to 4 players: PlayLab.players() lists who is present; give each present player their own entity and read PlayLab.input.axis(slot, ...). A 1-player game ignores the others.
8. Everything is drawn in code (canvas shapes, Phaser Graphics + generateTexture, three.js geometries and materials, procedural textures) or comes from PlayLab.assets. No picture, font, sound or model files from anywhere: the policy blocks every address outside the libraries above. Sounds, if any, are synthesised with the Web Audio API after the first input.
9. Forbidden (the policy blocks them and the code is rejected before it runs): fetch, XMLHttpRequest, WebSocket, localStorage, sessionStorage, indexedDB, cookies, eval, new Function, window.parent / top / opener, iframes, forms, window.open, navigation. Do not even mention these names in comments.
10. System fonts only (system-ui, sans-serif). Readable colours, a dark background unless the theme says otherwise. On-screen text in the language of the plan.
11. Under 40 KB in one or two <script> blocks. Clean code, no TODOs: everything the notes promise works. The whole game is in this one file.`;

export function systemPrompt() {
  return `You write complete browser games for PlayLab Studio. You answer with ONE self-contained HTML file and nothing else: no markdown fences, no words before or after it. The file starts with <!doctype html> and its second line is a comment with notes for the person:
<!-- playlab {"note":"3-8 words naming this version","built":"one or two sentences: what the game does and how to play it","missing":"what you left out or simplified, or an empty string"} -->

THE RUNTIME
The file runs inside a sandboxed iframe under a strict Content Security Policy: inline <script> and <style> are fine, data: and blob: URLs are fine, WebGL and Web Audio are fine, and scripts or modules may come ONLY from the exact addresses below.

${LIBS}

${SDK_DOCS}

${RULES}

EXAMPLES (complete games written the PlayLab way; match their structure and their use of the SDK)
--- plain canvas: snake ---
${EXAMPLES.snake}
--- Phaser 3: star catcher ---
${EXAMPLES.phaser}
--- three.js: ring flight ---
${EXAMPLES.three}`;
}

function userPrompt({ plan, prompt, previousHtml, change, assets }) {
  const roles = Object.keys(assets || {});
  const pictures = roles.length ? `\nPICTURES THE PERSON UPLOADED (PlayLab.assets.get(role) returns each as { src, kind, width, height }; use them for those roles, keep a drawn fallback): ${roles.join(", ")}` : "";
  if (previousHtml) {
    return `Change the current game.\nTHE PERSON ASKS FOR: ${change}\nTHE PLAN OF THE GAME: ${JSON.stringify(normalizePlan(plan))}${pictures}\n\nTHE CURRENT FILE:\n${previousHtml}\n\nApply the change and answer with the COMPLETE updated file: everything the person did not ask to change stays as it is. Update the playlab notes comment (note, built, missing) for this version.`;
  }
  return `Build this game.\nTHE PERSON ASKED FOR: ${prompt}\nTHE PLAN (agreed with the person): ${JSON.stringify(normalizePlan(plan))}${pictures}\n\nWrite the complete HTML file now.`;
}

/** The model's answer as { html, notes: { note, built, missing } }: fences stripped, the notes comment read. */
export function parseGameHtml(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const start = t.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) t = t.slice(start);
  const end = t.lastIndexOf("</html>");
  if (end > 0) t = t.slice(0, end + "</html>".length);
  const notes = { note: "", built: "", missing: "" };
  const m = /<!--\s*playlab\s*(\{[\s\S]*?\})\s*-->/i.exec(t);
  if (m) { const j = extractJson(m[1]); if (j) for (const k of Object.keys(notes)) notes[k] = String(j[k] ?? "").replace(/\s+/g, " ").trim().slice(0, k === "note" ? 80 : 400); }
  return { html: t, notes };
}

export function engineOf(html) {
  const h = String(html || "");
  if (/three@0\.160\.0|from\s+["']three["']/.test(h)) return "three";
  if (/phaser/i.test(h)) return "phaser";
  return "canvas";
}

/**
 * Muse Wonder writes the game (or rewrites it with a change). onProgress({ chars, lines }) fires while the code streams in.
 * Returns { html, notes, scan, engine, usage, model, ms, finishReason }; throws when the answer is not a game.
 */
export async function generateGame(job, opts = {}) {
  return runModel(userPrompt({ assets: {}, ...job }), opts);
}

/** One streamed Muse Wonder answer to a request, raw (the system prompt is the same for builds, changes and fixes). */
async function callModel(user, { provider = "meta", model = CODE_MODEL, effort = "medium", timeoutMs = 240_000, onProgress, stream = completeStream, maxTokens = 24_000 } = {}) {
  const p = { ...(typeof provider === "string" ? resolveProvider(provider) : provider), model };
  const messages = [{ role: "system", content: systemPrompt() }, { role: "user", content: user }];
  let last = 0;
  const out = await stream({
    provider: p, messages, maxTokens, timeoutMs, reasoningEffort: effort,
    onDelta: (d, all) => { const now = Date.now(); if (onProgress && now - last > 700) { last = now; onProgress({ chars: all.length, lines: (all.match(/\n/g) || []).length }); } },
  });
  return { ...out, model: p.model };
}
/** Muse Wonder answers one request (a build, or a change or a fix that could not be patched) with a whole game. */
async function runModel(user, opts = {}) {
  const out = await callModel(user, opts), p = { model: out.model };
  const { html, notes } = parseGameHtml(out.content);
  if (!/<canvas|<script/i.test(html) || html.length < MIN_HTML) throw new Error(out.finishReason === "length" ? "The model ran out of room before the game was finished." : "The model did not answer with a game.");
  if (out.finishReason === "length" && !/<\/html>\s*$/i.test(html)) throw new Error("The model ran out of room before the game was finished.");
  if (html.length > MAX_HTML) throw new Error("The game is too big to save (over 200 KB).");
  return { html, notes, scan: scanCode(html), engine: engineOf(html), usage: out.usage, model: p.model, ms: out.ms, finishReason: out.finishReason };
}

export const actionFor = (plan, edit = false) => (edit ? "code_edit" : normalizePlan(plan).engine === "three" ? "code_create_3d" : "code_create_2d");

/** A code game as a level the projects API saves: { level } or { error }. */
export function validateCodeLevel(raw) {
  const l = raw && typeof raw === "object" ? raw : {};
  if (l.genre !== "code") return { error: "Not a code game." };
  if (typeof l.html !== "string" || l.html.length < MIN_HTML) return { error: "The game code is missing." };
  if (l.html.length > MAX_HTML) return { error: "The game code is too big (over 200 KB)." };
  const scan = scanCode(l.html);
  if (!scan.ok) return { error: "The game code uses something the sandbox forbids: " + scan.problems.slice(0, 3).join("; ") };
  const s = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const plan = normalizePlan(l.plan);
  const engine = ENGINES.includes(l.engine) ? l.engine : engineOf(l.html);
  const notes = l.notes && typeof l.notes === "object" ? { note: s(l.notes.note, 80), built: s(l.notes.built, 400), missing: s(l.notes.missing, 400) } : { note: "", built: "", missing: "" };
  return { level: { genre: "code", engine, title: s(l.title, 80) || plan.title, theme: s(l.theme, 80) || plan.genre, note: s(l.note, 80) || notes.note || plan.title, prompt: s(l.prompt, 2000), plan, html: l.html, notes, objects: [] } };
}

// ---------------------------------------------------------------- the self-healing loop: free fixes tied to a paid build
// The page runs the game in the sandbox and watches it (the smoke test); a failure comes back here with a token that the
// build handed out, signed with the server key: a fix is free but only within 20 minutes of a paid build and at most
// MAX_FIXES times (each fix returns the token for the next attempt). Nothing is stored.
export const MAX_FIXES = 3, FIX_TTL_MS = 20 * 60_000;
const secret = () => process.env.PLAYLAB_SERVER_KEY || "";
const sign = (payload) => createHmac("sha256", secret()).update(payload).digest("base64url");
export function makeFixToken({ ledger = null, n = 0, project = null, ttl = FIX_TTL_MS } = {}) {
  if (!secret()) return null;
  const payload = Buffer.from(JSON.stringify({ l: ledger, n: Number(n) || 0, p: project, e: Date.now() + ttl })).toString("base64url");
  return payload + "." + sign(payload);
}
/** { ledger, n, project, exp } for a valid, unexpired token, else null. */
export function readFixToken(token) {
  if (!secret() || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = sign(payload);
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  let j; try { j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!j || typeof j.e !== "number" || j.e < Date.now()) return null;
  return { ledger: j.l ?? null, n: Number(j.n) || 0, project: j.p ?? null, exp: j.e };
}

/** The page's report of a failed run, cleaned for the model (and for the API): errors, blank, ready, responds, restart, scan, feedback. */
export function cleanReport(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const s = (v, n) => String(v ?? "").slice(0, n);
  return {
    errors: (Array.isArray(r.errors) ? r.errors : []).slice(0, 8).filter((e) => e && typeof e === "object").map((e) => ({ kind: s(e.kind, 20), message: s(e.message, 600), line: Number(e.line) || 0, col: Number(e.col) || 0, stack: s(e.stack, 1200) })),
    blank: r.blank ? s(r.blank, 120) : null,
    ready: typeof r.ready === "boolean" ? r.ready : null, responds: typeof r.responds === "boolean" ? r.responds : null, restart: typeof r.restart === "boolean" ? r.restart : null,
    scan: r.scan && typeof r.scan === "object" ? { ok: !!r.scan.ok, problems: (Array.isArray(r.scan.problems) ? r.scan.problems : []).slice(0, 8).map((p) => s(p, 200)) } : null,
    feedback: r.feedback ? s(r.feedback, 800) : "",
  };
}
/** The report as lines for the model. */
export function describeFailure(raw) {
  const r = cleanReport(raw), lines = [];
  for (const e of r.errors) lines.push(`- ${e.kind || "error"}: ${e.message}${e.line ? ` (line ${e.line}${e.col ? ":" + e.col : ""} of the file)` : ""}${e.stack ? "\n  " + e.stack.split("\n").slice(0, 3).join("\n  ") : ""}`);
  if (r.blank) lines.push(`- the canvas stayed blank: ${r.blank}`);
  if (r.ready === false && !r.errors.length) lines.push("- no frame was drawn within 12 seconds (no requestAnimationFrame loop, or the code stopped before drawing)");
  if (r.responds === false) lines.push("- the screen did not change after one second of holding right on the d-pad and the stick, the A button and a tap in the middle: the game must read PlayLab.input every frame and react at once");
  if (r.restart === false) lines.push("- a restart from the host's menu did not bring the game back to playing: register PlayLab.onRestart and call PlayLab.start() in the reset");
  if (r.scan && !r.scan.ok) lines.push(`- the code scan refused it: ${r.scan.problems.join("; ")}`);
  if (r.feedback) lines.push(`- a look at a screenshot after a few seconds of play: ${r.feedback}`);
  return lines;
}
/** Muse Wonder fixes a game that failed in the sandbox: the whole corrected file comes back, the same way as generateGame. */
export async function repairGame({ plan, prompt = "", html, report = {} }, opts = {}) {
  const lines = describeFailure(report);
  const what = `THE PERSON ASKED FOR: ${prompt}\nTHE PLAN: ${JSON.stringify(normalizePlan(plan))}\nWHAT WENT WRONG:\n${lines.join("\n") || "- it did not run"}`;
  const user = `The game below failed in the sandbox. Fix every problem below and answer with the COMPLETE corrected file: keep everything that works, change only what the problems need, update the playlab notes comment.\n${what}\n\nTHE FILE:\n${html}`;
  if (opts.patch === false) return runModel(user, opts);
  return patchOrRewrite({ html, request: `The game below failed in the sandbox. Fix every problem listed.\n${what}`, rewrite: user }, opts);
}

// ---------------------------------------------------------------- the vision check (Muse Spark looks at a screenshot)
export const LOOK_BRIEF = `You check games for PlayLab Studio. You get what the person asked for, the plan, and a screenshot of the running game a few seconds after it started (nothing pressed yet, or a direction held for a second). Judge whether the screen shows that game: the right kind of scene and elements, something to play, a readable HUD or help line, nothing broken (a black or empty screen, overlapping text, error text, a tiny unreadable scene).
Answer with ONE JSON object only: {"match": 0.0-1.0, "looks_like": "one sentence: what the screen shows", "problems": ["short items"], "suggestion": "one concrete improvement the code could make, or an empty string"}. match 0.8 or more = clearly that game; 0.5 = partly; below 0.5 = not that game, or broken. Write the sentences in the language of the plan.`;
export async function lookAtGame({ plan, prompt = "", snapshot }, { provider, timeoutMs = 40_000, chatFn = aiChat } = {}) {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(snapshot || ""));
  if (!m) throw new Error("A screenshot is required.");
  const out = await chatFn({ provider, system: LOOK_BRIEF, prompt: `THE PERSON ASKED FOR: ${prompt}\nTHE PLAN: ${JSON.stringify(normalizePlan(plan))}\nHere is the screenshot.`, imageBase64: m[2], mime: m[1], maxTokens: 1500, timeoutMs, reasoningEffort: "low" });
  const j = extractJson(out.text) || {};
  return {
    match: Math.max(0, Math.min(1, Number(j.match) || 0)), looksLike: String(j.looks_like || "").replace(/\s+/g, " ").trim().slice(0, 300),
    problems: (Array.isArray(j.problems) ? j.problems : []).map((p) => String(p).slice(0, 160)).slice(0, 6), suggestion: String(j.suggestion || "").replace(/\s+/g, " ").trim().slice(0, 300),
    model: out.model, ms: out.ms,
  };
}

// ---------------------------------------------------------------- changes and fixes as patches (step 5)
// A change or a fix rarely touches more than a few lines, so Muse Wonder answers with search / replace blocks instead of the
// whole file: much faster, nothing else in the game moves. Each SEARCH must match the current file exactly once (exactly,
// or line by line ignoring indentation and trailing spaces). When a block does not fit, or the patched file fails the scan,
// the same request is made again for the whole file, under the same charge, and the result says which way it went.
export const PATCH_RULES = `ANSWER WITH PATCHES, NOT THE WHOLE FILE. Write one or more blocks exactly like this:
<<<<<<< SEARCH
lines copied EXACTLY from the current file (enough of them to be unique, usually 2 to 8)
=======
the new lines that replace them
>>>>>>> REPLACE
Rules: every SEARCH appears exactly once in the current file; copy it character for character; to add code, SEARCH a nearby line and REPLACE it with that line plus the new code; to delete, leave REPLACE empty; blocks apply in order and must not overlap; keep the playlab SDK rules. After the blocks write one line:
NOTES {"note":"3-8 words naming this version","built":"one or two sentences: what the game does now and how to play it","missing":"what you left out, or an empty string"}
Nothing else: no explanations, no fences.`;

/** { patches: [{ search, replace }], notes } from a patch answer. */
export function parsePatches(text) {
  const s = String(text || "").replace(/\r\n/g, "\n"), patches = [];
  const re = /<{5,9} ?SEARCH[^\n]*\n([\s\S]*?)\n?={5,9}[^\n]*\n([\s\S]*?)\n?>{5,9} ?REPLACE[^\n]*/g;
  for (const m of s.matchAll(re)) patches.push({ search: m[1], replace: m[2] });
  const notes = { note: "", built: "", missing: "" };
  const n = /NOTES\s*(\{[\s\S]*?\})\s*$/m.exec(s) || /<!--\s*playlab\s*(\{[\s\S]*?\})\s*-->/i.exec(s);
  if (n) { const j = extractJson(n[1]); if (j) for (const k of Object.keys(notes)) notes[k] = String(j[k] ?? "").replace(/\s+/g, " ").trim().slice(0, k === "note" ? 80 : 400); }
  return { patches, notes };
}

/** Where a SEARCH sits in the file: [start, end] character offsets, or a reason why it does not fit. */
function locate(html, search, replace = "") {
  if (!search.trim()) return { error: "an empty SEARCH" };
  const first = html.indexOf(search);
  if (first >= 0) {
    if (html.indexOf(search, first + 1) >= 0) return { error: "the SEARCH appears more than once" };
    // a SEARCH copied without its indentation, replaced by indented lines: take the indentation in too (no doubled spaces)
    const lineStart = html.lastIndexOf("\n", first - 1) + 1, lead = html.slice(lineStart, first);
    const start = lead && !lead.trim() && !/^\s/.test(search) && /^\s/.test(replace) ? lineStart : first;
    return { at: [start, first + search.length] };
  }
  // line by line, ignoring indentation and trailing spaces
  const lines = html.split("\n"), want = search.split("\n").map((l) => l.trim());
  while (want.length && !want[0]) want.shift();
  while (want.length && !want[want.length - 1]) want.pop();
  if (!want.length) return { error: "an empty SEARCH" };
  const starts = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) if (lines[i + k].trim() !== want[k]) { ok = false; break; }
    if (ok) starts.push(i);
  }
  if (starts.length !== 1) return { error: starts.length ? "the SEARCH appears more than once" : "the SEARCH is not in the file" };
  const offset = (i) => lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  const a = offset(starts[0]), b = offset(starts[0] + want.length) - 1;
  return { at: [a, b] };
}
/** Applies the patches in order: { html, applied, failed: [{ i, error, search }] }. Nothing changes when one fails. */
export function applyPatches(html, patches) {
  let out = String(html || "").replace(/\r\n/g, "\n");
  const failed = [];
  (patches || []).forEach((p, i) => {
    const where = locate(out, p.search, p.replace);
    if (where.error) { failed.push({ i, error: where.error, search: p.search.split("\n").slice(0, 3).join("\n").slice(0, 200) }); return; }
    out = out.slice(0, where.at[0]) + p.replace + out.slice(where.at[1]);
  });
  return failed.length ? { html: String(html), applied: 0, failed } : { html: out, applied: (patches || []).length, failed };
}

/** Lines added and removed between two versions of a file (by content, enough for "+12 -3 lines"). */
export function lineDiff(before, after) {
  const count = (s) => { const m = new Map(); for (const l of String(s || "").split("\n")) { const k = l.trim(); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; };
  const a = count(before), b = count(after);
  let added = 0, removed = 0;
  for (const [k, n] of b) added += Math.max(0, n - (a.get(k) || 0));
  for (const [k, n] of a) removed += Math.max(0, n - (b.get(k) || 0));
  return { added, removed };
}

/**
 * A change or a fix: patches first, the whole file if they do not fit. Returns what generateGame returns plus
 * patch: { mode: "patch" | "rewrite", count, why?, added, removed }.
 */
async function patchOrRewrite({ html, request, rewrite }, opts = {}) {
  let why = "";
  try {
    const out = await callModel(`${request}\n\n${PATCH_RULES}\n\nTHE CURRENT FILE:\n${html}`, { ...opts, maxTokens: 12_000 });
    const { patches, notes } = parsePatches(out.content);
    if (!patches.length) why = "the answer had no patch blocks";
    else {
      const res = applyPatches(html, patches);
      if (res.failed.length) why = `patch ${res.failed[0].i + 1} of ${patches.length} did not fit (${res.failed[0].error})`;
      else if (res.html === html.replace(/\r\n/g, "\n")) why = "the patches changed nothing";
      else {
        const scan = scanCode(res.html);
        if (!scan.ok) why = "the patched file uses " + scan.problems[0];
        else if (res.html.length > MAX_HTML) why = "the patched file is over 200 KB";
        else return { html: res.html, notes, scan, engine: engineOf(res.html), usage: out.usage, model: out.model, ms: out.ms, finishReason: out.finishReason, patch: { mode: "patch", count: patches.length, ...lineDiff(html, res.html) } };
      }
    }
  } catch (err) { if (err.status || /request failed|stream broke/.test(err.message)) throw err; why = err.message; }   // the service itself failing is not a reason to rewrite
  if (opts.onProgress) opts.onProgress({ chars: 0, lines: 0, rewrite: true, why });
  const full = await runModel(rewrite, opts);
  return { ...full, patch: { mode: "rewrite", count: 0, why, ...lineDiff(html, full.html) } };
}

/** A change the person asked for, on the current file: patches, or the whole file when they do not fit. */
export async function changeGame({ plan, prompt = "", html, change, assets = {} }, opts = {}) {
  const roles = Object.keys(assets || {});
  const request = `Change the current game.\nTHE PERSON ASKS FOR: ${change}\nTHE PLAN OF THE GAME: ${JSON.stringify(normalizePlan(plan))}${roles.length ? `\nPICTURES THE PERSON UPLOADED (PlayLab.assets.get(role)): ${roles.join(", ")}` : ""}\nChange only what this needs; everything else stays exactly as it is.`;
  return patchOrRewrite({ html, request, rewrite: userPrompt({ plan, prompt, previousHtml: html, change, assets }) }, opts);
}
