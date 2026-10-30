#!/usr/bin/env node
// scan.mjs — photo of a drawn level -> levels/<name>.json via Meta Muse Spark.
//
//   node scan.mjs photos/level1.jpg                 -> levels/level1.json
//   node scan.mjs photos/level1.jpg --out x.json    -> custom output path
//   node scan.mjs --mock                            -> levels/mock.json, no API call
//
// Reads MODEL_API_KEY (and optional MODEL_API_URL, MODEL_NAME) from .env.

import fs from "node:fs/promises";
import path from "node:path";
import { scanLevelFromImage, normalizeLevel, mimeFromName, DEFAULT_API_URL, DEFAULT_MODEL } from "./lib/scan-level.mjs";

try { process.loadEnvFile(".env"); } catch { /* no .env yet; handled below */ }

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? true; };
const mock = args.includes("--mock");
const outFlag = flag("--out");
const imagePath = args.find((a) => !a.startsWith("--") && a !== outFlag);

if (!mock && !imagePath) {
  console.error("Usage: node scan.mjs <photo.jpg> [--out levels/name.json]   or   node scan.mjs --mock");
  process.exit(1);
}

const name = mock ? "mock" : path.basename(imagePath, path.extname(imagePath));
const outPath = typeof outFlag === "string" ? outFlag : path.join("levels", `${name}.json`);

async function main() {
  let level, raw = "", usage;

  if (mock) {
    // Pretend the AI answered, so the rest of the pipeline can be tested offline.
    const fake = await fs.readFile("levels/sample.json", "utf8");
    level = normalizeLevel(JSON.parse(fake));
    console.log("(mock) using levels/sample.json instead of calling the model");
  } else {
    const apiKey = process.env.MODEL_API_KEY;
    if (!apiKey) {
      console.error("No MODEL_API_KEY found. Copy .env.example to .env and put your key in it.");
      process.exit(1);
    }
    const apiUrl = process.env.MODEL_API_URL || DEFAULT_API_URL;
    const model = process.env.MODEL_NAME || DEFAULT_MODEL;

    let bytes;
    try { bytes = await fs.readFile(imagePath); }
    catch { console.error(`Cannot read ${imagePath}. Put your photo there first.`); process.exit(1); }

    const mb = bytes.length / 1e6;
    if (mb > 4) console.warn(`Warning: ${mb.toFixed(1)} MB image. If the API rejects it, resize to ~1500px wide first.`);

    console.log(`Scanning ${imagePath} (${mb.toFixed(2)} MB) with ${model} ...`);
    const t0 = Date.now();
    try {
      ({ level, raw, usage } = await scanLevelFromImage({ base64: bytes.toString("base64"), mime: mimeFromName(imagePath), apiKey, apiUrl, model }));
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
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const tok = usage ? ` (${usage.prompt_tokens ?? "?"} in / ${usage.completion_tokens ?? "?"} out tokens)` : "";
    console.log(`Model replied in ${secs}s${tok}`);
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
  console.log(`\nSaved ${outPath}`);
  console.log("Next: open viewer.html, pick the photo + this JSON to check the boxes.");
}

main().catch((err) => { console.error(err); process.exit(1); });
