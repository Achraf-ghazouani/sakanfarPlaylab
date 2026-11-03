// Publish, play and remix a game written as code (step 6), against the real Supabase project and the dev server: the projects
// API keeps the code level and refuses forbidden code, publishing gives it the "code" kind (or the mode's kind before
// db/012_code_kind.sql), /play/<id> runs the code in the sandbox with the person's pictures in PlayLab.assets, restart and pause
// on the page and the phone route, explore filters on it, a remix copies the code. Throwaway accounts, deleted at the end.
//   node tests/publish-code.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EXAMPLES } from "../lib/code-examples.mjs";
try { process.loadEnvFile(".env"); } catch {}
const BASE = process.argv[2] || "http://localhost:3000";
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, KEY = process.env.PLAYLAB_SERVER_KEY;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 240) : ""}`); if (!cond) fails++; }
const rnd = () => Math.random().toString(36).slice(2, 10);
async function api(p, { method = "GET", body, token } = {}) {
  const h = { "Content-Type": "application/json" }; if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(`${BASE}/${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const srv = async (fn, args) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" }, body: JSON.stringify({ p_key: KEY, ...args }) }); return { status: r.status, data: await r.json().catch(() => null) }; };
const made = [];
async function makeUser(name) {
  const username = `code_${rnd()}`, password = "Test-" + rnd() + rnd();
  const r = await srv("srv_create_user", { p_email: null, p_password: password, p_username: username, p_display_name: name, p_credits: 50, p_role: "user", p_is_demo: true, p_tag: "Tester", p_expires_at: null, p_daily_limit: null });
  if (r.status !== 200) throw new Error("srv_create_user " + r.status);
  made.push(r.data);
  const t = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: `${username}@demo.playlab.invalid`, password }) }).then((x) => x.json());
  return { id: r.data, token: t.access_token };
}
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
// a small game that says in its HUD whether the person's player picture reached PlayLab.assets
const ASSET_GAME = `<!doctype html>
<!-- playlab {"note":"asset check","built":"Shows whether the player picture arrived.","missing":""} -->
<html><head><meta charset="utf-8"><title>Asset check</title><style>html,body{margin:0;background:#123;overflow:hidden}</style></head>
<body><canvas id="c" width="320" height="200"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d"), a = PlayLab.assets.get("player");
PlayLab.controller({ type: "tap" });
PlayLab.hud.set({ text: a && a.kind === "image" && a.src.startsWith("data:image/png") ? "player picture: yes" : "player picture: no" });
PlayLab.onRestart(() => PlayLab.start());
function loop() { requestAnimationFrame(loop); ctx.fillStyle = "#123"; ctx.fillRect(0, 0, 320, 200); ctx.fillStyle = "#fa0"; ctx.fillRect(40 + (Date.now() / 10) % 200, 80, 40, 40); }
loop();
</script></body></html>`;
const level = (html, title = "Asset check") => ({ genre: "code", engine: "canvas", title, theme: "test", note: "v1", prompt: "a test game", plan: { title, genre: "test", engine: "canvas", goal: "test", controls: "tap", controller: "tap", win: "-", lose: "-", entities: [], opponents: "none", levels: "-", players: 1, notes: "" }, html, notes: { note: "v1", built: "x", missing: "" }, objects: [] });

