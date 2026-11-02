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

export const TOOLS = [
  { type: "function", function: { name: "create_level", description: "Build a brand new level from the description. Replaces the current level.", parameters: LEVEL_PARAMS } },
  { type: "function", function: { name: "edit_level", description: "Change the current level. Return the FULL updated object list: keep everything the person did not ask to change, with the same coordinates and labels.", parameters: LEVEL_PARAMS } },
  { type: "function", function: { name: "playtest_level", description: "Run the playtest agent on the current level: it checks that every platform, coin and goal is reachable and repairs what is not.", parameters: { type: "object", properties: {} } } },
];

export const BRIEF = `You are the game designer inside PlayLab Studio. People chat with you to build and change a 2D platformer level that appears live next to the chat. Be playful, concrete and short.

LEVEL FORMAT: a 1000 x 1000 grid, y goes DOWN, (0,0) is the top-left corner. Each object is {type, label, x, y, w, h}: x,y is the top-left corner of its box, w,h its size. Types:
- start (exactly one): where the player appears, standing on a platform near the left edge. w 40, h 60.
- goal (at least one): the exit, standing on a platform near the right edge. w 40, h 60.
- platform: solid ground. The player stands on top and can jump up through it from below. Ground: h 40-60, full width (x 0, w 1000, y 900-950). Ledges: h 20-40, w 80-400.
- moving_platform: slides left and right by about 150 units each way. Use it to cross wide gaps. w 120-200, h 25-35.
- coin: collectible. w 30, h 30, floating 40-150 above a platform.
- enemy: walks back and forth on its platform, hurts on touch, can be stomped. w 40, h 50, standing on a platform. At most one per ledge.
- spike: static hazard. w 40-200, h 30, standing on a platform or at the bottom of a gap. Never under the start or the goal.
- decoration: background only (sun, trees, clouds high in the sky), no gameplay.

PHYSICS (the player is 36 wide, 54 tall): max jump height 240 from feet to the top of the next ledge; max horizontal jump about 280 between ledge edges at the same height, less when jumping up. Keep each step up under 200 and each gap under 240, otherwise add a stepping ledge or a moving platform. Things standing on a platform have y + h equal to the platform's y.

DESIGN: left to right. 6 to 25 objects. Usually one ground platform plus 2-6 ledges; for harder levels, islands with gaps, more enemies and spikes, fewer safe ledges, still within the physics limits. Spread 2-8 coins along the path. Give every object a short label that fits the theme.

TOOLS: call create_level for a new game or when the person describes a whole level. Call edit_level to change the current level: keep everything they did not ask to change (same coordinates and labels) and return the FULL updated list. Call playtest_level when they ask to test or check the level. Alongside a tool call, answer with one or two friendly sentences saying what you built or changed. "Make it harder": more enemies and spikes, longer gaps within the limits. "Add more coins": add 3-5 coins on the path. "Change theme" without a theme given: pick a fun new one and rename the theme and the labels; keep the layout. Questions or chit-chat: answer in text only, no tool.`;

const JSON_PROTOCOL = `You cannot call tools here. Instead reply with ONE JSON object and nothing else:
{"tool":"create_level"|"edit_level"|"playtest_level"|"none","reply":"one or two sentences for the person","theme":"...","note":"3-8 words naming this version","objects":[{"type":"platform","label":"ground","x":0,"y":920,"w":1000,"h":50}, ...]}
Use "tool":"none" with only "reply" for answers that change nothing.`;

