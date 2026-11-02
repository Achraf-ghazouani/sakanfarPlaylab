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
  const r402 = await api("api/agent", { method: "POST", token: u.token, body: { message: "a desert level" } });
  check("api/agent answers 402 with the cost, without calling the AI", r402.status === 402 && r402.data.credits?.cost === 10 && r402.data.credits?.balance === 3 && Date.now() - t0 < 4000, { status: r402.status, body: r402.data, ms: Date.now() - t0 });
  check("still 3 credits", (await balance(u)) === 3);

  // free things stay free
  const quick = await api("api/agent", { method: "POST", token: u.token, body: { message: "Make it 3D" } });
  check("a reply without AI costs nothing", quick.status === 200 && !quick.data.credits && (await balance(u)) === 3);
  const fine = { theme: "t", objects: [{ type: "platform", x: 0, y: 900, w: 1000, h: 60 }, { type: "start", x: 40, y: 840, w: 40, h: 60 }, { type: "goal", x: 900, y: 840, w: 40, h: 60 }] };
  const fx = await api("api/fix", { method: "POST", token: u.token, body: { level: fine } });
  check("playtest of a level that is already fine is free", fx.status === 200 && fx.data.report.before.ok === true && (await balance(u)) === 3);

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

  // one real AI call: the agent charges create_2d and reports the new balance
  if (process.env.MODEL_API_KEY) {
    const w = await account(30);
    const real = await api("api/agent", { method: "POST", token: w.token, body: { message: "A tiny desert level with 2 coins" } });
    check("real agent call: level built, 10 credits spent, balance in the answer", real.status === 200 && real.data.level && real.data.credits?.spent === 10 && real.data.credits?.balance === 20, { status: real.status, credits: real.data.credits, err: real.data.error });
    const after = await balance(w);
    check("server balance matches", after === 20, after);
  }
} catch (err) { console.log("ERROR", err.stack || err.message); fails++; }
finally {
  for (const id of created) await srv("srv_delete_user", { p_user: id });
  console.log(`cleaned ${created.length} test account(s)`);
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
