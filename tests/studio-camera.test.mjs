// Phone camera inside the Studio: two headless Chromes. The "computer" opens studio.html and the camera link,
// the "phone" opens pad.html with the synthetic sheet (?fakepaper=1): paper detection, auto-capture, the shot read into an AI
// code plan on the computer (mocked); then the phones play a game written as code in the sandbox (layout, input, menu, 2 players).
// Needs the dev server (node serve.mjs) and either the public PeerServer or the Supabase relay in .env.
//   node tests/studio-camera.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXAMPLES } from "../shared/code-examples.mjs";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.argv[2] || "http://localhost:3000";
const OUT = path.join(os.tmpdir(), "playlab-studio-camera-test");
await fs.mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { process.loadEnvFile(".env"); } catch {}
// A throwaway demo account (needs db/003_server_users.sql and PLAYLAB_SERVER_KEY); deleted at the end.
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, SKEY = process.env.PLAYLAB_SERVER_KEY;
const srv = async (fn, args) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" }, body: JSON.stringify({ p_key: SKEY, ...args }) }); return { status: r.status, data: await r.json().catch(() => null) }; };
const USERNAME = "cam_" + Math.random().toString(36).slice(2, 10), PASSWORD = "Test-" + Math.random().toString(36).slice(2) + "-x";
const made = await srv("srv_create_user", { p_email: null, p_password: PASSWORD, p_username: USERNAME, p_display_name: "Camera Tester", p_credits: 200, p_role: "user", p_is_demo: true, p_tag: "Tester", p_expires_at: null, p_daily_limit: null });
if (made.status !== 200) { console.log("SKIP  this test needs a throwaway account: run db/003_server_users.sql (" + made.status + ")"); process.exit(0); }
const USER_ID = made.data;
let TOKEN = "";

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`); if (!cond) fails++; }

async function browser(name, port, extraFlags = []) {
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(OUT, "profile-" + name)}`, "--window-size=1280,800", ...extraFlags, "about:blank"], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 60 && !wsUrl; i++) { try { const l = await (await fetch(`http://localhost:${port}/json/list`)).json(); wsUrl = l.find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch {} if (!wsUrl) await sleep(250); }
  if (!wsUrl) throw new Error(`Chrome (${name}) did not start`);
  const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1; const pending = new Map(); const errors = [];
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); } else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text); };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const evalJS = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error("JS error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
  const waitFor = async (expression, timeout = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { let v = null; try { v = await evalJS(expression); } catch {} if (v) return v; await sleep(150); } return null; };
  await send("Page.enable"); await send("Runtime.enable");
  return { name, proc, ws, send, evalJS, waitFor, errors, close() { try { ws.close(); } catch {} proc.kill(); } };
}

const pc = await browser("pc", 9343);
const phone = await browser("phone", 9344, ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]);
const api = async (p, init = {}) => (await fetch(`${BASE}/${p}`, { ...init, headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN } })).json();

