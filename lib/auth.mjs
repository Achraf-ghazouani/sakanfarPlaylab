// lib/auth.mjs — who is calling, and may they? Server-side only.
// Every API that costs money or touches private data calls requireUser(): the access token is checked with
// Supabase Auth, then the profile is read from the database (me()), and blocked accounts (suspended, banned,
// expired demo, no profile) are refused. Roles are read from the database, never from the browser.

import { authApi, rpc, srv, serverConfigured, dbConfigured } from "./db.mjs";

const userCache = new Map();   // token -> { user, at }   (Supabase /user lookups are ~100 ms; keep them 30 s)
const CACHE_MS = 30_000;

export function bearer(req) {
  const h = String(req.headers?.authorization || req.headers?.Authorization || "");
  const m = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(h.trim());
  return m ? m[1] : "";
}

/** The Supabase user for a token, or null. */
export async function userFromToken(token) {
  if (!token) return null;
  const hit = userCache.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
  let user = null;
  try { user = await authApi("/user", { token }); } catch (err) { if (err.status && err.status < 500) user = null; else throw err; }
  if (userCache.size > 500) userCache.clear();
  userCache.set(token, { user, at: Date.now() });
  return user;
}

/** ADMIN_EMAILS env -> database, once per server process (the database trigger and role checks read it there). */
let adminsSynced = null;
export function syncAdmins() {
  if (adminsSynced) return adminsSynced;
  const emails = String(process.env.ADMIN_EMAILS || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length || !serverConfigured()) return (adminsSynced = Promise.resolve(0));
  adminsSynced = srv("srv_sync_admins", { p_emails: emails }).catch((err) => { console.warn("admin sync failed:", err.message); adminsSynced = null; return 0; });
  return adminsSynced;
}

export const BLOCK_MESSAGES = {
  no_profile: "Your access request is still pending.",
  suspended: "Your access is paused. Contact us if you think this is a mistake.",
  banned: "This account has been closed.",
  expired: "This demo account has expired. Thanks for trying Sakanfar PlayLab!",
};

/**
 * Check the caller. On success returns ctx { token, uid, email, profile }; otherwise sends the error response
 * (401 not logged in, 403 blocked or not an admin) and returns null.
 */
export async function requireUser(req, res, { admin = false } = {}) {
  if (!dbConfigured()) { res.status(503).json({ error: "Accounts are not configured on the server." }); return null; }
  const token = bearer(req);
  if (!token) { res.status(401).json({ error: "Please log in.", login: true }); return null; }
  let user;
  try { user = await userFromToken(token); } catch { res.status(502).json({ error: "Could not check your login. Try again." }); return null; }
  if (!user?.id) { res.status(401).json({ error: "Your session has expired. Please log in again.", login: true }); return null; }
  await syncAdmins();
  let profile;
  try { profile = await rpc("me", {}, token); } catch (err) { res.status(err.status === 403 ? 401 : 502).json({ error: "Could not load your account." }); return null; }
  if (!profile || profile.blocked) {
    const reason = profile?.blocked || "no_profile";
    res.status(403).json({ error: BLOCK_MESSAGES[reason] || "Access denied.", blocked: reason });
    return null;
  }
  if (admin && profile.role !== "admin") { res.status(403).json({ error: "Admins only." }); return null; }
  return { token, uid: user.id, email: user.email, profile };
}

/** The caller's IP as seen by Vercel (x-real-ip / first x-forwarded-for), or the socket address in dev. */
export function clientIp(req) {
  const h = req.headers || {};
  return String(h["x-real-ip"] || String(h["x-forwarded-for"] || "").split(",")[0] || req.socket?.remoteAddress || "unknown").trim().slice(0, 64);
}

/** Per-IP (or any key) rate limit backed by the database. Returns true when allowed. Fails open if the server key is missing. */
export async function rateLimit(bucket, max, windowSeconds) {
  if (!serverConfigured()) return true;
  try { return !!(await srv("srv_rate_limit", { p_bucket: bucket, p_max: max, p_window_seconds: windowSeconds })); }
  catch (err) { console.warn("rate limit check failed:", err.message); return true; }
}

export function readBody(req) {
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}
