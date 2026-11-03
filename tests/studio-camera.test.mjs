// Phone camera inside the Studio: two headless Chromes. The "computer" opens studio.html and the camera link,
// the "phone" opens pad.html with the synthetic sheet (?fakepaper=1): paper detection, auto-capture, ink layer,
// scan (mocked on the phone) and the level lands in the Studio chat as a version.
// Needs the dev server (node serve.mjs) and either the public PeerServer or the Supabase relay in .env.
//   node tests/studio-camera.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
const LEVEL = { theme: "fake paper", aspect: 1.333, objects: [{ type: "platform", label: "ground", x: 0, y: 900, w: 1000, h: 60 }, { type: "start", x: 40, y: 840, w: 40, h: 60 }, { type: "goal", x: 900, y: 840, w: 40, h: 60 }, { type: "platform", label: "ledge", x: 300, y: 760, w: 200, h: 30 }, { type: "coin", x: 380, y: 700, w: 30, h: 30 }, { type: "enemy", x: 600, y: 850, w: 40, h: 50 }] };

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
    const LEVEL = ${JSON.stringify(LEVEL)}; const realFetch = window.fetch.bind(window);
    const PLAN = { title: "Paper Maze", genre: "maze", engine: "canvas", goal: "reach the exit", controls: "d-pad", controller: "dpad+jump", win: "exit", lose: "-", entities: ["walls"], opponents: "none", levels: "1", players: 1, notes: "", picture: "a hand-drawn maze" };
    window.fetch = (url, init) => {
      if (/api\\/agent$/.test(String(url))) { const b = JSON.parse(init.body); if (b.task === "plan") { window.__pcPlans.push(b); return Promise.resolve(new Response(JSON.stringify({ plan: PLAN, meta: { model: "mock", ms: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } })); } }
      if (/api\\/scan$/.test(String(url))) { window.__pcScans++; return Promise.resolve(new Response(JSON.stringify({ level: { ...LEVEL, checked: true, fixes: [] }, meta: { provider: "mock", ms: 1, playtest: { before: { ok: true, problems: [] } } } }), { status: 200, headers: { "Content-Type": "application/json" } })); } return realFetch(url, init); };` });
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
  // an older game made with the classic engine still scans: the classic path for the controller checks below
  await pc.evalJS(`S.pendingPlan = null; renderCodeMode(); applyLevel(${JSON.stringify({ ...LEVEL, note: "older classic game" })}, { note: "older classic game" }); true`);
  await pc.waitFor(`S.level && !S.level.genre && S.versions.length >= 1`, 20_000);
  await phone.evalJS(`window.__camScans = 0; window.__camCaptures = 0; Cam.pending = null; document.getElementById("captureBtn").click(); true`);   // the sheet did not change: capture by hand
  check("on an older classic game the camera still scans on the computer, not on the phone", !!(await pc.waitFor(`window.__pcScans >= 1`, 40_000)) && (await phone.evalJS(`window.__phoneApiCalls`)) === 0);
  check("the phone got the result back", !!(await phone.waitFor(`window.__camLevel && window.__camLevel.objects.length === 6`, 20_000)));

  // the studio: ink arrives first, then the level becomes a version + card + reply
  const ink = await pc.waitFor(`window.__studioInkSeq`, 20_000);
  check("ink layer reached the studio", !!ink, ink);
  const seq = await pc.waitFor(`window.__studioPhoneLevelSeq`, 30_000);
  check("level reached the studio", !!seq, seq);
  await pc.waitFor(`!S.busy && S.versions.length >= 2`, 20_000);
  check("the classic game got a new version from the phone camera", await pc.evalJS(`S.level && S.level.objects.length === 6 && S.versions[0] && S.versions[0].n === 2`), await pc.evalJS(`S.versions.map((v) => v.n + ":" + v.note)`));
  const chatText = await pc.waitFor(`/Redrawn on paper|Level from the phone camera/.test(document.body.innerText)`, 20_000);
  check("card and reply in the chat", !!chatText);
  check("project photo is the phone thumbnail", String(await pc.evalJS(`S.project && S.project.photo || ""`)).startsWith("data:image/jpeg"));
  const video = await pc.evalJS(`!!document.getElementById("camVideo").srcObject`);
  console.log(`  live video on the studio: ${video ? "yes" : "no (relay or no WebRTC between the two headless browsers)"}`);
  const player = await pc.waitFor(`(() => { try { const f = document.getElementById("preview").contentWindow; return !!(f.document.querySelector("canvas")); } catch { return false; } })()`, 10_000);
  check("preview is running", !!player);
  // the phone switches to the controller: it drives the main character in the preview; menu + state sync
  const scene = `document.getElementById("preview").contentWindow.__playlab.scene()`;
  await phone.evalJS(`window.__padClient.sendMode("pad"); true`);
  const pads = await pc.waitFor(`(() => { const p = document.getElementById("preview").contentWindow.__playlab.players(); return p.length === 1 && p[0].slot === 1 ? p : null; })()`, 10_000);
  check("phone in controller mode is player 1 in the preview", !!pads, pads);
  const x0 = await pc.evalJS(`Math.round(${scene}.player.x)`);
  await phone.evalJS(`window.__padClient.sendInput({ l: 0, r: 1 }, true); true`); await sleep(600);
  await phone.evalJS(`window.__padClient.sendInput({ l: 0, r: 0 }, true); true`); await sleep(150);
  const x1 = await pc.evalJS(`Math.round(${scene}.player.x)`);
  check("phone input moves the character in the preview", x1 > x0 + 60, { x0, x1 });
  await phone.evalJS(`window.__padClient.send({ t: "menu", action: "toggle-pause" }); true`);
  const padState = await phone.waitFor(`window.__padState && window.__padState.state === "paused" && window.__padState`, 10_000);
  check("pause from the phone reaches the game and the state comes back", !!padState && (await pc.evalJS(`${scene}.state`)) === "paused" && padState.total > 0, padState);
  await phone.evalJS(`window.__padClient.send({ t: "menu", action: "toggle-pause" }); true`);
  await pc.waitFor(`${scene}.state === "play"`, 5000);
  check("resume from the phone", (await pc.evalJS(`${scene}.state`)) === "play");

  // a second phone joins as a controller and gets its own character
  const phone2 = await browser("phone2", 9345);
  try {
    await phone2.send("Page.navigate", { url: `${BASE}/pad.html?room=${code}` });
    const w2 = await phone2.waitFor(`window.__padWelcome && window.__padWelcome`, 30_000);
    check("second phone welcomed as a controller in slot 2", !!w2 && w2.slot === 2 && w2.mode === "pad", w2);
    const two = await pc.waitFor(`(() => { const s = ${scene}; return s.avatars.length === 2 ? s.avatars.map((a) => a.slot) : null; })()`, 10_000);
    check("preview shows two characters", !!two && two.join() === "1,2", two);
    const p1 = await pc.evalJS(`Math.round(${scene}.player.x)`), p2 = await pc.evalJS(`Math.round(${scene}.avatars[1].obj.x)`);
    await phone2.evalJS(`window.__padClient.sendInput({ l: 0, r: 1 }, true); true`); await sleep(600);
    await phone2.evalJS(`window.__padClient.sendInput({ l: 0, r: 0 }, true); true`); await sleep(150);
    const q1 = await pc.evalJS(`Math.round(${scene}.player.x)`), q2 = await pc.evalJS(`Math.round(${scene}.avatars[1].obj.x)`);
    check("second phone moves only its own character", q2 > p2 + 60 && Math.abs(q1 - p1) < 5, { p1, p2, q1, q2 });
    const listed = await pc.evalJS(`document.getElementById("camPlayers").textContent`);
    check("studio lists both phones", /player 1/.test(listed) && /player 2/.test(listed), listed);
    const state2 = await phone2.waitFor(`window.__padState && window.__padState.players && window.__padState.players.length === 2 && window.__padState`, 10_000);
    check("second phone sees both players in the state", !!state2, state2 && state2.players);
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
