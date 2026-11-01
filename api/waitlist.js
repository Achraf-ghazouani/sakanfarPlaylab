// api/waitlist.js — join the waitlist (no account needed).
//   POST { name, email, message?, source?, website? } -> { ok, position, already }
// Protection: strict validation, a honeypot field ("website", hidden from people), a per-IP rate limit and a
// global hourly cap (both in the database), duplicate emails return the existing position instead of a new row.

import { srv, serverConfigured } from "../lib/db.mjs";
import { clientIp, readBody } from "../lib/auth.mjs";
import { createHash } from "node:crypto";

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!serverConfigured()) return res.status(503).json({ error: "The waitlist is not configured on the server yet." });
  const b = readBody(req);

  // Bots fill every field. People never see this one. Pretend it worked and store nothing.
  if (String(b.website || "").trim()) return res.status(200).json({ ok: true, position: 0, already: false });

  const name = String(b.name || "").trim().replace(/\s+/g, " ");
  const email = String(b.email || "").trim().toLowerCase();
  const message = String(b.message || "").trim();
  const source = String(b.source || "").trim();
  if (!name || name.length > 80) return res.status(400).json({ error: "Please tell us your name (80 characters max).", field: "name" });
  if (email.length > 254 || !EMAIL.test(email)) return res.status(400).json({ error: "That email does not look right.", field: "email" });
  if (message.length > 1000) return res.status(400).json({ error: "Keep the game idea under 1000 characters.", field: "message" });
  if (source.length > 120) return res.status(400).json({ error: "Keep that answer short.", field: "source" });

  // The IP is only used as a rate-limit bucket, hashed with the server key so raw addresses are never stored.
  const ipHash = createHash("sha256").update(clientIp(req) + "|" + process.env.PLAYLAB_SERVER_KEY).digest("hex").slice(0, 32);
  try {
    const r = await srv("srv_join_waitlist", { p_name: name, p_email: email, p_message: message, p_source: source, p_ip: ipHash });
    if (r?.error === "rate_limited") return res.status(429).json({ error: "Too many sign-ups from here. Try again in an hour." });
    return res.status(200).json({ ok: true, position: r.position, already: !!r.already, status: r.already ? r.status : "pending" });
  } catch (err) {
    console.error("waitlist:", err.message);
    return res.status(502).json({ error: "Could not save that. Try again in a moment." });
  }
}
