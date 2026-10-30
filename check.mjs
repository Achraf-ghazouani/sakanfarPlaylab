#!/usr/bin/env node
// check.mjs — run the playtest agent on a level file from the terminal.
//
//   node check.mjs levels/level1.json              report only
//   node check.mjs levels/x.json --fix             AI + auto fix -> levels/x.fixed.json
//   node check.mjs levels/x.json --fix --write     fix the file in place
//   node check.mjs levels/x.json --fix --no-ai     algorithmic fix only (no API call)

import fs from "node:fs/promises";
import { checkLevel } from "./shared/reach.mjs";
import { playtestAndFix } from "./lib/fix-level.mjs";

try { process.loadEnvFile(".env"); } catch { /* only needed for --fix with AI */ }

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("Usage: node check.mjs <level.json> [--fix] [--write] [--no-ai]"); process.exit(1); }

const level = JSON.parse(await fs.readFile(file, "utf8"));
const report = checkLevel(level);
console.log(`${file}: ${level.objects.length} objects, ${report.reachable.length} reachable platform(s), goal ${report.goalReachable ? "reachable" : "NOT reachable"}`);
if (report.ok) { console.log("All platforms, coins and goals are reachable."); }
else { console.log(`${report.problems.length} problem(s):`); for (const p of report.problems) console.log("  - " + p.message); }

if (args.includes("--fix") && !report.ok) {
  const useAI = !args.includes("--no-ai");
  console.log(`\nFixing (${useAI ? "AI first, then auto" : "auto only"}) ...`);
  const { level: fixed, report: r } = await playtestAndFix(level, { useAI });
  if (r.aiError) {
    console.log("AI fix skipped: " + r.aiError);
    if (r.aiRaw) { const rawPath = file.replace(/\.json$/, ".fix.raw.txt"); await fs.writeFile(rawPath, r.aiRaw); console.log(`  raw AI reply saved to ${rawPath}`); }
  }
  console.log(`Fixed by: ${r.fixedBy ?? "nothing"}${r.aiMs ? ` (AI took ${(r.aiMs / 1000).toFixed(1)}s)` : ""}`);
  for (const c of r.fixes) console.log("  * " + c);
  console.log(`After: ${r.after.ok ? "all reachable" : r.after.problems.length + " problem(s) left"}`);
  const out = args.includes("--write") ? file : file.replace(/\.json$/, ".fixed.json");
  await fs.writeFile(out, JSON.stringify(fixed, null, 2));
  console.log(`Saved ${out}`);
}
process.exit(report.ok || args.includes("--fix") ? 0 : 2);
