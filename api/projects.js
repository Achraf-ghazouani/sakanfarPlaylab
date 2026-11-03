// api/projects.js — studio projects (a chat + its game), stored in Supabase through lib/db.mjs.
//   GET    /api/projects                 -> { projects: [...] }                         (owner's list)
//   GET    /api/projects?id=UUID         -> { project, messages, versions }
//   POST   /api/projects {title?, level?, photo?, mode?}            -> { project }
//   POST   /api/projects {claim: "u-<24 hex>"}                      -> { claimed }  (games made before accounts, from this browser's old id)
//   PATCH  /api/projects {id, title?, level?, photo?, mode?, note?} -> { project, version? }  (a level change adds a version)
//   PATCH  /api/projects {id, publish: {visibility, description?, cover?, og_image?, title?}} -> { project }  (public | unlisted, at /play/<share_id>)
//   PATCH  /api/projects {id, unpublish: true}                       -> { project }
//   GET    /api/projects?id=UUID&version=3                            -> { version }  (one saved version)
//   DELETE /api/projects?id=UUID         -> { ok: true }
// The caller must be logged in (Authorization: Bearer <Supabase access token>); rows are theirs through row-level security.

import { normalizeLevel } from "../lib/scan-level.mjs";
import { normalizeArena } from "../shared/arena.mjs";
import { ASSET_ROLES } from "../lib/image.mjs";
import * as db from "../lib/db.mjs";
import { requireUser } from "../lib/auth.mjs";