try {
  // the computer: logged in; its scans are mocked (the phone hands its pictures to the computer, which calls api/scan)
  await pc.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    try { sessionStorage.removeItem("playlab.studio.room"); } catch {}
    window.__pcScans = 0; window.__pcPlans = [];
    const realFetch = window.fetch.bind(window);
    const PLAN = { title: "Paper Maze", genre: "maze", engine: "canvas", goal: "reach the exit", controls: "d-pad", controller: "dpad+jump", win: "exit", lose: "-", entities: ["walls"], opponents: "none", levels: "1", players: 1, notes: "", picture: "a hand-drawn maze" };
    window.fetch = (url, init) => {
      if (/api\\/agent$/.test(String(url))) { const b = JSON.parse(init.body); if (b.task === "plan") { window.__pcPlans.push(b); return Promise.resolve(new Response(JSON.stringify({ plan: PLAN, meta: { model: "mock", ms: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } })); } }
      return realFetch(url, init); };` });
  await pc.send("Page.navigate", { url: `${BASE}/index.html` }); await pc.waitFor(`document.readyState === "complete"`);
  await pc.evalJS(`localStorage.clear(); sessionStorage.clear(); true`);   // the browser profile is reused between runs: drop old sessions
  await pc.send("Page.navigate", { url: `${BASE}/login.html?next=studio.html` });
  await pc.waitFor(`typeof PlayAuth === "object" && !!document.getElementById("passwordBtn")`);
  await pc.evalJS(`document.querySelector('[data-tab="password"]').click(); document.getElementById("user").value = ${JSON.stringify(USERNAME)}; document.getElementById("password").value = ${JSON.stringify(PASSWORD)}; document.getElementById("passwordBtn").click(); true`);
  check("computer logs in", !!(await pc.waitFor(`/studio\\.html$/.test(location.pathname) && typeof S === "object" && !!S.me`, 20_000)));
  TOKEN = await pc.evalJS(`PlayAuth.token()`);
  await pc.waitFor(`typeof S === "object" && S.previewReady`, 20_000);
  await pc.evalJS(`document.getElementById("cameraBtn").click(); true`);
  const code = await pc.waitFor(`/^[A-Z2-9]{4}$/.test(document.getElementById("camCode").textContent) && document.getElementById("camCode").textContent`, 20_000);
  check("studio shows a room code", !!code, code);
  const status = await pc.waitFor(`/waiting|connected/.test(document.getElementById("camStatus").textContent) && document.getElementById("camStatus").textContent`, 20_000);
  check("link is up (PeerServer or relay)", !!status, status);

  // the phone: synthetic sheet, no account and no API calls of its own
  await phone.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__phoneApiCalls = 0; const realFetch = window.fetch.bind(window); window.fetch = (url, init) => { if (/api\\/(scan|fix|agent)/.test(String(url))) window.__phoneApiCalls++; return realFetch(url, init); };` });
  await phone.send("Page.navigate", { url: `${BASE}/pad.html?room=${code}&fakepaper=1` });
  const welcome = await phone.waitFor(`window.__padWelcome && window.__padWelcome.mode`, 30_000);
  check("phone welcomed as a camera", welcome === "camera", welcome);
  const transport = await phone.waitFor(`window.__padTransport`, 5_000);
  console.log("  transport:", transport);
  const captures = await phone.waitFor(`window.__camCaptures >= 1 && window.__camCaptures`, 30_000);
  check("phone captured the sheet", !!captures, captures);
  const scans = await phone.waitFor(`window.__camScans >= 1 && window.__camScans`, 15_000);
  check("phone scanned it", !!scans, scans);
  // a new game: nothing is made without AI code, so the camera shot is read into a plan on the computer (no classic scan)
  check("on a new game the camera shot goes to an AI code plan on the computer (the picture, no scan), not from the phone", !!(await pc.waitFor(`window.__pcPlans.length >= 1 && /^data:image\\/jpeg/.test(window.__pcPlans[0].image || "") || (window.__pcPlans.length >= 1 && (window.__pcPlans[0].image || "").length > 1000)`, 20_000)) && (await pc.evalJS(`window.__pcScans`)) === 0 && (await phone.evalJS(`window.__phoneApiCalls`)) === 0);
  check("the plan card names the picture; the phone says AI code is reading it", !!(await pc.waitFor(`!!S.pendingPlan && /From your picture: a hand-drawn maze/.test(document.body.innerText)`, 20_000)) && !!(await phone.waitFor(`/AI code is reading your drawing|still busy/.test(document.getElementById("camStatus").textContent)`, 10_000)));
  // the phones play a game written as code: the snake example, saved as a version and running in the sandbox
  await pc.evalJS(`S.pendingPlan = null; renderCodeMode(); applyLevel(${JSON.stringify({ genre: "code", engine: "canvas", title: "Snake", theme: "snake", note: "snake v1", prompt: "a snake game", plan: { title: "Snake", genre: "snake", engine: "canvas", goal: "eat", controls: "d-pad", controller: "dpad+jump", win: "-", lose: "-", entities: [], opponents: "none", levels: "-", players: 1, notes: "" }, html: EXAMPLES.snake, notes: { note: "snake v1", built: "x", missing: "" }, objects: [] })}, { note: "snake v1" }); true`);
  check("the code game runs in the sandbox on the computer", !!(await pc.waitFor(`S.level && S.level.genre === "code" && S.codeRun && S.codeRun.ready`, 20_000)));
  const video = await pc.evalJS(`!!document.getElementById("camVideo").srcObject`);
  console.log(`  live video on the studio: ${video ? "yes" : "no (relay or no WebRTC between the two headless browsers)"}`);
  // the phone switches to the controller: it shows the layout the game asked for, its input reaches the game, menu + state sync
  await phone.evalJS(`window.__padClient.sendMode("pad"); true`);
  check("the phone switches to the layout the game asked for (a 4-way d-pad and JUMP)", !!(await phone.waitFor(`window.__padLayout === "dpad+jump" && document.body.classList.contains("pad-dpad")`, 15_000)));
  const shot0 = await pc.evalJS(`askSnapshot()`);
  await phone.evalJS(`window.__padClient.sendInput({ l: 0, r: 0, u: 0, d: 1 }, true); true`); await sleep(900);
  await phone.evalJS(`window.__padClient.sendInput({ l: 0, r: 0, u: 0, d: 0 }, true); true`);
  const shot1 = await pc.evalJS(`askSnapshot()`);
  check("phone input (down on the d-pad) reaches the game in the sandbox: the screen changed", !!shot0 && !!shot1 && shot0 !== shot1);
  await pc.evalJS(`S.code.send({ type: "playlab:menu", action: "restart" }); true`); await sleep(300);
  await phone.evalJS(`window.__padClient.send({ t: "menu", action: "toggle-pause" }); true`);
  const padState = await phone.waitFor(`window.__padState && window.__padState.state === "paused" && window.__padState`, 10_000);
  check("pause from the phone reaches the game and the state comes back (title and score on the phone)", !!padState && (await pc.evalJS(`S.codeRun.lastState`)) === "paused" && /score/.test(await phone.evalJS(`document.getElementById("gameState").textContent`)), padState);
  await phone.evalJS(`window.__padClient.send({ t: "menu", action: "toggle-pause" }); true`);
  check("resume from the phone", !!(await pc.waitFor(`S.codeRun.lastState === "play"`, 5000)));

  // a second phone joins as a controller in slot 2; both are players of the game
  const phone2 = await browser("phone2", 9345);
  try {
    await phone2.send("Page.navigate", { url: `${BASE}/pad.html?room=${code}` });
    const w2 = await phone2.waitFor(`window.__padWelcome && window.__padWelcome`, 30_000);
    check("second phone welcomed as a controller in slot 2", !!w2 && w2.slot === 2 && w2.mode === "pad", w2);
    const listed = await pc.waitFor(`/player 1/.test(document.getElementById("camPlayers").textContent) && /player 2/.test(document.getElementById("camPlayers").textContent) && document.getElementById("camPlayers").textContent`, 10_000);
    check("studio lists both phones", !!listed, listed);
    const state2 = await phone2.waitFor(`window.__padState && window.__padState.players && window.__padState.players.length === 2 && window.__padState`, 10_000);
    check("the game knows both players (PlayLab.players) and the second phone sees them, with the game's layout", !!state2 && (await phone2.evalJS(`window.__padLayout`)) === "dpad+jump", state2 && state2.players);
  } finally { phone2.close(); }

  const own = pc.errors.filter((e) => !/Phaser|peerjs|supabase|WebSocket/i.test(e));
  check("no studio exceptions", own.length === 0, own.slice(0, 2));
} catch (err) {
  console.log("ERROR", err.stack || err.message); fails++;
} finally {
  try { const { projects } = await api("api/projects"); for (const p of projects || []) await api(`api/projects?id=${p.id}`, { method: "DELETE" }); console.log(`cleaned ${projects?.length || 0} test project(s)`); } catch (e) { console.log("cleanup failed:", e.message); }
  try { await srv("srv_delete_user", { p_user: USER_ID }); console.log("deleted the test account"); } catch {}
  pc.close(); phone.close();
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
