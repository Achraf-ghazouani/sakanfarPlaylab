// Credits: prices, multipliers, the atomic charge, refunds, daily limits, parallel charges, free actions, admin grants,
// and one real AI call through the API. Needs the dev server, .env and db/004_credits.sql.
//   node tests/credits.test.mjs [baseUrl]
try { process.loadEnvFile(".env"); } catch {}
const BASE = process.argv[2] || "http://localhost:3000";
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, KEY = process.env.PLAYLAB_SERVER_KEY;
let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 240) : ""}`); if (!cond) fails++; }
const rnd = () => Math.random().toString(36).slice(2, 10);
async function sb(path, { method = "GET", body, token } = {}) {
  const r = await fetch(`${SB}/rest/v1${path}`, { method, headers: { apikey: ANON, Authorization: "Bearer " + (token || ANON), "Content-Type": "application/json", Prefer: "return=representation" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
}
const srv = (fn, args) => sb(`/rpc/${fn}`, { method: "POST", body: { p_key: KEY, ...args } });
const rpc = (fn, args, token) => sb(`/rpc/${fn}`, { method: "POST", body: args, token });
async function api(path, { method = "GET", body, token } = {}) {
  const r = await fetch(`${BASE}/${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const created = [];
async function account(credits, opts = {}) {
  const username = "cr_" + rnd(), password = "Test-" + rnd() + "-" + rnd();
  const r = await srv("srv_create_user", { p_email: opts.email || null, p_password: password, p_username: opts.email ? null : username, p_display_name: null, p_credits: credits, p_role: opts.role || "user", p_is_demo: false, p_tag: null, p_expires_at: null, p_daily_limit: null });
  if (r.status !== 200) throw new Error("srv_create_user " + r.status);
  created.push(r.data);
  const t = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: opts.email || `${username}@demo.playlab.invalid`, password }) }).then((x) => x.json());
  return { id: r.data, token: t.access_token };
}
const balance = async (u) => (await api("api/me", { token: u.token })).data.profile.balance;

if (!SB || !ANON || !KEY) { console.log("SKIP  missing Supabase values or PLAYLAB_SERVER_KEY in .env"); process.exit(0); }
const probe = await sb("/costs?select=action&limit=1");
if (probe.status !== 200) { console.log("SKIP  run db/004_credits.sql in the Supabase SQL editor first"); process.exit(0); }

