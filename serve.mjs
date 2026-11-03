// serve.mjs — dev server, no dependencies.
//   npm run dev            http://localhost:3000  (+ your LAN address)
//   npm run dev:https      https://localhost:3443 (+ LAN) with a self-signed certificate: phones need HTTPS
//                          for the camera. Accept the browser warning once on the phone.
//   node serve.mjs [port] [--https]
// Serves the static files and runs api/*.js the way Vercel does (handler(req, res)).

import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

try { process.loadEnvFile(".env"); } catch { console.warn("No .env found: /api/scan will fail until you add MODEL_API_KEY."); }

const args = process.argv.slice(2);
const useHttps = args.includes("--https");
const PORT = Number(args.find((a) => /^\d+$/.test(a)) || process.env.PORT) || (useHttps ? 3443 : 3000);
const ROOT = process.cwd();
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
};
// Never serve secrets or internals.
const BLOCKED = [/^\/\.env/i, /^\/\.git/i, /^\/node_modules/i, /^\/lib\//i, /^\/api\//i, /^\/certs\//i];

async function handler(req, res) {
  let pathname = "/";
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { return send(res, 400, "Bad request"); }
  if (pathname === "/") pathname = "/index.html";

  if (/^\/api\/[a-z0-9_-]+$/i.test(pathname)) return runApi(req, res, pathname);
  const play = /^\/play\/([a-z0-9]{1,16})$/i.exec(pathname);   // the share page, like the Vercel rewrite in vercel.json
  if (play) { req.url = "/api/play?id=" + play[1].toLowerCase(); return runApi(req, res, "/api/play"); }
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
}

const server = useHttps ? https.createServer(ensureCerts(), handler) : http.createServer(handler);
server.listen(PORT, "0.0.0.0", () => {
  const proto = useHttps ? "https" : "http";
  console.log(`PlayLab dev server${useHttps ? " (HTTPS, self-signed)" : ""}`);
  console.log(`  this computer:  ${proto}://localhost:${PORT}/`);
  for (const ip of lanAddresses()) console.log(`  your phone:     ${proto}://${ip}:${PORT}/   (same Wi-Fi${useHttps ? ", accept the certificate warning once" : ""})`);
  if (!useHttps) console.log(`  camera on a phone needs HTTPS: run "npm run dev:https" or use the vercel.app site`);
  console.log(`  Ctrl+C to stop`);
});

/** Self-signed certificate in certs/ (git-ignored), made with the openssl that ships with Git for Windows. */
function ensureCerts() {
  const dir = path.join(ROOT, "certs"), keyFile = path.join(dir, "dev-key.pem"), certFile = path.join(dir, "dev-cert.pem");
  if (!fsSync.existsSync(keyFile) || !fsSync.existsSync(certFile)) {
    fsSync.mkdirSync(dir, { recursive: true });
    const san = ["DNS:localhost", "IP:127.0.0.1", ...lanAddresses().map((ip) => "IP:" + ip)].join(",");
    const openssl = ["openssl", "C:/Program Files/Git/usr/bin/openssl.exe"].find((bin) => { try { execFileSync(bin, ["version"], { stdio: "ignore" }); return true; } catch { return false; } });
    if (!openssl) { console.error("openssl not found. Install Git for Windows (ships openssl) or create certs/dev-key.pem and certs/dev-cert.pem yourself."); process.exit(1); }
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "365", "-subj", "/CN=playlab-dev", "-addext", "subjectAltName=" + san], { stdio: "ignore" });
    console.log(`Created a self-signed certificate in certs/ for ${san}`);
  }
  return { key: fsSync.readFileSync(keyFile), cert: fsSync.readFileSync(certFile) };
}

/** Run api/<name>.js (or .mjs) like a Vercel Node function: parsed JSON body, res.status().json(). */
async function runApi(req, res, pathname) {
  const name = pathname.slice(5);
  let mod;
  for (const ext of [".js", ".mjs"]) {
    const file = path.join(ROOT, "api", name + ext);
    try { mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`); break; }   // re-import each call so edits apply without restart
    catch (err) {
      if (err.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes(name + ext)) continue;
      console.error(err); log(500, pathname); return send(res, 500, "API module failed to load: " + err.message);
    }
  }
  if (!mod) { log(404, pathname); return send(res, 404, `No api/${name}.js`); }

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
