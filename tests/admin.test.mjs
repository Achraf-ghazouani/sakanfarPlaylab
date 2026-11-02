// The admin panel's API (api/admin.js + db/005_admin.sql) against the real Supabase project and the dev server.
// Start the dev server first (node serve.mjs), then:  node tests/admin.test.mjs [baseUrl]
// Makes a throwaway admin, a throwaway user and a throwaway waitlist entry, and deletes them at the end.
// Prices and model multipliers it touches are put back to what they were.
try { process.loadEnvFile(".env"); } catch {}
const BASE = process.argv[2] || "http://localhost:3000";
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, KEY = process.env.PLAYLAB_SERVER_KEY;

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`); if (!cond) fails++; }
const rnd = () => Math.random().toString(36).slice(2, 10);
async function api(path, { method = "GET", body, token } = {}) {
  const h = { "Content-Type": "application/json" }; if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(`${BASE}/${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const admin = (token, query) => api("api/admin?" + new URLSearchParams(query), { token });
const post = (token, body) => api("api/admin", { method: "POST", body, token });
async function sb(path, body) {
  const r = await fetch(`${SB}/rest/v1${path}`, { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const srv = (fn, args) => sb(`/rpc/${fn}`, { p_key: KEY, ...args });
async function login(email, password) {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return (await r.json().catch(() => ({}))).access_token;
}

const made = [];
async function makeUser(role, credits) {
  const username = `adm_${role}_${rnd()}`, password = "Test-" + rnd() + rnd();
  const r = await srv("srv_create_user", { p_email: null, p_password: password, p_username: username, p_display_name: `Admin test ${role}`, p_credits: credits, p_role: role, p_is_demo: true, p_tag: "Tester", p_expires_at: null, p_daily_limit: null });
  if (r.status !== 200) throw new Error("srv_create_user " + r.status + " " + JSON.stringify(r.data));
  made.push(r.data);
  return { id: r.data, username, token: await login(`${username}@demo.playlab.invalid`, password) };
}

const wlEmail = `admin-test-${rnd()}@example.com`;
try {
  const A = await makeUser("admin", 0), U = await makeUser("user", 50);
  check("throwaway admin and user can log in", !!A.token && !!U.token);

  // access
  check("no login: 401", (await admin(null, { action: "overview" })).status === 401);
  check("a regular user gets 403", (await admin(U.token, { action: "overview" })).status === 403);
  const ov = await admin(A.token, { action: "overview" });
  check("admin overview has users, waitlist, spend and 14 days", ov.status === 200 && ov.data.overview.users.total >= 2 && ov.data.overview.daily.length === 14 && "pending" in ov.data.overview.waitlist, ov.data.overview?.spent);

  // users
  const users = await admin(A.token, { action: "users", search: U.username });
  check("users search finds the throwaway user", users.status === 200 && users.data.users.length === 1 && users.data.users[0].id === U.id);
  const give = await post(A.token, { action: "credits", ids: [U.id], amount: 25, reason: "admin test" });
  check("give credits", give.status === 200 && give.data.updated === 1, give.data);
  check("give credits needs a reason", (await post(A.token, { action: "credits", ids: [U.id], amount: 5, reason: "" })).status === 400);
  const ledger = await admin(A.token, { action: "ledger", user: U.id });
  check("usage shows the grant with the admin", ledger.status === 200 && ledger.data.ledger[0]?.amount === 25 && ledger.data.ledger[0].balance_after === 75 && ledger.data.ledger[0].admin_email === `${A.username}@demo.playlab.invalid`, ledger.data.ledger?.[0]);
  const take = await post(A.token, { action: "credits", ids: [U.id], amount: -10, reason: "admin test take" });
  check("take credits", take.status === 200 && take.data.updated === 1);
  const lim = await post(A.token, { action: "user_set", id: U.id, daily_limit: 30 });
  check("set a daily limit", lim.status === 200 && lim.data.user.daily_limit === 30, lim.data);
  const pause = await post(A.token, { action: "user_set", id: U.id, status: "suspended" });
  check("suspend a user", pause.status === 200 && pause.data.user.status === "suspended");
  check("a suspended user is locked out of the app", (await api("api/me", { token: U.token })).status === 403);
  check("unpause", (await post(A.token, { action: "user_set", id: U.id, status: "active", clear_daily_limit: true })).data.user?.daily_limit === null);
  check("an admin cannot suspend themselves", (await post(A.token, { action: "user_set", id: A.id, status: "suspended" })).status === 400);
  const pw = await post(A.token, { action: "user_password", id: U.id, password: "New-" + rnd() + rnd() });
  check("set a password", pw.status === 200);
  check("short passwords are refused", (await post(A.token, { action: "user_password", id: U.id, password: "short" })).status === 400);
  const nu = `adm_new_${rnd()}`;
  const created = await post(A.token, { action: "user_create", username: nu, password: "Made-" + rnd() + rnd(), credits: 40, is_demo: true, tag: "Judge" });
  check("create a demo account", created.status === 200 && /^[0-9a-f-]{36}$/.test(created.data.id), created.data);
  if (created.data.id) made.push(created.data.id);
  check("the same username twice is refused", (await post(A.token, { action: "user_create", username: nu, password: "Made-" + rnd() + rnd() })).status === 409);
  const del = await post(A.token, { action: "user_delete", id: created.data.id });
  check("delete an account", del.status === 200);
  if (del.status === 200) made.pop();

  // waitlist
  const joined = await api("api/waitlist", { method: "POST", body: { name: "Admin Test", email: wlEmail, message: "admin panel test", source: "test", website: "" } });
  check("throwaway waitlist entry", joined.status === 200, joined.data);
  const wl = await admin(A.token, { action: "waitlist", status: "pending", search: wlEmail });
  const entry = wl.data.waitlist?.[0];
  check("waitlist search finds it", wl.status === 200 && entry?.email === wlEmail);
  const ap = await post(A.token, { action: "waitlist_set", ids: [entry?.id], status: "approved", credits: 150 });
  check("approve with starting credits", ap.status === 200 && ap.data.updated === 1);
  check("mark invited", (await post(A.token, { action: "waitlist_invited", ids: [entry?.id] })).data.updated === 1);
  const after = (await admin(A.token, { action: "waitlist", status: "approved", search: wlEmail })).data.waitlist?.[0];
  check("approved entry keeps credits and invite time", after?.starting_credits === 150 && !!after.invited_at, after);
  check("reject", (await post(A.token, { action: "waitlist_set", ids: [entry?.id], status: "rejected" })).data.updated === 1);

  // prices and models (restored afterwards)
  const pr = await admin(A.token, { action: "pricing" });
  const cost = pr.data.costs?.find((c) => c.action === "playtest"), model = pr.data.models?.find((m) => !m.is_default);
  check("pricing lists prices and every model", pr.status === 200 && !!cost && pr.data.models.length >= 2, { costs: pr.data.costs?.length, models: pr.data.models?.length });
  const cs = await post(A.token, { action: "cost_set", key: "playtest", credits: cost.credits + 1 });
  check("change a price", cs.status === 200 && cs.data.cost.credits === cost.credits + 1);
  check("prices show up in the public price list", (await api("api/costs")).data.costs?.playtest?.credits === cost.credits + 1);
  await post(A.token, { action: "cost_set", key: "playtest", credits: cost.credits });
  const ms = await post(A.token, { action: "model_set", id: model.id, multiplier: 1.5 });
  check("change a model multiplier", ms.status === 200 && ms.data.model.multiplier === 1.5);
  await post(A.token, { action: "model_set", id: model.id, multiplier: model.multiplier });
  const def = pr.data.models.find((m) => m.is_default);
  check("the default model cannot be switched off", (await post(A.token, { action: "model_set", id: def.id, enabled: false })).status === 400);
  check("a regular user cannot change prices", (await post(U.token, { action: "cost_set", key: "playtest", credits: 0 })).status === 403);

  // activity
  const actv = await admin(A.token, { action: "activity" });
  const mine = (actv.data.activity || []).filter((a) => a.admin_email === `${A.username}@demo.playlab.invalid`).map((a) => a.action);
  check("activity log records the changes", actv.status === 200 && ["credits", "user_update", "password_reset", "demo_create", "user_delete", "waitlist_approved", "cost_update", "model_update"].every((x) => mine.includes(x)), mine);
} catch (err) {
  console.log("ERROR", err.message); fails++;
} finally {
  for (const id of made) await srv("srv_delete_user", { p_user: id });
  // the waitlist entry has no delete function on purpose; leave it rejected and clearly named
  console.log(`deleted ${made.length} test account(s)`);
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
}
