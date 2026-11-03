// lib/db.mjs — tiny Supabase client for the server (PostgREST + Auth). Server-side only, no dependency.
//
// Three ways to talk to the database:
//   * as the user:   their access token in Authorization, so row-level security and auth.uid() apply
//   * as a visitor:  the publishable (anon) key only, for public data (shared games)
//   * as the server: srv_* functions with PLAYLAB_SERVER_KEY, for the few server-only jobs (waitlist, rate limits)
// "ctx" below is { token, uid } from lib/auth.mjs requireUser().

const url = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const anonKey = () => process.env.SUPABASE_ANON_KEY || "";
const serverKey = () => process.env.PLAYLAB_SERVER_KEY || "";

export function dbConfigured() { return !!(url() && anonKey()); }
export function serverConfigured() { return dbConfigured() && serverKey().length >= 32; }

/**
 * Perform a PostgREST request. `path` is "/projects?select=..." etc.
 * Returns parsed JSON (or null for 204). Throws Error with .status on failure.
 */
export async function rest(path, { method = "GET", body, token = "", prefer } = {}) {
  if (!dbConfigured()) { const e = new Error("Database not configured (SUPABASE_URL / SUPABASE_ANON_KEY)."); e.status = 503; throw e; }
  const headers = { apikey: anonKey(), Authorization: `Bearer ${token || anonKey()}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url()}/rest/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) {
    let detail = text; try { const j = JSON.parse(text); detail = j.message || j.hint || text; } catch {}
    const e = new Error(`db ${method} ${path.split("?")[0]} -> ${res.status}: ${String(detail).slice(0, 200)}`);
    e.status = res.status === 401 || res.status === 403 || /42501|not allowed|admins only/i.test(text) ? 403 : res.status === 400 ? 400 : 502;
    e.detail = String(detail);
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

export function rpc(name, args = {}, token = "") { return rest(`/rpc/${name}`, { method: "POST", body: args, token }); }

/** Server-only function: the server key is added here and never leaves the server. */
export function srv(name, args = {}) {
  if (!serverConfigured()) { const e = new Error("Server key missing (PLAYLAB_SERVER_KEY)."); e.status = 503; throw e; }
  return rpc(name, { p_key: serverKey(), ...args });
}

/** Supabase Auth REST call (login, user lookup). */
export async function authApi(path, { method = "GET", body, token = "" } = {}) {
  const headers = { apikey: anonKey(), "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${url()}/auth/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) { const e = new Error(`auth ${path.split("?")[0]} -> ${res.status}: ${(data?.msg || data?.error_description || data?.message || text).slice(0, 200)}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

const q = (v) => encodeURIComponent(v);

// ---- projects ----
export const PROJECT_FIELDS = "id,title,mode,photo,share_id,play_count,like_count,visibility,kind,description,published_at,created_at,updated_at";

export function listProjects(ctx) {   // owner filter: RLS also lets a login read everyone's published games (008), My games is only theirs
  return rest(`/projects?owner=eq.${q(ctx.uid)}&select=${PROJECT_FIELDS}&order=updated_at.desc&limit=100`, { token: ctx.token });
}
export async function getProject(ctx, id) {
  const rows = await rest(`/projects?id=eq.${q(id)}&owner=eq.${q(ctx.uid)}&select=*`, { token: ctx.token });
  return rows[0] || null;
}
export async function createProject(ctx, fields) {
  const rows = await rest("/projects", { method: "POST", token: ctx.token, body: { ...fields, owner: ctx.uid }, prefer: "return=representation" });
  return rows[0];
}
export async function updateProject(ctx, id, fields) {
  const rows = await rest(`/projects?id=eq.${q(id)}&owner=eq.${q(ctx.uid)}`, { method: "PATCH", token: ctx.token, body: { ...fields, updated_at: new Date().toISOString() }, prefer: "return=representation" });
  return rows[0] || null;
}
export function deleteProject(ctx, id) {
  return rest(`/projects?id=eq.${q(id)}&owner=eq.${q(ctx.uid)}`, { method: "DELETE", token: ctx.token });
}

// ---- messages ----
export function listMessages(ctx, projectId, limit = 200) {
  return rest(`/messages?project_id=eq.${q(projectId)}&select=id,role,content,meta,created_at&order=id.asc&limit=${limit}`, { token: ctx.token });
}
export async function addMessage(ctx, projectId, { role, content = "", meta = null }) {
  const rows = await rest("/messages", { method: "POST", token: ctx.token, body: { project_id: projectId, role, content, meta }, prefer: "return=representation" });
  return rows[0];
}

// ---- versions ----
export function listVersions(ctx, projectId) {
  return rest(`/versions?project_id=eq.${q(projectId)}&select=id,n,note,created_at&order=n.desc&limit=100`, { token: ctx.token });
}
export async function getVersion(ctx, projectId, n) {
  const rows = await rest(`/versions?project_id=eq.${q(projectId)}&n=eq.${Number(n)}&select=*`, { token: ctx.token });
  return rows[0] || null;
}
export async function addVersion(ctx, projectId, level, note = "") {
  const last = await rest(`/versions?project_id=eq.${q(projectId)}&select=n&order=n.desc&limit=1`, { token: ctx.token });
  const n = (last[0]?.n || 0) + 1;
  const rows = await rest("/versions", { method: "POST", token: ctx.token, body: { project_id: projectId, n, level, note }, prefer: "return=representation" });
  return rows[0];
}
