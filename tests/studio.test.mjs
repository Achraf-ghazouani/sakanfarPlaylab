// Headless Chrome test of studio.html: chat loop, projects + messages + versions saved through the real
// /api (Supabase), the preview iframe, history/undo, reload, mobile tabs. AI endpoints (/api/scan, /api/fix)
// are mocked in the page so the test is fast and deterministic; they have their own tests.
// Start the dev server first (node serve.mjs), then:  node tests/studio.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9337;
const BASE = process.argv[2] || "http://localhost:3000";
const OUT = path.join(os.tmpdir(), "playlab-studio-test");
await fs.mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { process.loadEnvFile(".env"); } catch {}
// A throwaway demo account (needs db/003_server_users.sql and PLAYLAB_SERVER_KEY); deleted at the end.
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, SKEY = process.env.PLAYLAB_SERVER_KEY;
const srv = async (fn, args) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" }, body: JSON.stringify({ p_key: SKEY, ...args }) }); return { status: r.status, data: await r.json().catch(() => null) }; };
const USERNAME = "studio_" + Math.random().toString(36).slice(2, 10), PASSWORD = "Test-" + Math.random().toString(36).slice(2) + "-x";
const made = await srv("srv_create_user", { p_email: null, p_password: PASSWORD, p_username: USERNAME, p_display_name: "Studio Tester", p_credits: 200, p_role: "user", p_is_demo: true, p_tag: "Tester", p_expires_at: null, p_daily_limit: null });
if (made.status !== 200) { console.log("SKIP  this test needs a throwaway account: run db/003_server_users.sql (" + made.status + ")"); process.exit(0); }
const USER_ID = made.data;
let TOKEN = "";
/** Log in through login.html (Username tab) in the page driven by evalJS/click/waitFor, then keep the token. */
async function loginInPage(evalJS, waitFor, nav) {
  await evalJS(`localStorage.clear(); sessionStorage.clear(); true`);   // the browser profile is reused between runs: drop old sessions
  await nav(`${BASE}/login.html?next=studio.html`);
  await waitFor(`typeof PlayAuth === "object" && !!document.getElementById("passwordBtn")`);
  await evalJS(`document.querySelector('[data-tab="password"]').click(); document.getElementById("user").value = ${JSON.stringify(USERNAME)}; document.getElementById("password").value = ${JSON.stringify(PASSWORD)}; document.getElementById("passwordBtn").click(); true`);
  const ok = await waitFor(`/studio\\.html$/.test(location.pathname) && typeof S === "object" && !!S.me`, 20_000);
  TOKEN = ok ? await evalJS(`PlayAuth.token()`) : "";
  return !!ok;
}
const PHOTO = path.resolve("photos/level1.jpg");

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, "chrome-profile")}`, "--window-size=1280,800", "about:blank",
], { stdio: "ignore" });

async function getPageWs() {
  for (let i = 0; i < 60; i++) {
    try { const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json(); const page = list.find((t) => t.type === "page"); if (page) return page.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error("Chrome did not start (set CHROME=path\\to\\chrome.exe)");
}
const ws = new WebSocket(await getPageWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
const exceptions = [];
const contexts = [];   // { id, frameId, isDefault }
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else if (msg.method === "Runtime.exceptionThrown") exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  else if (msg.method === "Runtime.executionContextCreated") contexts.push({ id: msg.params.context.id, frameId: msg.params.context.auxData?.frameId, isDefault: msg.params.context.auxData?.isDefault });
  else if (msg.method === "Runtime.executionContextsCleared") contexts.length = 0;
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
async function evalJS(expression, contextId) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
  if (r.exceptionDetails) throw new Error("JS error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expression, { timeout = 10_000, contextId } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { let v = null; try { v = await evalJS(expression, contextId); } catch {} if (v) return v; await sleep(120); }
  return null;
}
let mainFrameId = null;
const iframeCtx = () => contexts.find((c) => c.isDefault && c.frameId !== mainFrameId)?.id;
async function click(selector) { await evalJS(`document.querySelector(${JSON.stringify(selector)}).click(); true`); }
async function type(text) { await evalJS(`(() => { const c = document.getElementById("composer"); c.value = ${JSON.stringify(text)}; c.dispatchEvent(new Event("input")); return true; })()`); }
async function sendMsg() { await click("#sendBtn"); }
async function attachPhoto() {
  const before = await evalJS(`S.attachments.length`);
  const { root } = await send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "#attachInput" });
  await send("DOM.setFileInputFiles", { nodeId, files: [PHOTO] });
  // Chrome fires "change" the first time only; a later upload of the same file needs the event dispatched by hand.
  if (!(await waitFor(`S.attachments.length > ${before}`, { timeout: 1500 }))) {
    await evalJS(`document.getElementById("attachInput").dispatchEvent(new Event("change")); true`);
    await waitFor(`S.attachments.length > ${before}`, { timeout: 4000 });
  }
}
const idle = () => waitFor(`!S.busy`, { timeout: 30_000 });
const api = async (p, init = {}) => { const r = await fetch(`${BASE}/${p}`, { ...init, headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN, ...(init.headers || {}) } }); return r.json(); };

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`); if (!cond) fails++; }

