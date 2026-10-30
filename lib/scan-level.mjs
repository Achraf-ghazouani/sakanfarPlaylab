// lib/scan-level.mjs
// Core "drawing -> level JSON" logic, shared by the CLI (scan.mjs) and the
// Vercel function (api/scan.js). No dependencies: Node 20+ fetch only.

export const TYPES = ["start", "goal", "platform", "moving_platform", "coin", "enemy", "spike", "decoration"];

export const DEFAULT_API_URL = "https://api.meta.ai/v1/chat/completions";
export const DEFAULT_MODEL = "muse-spark-1.3";

const SYSTEM_PROMPT = `You convert a photo of a hand-drawn 2D platformer level into game JSON.

The drawing is free-form: people sketch whatever they like and you decide what each thing means in a platformer. Be generous and playful in your interpretation:
- start: where the player begins. A stick figure, a person, an arrow pointing in, "S", "start", "P", a door on the left.
- goal: where the level ends. A flag, a star, a door/house on the right, a trophy, "goal", "end", "finish", "exit".
- platform: anything the player can stand on. Ground lines, horizontal strokes, boxes, bricks, hills, logs, tables.
- moving_platform: a platform that moves. Clouds, boats, anything with motion arrows ("<->"), wings, wheels.
- coin: collectible. Small circles, dots, stars, "$", "o", gems, fruit, hearts.
- enemy: hurts the player and walks around. Any creature, monster, animal, face, cactus, robot, ghost, anything with eyes or teeth.
- spike: a static hazard. Triangles, zigzags, saw blades, fire, lava, water, thorns, "^^^".
- decoration: everything else. Sun, trees, flowers, background clouds high in the sky with nothing on them, words, scribbles.

Coordinates: the photo is a 1000 x 1000 grid. x goes right, y goes DOWN, (0,0) is the top-left corner of the photo. x,y is the top-left corner of the box around the object, w,h is its size. Boxes must tightly cover the drawn thing, measured over the whole photo (not just the paper).

Rules:
- Return exactly one start and exactly one goal. If none is drawn, invent sensible ones (start on the left on top of a platform, goal on the right on top of a platform).
- Ground lines and long strokes become thin platforms (h 15-40). Thick filled shapes keep their real size.
- Enemies, coins, start and goal should sit just above a platform, not float in the air, unless clearly drawn floating.
- Include every drawn thing. Do not merge separate platforms into one.
- "label" is 1-3 words saying what was literally drawn (e.g. "cactus", "cloud", "stick figure").
- "theme" is 2-5 words describing the vibe of the drawing (e.g. "desert cactus canyon").

Respond with JSON only, no prose, no markdown fences:
{"theme":"...","objects":[{"type":"platform","label":"ground line","x":0,"y":900,"w":1000,"h":30}, ...]}`;

const USER_PROMPT = "Here is the photo of the drawn level. Return the level JSON.";

/**
 * Send an image to the model and get a normalized level.
 * @param {object} opts
 * @param {string} opts.base64   image bytes as base64 (no data: prefix)
 * @param {string} opts.mime     e.g. "image/jpeg"
 * @param {string} opts.apiKey
 * @param {string} [opts.apiUrl]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{level: object, raw: string, usage?: object}>}
 */
