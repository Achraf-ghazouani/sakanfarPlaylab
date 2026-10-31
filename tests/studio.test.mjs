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
const OWNER = "test-studio-" + Math.random().toString(36).slice(2, 10);
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
const api = async (p, init = {}) => { const r = await fetch(`${BASE}/${p}`, { ...init, headers: { "Content-Type": "application/json", "x-owner": OWNER, ...(init.headers || {}) } }); return r.json(); };

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`); if (!cond) fails++; }

// Mocks for the AI endpoints + a fixed owner, injected before every document (top frame and the preview iframe).
const LEVEL_A = { theme: "lava castle", aspect: 1.333, objects: [
  { type: "platform", label: "ground", x: 0, y: 900, w: 1000, h: 60 }, { type: "start", x: 40, y: 840, w: 40, h: 60 }, { type: "goal", x: 900, y: 840, w: 40, h: 60 },
  { type: "platform", label: "ledge", x: 300, y: 760, w: 200, h: 30 }, { type: "coin", x: 380, y: 700, w: 30, h: 30 }, { type: "enemy", x: 600, y: 850, w: 40, h: 50 } ] };
const LEVEL_B = { ...LEVEL_A, theme: "lava castle", objects: [...LEVEL_A.objects, { type: "coin", x: 700, y: 820, w: 30, h: 30 }] };
const inject = `
  try { localStorage.setItem("playlab.owner", ${JSON.stringify(OWNER)}); } catch {}
  window.__scanCalls = 0; window.__fixCalls = 0; window.__sawTyping = false;
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.id === "typing") window.__sawTyping = true; }).observe(document.documentElement, { childList: true, subtree: true });
  });
  const LA = ${JSON.stringify(LEVEL_A)}, LB = ${JSON.stringify(LEVEL_B)};
  const realFetch = window.fetch.bind(window);
  const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } }));
  window.fetch = (url, init) => {
    const u = String(url);
    if (/api\\/scan$/.test(u)) { window.__scanCalls++; const lvl = window.__scanCalls === 1 ? LA : LB; return json({ level: { ...lvl, checked: true, fixes: [] }, original: lvl, meta: { provider: "mock", playtest: { before: { ok: true, problems: [] } } } }); }
    if (/api\\/fix$/.test(u)) { window.__fixCalls++; const lvl = JSON.parse(init.body).level; return json({ level: { ...lvl, checked: true, fixes: [] }, report: { before: { ok: true, problems: [] }, after: { ok: true, problems: [] }, fixes: [], fixedBy: null } }); }
    return realFetch(url, init);
  };
