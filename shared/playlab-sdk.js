// shared/playlab-sdk.js — the PlayLab SDK inside every generated game (window.PlayLab). The game runs in a sandboxed iframe
// with no origin of its own; this file is the only bridge to the page around it (the Studio, the play page, the big
// screen), and it only ever uses postMessage with the fixed "playlab:*" messages below.
//
//   PlayLab.input.axis(player, "x" | "y")      -1..1 from the keyboard (arrows / WASD), a phone's stick or pad, or touch
//   PlayLab.input.button(player, "A" | "B" | "jump" | "fire" | "pause" | ...)   held right now
//   PlayLab.input.pressed(player, name)        true once per press
//   PlayLab.input.aim(player)                  { x, y } the phone's aim stick (or the mouse as a direction from the centre)
//   PlayLab.input.pointer                      { x, y, nx, ny, down } the mouse / touch on the page (nx, ny in 0..1)
//   PlayLab.players()                          [1, 2, 3, 4] the players present (1 is always the keyboard / first phone)
//   PlayLab.onStart(fn) onPause(fn) onResume(fn) onRestart(fn) onMute(fn)   the host's menu buttons and the top bar reach these
//   PlayLab.gameOver({ win, score })           the game ended; the host hears it (the phones vibrate, the Studio knows)
//   PlayLab.start()                            a new round began (after gameOver, or on "play again"); the host sees "playing" again
//   PlayLab.controller({ type })               which controls the phones should show: "dpad+jump" | "stick+2buttons" | "steering+gas+brake" | "tap" | "dpad+2buttons" | "stick+fire"
//   PlayLab.event("hit" | "coin" | "goal" | "jump" | "explode" | "win" | "lose" | ...)   vibration and sound on the host side
//   PlayLab.assets.get(role)                   { src, kind: "image" | "model", name, width, height } the uploaded picture or model for that role, or null
//   PlayLab.hud.set({ score, lives, timer, laps, text }) / hide() / show()   a small HUD drawn by the SDK
//   PlayLab.ready()                            call when the first frame is on screen (the SDK also notices on its own)
//   PlayLab.screenshot()                       Promise<data URL> of the game's canvas
//   PlayLab.env                                { touch, width, height, muted }
(() => {
  if (window.PlayLab) return;
  const post = (msg) => { try { parent.postMessage(msg, "*"); } catch {} };
  const SLOTS = [1, 2, 3, 4];
  const ALIAS = { jump: "A", action: "A", gas: "A", accelerate: "A", select: "A", ok: "A", fire: "B", shoot: "B", brake: "B", cancel: "B", back: "B" };
  const norm = (name) => { const s = String(name), l = s.toLowerCase(); if (ALIAS[l]) return ALIAS[l]; if (l === "a" || l === "b") return s.toUpperCase(); return l; };
  // one record per player: axes from the phone, buttons held, buttons pressed once
  const P = {}; for (const s of SLOTS) P[s] = { x: 0, y: 0, ax: 0, ay: 0, held: {}, once: {} };
  const present = new Set([1]);
  // keyboard (player 1)
  const keys = new Set();
  const KEYAXES = { ArrowLeft: ["x", -1], ArrowRight: ["x", 1], ArrowUp: ["y", -1], ArrowDown: ["y", 1], KeyA: ["x", -1], KeyD: ["x", 1], KeyW: ["y", -1], KeyS: ["y", 1] };
  const KEYBTN = { Space: "A", KeyZ: "A", KeyJ: "A", Enter: "A", KeyX: "B", KeyK: "B", ShiftLeft: "B", ShiftRight: "B", ControlLeft: "B", KeyP: "pause", Escape: "pause", KeyR: "restart", KeyM: "mute" };
  const hold = (slot, name, down) => { const p = P[slot]; if (!p) return; const was = !!p.held[name]; p.held[name] = !!down; if (down && !was) p.once[name] = true; if (down && (name === "pause" || name === "restart" || name === "mute") && slot === 1) menu(name === "pause" ? "toggle-pause" : name); };
  window.addEventListener("keydown", (e) => { if (e.repeat) return; keys.add(e.code); if (KEYBTN[e.code]) hold(1, KEYBTN[e.code], true); if (KEYAXES[e.code] || KEYBTN[e.code]) e.preventDefault(); }, { passive: false });
  window.addEventListener("keyup", (e) => { keys.delete(e.code); if (KEYBTN[e.code]) hold(1, KEYBTN[e.code], false); });
  window.addEventListener("blur", () => { keys.clear(); for (const s of SLOTS) P[s].held = {}; });
  const keyAxis = (which) => { let v = 0; for (const code of keys) { const k = KEYAXES[code]; if (k && k[0] === which) v += k[1]; } return Math.max(-1, Math.min(1, v)); };
  // pointer (mouse / touch on the page)
  const pointer = { x: 0, y: 0, nx: 0.5, ny: 0.5, down: false };
  const setPointer = (e, down) => { const t = e.touches ? e.touches[0] || e.changedTouches[0] : e; if (!t) return; pointer.x = t.clientX; pointer.y = t.clientY; pointer.nx = innerWidth ? t.clientX / innerWidth : 0.5; pointer.ny = innerHeight ? t.clientY / innerHeight : 0.5; if (down !== undefined) pointer.down = down; };
  window.addEventListener("pointerdown", (e) => { setPointer(e, true); if (!e.target.closest?.(".pl-touch")) hold(1, "B", true); }, { passive: true });
  window.addEventListener("pointermove", (e) => setPointer(e), { passive: true });
  window.addEventListener("pointerup", (e) => { setPointer(e, false); hold(1, "B", false); }, { passive: true });
  window.addEventListener("pointercancel", () => { pointer.down = false; hold(1, "B", false); }, { passive: true });

  // ---- the host's messages ----
  const flow = { start: [], pause: [], resume: [], restart: [], mute: [] };
  let state = "play", score = 0, hud = {}, layout = "dpad+jump", level = document.title || "game", muted = false;
  const assets = {};
  function menu(action) {
    if (action === "restart") { if (flow.restart.length) { for (const f of flow.restart) f(); state = "play"; publish(true); } else post({ type: "playlab:remount" }); }
    else if (action === "pause") { if (state === "play") { state = "paused"; for (const f of flow.pause) f(); publish(true); } }
    else if (action === "resume") { if (state === "paused") { state = "play"; for (const f of flow.resume) f(); publish(true); } }
    else if (action === "toggle-pause") menu(state === "paused" ? "resume" : "pause");
    else if (action === "mute") { muted = !muted; for (const f of flow.mute) f(muted); publish(true); }
  }
  window.addEventListener("message", (e) => {
    const m = e.data; if (!m || typeof m !== "object" || typeof m.type !== "string") return;
    const slot = SLOTS.includes(m.slot) ? m.slot : 1, p = P[slot];
    if (m.type === "playlab:input") { present.add(slot); p.x = (m.r ? 1 : 0) - (m.l ? 1 : 0); p.y = (m.d ? 1 : 0) - (m.u ? 1 : 0); }
    else if (m.type === "playlab:jump") { present.add(slot); hold(slot, "A", !!m.down); }
    else if (m.type === "playlab:fire") { present.add(slot); hold(slot, "B", !!m.down); }
    else if (m.type === "playlab:stick") { present.add(slot); const mv = Array.isArray(m.m) ? m.m : [0, 0], a = Array.isArray(m.a) ? m.a : [0, 0]; p.x = clamp(mv[0]); p.y = clamp(mv[1]); p.ax = clamp(a[0]); p.ay = clamp(a[1]); }
    else if (m.type === "playlab:players") { present.clear(); present.add(1); for (const pl of m.players || []) if (SLOTS.includes(pl.slot)) present.add(pl.slot); }
    else if (m.type === "playlab:menu") menu(String(m.action || ""));
    else if (m.type === "playlab:mute") { muted = !!m.muted; for (const f of flow.mute) f(muted); }
    else if (m.type === "playlab:assets") { for (const k of Object.keys(assets)) delete assets[k]; Object.assign(assets, m.assets && typeof m.assets === "object" ? m.assets : {}); }
    else if (m.type === "playlab:state") publish(true);
    else if (m.type === "playlab:snapshot") screenshot().then((image) => post({ type: "playlab:snapshot", image }));
  });
  const clamp = (v) => Math.max(-1, Math.min(1, Number(v) || 0));

  // ---- what the host hears ----
  let lastSent = "", readySent = false;
  function snapshotState() { return { t: "state", level, state, score, hud: { ...hud }, layout, muted, players: [...present].sort().map((slot) => ({ slot })) }; }
  function publish(force) { const s = snapshotState(), key = JSON.stringify(s); if (!force && key === lastSent) return; lastSent = key; post({ type: "playlab:state", state: s }); }
  setInterval(() => publish(false), 500);
  function ready() { if (readySent) return; readySent = true; post({ type: "playlab:ready" }); for (const f of flow.start) f(); publish(true); setTimeout(blankCheck, 2500); }
  // the first frames drawn tell the host the game is up, even if the game never calls ready()
  let frames = 0; const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => raf((t) => { if (++frames === 5) ready(); fn(t); });
  setTimeout(() => { if (!readySent && document.querySelector("canvas")) ready(); }, 4000);
  // errors reach the host: exceptions, promise rejections, console.error, files that failed to load, CSP blocks
  const sendError = (message, extra = {}) => post({ type: "playlab:error", message: String(message || "error").slice(0, 600), ...extra });
  window.addEventListener("error", (e) => { if (e.target && e.target !== window && e.target.tagName) sendError(`failed to load ${e.target.tagName.toLowerCase()} ${e.target.src || e.target.href || ""}`, { kind: "load" }); else sendError(e.message, { kind: "exception", line: e.lineno, col: e.colno, stack: String(e.error?.stack || "").slice(0, 1200) }); }, true);
  window.addEventListener("unhandledrejection", (e) => sendError(e.reason?.message || String(e.reason || "rejected promise"), { kind: "rejection", stack: String(e.reason?.stack || "").slice(0, 1200) }));
  window.addEventListener("securitypolicyviolation", (e) => sendError(`blocked by the sandbox policy: ${e.violatedDirective} ${e.blockedURI || ""}`, { kind: "csp" }));
  const origError = console.error.bind(console); console.error = (...a) => { origError(...a); sendError(a.map((x) => (x && x.stack) || String(x)).join(" ").slice(0, 600), { kind: "console" }); };
  // WebGL canvases keep their drawing buffer so screenshots (and the blank check) can read them
  const getCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) { if (/webgl/i.test(String(type))) opts = { ...(opts || {}), preserveDrawingBuffer: true }; return getCtx.call(this, type, opts); };
  function mainCanvas() { const cs = [...document.querySelectorAll("canvas")].filter((c) => c.width > 8 && c.height > 8); return cs.sort((a, b) => b.width * b.height - a.width * a.height)[0] || null; }
  async function screenshot() {
    const c = mainCanvas(); if (!c) return null;
    try { const o = document.createElement("canvas"), w = Math.min(640, c.width), h = Math.round(c.height * w / c.width); o.width = w; o.height = h; o.getContext("2d").drawImage(c, 0, 0, w, h); return o.toDataURL("image/jpeg", 0.7); } catch { return null; }
  }
  // blank = nothing drawn (transparent) or fewer than 0.5 % of the pixels differ from the average colour
  async function blankCheck() {
    const c = mainCanvas(); if (!c) { post({ type: "playlab:blank", why: "no canvas" }); return; }
    try {
      const S = 64, o = document.createElement("canvas"); o.width = S; o.height = S; const x = o.getContext("2d", { willReadFrequently: true }); x.drawImage(c, 0, 0, S, S);
      const d = x.getImageData(0, 0, S, S).data, n = S * S; let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; }
      const mr = r / n, mg = g / n, mb = b / n; let differ = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - mr) + Math.abs(d[i + 1] - mg) + Math.abs(d[i + 2] - mb) > 40) differ++;
      if (a / n < 8) post({ type: "playlab:blank", why: "transparent canvas" });
      else if (differ < n * 0.005) post({ type: "playlab:blank", why: "one flat colour" });
    } catch (err) { post({ type: "playlab:blank", why: "unreadable canvas: " + err.message }); }
  }

  // ---- the HUD ----
  let touchPad = null;
  const hudEl = document.createElement("div");
  hudEl.className = "pl-hud"; hudEl.style.cssText = "position:fixed;top:8px;left:8px;z-index:9000;display:flex;gap:6px;flex-wrap:wrap;font:600 13px system-ui,sans-serif;pointer-events:none;";
  const chip = (txt) => `<span style="background:rgba(0,0,0,.55);color:#fff;border-radius:999px;padding:3px 9px">${String(txt).replace(/[<>&]/g, "")}</span>`;
  function hudRender() {
    const parts = [];
    if (hud.score !== undefined) parts.push(chip(`Score ${hud.score}`)); if (hud.lives !== undefined) parts.push(chip(`❤ ${hud.lives}`)); if (hud.laps !== undefined) parts.push(chip(`Lap ${hud.laps}`));
    if (hud.timer !== undefined) { const s = Math.max(0, Math.round(Number(hud.timer) || 0)); parts.push(chip(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`)); }
    if (hud.text) parts.push(chip(hud.text));
    hudEl.innerHTML = parts.join("");
  }
  const mount = () => { if (document.body && !hudEl.isConnected) document.body.appendChild(hudEl); if (document.body && touchPad && !touchPad.isConnected) document.body.appendChild(touchPad); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();

  // ---- touch controls inside the game, when there is a touch screen and no phone pad ----
  const env = { touch: "ontouchstart" in window || navigator.maxTouchPoints > 0, get width() { return innerWidth; }, get height() { return innerHeight; }, get muted() { return muted; } };
  function buildTouch(type) {
    if (!env.touch) return;
    if (touchPad) touchPad.remove();
    touchPad = document.createElement("div"); touchPad.className = "pl-touch";
    touchPad.style.cssText = "position:fixed;inset:0;z-index:8999;pointer-events:none;font:700 20px system-ui,sans-serif;user-select:none;-webkit-user-select:none;";
    const btn = (label, left, right, bottom, size, on, off) => { const b = document.createElement("div"); b.textContent = label; b.style.cssText = `position:absolute;${left !== null ? "left:" + left + "px" : "right:" + right + "px"};bottom:${bottom}px;width:${size}px;height:${size}px;border-radius:50%;background:rgba(255,255,255,.22);border:2px solid rgba(255,255,255,.6);color:#fff;display:flex;align-items:center;justify-content:center;pointer-events:auto;touch-action:none;`; b.addEventListener("pointerdown", (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); on(); }); b.addEventListener("pointerup", off); b.addEventListener("pointercancel", off); touchPad.appendChild(b); return b; };
    const tx = (v) => { P[1].tx = v; }, ty = (v) => { P[1].ty = v; };
    if (type === "dpad+jump" || type === "dpad+2buttons") {
      btn("◀", 18, null, 18, 64, () => tx(-1), () => tx(0)); btn("▶", 96, null, 18, 64, () => tx(1), () => tx(0));
      if (type === "dpad+2buttons") { btn("B", null, 96, 18, 64, () => hold(1, "B", true), () => hold(1, "B", false)); btn("A", null, 18, 40, 72, () => hold(1, "A", true), () => hold(1, "A", false)); }
      else btn("▲", null, 18, 18, 72, () => hold(1, "A", true), () => hold(1, "A", false));
    } else if (type === "steering+gas+brake") {
      btn("◀", 18, null, 18, 64, () => tx(-1), () => tx(0)); btn("▶", 96, null, 18, 64, () => tx(1), () => tx(0));
      btn("GAS", null, 18, 40, 72, () => hold(1, "A", true), () => hold(1, "A", false)); btn("BRK", null, 100, 18, 56, () => hold(1, "B", true), () => hold(1, "B", false));
    } else if (type === "tap") { /* the pointer is the control */ }
    else {   // stick+2buttons, stick+fire: a stick zone on the left, buttons on the right
      const zone = document.createElement("div"); zone.style.cssText = "position:absolute;left:0;bottom:0;width:45%;height:60%;pointer-events:auto;touch-action:none;"; let c0 = null;
      zone.addEventListener("pointerdown", (e) => { c0 = [e.clientX, e.clientY]; zone.setPointerCapture(e.pointerId); });
      zone.addEventListener("pointermove", (e) => { if (!c0) return; tx(clamp((e.clientX - c0[0]) / 50)); ty(clamp((e.clientY - c0[1]) / 50)); });
      const end = () => { c0 = null; tx(0); ty(0); }; zone.addEventListener("pointerup", end); zone.addEventListener("pointercancel", end); touchPad.appendChild(zone);
      btn(type === "stick+fire" ? "FIRE" : "A", null, 18, 40, 72, () => hold(1, "A", true), () => hold(1, "A", false));
      if (type !== "stick+fire") btn("B", null, 100, 18, 56, () => hold(1, "B", true), () => hold(1, "B", false));
    }
    mount();
  }

  // ---- the API ----
  const input = {
    axis(player, which) { const p = P[SLOTS.includes(player) ? player : 1]; const w = which === "y" ? "y" : "x"; if (player === 1 || player === undefined) { const k = keyAxis(w); if (k) return k; const t = w === "x" ? p.tx : p.ty; if (t) return t; } return p[w] || 0; },
    button(player, name) { const p = P[SLOTS.includes(player) ? player : 1]; return !!p.held[norm(name)]; },
    pressed(player, name) { const p = P[SLOTS.includes(player) ? player : 1], n = norm(name); if (p.once[n]) { p.once[n] = false; return true; } return false; },
    aim(player) { const p = P[SLOTS.includes(player) ? player : 1]; if (p.ax || p.ay) return { x: p.ax, y: p.ay }; if (player === 1 || player === undefined) return { x: pointer.nx * 2 - 1, y: pointer.ny * 2 - 1 }; return { x: 0, y: 0 }; },
    pointer,
  };
  window.PlayLab = {
    input, env, assets: { get: (role) => assets[role] || null, list: () => ({ ...assets }) },
    players: () => [...present].sort(),
    onStart: (f) => flow.start.push(f), onPause: (f) => flow.pause.push(f), onResume: (f) => flow.resume.push(f), onRestart: (f) => flow.restart.push(f), onMute: (f) => flow.mute.push(f),
    gameOver({ win = false, score: s } = {}) { state = "over"; if (s !== undefined) score = Number(s) || 0; post({ type: "playlab:event", kind: win ? "win" : "lose", score }); publish(true); },
    start() { state = "play"; publish(true); },
    controller({ type = "dpad+jump" } = {}) { layout = String(type); buildTouch(layout); post({ type: "playlab:controller", layout }); publish(true); },
    event(kind, extra) { post({ type: "playlab:event", kind: String(kind), ...(extra && typeof extra === "object" ? extra : {}) }); },
    hud: { set(fields) { Object.assign(hud, fields || {}); if (fields && fields.score !== undefined) score = Number(fields.score) || 0; hudRender(); publish(false); }, hide() { hudEl.style.display = "none"; }, show() { hudEl.style.display = ""; }, clear() { hud = {}; hudRender(); } },
    setLevel(name) { level = String(name || level); publish(false); },
    ready, screenshot, state: () => snapshotState(),
    get paused() { return state === "paused"; }, get muted() { return muted; },
    version: "1",
  };
})();
