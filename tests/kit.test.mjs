// Headless Chrome checks that the engines and the pad use the uploaded assets (tests/samples/): game.html gets a parallax
// background, textured platforms, a player animated from a sprite sheet and the UI kit on its HUD, panel and score;
// arena.html a sky dome and a floor texture; pad.html the kit's button and colour. Needs the dev server:
//   node tests/kit.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { generateArena } from "../shared/arena.mjs";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9344, BASE = process.argv[2] || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`); if (!cond) fails++; }

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "playlab-kit-test")}`, "--window-size=1100,700", "about:blank"], { stdio: "ignore" });
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
async function waitFor(expression, timeout = 10_000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { let v = null; try { v = await evalJS(expression); } catch {} if (v) return v; await sleep(150); } return null; }
// the samples as data URLs, loaded inside the page (window.__S[name])
const LOAD = `(async () => { window.__S = {}; for (const n of ["background", "texture", "spritesheet", "button", "panel", "coin", "font", "logo"]) { const b = await (await fetch("tests/samples/" + n + ".png", { cache: "no-store" })).blob(); window.__S[n] = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); } return Object.keys(window.__S).length; })()`;
const ASSETS = `[
  { id: "a1", role: "background", name: "sky", hint: "", src: __S.background, w: 800, h: 450, grid: null },
  { id: "a2", role: "texture", name: "bricks", hint: "", src: __S.texture, w: 128, h: 128, grid: null },
  { id: "a3", role: "spritesheet", name: "hero frames", hint: "", src: __S.spritesheet, w: 224, h: 270, grid: { cols: 4, rows: 3 } },
  { id: "a4", role: "ui_button", name: "restart button", hint: "restart", src: __S.button, w: 240, h: 72, grid: null },
  { id: "a5", role: "ui_panel", name: "wood panel", hint: "", src: __S.panel, w: 300, h: 220, grid: null },
  { id: "a6", role: "ui_icon", name: "coin icon", hint: "coin", src: __S.coin, w: 48, h: 48, grid: null },
  { id: "a7", role: "ui_font", name: "digits", hint: "", src: __S.font, w: 220, h: 120, grid: { cols: 10, rows: 4 } },
  { id: "a8", role: "ui_logo", name: "game logo", hint: "", src: __S.logo, w: 400, h: 120, grid: null },
]`;
const LEVEL = JSON.stringify({ theme: "kit test meadow", objects: [{ type: "platform", label: "ground", x: 0, y: 900, w: 1000, h: 60 }, { type: "platform", label: "ledge", x: 400, y: 700, w: 250, h: 40 }, { type: "start", x: 40, y: 840, w: 40, h: 60 }, { type: "goal", x: 900, y: 840, w: 40, h: 60 }, { type: "coin", x: 450, y: 620, w: 30, h: 30 }, { type: "coin", x: 550, y: 620, w: 30, h: 30 }] });

try {
  await send("Page.enable"); await send("Runtime.enable");

  // ---- game.html: the 2D engine wears the assets ----
  await send("Page.navigate", { url: `${BASE}/game.html?embed=1` });
  check("game.html (embed) is up", !!(await waitFor(`!!window.__playlab`)));
  check("the samples load in the page", (await evalJS(LOAD)) === 8);
  await evalJS(`window.postMessage({ type: "playlab:level", level: ${LEVEL}, name: "kit", assets: ${ASSETS}, mode: "2d" }, "*"); true`);
  const built = await waitFor(`(() => { const s = window.__playlab.scene(); return !!(s && s.W && s.avatars && s.avatars.length && s.state === "play"); })()`);
  check("the level builds with the assets", !!built);
  const g = await evalJS(`(() => { const s = window.__playlab.scene(); const av = s.avatars[0]; const tiles = s.children.list.filter((c) => c.type === "TileSprite" && c !== s.bgTile); const f = s.textures.get(av.anim).get(0);
    return { bg: !!s.bgTile && s.bgTile.scrollFactorX === 0 && s.bgTile.depth === -10, platformsTextured: tiles.length, anim: av.anim, sprite: av.skin.type, frame: [f.width, f.height], anims: ["idle", "run", "jump"].map((n) => s.anims.exists(av.anim + ":" + n)), playing: av.skin.anims.currentAnim?.key }; })()`);
  check("a parallax background behind the level (scroll factor 0)", g.bg, g);
  check("both platforms wear the texture", g.platformsTextured === 2, g.platformsTextured);
  check("the player is a sprite cut from the sheet: 56 x 90 frames, idle / run / jump animations", g.sprite === "Sprite" && g.frame[0] === 56 && g.frame[1] === 90 && g.anims.every(Boolean) && /:(idle|run|jump)$/.test(g.playing || ""), g);
  const hud = await evalJS(`({ restart: getComputedStyle(document.getElementById("restartBtn")).backgroundImage.slice(0, 15), panel: getComputedStyle(document.getElementById("msgText")).borderImageSource.slice(0, 15), score: document.getElementById("score").innerHTML, state: window.__playlab.state() })`);
  check("the restart button wears the uploaded button", /url\(/.test(hud.restart), hud.restart);
  check("the message panel is the uploaded panel, 9-sliced", /url\(/.test(hud.panel), hud.panel);
  check("the score shows the coin icon and digits from the font sheet", /class="kicon"/.test(hud.score) && (hud.score.match(/class="dg"/g) || []).length === 2 && !/Coins/.test(hud.score), hud.score.slice(0, 120));
  check("the state carries the kit for the pad: a small button and its colour", /^data:image\/webp/.test(hud.state.kit?.button || "") && /^#[0-9a-f]{6}$/.test(hud.state.kit?.color || "") && hud.state.kit.button.length < 40000, { color: hud.state.kit?.color, bytes: hud.state.kit?.button?.length });
  await evalJS(`window.__playlab.scene().pause(); true`); await sleep(200);
  check("the logo tops the message panel", await evalJS(`!!document.querySelector("#msgText img.klogo") && document.getElementById("msg").classList.contains("show")`));
  await evalJS(`window.__playlab.scene().resume(); true`);
  // a run: the animation follows the state
  await send("Input.dispatchKeyEvent", { type: "keyDown", code: "ArrowRight", key: "ArrowRight", windowsVirtualKeyCode: 39 }); await sleep(400);
  const running = await evalJS(`window.__playlab.scene().avatars[0].skin.anims.currentAnim?.key`);
  await send("Input.dispatchKeyEvent", { type: "keyUp", code: "ArrowRight", key: "ArrowRight", windowsVirtualKeyCode: 39 }); await sleep(500);
  const idle = await evalJS(`window.__playlab.scene().avatars[0].skin.anims.currentAnim?.key`);
  check("run while moving, idle when still", /:run$/.test(running || "") && /:idle$/.test(idle || ""), { running, idle });
  // taking the assets away puts everything back
  await evalJS(`window.postMessage({ type: "playlab:assets", assets: [] }, "*"); true`);
  const plain = await waitFor(`(() => { const s = window.__playlab.scene(); return s && s.state === "play" && !s.bgTile && !s.avatars[0].anim ? { restart: getComputedStyle(document.getElementById("restartBtn")).backgroundImage, score: document.getElementById("score").textContent, kit: window.__playlab.state().kit } : null; })()`);
  check("without assets: paper background, the plain player, the plain HUD, no kit in the state", !!plain && plain.restart === "none" && /^Coins 0\/2$/.test(plain.score) && plain.kit === null, plain);

  // ---- arena.html: a sky dome and the floor texture ----
  await send("Page.navigate", { url: `${BASE}/arena.html?embed=1` });
  check("arena.html (embed) is up", !!(await waitFor(`!!window.__arena`)));
  check("the samples load in the arena page", (await evalJS(LOAD)) === 8);
  const arena = JSON.stringify(generateArena("zombie graveyard at night"));
  await evalJS(`window.postMessage({ type: "playlab:level", level: ${arena}, name: "kit", assets: ${ASSETS} }, "*"); true`);
  const a = await waitFor(`(() => { const A = window.__arena; if (!A.G.scene || !A.G.player) return null; return { dome: !!A.G.dome && A.G.dome.material.side === 1, floorMap: A.G.floor?.material?.map?.image?.naturalWidth || 0, repeat: A.G.floor?.material?.map?.repeat?.x }; })()`);
  check("a sky dome (back side) wears the background and the floor repeats the texture", !!a && a.dome && a.floorMap === 128 && a.repeat === 12, a);
  await evalJS(`window.postMessage({ type: "playlab:assets", assets: [] }, "*"); true`);
  const a2 = await waitFor(`(() => { const A = window.__arena; return A.G.scene && A.G.player && !A.G.dome ? { floorMap: A.G.floor?.material?.map?.image?.width || 0 } : null; })()`);
  check("without assets the arena is back to its theme", !!a2 && a2.floorMap !== 128, a2);

  // ---- pad.html: the kit's button and colour ----
  await send("Page.navigate", { url: `${BASE}/pad.html?room=ZZZZ` });
  check("pad.html is up", !!(await waitFor(`typeof window.__padShowState === "function"`)));
  check("the samples load in the pad page", (await evalJS(LOAD)) === 8);
  const pad = await evalJS(`(() => { __padShowState({ t: "state", level: "kit", state: "play", coins: 0, total: 2, muted: false, players: [], layout: "2d", kit: { button: __S.button, color: "#4338ca" } }); const cs = getComputedStyle(document.getElementById("jump")); return { kit: document.body.classList.contains("kit"), image: cs.backgroundImage.slice(0, 15), radius: cs.borderRadius, purple: getComputedStyle(document.documentElement).getPropertyValue("--purple").trim() }; })()`);
  check("the pad's buttons wear the uploaded button and its colour", pad.kit && /url\(/.test(pad.image) && pad.radius === "18px" && pad.purple === "#4338ca", pad);
  const pad2 = await evalJS(`(() => { __padShowState({ t: "state", level: "kit", state: "play", coins: 0, total: 2, muted: false, players: [], layout: "2d", kit: null }); return { kit: document.body.classList.contains("kit"), image: getComputedStyle(document.getElementById("jump")).backgroundImage, purple: getComputedStyle(document.documentElement).getPropertyValue("--purple").trim() }; })()`);
  check("without a kit the pad is back to its own look", !pad2.kit && pad2.image === "none" && pad2.purple === "#7c3aed", pad2);

  // ---- 3D models: the main character in the 3D view and in the arena ----
  const LOAD_MODEL = `(async () => { const b = await (await fetch("tests/samples/cube.glb", { cache: "no-store" })).blob(); window.__M = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); return window.__M.length; })()`;
  await send("Page.navigate", { url: `${BASE}/game.html?embed=1` });
  check("game.html is up again", !!(await waitFor(`!!window.__playlab`)));
  check("the cube model loads as a data URL", (await evalJS(LOAD_MODEL)) > 100);
  await evalJS(`window.postMessage({ type: "playlab:level", level: ${LEVEL}, name: "model", assets: [], model: { src: window.__M, name: "cube.glb", role: "player", size: 1000 }, mode: "3d-side" }, "*"); true`);
  const m3 = await waitFor(`(() => { const s = window.__playlab.scene(); if (!s || !s.avatars || !s.avatars.length || !View3D.on || !View3D.model) return null; const d = View3D.debug(); return d.meshes.length && d.meshes[0].model ? d : null; })()`, 40_000);
  check("the 3D view shows the uploaded model as the main character", !!m3 && m3.model && m3.meshes[0].model && m3.meshes[0].kids > 0, m3);
  await evalJS(`window.postMessage({ type: "playlab:model", model: null }, "*"); true`);
  const m3off = await waitFor(`(() => { if (View3D.model) return null; const d = View3D.debug(); return d.meshes.length && !d.meshes[0].model ? d : null; })()`, 10_000);
  check("without the model the character is a block again", !!m3off, m3off);
  await send("Page.navigate", { url: `${BASE}/arena.html?embed=1` });
  check("arena.html is up again", !!(await waitFor(`!!window.__arena`)));
  check("the cube model loads in the arena page", (await evalJS(LOAD_MODEL)) > 100);
  await evalJS(`window.postMessage({ type: "playlab:level", level: ${arena}, name: "model", assets: [], model: { src: window.__M, name: "cube.glb", role: "player", size: 1000 } }, "*"); true`);
  const am = await waitFor(`(() => { const A = window.__arena; return A.G.player && A.G.player.mesh.userData.model ? { model: true, kids: A.G.player.mesh.children.length } : null; })()`, 40_000);
  check("the arena's player body is the uploaded model", !!am && am.kids > 0, am);
} catch (err) { console.log("ERROR", err.message); fails++; }
finally { try { ws.close(); } catch {} chrome.kill(); }
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
