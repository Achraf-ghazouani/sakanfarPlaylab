// api/art.js — pictures in the Studio (Vercel serverless function, login required).
//   POST { task: "classify", image, hint? }                       -> { kind: "level"|"character"|"object", role, name, confidence, credits }
//   POST { task: "sprite", image, kind, role?, name?, wish? }     -> { image: "data:image/png;base64,...", credits }
// classify: Muse Spark vision, the "classify" price. sprite: Muse Image 1.0, the "art" price on the muse-image-1.0 model.
// Both are refunded when the AI call fails. The page cuts the sprite's white background out (shared/cutout.js).

import { requireUser, readBody } from "../lib/auth.mjs";
import { paid } from "../lib/credits.mjs";
import { classifyPicture, makeSprite, ROLES } from "../lib/image.mjs";

const MAX_BASE64 = 6_000_000;
const OK_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const user = await requireUser(req, res);
  if (!user) return;
  const b = readBody(req);
  const m = /^data:([^;]+);base64,(.+)$/s.exec(String(b.image || ""));
  if (!m || !OK_MIME.has(m[1].toLowerCase()) || m[2].length > MAX_BASE64) return res.status(400).json({ error: "Send the picture as a JPEG, PNG or WebP data URL (up to about 4 MB)." });
  const mime = m[1].toLowerCase(), base64 = m[2];

  try {
    if (b.task === "classify") {
      const out = await paid(user, res, "classify", {}, (c) => classifyPicture({ base64, mime, hint: String(b.hint || ""), provider: c.provider }));
      if (!out) return;
      const { kind, role, name, confidence } = out.result;
      return res.status(200).json({ kind, role, name, confidence, credits: out.credits });
    }
    if (b.task === "sprite") {
      const kind = b.kind === "object" ? "object" : "character";
      const role = kind === "object" ? (ROLES.includes(b.role) ? b.role : "decoration") : null;
      const name = String(b.name || "").slice(0, 40), wish = String(b.wish || "").slice(0, 200);
      const out = await paid(user, res, "art", { model: "muse-image-1.0" }, () => makeSprite({ imageDataUrl: `data:${mime};base64,${base64}`, kind, role, name, wish }));
      if (!out) return;
      return res.status(200).json({ image: out.result.dataUrl, ms: out.result.ms, kind, role, credits: out.credits });
    }
    return res.status(400).json({ error: "task must be classify or sprite." });
  } catch (err) {
    console.error("art failed:", err.message);
    const blocked = err.code === "content_policy_violation";
    return res.status(blocked ? 400 : 502).json({
      error: blocked ? "Muse Image would not draw this picture (content policy)." : err.status === 429 ? "The image model is busy. Try again in a moment." : "The AI could not do that: " + String(err.message).slice(0, 160),
      credits: { refunded: !!err.refunded, balance: err.balance },
    });
  }
}
