// Headless Chrome checks pad.html with the layouts a generated game asks for (PlayLab.controller): the controls each layout
// shows, the labels of A and B, what pressing them sends (the phone link client is replaced by a recorder), the tap pad, the
// state line of a generated game, and that the engines' own layouts (2d, arena) are unchanged. Needs the dev server:
//   node tests/pad.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { toGame, releaseAll, codeLayout, CODE_LAYOUTS } from "../shared/padroute.mjs";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9350, BASE = process.argv[2] || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 260) : ""}`); if (!cond) fails++; }

// ---- the route (no browser) ----
check("route: input carries up and down, bits only", JSON.stringify(toGame(2, { t: "input", l: 1, r: 0, u: "yes", d: 0 })) === JSON.stringify([{ type: "playlab:input", slot: 2, l: 1, r: 0, u: 1, d: 0 }]));
check("route: jump is A, fire is B, a tap is clamped to the page, sticks are clamped", toGame(1, { t: "jump", down: 1 })[0].type === "playlab:jump" && toGame(1, { t: "fire", down: true })[0].down === true && JSON.stringify(toGame(3, { t: "tap", nx: 1.4, ny: -2 })[0]) === JSON.stringify({ type: "playlab:tap", slot: 3, nx: 1, ny: 0 }) && JSON.stringify(toGame(1, { t: "stick", m: [5, -0.5], a: "x" })[0].m) === "[1,-0.5]");
check("route: the menu passes only known actions; unknown messages and bad slots are safe", toGame(1, { t: "menu", action: "toggle-pause" })[0].action === "toggle-pause" && toGame(1, { t: "menu", action: "reload" }).length === 0 && toGame(1, { t: "ink" }).length === 0 && toGame(9, { t: "jump" })[0].slot === 1);
check("route: a phone that leaves releases everything it held", releaseAll(2).length === 4 && releaseAll(2).every((m) => m.slot === 2));
check("route: the six code layouts, and the engines' layouts are not among them", Object.keys(CODE_LAYOUTS).length === 6 && codeLayout("steering+gas+brake").a === "GAS" && codeLayout("2d") === null && codeLayout("arena") === null && codeLayout("constructor") === null);

// ---- the pad ----
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "playlab-pad-test")}`, "--window-size=844,390", "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 60 && !ws; i++) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = list.find((t) => t.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(250); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function evalJS(expression) { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error("JS error: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result?.result?.value; }
async function waitFor(expression, timeout = 10_000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { let v = null; try { v = await evalJS(expression); } catch {} if (v) return v; await sleep(150); } return null; }
const visible = (ids) => evalJS(`JSON.stringify(${JSON.stringify(ids)}.filter((id) => { const el = document.getElementById(id); if (!el) return false; const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 10 && r.height > 10 && cs.display !== "none" && cs.visibility !== "hidden"; }))`).then(JSON.parse);
const ALL = ["left", "right", "jump", "stickMove", "stickAim", "fire", "dpad", "btnA", "btnB", "tapPad"];
/** Presses an element with real pointer events at its centre; returns the messages the pad sent meanwhile. */
const press = async (elId, holdMs = 60) => {
  await evalJS(`__sent.length = 0; true`);
  const c = await evalJS(`(() => { const r = document.getElementById(${JSON.stringify(elId)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c[0], y: c[1], button: "left", clickCount: 1 });
  await sleep(holdMs);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c[0], y: c[1], button: "left", clickCount: 1 });
  await sleep(60);
  return evalJS(`JSON.stringify(__sent)`).then(JSON.parse);
};
const state = (layout, extra = {}) => evalJS(`__padShowState(${JSON.stringify({ t: "state", level: "Lap Dash", state: "play", score: 3, hud: { score: 3, laps: 2, timer: 75 }, layout, muted: false, players: [{ slot: 1 }], ...extra })}); true`);