// Mocks for the AI endpoints + a fixed owner, injected before every document (top frame and the preview iframe).
const LEVEL_A = { theme: "lava castle", aspect: 1.333, objects: [
  { type: "platform", label: "ground", x: 0, y: 900, w: 1000, h: 60 }, { type: "start", x: 40, y: 840, w: 40, h: 60 }, { type: "goal", x: 900, y: 840, w: 40, h: 60 },
  { type: "platform", label: "ledge", x: 300, y: 760, w: 200, h: 30 }, { type: "coin", x: 380, y: 700, w: 30, h: 30 }, { type: "enemy", x: 600, y: 850, w: 40, h: 50 } ] };
const LEVEL_B = { ...LEVEL_A, theme: "lava castle", objects: [...LEVEL_A.objects, { type: "coin", x: 700, y: 820, w: 30, h: 30 }] };
const LEVEL_C = { ...LEVEL_B, objects: [...LEVEL_B.objects, { type: "spike", x: 500, y: 870, w: 60, h: 30 }] };
const inject = `
  window.__scanCalls = 0; window.__fixCalls = 0; window.__agentCalls = 0; window.__sawTyping = false;
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.id === "typing") window.__sawTyping = true; }).observe(document.documentElement, { childList: true, subtree: true });
  });
  const LA = ${JSON.stringify(LEVEL_A)}, LB = ${JSON.stringify(LEVEL_B)}, LC = ${JSON.stringify(LEVEL_C)};
  const realFetch = window.fetch.bind(window);
  const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } }));
  window.fetch = (url, init) => {
    const u = String(url);
    if (/api\\/agent$/.test(u)) {
      window.__agentCalls++; const b = JSON.parse(init.body); window.__lastAgentBody = b;
      if (/playtest/i.test(b.message)) return json({ reply: "Running the playtest agent.", actions: [{ type: "playtest" }] });
      if (b.level) return json({ reply: "Changed it.", level: { ...b.level, theme: "edited " + b.level.theme }, kind: "edit", note: "edited by chat", diff: "theme changed", playtest: { ok: true, fixed: 0 }, actions: [] });
      return json({ reply: "Built a lava castle with a ledge and a guard.", level: { ...LA, checked: true, fixes: [] }, kind: "create", note: "lava castle, one ledge", playtest: { ok: true, fixed: 0 }, actions: [] });
    }
    if (/api\\/scan$/.test(u)) { window.__scanCalls++; try { window.__lastScanImage = JSON.parse(init.body).image; } catch {} const lvl = window.__scanCalls === 1 ? LB : LC; return json({ level: { ...lvl, checked: true, fixes: [] }, original: lvl, meta: { provider: "mock", playtest: { before: { ok: true, problems: [] } } } }); }
    if (/api\\/fix$/.test(u)) { window.__fixCalls++; const lvl = JSON.parse(init.body).level; return json({ level: { ...lvl, checked: true, fixes: [] }, report: { before: { ok: true, problems: [] }, after: { ok: true, problems: [] }, fixes: [], fixedBy: null } }); }
    return realFetch(url, init);
  };
`;

