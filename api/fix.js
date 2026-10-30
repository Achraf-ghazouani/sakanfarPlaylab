// api/fix.js — Vercel serverless function: run the playtest agent on a level JSON.
// POST { level: {...}, ai?: true }
// -> 200 { level, report: { before, after, fixedBy, fixes, aiError } }

import { normalizeLevel } from "../lib/scan-level.mjs";
import { playtestAndFix } from "../lib/fix-level.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST with a JSON body." });
  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  const lvl = body?.level;
  if (!lvl || !Array.isArray(lvl.objects)) return res.status(400).json({ error: "Body must be JSON with a \"level\" object that has an objects array." });
  if (lvl.objects.length > 300) return res.status(413).json({ error: "Too many objects." });

  const level = normalizeLevel(lvl, { aspect: lvl.aspect });
  try {
    const { level: fixed, report } = await playtestAndFix(level, { useAI: body.ai !== false, timeoutMs: 55_000 });   // vercel.json gives this function 60 s
    return res.status(200).json({ level: fixed, report });
  } catch (err) {
    console.error("fix failed:", err.message);
    return res.status(502).json({ error: "The playtest agent failed: " + String(err.message).slice(0, 160) });
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
