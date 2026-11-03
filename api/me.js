// api/me.js — the logged-in account.
//   GET   /api/me             -> { profile, cap }                   (403 { blocked } when the account may not be used;
//                                                                     cap: the shared daily budget { cap, spent_today, reached, resets_at })
//   GET   /api/me?ledger=1    -> { profile, ledger: [...] }          (credit history, newest first)
//   PATCH /api/me { username?, display_name?, avatar_url? } -> { profile }

import { requireUser, readBody } from "../lib/auth.mjs";
import { rest, rpc } from "../lib/db.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  try {
    if (req.method === "GET") {
      const out = { profile: ctx.profile };
      try { out.cap = await rpc("cap_status", {}, ctx.token); } catch (err) { console.warn("cap_status:", err.message); }   // absent until db/010 runs
      if (req.query?.ledger) out.ledger = await rest(`/credit_ledger?select=id,amount,balance_after,reason,action,model,game_id,created_at&order=id.desc&limit=100`, { token: ctx.token });
      return res.status(200).json(out);
    }
    if (req.method === "PATCH") {
      const b = readBody(req);
      const args = { p_username: null, p_display_name: null, p_avatar_url: null };
      if (b.username !== undefined) {
        const u = String(b.username || "").trim().toLowerCase();
        if (u && !/^[a-z0-9_]{3,24}$/.test(u)) return res.status(400).json({ error: "Usernames are 3-24 letters, digits or _.", field: "username" });
        args.p_username = u;
      }
      if (b.display_name !== undefined) args.p_display_name = String(b.display_name || "").trim().slice(0, 60);
      if (b.avatar_url !== undefined) {
        const a = String(b.avatar_url || "");
        if (a && (!/^data:image\/(png|jpeg|webp);base64,/.test(a) || a.length > 60000)) return res.status(400).json({ error: "Avatar must be a small image.", field: "avatar_url" });
        args.p_avatar_url = a;
      }
      const profile = await rpc("update_my_profile", args, ctx.token);
      return res.status(200).json({ profile });
    }
    return res.status(405).json({ error: "Use GET or PATCH." });
  } catch (err) {
    if (/duplicate key|unique/i.test(err.detail || err.message)) return res.status(409).json({ error: "That username is taken.", field: "username" });
    console.error("me:", err.message);
    return res.status(err.status || 502).json({ error: err.status === 403 ? "Not allowed." : "Could not update your profile." });
  }
}
