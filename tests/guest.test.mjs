// tests/guest.test.mjs — "Try it free, no account": the landing page links to login.html?guest=1, the server makes a guest
// (a demo account, 2,000 credits, two weeks), the page logs in with it and the Studio opens. The guest is deleted at the end.
// Needs the dev server on 3000 and .env (Supabase keys). npm run test:guest
import { spawn } from "node:child_process";
import os from "node:os"; import path from "node:path";
try { process.loadEnvFile(".env"); } catch {}
const BASE = "http://localhost:3000", PORT = 9740 + Math.floor(Math.random() * 20), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, SKEY = process.env.PLAYLAB_SERVER_KEY;
const srv = async (fn, a) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" }, body: JSON.stringify({ p_key: SKEY, ...a }) }); return { status: r.status, data: await r.json().catch(() => null) }; };
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : ""}`); if (!ok) fails++; };
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "pl-guest-" + Date.now())}`, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
let ws; for (let i = 0; i < 60 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(250); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
const waitFor = async (e, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = await ev(e); if (v) return v; } catch {} await sleep(250); } return null; };
let uid = null;
try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/` });
  check("the landing page offers it", !!(await waitFor(`!!document.querySelector('#betaNote a[href="login.html?guest=1"]')`)));
  await send("Page.navigate", { url: `${BASE}/login.html` });
  check("the login page has a Try it free button", !!(await waitFor(`/Try it free/.test(document.getElementById("guestBtn")?.textContent || "")`)));
  await send("Page.navigate", { url: `${BASE}/login.html?guest=1` });
  const me = await waitFor(`/studio\\.html/.test(location.pathname) && typeof S === "object" && S.me && JSON.stringify({ id: S.me.id || S.me.profile?.id, name: S.me.display_name || S.me.profile?.display_name, credits: S.me.balance ?? S.me.profile?.balance ?? S.me.credits, demo: S.me.is_demo ?? S.me.profile?.is_demo, username: S.me.username || S.me.profile?.username, expires: S.me.expires_at ?? S.me.profile?.expires_at })`, 40000);
  const g = me ? JSON.parse(me) : {};
  uid = g.id || null;
  check("one link: a guest account is made, logged in, and the Studio opens", !!me && /^guest_[0-9a-f]{8}$/.test(g.username || ""), g);
  check("the guest has 2,000 credits, is a demo account and lasts two weeks", g.credits === 2000 && g.demo === true && Math.abs(new Date(g.expires).getTime() - Date.now() - 14 * 86400e3) < 3600e3, g);
} catch (err) { console.log("ERROR", err.message); fails++; }
finally {
  try { ws.close(); } catch {} chrome.kill();
  if (uid) { await srv("srv_delete_user", { p_user: uid }); console.log("deleted the guest"); }
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
