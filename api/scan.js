// api/scan.js — Vercel serverless function: photo -> playable level JSON.
// POST { image: "<base64 or data URL>", mime?: "image/jpeg", fix?: true }
// -> 200 { level, meta: { provider, model, ms, usage, playtest } }
// -> 4xx/5xx { error }
// The API keys live in environment variables on the server only.
// After the scan, the playtest agent checks every jump and repairs impossible parts (AI, then auto).

import { scanLevelFromImage, aspectFromImage, normalizeLevel } from "../lib/scan-level.mjs";
import { playtestAndFix } from "../lib/fix-level.mjs";
import { diffLevels } from "../shared/diff.mjs";
import { requireUser } from "../lib/auth.mjs";
import { paid } from "../lib/credits.mjs";

const MAX_BASE64 = 8_000_000;                 // ~6 MB of image; the page sends ~0.3-0.8 MB
const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST with a JSON body." });
  const user = await requireUser(req, res);   // AI costs money: logged-in, approved accounts only
  if (!user) return;

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  if (!body || typeof body.image !== "string") return res.status(400).json({ error: "Body must be JSON with an \"image\" field (base64)." });

  // Accept both raw base64 and data URLs.
  let base64 = body.image, mime = String(body.mime || "image/jpeg").toLowerCase();
  const m = /^data:([^;]+);base64,(.*)$/s.exec(base64);
  if (m) { mime = m[1].toLowerCase(); base64 = m[2]; }
  base64 = base64.replace(/\s/g, "");
  if (!OK_MIME.has(mime)) return res.status(400).json({ error: `Unsupported image type ${mime}. Send JPEG, PNG or WebP.` });
  if (base64.length < 100) return res.status(400).json({ error: "Image data is empty." });
  if (base64.length > MAX_BASE64) return res.status(413).json({ error: "Image too large. Resize to 1600px before uploading." });

  let aspect;
  try { aspect = aspectFromImage(Buffer.from(base64, "base64")); } catch { /* not fatal */ }

  // Optional: the level from the earlier scan of the same drawing (live edit by redrawing).
  let previous = null;
  if (body.previous && Array.isArray(body.previous.objects) && body.previous.objects.length <= 300) {
    previous = normalizeLevel(body.previous, { aspect: body.previous.aspect });
  }

  // Optional provider choice (live re-scans use Baseten to save Meta credits); unknown values are ignored.
  const wantProvider = ["meta", "baseten"].includes(String(body.provider || "").toLowerCase()) ? body.provider.toLowerCase() : undefined;

  // Credits: one scan at the price of the chosen model (live re-scans on Baseten use Muse Spark Open's multiplier).
  const model = typeof body.model === "string" ? body.model.slice(0, 60) : wantProvider === "baseten" ? "muse-spark-open" : null;
  let scanned, credits;
  try {
    const out = await paid(user, res, "scan", { model }, (c) => scanLevelFromImage({ base64, mime, aspect, previous, provider: c.provider || wantProvider }));
    if (!out) return;   // 402 / 403 already sent
    scanned = out.result; credits = out.credits;
  } catch (err) {
    console.error("scan failed:", err.message);
    const status = err.status === 401 || err.status === 403 ? 500 : 502;   // never leak auth details, just say the AI failed
    return res.status(status).json({ error: friendly(err), credits: { refunded: !!err.refunded, balance: err.balance } });
  }

  // Playtest agent, quick pass: check every jump and apply the instant algorithmic fix so the level is
  // playable right away. When something was impossible, the original is returned too so the page can
  // ask /api/fix for the slower AI repair (the AI needs ~45 s, which does not fit in this function).
  let level = scanned.level, playtest = null, original = null;
  if (body.fix !== false) {
    try {
      const fixed = await playtestAndFix(level, { useAI: false });
      if (!fixed.report.before.ok) original = level;
      level = fixed.level; playtest = fixed.report;
    } catch (err) {
      console.error("playtest failed:", err.message);
      playtest = { error: String(err.message).slice(0, 200) };
    }
  }

  if (previous) level.diff = diffLevels(previous, level);

  const { provider, ms, usage, fallback } = scanned;
  return res.status(200).json({ level, original, meta: { provider, model: scanned.model, ms, usage, fallback: !!fallback, playtest }, credits });
}

function friendly(err) {
  const msg = String(err.message || err);
  if (/no api key|missing its url/i.test(msg)) return "The server has no AI key configured.";
  if (/401|403/.test(msg)) return "The AI rejected the server key.";
  if (/timeout|aborted/i.test(msg)) return "The AI took too long. Try again with a clearer photo.";
  if (/could not find level JSON/i.test(msg)) return "The AI did not return a level. Try a clearer photo with a ground line.";
  return "The AI could not read this drawing. Try again.";
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
