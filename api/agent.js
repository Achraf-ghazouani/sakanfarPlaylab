// api/agent.js — the Studio game agent endpoint (Vercel serverless function).
//   POST { message, level?, history?: [{role, content}], attachments?: [{name, type}] }
//   -> 200 { reply, actions, level?, kind?: "create"|"edit", note?, diff?, playtest?, meta?, credits? }
// Credits: a turn without a level costs create_2d, a turn on an existing level costs edit_2d (402 when the balance is short);
// replies that need no AI (empty message, "3D comes later", pictures go to the scanner) are free; a failed AI call is refunded.
// Muse Spark (Meta Model API) answers with function tools; the server validates the level, runs the quick
// reachability fix and returns it. The page saves it as a version. Keys stay in environment variables.

import { runAgent, quickReply } from "../lib/agent.mjs";
import { paid } from "../lib/credits.mjs";
import { normalizeLevel } from "../lib/scan-level.mjs";
import { normalizeArena, genreWanted } from "../shared/arena.mjs";
import { requireUser } from "../lib/auth.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const user = await requireUser(req, res);   // AI costs money: logged-in, approved accounts only
  if (!user) return;
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});

  const message = String(body.message || "").slice(0, 2000);
  let level = null;
  if (body.level && Array.isArray(body.level.objects) && body.level.objects.length && body.level.objects.length <= 300) {
    level = body.level.genre === "arena" ? normalizeArena(body.level) : normalizeLevel(body.level, { aspect: body.level.aspect });
  }
  const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [];

  const free = quickReply(message, !!level, attachments, level);
  if (free) return res.status(200).json(free);
  const model = typeof body.model === "string" ? body.model.slice(0, 60) : null;
  try {
    // 3D prices: the Studio's 3D toggle, an arena shooter (always 3D), or words asking for one
    const is3d = String(body.mode || "").startsWith("3d") || level?.genre === "arena" || genreWanted(message) === "arena";
    const out = await paid(user, res, level ? (is3d ? "edit_3d" : "edit_2d") : (is3d ? "create_3d" : "create_2d"), { model, gameId: uuidOrNull(body.project_id) },
      (c) => runAgent({ message, level, history, attachments }, { timeoutMs: 50_000, provider: c.provider }));
    if (!out) return;   // 402 / 403 already sent
    return res.status(200).json({ ...out.result, credits: out.credits });
  } catch (err) {
    console.error("agent failed:", err.message);
    const status = err.status === 401 || err.status === 403 ? 500 : 502;   // never leak auth details
    return res.status(status).json({ error: friendly(err), credits: { refunded: !!err.refunded, balance: err.balance } });
  }
}

function friendly(err) {
  const m = String(err?.message || err);
  if (/no API key|not configured/i.test(m)) return "The AI is not configured on the server (MODEL_API_KEY).";
  if (err?.name === "TimeoutError" || /timed? ?out|aborted/i.test(m)) return "The AI took too long. Try again.";
  if (err?.status === 429) return "The AI is busy right now. Try again in a moment.";
  return "The AI could not answer: " + m.slice(0, 160);
}
function uuidOrNull(v) { return /^[0-9a-f-]{36}$/i.test(String(v || "")) ? v : null; }
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
