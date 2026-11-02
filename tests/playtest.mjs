// Automated playtest of game.html in headless Chrome via the DevTools protocol.
// Start the dev server first (node serve.mjs), then:  npm run playtest
//   node tests/playtest.mjs [baseUrl] [outDir]
// Set CHROME=<path to chrome.exe> if Chrome is not in the default location.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const BASE = process.argv[2] || "http://localhost:3000";
const OUT = process.argv[3] || path.join(os.tmpdir(), "playlab-playtest");
await fs.mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, "chrome-profile")}`,
  "--window-size=1280,800", "about:blank",
], { stdio: "ignore" });

async function getPageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("Chrome did not start (set CHROME=path\\to\\chrome.exe)");
}

const ws = new WebSocket(await getPageWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push("EXCEPTION: " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  } else if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
    consoleErrors.push(msg.params.type.toUpperCase() + ": " + msg.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
async function evalJS(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("JS error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const key = (type, code, keyCode) => evalJS(`window.dispatchEvent(new KeyboardEvent("${type}", { code: "${code}", key: "${code}", keyCode: ${keyCode}, which: ${keyCode}, bubbles: true, cancelable: true })); true`);
const hold = async (code, keyCode, ms) => { await key("keydown", code, keyCode); await sleep(ms); await key("keyup", code, keyCode); };

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`);
  if (!cond) fails++;
}

const S = 'game.scene.getScene("play")';
const snap = () => evalJS(`(() => { const s = ${S}; return { state: s.state, x: Math.round(s.player.x), y: Math.round(s.player.y), vy: Math.round(s.player.body.velocity.y), coins: s.coins, total: s.totalCoins, enemies: s.enemies.countActive(true), onGround: s.player.body.blocked.down || s.player.body.touching.down }; })()`);
const enemy = (i) => evalJS(`(() => { const e = ${S}.enemies.getChildren()[${i}]; return { x: Math.round(e.x), y: Math.round(e.y), patrol: e.getData("patrol") }; })()`);
const teleport = (x, y) => evalJS(`${S}.player.body.reset(${x}, ${y}); true`);
async function restart() { await evalJS(`${S}.scene.restart(); true`); await sleep(500); }

