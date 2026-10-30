// lib/scan-level.mjs
// "Drawing photo -> level JSON": prompt, AI call (via lib/ai.mjs), JSON extraction and
// normalization. Shared by the CLI (scan.mjs) and the Vercel function (api/scan.js).
// Server-side only (it needs API keys through lib/ai.mjs).

import { chatVision, defaultProviderName, isConfigured } from "./ai.mjs";

export const TYPES = ["start", "goal", "platform", "moving_platform", "coin", "enemy", "spike", "decoration"];

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
- Return exactly one start and at least one goal. If none is drawn, invent sensible ones (start on the left on top of a platform, goal on the right on top of a platform).
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
 * Tries the default provider, then falls back to the other one if it is configured.
 * @param {object} opts
 * @param {string} opts.base64     image bytes as base64 (no data: prefix)
 * @param {string} opts.mime       e.g. "image/jpeg"
 * @param {number} [opts.aspect]   photo width / height
 * @param {string} [opts.provider] "meta" | "baseten" (default: AI_PROVIDER env or meta)
 * @returns {Promise<{level: object, raw: string, usage?: object, provider: string, model: string, ms: number, fallback?: boolean}>}
 */
export async function scanLevelFromImage({ base64, mime = "image/jpeg", aspect, provider, timeoutMs = 90_000 }) {
  if (!base64) throw new Error("Missing image data.");
  const primary = (provider || defaultProviderName()).toLowerCase();
  const order = [primary];
  for (const other of ["meta", "baseten"]) if (other !== primary && isConfigured(other)) order.push(other);

  let lastErr;
  for (const name of order) {
    try {
      const reply = await chatVision({ provider: name, system: SYSTEM_PROMPT, prompt: USER_PROMPT, imageBase64: base64, mime, timeoutMs });
      const parsed = extractJson(reply.text);
      if (!parsed) {
        const err = new Error(`${name}: could not find level JSON in the model reply.`);
        err.raw = reply.text;
        throw err;
      }
      return { level: normalizeLevel(parsed, { aspect }), raw: reply.text, usage: reply.usage, provider: reply.provider, model: reply.model, ms: reply.ms, fallback: name !== primary };
    } catch (err) {
      lastErr = err;
      if (order.length > 1 && name !== order[order.length - 1]) console.warn(`${name} failed (${err.message.slice(0, 120)}), trying next provider...`);
    }
  }
  throw lastErr;
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
 * valid types (unknown -> decoration), integer coords inside 0-1000,
 * exactly one start, at least one goal, at least one platform.
 */
export function normalizeLevel(input, extra = {}) {
  const theme = typeof input?.theme === "string" && input.theme.trim() ? input.theme.trim().slice(0, 60) : "hand-drawn level";
  // aspect = photo width / height. The game uses it so the level is not squashed into a square.
  const a = Number(extra.aspect ?? input?.aspect);
  const aspect = Number.isFinite(a) && a > 0.4 && a < 3 ? Math.round(a * 1000) / 1000 : undefined;
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

  // Exactly one start: keep the first, demote extras to decoration.
  let seenStart = false;
  for (const o of objects) {
    if (o.type !== "start") continue;
    if (seenStart) o.type = "decoration"; else seenStart = true;
  }

  // At least one platform, otherwise nothing is playable.
  if (!objects.some((o) => o.type === "platform" || o.type === "moving_platform")) {
    objects.push({ type: "platform", label: "ground (auto)", x: 0, y: 940, w: 1000, h: 30 });
  }

  const solids = objects.filter((o) => o.type === "platform");
  if (!seenStart) {
    const p = solids.length ? solids.reduce((a, b) => (b.x < a.x ? b : a)) : { x: 0, y: 940 };
    objects.push({ type: "start", label: "start (auto)", x: clamp(p.x + 10, 0, 960), y: Math.max(0, p.y - 60), w: 40, h: 60 });
  }
  if (!objects.some((o) => o.type === "goal")) {
    const p = solids.length ? solids.reduce((a, b) => (b.x + b.w > a.x + a.w ? b : a)) : { x: 0, y: 940, w: 1000 };
    objects.push({ type: "goal", label: "goal (auto)", x: clamp(p.x + p.w - 50, 0, 960), y: Math.max(0, p.y - 60), w: 40, h: 60 });
  }

  return aspect ? { theme, aspect, objects } : { theme, objects };
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * Width/height (and EXIF orientation for JPEG) of a JPEG or PNG buffer, or null.
 * Orientation 5-8 means the phone stored the photo rotated.
 */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: IHDR right after the 8-byte signature.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), orientation: 1 };
  }
  // JPEG: walk the markers until a SOFn frame header.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let orientation = 1;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xe1 && buf.toString("ascii", i + 4, i + 8) === "Exif") orientation = exifOrientation(buf, i + 10) || 1;
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), orientation };
      if (marker === 0xda) break;
      i += 2 + len;
    }
  }
  return null;
}

function exifOrientation(buf, tiff) {
  try {
    const le = buf.toString("ascii", tiff, tiff + 2) === "II";
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd = tiff + u32(tiff + 4);
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) return u16(e + 8);
    }
  } catch { /* malformed EXIF */ }
  return 0;
}

/** Photo aspect ratio (width / height) corrected for EXIF rotation, or undefined. */
export function aspectFromImage(buf) {
  const dims = imageSize(buf);
  if (!dims) return undefined;
  return dims.orientation >= 5 ? dims.height / dims.width : dims.width / dims.height;
}

export function mimeFromName(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic" }[ext] ?? "image/jpeg";
}
