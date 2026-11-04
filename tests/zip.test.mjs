// tests/zip.test.mjs — "Download the project (.zip)": the Studio packs a game written as code with the person's picture,
// Windows' own unzip (Expand-Archive) opens the file, and the extracted index.html plays on its own from disk (file://):
// the SDK next to it, the picture inside it. Also clicks the real button with downloads allowed.
// Needs the dev server on 3000 and .env (Supabase keys). npm run test:zip
import { spawn, execFileSync } from "node:child_process";
import os from "node:os"; import path from "node:path"; import fs from "node:fs";
try { process.loadEnvFile(".env"); } catch {}
const BASE = "http://localhost:3000", PORT = 9430 + Math.floor(Math.random() * 30), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, SKEY = process.env.PLAYLAB_SERVER_KEY;
const srv = async (fn, a) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" }, body: JSON.stringify({ p_key: SKEY, ...a }) }); return { status: r.status, data: await r.json().catch(() => null) }; };
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : ""}`); if (!ok) fails++; };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
// a small game that says in its HUD whether the player picture reached PlayLab.assets
const GAME = `<!doctype html>
<!-- playlab {"note":"zip check","built":"Shows whether the player picture arrived.","missing":""} -->
<html><head><meta charset="utf-8"><title>Zip check</title><style>html,body{margin:0;background:#123;overflow:hidden}</style></head>
<body><canvas id="c" width="320" height="200"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d"), a = PlayLab.assets.get("player");
PlayLab.controller({ type: "tap" });
const said = a && a.kind === "image" && a.src.startsWith("data:image/png") ? "player picture: yes" : "player picture: no";
PlayLab.hud.set({ text: said }); window.__said = said;
PlayLab.onRestart(() => PlayLab.start());
function loop() { requestAnimationFrame(loop); ctx.fillStyle = "#123"; ctx.fillRect(0, 0, 320, 200); ctx.fillStyle = "#fa0"; ctx.fillRect(40 + (Date.now() / 10) % 200, 80, 40, 40); }
loop();
</script></body></html>`;
const level = (html, title) => ({ genre: "code", engine: "canvas", title, theme: "test", note: "v1", prompt: "a zip test game", plan: { title, genre: "test", engine: "canvas", goal: "see the picture", controls: "tap anywhere", controller: "tap", win: "-", lose: "-", entities: [], opponents: "none", levels: "-", players: 1, notes: "" }, html, notes: { note: "v1", built: "x", missing: "" }, objects: [] });

const work = fs.mkdtempSync(path.join(os.tmpdir(), "playlab-zip-"));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio", "--allow-file-access-from-files",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "playlab-zipc-" + Date.now())}`, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
let ws; for (let i = 0; i < 60 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(250); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
const waitFor = async (e, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = await ev(e); if (v) return v; } catch {} await sleep(200); } return null; };