`;

try {
  await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
  const { frameTree } = await send("Page.getFrameTree"); mainFrameId = frameTree.frame.id;
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
  let saved = await api(`api/projects?id=${pid}`);
  check("messages saved to the database", saved.messages?.length === 2 && saved.messages[0].role === "user" && saved.messages[1].role === "assistant", saved.messages?.map((m) => m.role));

  // 2. attach a picture: scan (mocked), level to preview, version 1
  await attachPhoto();
  check("attachment chip shows", !!(await waitFor(`document.querySelectorAll(".attach").length === 1`)));
  await sendMsg(); await idle();
  check("scan endpoint called once", await evalJS(`window.__scanCalls`) === 1);
  check("level loaded in the page", await evalJS(`S.level && S.level.objects.length`) === 6);
  check("version 1 created", await evalJS(`S.versions.length === 1 && S.versions[0].n === 1`), await evalJS(`S.versions.map((v) => v.n)`));
  check("preview status text", /6 objects/.test(await evalJS(`document.getElementById("previewStatus").textContent`)));
  check("change card rendered", /Level from your picture/.test(await evalJS(`document.body.innerText`)));
  const player = await waitFor(`(() => { try { const s = game.scene.getScene("play"); return s && s.player ? { x: Math.round(s.player.x), state: s.state } : null; } catch { return null; } })()`, { contextId: iframeCtx(), timeout: 15_000 });
  check("preview iframe is running the level", !!player && player.state === "play", player);
  saved = await api(`api/projects?id=${pid}`);
  check("level + photo saved on the project", saved.project?.level?.objects?.length === 6 && String(saved.project.photo || "").startsWith("data:image/jpeg"));
  check("sidebar thumbnail uses the photo", !!(await waitFor(`document.querySelector(".proj img") !== null`)));

  // 3. playtest chip -> /api/fix (mocked) -> card
  await evalJS(`[...document.querySelectorAll(".chip")].find((c) => c.textContent === "Playtest it").click(); true`); await idle();
  check("playtest chip hits /api/fix", await evalJS(`window.__fixCalls`) === 1);
  check("playtest card says reachable", /every platform, coin and goal is reachable/.test(await evalJS(`document.body.innerText`)));

  // 4. second picture -> version 2, history shows both, undo restores v1 as v3
  await attachPhoto();
  check("second attachment accepted", await evalJS(`S.attachments.length`) === 1);
  await sendMsg(); await idle();
  check("second scan gives 7 objects and version 2", await evalJS(`S.level.objects.length === 7 && S.versions[0].n === 2`), await evalJS(`({ n: S.level.objects.length, scans: window.__scanCalls, v: S.versions.map((v) => v.n) })`));
  await click("#historyBtn");
  check("history popover lists 2 versions", await evalJS(`document.getElementById("historyPop").classList.contains("show") && document.querySelectorAll("#historyPop .v").length`) === 2);
  await click("#historyBtn");
  check("undo enabled with 2 versions", await evalJS(`!document.getElementById("undoBtn").disabled`));
  await click("#undoBtn");
  await waitFor(`S.versions[0] && S.versions[0].n === 3`, { timeout: 15_000 }); await idle();
  check("undo restored v1 as a new version 3", await evalJS(`S.versions[0].n === 3 && S.level.objects.length === 6 && /restored v1/.test(S.versions[0].note)`), await evalJS(`S.versions.map((v) => v.n + ":" + v.note)`));
  check("restored card in the chat", /Restored v1/.test(await evalJS(`document.body.innerText`)));
  const v = await api(`api/version?project_id=${pid}&n=2`);
  check("GET /api/version returns a stored version", v.version?.n === 2 && v.version.level.objects.length === 7);

  // 5. rename
  await evalJS(`(() => { const t = document.getElementById("title"); t.value = "Lava Castle"; t.dispatchEvent(new Event("change")); return true; })()`);
  await waitFor(`document.querySelector(".proj .t b") && document.querySelector(".proj .t b").textContent === "Lava Castle"`);
  saved = await api(`api/projects?id=${pid}`);
  check("rename saved", saved.project?.title === "Lava Castle", saved.project?.title);

  // 6. reload -> last project reopens with its history and level
  await send("Page.navigate", { url: `${BASE}/studio.html` });
  await waitFor(`typeof S === "object" && S.project && S.project.id === ${JSON.stringify(pid)}`, { timeout: 15_000 });
  await waitFor(`S.previewReady`, { timeout: 20_000 });
  check("reload reopens the last project", await evalJS(`S.project.id`) === pid);
  check("messages restored", (await evalJS(`document.querySelectorAll(".msg, .card").length`)) >= 8, await evalJS(`document.querySelectorAll(".msg, .card").length`));
  check("versions restored", await evalJS(`S.versions.length`) === 3);
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
  await send("Emulation.clearDeviceMetricsOverride");

  // 9. another owner cannot see the project through the API
  const foreign = await fetch(`${BASE}/api/projects?id=${pid}`, { headers: { "x-owner": "test-other-owner-1" } });
  check("other owner gets 404 for the project", foreign.status === 404, foreign.status);

  const own = exceptions.filter((e) => !/Phaser|peerjs|supabase/i.test(e));
  check("no page exceptions", own.length === 0, own.slice(0, 3));
} catch (err) {
  console.log("ERROR", err.stack || err.message); fails++;
} finally {
  try { const { projects } = await api("api/projects"); for (const p of projects || []) await api(`api/projects?id=${p.id}`, { method: "DELETE" }); console.log(`cleaned ${projects?.length || 0} test project(s)`); } catch (e) { console.log("cleanup failed:", e.message); }
  try { ws.close(); } catch {}
  chrome.kill();
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
