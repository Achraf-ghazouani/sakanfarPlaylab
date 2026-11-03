// shared/auth.js — login state in the browser (classic script: window.PlayAuth). Needs supabase-js (UMD) on the page.
// The browser only holds the user's own session. Every decision (approved? admin? enough credits?) is made by
// the server, which re-checks the token and the profile on each call; this file just carries the token and
// reacts to the server's answer (401 -> log in again, 403 blocked -> sign out and explain).
window.PlayAuth = (() => {
  const BLOCK_MESSAGES = {
    no_profile: "Your access request is still pending.",
    pending: "Your access request is still pending.",
    not_approved: "This email has no access yet. If you joined the waitlist, your request is still pending.",
    suspended: "Your access is paused. Contact us if you think this is a mistake.",
    banned: "This account has been closed.",
    expired: "This demo account has expired. Thanks for trying Sakanfar PlayLab!",
  };
  let client = null, loading = null, profile = null;

  async function waitFor(test, ms = 10000) { const t0 = Date.now(); while (!test()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 50)); } return true; }

  /** The Supabase client (created once, from the public config served by api/config). */
  function load() {
    if (client) return Promise.resolve(client);
    loading ||= (async () => {
      const cfg = await fetch("api/config", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
      if (!cfg.supabase) throw new Error("Accounts are not configured on this server.");
      if (!(await waitFor(() => window.supabase?.createClient))) throw new Error("Could not load the login library. Check your connection.");
      client = window.supabase.createClient(cfg.supabase.url, cfg.supabase.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      return client;
    })();
    return loading;
  }
  async function session() { const c = await load(); const { data } = await c.auth.getSession(); return data.session || null; }
  async function token() { return (await session())?.access_token || ""; }

  /** Quick check without loading anything: is there a stored session? (for showing "Open Studio" vs "Join the waitlist") */
  function hasStoredSession() {
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^sb-.+-auth-token$/.test(k) && localStorage.getItem(k)) return true; } } catch {}
    return false;
  }

  function goLogin(extra = "") {
    const here = location.pathname.split("/").pop() + location.search;
    location.href = "login.html?next=" + encodeURIComponent(here || "studio.html") + extra;
  }
  async function signOut() { try { await (await load()).auth.signOut(); } catch {} profile = null; }

  /**
   * fetch() for our API with the user's token. Handles the server's verdict:
   *   401 { login }   -> go to the login page
   *   403 { blocked } -> sign out, go to the login page with the reason
   * Returns the Response for everything else.
   */
  async function api(path, init = {}) {
    const t = await token();
    const headers = { ...(init.headers || {}) };
    if (t) headers.Authorization = "Bearer " + t;
    if (init.body !== undefined && typeof init.body !== "string") { headers["Content-Type"] = "application/json"; init = { ...init, body: JSON.stringify(init.body) }; }
    const res = await fetch(path, { ...init, headers });
    if (res.status === 401 || res.status === 403) {
      const data = await res.clone().json().catch(() => ({}));
      if (res.status === 401 && data.login) { goLogin(); return new Promise(() => {}); }
      if (res.status === 403 && data.blocked) { await signOut(); goLogin("&blocked=" + encodeURIComponent(data.blocked)); return new Promise(() => {}); }
    }
    return res;
  }

  /** The profile from the server (cached for the page). */
  async function me(force = false) {
    if (profile && !force) return profile;
    const r = await api("api/me");
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Could not load your account.");
    return (profile = Object.assign(data.profile, { cap: data.cap }));   // cap: the shared daily budget (db/010), for the Studio's note
  }

  /** Pages that need an account call this first. Resolves with the profile, or navigates to the login page. */
  async function requireLogin({ admin = false } = {}) {
    let s = null;
    try { s = await session(); } catch {}
    if (!s) { goLogin(); return new Promise(() => {}); }
    const p = await me();
    if (admin && p.role !== "admin") { location.href = "studio.html"; return new Promise(() => {}); }
    return p;
  }

  return { load, session, token, api, me, requireLogin, signOut, hasStoredSession, goLogin, BLOCK_MESSAGES,
    /** username -> the synthetic email used by demo accounts; emails pass through. */
    loginEmail: (u) => { u = String(u || "").trim(); return u.includes("@") ? u.toLowerCase() : u.toLowerCase() + "@demo.playlab.invalid"; } };
})();
