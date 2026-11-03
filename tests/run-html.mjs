// Runs one HTML game file (a generated game) through the sandbox harness in headless Chrome and reports what the SDK saw:
// ready, the controller layout, the state, errors, a blank canvas, and whether the screen changes after a phone input.
// Needs the dev server.   node tests/run-html.mjs <file.html> [baseUrl] [--seconds 8] [--model file.glb|fbx] (the model as PlayLab.assets player)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => /\.html?$/i.test(a));
if (!file) { console.log("usage: node tests/run-html.mjs <file.html> [baseUrl] [--seconds 8]"); process.exit(2); }
const BASE = args.find((a) => /^https?:\/\//.test(a)) || "http://localhost:3000";
const SECONDS = Number(args[args.indexOf("--seconds") + 1]) || 8;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9346;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = fs.readFileSync(file, "utf8");
const modelFile = args.includes("--model") ? args[args.indexOf("--model") + 1] : null;
const assets = modelFile ? { player: { src: "data:application/octet-stream;base64," + fs.readFileSync(modelFile).toString("base64"), kind: "model", name: path.basename(modelFile) } } : null;

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "playlab-run-html")}`, "--window-size=900,600", "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 60 && !ws; i++) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = list.find((t) => t.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(250); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function evalJS(expression) { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result?.result?.value; }
async function waitFor(expression, timeout) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { let v = null; try { v = await evalJS(expression); } catch {} if (v) return v; await sleep(120); } return null; }

const out = { file, ok: false, ready: false, readyMs: null, layout: null, state: null, errors: [], blank: null, responds: null };
try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/tests/harness.html` });
  if (!(await waitFor(`typeof CodeRun === "object" && typeof __runHtml === "function"`, 10_000))) throw new Error("the harness did not load (is the dev server up?)");
  out.scan = await evalJS(`JSON.stringify(__runHtml(${JSON.stringify(html)}${assets ? ", " + JSON.stringify(assets) : ""}))`).then(JSON.parse);
  const t0 = Date.now();
  const ready = await waitFor(`!!__has("playlab:ready")`, 25_000);
  out.ready = !!ready; if (ready) out.readyMs = Date.now() - t0;
  await sleep(SECONDS * 1000);
  out.layout = await evalJS(`(__has("playlab:controller") || {}).layout || null`);
  out.state = await evalJS(`JSON.stringify((__msgs.filter((m) => m.type === "playlab:state").slice(-1)[0] || {}).state || null)`).then(JSON.parse);
  out.errors = await evalJS(`JSON.stringify(__msgs.filter((m) => m.type === "playlab:error").slice(0, 5).map((m) => ({ kind: m.kind, message: m.message, line: m.line })))`).then(JSON.parse);
  out.blank = await evalJS(`(__has("playlab:blank") || {}).why || null`);
  // does the screen change after a phone input? (two screenshots around a held d-pad / stick / button)
  await evalJS(`__msgs = __msgs.filter((m) => m.type !== "playlab:snapshot"); __send({ type: "playlab:snapshot" }); true`);
  const shot1 = await waitFor(`(__has("playlab:snapshot") || {}).image || null`, 4000);
  await evalJS(`__msgs = __msgs.filter((m) => m.type !== "playlab:snapshot"); __send({ type: "playlab:input", slot: 1, l: 0, r: 1, u: 0, d: 0 }); __send({ type: "playlab:stick", slot: 1, m: [1, 0], a: [0, 0] }); __send({ type: "playlab:jump", slot: 1, down: true }); true`);
  await sleep(900);
  await evalJS(`__send({ type: "playlab:snapshot" }); true`);
  const shot2 = await waitFor(`(__has("playlab:snapshot") || {}).image || null`, 4000);
  await evalJS(`__send({ type: "playlab:input", slot: 1, l: 0, r: 0, u: 0, d: 0 }); __send({ type: "playlab:stick", slot: 1, m: [0, 0], a: [0, 0] }); __send({ type: "playlab:jump", slot: 1, down: false }); true`);
  out.responds = shot1 && shot2 ? shot1 !== shot2 : null;
  out.ok = out.ready && out.errors.length === 0 && !out.blank && out.scan.ok;
} catch (err) { out.error = err.message; }
finally { try { ws.close(); } catch {} chrome.kill(); }
console.log("RESULT " + JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
