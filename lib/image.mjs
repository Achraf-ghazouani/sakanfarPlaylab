// lib/image.mjs — pictures uploaded to the Studio: what are they, and a game sprite of them.
// SERVER-SIDE ONLY (reads MODEL_API_KEY).
//   classifyPicture  Muse Spark (vision, chat completions) decides: a level, a character or one object (and which game role).
//                    Muse Image only outputs images, so understanding a picture is Muse Spark's job (dev.meta.ai/docs/models).
//   makeSprite       Muse Image 1.0 (POST /v1/images/edits, dev.meta.ai/docs/api-reference/images/edit-image) redraws it as one
//                    clean sprite. Muse Image has no transparent background option (responses are always "opaque"), so the
//                    prompt asks for flat pure white and the page cuts it out (shared/cutout.js).

import { chatVision } from "./ai.mjs";

export const ROLES = ["enemy", "coin", "goal", "spike", "decoration"];
const KINDS = ["level", "character", "object"];

const CLASSIFY_SYSTEM = `You look at ONE picture that someone uploaded to a 2D platformer game builder and decide what it is for.
- "level": a drawn, sketched or photographed level layout: ground lines, platforms, several separate things placed like a map, a notebook page with a level on it.
- "character": ONE figure meant to be the hero the player controls: a person, creature, mascot, avatar or game sprite of a hero.
- "object": ONE single thing that is not the hero: a monster or animal (enemy), a coin, gem, fruit or treasure (coin), a flag, door or portal (goal), something sharp (spike), or scenery like a tree, cloud or house (decoration).
If the person's message says what they want, follow it.
Answer with JSON only, no prose: {"kind":"level|character|object","role":"enemy|coin|goal|spike|decoration|null","name":"2 to 4 words","confidence":0.0-1.0}
"role" is null unless kind is "object".`;

/** Muse Spark answer -> { kind, role, name, confidence }. Exported for tests. */
export function parseClassification(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  let j = {};
  try { j = JSON.parse(m ? m[0] : "{}"); } catch {}
  const kind = KINDS.includes(j.kind) ? j.kind : "level";
  const role = kind === "object" ? (ROLES.includes(j.role) ? j.role : "decoration") : null;
  const name = String(j.name || (kind === "character" ? "your character" : kind === "object" ? role : "your level")).replace(/[^\p{L}\p{N} '\-]/gu, "").trim().slice(0, 40) || kind;
  const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0.5));
  return { kind, role, name, confidence };
}

export async function classifyPicture({ base64, mime = "image/jpeg", hint = "", timeoutMs = 30_000, provider }) {
  const prompt = `The person's message: ${hint ? JSON.stringify(String(hint).slice(0, 300)) : "(none)"}\nWhat is this picture for? JSON only.`;
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
