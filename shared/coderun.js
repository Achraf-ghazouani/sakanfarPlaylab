// shared/coderun.js — runs a generated game (one HTML file) in a sandboxed iframe (window.CodeRun). The host side of the
// PlayLab SDK: wraps the HTML with a strict Content Security Policy and the SDK script, scans it for forbidden APIs,
// mounts it with sandbox="allow-scripts" (no origin of its own: no cookies, no storage, no parent access), forwards the
// phones' input and the menu to it, and hands its messages (ready, state, events, errors, blank canvas, snapshots) back.
window.CodeRun = (() => {
  const CDN = ["https://cdnjs.cloudflare.com/ajax/libs/", "https://cdn.jsdelivr.net/npm/", "https://unpkg.com/"];
  const CDN_RE = /^https:\/\/(cdnjs\.cloudflare\.com\/ajax\/libs\/|cdn\.jsdelivr\.net\/npm\/|unpkg\.com\/)/;
  const SDK_PATH = "/shared/playlab-sdk.js";
  const origin = () => location.origin;

  /** The policy the game runs under: scripts and modules only from the pinned CDNs and the SDK, no network, no frames, no forms. */
  function csp() {
    const cdn = CDN.join(" ");
    return [
      "default-src 'none'", `script-src 'unsafe-inline' 'wasm-unsafe-eval' ${cdn} ${origin()}${SDK_PATH}`, "style-src 'unsafe-inline'",
      `img-src data: blob: ${origin()}/`, "media-src data: blob:", "font-src data:", `connect-src data: blob: ${cdn}`, "worker-src blob:",
      "child-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
    ].join("; ");
  }

  /** The HTML the iframe gets: the model's file with the policy and the SDK put first (any policy of its own is dropped). */
  function wrap(html) {
    let h = String(html || "");
    h = h.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, "");
    const head = `<meta http-equiv="Content-Security-Policy" content="${csp().replace(/"/g, "&quot;")}"><script src="${origin()}${SDK_PATH}"></script>`;
    if (/<head[^>]*>/i.test(h)) h = h.replace(/<head[^>]*>/i, (m) => m + head);
    else if (/<html[^>]*>/i.test(h)) h = h.replace(/<html[^>]*>/i, (m) => m + "<head>" + head + "</head>");
    else h = "<!doctype html><html><head>" + head + "</head><body>" + h + "</body></html>";
    if (!/^\s*<!doctype/i.test(h)) h = "<!doctype html>\n" + h;
    return h;
  }

  /** Forbidden things in generated code, found before it runs (the policy blocks them too; this names them). */
  const RULES = [
    ["document.cookie", /document\s*\.\s*cookie/],
    ["browser storage (localStorage / sessionStorage / indexedDB)", /\b(localStorage|sessionStorage|indexedDB|openDatabase)\b/],
    ["document.domain", /document\s*\.\s*domain/],
    ["the parent page (window.parent / top / opener)", /\b(window\s*\.\s*)?(parent|top|opener)\s*\.\s*(document|location|postMessage|window|frames|eval|localStorage|cookie|name)\b/],
    ["eval / new Function", /\beval\s*\(|new\s+Function\s*\(/],
    ["network calls (fetch / XMLHttpRequest / WebSocket / sendBeacon / EventSource)", /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|navigator\s*\.\s*sendBeacon|new\s+(XMLHttpRequest|WebSocket|EventSource)\b/],
    ["frames, objects, embeds or forms", /<\s*(iframe|object|embed|form|frame)\b/i],
    ["service workers / clipboard / geolocation / camera", /\b(serviceWorker|navigator\s*\.\s*(clipboard|geolocation|mediaDevices|credentials|usb|bluetooth))\b/],
    ["window.name or navigation away", /\bwindow\s*\.\s*name\s*=|\blocation\s*\.\s*(href|assign|replace)\s*[=(]|\bwindow\s*\.\s*open\s*\(/],
  ];
  function scan(html) {
    const h = String(html || ""), problems = [];
    for (const [what, re] of RULES) if (re.test(h)) problems.push(`uses ${what}`);
    for (const m of h.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)) if (!CDN_RE.test(m[1]) && !m[1].startsWith(origin() + SDK_PATH)) problems.push(`loads a script from ${m[1]} (only cdnjs, jsdelivr and unpkg are allowed)`);
    for (const m of h.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) if (!CDN_RE.test(m[1]) && !/^[./]/.test(m[1]) && !/^[a-z@][\w/@.-]*$/i.test(m[1])) problems.push(`imports ${m[1]} (only the pinned CDNs)`);
    for (const m of h.matchAll(/\bfrom\s+["'](https?:\/\/[^"']+)["']/g)) if (!CDN_RE.test(m[1])) problems.push(`imports ${m[1]} (only the pinned CDNs)`);
    const map = /<script[^>]+type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(h);
    if (map) { try { const j = JSON.parse(map[1]); for (const v of Object.values(j.imports || {})) if (!CDN_RE.test(String(v))) problems.push(`import map points to ${v} (only the pinned CDNs)`); } catch { problems.push("the import map is not valid JSON"); } }
    for (const m of h.matchAll(/\b(src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) if (!CDN_RE.test(m[2]) && !m[2].startsWith(origin())) problems.push(`loads ${m[2]} (no outside addresses)`);
    return { ok: problems.length === 0, problems: [...new Set(problems)] };
  }

  /**
   * Mounts the game into `iframe`. on(msg) gets every "playlab:*" message from inside. Returns { send(msg), remount(), destroy() }.
   * The iframe is sandboxed without allow-same-origin: the game has an opaque origin and cannot reach this page or its storage.
   */
  function mount(iframe, html, { on, assets } = {}) {
    const doc = wrap(html);
    let win = null;
    const listener = (e) => {
      if (!win || e.source !== win) return;
      const m = e.data; if (!m || typeof m !== "object" || typeof m.type !== "string" || !m.type.startsWith("playlab:")) return;
      if (m.type === "playlab:ready" && assets) send({ type: "playlab:assets", assets });
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

  return { wrap, scan, mount, csp, CDN };
})();
