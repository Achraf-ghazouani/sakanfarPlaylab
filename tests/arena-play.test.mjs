// Headless Chrome drives arena.html: the demo arena builds, waves spawn, the player walks and shoots, a view switch,
// death and the state the Studio and phones receive. Needs the dev server:  node tests/arena-play.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { generateArena } from "../shared/arena.mjs";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9341, BASE = process.argv[2] || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`); if (!cond) fails++; }

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "playlab-arena-test")}`, "--window-size=1100,700", "about:blank"], { stdio: "ignore" });
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
const key = async (code, keyCode, ms) => { await send("Input.dispatchKeyEvent", { type: "keyDown", code, key: code.replace("Key", ""), windowsVirtualKeyCode: keyCode }); await sleep(ms); await send("Input.dispatchKeyEvent", { type: "keyUp", code, key: code.replace("Key", ""), windowsVirtualKeyCode: keyCode }); };

try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/arena.html?demo=1` });
  const built = await (async () => { for (let i = 0; i < 100; i++) { try { if (await evalJS(`!!(window.__arena && window.__arena.G.scene && window.__arena.G.player)`)) return true; } catch {} await sleep(200); } return false; })();
  check("the demo arena builds (three.js scene, player, gates, walls)", built);
  const b = await evalJS(`(() => { const G = window.__arena.G; return { solids: G.solids.length, gates: G.spawners.length, pickups: G.pickups.length, state: G.state, view: G.view, waves: G.level.waves, theme: G.level.theme }; })()`);
  check("walls, gates and pickups are in the scene", b.solids > 8 && b.gates >= 3 && b.pickups >= 3 && b.state === "ready" && b.view === "fps", b);

  // start, waves spawn
  await evalJS(`window.__arena.startPlay(); true`); await sleep(2500);
  const w = await evalJS(`(() => { const G = window.__arena.G; return { wave: G.wave, zombies: G.zombies.filter((z) => !z.dead).length, pending: G.pending, state: G.state }; })()`);
  check("wave 1 starts and zombies come out of the gates", w.wave === 1 && w.zombies >= 2 && w.state === "play", w);

  // keyboard: W walks forward
  const x0 = await evalJS(`window.__arena.G.player.z`);
  await key("KeyW", 87, 500);
  const x1 = await evalJS(`window.__arena.G.player.z`);
  check("W walks the player (first person, toward the gate ahead)", Math.abs(x1 - x0) > 60, { from: Math.round(x0), to: Math.round(x1) });

  // aim at the nearest zombie and shoot until it drops
  const shot = await evalJS(`(async () => { const A = window.__arena, G = A.G; const alive = () => G.zombies.filter((z) => !z.dead); let shots = 0; const k0 = G.kills, a0 = G.player.ammo;
    const aimAt = (z) => { const dx = z.x - G.player.x, dz = z.z - G.player.z, d = Math.hypot(dx, dz); G.yaw = Math.atan2(-dx, -dz); G.pitch = Math.atan2(-30, d); };
    const visible = () => alive().find((z) => { aimAt(z); const p = A.probe(); const hit = p.zombies.find((q) => q.t !== null); return hit && hit.t < p.wallT; });
    for (let i = 0; i < 14 && G.kills === k0; i++) { const z = visible() || alive()[0]; if (!z) break; aimAt(z); if (A.shoot()) shots++; await new Promise((r) => setTimeout(r, 190)); }
    return { shots, kills: G.kills - k0, ammoUsed: a0 - G.player.ammo }; })()`);
  check("shooting a zombie kills it in two hits and costs ammo", shot.kills === 1 && shot.shots <= 4 && shot.ammoUsed === shot.shots, shot);

  // views
  await evalJS(`window.__arena.setView("top"); true`); await sleep(300);
  const top = await evalJS(`({ view: window.__arena.G.view, camY: Math.round(window.__arena.camera.position.y), crossHidden: getComputedStyle(document.getElementById("cross")).display === "none", on: document.querySelector("#viewSeg .on").dataset.view })`);
  check("top-down view: camera high above, no crosshair", top.view === "top" && top.camY > 400 && top.crossHidden && top.on === "top", top);
  await evalJS(`window.__arena.setView("tps"); true`); await sleep(400);
  const tps = await evalJS(`({ view: window.__arena.G.view, camY: Math.round(window.__arena.camera.position.y), bodyVisible: window.__arena.G.player.mesh.visible })`);
  check("third person: camera behind and above, the player body visible", tps.view === "tps" && tps.camY > 80 && tps.camY < 200 && tps.bodyVisible, tps);

  // state for the Studio and the phones
  const st = await evalJS(`JSON.stringify(window.__arena.state())`);
  check("state snapshot: arena layout, wave, kills, hp, ammo", /"layout":"arena"/.test(st) && /"wave":1/.test(st) && /"coins":1/.test(st) && /"hp":/.test(st) && /"view":"tps"/.test(st), st);

  // death
  await evalJS(`window.__arena.G.player.hp = 5; true`);
  const dead = await (async () => { for (let i = 0; i < 60; i++) { if ((await evalJS(`window.__arena.G.state`)) === "dead") return true; await sleep(250); } return false; })();
  check("a zombie bite at 5 hp ends the fight", dead && /You fell/.test(await evalJS(`document.getElementById("msgText").textContent`)));
  await key("KeyR", 82, 50); await sleep(400);
  check("R restarts: fresh player, wave 0", await evalJS(`window.__arena.G.state === "ready" && window.__arena.G.player.hp === 100 && window.__arena.G.wave === 0`));

  // a level file with the arena genre
  await send("Page.navigate", { url: `${BASE}/arena.html?level=levels/zombies.json` });
  const fromFile = await (async () => { for (let i = 0; i < 60; i++) { try { const v = await evalJS(`window.__arena && window.__arena.G.level ? window.__arena.G.level.theme : null`); if (v) return v; } catch {} await sleep(200); } return null; })();
  check("levels/zombies.json loads as an arena", fromFile === "zombie graveyard", fromFile);

  // phone sticks: the Studio forwards the pad's messages to the embedded arena; on a touch device the same sticks are on screen
  await send("Page.navigate", { url: `${BASE}/arena.html?embed=1&touch=1` });
  const emb = await (async () => { for (let i = 0; i < 60; i++) { try { if (await evalJS(`!!(window.__arena && window.__arena.R)`)) return true; } catch {} await sleep(200); } return false; })();
  check("the embedded arena is up", emb);
  await evalJS(`window.postMessage({ type: "playlab:level", level: ${JSON.stringify(generateArena("top down zombie arena, 3 waves"))}, name: "studio" }, "*"); true`);
  const builtTop = await (async () => { for (let i = 0; i < 40; i++) { if (await evalJS(`!!(window.__arena.G.level && window.__arena.G.level.view === "top")`)) return true; await sleep(150); } return false; })();
  check("a level from the Studio builds (top-down, 3 waves)", builtTop && (await evalJS(`window.__arena.G.level.waves`)) === 3);
  check("on a touch device the sticks and FIRE are on screen", await evalJS(`getComputedStyle(document.getElementById("touch")).display === "block" && document.querySelectorAll("#touch .stick").length === 2 && /Tap to start/.test(document.getElementById("msgText").textContent)`));
  await evalJS(`window.postMessage({ type: "playlab:fire", slot: 1, down: true }, "*"); true`); await sleep(200);
  check("FIRE from the phone starts the fight", (await evalJS(`window.__arena.G.state`)) === "play");
  await evalJS(`window.postMessage({ type: "playlab:fire", slot: 1, down: false }, "*"); true`);
  const p0 = await evalJS(`[window.__arena.G.player.x, window.__arena.G.player.z]`);
  await evalJS(`window.postMessage({ type: "playlab:stick", slot: 1, m: [0, 1], a: [0, 0] }, "*"); true`); await sleep(500);
  await evalJS(`window.postMessage({ type: "playlab:stick", slot: 1, m: [0, 0], a: [0, 0] }, "*"); true`);
  const p1 = await evalJS(`[window.__arena.G.player.x, window.__arena.G.player.z]`);
  check("the move stick walks the player (top-down: forward = north)", p0[1] - p1[1] > 60 && Math.abs(p1[0] - p0[0]) < 20, { p0: p0.map(Math.round), p1: p1.map(Math.round) });
  const a0 = await evalJS(`window.__arena.G.player.ammo`);
  await evalJS(`window.postMessage({ type: "playlab:stick", slot: 1, m: [0, 0], a: [1, 0] }, "*"); true`); await sleep(450);
  await evalJS(`window.postMessage({ type: "playlab:stick", slot: 1, m: [0, 0], a: [0, 0] }, "*"); true`);
  const aim = await evalJS(`({ x: +window.__arena.G.aim.x.toFixed(2), z: +window.__arena.G.aim.z.toFixed(2), ammo: window.__arena.G.player.ammo })`);
  check("the aim stick aims east and shoots by itself (twin-stick)", aim.x > 0.9 && Math.abs(aim.z) < 0.1 && aim.ammo < a0, aim);
  await evalJS(`window.__arena.setView("fps"); true`);
  const yaw0 = await evalJS(`window.__arena.G.yaw`);
  await evalJS(`window.postMessage({ type: "playlab:stick", slot: 1, m: [0, 0], a: [1, 0] }, "*"); true`); await sleep(400);
  await evalJS(`window.postMessage({ type: "playlab:stick", slot: 1, m: [0, 0], a: [0, 0] }, "*"); true`);
  const yaw1 = await evalJS(`window.__arena.G.yaw`);
  check("in first person the aim stick turns the view", yaw0 - yaw1 > 0.5, { yaw0: +yaw0.toFixed(2), yaw1: +yaw1.toFixed(2) });
  await evalJS(`window.postMessage({ type: "playlab:input", slot: 1, l: 1, r: 0 }, "*"); true`); await sleep(300);
  await evalJS(`window.postMessage({ type: "playlab:input", slot: 1, l: 0, r: 0 }, "*"); true`);
  check("the platformer pad's arrows turn too", (await evalJS(`window.__arena.G.yaw`)) > yaw1 + 0.3);

  // the pad on a phone: an arena state switches it to the shooter layout
  await send("Page.navigate", { url: `${BASE}/pad.html?room=ZZZZ` });
  const padUp = await (async () => { for (let i = 0; i < 60; i++) { try { if (await evalJS(`typeof window.__padShowState === "function"`)) return true; } catch {} await sleep(200); } return false; })();
  check("the pad is up", padUp);
  await evalJS(`window.__padShowState({ t: "state", layout: "arena", state: "play", theme: "zombie graveyard", wave: 2, waves: 5, hp: 80, ammo: 12, coins: 3, total: 45, view: "fps" }); true`);
  const pad = await evalJS(`({ arena: document.body.classList.contains("layout-arena"), sticks: [...document.querySelectorAll("#pad .stick")].filter((e) => getComputedStyle(e).display !== "none").length, fire: getComputedStyle(document.getElementById("fire")).display, jumpHidden: getComputedStyle(document.getElementById("jump")).display === "none", text: document.getElementById("gameState").textContent })`);
  check("the pad shows move + aim sticks and FIRE, no jump button, wave and health", pad.arena && pad.sticks === 2 && pad.fire === "flex" && pad.jumpHidden && /wave 2\/5/.test(pad.text) && /80/.test(pad.text), pad);
  const stickVal = await evalJS(`(() => { const el = document.getElementById("stickMove"), r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, clientX: cx, clientY: cy, bubbles: true })); el.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: cx + r.width * 0.4, clientY: cy - r.height * 0.1, bubbles: true }));
    const v = window.__padStick && window.__padStick.m.map((n) => +n.toFixed(2)); el.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, clientX: cx, clientY: cy, bubbles: true })); return { v, after: window.__padStick.m }; })()`);
  check("dragging the move stick right gives x≈0.8, y≈0.2, release gives 0", stickVal.v && stickVal.v[0] > 0.7 && stickVal.v[1] > 0.1 && stickVal.after[0] === 0 && stickVal.after[1] === 0, stickVal);
  const fireVal = await evalJS(`(() => { const el = document.getElementById("fire"); el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 8, bubbles: true })); const d = window.__padFire; el.dispatchEvent(new PointerEvent("pointerup", { pointerId: 8, bubbles: true })); return { d, u: window.__padFire }; })()`);
  check("FIRE is a hold", fireVal.d === true && fireVal.u === false, fireVal);
  await evalJS(`window.__padShowState({ t: "state", layout: "2d", state: "play", level: "sample", coins: 1, total: 4 }); true`);
  check("a platformer state brings the arrows and JUMP back", await evalJS(`!document.body.classList.contains("layout-arena") && getComputedStyle(document.getElementById("jump")).display !== "none"`));
} catch (err) { console.log("ERROR", err.message); fails++; }
finally { ws.close(); chrome.kill(); console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0); }
