// Headless Chrome runs shared/assetcheck.js (the local picture checks, no AI) on every sample in tests/samples/:
// the sure guesses must be right, the unsure ones must say so (those go to Muse Spark). Needs the dev server:
//   node tests/assets.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

/** A small ZIP writer for the ZipRead check: entries [{ name, data, deflate }], stored or deflated, with the central directory. */
function zipOf(entries) {
  const parts = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = e.deflate ? zlib.deflateRawSync(e.data) : e.data, crc = zlib.crc32(e.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.deflate ? 8 : 0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(e.deflate ? 8 : 0, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(e.data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, name, data); central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

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

  // ZIP: pictures and models come out as files, stored or deflated; folders, junk and other types are skipped
  await evalJS(`new Promise((ok, no) => { const s = document.createElement("script"); s.src = "shared/zip.js?v=" + Date.now(); s.onload = ok; s.onerror = no; document.head.appendChild(s); })`);
  const button = fs.readFileSync("tests/samples/button.png"), bg = fs.readFileSync("tests/samples/background.png"), glb = Buffer.from("glTF fake model bytes ".repeat(50));
  const zip = zipOf([
    { name: "button.png", data: button, deflate: false }, { name: "pics/background.png", data: bg, deflate: true }, { name: "models/hero.glb", data: glb, deflate: true },
    { name: "__MACOSX/._button.png", data: Buffer.from("junk"), deflate: false }, { name: "notes.txt", data: Buffer.from("hello"), deflate: true }, { name: "sprites/", data: Buffer.alloc(0), deflate: false }, { name: "pics/.hidden.png", data: button, deflate: false },
  ]);
  const z = await evalJS(`(async () => { const bytes = Uint8Array.from(atob("${zip.toString("base64")}"), (c) => c.charCodeAt(0)); const files = await ZipRead.files(bytes.buffer); const out = []; for (const f of files) { const b = new Uint8Array(await f.arrayBuffer()); out.push({ name: f.name, type: f.type, size: f.size, png: b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 }); } return out; })()`);
  check("ZipRead: three files out, junk, folders, dotfiles and text skipped", z.length === 3 && z.map((f) => f.name).join() === "button.png,background.png,hero.glb", z.map((f) => f.name));
  check("ZipRead: stored and deflated pictures come back whole, with their types", z[0].size === button.length && z[0].png && z[0].type === "image/png" && z[1].size === bg.length && z[1].png && z[2].size === glb.length && z[2].type === "model/gltf-binary", z);
  let bad = null; try { await evalJS(`ZipRead.files(new Uint8Array([1, 2, 3, 4]).buffer)`); } catch (e) { bad = e.message; }
  check("ZipRead: not a ZIP is an error", /not a ZIP/.test(bad || ""), bad);
} catch (err) { console.log("ERROR", err.message); fails++; }
finally { try { ws.close(); } catch {} chrome.kill(); }
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
