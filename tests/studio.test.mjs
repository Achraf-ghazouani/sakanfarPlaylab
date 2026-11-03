// Headless Chrome test of studio.html: chat loop, projects + messages + versions saved through the real
// /api (Supabase), the preview iframe, history/undo, reload, mobile tabs. AI endpoints (/api/scan, /api/fix)
// are mocked in the page so the test is fast and deterministic; they have their own tests.
// Start the dev server first (node serve.mjs), then:  node tests/studio.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { generateArena } from "../shared/arena.mjs";
import { EXAMPLES } from "../lib/code-examples.mjs";
const BROKEN = await fs.readFile("tests/samples/broken.html", "utf8");   // a game that throws at once: the self-healing loop must catch and fix it
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
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",   // WebGL in software: the 3D view and baking a model
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
  else if (msg.method === "Runtime.executionContextDestroyed") { const i = contexts.findIndex((c) => c.id === msg.params.executionContextId); if (i >= 0) contexts.splice(i, 1); }
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
const iframeCtx = () => contexts.findLast((c) => c.isDefault && c.frameId !== mainFrameId)?.id;
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
const ARENA = generateArena("zombie graveyard first person shooter, 5 waves");
const LEVEL_C = { ...LEVEL_B, objects: [...LEVEL_B.objects, { type: "spike", x: 500, y: 870, w: 60, h: 30 }] };
const inject = `
  window.__scanCalls = 0; window.__fixCalls = 0; window.__agentCalls = 0; window.__sawTyping = false;
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.id === "typing") window.__sawTyping = true; }).observe(document.documentElement, { childList: true, subtree: true });
  });
  const LA = ${JSON.stringify(LEVEL_A)}, LB = ${JSON.stringify(LEVEL_B)}, LC = ${JSON.stringify(LEVEL_C)}, AR = ${JSON.stringify(ARENA)};
  // the code builder, mocked: Muse Spark's plan and Muse Wonder's build (the snake example, streamed as the real endpoint streams it)
  const PLAN = { title: "Lap Dash", genre: "racing", engine: "canvas", goal: "Finish 3 laps before the rivals.", controls: "Left and right steer, A is gas, B brakes.", controller: "steering+gas+brake", win: "First after 3 laps", lose: "Last after 3 laps", entities: ["car", "4 rival cars", "track"], opponents: "4 AI cars on the racing line", levels: "3 laps", players: 1, notes: "" };
  const SNAKE = ${JSON.stringify(EXAMPLES.snake)}, BROKEN = ${JSON.stringify(BROKEN)};
  // the first build answers with a game that throws; the fix (free, with the build token) answers with the snake; a change answers with the snake
  const sse = (b, html, extra) => ["start", "progress", "done"].map((e) => "data: " + JSON.stringify(e === "start" ? { e, action: b.change ? "code_edit" : b.task === "fix" ? "fix" : "code_create_2d", cost: 20, balance: 180, model: "mock", modelName: "mock" } : e === "progress" ? { e, chars: 1200, lines: 30 } : { e, html, notes: { note: b.change ? "blue apples" : "snake v1", built: "Steer the snake with the d-pad; eat apples to grow.", missing: "" }, scan: { ok: true, problems: [] }, engine: "canvas", ms: 1, fix: "mock-token", ...extra }) + "\\n\\n").join("");
  const stream = (text) => Promise.resolve(new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const realFetch = window.fetch.bind(window);
  const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } }));
  window.fetch = (url, init) => {
    const u = String(url);
    if (/api\\/build-code$/.test(u)) { const b = JSON.parse(init.body); window.__lastBuildBody = b; const calls = (window.__buildCalls = window.__buildCalls || []); calls.push(b.change || "create"); const first = calls.length === 1; return stream(sse(b, first ? BROKEN : SNAKE, { credits: { spent: b.change ? 6 : 20, balance: 180, action: b.change ? "code_edit" : "code_create_2d", model: "mock" } })); }
    if (/api\\/agent$/.test(u)) {
      window.__agentCalls++; const b = JSON.parse(init.body); window.__lastAgentBody = b;
      if (b.task === "plan") { window.__lastPlanBody = b; return json({ plan: PLAN, meta: { model: "mock", ms: 1 } }); }
      if (b.task === "fix") { (window.__fixBodies = window.__fixBodies || []).push(b); return stream(sse(b, SNAKE, { attempt: window.__fixBodies.length })); }
      if (b.task === "look") { window.__lookBody = b; return json({ match: 0.9, looksLike: "a green snake on a dark grid with a score", problems: [], suggestion: "", model: "mock", ms: 1 }); }
      if (/playtest/i.test(b.message)) return json({ reply: "Running the playtest agent.", actions: [{ type: "playtest" }] });
      if (/racing/i.test(b.message)) return realFetch(url, init);   // the real agent answers for free: it hands racing to the code builder
      if (/top.?down/i.test(b.message) && b.level && b.level.genre === "arena") return json({ reply: "Top-down it is.", actions: [{ type: "view", view: "top" }] });
      if (/shooter|zombie/i.test(b.message)) return json({ reply: "Zombies incoming!", level: AR, kind: "create", note: "zombie graveyard, 5 waves", playtest: { ok: true, fixed: 0, fixes: [] }, actions: [] });
      if (/lava castle/i.test(b.message)) return json({ reply: "Built a lava castle with a ledge and a guard.", level: { ...LA, checked: true, fixes: [] }, kind: "create", note: "lava castle, one ledge", playtest: { ok: true, fixed: 0 }, actions: [] });
      if (b.level) return json({ reply: "Changed it.", level: { ...b.level, theme: "edited " + b.level.theme }, kind: "edit", note: "edited by chat", diff: "theme changed", playtest: { ok: true, fixed: 0 }, actions: [] });
      return json({ reply: "Built a lava castle with a ledge and a guard.", level: { ...LA, checked: true, fixes: [] }, kind: "create", note: "lava castle, one ledge", playtest: { ok: true, fixed: 0 }, actions: [] });
    }
    if (/api\\/scan$/.test(u)) { window.__scanCalls++; try { window.__lastScanImage = JSON.parse(init.body).image; } catch {} const lvl = window.__scanCalls === 1 ? LB : LC; return json({ level: { ...lvl, checked: true, fixes: [] }, original: lvl, meta: { provider: "mock", playtest: { before: { ok: true, problems: [] } } } }); }
    if (/api\\/art$/.test(u)) {
      const b = JSON.parse(init.body); (window.__artCalls = window.__artCalls || []).push(b.task);
      if (b.task === "classify") return json({ ...(window.__classifyAs || { role: "level", kind: "level", objRole: null, name: "a level" }), confidence: 0.9, hint: "", credits: { spent: 1 } });
      if (b.task === "cutout") return new Response(JSON.stringify({ error: "mock: no SAM here" }), { status: 502, headers: { "Content-Type": "application/json" } });   // the page falls back to its free fill
      return json({ image: b.image, kind: b.kind, role: b.role, credits: { spent: 15 } });   // the "sprite" is the picture itself
    }
    if (/api\\/fix$/.test(u)) { window.__fixCalls++; const lvl = JSON.parse(init.body).level; return json({ level: { ...lvl, checked: true, fixes: [] }, report: { before: { ok: true, problems: [] }, after: { ok: true, problems: [] }, fixes: [], fixedBy: null } }); }
    return realFetch(url, init);
  };
`;

