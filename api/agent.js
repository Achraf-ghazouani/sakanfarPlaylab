// api/agent.js — the Studio game agent endpoint (Vercel serverless function). Five tasks on one function (the Hobby plan
// allows 12 functions and api/ has 12):
//   POST { message, level?, history?: [{role, content}], attachments?: [{name, type}] }          the chat agent (platformers, arenas)
//   -> 200 { reply, actions, level?, kind?: "create"|"edit", note?, diff?, playtest?, meta?, credits? }
//   POST { task: "plan", message, plan?, history? }                                                a plan for a game written as code (free)
//   -> 200 { plan, meta: { model, ms } }
//   POST { task: "code", plan, prompt, project_id?, change?, previous_html? }   (also POST /api/build-code, a rewrite)
//   -> 200 text/event-stream: data: {e:"start"} ... {e:"progress", chars, lines} ... {e:"done", html, notes, scan, engine, credits, fix} | {e:"error", error}
//   POST { task: "fix", token, plan, prompt, html, report }                                        the self-healing loop (free, token-bound)
//   -> the same stream; done carries the next token and the attempt number
//   POST { task: "look", token, plan, prompt, snapshot }                                           the vision check (free, token-bound)
//   -> 200 { match, looksLike, problems, suggestion, model, ms }
// Credits: a chat turn without a level costs create_2d, a turn on an existing level costs edit_2d (402 when the balance is
// short); replies that need no AI are free; a failed AI call is refunded. A code build costs code_create_2d / code_create_3d
// (code_edit with previous_html), charged before the stream starts and refunded when the model fails. Fixes and looks are
// free but need the token a paid build handed out (20 minutes, at most MAX_FIXES fixes).
// Muse Spark (Meta Model API) answers with function tools; the server validates the level, runs the quick reachability fix
// and returns it. Muse Wonder writes and repairs code games (lib/code.mjs). Keys stay in environment variables.

import { runAgent, quickReply, cleanHistory } from "../lib/agent.mjs";
import { paid, charge, refund } from "../lib/credits.mjs";
import { normalizeLevel } from "../lib/scan-level.mjs";
import { normalizeArena, genreWanted } from "../shared/arena.mjs";
import { requireUser, rateLimit } from "../lib/auth.mjs";
import { planGame, generateGame, repairGame, lookAtGame, normalizePlan, actionFor, cleanReport, makeFixToken, readFixToken, MAX_FIXES, CODE_MODEL, MAX_HTML, MIN_HTML } from "../lib/code.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const user = await requireUser(req, res);   // AI costs money: logged-in, approved accounts only
  if (!user) return;
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  const task = String(body.task || req.query?.task || "chat");
  if (task === "plan") return plan(res, user, body);
  if (task === "code") return code(res, user, body);
  if (task === "fix") return fix(res, user, body);
  if (task === "look") return look(res, user, body);

  const message = String(body.message || "").slice(0, 2000);
  let level = null;
  if (body.level && Array.isArray(body.level.objects) && body.level.objects.length && body.level.objects.length <= 300) {
    level = body.level.genre === "arena" ? normalizeArena(body.level) : normalizeLevel(body.level, { aspect: body.level.aspect });
  }
  const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [];

  const free = quickReply(message, !!level, attachments, level);
  if (free) return res.status(200).json(free);
  const model = typeof body.model === "string" ? body.model.slice(0, 60) : null;
  try {
    // 3D prices: the Studio's 3D toggle, an arena shooter (always 3D), or words asking for one
    const is3d = String(body.mode || "").startsWith("3d") || level?.genre === "arena" || genreWanted(message) === "arena";
    const out = await paid(user, res, level ? (is3d ? "edit_3d" : "edit_2d") : (is3d ? "create_3d" : "create_2d"), { model, gameId: uuidOrNull(body.project_id) },
      (c) => runAgent({ message, level, history, attachments }, { timeoutMs: 50_000, provider: c.provider }));
    if (!out) return;   // 402 / 403 already sent
    return res.status(200).json({ ...out.result, credits: out.credits });
  } catch (err) {
    console.error("agent failed:", err.message);
    const status = err.status === 401 || err.status === 403 ? 500 : 502;   // never leak auth details
    return res.status(status).json({ error: friendly(err), credits: { refunded: !!err.refunded, balance: err.balance } });
  }
}

/** A plan for a game the code builder will write: Muse Spark, a few seconds, not charged. */
async function plan(res, user, body) {
  const message = String(body.message || "").slice(0, 2000).trim();
  if (!message) return res.status(400).json({ error: "Say what game to plan." });
  try {
    const out = await planGame({ message, previousPlan: body.plan && typeof body.plan === "object" ? body.plan : null, history: cleanHistory(body.history, 8) }, { timeoutMs: 45_000 });
    return res.status(200).json({ plan: out.plan, meta: { model: out.model, ms: out.ms } });
  } catch (err) {
    console.error("plan failed:", err.message);
    return res.status(err.status === 401 || err.status === 403 ? 500 : 502).json({ error: friendly(err) });
  }
}