/** A message that only asks to switch between the 2D and the 3D view ("make it 3D", "switch to 2d"): "3d" | "2d" | null. */
export function viewSwitch(text) {
  const t = String(text || "").trim().toLowerCase();
  if (t.length > 40 || !/\b(2d|3d|three.?d|two.?d)\b/.test(t)) return null;
  if (!/^(please\s+)?(make|turn|switch|change|put|play|show|go|view|see|let'?s|i want|in)\b/.test(t) && !/^(2d|3d)[\s.!]*$/.test(t)) return null;
  return /\b(3d|three.?d)\b/.test(t) ? "3d" : "2d";
}

/** Short answers that need no model call: empty input, pictures, a view switch, things handled elsewhere. */
export function quickReply(text, hasLevel, attachments = []) {
  const hasImage = attachments.some((a) => a && String(a.type || "").startsWith("image/"));
  if (hasImage) return { reply: "Got your picture. I am reading it as a level now.", actions: [{ type: "scan" }] };
  const t = String(text || "").trim();
  if (!t) return { reply: "Tell me what to build, or attach a drawing.", actions: [] };
  const lower = t.toLowerCase();
  const view = viewSwitch(t);
  if (view) return { reply: view === "3d" ? "Switched to the 3D view: same level, same controls, now with depth. Use the 2D / 3D toggle to switch back." : "Back to the 2D view.", actions: [{ type: "mode", mode: view }] };
  if (/^generate art$/.test(lower) || /\b(generate|make|create|draw)\b.*\b(art|sprites?|graphics|skins?|ui kit|textures?)\b/.test(lower)) return { reply: "Attach a picture of a character or an object and Muse Image draws it as a game sprite: a character becomes the player, an object becomes every enemy, coin or flag.", actions: [] };
  if (/^share$/.test(lower) || /\bshare (it|this|the (game|level)|a link)\b/.test(lower)) return { reply: "Share links arrive in a later step. For now, use the Share button in the top bar once it is enabled.", actions: [] };
  return null;
}

/** The system prompt for this turn: the brief plus the current level. */
export function systemPrompt(level, { json = false } = {}) {
  const state = level?.objects?.length
    ? `CURRENT LEVEL (JSON): ${JSON.stringify({ theme: level.theme, objects: level.objects.map(({ type, label, x, y, w, h }) => ({ type, label, x, y, w, h })) })}`
    : "There is no level yet: the first thing to do is create one.";
  return `${BRIEF}\n\n${state}${json ? `\n\n${JSON_PROTOCOL}` : ""}`;
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

const KIND = { create_level: "create", edit_level: "edit", playtest_level: "playtest" };

/** Meta: real function tools. */
async function decideWithTools(complete, messages, { timeoutMs, effort }) {
  const r = await complete({ provider: "meta", messages, tools: TOOLS, parallelToolCalls: false, maxTokens: 8000, timeoutMs, reasoningEffort: effort });
  const call = r.toolCalls[0];
  const name = call?.function?.name;
  const kind = call ? KIND[name] || "reply" : "reply";
  return { kind, args: call && kind !== "reply" ? parseArgs(call.function.arguments) : null, text: r.content, model: r.model, ms: r.ms, usage: r.usage };
}

/** Baseten (Muse Spark Open): same brief, JSON answer instead of a tool call. */
async function decideWithJson(complete, messages, { timeoutMs }) {
  const r = await complete({ provider: "baseten", messages, maxTokens: 8000, timeoutMs });
  const obj = extractJson(r.content);
  if (!obj) return { kind: "reply", args: null, text: r.content, model: r.model, ms: r.ms, usage: r.usage };
  const kind = KIND[obj.tool] || "reply";
  return { kind, args: kind === "reply" ? null : obj, text: typeof obj.reply === "string" ? obj.reply : "", model: r.model, ms: r.ms, usage: r.usage };
}

/** Turn the model's decision into a validated, playable result for the page. */
export async function applyDecision(decision, previous) {
  const hasLevel = !!(previous && Array.isArray(previous.objects) && previous.objects.length);
  const text = String(decision.text || "").trim();
  if (decision.kind === "playtest") {
    if (!hasLevel) return { reply: "There is no level yet. Describe one, or attach a drawing, and I will playtest it.", actions: [] };
    return { reply: text || "Running the playtest agent: checking every jump and fixing what is impossible.", actions: [{ type: "playtest" }] };
  }
  if (decision.kind !== "create" && decision.kind !== "edit") return { reply: text || "...", actions: [] };

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

/**
 * One agent turn.
 * @param {{message?: string, level?: object|null, history?: Array<{role: string, content: string}>, attachments?: object[]}} input
 * @param {{complete?: Function, provider?: string, timeoutMs?: number, effort?: string}} [opts]  complete is injectable for tests
 * @returns {Promise<{reply: string, actions: object[], level?: object, kind?: string, note?: string, diff?: string|null, playtest?: object, meta?: object}>}
 */
export async function runAgent({ message = "", level = null, history = [], attachments = [] } = {}, { complete = aiComplete, provider, timeoutMs = 50_000, effort = process.env.PLAYLAB_AGENT_EFFORT || "low" } = {}) {
  const text = String(message || "").trim().slice(0, 2000);
  const hasLevel = !!(level && Array.isArray(level.objects) && level.objects.length);
  const quick = quickReply(text, hasLevel, attachments);
  if (quick) return quick;

  const primary = (provider || defaultProviderName()).toLowerCase();
  const order = [primary];
  for (const other of ["meta", "baseten"]) if (other !== primary && isConfigured(other)) order.push(other);

  let lastErr;
  for (const name of order) {
    try {
      const messages = [{ role: "system", content: systemPrompt(level, { json: name !== "meta" }) }, ...cleanHistory(history), { role: "user", content: text }];
      const decision = name === "meta" ? await decideWithTools(complete, messages, { timeoutMs, effort }) : await decideWithJson(complete, messages, { timeoutMs });
      const out = await applyDecision(decision, level);
      out.meta = { provider: name, model: decision.model, ms: decision.ms, usage: decision.usage, fallback: name !== primary };
      return out;
    } catch (err) {
      lastErr = err;
      if (name !== order[order.length - 1]) console.warn(`agent: ${name} failed (${String(err.message).slice(0, 120)}), trying next provider...`);
    }
  }
  throw lastErr;
}