try {
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
  const { frameTree } = await send("Page.getFrameTree"); mainFrameId = frameTree.frame.id;

  // 0. landing page: the main button opens the Studio (which needs a login), the waitlist is offered once
  await send("Page.navigate", { url: `${BASE}/index.html` });
  await waitFor(`document.readyState === "complete" && typeof discover === "function"`);   // the page script has run
  await evalJS(`localStorage.clear(); sessionStorage.clear(); true`);   // a visitor: no old session from an earlier run
  await send("Page.navigate", { url: `${BASE}/index.html` });
  await waitFor(`document.readyState === "complete" && typeof discover === "function"`);
  check("landing page has no leftover photo inputs", await evalJS(`document.querySelectorAll("input[type=file]").length`) === 0);
  check("main button starts creating in the Studio", await evalJS(`(() => { const b = document.getElementById("startBtn"); return b.textContent === "START CREATING" && /studio\.html$/.test(b.href); })()`));
  check("visitors see the waitlist note", await evalJS(`!document.getElementById("betaNote").hidden`));
  check("waitlist form with a hidden honeypot", await evalJS(`!!document.getElementById("wlForm") && getComputedStyle(document.querySelector(".wl .hp")).position === "absolute"`));
  await send("Page.navigate", { url: `${BASE}/studio.html` });
  check("the Studio sends visitors to the login page", !!(await waitFor(`/login\\.html$/.test(location.pathname) && /next=studio/.test(location.search)`, { timeout: 15_000 })), await evalJS(`location.href`));
  const loggedIn = await loginInPage(evalJS, (e, t) => waitFor(e, { timeout: t || 10_000 }), (url) => send("Page.navigate", { url }));
  check("username + password login lands in the Studio", loggedIn, await evalJS(`location.href`));
  check("first screen: fresh layout, chat box at the bottom center", await evalJS(`document.body.classList.contains("fresh") && (() => { const r = document.querySelector(".chat").getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2) < 4 && innerHeight - r.bottom < 60; })()`));
  check("first screen offers the drawing starts and Add your character", await evalJS(`[...document.querySelectorAll(".starts button")].map((b) => b.dataset.start).join()`) === "sketch,upload,camera,player");
  check("the unfinished 3D mode switch is hidden; Publish waits for a game", await evalJS(`getComputedStyle(document.getElementById("modeSeg")).display === "none" && getComputedStyle(document.getElementById("publishBtn")).display === "none"`));
  await evalJS(`document.querySelector('.starts [data-start="sketch"]').click(); true`);
  check("Sketch it opens the sketch pad", await evalJS(`document.getElementById("sketchModal").classList.contains("show")`));
  await evalJS(`document.getElementById("sketchClose").click(); true`);
  { const shot = await send("Page.captureScreenshot", { format: "png" }); await fs.writeFile(path.join(OUT, "studio-start.png"), Buffer.from(shot.data, "base64")); }
  check("top bar shows the name, credits and the demo badge", await evalJS(`document.getElementById("userName").textContent === "Studio Tester" && document.getElementById("creditNum").textContent === "200" && !!document.getElementById("demoBadge")`));
  await send("Page.navigate", { url: `${BASE}/studio.html?camera=1` });
  check("studio.html?camera=1 opens the camera link", !!(await waitFor(`typeof S === "object" && document.getElementById("camModal").classList.contains("show")`, { timeout: 15_000 })));
  await send("Page.navigate", { url: `${BASE}/studio.html` });
  await waitFor(`typeof S === "object" && document.body.classList.contains("fresh")`);
  check("the loading screen is gone once the Studio is on screen", !!(await waitFor(`!document.getElementById("boot") || document.getElementById("boot").classList.contains("off")`)));
  check("the loading screen has its words and its failure hooks", await evalJS(`typeof bootDone === "function" && typeof bootError === "function" && Array.isArray(window.__bootWords) && window.__bootWords.length === 5`));
  check("studio loads on the welcome screen", await evalJS(`getComputedStyle(document.getElementById("emptyState")).display === "flex"`));
  check("my games list is empty for a fresh owner", await evalJS(`document.querySelectorAll(".proj").length`) === 0);
  check("preview iframe reports ready", !!(await waitFor(`S.previewReady`, { timeout: 20_000 })));
  const ctx = iframeCtx();
  check("preview shows no-game message", ctx && /Your game appears here/.test(await evalJS(`document.getElementById("msgText").textContent`, ctx)));
  check("the old 3D toggle is a disabled placeholder", await evalJS(`document.querySelector('[data-mode="3d"]').disabled`));

  // 0b. languages: the chrome switches to French and Arabic (right-to-left) and back, the chips keep their price tags
  await evalJS(`I18N.set("fr"); true`);
  check("French: the welcome, the chips and the chat box follow", await evalJS(`document.querySelector(".welcome h2").textContent === "Qu'est-ce qu'on construit aujourd'hui ?" && document.querySelector("#chips .chip").dataset.label === "Plus difficile" && document.getElementById("composer").placeholder.startsWith("Décrivez") && document.documentElement.lang === "fr"`), await evalJS(`({ h2: document.querySelector(".welcome h2").textContent, chip: document.querySelector("#chips .chip").dataset.label, ph: document.getElementById("composer").placeholder })`));
  await evalJS(`I18N.set("ar"); true`);
  check("Arabic: right-to-left, the pad's words in Arabic, the example prompts translated", await evalJS(`document.documentElement.dir === "rtl" && document.body.classList.contains("rtl") && document.querySelector(".welcome h2").textContent === "ماذا نبني اليوم؟" && document.querySelector(".examples button").dataset.prompt === "قلعة من الحمم بمنصات متحركة"`), await evalJS(`({ dir: document.documentElement.dir, prompt: document.querySelector(".examples button").dataset.prompt })`));
  check("the choice is remembered", await evalJS(`localStorage.getItem("playlab.lang")`) === "ar");
  await waitFor(`S.costs && S.costs.edit_2d`);   // the price list arrives in the background; the chips' tags need it
  await evalJS(`I18N.set("en"); true`);
  check("English again, left-to-right, the chips re-labelled with their cost", await evalJS(`document.documentElement.dir === "ltr" && document.querySelector(".welcome h2").textContent === "What are we building today?" && document.querySelector("#chips .chip").dataset.label === "Make it harder" && document.querySelector("#chips .chip .cost") !== null && document.querySelector(".examples button").dataset.prompt === "A lava castle with moving platforms"`));
  check("the account menu has the switch with English on", await evalJS(`[...document.querySelectorAll("#userPop [data-lang]")].map((b) => b.dataset.lang + (b.classList.contains("on") ? "*" : "")).join()`) === "en*,fr,ar");

  // 1. first text message: project auto-created, reply streamed, both messages saved
  await type("A lava castle with moving platforms"); await sendMsg();
  check("user bubble appears", !!(await waitFor(`document.querySelector(".msg.user .bubble")`)));
  check("first message switches to the chat panel on the left", await evalJS(`!document.body.classList.contains("fresh") && document.querySelector(".chat").getBoundingClientRect().left < 5`));
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
  const think1 = await evalJS(`(() => { const c = [...document.querySelectorAll(".card.think")].pop(); return c ? { title: c.querySelector(".th b").textContent, steps: [...c.querySelectorAll(".steps li")].map((l) => l.className + ":" + l.textContent) } : null; })()`);
  check("the AI thinking panel: designing (Muse Spark), built, jumps checked, no problems, ready", !!think1 && /Designing/.test(think1.title) && think1.steps.length === 5 && /s-done:Designing[^]*Muse Spark 1\.3/.test(think1.steps[0]) && /Built: 6 objects/.test(think1.steps[1]) && /Checking every jump/.test(think1.steps[2]) && /No problems/.test(think1.steps[3]) && /Ready/.test(think1.steps[4]), think1);
  let saved = await api(`api/projects?id=${pid}`);
  check("messages saved to the database (the user's words, the AI steps, the level card, the reply)", saved.messages?.length === 4 && saved.messages.map((m) => m.role).join() === "user,tool,tool,assistant" && /Designing[^]*Ready/.test(saved.messages[1].content), saved.messages?.map((m) => m.role));
  const player = await waitFor(`(() => { try { const s = game.scene.getScene("play"); return s && s.player ? { x: Math.round(s.player.x), state: s.state } : null; } catch { return null; } })()`, { contextId: iframeCtx(), timeout: 15_000 });
  check("preview iframe is running the level", !!player && player.state === "play", player);
  check("game layout: chat on the left, the game in the center", await evalJS(`!document.body.classList.contains("building") && document.querySelector(".preview").getBoundingClientRect().left >= 300`));
  { const shot = await send("Page.captureScreenshot", { format: "png" }); await fs.writeFile(path.join(OUT, "studio-game.png"), Buffer.from(shot.data, "base64")); }

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
  const think2 = await evalJS(`(() => { const c = [...document.querySelectorAll(".card.think")].pop(); return c ? [...c.querySelectorAll(".steps li")].map((l) => l.textContent) : null; })()`);
  check("the panel for a scan continues the picture's: looked at, reading the drawing, objects found, jumps, ready", !!think2 && think2.some((l) => /It is a level/.test(l)) && think2.some((l) => /Reading the drawing/.test(l)) && think2.some((l) => /Objects found: 7/.test(l)) && think2.some((l) => /Checking every jump/.test(l)) && /Ready/.test(think2[think2.length - 1]), think2);
  saved = await api(`api/projects?id=${pid}`);
  check("level + photo saved on the project", saved.project?.level?.objects?.length === 7 && String(saved.project.photo || "").startsWith("data:image/jpeg"));
  check("sidebar thumbnail uses the photo", !!(await waitFor(`document.querySelector(".proj img") !== null`)));

  // 4. playtest chip -> agent action -> /api/fix (mocked) -> card
  await evalJS(`[...document.querySelectorAll(".chip")].find((c) => (c.dataset.label || c.textContent) === "Playtest it").click(); true`); await idle();
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
  const v = await api(`api/projects?id=${pid}&version=2`);
  check("GET /api/projects?version=n returns a stored version", v.version?.n === 2 && /^edited /.test(v.version.level.theme));

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

  // 5d. a picture sent with "use this as my player" becomes the player character (Muse Image sprite, mocked), not a level
  await evalJS(`(async () => {
    const c = document.createElement("canvas"); c.width = 300; c.height = 400; const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 400); grad.addColorStop(0, "#d9dde3"); grad.addColorStop(1, "#c4c9d1"); g.fillStyle = grad; g.fillRect(0, 0, 300, 400);
    g.fillStyle = "#6d28d9"; g.fillRect(110, 140, 80, 150); g.fillStyle = "#f5d0b5"; g.beginPath(); g.arc(150, 105, 42, 0, 7); g.fill();
    g.fillStyle = "#111"; g.fillRect(115, 290, 25, 70); g.fillRect(160, 290, 25, 70);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    await addAttachment(new File([blob], "hero.png", { type: "image/png" })); return true; })()`);
  await type("use this as my player");
  check("the picture's toggle switches to Player from the words", await evalJS(`document.querySelector(".attach .role")?.classList.contains("player")`));
  check("the send line says Muse Image draws the player", /Muse Image draws the player/.test(await evalJS(`document.getElementById("sendCost").textContent`)));
  await evalJS(`window.__artCalls = []; true`);
  const scansBefore = await evalJS(`window.__scanCalls`), agentBefore = await evalJS(`window.__agentCalls`), versionsBefore = await evalJS(`S.versions.length`);
  await sendMsg(); await idle();
  check("a player picture skips the scanner and the agent", await evalJS(`window.__scanCalls === ${scansBefore} && window.__agentCalls === ${agentBefore} && S.versions.length === ${versionsBefore}`), await evalJS(`({ scans: window.__scanCalls, agent: window.__agentCalls })`));
  check("the words skip the look-at step and go straight to Muse Image", await evalJS(`window.__artCalls.join()`) === "sprite", await evalJS(`window.__artCalls`));
  check("the player picture is saved on the game", (await api(`api/projects?id=${pid}`)).project?.art?.player?.match(/^data:image\/(webp|png);base64,/));
  check("player card in the chat", /New player character/.test(await evalJS(`document.body.innerText`)));
  const worn = await waitFor(`(() => { try { const a = game.scene.getScene("play").avatars[0]; return a && a.sprite && a.skin.type === "Image"; } catch { return false; } })()`, { contextId: iframeCtx(), timeout: 10_000 });
  check("the preview's main character wears the picture", !!worn);
  check("the background was cut away (corner and between the legs clear, body solid)", await evalJS(`(async () => { const i = new Image(); i.src = S.project.art.player; await i.decode(); const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const x = c.getContext("2d"); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, i.width, i.height).data; const at = (px, py) => d[(py * i.width + px) * 4 + 3]; return at(0, 0) <= 5 && at(Math.round(i.width / 2), i.height - 8) <= 5 && at(Math.round(i.width / 2), Math.round(i.height / 2)) >= 250 && i.height === 256; })()`));

  // 5e. a picture with no words: Muse Spark looks at it (mocked: an enemy), Muse Image draws it, every enemy wears it
  await evalJS(`(async () => {
    window.__artCalls = []; window.__classifyAs = { role: "enemy", kind: "object", objRole: "enemy", name: "red blob" };
    const c = document.createElement("canvas"); c.width = 300; c.height = 300; const g = c.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, 300, 300); g.fillStyle = "#dc2626"; g.beginPath(); g.ellipse(150, 170, 90, 70, 0, 0, 7); g.fill();
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    await addAttachment(new File([blob], "blob.png", { type: "image/png" })); return true; })()`);
  check("a picture with no words is on Auto", await evalJS(`document.querySelector(".attach .role")?.classList.contains("auto")`));
  await sendMsg(); await idle();
  check("Auto: looked at first, then drawn", await evalJS(`window.__artCalls.join()`) === "classify,sprite", await evalJS(`window.__artCalls`));
  check("the enemy sprite is saved on the game", !!(await api(`api/projects?id=${pid}`)).project?.art?.sprites?.enemy?.match(/^data:image\/(webp|png);base64,/));
  check("the chat says it will be the enemy", /it will be the enemy/.test(await evalJS(`document.body.innerText`)) && /New enemy sprite/.test(await evalJS(`document.body.innerText`)));
  const enemiesWear = await waitFor(`(() => { try { const es = game.scene.getScene("play").enemies.getChildren(); return es.length > 0 && es.every((e) => !!e.getData("art")); } catch { return false; } })()`, { contextId: iframeCtx(), timeout: 10_000 });
  check("every enemy in the preview wears the sprite", !!enemiesWear);
  await evalJS(`window.__classifyAs = null; true`);

  // 5e2. many files at once: the review grid, roles set by hand, Apply all -> assets on the game and one Detected card
  await evalJS(`(async () => { const files = []; for (const n of ["button.png", "background.png", "icon_heart.png"]) { const b = await (await fetch("tests/samples/" + n, { cache: "no-store" })).blob(); files.push(new File([b], n, { type: "image/png" })); } await addFiles(files); return true; })()`);
  check("three pictures open the review grid with three cards and empty the attachments", await evalJS(`document.getElementById("reviewModal").classList.contains("show") && document.querySelectorAll("#reviewGrid .rcard").length === 3 && S.attachments.length === 0`));
  check("the grid preselects the local guesses (button sure, the others ask)", await evalJS(`[...document.querySelectorAll("#reviewGrid select[data-role]")].map((s) => s.value).join()`) === "ui_button,auto,auto", await evalJS(`[...document.querySelectorAll("#reviewGrid select[data-role]")].map((s) => s.value)`));
  check("the grid says the game stays 2D", /2D/.test(await evalJS(`document.getElementById("reviewEngine").textContent`)));
  const pick = async (i, role) => evalJS(`(() => { const s = document.querySelector("#reviewGrid select[data-role][data-i='${i}']"); s.value = "${role}"; s.dispatchEvent(new Event("change")); return true; })()`);
  const hint = async (i, h) => evalJS(`(() => { const s = document.querySelector("#reviewGrid select[data-hint][data-i='${i}']"); if (!s) return false; s.value = "${h}"; s.dispatchEvent(new Event("change")); return true; })()`);
  await pick(1, "background"); await pick(2, "ui_icon"); await hint(0, "pause"); await hint(2, "heart");
  check("hint pickers appear for buttons and icons only", await evalJS(`[...document.querySelectorAll("#reviewGrid select[data-hint]")].map((s) => s.dataset.i).join()`) === "0,2");
  await evalJS(`window.__artCalls = []; true`);
  await click("#reviewApply"); await idle();
  const batchAssets = (await api(`api/projects?id=${pid}`)).project?.art?.assets || [];
  check("Apply all saved the three assets with their roles and hints, no AI call", batchAssets.map((a) => a.role + (a.hint ? ":" + a.hint : "")).sort().join() === "background,ui_button:pause,ui_icon:heart" && (await evalJS(`window.__artCalls.length`)) === 0, batchAssets.map((a) => [a.role, a.hint]));
  check("one Detected card sums the batch up", /Detected[^]*?1 pause UI button, 1 background, 1 heart UI icon\. Game is 2D\./.test(await evalJS(`document.getElementById("messages").innerText`)), (await evalJS(`document.getElementById("messages").innerText`)).split("Detected").pop()?.slice(0, 120));
  check("the grid is closed and nothing is left attached", await evalJS(`!document.getElementById("reviewModal").classList.contains("show") && S.attachments.length === 0 && !S.batch`));

  // 5f. the 2D / 3D switch in the chat box: saved on the game, sent to the agent (3D prices) and drawn in 3D by the preview
  check("the chat box has a 2D / 3D switch on 2D", await evalJS(`document.querySelector("#dimSeg [data-dim='2d']").classList.contains("on")`));
  await evalJS(`document.querySelector("#dimSeg [data-dim='3d']").click(); true`);
  check("3D is selected", await evalJS(`S.mode === "3d" && document.querySelector("#dimSeg [data-dim='3d']").classList.contains("on")`));
  const in3d = await waitFor(`typeof View3D === "object" && View3D.on && !!document.getElementById("view3d") && document.querySelector("#game canvas:not(#view3d)").style.visibility === "hidden"`, { contextId: iframeCtx(), timeout: 20_000 });
  check("the preview draws the game in 3D (three.js canvas on, 2D canvas hidden)", !!in3d);
  check("the game type is saved as 3d-side", !!(await waitFor(`true`)) && (await api(`api/projects?id=${pid}`)).project?.mode === "3d-side");
  check("the send line shows the 3D price", /3D game/.test(await evalJS(`(() => { const c = document.getElementById("composer"); c.value = "more coins"; c.dispatchEvent(new Event("input")); return document.getElementById("sendCost").textContent; })()`)));
  await sendMsg(); await idle();
  check("the agent is told the game is 3D", await evalJS(`window.__lastAgentBody && window.__lastAgentBody.mode === "3d"`));
  const stillIn3d = await waitFor(`View3D.on && game.scene.getScene("play").state === "play"`, { contextId: iframeCtx(), timeout: 15_000 });
  check("the edited level plays in 3D", !!stillIn3d);
  await new Promise((r) => setTimeout(r, 800));
  { const shot = await send("Page.captureScreenshot", { format: "png" }); await fs.writeFile(path.join(OUT, "studio-3d.png"), Buffer.from(shot.data, "base64")); }
  await evalJS(`document.querySelector("#dimSeg [data-dim='2d']").click(); true`);
  const back2d = await waitFor(`!View3D.on && document.querySelector("#game canvas:not(#view3d)").style.visibility === ""`, { contextId: iframeCtx(), timeout: 10_000 });
  check("back to 2D", !!back2d && await evalJS(`S.mode === "2d"`));

  // 6a. arriving again (not a reload) starts on the welcome screen, with a button to continue the last game
  await send("Page.navigate", { url: `${BASE}/studio.html` });
  check("a new visit starts on the welcome screen", !!(await waitFor(`typeof S === "object" && !!S.me && document.body.classList.contains("fresh") && !document.getElementById("continueBtn").hidden`, { timeout: 15_000 })));
  check("Continue names the last game", /Lava Castle/.test(await evalJS(`document.getElementById("continueBtn").textContent`)));
  // 6b. reload -> last project reopens with its history and level
  await send("Page.reload");
  await waitFor(`typeof S === "object" && S.project && S.project.id === ${JSON.stringify(pid)}`, { timeout: 15_000 });
  await waitFor(`S.previewReady`, { timeout: 20_000 });
  check("reload reopens the last project", await evalJS(`S.project.id`) === pid);
  check("messages restored", (await evalJS(`document.querySelectorAll(".msg, .card").length`)) >= 15, await evalJS(`document.querySelectorAll(".msg, .card").length`));
  check("versions restored (6 + the 3D edit)", await evalJS(`S.versions.length`) === 7);
  const again = await waitFor(`(() => { try { const s = game.scene.getScene("play"); return !!(s && s.player); } catch { return false; } })()`, { contextId: iframeCtx(), timeout: 15_000 });
  check("preview restarts the saved level after reload", !!again);
  const wornAgain = await waitFor(`(() => { try { return !!game.scene.getScene("play").avatars[0].sprite; } catch { return false; } })()`, { contextId: iframeCtx(), timeout: 10_000 });
  check("the player picture comes back after reload", !!wornAgain);

  // 7. new game resets the UI, project stays in the list
  await click("#newGameBtn");
  check("new game goes back to the welcome screen", await evalJS(`!S.project && document.body.classList.contains("fresh")`));
  check("old game still listed", await evalJS(`document.querySelectorAll(".proj").length`) === 1);
  await click(".proj");
  await waitFor(`S.project && S.project.id === ${JSON.stringify(pid)}`);
  check("clicking a game in the list opens it", await evalJS(`S.project.id`) === pid);

  // 7b. a 3D model switches the game to 3D and becomes the player; "Undo, stay 2D" bakes it into a sprite sheet
  await evalJS(`setDim("2d"); true`);
  await evalJS(`(async () => { const b = await (await fetch("tests/samples/cube.glb", { cache: "no-store" })).blob(); await addFiles([new File([b], "cube.glb", { type: "model/gltf-binary" })]); return true; })()`);
  check("a .glb attaches with its bytes and no review grid", await evalJS(`S.attachments.length === 1 && S.attachments[0].model === true && /^data:/.test(S.attachments[0].modelSrc || "") && !document.getElementById("reviewModal").classList.contains("show")`));
  await sendMsg(); await idle();
  check("the game switched to 3D with the message, the model saved as the player", await evalJS(`S.mode === "3d" && /switched the game to 3D/.test(document.getElementById("messages").innerText) && S.project.art.model?.role === "player" && S.project.art.model.name === "cube.glb"`), await evalJS(`({ mode: S.mode, model: S.project.art.model && S.project.art.model.name })`));
  check("the game type is saved as 3d-side and the model with the art", (await api(`api/projects?id=${pid}`)).project?.mode === "3d-side" && /^data:/.test((await api(`api/projects?id=${pid}`)).project?.art?.model?.src || ""));
  check("Detected names the model", /Detected[^]*?1 3D model \(player\)\. Game is 3D\./.test(await evalJS(`document.getElementById("messages").innerText`)));
  check("an Undo, stay 2D chip is offered", await evalJS(`!![...document.querySelectorAll(".card .choices button")].find((b) => /stay 2D/.test(b.textContent))`));
  await evalJS(`[...document.querySelectorAll(".card .choices button")].find((b) => /stay 2D/.test(b.textContent)).click(); true`);
  await waitFor(`S.mode === "2d" && !S.busy && /baked/i.test(document.getElementById("messages").innerText)`, { timeout: 40_000 }); await idle();
  const baked = (await api(`api/projects?id=${pid}`)).project?.art?.assets?.find((a) => /baked/.test(a.name));
  check("back in 2D with the model baked into a 4-frame sprite sheet", !!baked && baked.role === "spritesheet" && baked.grid?.cols === 4 && baked.grid.rows === 1 && /^data:image\/png/.test(baked.src) && baked.w === 4 * Math.round(baked.h * 0.9), baked ? { name: baked.name, grid: baked.grid, w: baked.w, h: baked.h } : await evalJS(`document.getElementById("messages").innerText.slice(-300)`));
  check("the game type is back to 2d", (await api(`api/projects?id=${pid}`)).project?.mode === "2d");
  // a picture into a 3D game keeps 3D and offers the way back
  await evalJS(`setDim("3d"); true`);
  await evalJS(`(async () => { const b = await (await fetch("tests/samples/panel.png", { cache: "no-store" })).blob(); await addFiles([new File([b], "panel.png", { type: "image/png" })]); return true; })()`);
  await type("this is my panel"); await sendMsg(); await idle();
  check("a picture in a 3D game stays 3D and offers Switch to 2D instead", await evalJS(`S.mode === "3d" && !![...document.querySelectorAll(".card .choices button")].find((b) => /Switch to 2D/.test(b.textContent))`));
  await evalJS(`[...document.querySelectorAll(".card .choices button")].find((b) => /Switch to 2D/.test(b.textContent)).click(); true`);
  await sleep(300);
  check("one tap and it is 2D again", await evalJS(`S.mode === "2d"`));

  // 8. a shooter: the (mocked) agent answers with an arena, the preview switches to arena.html, 2D locks, views switch
  await click("#newGameBtn");
  await type("a first person shooter with zombie waves");
  check("the send line shows the 3D price for a shooter", /3D game/.test(await evalJS(`document.getElementById("sendCost").textContent`)), await evalJS(`document.getElementById("sendCost").textContent`));
  await sendMsg(); await idle();
  check("the game is an arena", await evalJS(`S.level && S.level.genre === "arena" && S.level.view === "fps" && S.level.waves === 5`));
  check("the preview switched to the arena engine", await evalJS(`document.getElementById("preview").getAttribute("src")`) === "arena.html?embed=1");
  const arenaUp = await waitFor(`S.previewReady`, { timeout: 20_000 });
  const inArena = arenaUp && await waitFor(`!!(window.__arena && window.__arena.G.level && window.__arena.G.level.genre === "arena" && window.__arena.G.spawners.length >= 3)`, { contextId: iframeCtx(), timeout: 20_000 });
  check("arena.html built the shooter (gates and all)", !!inArena);
  check("the 2D / 3D switch is locked to 3D", await evalJS(`S.mode === "3d" && document.querySelector("#dimSeg [data-dim='2d']").disabled && document.querySelector("#dimSeg [data-dim='3d']").classList.contains("on")`));
  const apid = await evalJS(`S.project.id`);
  check("the game type is saved as 3d-world", (await api(`api/projects?id=${apid}`)).project?.mode === "3d-world");
  check("the chat card names the shooter", /first person shooter · 5 waves/.test(await evalJS(`document.body.innerText`)));
  check("the status line names the shooter", /first person shooter · 5 waves/.test(await evalJS(`document.getElementById("previewStatus").textContent`)));
  await new Promise((r) => setTimeout(r, 600));
  { const shot = await send("Page.captureScreenshot", { format: "png" }); await fs.writeFile(path.join(OUT, "studio-arena.png"), Buffer.from(shot.data, "base64")); }
  await type("switch to top down"); await sendMsg(); await idle();
  const viewNow = await waitFor(`window.__arena.G.view === "top" ? "top" : null`, { contextId: iframeCtx(), timeout: 5_000 });
  check("a view switch changes the arena's camera and is kept on the level", viewNow === "top" && await evalJS(`S.level.view === "top"`));
  await type("A lava castle with moving platforms"); await sendMsg(); await idle();
  check("a platformer after a shooter brings the platformer engine back", await evalJS(`document.getElementById("preview").getAttribute("src")`) === "game.html?embed=1" && await evalJS(`!S.level.genre`));
  check("the 2D / 3D switch is free again", await evalJS(`!document.querySelector("#dimSeg [data-dim='2d']").disabled`));

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

  // 8b. a kind of game the engines do not have: the real agent answers for free and hands it to the code builder: a plan card
  // (mocked Muse Spark) with Go / Simpler chips and no game yet; Go streams the build (mocked Muse Wonder: the snake example)
  // into the thinking panel, the game is saved as a code level and a version through the real API and runs in the sandbox;
  // words on it rewrite it (mocked edit); a new game restores the engines' preview
  await click("#newGameBtn");
  await type("a car racing game with 3 laps");
  check("the send line announces a free plan first for a racing game", /free plan first/.test(await evalJS(`document.getElementById("sendCost").textContent`)));
  await sendMsg(); await idle();
  const planCard = await evalJS(`[...document.querySelectorAll(".card")].map((c) => c.textContent).find((t) => /Game plan/.test(t)) || ""`);
  const chips = await evalJS(`[...document.querySelectorAll(".card .choices button")].map((b) => b.textContent)`);
  check("the racing request got a plan card (title, goal, controls), Go / Simpler chips, no game yet, the AI code switch on", /Lap Dash/.test(planCard) && /Goal:/.test(planCard) && /Controls:/.test(planCard) && chips.length === 2 && /Go, build it/.test(chips[0]) && (await evalJS(`!S.level && !!S.pendingPlan && document.getElementById("codeBtn").classList.contains("on") && window.__lastPlanBody.message === "a car racing game with 3 laps"`)), [planCard.slice(0, 90), chips]);
  check("the send line now says go builds it", /go = build it/.test(await evalJS(`document.getElementById("sendCost").textContent`)));
  await evalJS(`[...document.querySelectorAll(".card .choices button")][0].click(); true`); await waitFor(`!S.busy`, { timeout: 120_000 });   // the loop: a crash, a fix, a smoke test, a look
  const built = await evalJS(`JSON.stringify({ genre: S.level?.genre, engine: S.level?.engine, title: S.level?.title, html: (S.level?.html || "").length, sandbox: document.getElementById("preview").getAttribute("sandbox"), status: document.getElementById("previewStatus").textContent, version: S.versions[0]?.note, versions: S.versions.length, ready: !!S.codeRun?.ready, errors: S.codeRun?.errors?.length, blank: S.codeRun?.blank, pending: !!S.pendingPlan, dim3d: document.querySelector('#dimSeg button[data-dim="3d"]').disabled, codeOff: document.getElementById("codeBtn").disabled, lastAssistant: [...document.querySelectorAll(".msg.assistant .bubble")].slice(-1)[0]?.textContent || "", steps: [...document.querySelectorAll(".card.think .steps li")].map((l) => l.textContent).join(" | ") })`).then(JSON.parse);
  if (built.html === 0 || !built.ready || built.blank) console.log("  build trouble: reply =", built.lastAssistant.slice(0, 300), "\n  steps =", built.steps, "\n  blank info =", await evalJS(`JSON.stringify(S.codeRun && S.codeRun.blankInfo)`), "\n  frame at smoke time =", await evalJS(`JSON.stringify(S.codeRun && S.codeRun.frameInfo)`), "\n  frame =", await evalJS(`JSON.stringify((() => { const f = document.getElementById("preview"), r = f.getBoundingClientRect(); return { w: r.width, h: r.height, display: getComputedStyle(f).display, vis: getComputedStyle(f).visibility, body: document.body.className }; })())`), "\n  exceptions =", exceptions.slice(-3));
  check("Go: the build streamed in, the game is saved as a code level and version v1 through the API, the iframe is sandboxed and the game said ready", built.genre === "code" && built.engine === "canvas" && built.title === "Lap Dash" && built.html > 1000 && built.sandbox === "allow-scripts allow-pointer-lock" && /AI code · canvas · v1/.test(built.status) && built.version === "snake v1" && built.versions === 1 && built.ready && built.errors === 0 && !built.blank && !built.pending && built.dim3d && built.codeOff, built);
  check("the self-healing loop: the first file crashed in the smoke test, the fix request carried the error and the token, the fixed file passed, one attempt", /Smoke test failed: it crashed: .*notAFunction/.test(built.steps) && /Fix 1 of 3 for "it crashed/.test(built.steps) && /Smoke test: first frames, reacts to input, restart ok/.test(built.steps) && (await evalJS(`window.__fixBodies.length === 1 && window.__fixBodies[0].token === "mock-token" && /notAFunction/.test(window.__fixBodies[0].report.errors[0].message) && window.__fixBodies[0].html.length > 100 && S.lastBuild.attempts === 1 && S.lastBuild.fixes.length === 1 && S.lastBuild.ok === true`)), built.steps);
  check("the vision check: a screenshot went to Muse Spark (mocked) and the verdict is in the panel", /Looks like the game asked for \(90%\): a green snake/.test(built.steps) && (await evalJS(`/^data:image\\/jpeg/.test(window.__lookBody.snapshot) && window.__lookBody.token === "mock-token" && window.__lookBody.plan.title === "Lap Dash"`)), built.steps);
  check("the reply says what was built, that it failed once and was fixed, and what the look saw", /Steer the snake/.test(built.lastAssistant) && /failed once at first \(it crashed: .*\) and I fixed it/.test(built.lastAssistant) && /A look at the screen: a green snake/.test(built.lastAssistant) && /Wrote .* KB of canvas/.test(built.steps) && /Scanned for forbidden APIs: clean/.test(built.steps), built.lastAssistant);
  check("the page cannot read into the sandboxed game", await evalJS(`(() => { try { return document.getElementById("preview").contentDocument === null; } catch { return true; } })()`));
  const savedCode = await api(`api/projects?id=${await evalJS(`S.project.id`)}`);
  check("the saved project carries the code level (html, plan, notes, engine) and nothing else was lost", savedCode.project?.level?.genre === "code" && savedCode.project.level.html.length > 1000 && savedCode.project.level.plan?.title === "Lap Dash" && savedCode.project.level.notes?.built.length > 5 && savedCode.versions?.length === 1, Object.keys(savedCode.project?.level || {}));
  await type("make the apples blue");
  check("the send line prices a change as a code rewrite", /rewrites its code/.test(await evalJS(`document.getElementById("sendCost").textContent`)));
  await sendMsg(); await idle();
  check("a change rewrites the code with the current file (code_edit flow) as version v2, still sandboxed", await evalJS(`S.level?.genre === "code" && S.versions.length === 2 && S.versions[0].note === "blue apples" && window.__lastBuildBody.change === "make the apples blue" && typeof window.__lastBuildBody.previous_html === "string" && window.__lastBuildBody.previous_html.length > 1000 && document.getElementById("preview").getAttribute("sandbox") === "allow-scripts allow-pointer-lock"`), await evalJS(`JSON.stringify({ versions: S.versions.map((v) => v.note), calls: window.__buildCalls })`));
  await click("#newGameBtn");
  check("a new game puts the preview back on game.html without the sandbox, the switch off", await evalJS(`!document.getElementById("preview").getAttribute("sandbox") && /game\\.html/.test(document.getElementById("preview").getAttribute("src") || "") && !document.getElementById("codeBtn").classList.contains("on") && !S.pendingPlan && !S.code`));
  check("the engines' preview says ready again after the sandbox", !!(await waitFor(`S.previewReady`, { timeout: 15_000 })));

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
