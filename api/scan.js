// api/scan.js — Vercel serverless function: photo -> level JSON.
// POST { image: "<base64 or data URL>", mime?: "image/jpeg" }
// -> 200 { level, meta: { provider, model, ms, usage } }
// -> 4xx/5xx { error }
// The API keys live in environment variables on the server only.

import { scanLevelFromImage, aspectFromImage } from "../lib/scan-level.mjs";

const MAX_BASE64 = 8_000_000;                 // ~6 MB of image; the page sends ~0.3-0.8 MB
const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST with a JSON body." });

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

  try {
    const { level, provider, model, ms, usage, fallback } = await scanLevelFromImage({ base64, mime, aspect });
    return res.status(200).json({ level, meta: { provider, model, ms, usage, fallback: !!fallback } });
  } catch (err) {
    console.error("scan failed:", err.message);
    const status = err.status === 401 || err.status === 403 ? 500 : 502;   // never leak auth details, just say the AI failed
    return res.status(status).json({ error: friendly(err) });
  }
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
