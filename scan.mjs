#!/usr/bin/env node
// scan.mjs — photo of a drawn level -> levels/<name>.json via the AI (Meta Muse Spark by default).
//
//   node scan.mjs photos/level1.jpg                   -> levels/level1.json
//   node scan.mjs photos/level1.jpg --out x.json      -> custom output path
//   node scan.mjs photos/level1.jpg --provider baseten
//   node scan.mjs --mock                              -> levels/mock.json, no API call
//   node scan.mjs --index                             -> only rebuild levels/index.json
//   add --no-fix to skip the playtest agent (reachability check + AI repair)
//
// Keys come from .env (see .env.example). Every run also rewrites levels/index.json,
// which game.html uses for its dropdown.

import fs from "node:fs/promises";
import path from "node:path";
import { scanLevelFromImage, normalizeLevel, mimeFromName, imageSize } from "./lib/scan-level.mjs";
import { playtestAndFix } from "./lib/fix-level.mjs";

try { process.loadEnvFile(".env"); } catch { /* no .env yet; handled below */ }

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? true; };
const mock = args.includes("--mock");
const outFlag = flag("--out");
const providerFlag = flag("--provider");
const previousFlag = flag("--previous");     // re-scan of an edited drawing: path of the earlier level JSON
const imagePath = args.find((a) => !a.startsWith("--") && a !== outFlag && a !== providerFlag && a !== previousFlag);

if (args.includes("--index")) {
  await writeIndex();
  process.exit(0);
}

if (!mock && !imagePath) {
  console.error("Usage: node scan.mjs <photo.jpg> [--out levels/name.json] [--provider meta|baseten]   or   --mock   or   --index");
  process.exit(1);
}

const name = mock ? "mock" : path.basename(imagePath, path.extname(imagePath));
const outPath = typeof outFlag === "string" ? outFlag : path.join("levels", `${name}.json`);

async function main() {
  let level, info = {};

  if (mock) {
    // Pretend the AI answered, so the rest of the pipeline can be tested offline.
    const fake = await fs.readFile("levels/sample.json", "utf8");
    level = normalizeLevel(JSON.parse(fake));
    console.log("(mock) using levels/sample.json instead of calling the model");
  } else {
    let bytes;
    try { bytes = await fs.readFile(imagePath); }
    catch { console.error(`Cannot read ${imagePath}. Put your photo there first.`); process.exit(1); }

    const mb = bytes.length / 1e6;
    if (mb > 4) console.warn(`Warning: ${mb.toFixed(1)} MB image. If the API rejects it, resize to ~1600px wide first.`);

    // Photo aspect ratio keeps the level from being squashed into a square in the game.
    const dims = imageSize(bytes);
    let aspect;
    if (dims) {
      const rotated = dims.orientation >= 5;
      aspect = rotated ? dims.height / dims.width : dims.width / dims.height;
      if (rotated) console.warn("Warning: this photo has EXIF rotation. If the boxes look misaligned in viewer.html, re-save the photo upright.");
    }

    let previous = null;
    if (typeof previousFlag === "string") {
      previous = normalizeLevel(JSON.parse(await fs.readFile(previousFlag, "utf8")));
      console.log(`Re-scan: comparing with ${previousFlag} (${previous.objects.length} objects)`);
    }

    console.log(`Scanning ${imagePath} (${mb.toFixed(2)} MB${dims ? `, ${dims.width}x${dims.height}` : ""}) ...`);
    try {
      ({ level, ...info } = await scanLevelFromImage({ base64: bytes.toString("base64"), mime: mimeFromName(imagePath), aspect, previous, provider: typeof providerFlag === "string" ? providerFlag : undefined }));
      if (previous) { const { diffLevels } = await import("./shared/diff.mjs"); level.diff = diffLevels(previous, level); console.log(`Changes: ${level.diff.summary}`); }
    } catch (err) {
      if (err.raw) {
        const rawPath = outPath.replace(/\.json$/, "") + ".raw.txt";
        await fs.mkdir(path.dirname(rawPath), { recursive: true });
        await fs.writeFile(rawPath, err.raw);
        console.error(`${err.message}\nRaw reply saved to ${rawPath}`);
      } else {
        console.error(err.message);
      }
      process.exit(2);
    }
    const tok = info.usage ? ` (${info.usage.prompt_tokens ?? "?"} in / ${info.usage.completion_tokens ?? "?"} out tokens)` : "";
    console.log(`${info.provider} / ${info.model} replied in ${(info.ms / 1000).toFixed(1)}s${tok}${info.fallback ? "  [fallback provider]" : ""}`);
  }

  // Playtest agent: check every jump, let the AI repair impossible parts (auto fallback).
  if (!args.includes("--no-fix")) {
    const { level: fixed, report } = await playtestAndFix(level, { useAI: !mock });
    if (report.before.ok) console.log("Playtest: every platform, coin and goal is reachable.");
    else {
      console.log(`Playtest: ${report.before.problems.length} problem(s):`);
      for (const p of report.before.problems) console.log("  - " + p);
      if (report.aiError) console.log("  AI fix skipped: " + report.aiError);
      console.log(`  Fixed by ${report.fixedBy}${report.aiMs ? ` (AI ${(report.aiMs / 1000).toFixed(1)}s)` : ""}:`);
      for (const c of report.fixes) console.log("  * " + c);
      if (!report.after.ok) console.log("  Still unreachable: " + report.after.problems.join("; "));
    }
    level = fixed;
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(level, null, 2));

  // Summary
  const counts = {};
  for (const o of level.objects) counts[o.type] = (counts[o.type] ?? 0) + 1;
  console.log(`\nTheme: ${level.theme}`);
  console.log(`Objects: ${level.objects.length}  ->  ${Object.entries(counts).map(([k, v]) => `${k} x${v}`).join(", ")}`);
  console.log("");
  for (const o of level.objects) {
    console.log(`  ${o.type.padEnd(16)} ${o.label.padEnd(20)} x=${String(o.x).padStart(4)} y=${String(o.y).padStart(4)} w=${String(o.w).padStart(4)} h=${String(o.h).padStart(4)}`);
  }
  console.log(`\nSaved ${outPath}${level.aspect ? ` (aspect ${level.aspect})` : ""}`);
  await writeIndex();
  console.log("Next: npm run dev, then open http://localhost:3000/game.html to play it, or viewer.html to check the boxes.");
}

/** levels/index.json lists every level for the dropdown in game.html (newest first). */
async function writeIndex() {
  const dir = "levels";
  await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json") && f !== "index.json");
  const entries = [];
  for (const f of files) {
    try {
      const [text, st] = await Promise.all([fs.readFile(path.join(dir, f), "utf8"), fs.stat(path.join(dir, f))]);
      const lvl = JSON.parse(text);
      entries.push({ file: f, theme: lvl.theme ?? "", objects: Array.isArray(lvl.objects) ? lvl.objects.length : 0, mtime: st.mtimeMs });
    } catch { /* skip unreadable files */ }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  await fs.writeFile(path.join(dir, "index.json"), JSON.stringify({ levels: entries.map(({ mtime, ...e }) => e) }, null, 2));
  console.log(`Updated levels/index.json (${entries.length} level${entries.length === 1 ? "" : "s"})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
