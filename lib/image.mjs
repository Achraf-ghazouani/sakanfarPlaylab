// lib/image.mjs — pictures uploaded to the Studio: what are they, and a game sprite of them.
// SERVER-SIDE ONLY (reads MODEL_API_KEY).
//   classifyPicture  Muse Spark (vision, chat completions) decides: a level, a character or one object (and which game role).
//                    Muse Image only outputs images, so understanding a picture is Muse Spark's job (dev.meta.ai/docs/models).
//   makeSprite       Muse Image 1.0 (POST /v1/images/edits, dev.meta.ai/docs/api-reference/images/edit-image) redraws it as one
//                    clean sprite. Muse Image has no transparent background option (responses are always "opaque"), so the
//                    prompt asks for flat pure white and the page cuts it out (shared/cutout.js).

import { chatVision } from "./ai.mjs";

export const ROLES = ["enemy", "coin", "goal", "spike", "decoration"];   // the object sprite slots in the game
/** Every role a picture can have (game content and UI); shared/assetcheck.js guesses among the same list. */
export const ASSET_ROLES = ["level", "player", "enemy", "collectible", "hazard", "goal", "texture", "tileset", "spritesheet", "background", "decoration",
  "ui_button", "ui_panel", "ui_hud", "ui_icon", "ui_logo", "ui_cursor", "ui_font", "ui_mockup"];
/** Asset roles that are one object sprite in the game -> the sprite slot they fill. */
export const OBJECT_SLOT = { enemy: "enemy", collectible: "coin", hazard: "spike", goal: "goal", decoration: "decoration" };
const LEGACY_SLOT = { enemy: "enemy", coin: "collectible", goal: "goal", spike: "hazard", decoration: "decoration" };
const HINTS = { ui_button: ["start", "pause", "restart", "menu", "gameover", "other"], ui_icon: ["heart", "coin", "star", "timer", "other"], ui_hud: ["health", "coins", "timer", "score", "other"] };

const CLASSIFY_SYSTEM = `You look at ONE picture that someone uploaded to a game builder (2D platformers and 3D arena shooters) and say what it is for.
Game content roles:
- "level": a drawn, sketched or photographed level layout: ground lines, platforms, several things placed like a map, a notebook page with a level on it.
- "player": ONE figure meant to be the hero the player controls: a person, creature, mascot, avatar or hero sprite.
- "enemy": one monster, animal or villain. "collectible": a coin, gem, fruit or treasure. "hazard": spikes, fire, a saw, lava. "goal": a flag, door, portal or exit.
- "texture": a repeating surface (bricks, grass, wood, stone) to paint platforms with. "tileset": a grid of many small square tiles.
- "spritesheet": a grid of animation frames of the same character. "background": a wide scene (sky, hills, forest, city) that goes behind the game. "decoration": scenery (a tree, cloud, house, rock).
UI roles:
- "ui_button": a button; hint one of start, pause, restart, menu, gameover, other. "ui_panel": a panel, window, dialog box or frame.
- "ui_hud": a HUD piece (health bar, coin counter frame, timer box); hint one of health, coins, timer, score, other.
- "ui_icon": a small icon; hint one of heart, coin, star, timer, other. "ui_logo": a logo or a game title. "ui_cursor": a mouse cursor or pointer.
- "ui_font": a sheet of letters or digits. "ui_mockup": a screenshot or design of a whole menu or HUD with several elements in it.
If the person's message says what they want, follow it. Facts measured on the pixels are given: trust them.
Answer with JSON only, no prose: {"role":"<one role from the lists>","name":"2 to 4 words","confidence":0.0-1.0,"hint":"<the hint word for buttons, icons and HUD pieces, else empty>"}`;

/**
 * Muse Spark's answer -> { role, kind, objRole, name, confidence, hint }. Exported for tests.
 * kind is the older coarse split (level / character / object / asset) and objRole the sprite slot for an object, both kept for the pages.
 * Older answers ({"kind":"object","role":"coin"}) are still understood.
 */