const MAX_PHOTO = 200_000;   // data URL chars (a 480px JPEG is ~40 KB)
const MAX_SPRITE = 400_000;  // data URL chars for the player picture (a 256px PNG is ~50-150 KB)
const MAX_ART = 6_000_000;   // the whole art object: player + object sprites (~30-120 KB each) + the asset list below
const MAX_ASSET = 1_400_000; // one asset picture (a background JPEG, a tileset or a UI piece as PNG)
const MAX_ASSETS = 40;
const SPRITE_ROLES = new Set(["enemy", "coin", "goal", "spike", "decoration"]);

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
      if (req.query?.version !== undefined) {
        const n = Number(req.query.version);
        if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "version must be a number from 1." });
        const version = await db.getVersion(owner, id, n);
        return version ? res.status(200).json({ version }) : res.status(404).json({ error: "Version not found." });
      }
      const project = await db.getProject(owner, id);
      if (!project) return res.status(404).json({ error: "Project not found." });
      const [messages, versions] = await Promise.all([db.listMessages(owner, id), db.listVersions(owner, id)]);
      return res.status(200).json({ project, messages, versions });
    }
    if (req.method === "POST") {
      if (typeof body.claim === "string") {   // first login: the browser's pre-accounts id hands its games to the account
        if (!/^u-[0-9a-f]{24}$/.test(body.claim)) return res.status(400).json({ error: "Not an anonymous owner id." });
        if (!db.serverConfigured()) return res.status(200).json({ claimed: 0 });
        const claimed = await db.srv("srv_claim_projects", { p_owner: body.claim, p_user: owner.uid });
        return res.status(200).json({ claimed: Number(claimed) || 0 });
      }
      const fields = pickFields(body);
      if (fields.error) return res.status(400).json({ error: fields.error });
      const project = await db.createProject(owner, fields);
      let version = null;
      if (fields.level) version = await db.addVersion(owner, project.id, fields.level, body.note || "created");
      return res.status(200).json({ project, version });
    }
    if (req.method === "PATCH") {
      if (!id) return res.status(400).json({ error: "id is required." });
      if (body.unpublish) {
        const project = await db.updateProject(owner, id, { visibility: "private" });
        return project ? res.status(200).json({ project }) : res.status(404).json({ error: "Project not found." });
      }
      if (body.publish && typeof body.publish === "object") {
        const p = body.publish, fields = {};
        if (!["public", "unlisted"].includes(p.visibility)) return res.status(400).json({ error: "visibility must be public or unlisted." });
        fields.visibility = p.visibility;
        if (p.title !== undefined) { const t = String(p.title).trim().slice(0, 80); if (!t) return res.status(400).json({ error: "Title cannot be empty." }); fields.title = t; }
        if (p.description !== undefined) fields.description = String(p.description || "").trim().slice(0, 300) || null;
        for (const [k, max] of [["cover", 250_000], ["og_image", 400_000]]) {
          if (p[k] === undefined) continue;
          if (p[k] !== null && (typeof p[k] !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(p[k]) || p[k].length > max)) return res.status(400).json({ error: `${k} must be a small image data URL.` });
          fields[k] = p[k];
        }
        const current = await db.getProject(owner, id);
        if (!current) return res.status(404).json({ error: "Project not found." });
        if (!current.level) return res.status(400).json({ error: "Build a game first: there is nothing to publish yet." });
        fields.kind = current.mode === "3d-world" ? "arena" : current.mode === "3d-side" ? "3d" : "2d";
        if (!current.share_id) fields.share_id = shortId();
        if (!current.published_at) fields.published_at = new Date().toISOString();
        const project = await db.updateProject(owner, id, fields);
        return res.status(200).json({ project });
      }
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
    const lvl = body.level.genre === "arena" ? normalizeArena(body.level) : normalizeLevel(body.level, { aspect: body.level.aspect });
    for (const k of ["checked", "fixes", "diff"]) if (body.level[k] !== undefined) lvl[k] = body.level[k];
    out.level = lvl;
  }
  if (body.photo !== undefined) {
    if (body.photo !== null && (typeof body.photo !== "string" || !body.photo.startsWith("data:image/") || body.photo.length > MAX_PHOTO)) return { error: "photo must be a small image data URL." };
    out.photo = body.photo;
  }
  if (body.rules !== undefined) out.rules = body.rules && typeof body.rules === "object" ? body.rules : null;
  if (body.art !== undefined) {
    const art = body.art && typeof body.art === "object" && !Array.isArray(body.art) ? body.art : null;
    // art.player: the player character picture (a transparent PNG/WebP from shared/cutout.js, ~256 px tall)
    const okSprite = (v) => typeof v === "string" && /^data:image\/(png|webp);base64,/.test(v) && v.length <= MAX_SPRITE;
    if (art && art.player != null && !okSprite(art.player)) return { error: "The player picture must be a small PNG or WebP image." };
    // art.sprites: one picture per object type, worn by every object of that type (Muse Image sprites, api/art.js)
    if (art && art.sprites != null) {
      if (typeof art.sprites !== "object" || Array.isArray(art.sprites)) return { error: "sprites must be an object." };
      for (const [k, v] of Object.entries(art.sprites)) {
        if (!SPRITE_ROLES.has(k)) return { error: `Unknown sprite type "${k}".` };
        if (v !== null && !okSprite(v)) return { error: `The ${k} sprite must be a small PNG or WebP image.` };
      }
    }
    // art.assets: every other picture the maker uploaded (backgrounds, tilesets, sprite sheets, UI pieces), with its role (api/art classify)
    if (art && art.assets != null) {
      if (!Array.isArray(art.assets) || art.assets.length > MAX_ASSETS) return { error: `assets must be a list of at most ${MAX_ASSETS} pictures.` };
      art.assets = art.assets.map((a) => a && typeof a === "object" ? {
        id: String(a.id || "").slice(0, 40), role: String(a.role || ""), name: String(a.name || "").slice(0, 60), hint: String(a.hint || "").slice(0, 40),
        src: a.src, w: Number(a.w) || 0, h: Number(a.h) || 0,
      } : null);
      for (const a of art.assets) {
        if (!a || !a.id || !ASSET_ROLES.includes(a.role)) return { error: "Each asset needs an id and a known role." };
        if (typeof a.src !== "string" || !/^data:image\/(png|webp|jpeg);base64,/.test(a.src) || a.src.length > MAX_ASSET) return { error: `The ${a.name || a.role} picture must be a PNG, WebP or JPEG under ${Math.round(MAX_ASSET / 1_400_000)} MB.` };
      }
    }
    if (art && JSON.stringify(art).length > MAX_ART) return { error: "Game art is too large." };
    out.art = art;
  }
  return out;
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
/** 8 characters of a-z 0-9 for /play/<id>: 2.8e12 possibilities, unique in the table. */
function shortId() { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; for (const b of crypto.getRandomValues(new Uint8Array(8))) s += a[b % 36]; return s; }
