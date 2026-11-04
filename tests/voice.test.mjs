// tests/voice.test.mjs — "Say a game.": the Studio mic records, Muse Voice Transcribe (Meta, live) writes it into the chat box.
// Chrome plays tests/samples/say.wav as a fake microphone ("Make a space game where a cat collects stars and dodges
// asteroids."), so the whole path runs for real: Web Audio capture, the 16 kHz WAV built in the page, api/agent.js task voice,
// the Meta transcribe endpoint, the words in the box. Nothing is sent and no credit is spent.
// Needs the dev server on 3000 and .env (MODEL_API_KEY, Supabase keys). npm run test:voice
import { spawn } from "node:child_process";
import os from "node:os"; import path from "node:path";
try { process.loadEnvFile(".env"); } catch {}
const BASE = "http://localhost:3000", PORT = 9400 + Math.floor(Math.random() * 30), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, SKEY = process.env.PLAYLAB_SERVER_KEY;
const srv = async (fn, a) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" }, body: JSON.stringify({ p_key: SKEY, ...a }) }); return { status: r.status, data: await r.json().catch(() => null) }; };
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : ""}`); if (!ok) fails++; };

const wavPath = path.resolve("tests/samples/say.wav");
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wavPath}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "playlab-voice-" + Date.now())}`, "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
let ws; for (let i = 0; i < 60 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = l.find((t) => t.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(250); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
const waitFor = async (e, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const v = await ev(e); if (v) return v; } catch {} await sleep(200); } return null; };
const clickMic = async () => { const [x, y] = JSON.parse(await ev(`(() => { const r = document.getElementById("micBtn").getBoundingClientRect(); return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); })()`)); for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); };

let uid = null;
try {
  // the endpoint: login required, WAV only
  const anon = await fetch(`${BASE}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "voice", audio: "x" }) });
  check("the voice task needs a login", anon.status === 401, anon.status);
  const u = "voice_" + Math.random().toString(36).slice(2, 9), pw = "Test-" + Math.random().toString(36).slice(2) + "-x";
  uid = (await srv("srv_create_user", { p_email: null, p_password: pw, p_username: u, p_display_name: "Voice Tester", p_credits: 50, p_role: "user", p_is_demo: true, p_tag: "Tester", p_expires_at: null, p_daily_limit: null })).data;
  check("a throwaway account", !!uid);
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/login.html?next=studio.html` }); await waitFor(`!!document.getElementById("passwordBtn")`);
  await ev(`document.querySelector('[data-tab="password"]').click(); document.getElementById("user").value = ${JSON.stringify(u)}; document.getElementById("password").value = ${JSON.stringify(pw)}; document.getElementById("passwordBtn").click(); true`);
  check("the Studio opens", !!(await waitFor(`/studio\\.html$/.test(location.pathname) && typeof S === "object" && !!S.me && !!document.getElementById("micBtn")`, 30000)));
  const bad = await ev(`api("/api/agent", { method: "POST", body: { task: "voice", audio: btoa("not a wav file at all, just words".repeat(100)) } }).then(() => "ok", (e) => e.status)`);
  check("anything that is not a WAV is refused", bad === 400, bad);
  const credits = await ev(`S.me.credits ?? S.me.profile?.credits ?? null`);

  // the mic, for real: tap, speak (the fake microphone plays the sample), tap again
  await clickMic();
  if (!(await waitFor(`document.getElementById("micBtn").classList.contains("rec")`, 3000))) { await sleep(1000); await clickMic(); }   // a tap before the page settled: once more
  check("one tap records: the mic turns red and the box says it is listening", !!(await waitFor(`document.getElementById("micBtn").classList.contains("rec") && /Listening/.test(document.getElementById("composer").placeholder)`, 5000)));
  await sleep(5600);
  await clickMic();
  check("the second tap stops and writes it down", !!(await waitFor(`!document.getElementById("micBtn").classList.contains("rec")`, 3000)));
  const said = await waitFor(`!Mic.busy && document.getElementById("composer").value`, 30000);
  check("Muse Voice Transcribe put the spoken sentence in the chat box", /space game/i.test(said || "") && /cat/i.test(said || "") && /stars/i.test(said || ""), said);
  check("it starts with a capital letter", /^[A-Z]/.test(said || ""), said);
  check("nothing was sent on its own and no credit was spent", (await ev(`document.querySelectorAll("#messages .msg.user").length`)) === 0 && (await ev(`S.me.credits ?? S.me.profile?.credits ?? null`)) === credits);
  check("the box placeholder is back", !(await ev(`/Listening|Writing/.test(document.getElementById("composer").placeholder)`)));
  // a tap that is too short says so instead of calling the model
  await clickMic(); await sleep(150); await clickMic();
  check("a tap that is too short asks for a longer one", !!(await waitFor(`/longer/.test(document.getElementById("toast").textContent)`, 3000)));
} catch (err) { console.log("ERROR", err.message); fails++; }
finally {
  try { ws.close(); } catch {} chrome.kill();
  if (uid) await srv("srv_delete_user", { p_user: uid });
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
