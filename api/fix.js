// api/fix.js — Vercel serverless function: run the playtest agent on a level JSON.
// POST { level: {...}, ai?: true }
// -> 200 { level, report: { before, after, fixedBy, fixes, aiError }, credits? }
// Credits: free when the level is already fine or ai:false (no AI call); otherwise the playtest price, refunded when
// the AI repair fails and the instant algorithmic fix is used instead.

import { normalizeLevel } from "../lib/scan-level.mjs";
import { playtestAndFix } from "../lib/fix-level.mjs";
import { requireUser } from "../lib/auth.mjs";
import { paid, refund } from "../lib/credits.mjs";
import { checkLevel } from "../shared/reach.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST with a JSON body." });
  const user = await requireUser(req, res);   // AI costs money: logged-in, approved accounts only
  if (!user) return;
  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  const lvl = body?.level;
  if (!lvl || !Array.isArray(lvl.objects)) return res.status(400).json({ error: "Body must be JSON with a \"level\" object that has an objects array." });
  if (lvl.objects.length > 300) return res.status(413).json({ error: "Too many objects." });

  const level = normalizeLevel(lvl, { aspect: lvl.aspect });
  try {
    const useAI = body.ai !== false && !checkLevel(level).ok;
    if (!useAI) {
      const { level: fixed, report } = await playtestAndFix(level, { useAI: false });
      return res.status(200).json({ level: fixed, report });
    }
    const model = typeof body.model === "string" ? body.model.slice(0, 60) : null;
    const out = await paid(user, res, "playtest", { model }, (c) => playtestAndFix(level, { useAI: true, provider: c.provider, timeoutMs: 55_000 }));   // vercel.json gives this function 60 s
    if (!out) return;   // 402 / 403 already sent
    const { level: fixed, report } = out.result;
    let credits = out.credits;
    if (report.aiError || report.fixedBy === "auto") {   // the AI did not do the work: give the credits back
      const back = await refund(out.ledgerId, "refund: the AI repair failed, the instant fix was used");
      credits = { ...credits, refunded: !!back?.ok, balance: back?.balance ?? credits.balance };
    }
    return res.status(200).json({ level: fixed, report, credits });
  } catch (err) {
    console.error("fix failed:", err.message);
    return res.status(502).json({ error: "The playtest agent failed: " + String(err.message).slice(0, 160) });
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
