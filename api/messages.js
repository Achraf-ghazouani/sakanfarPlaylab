// api/messages.js — chat messages of a studio project.
//   GET  /api/messages?project_id=UUID            -> { messages }
//   POST /api/messages {project_id, role, content, meta?} -> { message }

import * as db from "../lib/db.mjs";
import { requireUser } from "../lib/auth.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const owner = await requireUser(req, res);   // the logged-in caller (ctx: token, uid, profile)
  if (!owner) return;
  if (!db.dbConfigured()) return res.status(503).json({ error: "Database not configured on the server." });
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  try {
    if (req.method === "GET") {
      const pid = req.query?.project_id;
      if (!pid) return res.status(400).json({ error: "project_id is required." });
      return res.status(200).json({ messages: await db.listMessages(owner, pid) });
    }
    if (req.method === "POST") {
      const { project_id, role, content, meta } = body;
      if (!project_id || !["user", "assistant", "system", "tool"].includes(role)) return res.status(400).json({ error: "project_id and a valid role are required." });
      const text = String(content || "").slice(0, 8000);
      const message = await db.addMessage(owner, project_id, { role, content: text, meta: meta && typeof meta === "object" ? meta : null });
      return res.status(200).json({ message });
    }
    return res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    console.error("messages:", err.message);
    return res.status(err.status || 502).json({ error: err.status === 403 ? "Not allowed." : "Database error: " + err.message.slice(0, 160) });
  }
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
