// serve.mjs — dev server, no dependencies.
//   npm run dev   (or node serve.mjs [port], default 3000)
// Serves the static files and runs api/*.mjs the way Vercel does (handler(req, res)),
// so the phone flow (index.html -> /api/scan -> game.html) works locally.
// Open the LAN address it prints on your phone (same Wi-Fi).

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

try { process.loadEnvFile(".env"); } catch { console.warn("No .env found: /api/scan will fail until you add MODEL_API_KEY."); }

const PORT = Number(process.argv[2] || process.env.PORT) || 3000;
const ROOT = process.cwd();
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
};
// Never serve secrets or internals.
const BLOCKED = [/^\/\.env/i, /^\/\.git/i, /^\/node_modules/i, /^\/lib\//i, /^\/api\//i];

http.createServer(async (req, res) => {
  let pathname = "/";
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { return send(res, 400, "Bad request"); }
  if (pathname === "/") pathname = "/index.html";

  if (/^\/api\/[a-z0-9_-]+$/i.test(pathname)) return runApi(req, res, pathname);
  if (BLOCKED.some((re) => re.test(pathname))) return send(res, 403, "Forbidden");

  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) return send(res, 403, "Forbidden");

  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
    log(200, pathname);
  } catch (err) {
    const notFound = err.code === "ENOENT" || err.code === "EISDIR";
    log(notFound ? 404 : 500, pathname);
    send(res, notFound ? 404 : 500, notFound ? "Not found" : String(err.code || err));
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`PlayLab dev server`);
  console.log(`  this computer:  http://localhost:${PORT}/`);
  for (const ip of lanAddresses()) console.log(`  your phone:     http://${ip}:${PORT}/   (same Wi-Fi)`);
  console.log(`  Ctrl+C to stop`);
});

/** Run api/<name>.mjs like a Vercel Node function: parsed JSON body, res.status().json(). */
async function runApi(req, res, pathname) {
  const name = pathname.slice(5);
  const file = path.join(ROOT, "api", `${name}.mjs`);
  let mod;
  try { mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`); }   // re-import each call so edits apply without restart
  catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND") { log(404, pathname); return send(res, 404, `No api/${name}.mjs`); }
    console.error(err); log(500, pathname); return send(res, 500, "API module failed to load: " + err.message);
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  req.body = raw;
  if ((req.headers["content-type"] || "").includes("application/json") && raw) {
    try { req.body = JSON.parse(raw); } catch { log(400, pathname); return send(res, 400, "Invalid JSON body"); }
  }
  req.query = Object.fromEntries(new URL(req.url, "http://localhost").searchParams);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); log(res.statusCode, pathname); return res; };
  res.send = (data) => { res.end(data); log(res.statusCode, pathname); return res; };

  try { await mod.default(req, res); }
  catch (err) { console.error(err); if (!res.headersSent) { res.status(500).json({ error: "Server error: " + err.message }); } }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}
function log(code, p) { console.log(`${code} ${p}`); }
function send(res, code, text) { res.writeHead(code, { "Content-Type": "text/plain" }); res.end(text); }
