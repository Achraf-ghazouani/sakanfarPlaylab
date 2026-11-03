// Headless Chrome drives arena.html: the demo arena builds, waves spawn, the player walks and shoots, a view switch,
// death and the state the Studio and phones receive. Needs the dev server:  node tests/arena-play.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

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
    for (let i = 0; i < 14 && G.kills === k0; i++) { const z = alive()[0]; if (!z) break; const dx = z.x - G.player.x, dz = z.z - G.player.z, d = Math.hypot(dx, dz); G.yaw = Math.atan2(-dx, -dz); G.pitch = Math.atan2(-30, d); if (A.shoot()) shots++; await new Promise((r) => setTimeout(r, 190)); }
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
} catch (err) { console.log("ERROR", err.message); fails++; }
finally { ws.close(); chrome.kill(); console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED"); process.exit(fails ? 1 : 0); }
