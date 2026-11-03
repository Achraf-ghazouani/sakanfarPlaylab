// shared/coderun.mjs — runs a generated game (one HTML file) in a sandboxed iframe (window.CodeRun, also an ES module).
// The host side of the PlayLab SDK: wraps the HTML with the strict policy and the SDK script (shared/codescan.mjs), scans it
// for forbidden APIs, mounts it with sandbox="allow-scripts" (no origin of its own: no cookies, no storage, no parent access),
// forwards the phones' input and the menu to it, and hands its messages (ready, state, events, errors, blank canvas,
// snapshots) back.
import { wrap as wrapCode, scan as scanCode, csp as cspFor, CDN } from "./codescan.mjs";

const origin = () => location.origin;
export const wrap = (html, opts = {}) => wrapCode(html, { origin: origin(), ...opts });
export const scan = (html) => scanCode(html, { origin: origin() });
export const csp = () => cspFor(origin());

/**
 * Mounts the game into `iframe`. on(msg) gets every "playlab:*" message from inside. Returns { send(msg), remount(), destroy() }.
 * The iframe is sandboxed without allow-same-origin: the game has an opaque origin and cannot reach this page or its storage.
 * `assets` (role -> { src, kind, name, width, height }) is written into the page before the SDK, so PlayLab.assets.get works
 * from the game's first line.
 */
export function mount(iframe, html, { on, assets } = {}) {
  const doc = wrap(html, { assets });
  let win = null;
  const listener = (e) => {
    if (!win || e.source !== win) return;
    const m = e.data; if (!m || typeof m !== "object" || typeof m.type !== "string" || !m.type.startsWith("playlab:")) return;
    if (m.type === "playlab:remount") { remount(); return; }
    try { on && on(m); } catch (err) { console.warn("CodeRun handler:", err.message); }
  };
  window.addEventListener("message", listener);
  const send = (msg) => { try { win && win.postMessage(msg, "*"); } catch {} };
  const load = () => { iframe.setAttribute("sandbox", "allow-scripts allow-pointer-lock"); iframe.removeAttribute("src"); iframe.srcdoc = doc; win = iframe.contentWindow; };
  const remount = () => load();
  load();
  return { send, remount, destroy() { window.removeEventListener("message", listener); try { iframe.srcdoc = ""; } catch {} win = null; } };
}

export { CDN };
if (typeof window !== "undefined") window.CodeRun = { wrap, scan, mount, csp, CDN };