try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/game.html?level=levels/sample.json` });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { ready = await evalJS(`(() => { try { return !!(game && ${S} && ${S}.player); } catch { return false; } })()`); if (!ready) await sleep(100); }
  check("scene ready", ready);
  await sleep(500);

  // 1. initial state
  let s = await snap();
  check("starts in play state with 4 coins, 2 enemies", s.state === "play" && s.total === 4 && s.enemies === 2, s);
  check("spawned at start, standing on ground", Math.abs(s.x - 60) < 5 && s.onGround && Math.abs(s.y - 872) < 6, { x: s.x, y: s.y, onGround: s.onGround });
  const x0 = s.x;

  // 2. run right / left
  await hold("ArrowRight", 39, 500);
  s = await snap();
  check("ArrowRight moves player right ~165 units", s.x - x0 > 100 && s.x - x0 < 230, { dx: s.x - x0 });
  await hold("KeyA", 65, 300);
  const s2 = await snap();
  check("A key moves player left", s2.x < s.x - 50, { dx: s2.x - s.x });

  // 3. jump: full (held) vs short hop (tapped), variable height
  const minYDuring = async (ms) => { let min = 9999; const t0 = Date.now(); while (Date.now() - t0 < ms) { min = Math.min(min, (await snap()).y); await sleep(25); } return min; };
  await restart();
  await key("keydown", "Space", 32);
  const fullMin = await minYDuring(700);
  await key("keyup", "Space", 32);
  const fullRise = 872 - fullMin;
  check("held Space = full jump (rose > 180 units)", fullRise > 180, { rise: fullRise });
  await sleep(600);
  s = await snap();
  check("lands back on ground", s.onGround && Math.abs(s.y - 872) < 6, { y: s.y, onGround: s.onGround });
  await hold("Space", 32, 40);
  const shortRise = 872 - (await minYDuring(600));
  check("tapped Space = short hop (lower than full jump)", shortRise > 40 && shortRise < fullRise - 60, { shortRise, fullRise });
  await sleep(400);
  await hold("ArrowUp", 38, 60); await sleep(240); s = await snap();
  check("ArrowUp also jumps", s.y < 872 - 60, { y: s.y });
  await sleep(1000);
  await hold("KeyW", 87, 60); await sleep(240); s = await snap();
  check("W also jumps", s.y < 872 - 60, { y: s.y });
  await sleep(1000);
  await hold("Space", 32, 60); await sleep(150);
  await hold("Space", 32, 60); await sleep(200); s = await snap();
  check("no double jump in the air", s.y > 872 - 260, { y: s.y });

  // 3b. coyote time: run off ledge 1 (x 200-360, top 760) and jump a few frames late
  await restart();
  await teleport(350, 733); await sleep(300);
  await hold("ArrowRight", 39, 130);
  await key("keydown", "Space", 32);
  await sleep(200);
  s = await snap();
  await key("keyup", "Space", 32);
  check("coyote time: jump still works just after walking off an edge", s.y < 700 && s.x > 378, { x: s.x, y: s.y, vy: s.vy });

  // 3c. jump buffer: press jump shortly before landing, it fires on touchdown
  await restart();
  await teleport(100, 650);           // falls ~223 units, lands after ~430ms
  await sleep(330);
  await hold("Space", 32, 50);        // tapped and released ~50ms before touchdown
  await sleep(100);                   // now landed; a buffered tap gives a short hop
  const bufferedRise = 872 - (await minYDuring(400));
  check("jump buffer: tap just before landing still hops", bufferedRise > 25 && bufferedRise < 160, { rise: bufferedRise });

  // 3d. skin follows the physics body
  await sleep(600);
  const skin = await evalJS(`(() => { const s = ${S}; return { dx: Math.abs(s.skin.x - s.player.x), dy: Math.abs(s.skin.y - s.player.body.bottom), sx: s.skin.scaleX, sy: s.skin.scaleY }; })()`);
  check("visible skin tracks the body", skin.dx < 1 && skin.dy < 1 && Math.abs(skin.sx - 1) < 0.05 && Math.abs(skin.sy - 1) < 0.05, skin);

  // 4. coin
  await restart();
  await teleport(275, 700); await sleep(400);
  s = await snap();
  check("touching a coin collects it", s.coins === 1 && s.total === 4, { coins: s.coins });
  check("HUD shows score", (await evalJS(`document.getElementById("score").textContent`)) === "Coins 1/4");

  // 5. stomp enemy
  await restart();
  let e = await enemy(0);
  await teleport(e.x, e.y - 90); await sleep(700);
  s = await snap();
  check("falling onto an enemy squashes it, player survives", s.enemies === 1 && s.state === "play", { enemies: s.enemies, state: s.state });

  // 6. side hit kills player, then auto restart
  await restart();
  e = await enemy(0);
  await teleport(e.x - 70, e.y); await hold("ArrowRight", 39, 500);
  s = await snap();
  check("walking into an enemy kills player", s.state === "dead", { state: s.state });
  await sleep(1200);
  s = await snap();
  check("level auto-restarts after death", s.state === "play" && s.enemies === 2 && Math.abs(s.x - 60) < 5, { state: s.state, x: s.x });

  // 7. spikes
  await restart();
  await teleport(330, 800); await sleep(500);
  s = await snap();
  check("spikes kill player", s.state === "dead", { state: s.state });

  // 8. goal
  await restart();
  await teleport(960, 380); await sleep(400);
  s = await snap();
  check("touching the goal wins", s.state === "won", { state: s.state });
  check("win message shown", (await evalJS(`document.getElementById("msgText").textContent`)).includes("Level complete"));
  await key("keydown", "KeyR", 82); await key("keyup", "KeyR", 82); await sleep(500);
  s = await snap();
  check("R restarts after win", s.state === "play", { state: s.state });

  // 9. fall off
  await restart();
  await teleport(490, 1100); await sleep(400);
  s = await snap();
  check("falling off the bottom restarts", s.state === "dead" || s.state === "play", { state: s.state });

  // 10. ride the moving platform
  await restart();
  await teleport(770, 520); await sleep(300);
  const before = await snap();
  await sleep(1000);
  const after = await snap();
  check("player rides the moving cloud", Math.abs(after.x - before.x) > 40 && Math.abs(after.y - 533) < 8 && after.onGround, { dx: after.x - before.x, y: after.y });

  // 11. enemies stay on their platforms
  await restart();
  await sleep(3000);
  const e0 = await enemy(0), e1 = await enemy(1);
  check("enemy 0 stays within its patrol range", e0.x >= e0.patrol.left - 2 && e0.x <= e0.patrol.right + 2, e0);
  check("enemy 1 stays within its patrol range", e1.x >= e1.patrol.left - 2 && e1.x <= e1.patrol.right + 2, e1);

  // 12a. camera: zoomed past "fit" and follows the player vertically
  await restart();
  await sleep(600);
  const camGround = await evalJS(`(() => { const s = ${S}; const c = s.cameras.main; return { zoom: c.zoom, fit: Math.min(s.scale.width / s.W, s.scale.height / s.H), scrollY: c.scrollY }; })()`);
  check("camera zoom is above fit-to-screen", camGround.zoom > camGround.fit * 1.1, camGround);
  await teleport(900, 380); await sleep(1200);
  const camHigh = await evalJS(`${S}.cameras.main.scrollY`);
  check("camera scrolls up when player climbs", camGround.scrollY - camHigh > 50, { ground: Math.round(camGround.scrollY), high: Math.round(camHigh) });

  // 12b. audio context created on first key, mute toggles with M
  check("AudioContext created after key input", await evalJS(`!!SFX.ctx`));
  const mutedBefore = await evalJS(`SFX.muted`);
  await hold("KeyM", 77, 50); await sleep(100);
  check("M toggles mute", (await evalJS(`SFX.muted`)) === !mutedBefore);
  await hold("KeyM", 77, 50); await sleep(100);

  // 12. level switch via dropdown
  await evalJS(`(() => { const sel = document.getElementById("levelSelect"); sel.value = "levels/level1.json"; sel.dispatchEvent(new Event("change")); return true; })()`);
  await sleep(800);
  s = await snap();
  const theme = await evalJS(`document.getElementById("theme").textContent`);
  check("dropdown switches level", theme.includes("level1") && s.total === 0, { theme, total: s.total });

  // 12c. drawn art: level1 has its photo, so its platforms and flag wear the cut-out pen strokes; G toggles shapes
  const artOf = `(() => ({ art: Object.keys(levelArt).length, images: ${S}.children.list.filter((g) => g.type === "Image").length, on: artOn }))()`;
  const art1 = await evalJS(artOf);
  check("level1 uses the drawing as art", art1.art >= 4 && art1.images === art1.art && art1.on, art1);
  await hold("KeyG", 71, 50); await sleep(400);
  const art2 = await evalJS(artOf);
  check("G switches to simple shapes", !art2.on && art2.images === 0, art2);
  await hold("KeyG", 71, 50); await sleep(400);
  const art3 = await evalJS(artOf);
  check("G switches the drawn art back on", art3.on && art3.images === art1.images, art3);

  // 13. phone controllers: a second character for slot 2, independent input, respawn without restart, menu + state
  await evalJS(`(() => { const sel = document.getElementById("levelSelect"); sel.value = "levels/sample.json"; sel.dispatchEvent(new Event("change")); return true; })()`);
  await sleep(1000);
  await evalJS(`setRemotePlayers([{ slot: 2, color: "#3b82f6", name: "blue" }]); true`);
  await sleep(200);
  const av = await evalJS(`(() => { const s = ${S}; return { n: s.avatars.length, slots: s.avatars.map((a) => a.slot), x2: Math.round(s.avatars[1].obj.x), x1: Math.round(s.player.x) }; })()`);
  check("a phone in slot 2 gets its own character", av.n === 2 && av.slots.join() === "1,2", av);
  await evalJS(`remoteInput(2, { l: 0, r: 1 }); true`); await sleep(500); await evalJS(`remoteInput(2, { l: 0, r: 0 }); true`); await sleep(100);
  const moved = await evalJS(`(() => { const s = ${S}; return { x2: Math.round(s.avatars[1].obj.x), x1: Math.round(s.player.x) }; })()`);
  check("slot 2 input moves only character 2", moved.x2 > av.x2 + 60 && Math.abs(moved.x1 - av.x1) < 5, { before: av, moved });
  const y0 = await evalJS(`Math.round(${S}.avatars[1].obj.y)`);
  const minVy = await evalJS(`new Promise((res) => { const s = ${S}; let m = 0; remoteJump(2, true); const t0 = performance.now(); const tick = () => { m = Math.min(m, s.avatars[1].obj.body.velocity.y); if (performance.now() - t0 < 300) requestAnimationFrame(tick); else { remoteJump(2, false); res(Math.round(m)); } }; tick(); })`);
  const y1 = await evalJS(`Math.round(${S}.avatars[1].obj.y)`);
  check("slot 2 jump lifts character 2", minVy < -600, { minVy, y0, y1 });
  await sleep(900);
  await evalJS(`(() => { const s = ${S}; s.avatars[1].obj.body.reset(s.W / 2, s.H + 100); return true; })()`); await sleep(300);
  check("character 2 dying does not restart the level", (await evalJS(`${S}.state`)) === "play" && (await evalJS(`${S}.avatars[1].dead`)) === true);
  await sleep(1100);
  const back = await evalJS(`(() => { const s = ${S}; return { dead: s.avatars[1].dead, y: Math.round(s.avatars[1].obj.y), spawnY: Math.round(s.spawn.feetY) }; })()`);
  check("character 2 respawns at the start", back.dead === false && back.y < back.spawnY, back);
  await evalJS(`menuAction("toggle-pause"); true`); await sleep(100);
  const paused = await evalJS(`({ state: ${S}.state, snap: window.__playlab.state() })`);
  check("menu pause pauses the scene and publishes the state", paused.state === "paused" && paused.snap.state === "paused" && paused.snap.players.length === 1 && paused.snap.total > 0, paused.snap);
  await evalJS(`menuAction("toggle-pause"); true`); await sleep(100);
  check("menu resume", (await evalJS(`${S}.state`)) === "play");
  await evalJS(`menuAction("mute"); true`);
  check("menu mute toggles sound", (await evalJS(`window.__playlab.state().muted`)) === true);
  await evalJS(`menuAction("mute"); true`);
  await evalJS(`setRemotePlayers([]); true`); await sleep(100);
  check("character 2 leaves with its phone", (await evalJS(`${S}.avatars.length`)) === 1);

  // Screenshot of the sample level for a visual check
  await evalJS(`(() => { const sel = document.getElementById("levelSelect"); sel.value = "levels/sample.json"; sel.dispatchEvent(new Event("change")); return true; })()`);
  await sleep(1200);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(OUT, "sample.png");
  await fs.writeFile(shotPath, Buffer.from(shot.data, "base64"));
  console.log("screenshot saved to " + shotPath);

  check("no console errors/exceptions", consoleErrors.length === 0, consoleErrors.slice(0, 5));
} catch (err) {
  console.error("TEST SCRIPT ERROR:", err);
  fails++;
} finally {
  ws.close();
  spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