try {
  // prices
  const prices = await api("api/costs");
  const c = prices.data.costs || {};
  check("price list has the default costs", c.create_2d?.credits === 10 && c.create_3d?.credits === 25 && c.edit_2d?.credits === 2 && c.scan?.credits === 8 && c.playtest?.credits === 3 && c.publish?.credits === 0, c);
  const models = prices.data.models || [];
  check("models list with one default", models.length >= 2 && models.filter((m) => m.is_default).length === 1 && models.some((m) => m.id === "muse-spark-open"), models.map((m) => m.id + "x" + m.multiplier));

  // the atomic charge
  const u = await account(25);
  const ch = await rpc("charge", { p_action: "create_2d" }, u.token);
  check("charge create_2d: -10", ch.data.ok === true && ch.data.cost === 10 && ch.data.balance === 15, ch.data);
  check("balance is 15 on the server", (await balance(u)) === 15);
  const led = (await api("api/me?ledger=1", { token: u.token })).data.ledger;
  check("ledger row for the charge", led[0].amount === -10 && led[0].action === "create_2d" && led[0].balance_after === 15, led[0]);
  const open = await rpc("charge", { p_action: "create_2d", p_model: "muse-spark-open" }, u.token);
  check("model multiplier: Muse Spark Open x0.5 -> 5", open.data.ok === true && open.data.cost === 5 && open.data.balance === 10, open.data);

  // refunds: server only, once
  const rf = await srv("srv_refund", { p_ledger_id: ch.data.ledger_id, p_reason: "test refund" });
  check("refund gives the 10 back", rf.data.ok === true && rf.data.balance === 20, rf.data);
  check("a second refund of the same charge is refused", (await srv("srv_refund", { p_ledger_id: ch.data.ledger_id })).data.error === "already_refunded");
  check("users cannot refund themselves", (await sb("/rpc/srv_refund", { method: "POST", token: u.token, body: { p_key: "x".repeat(40), p_ledger_id: open.data.ledger_id } })).status >= 400);
  check("users cannot edit prices", (await sb("/costs?action=eq.create_2d", { method: "PATCH", token: u.token, body: { credits: 0 } })).data?.length !== 1);
  check("users cannot write their own ledger", (await sb("/credit_ledger", { method: "POST", token: u.token, body: { user_id: u.id, amount: 1000, balance_after: 1000, reason: "free money" } })).status >= 400);

  // not enough credits: refused before any AI call
  await srv("srv_set_profile", { p_user: u.id, p_balance: 3 });
  const poor = await rpc("charge", { p_action: "create_2d" }, u.token);
  check("insufficient credits is refused", poor.data.ok === false && poor.data.error === "insufficient_credits" && poor.data.cost === 10 && poor.data.balance === 3, poor.data);
  const t0 = Date.now();
  const r402 = await api("api/build-code", { method: "POST", token: u.token, body: { plan: { title: "Snake", genre: "snake", engine: "canvas", goal: "eat apples", controls: "d-pad", controller: "dpad+jump", win: "20 apples", lose: "a wall", entities: ["snake", "apple"], opponents: "none", levels: "1", players: 1, notes: "" }, prompt: "a snake game" } });
  check("api/build-code answers 402 with the cost (code_create_2d), without calling the AI", r402.status === 402 && r402.data.credits?.cost === 20 && r402.data.credits?.balance === 3 && Date.now() - t0 < 4000, { status: r402.status, body: r402.data, ms: Date.now() - t0 });
  check("still 3 credits", (await balance(u)) === 3);

  // free things stay free
  const fx = await api("api/agent", { method: "POST", token: u.token, body: { task: "fix", plan: { title: "Snake", genre: "snake", engine: "canvas", goal: "eat apples", controls: "d-pad", controller: "dpad+jump", win: "20 apples", lose: "a wall", entities: ["snake", "apple"], opponents: "none", levels: "1", players: 1, notes: "" }, html: "<html>" + "x".repeat(500) + "</html>", report: {} } });
  check("a free fix without the token of a paid build is refused, nothing charged", fx.status === 403 && /build token/.test(fx.data.error) && (await balance(u)) === 3, fx.data);
  const odd = await api("api/agent", { method: "POST", token: u.token, body: { message: "a desert level" } });
  check("the retired game agent answers 400 (every game is AI code now), nothing charged", odd.status === 400 && (await balance(u)) === 3, odd.data);

  // daily limit
  // Used today so far: 5 (the open-weights charge; the refunded create does not count). Limit 24: the first charge
  // brings it to 15, the second would reach 25 and is refused (reaching the limit exactly is allowed).
  await srv("srv_set_profile", { p_user: u.id, p_balance: 100, p_daily_limit: 24 });
  const d1 = await rpc("charge", { p_action: "create_2d" }, u.token);
  check("charge inside the daily limit", d1.data.ok === true, d1.data);
  const d2 = await rpc("charge", { p_action: "create_2d" }, u.token);
  check("the daily limit stops the next charge", d2.data.ok === false && d2.data.error === "daily_limit", d2.data);
  await srv("srv_set_profile", { p_user: u.id, p_clear_daily_limit: true });

  // parallel charges cannot overspend
  const v = await account(25);
  const par = await Promise.all(Array.from({ length: 5 }, () => rpc("charge", { p_action: "create_2d" }, v.token)));
  const okCount = par.filter((r) => r.data.ok).length;
  check("5 charges at once on 25 credits: exactly 2 pass", okCount === 2 && (await balance(v)) === 5, { okCount, balance: await balance(v) });

  // admin grants (with a reason, in the ledger); users cannot grant
  const adm = await account(0, { email: `cradmin-${rnd()}@example.com`, role: "admin" });
  check("users cannot grant credits", (await rpc("admin_grant_credits", { p_users: [v.id], p_amount: 100, p_reason: "hi" }, v.token)).status >= 400);
  const g = await rpc("admin_grant_credits", { p_users: [v.id, u.id], p_amount: 50, p_reason: "beta bonus" }, adm.token);
  check("admin grants 50 to two users", g.data === 2 && (await balance(v)) === 55, g.data);
  const vl = (await api("api/me?ledger=1", { token: v.token })).data.ledger[0];
  check("the grant is in the ledger with its reason", vl.amount === 50 && vl.reason === "beta bonus", vl);
  check("a grant needs a reason", (await rpc("admin_grant_credits", { p_users: [v.id], p_amount: 5, p_reason: "" }, adm.token)).status >= 400);

  // the global daily cap (db/010): everyone together, admins never blocked, nothing charged when refused
  const st = await api("api/admin?action=settings", { token: adm.token });
  check("admin reads the settings: the cap and everyone's usage today", st.status === 200 && typeof st.data.settings?.global_daily_cap === "number" && typeof st.data.settings?.spent_today_all === "number", st.data);
  const capBefore = st.data.settings.global_daily_cap, usedAll = st.data.settings.spent_today_all;
  check("users cannot read or change the settings", (await api("api/admin?action=settings", { token: u.token })).status === 403 && (await api("api/admin", { method: "POST", token: u.token, body: { action: "setting_set", key: "global_daily_cap", value: 1 } })).status === 403);
  try {
    // room for exactly one more create_2d (10): reaching the cap is allowed, passing it is not
    const set = await api("api/admin", { method: "POST", token: adm.token, body: { action: "setting_set", key: "global_daily_cap", value: usedAll + 10 } });
    check("admin sets the cap", set.status === 200 && set.data.settings.global_daily_cap === usedAll + 10, set.data);
    await srv("srv_set_profile", { p_user: u.id, p_balance: 100 });
    const c1 = await rpc("charge", { p_action: "create_2d" }, u.token);
    check("a charge under the cap passes", c1.data.ok === true, c1.data);
    const c2 = await rpc("charge", { p_action: "create_2d" }, u.token);
    check("the next one is refused: global_cap, with the numbers", c2.data.ok === false && c2.data.error === "global_cap" && c2.data.cap === usedAll + 10 && c2.data.spent_today_all >= usedAll + 10 && !!c2.data.resets_at, c2.data);
    check("nothing was charged", (await balance(u)) === 90);
    check("the Studio sees the budget as reached", (await api("api/me", { token: u.token })).data.cap?.reached === true);
    const r = await api("api/build-code", { method: "POST", token: u.token, body: { plan: { title: "Snake", genre: "snake", engine: "canvas", goal: "eat apples", controls: "d-pad", controller: "dpad+jump", win: "20 apples", lose: "a wall", entities: ["snake", "apple"], opponents: "none", levels: "1", players: 1, notes: "" }, prompt: "a snake game" } });
    check("api/build-code answers 402 with the friendly message, without calling the AI", r.status === 402 && r.data.credits?.error === "global_cap" && /shared budget/.test(r.data.error) && /midnight UTC/.test(r.data.error), r.data);
    await srv("srv_set_profile", { p_user: adm.id, p_balance: 50 });
    const ca = await rpc("charge", { p_action: "create_2d" }, adm.token);
    check("an admin is never blocked by the cap", ca.data.ok === true, ca.data);
    check("admins see reached=false", (await api("api/me", { token: adm.token })).data.cap?.reached === false);
    check("a free action still works at the cap", (await rpc("charge", { p_action: "publish" }, u.token)).data.ok === true);
    check("the cap cannot be negative", (await api("api/admin", { method: "POST", token: adm.token, body: { action: "setting_set", key: "global_daily_cap", value: -5 } })).status === 400);
  } finally {
    const back = await api("api/admin", { method: "POST", token: adm.token, body: { action: "setting_set", key: "global_daily_cap", value: capBefore } });
    check("the cap is put back", back.status === 200 && back.data.settings.global_daily_cap === capBefore);
  }
  check("charges work again without the cap", (await rpc("charge", { p_action: "create_2d" }, u.token)).data.ok === true || capBefore > 0);

  // one real AI call: a plan is free (Muse Spark), the build charges code_create_2d and streams the game (Muse Wonder)
  if (process.env.MODEL_API_KEY) {
    const w = await account(30);
    const plan = await api("api/agent", { method: "POST", token: w.token, body: { task: "plan", message: "a tiny snake game", mode: "2d" } });
    check("real plan: free, a plan comes back", plan.status === 200 && !!plan.data.plan?.title && (await balance(w)) === 30, { status: plan.status, err: plan.data.error });
    const r = await fetch(`${BASE}/api/build-code`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + w.token }, body: JSON.stringify({ plan: plan.data.plan || { title: "Snake", genre: "snake", engine: "canvas", goal: "eat apples", controls: "d-pad", controller: "dpad+jump", win: "20 apples", lose: "a wall", entities: ["snake", "apple"], opponents: "none", levels: "1", players: 1, notes: "" }, prompt: "a tiny snake game" }) });
    const text = await r.text(), done = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.e === "done" || e.e === "error");
    check("real build: the stream ends in a game, 20 credits spent, balance in the answer", r.status === 200 && done?.e === "done" && done.html.length > 500 && done.credits?.spent === 20 && done.credits?.balance === 10, { status: r.status, end: done && { e: done.e, error: done.error, credits: done.credits } });
    const after = await balance(w);
    check("server balance matches", after === 10, after);
  }
} catch (err) { console.log("ERROR", err.stack || err.message); fails++; }
finally {
  for (const id of created) await srv("srv_delete_user", { p_user: id });
  console.log(`cleaned ${created.length} test account(s)`);
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
