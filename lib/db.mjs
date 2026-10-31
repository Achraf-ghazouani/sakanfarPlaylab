// lib/db.mjs — tiny Supabase REST (PostgREST) client for the studio tables. Server-side only.
// No dependency: plain fetch. Every call carries the owner token in x-owner, which the row-level
// security policies compare with the row's owner column.

const url = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = () => process.env.SUPABASE_ANON_KEY || "";

export function dbConfigured() { return !!(url() && key()); }

/**
 * Perform a PostgREST request. `path` is "/projects?select=..." etc.
 * Returns parsed JSON (or null for 204). Throws Error with .status on failure.
 */
export async function rest(path, { method = "GET", body, owner = "", prefer } = {}) {
  if (!dbConfigured()) { const e = new Error("Database not configured (SUPABASE_URL / SUPABASE_ANON_KEY)."); e.status = 503; throw e; }
  const headers = { apikey: key(), Authorization: `Bearer ${key()}`, "Content-Type": "application/json", "x-owner": owner };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url()}/rest/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`db ${method} ${path.split("?")[0]} -> ${res.status}: ${text.slice(0, 200)}`);
    e.status = res.status === 401 || res.status === 403 ? 403 : 502;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

export async function rpc(name, args, owner = "") {
  return rest(`/rpc/${name}`, { method: "POST", body: args, owner });
}

const q = (v) => encodeURIComponent(v);

// ---- projects ----
export const PROJECT_FIELDS = "id,title,mode,photo,share_id,play_count,created_at,updated_at";

export function listProjects(owner) {
  return rest(`/projects?select=${PROJECT_FIELDS}&order=updated_at.desc&limit=100`, { owner });
}
export async function getProject(owner, id) {
  const rows = await rest(`/projects?id=eq.${q(id)}&select=*`, { owner });
  return rows[0] || null;
}
export async function getSharedProject(shareId) {
  const rows = await rest(`/projects?share_id=eq.${q(shareId)}&select=id,title,mode,level,photo,art,rules,share_id,play_count,created_at`);
  return rows[0] || null;
}
export async function createProject(owner, fields) {
  const rows = await rest("/projects", { method: "POST", owner, body: { owner, ...fields }, prefer: "return=representation" });
  return rows[0];
}
export async function updateProject(owner, id, fields) {
  const rows = await rest(`/projects?id=eq.${q(id)}`, { method: "PATCH", owner, body: { ...fields, updated_at: new Date().toISOString() }, prefer: "return=representation" });
  return rows[0] || null;
}
export function deleteProject(owner, id) {
  return rest(`/projects?id=eq.${q(id)}`, { method: "DELETE", owner });
}

// ---- messages ----
export function listMessages(owner, projectId, limit = 200) {
  return rest(`/messages?project_id=eq.${q(projectId)}&select=id,role,content,meta,created_at&order=id.asc&limit=${limit}`, { owner });
}
export async function addMessage(owner, projectId, { role, content = "", meta = null }) {
  const rows = await rest("/messages", { method: "POST", owner, body: { project_id: projectId, role, content, meta }, prefer: "return=representation" });
  return rows[0];
}

// ---- versions ----
export function listVersions(owner, projectId) {
  return rest(`/versions?project_id=eq.${q(projectId)}&select=id,n,note,created_at&order=n.desc&limit=100`, { owner });
}
export async function getVersion(owner, projectId, n) {
  const rows = await rest(`/versions?project_id=eq.${q(projectId)}&n=eq.${Number(n)}&select=*`, { owner });
  return rows[0] || null;
}
export async function addVersion(owner, projectId, level, note = "") {
  const last = await rest(`/versions?project_id=eq.${q(projectId)}&select=n&order=n.desc&limit=1`, { owner });
  const n = (last[0]?.n || 0) + 1;
  const rows = await rest("/versions", { method: "POST", owner, body: { project_id: projectId, n, level, note }, prefer: "return=representation" });
  return rows[0];
}
