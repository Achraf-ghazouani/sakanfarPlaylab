// serve.mjs — tiny static dev server, no dependencies.
//   node serve.mjs [port]      (default 3000)  ->  http://localhost:3000/game.html
// Browsers refuse fetch() on file:// URLs, so game.html needs this to read levels/*.json.
// Day 2 will add Vercel-style /api/* handling here.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.argv[2] || process.env.PORT) || 3000;
const ROOT = process.cwd();
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
};
// Never serve secrets or internals.
const BLOCKED = [/^\/\.env/i, /^\/\.git/i, /^\/node_modules/i];

http.createServer(async (req, res) => {
  let pathname = "/";
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { return send(res, 400, "Bad request"); }
  if (pathname === "/") pathname = "/game.html";
  if (BLOCKED.some((re) => re.test(pathname))) return send(res, 403, "Forbidden");

  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) return send(res, 403, "Forbidden");

  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
    console.log(`200 ${pathname}`);
  } catch (err) {
    const notFound = err.code === "ENOENT" || err.code === "EISDIR";
    console.log(`${notFound ? 404 : 500} ${pathname}`);
    send(res, notFound ? 404 : 500, notFound ? "Not found" : String(err.code || err));
  }
}).listen(PORT, () => console.log(`PlayLab dev server -> http://localhost:${PORT}/game.html   (Ctrl+C to stop)`));

function send(res, code, text) { res.writeHead(code, { "Content-Type": "text/plain" }); res.end(text); }