/** The events of a build or a fix: headers, keep-alive pings, start, the work's done payload, or an error. */
async function streamEvents(res, start, work, onError) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const ev = (o) => { try { res.write("data: " + JSON.stringify(o) + "\n\n"); } catch {} };
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 10_000);
  ev({ e: "start", ...start });
  try { ev({ e: "done", ...(await work(ev)) }); }
  catch (err) {
    console.error("code build failed:", err.message, err.cause?.message || "");
    ev({ e: "error", error: friendly(err), ...((onError && await onError(err)) || {}) });
  } finally { clearInterval(ping); res.end(); }
}
const pick = (out) => ({ html: out.html, notes: out.notes, scan: out.scan, engine: out.engine, ms: out.ms, usage: out.usage });

/** Muse Wonder writes the game: charged first (a normal JSON 402 when refused), then the progress streams as events. */
async function code(res, user, body) {
  const planIn = body.plan && typeof body.plan === "object" ? normalizePlan(body.plan) : null;
  if (!planIn) return res.status(400).json({ error: "A plan is required: ask for the plan first." });
  const prompt = String(body.prompt || "").slice(0, 2000);
  const change = body.change ? String(body.change).slice(0, 2000) : null;
  const previousHtml = change && typeof body.previous_html === "string" && body.previous_html.length >= MIN_HTML && body.previous_html.length <= MAX_HTML ? body.previous_html : null;
  if (change && !previousHtml) return res.status(400).json({ error: "A change needs the current game code." });
  const action = actionFor(planIn, !!previousHtml), project = uuidOrNull(body.project_id);
  const c = await charge(user, action, { model: CODE_MODEL, gameId: project });
  if (!c.ok) return res.status(c.status).json(c.body);
  return streamEvents(res, { action, cost: c.cost, balance: c.balance, model: c.model, modelName: c.modelName },
    async (ev) => {
      const out = await generateGame({ plan: planIn, prompt, previousHtml, change, assets: body.assets && typeof body.assets === "object" ? body.assets : {} },
        { provider: c.provider, model: c.model || CODE_MODEL, timeoutMs: 270_000, onProgress: (p) => ev({ e: "progress", ...p }) });
      return { ...pick(out), credits: { spent: c.cost, balance: c.balance, action, model: c.model }, fix: makeFixToken({ ledger: c.ledgerId, n: 0, project }) };
    },
    async () => { const back = await refund(c.ledgerId, "refund: the code build failed"); return { credits: { refunded: !!back?.ok, balance: back?.balance ?? c.balance } }; });
}

/** Muse Wonder fixes a game that failed in the sandbox: free, within the token of a paid build, at most MAX_FIXES times. */
async function fix(res, user, body) {
  const t = readFixToken(body.token);
  if (!t) return res.status(403).json({ error: "Fixes are free only right after a paid build (the build token is missing or expired). Say go to build it again." });
  if (t.n >= MAX_FIXES) return res.status(429).json({ error: `The ${MAX_FIXES} free fixes of this build are used up.` });
  const planIn = body.plan && typeof body.plan === "object" ? normalizePlan(body.plan) : null;
  const html = typeof body.html === "string" ? body.html : "";
  if (!planIn || html.length < MIN_HTML || html.length > MAX_HTML) return res.status(400).json({ error: "The plan and the current game code are required." });
  const report = cleanReport(body.report), attempt = t.n + 1;
  return streamEvents(res, { action: "fix", attempt, free: true, model: CODE_MODEL },
    async (ev) => {
      const out = await repairGame({ plan: planIn, prompt: String(body.prompt || "").slice(0, 2000), html, report }, { timeoutMs: 270_000, onProgress: (p) => ev({ e: "progress", ...p }) });
      return { ...pick(out), attempt, fix: makeFixToken({ ledger: t.ledger, n: attempt, project: t.project }) };
    });
}

/** Muse Spark looks at a screenshot of the running game: does it look like the game asked for? Free, token-bound, rate limited. */
async function look(res, user, body) {
  const t = readFixToken(body.token);
  if (!t) return res.status(403).json({ error: "A look is free only right after a paid build (the build token is missing or expired)." });
  if (!(await rateLimit("look:" + user.uid, 12, 600))) return res.status(429).json({ error: "Too many looks in a row. Try again in a few minutes." });
  const snapshot = String(body.snapshot || "");
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(snapshot) || snapshot.length > 600_000) return res.status(400).json({ error: "A JPEG, PNG or WebP screenshot under 450 KB is required." });
  try {
    const out = await lookAtGame({ plan: body.plan && typeof body.plan === "object" ? body.plan : {}, prompt: String(body.prompt || "").slice(0, 2000), snapshot }, { timeoutMs: 40_000 });
    return res.status(200).json(out);
  } catch (err) {
    console.error("look failed:", err.message);
    return res.status(err.status === 401 || err.status === 403 ? 500 : 502).json({ error: friendly(err) });
  }
}

function friendly(err) {
  const m = String(err?.message || err);
  if (/no API key|not configured/i.test(m)) return "The AI is not configured on the server (MODEL_API_KEY).";
  if (err?.name === "TimeoutError" || /timed? ?out|aborted/i.test(m)) return "The AI took too long. Try again.";
  if (err?.status === 429) return "The AI is busy right now. Try again in a moment.";
  if (/ran out of room|did not answer with a game|too big to save/.test(m)) return m;
  if (/request failed|stream broke|fetch failed/.test(m)) return "The AI service could not be reached: " + m.slice(0, 200) + ". Try again.";
  return "The AI could not answer: " + m.slice(0, 160);
}
function uuidOrNull(v) { return /^[0-9a-f-]{36}$/i.test(String(v || "")) ? v : null; }
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
