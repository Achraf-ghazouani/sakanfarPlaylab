// Headless Chrome checks the generated-game runtime: shared/coderun.js wraps, scans and mounts a game in a sandboxed iframe
// (no origin of its own, a strict policy), and shared/playlab-sdk.js inside it reports ready / state / events / errors /
// blank canvases, takes input from the host, answers the menu and screenshots. Samples in tests/samples/. Needs the dev server:
//   node tests/sdk.test.mjs [baseUrl]
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9345, BASE = process.argv[2] || "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 240) : ""}`); if (!cond) fails++; }

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--mute-audio", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.tmpdir(), "playlab-sdk-test")}`, "--window-size=900,600", "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 60 && !ws; i++) { try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const p = list.find((t) => t.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {} if (!ws) await sleep(250); }
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function evalJS(expression) {
  const expr = /\bawait\b/.test(expression) ? `(async () => (${expression}))()` : expression;
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error("JS error: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
}
async function waitFor(expression, timeout = 8000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { let v = null; try { v = await evalJS(expression); } catch {} if (v) return v; await sleep(120); } return null; }
const has = (type, extra = "") => waitFor(`(() => { const m = __has(${JSON.stringify(type)}${extra}); return m ? JSON.stringify(m) : null; })()`).then((s) => (s ? JSON.parse(s) : null));

try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: `${BASE}/tests/harness.html` });
  check("the harness is up with CodeRun", !!(await waitFor(`typeof CodeRun === "object" && typeof __run === "function"`)));

  // the scan
  const evil = await evalJS(`JSON.stringify(CodeRun.scan(await (await fetch("samples/evil.html")).text()))`).then(JSON.parse);
  check("the scan names every forbidden thing in evil.html", !evil.ok && evil.problems.length >= 5 && /cookie/.test(evil.problems.join()) && /storage/.test(evil.problems.join()) && /network/.test(evil.problems.join()) && /parent page/.test(evil.problems.join()) && /eval/.test(evil.problems.join()) && /evil\.example\.com\/steal\.js/.test(evil.problems.join()), evil.problems);
  const snakeScan = await evalJS(`JSON.stringify(CodeRun.scan(await (await fetch("samples/snake.html")).text()))`).then(JSON.parse);
  check("the snake passes the scan", snakeScan.ok, snakeScan.problems);
  const wrapped = await evalJS(`CodeRun.wrap("<html><head><meta http-equiv=\\"Content-Security-Policy\\" content=\\"default-src *\\"><title>x</title></head><body>hi</body></html>")`);
  check("wrap(): the policy and the SDK come first, the game's own policy is dropped", /^<!doctype html>/i.test(wrapped) && (wrapped.match(/Content-Security-Policy/g) || []).length === 1 && /default-src 'none'/.test(wrapped) && /playlab-sdk\.js/.test(wrapped) && wrapped.indexOf("Content-Security-Policy") < wrapped.indexOf("<title>"), wrapped.slice(0, 200));
  const policy = await evalJS(`CodeRun.csp()`);
  check("the policy: pinned CDNs only for scripts and connections, no frames, no forms, no eval", /script-src 'unsafe-inline' 'wasm-unsafe-eval' https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/ https:\/\/cdn\.jsdelivr\.net\/npm\/ https:\/\/unpkg\.com\//.test(policy) && /connect-src data: blob: https:\/\/cdnjs/.test(policy) && /frame-src 'none'/.test(policy) && /form-action 'none'/.test(policy) && !/unsafe-eval'/.test(policy.replace("wasm-unsafe-eval", "")), policy);

  // the snake: mounted in a sandbox, ready, a controller layout, input moves it, the menu works, a screenshot comes back
  await evalJS(`__run("snake")`);
  check("the iframe is sandboxed without its own origin (the page cannot reach its document, the game cannot reach the page)", !!(await waitFor(`(() => { const f = document.getElementById("game"); return f.getAttribute("sandbox") === "allow-scripts allow-pointer-lock" && f.contentDocument === null; })()`)));
  check("the game says ready", !!(await has("playlab:ready")));
  const ctrl = await has("playlab:controller");
  check("it asked the phones for a d-pad and a jump button", ctrl?.layout === "dpad+jump", ctrl);
  const st = await has("playlab:state", `, (m) => m.state && m.state.hud && m.state.hud.text === "run 1"`);
  check("state reaches the host: playing, score 0, run 1, the layout", !!st && st.state.state === "play" && st.state.score === 0 && st.state.layout === "dpad+jump", st?.state);
  await evalJS(`__send({ type: "playlab:snapshot" }); true`);
  const shot1 = await has("playlab:snapshot");
  check("a screenshot comes back as a JPEG data URL", /^data:image\/jpeg/.test(shot1?.image || ""), shot1?.image?.slice(0, 30));
  // steer down with a phone's d-pad, then take another screenshot: the picture changed
  await evalJS(`__msgs = __msgs.filter((m) => m.type !== "playlab:snapshot"); __send({ type: "playlab:input", slot: 1, l: 0, r: 0, u: 0, d: 1 }); true`);
  await sleep(700);
  await evalJS(`__send({ type: "playlab:snapshot" }); true`);
  const shot2 = await has("playlab:snapshot");
  check("the game responds to the phone's input: the screen changed", !!shot2?.image && shot2.image !== shot1.image && shot2.image.length > 1000);
  // pause and resume from the host's menu, then a restart (the game registered onRestart: run 2)
  await evalJS(`__msgs = []; __send({ type: "playlab:menu", action: "pause" }); true`);
  check("pause from the menu: state paused", !!(await has("playlab:state", `, (m) => m.state.state === "paused"`)));
  await evalJS(`__msgs = []; __send({ type: "playlab:menu", action: "resume" }); true`);
  check("resume: playing again", !!(await has("playlab:state", `, (m) => m.state.state === "play"`)));
  await evalJS(`__msgs = []; __send({ type: "playlab:menu", action: "restart" }); true`);
  check("restart reaches the game's own handler: run 2, score 0", !!(await has("playlab:state", `, (m) => m.state.hud.text === "run 2" && m.state.score === 0`)));
  // the keyboard works inside the sandbox: a key press steers it (the iframe needs focus)
  await evalJS(`document.getElementById("game").focus(); true`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 }); await sleep(100);
  await send("Input.dispatchKeyEvent", { type: "keyUp", code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 });
  // run into a wall by holding up: game over reaches the host as an event
  await evalJS(`__msgs = []; __send({ type: "playlab:input", slot: 1, l: 0, r: 0, u: 1, d: 0 }); true`);
  const over = await has("playlab:event", `, (m) => m.kind === "lose"`);
  check("running into the wall: a lose event and state over", !!over && !!(await has("playlab:state", `, (m) => m.state.state === "over"`)), over);
  await evalJS(`__msgs = []; __send({ type: "playlab:input", slot: 1, l: 0, r: 0, u: 0, d: 0 }); __send({ type: "playlab:jump", slot: 1, down: true }); __send({ type: "playlab:jump", slot: 1, down: false }); true`);
  check("the phone's jump button presses A: the snake starts run 3", !!(await has("playlab:state", `, (m) => m.state.hud.text === "run 3" && m.state.state === "play"`)));
  const noLeak = await evalJS(`(() => { try { return document.getElementById("game").contentWindow.PlayLab === undefined; } catch { return true; } })()`);
  check("the page cannot read the game's window", noLeak === true);

  // a game that throws: the error reaches the host with its message
  await evalJS(`__run("broken")`);
  const err = await has("playlab:error");
  check("an exception in the game is reported with its message and line", !!err && /notAFunction/.test(err.message) && err.kind === "exception" && err.line > 0, err);

  // a game that draws nothing: a blank canvas is reported
  await evalJS(`__run("blank")`);
  const blank = await waitFor(`(() => { const m = __has("playlab:blank"); return m ? JSON.stringify(m) : null; })()`, 9000).then((s) => (s ? JSON.parse(s) : null));
  check("a blank canvas is reported", !!blank && /flat colour|transparent/.test(blank.why), blank);

  // a game that reaches out at run time: the policy blocks it and the SDK reports the block
  await evalJS(`__run("leaky")`);
  const csp1 = await has("playlab:error", `, (m) => m.kind === "csp" && /img-src/.test(m.message)`);
  const csp2 = await has("playlab:error", `, (m) => m.kind === "csp" && /connect-src/.test(m.message)`);
  check("an outside image and an outside fetch are blocked by the policy and reported", !!csp1 && !!csp2 && /example\.com/.test(csp1.message), [csp1?.message, csp2?.message]);
  check("the leaky game still drew its frame (not blank)", !(await waitFor(`!!__has("playlab:blank")`, 4000)));

  // assets reach the game after ready
  await evalJS(`__run("snake", { player: { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", kind: "image", name: "hero", width: 1, height: 1 } })`);
  await has("playlab:ready");
  await evalJS(`__msgs = []; __send({ type: "playlab:state" }); true`);
  check("the host's asset list is sent after ready (no error from the game)", !!(await has("playlab:state")) && !(await evalJS(`!!__has("playlab:error")`)));
} catch (err) { console.log("ERROR", err.message); fails++; }
finally { try { ws.close(); } catch {} chrome.kill(); }
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