try {
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
  const { frameTree } = await send("Page.getFrameTree"); mainFrameId = frameTree.frame.id;

  // 0. landing page: the main button is the waitlist; the Studio needs a login
  await send("Page.navigate", { url: `${BASE}/index.html` });
  await waitFor(`document.readyState === "complete" && typeof TABS === "object"`);   // the page script has run
  await evalJS(`localStorage.clear(); sessionStorage.clear(); true`);   // a visitor: no old session from an earlier run
  await send("Page.navigate", { url: `${BASE}/index.html` });
  await waitFor(`document.readyState === "complete" && typeof TABS === "object"`);
  check("landing page has no leftover photo inputs", await evalJS(`document.querySelectorAll("input[type=file]").length`) === 0);
  check("main button says JOIN THE WAITLIST for visitors", (await evalJS(`document.getElementById("startBtn").textContent`)) === "JOIN THE WAITLIST");
  check("waitlist form with a hidden honeypot", await evalJS(`!!document.getElementById("wlForm") && getComputedStyle(document.querySelector(".wl .hp")).position === "absolute"`));
  await send("Page.navigate", { url: `${BASE}/studio.html` });
  check("the Studio sends visitors to the login page", !!(await waitFor(`/login\\.html$/.test(location.pathname) && /next=studio/.test(location.search)`, { timeout: 15_000 })), await evalJS(`location.href`));
  const loggedIn = await loginInPage(evalJS, (e, t) => waitFor(e, { timeout: t || 10_000 }), (url) => send("Page.navigate", { url }));
  check("username + password login lands in the Studio", loggedIn, await evalJS(`location.href`));
  check("top bar shows the name, credits and the demo badge", await evalJS(`document.getElementById("userName").textContent === "Studio Tester" && document.getElementById("creditNum").textContent === "200" && !!document.getElementById("demoBadge")`));
  await send("Page.navigate", { url: `${BASE}/studio.html?camera=1` });
  check("studio.html?camera=1 opens the camera link", !!(await waitFor(`typeof S === "object" && document.getElementById("camModal").classList.contains("show")`, { timeout: 15_000 })));
  await send("Page.navigate", { url: `${BASE}/studio.html` });
  await waitFor(`typeof S === "object" && document.querySelector(".empty-state") !== null`);
  check("studio loads with the empty state", await evalJS(`!!document.querySelector(".empty-state h2")`));
  check("my games list is empty for a fresh owner", await evalJS(`document.querySelectorAll(".proj").length`) === 0);
  check("preview iframe reports ready", !!(await waitFor(`S.previewReady`, { timeout: 20_000 })));
  const ctx = iframeCtx();
  check("preview shows no-game message", ctx && /No game yet/.test(await evalJS(`document.getElementById("msgText").textContent`, ctx)));
  check("3D toggle and Share are disabled placeholders", await evalJS(`document.querySelector('[data-mode="3d"]').disabled && document.getElementById("shareBtn").disabled`));

  // 1. first text message: project auto-created, reply streamed, both messages saved
  await type("A lava castle with moving platforms"); await sendMsg();
  check("user bubble appears", !!(await waitFor(`document.querySelector(".msg.user .bubble")`)));
  await idle();
  check("typing indicator showed while waiting", await evalJS(`window.__sawTyping`));
  check("assistant reply streamed in", await evalJS(`document.querySelectorAll(".msg.assistant .bubble").length`) === 1);
  const pid = await evalJS(`S.project && S.project.id`);
  check("project auto-created", !!pid, pid);
  check("title taken from the first message", await evalJS(`document.getElementById("title").value`) === "A lava castle with moving platforms");
  check("sidebar lists the new game", !!(await waitFor(`document.querySelectorAll(".proj").length === 1`)));
  check("agent called once with no level and empty history", await evalJS(`window.__agentCalls === 1 && window.__lastAgentBody.level === null && Array.isArray(window.__lastAgentBody.history) && window.__lastAgentBody.history.length === 0`), await evalJS(`window.__lastAgentBody`));
  check("level built from words", await evalJS(`S.level && S.level.objects.length`) === 6);
  check("version 1 created from the chat", await evalJS(`S.versions.length === 1 && S.versions[0].n === 1 && S.versions[0].note === "lava castle, one ledge"`), await evalJS(`S.versions.map((v) => v.n + ":" + v.note)`));
  check("create card rendered", /lava castle, one ledge/.test(await evalJS(`document.body.innerText`)));
  let saved = await api(`api/projects?id=${pid}`);
  check("messages saved to the database", saved.messages?.length === 3 && saved.messages.map((m) => m.role).join() === "user,tool,assistant", saved.messages?.map((m) => m.role));
  const player = await waitFor(`(() => { try { const s = game.scene.getScene("play"); return s && s.player ? { x: Math.round(s.player.x), state: s.state } : null; } catch { return null; } })()`, { contextId: iframeCtx(), timeout: 15_000 });
  check("preview iframe is running the level", !!player && player.state === "play", player);

  // 2. a chat edit: the agent gets the level + history, the result is version 2
  await type("Change theme"); await sendMsg(); await idle();
  check("edit sends the current level and history", await evalJS(`window.__agentCalls === 2 && window.__lastAgentBody.level && window.__lastAgentBody.level.objects.length === 6 && window.__lastAgentBody.history.length === 2 && window.__lastAgentBody.history[0].role === "user"`), await evalJS(`({ h: window.__lastAgentBody.history, n: window.__lastAgentBody.level && window.__lastAgentBody.level.objects.length })`));
  check("edit becomes version 2 with the theme changed", await evalJS(`S.versions[0].n === 2 && S.versions[0].note === "edited by chat" && /^edited /.test(S.level.theme)`), await evalJS(`({ v: S.versions.map((v) => v.n), theme: S.level.theme })`));
  check("edit card shows the diff", /edited by chat/.test(await evalJS(`document.body.innerText`)) && /theme changed/.test(await evalJS(`document.body.innerText`)));

  // 3. attach a picture: scan (mocked, not the agent), level to preview, version 3
  await attachPhoto();
  check("attachment chip shows", !!(await waitFor(`document.querySelectorAll(".attach").length === 1`)));
  await sendMsg(); await idle();
  check("picture goes to the scanner, not the agent", await evalJS(`window.__scanCalls === 1 && window.__agentCalls === 2`), await evalJS(`({ scans: window.__scanCalls, agent: window.__agentCalls })`));
  check("level loaded in the page", await evalJS(`S.level && S.level.objects.length`) === 7);
  check("version 3 created", await evalJS(`S.versions.length === 3 && S.versions[0].n === 3`), await evalJS(`S.versions.map((v) => v.n)`));
  check("preview status text", /7 objects/.test(await evalJS(`document.getElementById("previewStatus").textContent`)));
  check("change card rendered", /Level from your picture/.test(await evalJS(`document.body.innerText`)));
  saved = await api(`api/projects?id=${pid}`);
  check("level + photo saved on the project", saved.project?.level?.objects?.length === 7 && String(saved.project.photo || "").startsWith("data:image/jpeg"));
  check("sidebar thumbnail uses the photo", !!(await waitFor(`document.querySelector(".proj img") !== null`)));

  // 4. playtest chip -> agent action -> /api/fix (mocked) -> card
  await evalJS(`[...document.querySelectorAll(".chip")].find((c) => c.textContent === "Playtest it").click(); true`); await idle();
  check("playtest chip hits /api/fix", await evalJS(`window.__fixCalls`) === 1);
  check("playtest card says reachable", /every platform, coin and goal is reachable/.test(await evalJS(`document.body.innerText`)));

  // 5. second picture -> version 4, history shows all, undo restores v3 as v5
  await attachPhoto();
  check("second attachment accepted", await evalJS(`S.attachments.length`) === 1);
  await sendMsg(); await idle();
  check("second scan gives 8 objects and version 4", await evalJS(`S.level.objects.length === 8 && S.versions[0].n === 4`), await evalJS(`({ n: S.level.objects.length, scans: window.__scanCalls, v: S.versions.map((v) => v.n) })`));
  await click("#historyBtn");
  check("history popover lists 4 versions", await evalJS(`document.getElementById("historyPop").classList.contains("show") && document.querySelectorAll("#historyPop .v").length`) === 4);
  await click("#historyBtn");
  check("undo enabled", await evalJS(`!document.getElementById("undoBtn").disabled`));
  await click("#undoBtn");
  await waitFor(`S.versions[0] && S.versions[0].n === 5`, { timeout: 15_000 }); await idle();
  check("undo restored v3 as a new version 5", await evalJS(`S.versions[0].n === 5 && S.level.objects.length === 7 && /restored v3/.test(S.versions[0].note)`), await evalJS(`S.versions.map((v) => v.n + ":" + v.note)`));
  check("restored card in the chat", /Restored v3/.test(await evalJS(`document.body.innerText`)));
  const v = await api(`api/version?project_id=${pid}&n=2`);
  check("GET /api/version returns a stored version", v.version?.n === 2 && /^edited /.test(v.version.level.theme));

  // 5. rename
  await evalJS(`(() => { const t = document.getElementById("title"); t.value = "Lava Castle"; t.dispatchEvent(new Event("change")); return true; })()`);
  await waitFor(`document.querySelector(".proj .t b") && document.querySelector(".proj .t b").textContent === "Lava Castle"`);
  saved = await api(`api/projects?id=${pid}`);
  check("rename saved", saved.project?.title === "Lava Castle", saved.project?.title);

  // 5b. sketch pad: draw, use the drawing -> scanner -> version 6
  const darkCount = `(() => { const d = Sketch.ctx.getImageData(0, 0, 1200, 900).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++; return n; })()`;
  await click("#sketchBtn");
  check("sketch modal opens", await evalJS(`document.getElementById("sketchModal").classList.contains("show")`));
  const dark0 = await evalJS(darkCount);
  await evalJS(`(() => { const c = document.getElementById("sketchCanvas"); const r = c.getBoundingClientRect();
    const ev = (type, fx, fy) => c.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1, bubbles: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
    ev("pointerdown", 0.05, 0.9); for (let i = 1; i <= 20; i++) ev("pointermove", 0.05 + 0.9 * i / 20, 0.9); ev("pointerup", 0.95, 0.9);
    ev("pointerdown", 0.4, 0.7); ev("pointermove", 0.55, 0.7); ev("pointermove", 0.55, 0.76); ev("pointermove", 0.4, 0.76); ev("pointermove", 0.4, 0.7); ev("pointerup", 0.4, 0.7);
    return true; })()`);
  const dark1 = await evalJS(darkCount);
  check("strokes drawn on the canvas", dark1 > dark0 + 2000, { dark0, dark1 });
  await click("#sketchUndo");
  const dark2 = await evalJS(darkCount);
  check("undo removes the last stroke", dark2 < dark1 && dark2 > dark0, { dark1, dark2 });
  await click("#sketchUse");
  check("drawing sends itself when the composer is empty", await evalJS(`S.busy || S.versions[0].n === 6`));
  await idle();
  check("sketch went through the scanner as version 6", await evalJS(`window.__scanCalls === 3 && S.versions[0].n === 6 && S.versions[0].note === "from sketch" && S.level.objects.length === 8`), await evalJS(`({ scans: window.__scanCalls, v: S.versions.map((v) => v.n + ":" + v.note) })`));
  check("scanner received a JPEG of the sketch", /^data:image\/jpeg;base64,/.test(await evalJS(`window.__lastScanImage || ""`)) && (await evalJS(`(window.__lastScanImage || "").length`)) > 20000, await evalJS(`(window.__lastScanImage || "").length`));
  check("sketch card in the chat", /Level from your sketch/.test(await evalJS(`document.body.innerText`)));
  await click("#sketchBtn");
  check("drawing is kept when the pad reopens", (await evalJS(darkCount)) === dark2);
  await click("#sketchClose");

  // 5c. camera button on a computer: the phone link modal with a room code
  await click("#cameraBtn");
  check("camera modal opens on a computer", await evalJS(`document.getElementById("camModal").classList.contains("show")`));
  const code = await waitFor(`/^[A-Z2-9]{4}$/.test(document.getElementById("camCode").textContent) && document.getElementById("camCode").textContent`, { timeout: 20_000 });
  check("room code and QR rendered", !!code && (await evalJS(`document.querySelector("#camQr svg") !== null && /pad\\.html\\?room=/.test(document.getElementById("camUrl").textContent)`)), code);
  await click("#camClose");

  // 6. reload -> last project reopens with its history and level
  await send("Page.navigate", { url: `${BASE}/studio.html` });
  await waitFor(`typeof S === "object" && S.project && S.project.id === ${JSON.stringify(pid)}`, { timeout: 15_000 });
  await waitFor(`S.previewReady`, { timeout: 20_000 });
  check("reload reopens the last project", await evalJS(`S.project.id`) === pid);
  check("messages restored", (await evalJS(`document.querySelectorAll(".msg, .card").length`)) >= 15, await evalJS(`document.querySelectorAll(".msg, .card").length`));
  check("versions restored", await evalJS(`S.versions.length`) === 6);
  const again = await waitFor(`(() => { try { const s = game.scene.getScene("play"); return !!(s && s.player); } catch { return false; } })()`, { contextId: iframeCtx(), timeout: 15_000 });
  check("preview restarts the saved level after reload", !!again);

  // 7. new game resets the UI, project stays in the list
  await click("#newGameBtn");
  check("new game shows the empty state", await evalJS(`!S.project && !!document.querySelector(".empty-state")`));
  check("old game still listed", await evalJS(`document.querySelectorAll(".proj").length`) === 1);
  await click(".proj");
  await waitFor(`S.project && S.project.id === ${JSON.stringify(pid)}`);
  check("clicking a game in the list opens it", await evalJS(`S.project.id`) === pid);

  // 8. mobile layout: chat/preview tabs
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const mobile = await evalJS(`({ tabs: getComputedStyle(document.querySelector(".mtabs")).display, preview: getComputedStyle(document.querySelector(".preview")).display, chat: getComputedStyle(document.querySelector(".chat")).display })`);
  check("mobile shows tabs, chat first", mobile.tabs === "flex" && mobile.preview === "none" && mobile.chat !== "none", mobile);
  await click("#mtabPreview"); await sleep(200);
  const mobile2 = await evalJS(`({ preview: getComputedStyle(document.querySelector(".preview")).display, chat: getComputedStyle(document.querySelector(".chat")).display })`);
  check("preview tab swaps panes", mobile2.preview !== "none" && mobile2.chat === "none", mobile2);
  await click("#mtabChat");
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await evalJS(`window.__capClicked = 0; document.getElementById("cameraInput").click = () => { window.__capClicked++; }; true`);
  await click("#cameraBtn");
  check("camera button on a phone opens the device camera", (await evalJS(`window.__capClicked`)) === 1 && (await evalJS(`document.getElementById("cameraInput").getAttribute("capture")`)) === "environment" && !(await evalJS(`document.getElementById("camModal").classList.contains("show")`)));
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.clearDeviceMetricsOverride");

  // 9. another owner cannot see the project through the API
  const foreign = await fetch(`${BASE}/api/projects?id=${pid}`);
  check("the project is not reachable without a login", foreign.status === 401, foreign.status);

  const own = exceptions.filter((e) => !/Phaser|peerjs|supabase/i.test(e));
  check("no page exceptions", own.length === 0, own.slice(0, 3));
} catch (err) {
  console.log("ERROR", err.stack || err.message); fails++;
} finally {
  try { const { projects } = await api("api/projects"); for (const p of projects || []) await api(`api/projects?id=${p.id}`, { method: "DELETE" }); console.log(`cleaned ${projects?.length || 0} test project(s)`); } catch (e) { console.log("cleanup failed:", e.message); }
  try { await srv("srv_delete_user", { p_user: USER_ID }); console.log("deleted the test account"); } catch (e) { console.log("account cleanup failed:", e.message); }
  try { ws.close(); } catch {}
  chrome.kill();
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
