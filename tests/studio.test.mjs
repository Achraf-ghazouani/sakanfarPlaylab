// Headless Chrome test of studio.html, where every game is written as code: the first prompt is planned (Muse Spark, mocked)
// and built (Muse Wonder, mocked and streamed) through the self-healing loop into the sandbox; changes are patches with versions,
// undo and history; sketches (2D only), photos, characters, objects, batches and 3D models feed AI code; an older classic game is
// offered a rebuild; the projects, messages and versions go through the real /api (Supabase).
// Start the dev server first (node serve.mjs), then:  node tests/studio.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { EXAMPLES } from "../shared/code-examples.mjs";
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
const PHOTO = path.resolve("tests/samples/drawing.jpg");

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


// Mocks for the AI endpoints, injected before every document. The plan (Muse Spark), the build, its fixes and changes (Muse Wonder)
// and the look are mocked; the first build answers with a game that throws, so the self-healing loop runs every time.
const SNAKE_BLUE = EXAMPLES.snake.replace('ctx.fillStyle = "#ef4444";', 'ctx.fillStyle = "#3b82f6";');
const LEVEL_CLASSIC = { theme: "lava castle", aspect: 1.333, objects: [{ type: "platform", label: "ground", x: 0, y: 900, w: 1000, h: 60 }, { type: "start", x: 40, y: 840, w: 40, h: 60 }, { type: "goal", x: 900, y: 840, w: 40, h: 60 }] };
const inject = `
  window.__sawTyping = false;
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.id === "typing") window.__sawTyping = true; }).observe(document.documentElement, { childList: true, subtree: true });
  });
  const PLAN = { title: "Lap Dash", genre: "racing", engine: "canvas", goal: "Finish 3 laps before the rivals.", controls: "Left and right steer, A is gas, B brakes.", controller: "steering+gas+brake", win: "First after 3 laps", lose: "Last after 3 laps", entities: ["car", "4 rival cars", "track"], opponents: "4 AI cars on the racing line", levels: "3 laps", players: 1, notes: "", picture: "" };
  const SNAKE = ${JSON.stringify(EXAMPLES.snake)}, BLUE = ${JSON.stringify(SNAKE_BLUE)}, BROKEN = ${JSON.stringify(BROKEN)};
  const sse = (b, html, extra) => ["start", "progress", "done"].map((e) => "data: " + JSON.stringify(e === "start" ? { e, action: b.change ? "code_edit" : b.task === "fix" ? "fix" : "code_create_2d", cost: 20, balance: 180, model: "mock", modelName: "mock" } : e === "progress" ? { e, chars: 1200, lines: 30 } : { e, html, notes: { note: b.change ? (/apples blue/.test(b.change) ? "blue apples" : "changed") : "snake v1", built: "Steer the snake with the d-pad; eat apples to grow.", missing: "" }, scan: { ok: true, problems: [] }, engine: "canvas", ms: 1, fix: "mock-token", ...extra }) + "\\n\\n").join("");
  const stream = (text) => Promise.resolve(new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } }));
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => {
    const u = String(url);
    if (/api\\/build-code$/.test(u)) {
      const b = JSON.parse(init.body); window.__lastBuildBody = b; const calls = (window.__buildCalls = window.__buildCalls || []); calls.push(b.change || "create");
      const credits = { credits: { spent: b.change ? 6 : 20, balance: 180, action: b.change ? "code_edit" : "code_create_2d", model: "mock" } }, patch = { patch: { mode: "patch", count: 1, added: 1, removed: 1 } };
      if (b.change && /break it/.test(b.change)) { window.__breakFixes = true; return stream(sse(b, BROKEN, { ...credits, ...patch })); }
      if (b.change) return stream(sse(b, /apples blue/.test(b.change) ? BLUE : (b.previous_html || SNAKE), { ...credits, ...patch }));
      return stream(sse(b, calls.filter((c) => c === "create").length === 1 ? BROKEN : SNAKE, credits));
    }
    if (/api\\/agent$/.test(u)) {
      const b = JSON.parse(init.body);
      if (b.task === "plan") { (window.__planBodies = window.__planBodies || []).push(b); window.__lastPlanBody = b; return json({ plan: { ...(b.plan || PLAN), engine: b.mode === "3d" ? "three" : (b.plan || PLAN).engine, picture: b.image ? "a hand-drawn oval track with a start line" : "" }, meta: { model: "mock", ms: 1 } }); }
      if (b.task === "fix") { (window.__fixBodies = window.__fixBodies || []).push(b); return stream(sse(b, window.__breakFixes ? BROKEN : SNAKE, { attempt: window.__fixBodies.length, patch: { mode: "patch", count: 1, added: 2, removed: 1 } })); }
      if (b.task === "look") { window.__lookBody = b; return json({ match: 0.9, looksLike: "a green snake on a dark grid with a score", problems: [], suggestion: "", model: "mock", ms: 1 }); }
    }
    if (/api\\/art$/.test(u)) {
      const b = JSON.parse(init.body); (window.__artCalls = window.__artCalls || []).push(b.task);
      if (b.task === "classify") return json({ ...(window.__classifyAs || { role: "level", kind: "level", objRole: null, name: "a level" }), confidence: 0.9, hint: "", credits: { spent: 1 } });
      if (b.task === "cutout") return new Response(JSON.stringify({ error: "mock: no SAM here" }), { status: 502, headers: { "Content-Type": "application/json" } });   // the page falls back to its free fill
      return json({ image: b.image, kind: b.kind, role: b.role, credits: { spent: 15 } });   // the "sprite" is the picture itself
    }
    return realFetch(url, init);
  };
`;
const steps = () => evalJS(`[...document.querySelectorAll(".card.think")].slice(-1)[0]?.textContent || ""`);
const lastReply = () => evalJS(`[...document.querySelectorAll(".msg.assistant .bubble")].slice(-1)[0]?.textContent || ""`);
const busyDone = () => waitFor(`!S.busy`, { timeout: 120_000 });

