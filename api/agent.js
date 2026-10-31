// api/agent.js — the Studio game agent endpoint (Vercel serverless function).
//   POST { message, level?, history?: [{role, content}], attachments?: [{name, type}] }
//   -> 200 { reply, actions, level?, kind?: "create"|"edit", note?, diff?, playtest?, meta? }
// Muse Spark (Meta Model API) answers with function tools; the server validates the level, runs the quick
// reachability fix and returns it. The page saves it as a version. Keys stay in environment variables.

import { runAgent } from "../lib/agent.mjs";
import { normalizeLevel } from "../lib/scan-level.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});

  const message = String(body.message || "").slice(0, 2000);
  let level = null;
  if (body.level && Array.isArray(body.level.objects) && body.level.objects.length && body.level.objects.length <= 300) {
    level = normalizeLevel(body.level, { aspect: body.level.aspect });
  }
  const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [];

  try {
    const out = await runAgent({ message, level, history, attachments }, { timeoutMs: 50_000 });
    return res.status(200).json(out);
  } catch (err) {
    console.error("agent failed:", err.message);
    const status = err.status === 401 || err.status === 403 ? 500 : 502;   // never leak auth details
    return res.status(status).json({ error: friendly(err) });
  }
}

function friendly(err) {
  const m = String(err?.message || err);
  if (/no API key|not configured/i.test(m)) return "The AI is not configured on the server (MODEL_API_KEY).";
  if (err?.name === "TimeoutError" || /timed? ?out|aborted/i.test(m)) return "The AI took too long. Try again.";
  if (err?.status === 429) return "The AI is busy right now. Try again in a moment.";
  return "The AI could not answer: " + m.slice(0, 160);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
