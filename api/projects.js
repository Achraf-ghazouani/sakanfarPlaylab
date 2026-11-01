// api/projects.js — studio projects (a chat + its game), stored in Supabase through lib/db.mjs.
//   GET    /api/projects                 -> { projects: [...] }                         (owner's list)
//   GET    /api/projects?id=UUID         -> { project, messages, versions }
//   POST   /api/projects {title?, level?, photo?, mode?}            -> { project }
//   PATCH  /api/projects {id, title?, level?, photo?, mode?, note?} -> { project, version? }  (a level change adds a version)
//   DELETE /api/projects?id=UUID         -> { ok: true }
// The caller must be logged in (Authorization: Bearer <Supabase access token>); rows are theirs through row-level security.

import { normalizeLevel } from "../lib/scan-level.mjs";
import * as db from "../lib/db.mjs";
import { requireUser } from "../lib/auth.mjs";

const MAX_PHOTO = 200_000;   // data URL chars (a 480px JPEG is ~40 KB)

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!db.dbConfigured()) return res.status(503).json({ error: "Database not configured on the server (SUPABASE_URL / SUPABASE_ANON_KEY)." });
  const owner = await requireUser(req, res);   // the logged-in caller (ctx: token, uid, profile)
  if (!owner) return;

  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  const id = req.query?.id || body?.id;
  try {
    if (req.method === "GET") {
      if (!id) return res.status(200).json({ projects: await db.listProjects(owner) });
      const project = await db.getProject(owner, id);
      if (!project) return res.status(404).json({ error: "Project not found." });
      const [messages, versions] = await Promise.all([db.listMessages(owner, id), db.listVersions(owner, id)]);
      return res.status(200).json({ project, messages, versions });
    }
    if (req.method === "POST") {
      const fields = pickFields(body);
      if (fields.error) return res.status(400).json({ error: fields.error });
      const project = await db.createProject(owner, fields);
      let version = null;
      if (fields.level) version = await db.addVersion(owner, project.id, fields.level, body.note || "created");
      return res.status(200).json({ project, version });
    }
    if (req.method === "PATCH") {
      if (!id) return res.status(400).json({ error: "id is required." });
      const fields = pickFields(body);
      if (fields.error) return res.status(400).json({ error: fields.error });
      const project = await db.updateProject(owner, id, fields);
      if (!project) return res.status(404).json({ error: "Project not found." });
      let version = null;
      if (fields.level) version = await db.addVersion(owner, id, fields.level, body.note || "edited");
      return res.status(200).json({ project, version });
    }
    if (req.method === "DELETE") {
      if (!id) return res.status(400).json({ error: "id is required." });
      await db.deleteProject(owner, id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "Use GET, POST, PATCH or DELETE." });
  } catch (err) {
    console.error("projects:", err.message);
    return res.status(err.status || 502).json({ error: err.status === 403 ? "Not allowed." : "Database error: " + err.message.slice(0, 160) });
  }
}

function pickFields(body) {
  const out = {};
  if (body.title !== undefined) { const t = String(body.title).trim().slice(0, 80); if (!t) return { error: "Title cannot be empty." }; out.title = t; }
  if (body.mode !== undefined) { if (!["2d", "3d-side", "3d-world"].includes(body.mode)) return { error: "Unknown mode." }; out.mode = body.mode; }
  if (body.level !== undefined && body.level !== null) {
    if (!body.level || !Array.isArray(body.level.objects) || body.level.objects.length > 300) return { error: "level must have an objects array." };
    const lvl = normalizeLevel(body.level, { aspect: body.level.aspect });
    for (const k of ["checked", "fixes", "diff"]) if (body.level[k] !== undefined) lvl[k] = body.level[k];
    out.level = lvl;
  }
  if (body.photo !== undefined) {
    if (body.photo !== null && (typeof body.photo !== "string" || !body.photo.startsWith("data:image/") || body.photo.length > MAX_PHOTO)) return { error: "photo must be a small image data URL." };
    out.photo = body.photo;
  }
  if (body.rules !== undefined) out.rules = body.rules && typeof body.rules === "object" ? body.rules : null;
  if (body.art !== undefined) out.art = body.art && typeof body.art === "object" ? body.art : null;
  return out;
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