let uid = null;
try {
  const u = "zip_" + Math.random().toString(36).slice(2, 9), pw = "Test-" + Math.random().toString(36).slice(2) + "-x";
  uid = (await srv("srv_create_user", { p_email: null, p_password: pw, p_username: u, p_display_name: "Zip Tester", p_credits: 50, p_role: "user", p_is_demo: true, p_tag: "Tester", p_expires_at: null, p_daily_limit: null })).data;
  const tok = (await (await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: `${u}@demo.playlab.invalid`, password: pw }) })).json()).access_token;
  const papi = async (method, body) => (await fetch(`${BASE}/api/projects`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(body) })).json();
  const pid = (await papi("POST", { title: "Zip Check Game", mode: "2d", level: level(GAME, "Zip Check Game") })).project?.id;
  await papi("PATCH", { id: pid, art: { player: PNG } });
  check("a throwaway account with a code game and a player picture", !!uid && !!pid);

  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/login.html?next=${encodeURIComponent("studio.html?project=" + pid)}` }); await waitFor(`!!document.getElementById("passwordBtn")`);
  await ev(`document.querySelector('[data-tab="password"]').click(); document.getElementById("user").value = ${JSON.stringify(u)}; document.getElementById("password").value = ${JSON.stringify(pw)}; document.getElementById("passwordBtn").click(); true`);
  if (!(await waitFor(`typeof S === "object" && S.project && S.project.id === ${JSON.stringify(pid)}`, 20000))) await send("Page.navigate", { url: `${BASE}/studio.html?project=${pid}` });
  check("the Studio opens the game", !!(await waitFor(`typeof S === "object" && S.project && S.project.id === ${JSON.stringify(pid)} && S.codeRun && S.codeRun.ready`, 30000)));
  check("the Download button is in the top bar, and in the account menu", await ev(`getComputedStyle(document.getElementById("zipBtn")).display !== "none" && !!document.getElementById("zipLink")`));

  // the ZIP, as the page makes it
  const z = JSON.parse(await ev(`buildZip().then(async (z) => { const b = new Uint8Array(await z.blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return JSON.stringify({ name: z.name, files: z.files, b64: btoa(s) }); })`));
  check("the ZIP is named after the game and lists the files", z.name === "zip-check-game.zip" && ["index.html", "playlab-sdk.js", "game.html", "project.json", "README.txt", "assets/player.png", "versions/v1.html"].every((f) => z.files.includes("zip-check-game/" + f)), z.files);
  const zipFile = path.join(work, z.name); fs.writeFileSync(zipFile, Buffer.from(z.b64, "base64"));
  const out = path.join(work, "out");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${out}' -Force`]);
  const root = path.join(out, "zip-check-game");
  check("Windows' own unzip opens it", fs.existsSync(path.join(root, "index.html")) && fs.existsSync(path.join(root, "playlab-sdk.js")));
  const meta = JSON.parse(fs.readFileSync(path.join(root, "project.json"), "utf8"));
  check("project.json has the title, the prompt, the plan, the picture and the version", meta.title === "Zip Check Game" && meta.prompt === "a zip test game" && meta.plan?.controls === "tap anywhere" && meta.assets[0]?.file === "assets/player.png" && meta.versions[0]?.n === 1, meta);
  const png = fs.readFileSync(path.join(root, "assets/player.png"));
  check("the picture is a real PNG file", png.subarray(1, 4).toString() === "PNG" && png.length > 60, png.length);
  check("game.html is the code exactly as written, index.html adds the SDK and the picture", fs.readFileSync(path.join(root, "game.html"), "utf8") === GAME && /<script src="playlab-sdk\.js"><\/script>/.test(fs.readFileSync(path.join(root, "index.html"), "utf8")));
  check("the README says how to play it", /Open index\.html/.test(fs.readFileSync(path.join(root, "README.txt"), "utf8")) && /Controls: tap anywhere/.test(fs.readFileSync(path.join(root, "README.txt"), "utf8")));

  // the real button: a download lands on disk
  const dl = path.join(work, "dl"); fs.mkdirSync(dl);
  await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dl });
  await ev(`document.getElementById("zipBtn").click(); true`);
  let got = null; for (let i = 0; i < 50 && !got; i++) { await sleep(200); got = fs.readdirSync(dl).find((f) => f === "zip-check-game.zip"); }
  check("the Download button saves zip-check-game.zip", !!got && fs.statSync(path.join(dl, got)).size > 1000);

  // the extracted game plays on its own from disk
  await send("Page.navigate", { url: "file:///" + path.join(root, "index.html").replace(/\\/g, "/") });
  check("the extracted index.html plays from disk with the picture", (await waitFor(`window.PlayLab && window.__said`, 10000)) === "player picture: yes");
} catch (err) { console.log("ERROR", err.message); fails++; }
finally {
  try { ws.close(); } catch {} chrome.kill();
  if (uid) await srv("srv_delete_user", { p_user: uid });
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