try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/pad.html?room=ZZZZ` });
  check("pad.html is up", !!(await waitFor(`typeof window.__padShowState === "function"`)));
  // a recorder in place of the phone link client (the room ZZZZ has no host)
  await evalJS(`window.__sent = []; client = { connected: true, send: (m) => __sent.push(m), sendInput: (s) => __sent.push({ t: "input", l: s.l ? 1 : 0, r: s.r ? 1 : 0, u: s.u ? 1 : 0, d: s.d ? 1 : 0 }), sendJump: (d) => __sent.push({ t: "jump", down: !!d }), sendMode() {}, retry() {} }; true`);

  // dpad+jump: a 4-way d-pad and JUMP
  await state("dpad+jump");
  check("dpad+jump: the d-pad and one A button labelled JUMP, nothing of the engines' pad", JSON.stringify(await visible(ALL)) === JSON.stringify(["dpad", "btnA"]) && (await evalJS(`document.getElementById("btnA").textContent`)) === "JUMP", await visible(ALL));
  const up = await press("dUp");
  check("the up arrow sends input with u = 1, then releases it", up.some((m) => m.t === "input" && m.u === 1) && up.slice(-1)[0].u === 0, up);
  const down = await press("dDown");
  check("the down arrow sends input with d = 1", down.some((m) => m.t === "input" && m.d === 1), down);
  const a = await press("btnA");
  check("JUMP sends jump down then up (the host makes it A)", a[0]?.t === "jump" && a[0].down === true && a.slice(-1)[0].down === false, a);
  check("the state line of a generated game: title, score, lap, timer, playing", /Lap Dash, score 3, lap 2, 1:15, playing/.test(await evalJS(`document.getElementById("gameState").textContent`)), await evalJS(`document.getElementById("gameState").textContent`));

  // dpad+2buttons
  await state("dpad+2buttons");
  check("dpad+2buttons: the d-pad, A and B", JSON.stringify(await visible(ALL)) === JSON.stringify(["dpad", "btnA", "btnB"]) && (await evalJS(`document.getElementById("btnA").textContent + document.getElementById("btnB").textContent`)) === "AB", await visible(ALL));
  const b = await press("btnB");
  check("B sends fire down then up (the host makes it B)", b[0]?.t === "fire" && b[0].down === true && b.slice(-1)[0].down === false, b);

  // steering+gas+brake
  await state("steering+gas+brake");
  check("steering+gas+brake: left and right arrows, GAS and BRAKE", JSON.stringify(await visible(ALL)) === JSON.stringify(["left", "right", "btnA", "btnB"]) && (await evalJS(`document.getElementById("btnA").textContent + "/" + document.getElementById("btnB").textContent`)) === "GAS/BRAKE", await visible(ALL));
  const steer = await press("right");
  check("steering right sends input with r = 1", steer.some((m) => m.t === "input" && m.r === 1), steer);

  // stick+2buttons and stick+fire
  await state("stick+2buttons");
  check("stick+2buttons: the move stick, A and B", JSON.stringify(await visible(ALL)) === JSON.stringify(["stickMove", "btnA", "btnB"]), await visible(ALL));
  await state("stick+fire");
  check("stick+fire: the move stick, the aim stick and FIRE", JSON.stringify(await visible(ALL)) === JSON.stringify(["stickMove", "stickAim", "fire"]) && (await evalJS(`document.getElementById("fire").textContent`)) === "FIRE", await visible(ALL));

  // tap
  await state("tap");
  check("tap: only the tap pad", JSON.stringify(await visible(ALL)) === JSON.stringify(["tapPad"]), await visible(ALL));
  const tap = await press("tapPad");
  check("a tap in the middle of the pad sends its position (about 0.5, 0.5)", tap.length === 1 && tap[0].t === "tap" && Math.abs(tap[0].nx - 0.5) < 0.05 && Math.abs(tap[0].ny - 0.5) < 0.05, tap);

  // game over and pause on the state line and the menu
  await state("dpad+jump", { state: "over" });
  check("game over says which button plays again", /game over: press JUMP to play again/.test(await evalJS(`document.getElementById("gameState").textContent`)));
  await state("dpad+jump", { state: "paused", muted: true });
  check("paused and muted show on the menu buttons", await evalJS(`document.getElementById("mPause").classList.contains("on") && document.getElementById("mMute").classList.contains("on")`));
  const menu = await (async () => { await evalJS(`__sent.length = 0; document.getElementById("mRestart").click(); true`); return evalJS(`JSON.stringify(__sent)`).then(JSON.parse); })();
  check("restart on the menu sends menu restart", menu.length === 1 && menu[0].t === "menu" && menu[0].action === "restart", menu);

  // the engines' own layouts are unchanged
  await state("2d", { level: "sample", coins: 1, total: 4 });
  check("a platformer (layout 2d) shows the classic left, right and JUMP again", JSON.stringify(await visible(ALL)) === JSON.stringify(["left", "right", "jump"]) && /sample · coins 1\/4/.test(await evalJS(`document.getElementById("gameState").textContent`)), await visible(ALL));
  await state("arena", { theme: "zombie graveyard", wave: 2, waves: 5, hp: 80, ammo: 12 });
  check("an arena shows the sticks and FIRE", JSON.stringify(await visible(ALL)) === JSON.stringify(["stickMove", "stickAim", "fire"]) && (await evalJS(`document.getElementById("fire").textContent`)) === "FIRE", await visible(ALL));
} catch (err) { console.log("ERROR", err.message); fails++; }
finally { try { ws.close(); } catch {} chrome.kill(); }
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
