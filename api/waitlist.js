// api/waitlist.js — join the waitlist, or try PlayLab with a guest account (no account needed for either).
//   POST { name, email, message?, source?, website? } -> { ok, position, already }
//   POST { action: "guest" } -> { username, password, credits, expires_at }   a demo account with GUEST_CREDITS for GUEST_HOURS;
//        the page logs in with it at once. Limits: GUEST_PER_IP a day per address, GUEST_PER_DAY in all, and the shared daily
//        AI budget (db/010) still applies to every account.
// Protection: strict validation, a honeypot field ("website", hidden from people), a per-IP rate limit and a
// global hourly cap (both in the database), duplicate emails return the existing position instead of a new row.

import { srv, serverConfigured } from "../lib/db.mjs";
import { clientIp, readBody, rateLimit } from "../lib/auth.mjs";
import { createHash, randomBytes } from "node:crypto";

const GUEST_CREDITS = 500, GUEST_HOURS = 48, GUEST_PER_IP = 5, GUEST_PER_DAY = 300;

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!serverConfigured()) return res.status(503).json({ error: "The waitlist is not configured on the server yet." });
  const b = readBody(req);
  if (b.action === "guest") return guest(req, res);

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

/** A guest: a demo account (no email) that expires, with credits to build a few games. Its password goes to this browser only. */
async function guest(req, res) {
  const ipHash = createHash("sha256").update(clientIp(req) + "|" + process.env.PLAYLAB_SERVER_KEY).digest("hex").slice(0, 32);
  if (!(await rateLimit("guest:" + ipHash, GUEST_PER_IP, 86400))) return res.status(429).json({ error: "This connection already made several guest accounts today. Use the one you have, or try again tomorrow." });
  if (!(await rateLimit("guest:all", GUEST_PER_DAY, 86400))) return res.status(429).json({ error: "Guest accounts are full for today. Join the waitlist and we will let you in." });
  const username = "guest_" + randomBytes(4).toString("hex"), password = randomBytes(18).toString("base64url");
  const expires = new Date(Date.now() + GUEST_HOURS * 3600_000).toISOString();
  try {
    await srv("srv_create_user", { p_email: null, p_password: password, p_username: username, p_display_name: "Guest", p_credits: GUEST_CREDITS, p_role: "user", p_is_demo: true, p_tag: "Judge", p_expires_at: expires, p_daily_limit: null });
    return res.status(200).json({ username, password, credits: GUEST_CREDITS, expires_at: expires });
  } catch (err) {
    console.error("guest:", err.message);
    return res.status(502).json({ error: "Could not make a guest account. Try again in a moment." });
  }
}