export function parseClassification(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  let j = {};
  try { j = JSON.parse(m ? m[0] : "{}"); } catch {}
  let role = ASSET_ROLES.includes(j.role) ? j.role : null;
  if (!role) role = j.kind === "character" ? "player" : j.kind === "object" ? (LEGACY_SLOT[j.role] || "decoration") : "level";
  const kind = role === "level" ? "level" : role === "player" ? "character" : OBJECT_SLOT[role] ? "object" : "asset";
  const objRole = OBJECT_SLOT[role] || null;
  const name = String(j.name || (role === "player" ? "your character" : role === "level" ? "your level" : role.replace(/^ui_/, ""))).replace(/[^\p{L}\p{N} '\-]/gu, "").trim().slice(0, 40) || role;
  const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0.5));
  let hint = String(j.hint || "").toLowerCase().replace(/[^a-z0-9 ,-]/g, "").trim().slice(0, 40);
  if (HINTS[role] && !HINTS[role].includes(hint)) hint = HINTS[role].find((h) => hint.includes(h)) || "";
  return { role, kind, objRole, name, confidence, hint };
}

/** @param facts  what shared/assetcheck.js measured, in words (size, transparency, a grid, a frame, paper) */
export async function classifyPicture({ base64, mime = "image/jpeg", hint = "", facts = "", timeoutMs = 30_000, provider }) {
  const prompt = `The person's message: ${hint ? JSON.stringify(String(hint).slice(0, 300)) : "(none)"}\nFacts measured on the pixels: ${facts ? String(facts).slice(0, 300) : "(none)"}\nWhat is this picture for? JSON only.`;
  const r = await chatVision({ provider, system: CLASSIFY_SYSTEM, prompt, imageBase64: base64, mime, temperature: 0, maxTokens: 300, timeoutMs, reasoningEffort: "minimal" });
  return { ...parseClassification(r.text), provider: r.provider, model: r.model, ms: r.ms };
}

const ROLE_WORDS = {
  enemy: "an enemy creature that walks back and forth",
  coin: "a collectible coin or treasure item, small and shiny",
  goal: "the goal of the level (a flag, door or portal) that the player reaches to win",
  spike: "a dangerous spike hazard",
  decoration: "a piece of background scenery",
};

/** The Muse Image instruction for a sprite. Exported for tests. */
export function spritePrompt({ kind, role, name, wish = "" }) {
  const what = kind === "character"
    ? `the character in this picture${name ? ` (${name})` : ""} as the playable hero of a 2D side-scrolling platformer: full body, standing, facing right`
    : `the ${name || "thing"} in this picture as ${ROLE_WORDS[role] || ROLE_WORDS.decoration} in a 2D side-scrolling platformer, seen from the side`;
  return `Redraw ${what}. Make it one clean video game sprite: bold dark outlines, flat cartoon colors with simple shading, keep its colors, shape and key details so it is clearly the same ${kind === "character" ? "character" : "thing"}.`
    + (wish ? ` The person asked: ${String(wish).slice(0, 200)}.` : "")
    + ` Exactly one ${kind === "character" ? "character" : "object"}, centered, filling about 80% of the image height, on a plain flat pure white background (#FFFFFF) with nothing else: no shadow, no floor, no scenery, no text, no frame, no border.`;
}

/**
 * Muse Image edit with the uploaded picture as the reference. Returns { dataUrl, ms }.
 * Errors carry .status (400 content_policy_violation, 429, 503 retryable...).
 */
export async function makeSprite({ imageDataUrl, kind, role, name, wish, timeoutMs = 55_000 }) {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new Error("MODEL_API_KEY is not set.");
  const base = (process.env.MODEL_IMAGE_URL || "https://api.meta.ai/v1").replace(/\/+$/, "");
  const body = {
    model: process.env.MODEL_IMAGE_NAME || "muse-image-1.0",
    prompt: spritePrompt({ kind, role, name, wish }),
    images: [{ image_url: imageDataUrl }],
    n: 1,
    size: "1024x1024",
    output_format: "png",          // lossless: a clean flat background to cut out
    response_format: "b64_json",
    reasoning_strength: "low",     // faster; the sprite is simple
  };
  const t0 = Date.now();
  const res = await fetch(`${base}/images/edits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let code = ""; try { code = JSON.parse(text)?.error?.code || ""; } catch {}
    const err = new Error(`Muse Image error ${res.status}${code ? " " + code : ""}: ${text.slice(0, 300)}`);
    err.status = res.status; err.code = code;
    throw err;
  }
  let data; try { data = JSON.parse(text); } catch { throw new Error("Muse Image returned non-JSON."); }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error("Muse Image returned no image.");
  const fmt = data.output_format || "png";
  return { dataUrl: `data:image/${fmt};base64,${b64}`, ms: Date.now() - t0 };
}
