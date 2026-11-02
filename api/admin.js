// api/admin.js — the admin panel (admin.html). Admins only: checked here and again inside every database function.
//   GET  /api/admin?action=overview                              -> { overview }
//   GET  /api/admin?action=waitlist&status=&search=              -> { waitlist }
//   GET  /api/admin?action=users&search=&demo=                   -> { users }
//   GET  /api/admin?action=ledger&user=&kind=&offset=            -> { ledger }
//   GET  /api/admin?action=pricing                               -> { costs, models }
//   GET  /api/admin?action=activity&offset=                      -> { activity }
//   POST /api/admin { action: "waitlist_set", ids, status, credits }
//                   { action: "waitlist_invited", ids }
//                   { action: "user_create", email?, username?, password, display_name?, credits?, role?, is_demo?, tag?, note?, expires_at?, daily_limit? }
//                   { action: "user_set", id, status?, role?, expires_at?, clear_expiry?, daily_limit?, clear_daily_limit? }
//                   { action: "user_password", id, password }
//                   { action: "user_delete", id }
//                   { action: "credits", ids, amount, reason }
//                   { action: "cost_set", key, credits, label? }
//                   { action: "model_set", id, multiplier?, enabled?, is_default?, label?, description? }

import { requireUser, readBody } from "../lib/auth.mjs";
import { rest, rpc } from "../lib/db.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v, max = 200) => (v === undefined || v === null || v === "" ? null : String(v).trim().slice(0, max));
const int = (v) => (v === undefined || v === null || v === "" ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const bool = (v) => (v === undefined || v === null ? null : !!v);
const date = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const ids = (v, re) => (Array.isArray(v) ? v.map(String).filter((x) => re.test(x)).slice(0, 500) : []);
const bad = (res, error) => res.status(400).json({ error });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const ctx = await requireUser(req, res, { admin: true });
  if (!ctx) return;
  const call = (fn, args = {}) => rpc(fn, args, ctx.token);
  try {
    if (req.method === "GET") {
      const q = req.query || {};
      const offset = Math.max(0, int(q.offset) || 0);
      switch (q.action) {
        case "overview": return res.status(200).json({ overview: await call("admin_overview") });
        case "waitlist": return res.status(200).json({ waitlist: await call("admin_list_waitlist", { p_status: str(q.status, 20), p_search: str(q.search, 80), p_limit: 300, p_offset: offset }) });
        case "users": return res.status(200).json({ users: await call("admin_list_users", { p_search: str(q.search, 80), p_demo: q.demo === "1" ? true : q.demo === "0" ? false : null, p_limit: 300, p_offset: offset }) });
        case "ledger": {
          const user = UUID.test(String(q.user || "")) ? String(q.user) : null;
          return res.status(200).json({ ledger: await call("admin_list_ledger", { p_user: user, p_action: str(q.kind, 40), p_limit: 200, p_offset: offset }) });
        }
        case "pricing": {
          const [costs, models] = await Promise.all([rest("/costs?select=action,credits,label,sort,updated_at&order=sort.asc", { token: ctx.token }), call("admin_list_models")]);
          return res.status(200).json({ costs, models: models.map((m) => ({ ...m, multiplier: Number(m.multiplier) })) });
        }
        case "activity": return res.status(200).json({ activity: await call("admin_list_activity", { p_limit: 100, p_offset: offset }) });
        default: return bad(res, "Unknown action.");
      }
    }

    if (req.method === "POST") {
      const b = readBody(req);
      switch (b.action) {
        case "waitlist_set": {
          if (!["approved", "rejected", "pending"].includes(b.status)) return bad(res, "Pick approve, reject or pending.");
          const list = ids(b.ids, /^\d+$/).map(Number); if (!list.length) return bad(res, "Select at least one person.");
          const credits = int(b.credits); if (Number.isNaN(credits)) return bad(res, "Starting credits must be a number.");
          return res.status(200).json({ updated: await call("admin_set_waitlist", { p_ids: list, p_status: b.status, p_credits: credits ?? 200 }) });
        }
        case "waitlist_invited": {
          const list = ids(b.ids, /^\d+$/).map(Number); if (!list.length) return bad(res, "Select at least one person.");
          return res.status(200).json({ updated: await call("admin_mark_invited", { p_ids: list }) });
        }
        case "user_create": {
          const username = str(b.username, 24)?.toLowerCase() || null, email = str(b.email, 254)?.toLowerCase() || null;
          if (!email && !username) return bad(res, "Give an email or a username.");
          if (username && !/^[a-z0-9_]{3,24}$/.test(username)) return bad(res, "Usernames are 3-24 letters, digits or _.");
          if (email && !/^\S+@\S+\.\S{2,}$/.test(email)) return bad(res, "That email does not look right.");
          if (String(b.password || "").length < 10) return bad(res, "Passwords need at least 10 characters.");
          const credits = int(b.credits), daily = int(b.daily_limit);
          if (Number.isNaN(credits) || Number.isNaN(daily)) return bad(res, "Credits and daily limit must be numbers.");
          const tag = ["Judge", "Tester", "Partner"].includes(b.tag) ? b.tag : null;
          const id = await call("admin_create_user", {
            p_email: email, p_password: String(b.password), p_username: username, p_display_name: str(b.display_name, 60), p_credits: credits ?? 200,
            p_role: b.role === "admin" ? "admin" : "user", p_is_demo: !!b.is_demo, p_tag: b.is_demo ? tag : null, p_note: str(b.note, 500),
            p_expires_at: date(b.expires_at), p_daily_limit: daily,
          });
          return res.status(200).json({ id });
        }
        case "user_set": {
          if (!UUID.test(String(b.id || ""))) return bad(res, "Unknown user.");
          if (b.status && !["active", "suspended", "banned"].includes(b.status)) return bad(res, "Bad status.");
          if (b.role && !["user", "admin"].includes(b.role)) return bad(res, "Bad role.");
          const daily = int(b.daily_limit); if (Number.isNaN(daily) || daily < 0) return bad(res, "The daily limit must be 0 or more.");
          const user = await call("admin_set_user", {
            p_user: b.id, p_status: b.status || null, p_role: b.role || null, p_expires_at: date(b.expires_at), p_clear_expiry: !!b.clear_expiry,
            p_daily_limit: daily, p_clear_daily_limit: !!b.clear_daily_limit,
          });
          return res.status(200).json({ user });
        }
        case "user_password": {
          if (!UUID.test(String(b.id || ""))) return bad(res, "Unknown user.");
          if (String(b.password || "").length < 10) return bad(res, "Passwords need at least 10 characters.");
          await call("admin_set_password", { p_user: b.id, p_password: String(b.password) });
          return res.status(200).json({ ok: true });
        }
        case "user_delete": {
          if (!UUID.test(String(b.id || ""))) return bad(res, "Unknown user.");
          await call("admin_delete_user", { p_user: b.id });
          return res.status(200).json({ ok: true });
        }
        case "credits": {
          const list = ids(b.ids, UUID); if (!list.length) return bad(res, "Select at least one user.");
          const amount = int(b.amount); if (!amount || Number.isNaN(amount)) return bad(res, "Give a number of credits (negative to take some away).");
          if (!str(b.reason) || str(b.reason).length < 2) return bad(res, "Say why (it goes into the user's credit history).");
          return res.status(200).json({ updated: await call("admin_grant_credits", { p_users: list, p_amount: amount, p_reason: str(b.reason) }) });
        }
        case "cost_set": {
          const credits = int(b.credits); if (credits === null || Number.isNaN(credits)) return bad(res, "Give a price in credits.");
          return res.status(200).json({ cost: await call("admin_set_cost", { p_action: str(b.key, 40), p_credits: credits, p_label: str(b.label, 80) }) });
        }
        case "model_set": {
          const mult = b.multiplier === undefined || b.multiplier === "" ? null : Number(b.multiplier);
          if (mult !== null && !(mult > 0 && mult <= 20)) return bad(res, "The multiplier must be above 0 and at most 20.");
          const model = await call("admin_set_model", { p_id: str(b.id, 60), p_multiplier: mult, p_enabled: bool(b.enabled), p_is_default: bool(b.is_default), p_label: str(b.label, 80), p_description: str(b.description, 200) });
          return res.status(200).json({ model: { ...model, multiplier: Number(model.multiplier) } });
        }
        default: return bad(res, "Unknown action.");
      }
    }
    return res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    // Database checks (raise exception '...') come back as readable sentences: pass them on.
    const msg = String(err.detail || err.message || "");
    if (err.status === 403) return res.status(403).json({ error: "Admins only." });
    if (/already has an account|duplicate key|unique/i.test(msg)) return res.status(409).json({ error: /username/i.test(msg) ? "That username is taken." : "That email already has an account." });
    if (err.status === 400 || /password too short|bad |cannot|no such|must|required|pick another/i.test(msg)) return res.status(400).json({ error: msg.replace(/^.*?:\s*/, "").slice(0, 200) || "Not allowed." });
    console.error("admin:", msg);
    return res.status(502).json({ error: "Database error. Try again." });
  }
}
