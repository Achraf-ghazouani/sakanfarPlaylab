// shared/codescan.mjs — the rules every AI-written game runs under, shared by the page (shared/coderun.mjs mounts the game)
// and the server (lib/code.mjs refuses to save code that breaks them): the pinned CDNs, the Content Security Policy, the
// wrapper that puts the policy and the PlayLab SDK first, and the scan that names forbidden APIs before the code runs.

export const CDN = ["https://cdnjs.cloudflare.com/ajax/libs/", "https://cdn.jsdelivr.net/npm/", "https://unpkg.com/"];
export const CDN_RE = /^https:\/\/(cdnjs\.cloudflare\.com\/ajax\/libs\/|cdn\.jsdelivr\.net\/npm\/|unpkg\.com\/)/;
export const SDK_PATH = "/shared/playlab-sdk.js";

/** The policy the game runs under: scripts and modules only from the pinned CDNs and the SDK, no network, no frames, no forms. */
export function csp(origin = "") {
  const cdn = CDN.join(" ");
  return [
    "default-src 'none'", `script-src 'unsafe-inline' 'wasm-unsafe-eval' ${cdn} ${origin}${SDK_PATH}`, "style-src 'unsafe-inline'",
    `img-src data: blob: ${origin ? origin + "/" : ""}`, "media-src data: blob:", "font-src data:", `connect-src data: blob: ${cdn}`, "worker-src blob:",
    "child-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join("; ");
}

/**
 * The HTML the iframe gets: the model's file with the policy, the person's pictures (window.__playlabAssets) and the SDK
 * put first (any policy of its own is dropped).
 */
export function wrap(html, { origin = "", assets = null } = {}) {
  let h = String(html || "");
  h = h.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, "");
  const list = assets && typeof assets === "object" && Object.keys(assets).length ? `<script>window.__playlabAssets=${JSON.stringify(assets).replace(/</g, "\\u003c")}</script>` : "";
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp(origin).replace(/"/g, "&quot;")}">${list}<script src="${origin}${SDK_PATH}"></script>`;
  if (/<head[^>]*>/i.test(h)) h = h.replace(/<head[^>]*>/i, (m) => m + head);
  else if (/<html[^>]*>/i.test(h)) h = h.replace(/<html[^>]*>/i, (m) => m + "<head>" + head + "</head>");
  else h = "<!doctype html><html><head>" + head + "</head><body>" + h + "</body></html>";
  if (!/^\s*<!doctype/i.test(h)) h = "<!doctype html>\n" + h;
  return h;
}

/** Forbidden things in generated code, found before it runs (the policy blocks them too; this names them). */
export const RULES = [
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
export function scan(html, { origin = "" } = {}) {
  const h = String(html || ""), problems = [];
  for (const [what, re] of RULES) if (re.test(h)) problems.push(`uses ${what}`);
  for (const m of h.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)) if (!CDN_RE.test(m[1]) && !(origin && m[1].startsWith(origin + SDK_PATH))) problems.push(`loads a script from ${m[1]} (only cdnjs, jsdelivr and unpkg are allowed)`);
  for (const m of h.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) if (!CDN_RE.test(m[1]) && !/^[./]/.test(m[1]) && !/^[a-z@][\w/@.-]*$/i.test(m[1])) problems.push(`imports ${m[1]} (only the pinned CDNs)`);
  for (const m of h.matchAll(/\bfrom\s+["'](https?:\/\/[^"']+)["']/g)) if (!CDN_RE.test(m[1])) problems.push(`imports ${m[1]} (only the pinned CDNs)`);
  const map = /<script[^>]+type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i.exec(h);
  if (map) { try { const j = JSON.parse(map[1]); for (const v of Object.values(j.imports || {})) if (!CDN_RE.test(String(v))) problems.push(`import map points to ${v} (only the pinned CDNs)`); } catch { problems.push("the import map is not valid JSON"); } }
  for (const m of h.matchAll(/\b(src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) if (!CDN_RE.test(m[2]) && !(origin && m[2].startsWith(origin))) problems.push(`loads ${m[2]} (no outside addresses)`);
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
