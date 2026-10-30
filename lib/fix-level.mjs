// lib/fix-level.mjs — the playtest agent: check reachability, let the AI repair impossible parts,
// and fall back to algorithmic stepping stones so the level is always beatable. Server-side only.

import { chat } from "./ai.mjs";
import { checkLevel, autoFixLevel, MAX_JUMP_H } from "../shared/reach.mjs";
import { normalizeLevel, extractJson } from "./scan-level.mjs";

const SYSTEM_PROMPT = `You are the playtest agent for a 2D platformer that was generated from a hand drawing.

Level JSON: a 1000 x 1000 grid, y goes DOWN, x,y is the top-left corner of each object, w,h its size.
Player physics in grid units: the player is about 36 wide and 54 tall, jumps at most ${Math.round(MAX_JUMP_H - 8)} up, and the longest jump on flat ground covers about 300 across (less when jumping up, more when dropping down). Platforms are solid from every side: the player cannot jump up through one and must take off beside it.

A checker lists what cannot be reached from the start. Fix the level with the SMALLEST changes so that every platform, coin and goal becomes reachable:
- lower a platform or coin a little, widen a platform toward a gap, or add a small stepping platform (type "platform", label "step (AI)", w 60-120, h 15-25),
- keep every original object and its label, do not move the start, keep the drawing recognizable,
- prefer adding a step over moving a drawn object.

Respond with JSON only, no prose:
{"theme":"...","objects":[ ...every object, fixed... ],"changes":["lowered 'brick platform' by 80","added a step under 'sky coin'"]}`;

/**
 * Check a level and repair it if needed.
 * @returns {Promise<{level: object, report: {before, after, fixedBy, fixes, aiError}}>}
 */
export async function playtestAndFix(level, { useAI = true, provider, timeoutMs = Number(process.env.PLAYLAB_AI_TIMEOUT_MS) || 90_000 } = {}) {
  const before = checkLevel(level);
  const report = { before: summary(before), after: null, fixedBy: null, fixes: [], aiError: null, aiMs: 0, aiRaw: null };
  if (before.ok) {
    report.after = report.before;
    return { level: { ...level, checked: true, fixes: [] }, report };
  }

  let current = level, fixes = [], fixedBy = null;
  if (useAI) {
    try {
      const ai = await aiFix(level, before, { provider, timeoutMs });
      report.aiMs = ai.ms;
      current = ai.level; fixes = ai.changes; fixedBy = "ai";
    } catch (err) {
      report.aiError = String(err.message || err).slice(0, 200);
      if (err.raw) report.aiRaw = String(err.raw).slice(0, 1500);
      if (err.ms) report.aiMs = err.ms;
    }
  }

  let after = checkLevel(current);
  if (!after.ok) {
    const auto = autoFixLevel(current);
    current = auto.level;
    fixes = [...fixes, ...auto.changes];
    fixedBy = fixedBy ? "ai+auto" : "auto";
    after = checkLevel(current);
  }

  report.after = summary(after);
  report.fixedBy = fixedBy;
  report.fixes = fixes;
  return { level: { ...current, checked: true, fixes }, report };
}

async function aiFix(level, check, { provider, timeoutMs }) {
  const slim = { theme: level.theme, aspect: level.aspect, objects: level.objects };
  const prompt = `Level JSON:\n${JSON.stringify(slim)}\n\nProblems found by the checker:\n- ${check.problems.map((p) => p.message).join("\n- ")}\n\nReturn the fixed level JSON.`;
  // Low reasoning effort: the checker already did the analysis, the AI only needs design judgement, and we want an answer in seconds.
  const reply = await chat({ provider, system: SYSTEM_PROMPT, prompt, temperature: 0.2, maxTokens: 12000, timeoutMs, reasoningEffort: process.env.PLAYLAB_FIX_EFFORT || "low" });
  const fail = (msg) => { const e = new Error(msg); e.raw = reply.text; e.ms = reply.ms; return e; };
  const parsed = extractJson(reply.text);
  if (!parsed || !Array.isArray(parsed.objects)) throw fail("AI fix returned no level JSON");

  const fixed = normalizeLevel({ theme: parsed.theme ?? level.theme, objects: parsed.objects }, { aspect: level.aspect });
  if (fixed.objects.length < Math.ceil(level.objects.length * 0.8)) throw fail("AI fix dropped too many objects");
  const after = checkLevel(fixed);
  if (after.problems.length >= check.problems.length) throw fail(`AI fix did not improve the level (${after.problems.length} problems left)`);

  let changes = Array.isArray(parsed.changes) ? parsed.changes.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim().slice(0, 100)).slice(0, 6) : [];
  if (!changes.length) changes = [`AI adjusted ${Math.abs(fixed.objects.length - level.objects.length) || "some"} object(s)`];
  return { level: fixed, changes, ms: reply.ms };
}

function summary(check) {
  return { ok: check.ok, goalReachable: check.goalReachable, problems: check.problems.map((p) => p.message) };
}
