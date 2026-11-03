// Live end-to-end run of "any game from a prompt" in the Studio: headless Chrome drives studio.html against the dev server,
// the real Meta models and the real database. For each prompt: new game -> the prompt -> the plan (Muse Spark) -> Go ->
// the build (Muse Wonder, streamed) -> the game runs in the sandbox. Records the plan and build times, attempts, errors,
// whether the screen responds to a phone input, pass / fail, and writes tests/anygame-results.md.
// Needs the dev server, MODEL_API_KEY, PLAYLAB_SERVER_KEY (a throwaway account with credits) and db/011_code.sql applied.
//   node tests/anygame.test.mjs [baseUrl] [--only snake,racing] [--credits 600]
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PROMPTS = [
  ["racing", "a car racing game with 3 laps and 4 AI cars"],
  ["match3", "a match-3 puzzle game"],
  ["towerdefense", "a tower defense game with 3 waves"],
  ["runner", "an endless runner"],
  ["flight", "a simple flight game through rings"],
  ["soccer", "a 2-player soccer game with phone controllers"],
  ["snake", "a snake game"],
  ["dungeon", "a dungeon crawler with keys and doors"],
  ["memory", "a memory card game"],
];
const args = process.argv.slice(2);
const BASE = args.find((a) => /^https?:\/\//.test(a)) || "http://localhost:3000";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const CREDITS = Number(args[args.indexOf("--credits") + 1]) || 600;
const RUN = only ? PROMPTS.filter(([id]) => only.includes(id)) : PROMPTS;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9347;
const OUT = path.join(os.tmpdir(), "playlab-anygame");
await fs.mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { process.loadEnvFile(".env"); } catch {}
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, SKEY = process.env.PLAYLAB_SERVER_KEY;
const srv = async (fn, a) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" }, body: JSON.stringify({ p_key: SKEY, ...a }) }); return { status: r.status, data: await r.json().catch(() => null) }; };
const USERNAME = "anygame_" + Math.random().toString(36).slice(2, 10), PASSWORD = "Test-" + Math.random().toString(36).slice(2) + "-x";
const made = await srv("srv_create_user", { p_email: null, p_password: PASSWORD, p_username: USERNAME, p_display_name: "Any Game Tester", p_credits: CREDITS, p_role: "user", p_is_demo: true, p_tag: "Tester", p_expires_at: null, p_daily_limit: null });
if (made.status !== 200) { console.log("SKIP  this test needs a throwaway account: run db/003_server_users.sql (" + made.status + ")"); process.exit(0); }
const USER_ID = made.data;

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, "chrome-profile")}`, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 60 && !ws; i++) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = list.find((t) => t.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(250); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function evalJS(expression) { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; }
async function waitFor(expression, timeout) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { let v = null; try { v = await evalJS(expression); } catch {} if (v) return v; await sleep(200); } return null; }
const nav = async (url) => { await send("Page.navigate", { url }); };
const click = (sel) => evalJS(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
const type = (text) => evalJS(`(() => { const c = document.getElementById("composer"); c.value = ${JSON.stringify(text)}; c.dispatchEvent(new Event("input")); return true; })()`);

const results = [];
try {
  await send("Page.enable"); await send("Runtime.enable");
  await evalJS("1");
  await nav(`${BASE}/login.html?next=studio.html`);
  await waitFor(`typeof PlayAuth === "object" && !!document.getElementById("passwordBtn")`, 15_000);
  await evalJS(`localStorage.clear(); document.querySelector('[data-tab="password"]').click(); document.getElementById("user").value = ${JSON.stringify(USERNAME)}; document.getElementById("password").value = ${JSON.stringify(PASSWORD)}; document.getElementById("passwordBtn").click(); true`);
  if (!(await waitFor(`/studio\\.html$/.test(location.pathname) && typeof S === "object" && !!S.me && !!S.costs`, 30_000))) throw new Error("could not log in to the Studio");
  await evalJS(`window.__shots = []; addEventListener("message", (e) => { if (e.data && e.data.type === "playlab:snapshot") __shots.push(e.data.image); }); true`);
  console.log(`logged in as ${USERNAME} with ${CREDITS} credits; ${RUN.length} prompt(s)`);

  for (const [key, prompt] of RUN) {
    const r = { key, prompt, planS: null, buildS: null, title: "", engine: "", kb: 0, attempts: 0, ready: false, errors: [], blank: null, responds: null, pass: false, note: "" };
    results.push(r);
    try {
      await click("#newGameBtn");
      await type(prompt); let t0 = Date.now(); await click("#sendBtn");
      const planned = await waitFor(`!S.busy && !!S.pendingPlan`, 120_000);
      if (!planned) { r.note = "no plan within 120 s: " + (await evalJS(`S.messages.filter((m) => m.role === "assistant").slice(-1)[0]?.content || ""`)).slice(0, 160); console.log(`${key}: ${r.note}`); continue; }
      r.planS = +((Date.now() - t0) / 1000).toFixed(1);
      const plan = await evalJS(`JSON.stringify(S.pendingPlan.plan)`).then(JSON.parse);
      r.title = plan.title; r.engine = plan.engine;
      console.log(`${key}: plan in ${r.planS} s -> ${plan.title} (${plan.engine}, ${plan.controller})`);
      t0 = Date.now();
      await evalJS(`[...document.querySelectorAll(".card .choices button")][0].click(); true`);
      const built = await waitFor(`!S.busy`, 360_000);
      r.buildS = +((Date.now() - t0) / 1000).toFixed(0);
      r.attempts = await evalJS(`[...document.querySelectorAll(".card.think .th b")].filter((b) => /Writing your game|Changing your game/.test(b.textContent)).length`);
      const state = await evalJS(`JSON.stringify({ code: S.level?.genre === "code", engine: S.level?.engine, kb: +(((S.level?.html || "").length) / 1024).toFixed(1), ready: !!S.codeRun?.ready, errors: (S.codeRun?.errors || []).slice(0, 3).map((e) => e.message), blank: S.codeRun?.blank || null, reply: S.messages.filter((m) => m.role === "assistant").slice(-1)[0]?.content || "" })`).then(JSON.parse);
      if (!built) { r.note = "the build did not finish within 6 min"; console.log(`${key}: ${r.note}`); continue; }
      r.engine = state.engine || r.engine; r.kb = state.kb; r.ready = state.ready; r.errors = state.errors; r.blank = state.blank;
      if (!state.code) { r.note = state.reply.slice(0, 200); console.log(`${key}: no game -> ${r.note}`); continue; }
      const html = await evalJS(`S.level.html`);
      await fs.writeFile(path.join(OUT, key + ".html"), html);
      // does the screen respond to a phone input?
      await evalJS(`__shots = []; S.code.send({ type: "playlab:snapshot" }); true`);
      await waitFor(`__shots.length >= 1`, 5000);
      await evalJS(`S.code.send({ type: "playlab:input", slot: 1, l: 0, r: 1, u: 0, d: 0 }); S.code.send({ type: "playlab:stick", slot: 1, m: [1, 0], a: [0, 0] }); S.code.send({ type: "playlab:jump", slot: 1, down: true }); true`);
      await sleep(900);
      await evalJS(`S.code.send({ type: "playlab:snapshot" }); true`);
      await waitFor(`__shots.length >= 2`, 5000);
      await evalJS(`S.code.send({ type: "playlab:input", slot: 1, l: 0, r: 0, u: 0, d: 0 }); S.code.send({ type: "playlab:stick", slot: 1, m: [0, 0], a: [0, 0] }); S.code.send({ type: "playlab:jump", slot: 1, down: false }); true`);
      const shots = await evalJS(`JSON.stringify(__shots.map((s) => (s || "").length))`).then(JSON.parse);
      r.responds = shots.length >= 2 ? (await evalJS(`__shots[0] !== __shots[1]`)) : null;
      r.pass = r.ready && r.errors.length === 0 && !r.blank && r.responds !== false;
      r.note = state.reply.slice(0, 160);
      console.log(`${key}: ${r.pass ? "PASS" : "FAIL"} build ${r.buildS} s, ${r.engine}, ${r.kb} KB, ready ${r.ready}, errors ${r.errors.length}, blank ${r.blank}, responds ${r.responds}`);
    } catch (err) { r.note = "error: " + err.message; console.log(`${key}: ${r.note}`); }
  }
} catch (err) { console.log("ERROR", err.message); }
finally {
  try { ws.close(); } catch {} chrome.kill();
  try { await srv("srv_delete_user", { p_user: USER_ID }); console.log("deleted the test account"); } catch (e) { console.log("account cleanup failed:", e.message); }
}

const passed = results.filter((r) => r.pass).length;
const md = [`# Any game from a prompt: results`, ``, `Run on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC against ${BASE} with the real Meta models (plan: Muse Spark 1.3, code: Muse Wonder 1.0). ${passed} of ${results.length} prompts passed. Generated files: ${OUT}.`, ``,
  `| prompt | plan (s) | build (s) | engine | KB | attempts | ready | errors | responds | result | notes |`, `|---|---|---|---|---|---|---|---|---|---|---|`,
  ...results.map((r) => `| ${r.prompt} | ${r.planS ?? "-"} | ${r.buildS ?? "-"} | ${r.engine || "-"} | ${r.kb || "-"} | ${r.attempts} | ${r.ready ? "yes" : "no"} | ${r.errors.length ? r.errors.join("; ").replace(/\|/g, "/").slice(0, 120) : "none"}${r.blank ? " (blank: " + r.blank + ")" : ""} | ${r.responds === null ? "-" : r.responds ? "yes" : "no"} | ${r.pass ? "PASS" : "FAIL"} | ${r.note.replace(/\|/g, "/").replace(/\s+/g, " ")} |`),
  ``, `A prompt passes when the game loads with no error, draws something, and the screen changes after a phone input.`, ``].join("\n");
await fs.writeFile("tests/anygame-results.md", md);
console.log(`\n${passed} of ${results.length} passed; results in tests/anygame-results.md`);
process.exit(passed === results.length ? 0 : 1);