try {
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
  const { frameTree } = await send("Page.getFrameTree"); mainFrameId = frameTree.frame.id;

  // 0. landing page: the main button opens the Studio (which needs a login), demos are games written as code
  await send("Page.navigate", { url: `${BASE}/index.html` });
  await waitFor(`document.readyState === "complete" && typeof discover === "function"`);
  await evalJS(`localStorage.clear(); sessionStorage.clear(); true`);   // a visitor: no old session from an earlier run
  await send("Page.navigate", { url: `${BASE}/index.html` });
  await waitFor(`document.readyState === "complete" && typeof discover === "function"`);
  check("main button starts creating in the Studio", await evalJS(`(() => { const b = document.getElementById("startBtn"); return b.textContent === "START CREATING" && /studio\\.html$/.test(b.href); })()`));
  check("the landing links no classic engine: the demo and the cards open demo.html", await evalJS(`![...document.querySelectorAll("a")].some((a) => /game\\.html|arena\\.html|levels\\//.test(a.getAttribute("href") || "")) && document.querySelectorAll("#cards .card").length === 3 && [...document.querySelectorAll("#cards .card")].every((a) => /demo\\.html\\?g=/.test(a.href))`));
  check("visitors see the waitlist note", await evalJS(`!document.getElementById("betaNote").hidden`));
  await send("Page.navigate", { url: `${BASE}/demo.html?g=snake` });
  check("demo.html runs the snake example in the sandbox", !!(await waitFor(`window.__demoState && window.__demoState.state === "play" && document.getElementById("game").getAttribute("sandbox") === "allow-scripts allow-pointer-lock"`, { timeout: 15_000 })));
  await send("Page.navigate", { url: `${BASE}/studio.html` });
  check("the Studio sends visitors to the login page", !!(await waitFor(`/login\\.html$/.test(location.pathname) && /next=studio/.test(location.search)`, { timeout: 15_000 })), await evalJS(`location.href`));
  const loggedIn = await loginInPage(evalJS, (e, t) => waitFor(e, { timeout: t || 10_000 }), (url) => send("Page.navigate", { url }));
  check("username + password login lands in the Studio", loggedIn, await evalJS(`location.href`));
  check("first screen: fresh layout, chat box at the bottom center", await evalJS(`document.body.classList.contains("fresh") && (() => { const r = document.querySelector(".chat").getBoundingClientRect(); return Math.abs(r.left + r.width / 2 - innerWidth / 2) < 4 && innerHeight - r.bottom < 60; })()`));
  check("the loading screen is gone once the Studio is on screen", !!(await waitFor(`!document.getElementById("boot") || document.getElementById("boot").classList.contains("off")`)));
  check("the preview has no engine: an empty iframe with the empty-state words", await evalJS(`!document.getElementById("preview").getAttribute("src") && !document.getElementById("previewEmpty").hidden && document.getElementById("retired").hidden`));
  check("AI code is a label, lit; the old playtest chip is gone; chips cost a code change", await evalJS(`document.getElementById("codeBtn").tagName === "SPAN" && document.getElementById("codeBtn").classList.contains("on") && document.querySelectorAll("#chips .chip").length === 3 && [...document.querySelectorAll("#chips .chip")].every((c) => c.dataset.chipCost === "code_edit")`));
  check("top bar shows the name, credits and the demo badge", await evalJS(`document.getElementById("userName").textContent === "Studio Tester" && document.getElementById("creditNum").textContent === "200" && !!document.getElementById("demoBadge")`));
  check("my games list is empty for a fresh owner", await evalJS(`document.querySelectorAll(".proj").length`) === 0);

  // 0b. languages: the chrome switches to French and Arabic (right-to-left) and back
  await evalJS(`I18N.set("fr"); true`);
  check("French: the welcome, the chips, the empty preview and the chat box follow", await evalJS(`document.querySelector(".welcome h2").textContent === "Qu'est-ce qu'on construit aujourd'hui ?" && document.querySelector("#chips .chip").dataset.label === "Plus difficile" && /Votre jeu apparaît ici/.test(document.getElementById("previewEmpty").textContent) && document.documentElement.lang === "fr"`));
  await evalJS(`I18N.set("ar"); true`);
  check("Arabic: right-to-left", await evalJS(`document.documentElement.dir === "rtl" && document.body.classList.contains("rtl") && document.querySelector(".welcome h2").textContent === "ماذا نبني اليوم؟"`));
  await waitFor(`S.costs && S.costs.code_edit`);
  await evalJS(`I18N.set("en"); true`);
  check("English again, the chips re-labelled with their cost", await evalJS(`document.documentElement.dir === "ltr" && document.querySelector("#chips .chip").dataset.label === "Make it harder" && document.querySelector("#chips .chip .cost") !== null`));

  // 1. the first prompt: a free plan (2D), Go: the build streams in, crashes in the smoke test, is fixed with the token, looked at, saved as v1
  await type("a car racing game with 3 laps");
  check("the send line announces a free plan first", /free plan first/.test(await evalJS(`document.getElementById("sendCost").textContent`)));
  await sendMsg();
  check("user bubble appears and the chat moves to the left", !!(await waitFor(`document.querySelector(".msg.user .bubble")`)) && await evalJS(`!document.body.classList.contains("fresh")`));
  await busyDone();
  const pid = await evalJS(`S.project && S.project.id`);
  check("project auto-created, titled from the first message, listed", !!pid && (await evalJS(`document.getElementById("title").value`)) === "a car racing game with 3 laps" && !!(await waitFor(`document.querySelectorAll(".proj").length === 1`)));
  check("a plan card (title, goal, controls) with Go / Simpler chips; the plan got the words and 2D; no game yet", await evalJS(`/Game plan: Lap Dash/.test(document.body.innerText) && /Goal:/.test(document.body.innerText) && [...document.querySelectorAll(".card .choices button")].map((b) => b.textContent).join() === "Go, build it,Make it simpler" && window.__lastPlanBody.message === "a car racing game with 3 laps" && window.__lastPlanBody.mode === "2d" && !S.level && !!S.pendingPlan`));
  check("the send line says go builds it", /go = build it/.test(await evalJS(`document.getElementById("sendCost").textContent`)));
  await evalJS(`[...document.querySelectorAll(".card .choices button")][0].click(); true`); await busyDone();
  const built = await evalJS(`JSON.stringify({ genre: S.level?.genre, engine: S.level?.engine, html: (S.level?.html || "").length, sandbox: document.getElementById("preview").getAttribute("sandbox"), status: document.getElementById("previewStatus").textContent, versions: S.versions.map((v) => v.note), ready: !!S.codeRun?.ready, errors: S.codeRun?.errors?.length, empty: document.getElementById("previewEmpty").hidden, locked: document.querySelector('#dimSeg button[data-dim="3d"]').disabled, steps: [...document.querySelectorAll(".card.think .steps li")].map((l) => l.textContent).join(" | ") })`).then(JSON.parse);
  check("Go: a code level, version v1 through the API, the sandboxed iframe ready, the empty state gone, the switch locked", built.genre === "code" && built.engine === "canvas" && built.html > 1000 && built.sandbox === "allow-scripts allow-pointer-lock" && /AI code · canvas · v1/.test(built.status) && built.versions.join() === "snake v1" && built.ready && built.errors === 0 && built.empty && built.locked, built);
  check("the self-healing loop: a crash in the smoke test, fix 1 with the token and the error, the smoke test passes, the look", /Smoke test failed: it crashed: .*notAFunction/.test(built.steps) && /Fix 1 of 3/.test(built.steps) && /Smoke test: first frames, reacts to input, restart ok/.test(built.steps) && /Looks like the game asked for \(90%\)/.test(built.steps) && (await evalJS(`window.__fixBodies.length === 1 && window.__fixBodies[0].token === "mock-token" && /notAFunction/.test(window.__fixBodies[0].report.errors[0].message) && /^data:image\\/jpeg/.test(window.__lookBody.snapshot)`)), built.steps);
  check("the reply says what was built, that it failed once and was fixed, and what the look saw", /Steer the snake/.test(await lastReply()) && /failed once at first/.test(await lastReply()) && /A look at the screen: a green snake/.test(await lastReply()));
  let saved = await api(`api/projects?id=${pid}`);
  check("the saved project carries the code level (html, plan, notes) with one version", saved.project?.level?.genre === "code" && saved.project.level.plan?.title === "Lap Dash" && saved.project.level.notes?.built.length > 5 && saved.versions?.length === 1);
  check("the page cannot read into the sandboxed game", await evalJS(`(() => { try { return document.getElementById("preview").contentDocument === null; } catch { return true; } })()`));

  // 2. the bar over the game (restart, pause, sound) and a phone's menu message through the shared route
  check("the code bar shows over the game; the layout the game asked for reached the Studio", await evalJS(`!document.getElementById("codeBar").hidden && S.codeRun.layout === "dpad+jump"`));
  await evalJS(`document.querySelector('#codeBar [data-act="restart"]').click(); true`);
  check("Restart on the bar starts a fresh round", !!(await waitFor(`S.codeRun.lastState === "play"`, { timeout: 5000 })));
  await evalJS(`document.getElementById("codePause").click(); true`);
  check("Pause pauses the game in the sandbox, the button says Resume", !!(await waitFor(`S.codeRun.lastState === "paused" && /Resume/.test(document.getElementById("codePause").textContent)`, { timeout: 5000 })));
  await evalJS(`phoneToGame({ slot: 1 }, { t: "menu", action: "toggle-pause" }); true`);
  check("a phone's menu message resumes it", !!(await waitFor(`S.codeRun.lastState === "play"`, { timeout: 5000 })));

  // 3. a change is a patch (v2), undo restores v1 (as v3), history lists every version
  await type("make the apples blue");
  check("the send line prices a change as a code rewrite", /rewrites its code/.test(await evalJS(`document.getElementById("sendCost").textContent`)));
  await sendMsg(); await busyDone();
  check("the change was patched (v2): the panel, the card with +1 -1 lines, the blue apples, the current file sent", /Patched 1 place \(\+1 -1 lines\)/.test(await steps()) && (await evalJS(`S.versions.length === 2 && S.versions[0].note === "blue apples" && /#3b82f6/.test(S.level.html) && window.__lastBuildBody.change === "make the apples blue" && window.__lastBuildBody.previous_html.length > 1000 && [...document.querySelectorAll(".card")].some((c) => /\\+1 -1 lines since v1/.test(c.textContent))`)), await evalJS(`JSON.stringify(S.versions.map((v) => v.note))`));
  await click("#undoBtn"); await busyDone();
  check("Undo restores v1's code as v3 and the sandbox runs it", !!(await waitFor(`S.versions.length === 3 && /restored v1/.test(S.versions[0].note) && /#ef4444/.test(S.level.html) && S.codeRun && S.codeRun.html === S.level.html && S.codeRun.ready`, { timeout: 15_000 })));
  await evalJS(`document.getElementById("historyBtn").click(); true`);
  check("history lists the three versions", await evalJS(`document.getElementById("historyPop").classList.contains("show") && document.querySelectorAll("#historyPop .v").length === 3`));
  await evalJS(`document.body.click(); true`);
  const v1 = await api(`api/projects?id=${pid}&version=1`);
  check("GET /api/projects?version=n returns a stored version with its code", v1.version?.n === 1 && v1.version.level.genre === "code" && /#ef4444/.test(v1.version.level.html));

  // 4. rename
  await evalJS(`(() => { const t = document.getElementById("title"); t.value = "Lap Dash"; t.dispatchEvent(new Event("change")); return true; })()`);
  await waitFor(`document.querySelector(".proj .t b") && document.querySelector(".proj .t b").textContent === "Lap Dash"`);
  check("rename saved", (await api(`api/projects?id=${pid}`)).project?.title === "Lap Dash");

  // 5. the sketch pad (2D): a drawing on a code game is read by Muse Spark and the game is improved with it (a patch)
  const darkCount = `(() => { const d = Sketch.ctx.getImageData(0, 0, 1200, 900).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++; return n; })()`;
  await click("#sketchBtn");
  check("in 2D the sketch pad opens, titled for a 2D game, with a free plan instead of a scan price", await evalJS(`document.getElementById("sketchModal").classList.contains("show") && /Sketch a 2D game/.test(document.querySelector("#sketchModal header").textContent) && /free plan/.test(document.getElementById("sketchUse").textContent)`));
  const dark0 = await evalJS(darkCount);
  await evalJS(`(() => { const c = document.getElementById("sketchCanvas"); const r = c.getBoundingClientRect();
    const ev = (type, fx, fy) => c.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1, bubbles: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
    ev("pointerdown", 0.05, 0.9); for (let i = 1; i <= 20; i++) ev("pointermove", 0.05 + 0.9 * i / 20, 0.9); ev("pointerup", 0.95, 0.9);
    ev("pointerdown", 0.4, 0.7); ev("pointermove", 0.55, 0.7); ev("pointermove", 0.55, 0.76); ev("pointermove", 0.4, 0.76); ev("pointermove", 0.4, 0.7); ev("pointerup", 0.4, 0.7);
    return true; })()`);
  const dark1 = await evalJS(darkCount);
  check("strokes drawn on the canvas", dark1 > dark0 + 2000, { dark0, dark1 });
  await click("#sketchUndo");
  check("undo removes the last stroke", (await evalJS(darkCount)) < dark1);
  await evalJS(`window.__planBodies = []; true`);
  await click("#sketchUse"); await busyDone();
  check("the sketch went to Muse Spark with the game's plan (no scanner), then the game was patched with what it shows (v4)", await evalJS(`window.__planBodies.length === 1 && /^data:image\\/jpeg/.test(window.__planBodies[0].image || "") && window.__planBodies[0].plan.title === "Lap Dash" && /The picture shows: a hand-drawn oval track/.test(window.__lastBuildBody.change) && S.versions.length === 4`), await evalJS(`JSON.stringify({ plans: window.__planBodies.length, change: window.__lastBuildBody.change, versions: S.versions.length })`));

  // 6. the camera button on a computer: the phone link modal with a room code
  await click("#cameraBtn");
  check("camera modal opens on a computer", await evalJS(`document.getElementById("camModal").classList.contains("show")`));
  const code = await waitFor(`/^[A-Z2-9]{4}$/.test(document.getElementById("camCode").textContent) && document.getElementById("camCode").textContent`, { timeout: 20_000 });
  check("room code and QR rendered, the hint says drawings go to AI code", !!code && (await evalJS(`document.querySelector("#camQr svg") !== null && /AI code game/.test(document.getElementById("camHint").textContent)`)), code);
  await click("#camClose");

  // 7. "use this as my player": Muse Image draws it (mocked), it is saved, and Muse Wonder puts it in the game right away (v5)
  await evalJS(`(async () => {
    const c = document.createElement("canvas"); c.width = 300; c.height = 400; const g = c.getContext("2d");
    g.fillStyle = "#d9dde3"; g.fillRect(0, 0, 300, 400); g.fillStyle = "#6d28d9"; g.fillRect(110, 140, 80, 150); g.fillStyle = "#f5d0b5"; g.beginPath(); g.arc(150, 105, 42, 0, 7); g.fill();
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    await addAttachment(new File([blob], "hero.png", { type: "image/png" })); return true; })()`);
  await type("use this as my player");
  check("the picture's toggle switches to Player from the words", await evalJS(`document.querySelector(".attach .role")?.classList.contains("player")`));
  await evalJS(`window.__artCalls = []; true`);
  await sendMsg(); await busyDone();
  check("Muse Image drew the player (no look-at step), saved on the game", (await evalJS(`window.__artCalls.join()`)) === "sprite" && !!(await api(`api/projects?id=${pid}`)).project?.art?.player?.match(/^data:image\/(webp|png);base64,/));
  check("then Muse Wonder put it in the game: a change naming PlayLab.assets player (v5)", await evalJS(`/PlayLab\\.assets: player/.test(window.__lastBuildBody.change) && S.versions.length === 5`), await evalJS(`window.__lastBuildBody.change`));

  // 8. a picture with no words: Muse Spark looks at it (mocked: an enemy), Muse Image draws it, it goes into the game (v6)
  await evalJS(`(async () => {
    window.__artCalls = []; window.__classifyAs = { role: "enemy", kind: "object", objRole: "enemy", name: "red blob" };
    const c = document.createElement("canvas"); c.width = 300; c.height = 300; const g = c.getContext("2d");
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, 300, 300); g.fillStyle = "#dc2626"; g.beginPath(); g.ellipse(150, 170, 90, 70, 0, 0, 7); g.fill();
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    await addAttachment(new File([blob], "blob.png", { type: "image/png" })); return true; })()`);
  await sendMsg(); await busyDone();
  check("Auto: looked at, drawn, saved as the enemy sprite, put in the game (v6)", (await evalJS(`window.__artCalls.join()`)) === "classify,sprite" && !!(await api(`api/projects?id=${pid}`)).project?.art?.sprites?.enemy && (await evalJS(`/enemy/.test(window.__lastBuildBody.change) && S.versions.length === 6`)), await evalJS(`window.__artCalls`));
  await evalJS(`window.__classifyAs = null; true`);

  // 9. many files at once: the review grid, roles set by hand, Apply all -> assets on the game and one Detected card
  await evalJS(`(async () => { const files = []; for (const n of ["button.png", "background.png", "icon_heart.png"]) { const b = await (await fetch("tests/samples/" + n, { cache: "no-store" })).blob(); files.push(new File([b], n, { type: "image/png" })); } await addFiles(files); return true; })()`);
  check("three pictures open the review grid with three cards", await evalJS(`document.getElementById("reviewModal").classList.contains("show") && document.querySelectorAll("#reviewGrid .rcard").length === 3 && S.attachments.length === 0`));
  const pick = async (i, role) => evalJS(`(() => { const s = document.querySelector("#reviewGrid select[data-role][data-i='${i}']"); s.value = "${role}"; s.dispatchEvent(new Event("change")); return true; })()`);
  const hint = async (i, h) => evalJS(`(() => { const s = document.querySelector("#reviewGrid select[data-hint][data-i='${i}']"); if (!s) return false; s.value = "${h}"; s.dispatchEvent(new Event("change")); return true; })()`);
  await pick(1, "background"); await pick(2, "ui_icon"); await hint(0, "pause"); await hint(2, "heart");
  await evalJS(`window.__artCalls = []; true`);
  await click("#reviewApply"); await busyDone();
  const batchAssets = (await api(`api/projects?id=${pid}`)).project?.art?.assets || [];
  check("Apply all saved the three assets with their roles and hints, no AI call", batchAssets.map((a) => a.role + (a.hint ? ":" + a.hint : "")).sort().join() === "background,ui_button:pause,ui_icon:heart" && (await evalJS(`window.__artCalls.length`)) === 0, batchAssets.map((a) => [a.role, a.hint]));
  check("one Detected card sums the batch up", /Detected[^]*?1 pause UI button, 1 background, 1 heart UI icon\. Game is 2D\./.test(await evalJS(`document.getElementById("messages").innerText`)));

  // 10. a change that breaks the game and cannot be fixed: nothing is saved, the working version keeps running
  const before = await evalJS(`S.versions.length`);
  await type("break it please"); await sendMsg(); await busyDone();
  check("a change that still crashes after 3 fixes is not saved; the working code is mounted again; the reply says so; a chip to try again", await evalJS(`S.versions.length === ${before} && S.codeRun && S.codeRun.html === S.level.html && S.codeRun.errors.length === 0 && /I did not save it/.test([...document.querySelectorAll(".msg.assistant .bubble")].slice(-1)[0].textContent) && [...document.querySelectorAll(".card .choices button")].some((b) => b.textContent === "Try that change again")`));
  await evalJS(`window.__breakFixes = false; document.querySelectorAll(".card .choices").forEach((r) => r.remove()); true`);

  // 11. publish opens on a game written as code
  await evalJS(`document.getElementById("publishBtn").click(); true`);
  check("Publish opens its dialog", !!(await waitFor(`document.getElementById("publishModal").classList.contains("show")`, { timeout: 5000 })));
  await evalJS(`document.getElementById("pubClose").click(); true`);

  // 12. reload: the game reopens in the sandbox with its versions and messages
  await send("Page.reload");
  await waitFor(`typeof S === "object" && S.project && S.project.id === ${JSON.stringify(pid)}`, { timeout: 15_000 });
  check("reload reopens the code game in the sandbox with its versions", !!(await waitFor(`S.level && S.level.genre === "code" && S.codeRun && S.codeRun.ready && S.versions.length === ${before}`, { timeout: 20_000 })));
  check("messages restored", (await evalJS(`document.querySelectorAll(".msg, .card").length`)) >= 15);

  // 13. a new 3D game: the sketch pad says it is for 2D, the plan asks for 3D, a GLB becomes the player of the 3D game
  await click("#newGameBtn");
  check("a new game: the welcome, the empty preview, no sandbox", await evalJS(`document.body.classList.contains("fresh") && !document.getElementById("previewEmpty").hidden && !S.code && document.getElementById("codeBar").hidden`));
  await evalJS(`document.querySelector("#dimSeg [data-dim='3d']").click(); true`);
  await click("#sketchBtn");
  check("in 3D the sketch button is off and says to switch to 2D (no pad)", await evalJS(`S.mode === "3d" && document.getElementById("sketchBtn").classList.contains("off") && !document.getElementById("sketchModal").classList.contains("show") && /switch to 2D/.test(document.getElementById("toast").textContent)`));
  await evalJS(`(async () => { const b = await (await fetch("tests/samples/cube.glb", { cache: "no-store" })).blob(); await addAttachment(new File([b], "cube.glb", { type: "model/gltf-binary" })); return true; })()`);
  await sendMsg(); await busyDone();
  const p2 = await evalJS(`S.project && S.project.id`);
  check("a GLB on a new game is saved as the player model, the game is 3D, the reply asks for the game", (await api(`api/projects?id=${p2}`)).project?.art?.model?.name === "cube.glb" && (await evalJS(`S.mode === "3d" && !S.level`)) && /will be the player/.test(await lastReply()));
  await type("a game where I collect coins"); await sendMsg(); await busyDone();
  check("the plan asks for 3D (three.js)", await evalJS(`window.__lastPlanBody.mode === "3d" && S.pendingPlan && S.pendingPlan.plan.engine === "three"`));

  // 14. a GLB on a game written as code: Muse Wonder loads it with GLTFLoader (a change)
  await evalJS(`document.querySelector('.proj[data-id="${pid}"]').click(); true`);
  await waitFor(`S.project && S.project.id === ${JSON.stringify(pid)} && S.codeRun && S.codeRun.ready`, { timeout: 20_000 });
  await evalJS(`(async () => { const b = await (await fetch("tests/samples/cube.glb", { cache: "no-store" })).blob(); await addAttachment(new File([b], "cube.glb", { type: "model/gltf-binary" })); return true; })()`);
  await type("use it as the hero"); await sendMsg(); await busyDone();
  check("a GLB on a code game: saved, then a change that loads it with three's GLTFLoader", /GLTFLoader/.test(await evalJS(`window.__lastBuildBody.change`)) && (await api(`api/projects?id=${pid}`)).project?.art?.model?.name === "cube.glb", await evalJS(`window.__lastBuildBody.change`));

  // 15. an older game made with the classic engine (retired): no engine runs it; a rebuild with AI code is offered
  const ins = await fetch(`${SB}/rest/v1/projects`, { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + TOKEN, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ owner: USER_ID, title: "Old lava castle", mode: "2d", level: LEVEL_CLASSIC }) }).then((r) => r.json());
  const oldId = ins[0]?.id;
  await evalJS(`openProject(${JSON.stringify(oldId)}); true`);
  check("an older classic game opens on the retired card (no engine page, no sandbox)", !!(await waitFor(`S.project && S.project.id === ${JSON.stringify(oldId)} && !document.getElementById("retired").hidden && /retired/.test(document.getElementById("previewStatus").textContent) && !S.code`, { timeout: 15_000 })));
  await click("#rebuildBtn"); await busyDone();
  check("Rebuild with AI code plans a new game from its theme", await evalJS(`/lava castle/.test(window.__lastPlanBody.message) && /platformer/.test(window.__lastPlanBody.message) && !!S.pendingPlan`), await evalJS(`window.__lastPlanBody && window.__lastPlanBody.message`));

  // 16. mobile layout: chat/preview tabs, the camera button opens the device camera on a phone
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
  check("camera button on a phone opens the device camera", (await evalJS(`window.__capClicked`)) === 1 && !(await evalJS(`document.getElementById("camModal").classList.contains("show")`)));
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.clearDeviceMetricsOverride");

  // 17. another owner cannot see the project through the API
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
