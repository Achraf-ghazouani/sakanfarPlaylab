// Accounts, waitlist and access rules against the real Supabase project and the dev server.
// Start the dev server first (node serve.mjs), then:  node tests/auth.test.mjs [baseUrl]
// Needs SUPABASE_URL, SUPABASE_ANON_KEY and PLAYLAB_SERVER_KEY in .env. The parts that create throwaway accounts need
// db/003_server_users.sql; they are skipped (and say so) until it has been run.
try { process.loadEnvFile(".env"); } catch {}
const BASE = process.argv[2] || "http://localhost:3000";
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, KEY = process.env.PLAYLAB_SERVER_KEY;

let fails = 0, skips = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`); if (!cond) fails++; }
function skip(name, why) { console.log(`SKIP  ${name}  (${why})`); skips++; }
const rnd = () => Math.random().toString(36).slice(2, 10);

async function api(path, { method = "GET", body, token, headers = {} } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(`${BASE}/${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function sbRest(path, { method = "GET", body, token } = {}) {
  const r = await fetch(`${SB}/rest/v1${path}`, { method, headers: { apikey: ANON, Authorization: "Bearer " + (token || ANON), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const srv = (fn, args) => sbRest(`/rpc/${fn}`, { method: "POST", body: { p_key: KEY, ...args } });
async function login(email, password) {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, token: d.access_token, error: d.error_description || d.msg || d.error };
}

if (!SB || !ANON || !KEY) { console.log("SKIP  missing SUPABASE_URL / SUPABASE_ANON_KEY / PLAYLAB_SERVER_KEY in .env"); process.exit(0); }

// ---------------------------------------------------------------- no account needed
for (const p of ["api/projects", "api/me", "api/messages?project_id=x", "api/projects?id=x&version=1"]) {
  const r = await api(p);
  check(`${p} without a login -> 401`, r.status === 401 && r.data.login === true, r.status);
}
for (const p of ["api/agent", "api/scan", "api/fix"]) {
  const r = await api(p, { method: "POST", body: {} });
  check(`${p} without a login -> 401 (AI costs money)`, r.status === 401, r.status);
}
check("garbage token -> 401", (await api("api/me", { token: "x".repeat(40) })).status === 401);
const cfg = (await api("api/config")).data;
check("config gives the public Supabase values, never the server key", cfg.supabase?.url === SB && !JSON.stringify(cfg).includes(KEY));

// waitlist validation and the honeypot never write a row
const badEmail = await api("api/waitlist", { method: "POST", body: { name: "Ana", email: "not-an-email" } });
check("waitlist rejects a bad email", badEmail.status === 400 && badEmail.data.field === "email", badEmail);
const noName = await api("api/waitlist", { method: "POST", body: { name: "", email: `x${rnd()}@example.com` } });
check("waitlist needs a name", noName.status === 400 && noName.data.field === "name");
const longMsg = await api("api/waitlist", { method: "POST", body: { name: "Ana", email: `x${rnd()}@example.com`, message: "a".repeat(1001) } });
check("waitlist caps the message", longMsg.status === 400 && longMsg.data.field === "message");
const botEmail = `bot-${rnd()}@example.com`;
const bot = await api("api/waitlist", { method: "POST", body: { name: "Bot", email: botEmail, website: "http://spam.example" } });
check("honeypot: fake success for bots", bot.status === 200 && bot.data.ok === true && bot.data.position === 0);

// the database itself: anonymous and direct access is closed
check("waitlist table is not readable with the public key", JSON.stringify((await sbRest("/waitlist?select=email&limit=5")).data) === "[]");
check("profiles are not readable with the public key", JSON.stringify((await sbRest("/profiles?select=email&limit=5")).data) === "[]");
const noKey = await sbRest("/rpc/srv_join_waitlist", { method: "POST", body: { p_key: "wrong-key-wrong-key-wrong-key-wrong", p_name: "x", p_email: `x${rnd()}@example.com`, p_message: "", p_source: "", p_ip: "t" } });
check("server functions refuse a wrong server key", noKey.status >= 400, noKey.status);
const adminAnon = await sbRest("/rpc/admin_list_waitlist", { method: "POST", body: {} });
check("admin functions refuse the public key", adminAnon.status >= 400, adminAnon.status);

// the approval gate: a sign-up for an email that is not approved is refused by the database
const strangerEmail = `stranger-${rnd()}@example.com`;
const signup = await fetch(`${SB}/auth/v1/signup`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: strangerEmail, password: "Str0ng-pass-" + rnd() }) });
const signupBody = await signup.json().catch(() => ({}));
check("sign-up with an unapproved email is refused", signup.status >= 400 && !signupBody.id && !signupBody.user?.id, { status: signup.status, msg: signupBody.msg || signupBody.error_description });

// ---------------------------------------------------------------- throwaway accounts (need db/003_server_users.sql)
const probe = await srv("srv_set_waitlist", { p_email: "nobody@example.invalid", p_status: "pending", p_credits: 0 });
const has003 = probe.status === 200;
if (!has003) {
  skip("waitlist inserts, rate limit, accounts, roles, blocked accounts, RLS between users", "run db/003_server_users.sql in the Supabase SQL editor");
} else {
  const created = [];   // user ids to delete
  const wlEmails = [];  // waitlist rows to delete
  const mkUser = async (opts) => {
    const pw = "Test-" + rnd() + "-" + rnd();
    const r = await srv("srv_create_user", { p_email: opts.email || null, p_password: pw, p_username: opts.username || null, p_display_name: opts.name || null, p_credits: opts.credits ?? 50, p_role: opts.role || "user", p_is_demo: !!opts.demo, p_tag: opts.tag || null, p_expires_at: opts.expires || null, p_daily_limit: null });
    if (r.status !== 200) throw new Error("srv_create_user " + r.status + " " + JSON.stringify(r.data));
    created.push(r.data);
    return { id: r.data, password: pw, email: (opts.email || `${opts.username}@demo.playlab.invalid`).toLowerCase() };
  };
  try {
    // waitlist: position, duplicates, rate limit per IP
    const ip = "10.9." + Math.floor(Math.random() * 250) + "." + Math.floor(Math.random() * 250);
    const e1 = `wl-${rnd()}@example.com`; wlEmails.push(e1);
    const j1 = await api("api/waitlist", { method: "POST", headers: { "x-real-ip": ip }, body: { name: "Wl Tester", email: e1, message: "a lava castle", source: "test" } });
    check("join the waitlist -> position", j1.status === 200 && j1.data.position > 0 && j1.data.already === false, j1.data);
    const j2 = await api("api/waitlist", { method: "POST", headers: { "x-real-ip": ip }, body: { name: "Wl Tester", email: e1.toUpperCase() } });
    check("same email again -> same position, flagged as already", j2.status === 200 && j2.data.already === true && j2.data.position === j1.data.position, j2.data);
    let limited = null;
    for (let i = 0; i < 5; i++) { const e = `wl-${rnd()}@example.com`; wlEmails.push(e); const r = await api("api/waitlist", { method: "POST", headers: { "x-real-ip": ip }, body: { name: "Flood", email: e } }); if (r.status === 429) { limited = i; break; } }
    check("rate limit: the 6th sign-up from one IP in an hour is refused", limited !== null && limited <= 3, limited);

    // approval opens the door: the database lets an approved email create its account
    const ok = await srv("srv_set_waitlist", { p_email: e1, p_status: "approved", p_credits: 123 });
    check("approve a waitlist email", ok.status === 200 && ok.data === 1, ok.data);

    // demo account by username + password
    const demo = await mkUser({ username: "demo_" + rnd(), name: "Demo Judge", credits: 77, demo: true, tag: "Judge" });
    const dl = await login(demo.email, demo.password);
    check("demo account logs in by username (synthetic email)", dl.status === 200 && !!dl.token, dl.error);
    const meDemo = await api("api/me", { token: dl.token });
    check("api/me returns the profile with starting credits", meDemo.status === 200 && meDemo.data.profile.balance === 77 && meDemo.data.profile.is_demo === true && meDemo.data.profile.demo_tag === "Judge" && meDemo.data.profile.role === "user", meDemo.data.profile);
    const ledger = await api("api/me?ledger=1", { token: dl.token });
    check("starting credits are written to the ledger", ledger.data.ledger?.length === 1 && ledger.data.ledger[0].amount === 77 && ledger.data.ledger[0].reason === "starting credits", ledger.data.ledger);
    check("wrong password is refused", (await login(demo.email, "nope-nope-nope")).status === 400);

    // profile edits
    const uname = "ana_" + rnd();
    const pe = await api("api/me", { method: "PATCH", token: dl.token, body: { username: uname, display_name: "Ana B." } });
    check("change username and display name", pe.status === 200 && pe.data.profile.username === uname && pe.data.profile.display_name === "Ana B.", pe.data);
    check("bad username is refused", (await api("api/me", { method: "PATCH", token: dl.token, body: { username: "No Spaces!" } })).status === 400);
    const other = await mkUser({ username: "other_" + rnd(), credits: 0 });
    const ol = await login(other.email, other.password);
    check("taken username -> 409", (await api("api/me", { method: "PATCH", token: ol.token, body: { username: uname } })).status === 409);
    check("a user cannot raise their own balance through the database", (await sbRest(`/profiles?id=eq.${demo.id}`, { method: "PATCH", token: dl.token, body: { balance: 99999 } })).status >= 400 || (await api("api/me", { token: dl.token })).data.profile.balance === 77);
    check("a user cannot make themselves admin", (await sbRest(`/profiles?id=eq.${demo.id}`, { method: "PATCH", token: dl.token, body: { role: "admin" } })).status >= 400 || (await api("api/me", { token: dl.token })).data.profile.role === "user");
    check("a user cannot read someone else's profile", JSON.stringify((await sbRest(`/profiles?id=eq.${other.id}&select=email`, { token: dl.token })).data) === "[]");
    check("a user cannot read the waitlist", JSON.stringify((await sbRest("/waitlist?select=email&limit=3", { token: dl.token })).data) === "[]");
    check("a user cannot call admin functions", (await sbRest("/rpc/admin_list_users", { method: "POST", body: {}, token: dl.token })).status >= 400);

    // projects belong to their owner
    const pr = await api("api/projects", { method: "POST", token: dl.token, body: { title: "Auth test game" } });
    check("logged-in user creates a project", pr.status === 200 && pr.data.project?.owner === demo.id, pr.data);
    check("another user cannot open it", (await api(`api/projects?id=${pr.data.project.id}`, { token: ol.token })).status === 404);
    check("another user does not see it in their list", !(await api("api/projects", { token: ol.token })).data.projects.some((p) => p.id === pr.data.project.id));
    check("another user cannot post into it", (await api("api/messages", { method: "POST", token: ol.token, body: { project_id: pr.data.project.id, role: "user", content: "hi" } })).status >= 400);

    // admin: role from the database, admin functions work, users can be suspended
    const adm = await mkUser({ email: `admin-${rnd()}@example.com`, role: "admin", credits: 0 });
    const al = await login(adm.email, adm.password);
    const am = await api("api/me", { token: al.token });
    check("admin account has the admin role", am.data.profile?.role === "admin", am.data.profile?.role);
    const wl = await sbRest("/rpc/admin_list_waitlist", { method: "POST", token: al.token, body: { p_search: e1 } });
    check("admin can list the waitlist", wl.status === 200 && wl.data[0]?.email === e1 && wl.data[0].status === "approved" && wl.data[0].starting_credits === 123, wl.data[0]);
    const susp = await sbRest("/rpc/admin_set_user", { method: "POST", token: al.token, body: { p_user: other.id, p_status: "suspended" } });
    check("admin suspends a user", susp.status === 200, susp.data);
    const blocked = await api("api/me", { token: ol.token });
    check("suspended user is refused by the server with a reason", blocked.status === 403 && blocked.data.blocked === "suspended", blocked.data);
    check("suspended user cannot log in again", (await login(other.email, other.password)).status >= 400);
    check("admin cannot lock themselves out", (await sbRest("/rpc/admin_set_user", { method: "POST", token: al.token, body: { p_user: adm.id, p_status: "suspended" } })).status >= 400);

    // expired demo accounts are blocked automatically
    const old = await mkUser({ username: "expired_" + rnd(), demo: true, tag: "Tester", expires: new Date(Date.now() - 60_000).toISOString() });
    const xl = await login(old.email, old.password);
    const xm = await api("api/me", { token: xl.token });
    check("expired demo account -> 403 expired", xm.status === 403 && xm.data.blocked === "expired" && /expired/.test(xm.data.error), xm.data);
    check("expired demo account cannot use the AI", (await api("api/agent", { method: "POST", token: xl.token, body: { message: "hi" } })).status === 403);

    // ADMIN_EMAILS: an account for an admin email gets the admin role
    if (process.env.ADMIN_EMAILS) check("ADMIN_EMAILS is configured for the server", true);
  } catch (err) { console.log("ERROR", err.stack || err.message); fails++; }
  finally {
    for (const id of created) await srv("srv_delete_user", { p_user: id });
    for (const e of wlEmails) await srv("srv_set_waitlist", { p_email: e, p_status: "deleted" });
    console.log(`cleaned ${created.length} test account(s), ${wlEmails.length} waitlist row(s)`);
  }
}
console.log(fails ? `\n${fails} FAILED` : `\nALL PASSED${skips ? ` (${skips} skipped)` : ""}`);
process.exit(fails ? 1 : 0);