export async function scanLevelFromImage({ base64, mime, apiKey, apiUrl = DEFAULT_API_URL, model = DEFAULT_MODEL, timeoutMs = 90_000 }) {
  if (!apiKey) throw new Error("Missing API key (MODEL_API_KEY).");
  if (!base64) throw new Error("Missing image data.");

  const body = {
    model,
    temperature: 0.2,
    max_tokens: 3000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: USER_PROMPT },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
  };

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Model API error ${res.status} ${res.statusText}: ${text.slice(0, 600)}`);
  }

  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Model API returned non-JSON body: " + text.slice(0, 300)); }

  const raw = extractMessageText(data);
  const parsed = extractJson(raw);
  if (!parsed) {
    const err = new Error("Could not find level JSON in the model reply.");
    err.raw = raw;
    throw err;
  }
  return { level: normalizeLevel(parsed), raw, usage: data.usage };
}

/** Handles string content and array-of-parts content. */
function extractMessageText(data) {
  const msg = data?.choices?.[0]?.message;
  const content = msg?.content ?? data?.output_text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n");
  return String(content);
}

/** Pull the first {...} object out of a reply that may contain fences or prose. */
export function extractJson(text) {
  if (!text) return null;
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const SYNONYMS = {
  player: "start", spawn: "start", begin: "start",
  flag: "goal", end: "goal", finish: "goal", exit: "goal", door: "goal",
  ground: "platform", block: "platform", wall: "platform", floor: "platform", ledge: "platform",
  movingplatform: "moving_platform", "moving-platform": "moving_platform", cloud: "moving_platform", mover: "moving_platform",
  coins: "coin", gem: "coin", star: "coin", collectible: "coin",
  monster: "enemy", enemies: "enemy", creature: "enemy", bad: "enemy",
  spikes: "spike", hazard: "spike", lava: "spike", fire: "spike", trap: "spike",
  deco: "decoration", background: "decoration", text: "decoration",
};

const MIN_SIZE = { start: 30, goal: 30, platform: 15, moving_platform: 15, coin: 18, enemy: 25, spike: 15, decoration: 10 };

/**
 * Make any model output safe for the game:
 * valid types, integer coords inside the grid, exactly one start and one goal,
 * at least one platform.
 */
export function normalizeLevel(input) {
  const theme = typeof input?.theme === "string" && input.theme.trim() ? input.theme.trim().slice(0, 60) : "hand-drawn level";
  const list = Array.isArray(input?.objects) ? input.objects : [];
  const objects = [];

  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    let type = String(o.type ?? "").toLowerCase().trim().replace(/\s+/g, "_");
    type = TYPES.includes(type) ? type : SYNONYMS[type] ?? SYNONYMS[type.replace(/_/g, "")] ?? "decoration";

    let x = num(o.x, 0), y = num(o.y, 0), w = num(o.w, 40), h = num(o.h, 40);
    const min = MIN_SIZE[type];
    w = Math.max(min, w); h = Math.max(min, h);
    x = clamp(x, 0, 1000 - min); y = clamp(y, 0, 1000 - min);
    w = Math.min(w, 1000 - x); h = Math.min(h, 1000 - y);

    objects.push({
      type,
      label: String(o.label ?? type).slice(0, 40),
      x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
    });
  }

  // Exactly one start / goal: keep the first, demote extras to decoration.
  keepOne(objects, "start");
  keepOne(objects, "goal");

  // At least one platform, otherwise nothing is playable.
  if (!objects.some((o) => o.type === "platform" || o.type === "moving_platform")) {
    objects.push({ type: "platform", label: "ground (auto)", x: 0, y: 940, w: 1000, h: 30 });
  }

  const solids = objects.filter((o) => o.type === "platform");
  if (!objects.some((o) => o.type === "start")) {
    const p = solids.length ? solids.reduce((a, b) => (b.x < a.x ? b : a)) : { x: 0, y: 940 };
    objects.push({ type: "start", label: "start (auto)", x: clamp(p.x + 10, 0, 960), y: Math.max(0, p.y - 60), w: 40, h: 60 });
  }
  if (!objects.some((o) => o.type === "goal")) {
    const p = solids.length ? solids.reduce((a, b) => (b.x + b.w > a.x + a.w ? b : a)) : { x: 0, y: 940, w: 1000 };
    objects.push({ type: "goal", label: "goal (auto)", x: clamp(p.x + p.w - 50, 0, 960), y: Math.max(0, p.y - 60), w: 40, h: 60 });
  }

  return { theme, objects };
}

function keepOne(objects, type) {
  let seen = false;
  for (const o of objects) {
    if (o.type !== type) continue;
    if (seen) o.type = "decoration"; else seen = true;
  }
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export function mimeFromName(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic" }[ext] ?? "image/jpeg";
}
