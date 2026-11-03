// Headless Chrome runs shared/assetcheck.js (the local picture checks, no AI) on every sample in tests/samples/:
// the sure guesses must be right, the unsure ones must say so (those go to Muse Spark). Needs the dev server:
//   node tests/assets.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9343, BASE = process.argv[2] || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`); if (!cond) fails++; }

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "playlab-assets-test")}`, "--window-size=1000,700", "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 60 && !ws; i++) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = list.find((t) => t.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(250); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function evalJS(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("JS error: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
}

// sample -> what the local checks must say. sure: the guess is trusted (no credit spent); unsure: Muse Spark decides.
const EXPECT = {
  "level_drawing.png": { role: "level", sure: true, facts: { paper: true, transparent: false } },
  "background.png": { role: "background", sure: false, facts: { transparent: false } },   // a photo of a drawing can look like a scene: the model confirms
  "spritesheet.png": { role: "spritesheet", sure: true, facts: { transparent: true, grid: [4, 3] } },
  "tileset.png": { role: "tileset", sure: true, facts: { transparent: true, grid: [8, 4] } },
  "font.png": { role: "ui_font", sure: true, facts: { transparent: true, grid: [10, 4] } },
  "button.png": { role: "ui_button", sure: true, facts: { frame: true } },
  "panel.png": { role: "ui_panel", sure: true, facts: { frame: true } },
  "character.png": { sure: false, facts: { transparent: true } },
  "enemy.png": { sure: false, facts: { transparent: true } },
  "coin.png": { role: "ui_icon", sure: false, facts: { transparent: true } },
  "icon_heart.png": { role: "ui_icon", sure: false, facts: { transparent: true } },
  "logo.png": { sure: false, facts: { transparent: true } },
  "texture.png": { sure: false, facts: { transparent: false } },
};

try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/explore.html` });
  await sleep(800);
  await evalJS(`new Promise((ok, no) => { const s = document.createElement("script"); s.src = "shared/assetcheck.js?v=" + Date.now(); s.onload = ok; s.onerror = no; document.head.appendChild(s); })`);
  check("shared/assetcheck.js loads", await evalJS(`typeof AssetCheck.inspect === "function" && typeof AssetCheck.describe === "function"`));
  let sureCount = 0;
  for (const [file, exp] of Object.entries(EXPECT)) {
    const f = await evalJS(`(async () => { const b = await (await fetch("tests/samples/${file}", { cache: "no-store" })).blob(); const src = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); const t0 = performance.now(); const f = await AssetCheck.inspect(src); f.ms = Math.round(performance.now() - t0); f.words = AssetCheck.describe(f); return f; })()`);
    const facts = exp.facts || {};
    const factsOk = Object.entries(facts).every(([k, v]) => k === "grid" ? f.grid && f.grid.cols === v[0] && f.grid.rows === v[1] : f[k] === v);
    const roleOk = exp.role ? f.guess.role === exp.role : true;
    check(`${file}: ${exp.sure ? "sure it is " + exp.role : "not sure" + (exp.role ? " (leans " + exp.role + ")" : "")}`, roleOk && f.sure === exp.sure && factsOk && typeof f.words === "string" && f.words.length > 10, { guess: f.guess, sure: f.sure, transparent: f.transparent, grid: f.grid, frame: f.frame, paper: f.paper, colors: f.colors, ms: f.ms });
    if (f.sure) sureCount++;
  }
  check("six of thirteen samples need no Muse Spark call", sureCount === 6, sureCount);
} catch (err) { console.log("ERROR", err.message); fails++; }
finally { try { ws.close(); } catch {} chrome.kill(); }
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