let chrome, ws;
try {
  const A = await makeUser("Code Maker"), B = await makeUser("Code Remixer");
  check("two throwaway accounts", !!A.token && !!B.token);
  // the projects API keeps a code level and refuses forbidden code
  const bad = await api("api/projects", { method: "POST", token: A.token, body: { title: "bad", level: level(EXAMPLES.snake.replace("<script>", "<script>localStorage.setItem('x', 1);")) } });
  check("a code level that reaches for storage is refused by the projects API", bad.status === 400 && /forbids/.test(bad.data.error), bad.data);
  const created = await api("api/projects", { method: "POST", token: A.token, body: { title: "Asset check", mode: "2d", level: level(ASSET_GAME) } });
  const pid = created.data.project?.id;
  check("a code level is saved with version 1", created.status === 200 && created.data.project.level.genre === "code" && created.data.project.level.html.length > 300 && created.data.version?.n === 1, created.status);
  const art = await api("api/projects", { method: "PATCH", token: A.token, body: { id: pid, art: { player: PNG } } });
  check("the player picture is saved on the game", art.status === 200 && art.data.project.art?.player === PNG, art.status);
  // publish
  const pub = await api("api/projects", { method: "PATCH", token: A.token, body: { id: pid, publish: { visibility: "public", title: "Asset check", description: "A test of games written as code." } } });
  const share = pub.data.project?.share_id;
  check("publishing works and the kind is code (or the mode's kind before db/012)", pub.status === 200 && !!share && ["code", "2d"].includes(pub.data.project.kind), pub.data.project && { kind: pub.data.project.kind, share });
  const kindIsCode = pub.data.project?.kind === "code";
  if (!kindIsCode) console.log("note  db/012_code_kind.sql is not applied yet: the game was published with the mode's kind");
  const json = await api(`api/play?id=${share}&format=json`);
  check("the public game carries the code level and the art", json.status === 200 && json.data.game.level.genre === "code" && json.data.game.level.html === ASSET_GAME.replace(/\r\n/g, "\n") || json.data.game.level.html.length > 300, json.status);
  const page = await fetch(`${BASE}/play/${share}`).then((r) => r.text());
  check("the play page loads the sandbox runner and the phone route", /\/shared\/coderun\.mjs/.test(page) && /\/shared\/padroute\.mjs/.test(page) && (kindIsCode ? /custom game \(AI code\)/.test(page) : true));
  if (kindIsCode) {
    const ex = await api("api/play?action=explore&kind=code&sort=newest");
    check("explore with the AI code filter lists it", ex.status === 200 && ex.data.games.some((g) => g.id === share && g.kind === "code"), ex.data.games?.length);
  }
  // the play page in headless Chrome
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "playlab-publish-code-" + Date.now())}`, "--window-size=1200,800", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 60 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(250); }
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJS = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
  const waitFor = async (expression, timeout = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { let v = null; try { v = await evalJS(expression); } catch {} if (v) return v; await sleep(150); } return null; };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/play/${share}` });
  check("the published game runs in the sandbox (no origin of its own) and says ready", !!(await waitFor(`window.__play && window.__play.ready() && document.getElementById("game").getAttribute("sandbox") === "allow-scripts allow-pointer-lock" && document.getElementById("game").contentDocument === null`)));
  check("the person's player picture reached PlayLab.assets inside the published game", !!(await waitFor(`window.__playState && window.__playState.hud && window.__playState.hud.text === "player picture: yes"`)), await evalJS(`JSON.stringify(window.__playState)`));
  check("the loading line is gone and a play was counted", !!(await waitFor(`document.getElementById("loading").style.display === "none"`)) && !!(await waitFor(`Number(document.getElementById("plays").textContent) >= 1`, 8000)));
  check("restart and pause on the page", await evalJS(`!!document.getElementById("codeRestart") && !!document.getElementById("codePause")`));
  await evalJS(`document.getElementById("codePause").click(); true`);
  check("Pause pauses the game; the button says Resume", !!(await waitFor(`window.__playState.state === "paused" && /Resume/.test(document.getElementById("codePause").textContent)`, 5000)));
  await evalJS(`for (const m of PadRoute.toGame(1, { t: "menu", action: "toggle-pause" })) window.__play.toGame(m); true`);
  check("a phone's menu message through the shared route resumes it", !!(await waitFor(`window.__playState.state === "play"`, 5000)));
  // remix copies the code
  const rem = await api("api/play", { method: "POST", token: B.token, body: { action: "remix", id: share } });
  const rid = rem.data.project?.id || rem.data.id;
  const copy = rid ? await api(`api/projects?id=${rid}`, { token: B.token }) : { data: {} };
  check("a remix copies the game's code to the remixer's account", rem.status === 200 && copy.data.project?.level?.genre === "code" && copy.data.project.level.html.length > 300, { status: rem.status, data: rem.data });
} catch (err) { console.log("ERROR", err.message); fails++; }
finally {
  try { ws?.close(); } catch {} try { chrome?.kill(); } catch {}
  for (const u of made) await srv("srv_delete_user", { p_user: u }).catch(() => {});
  console.log(`deleted ${made.length} test accounts`);
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
