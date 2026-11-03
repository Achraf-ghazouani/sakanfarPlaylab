// api/agent.js — the Studio's AI code endpoint (Vercel serverless function). Every game is written as code; four tasks:
//   POST { task: "plan", message, plan?, history?, image?, mode? }                                  a plan for the game (free; a picture is read into it)
//   -> 200 { plan, meta: { model, ms } }
//   POST { task: "code", plan, prompt, project_id?, change?, previous_html? }   (also POST /api/build-code, a rewrite)
//   -> 200 text/event-stream: data: {e:"start"} ... {e:"progress", chars, lines, rewrite?} ... {e:"done", html, notes, scan, engine, patch, credits, fix} | {e:"error", error}
//      a change (and a fix) comes back as search / replace patches applied here (patch.mode "patch"), or the whole file when they do not fit ("rewrite")
//   POST { task: "fix", token, plan, prompt, html, report }                                        the self-healing loop (free, token-bound)
//   -> the same stream; done carries the next token and the attempt number
//   POST { task: "look", token, plan, prompt, snapshot }                                           the vision check (free, token-bound)
//   -> 200 { match, looksLike, problems, suggestion, model, ms }
// Credits: a build costs code_create_2d / code_create_3d (code_edit with previous_html), charged before the stream starts and
// refunded when the model fails. Plans are free; fixes and looks are free but need the token a paid build handed out (20 minutes,
// at most MAX_FIXES fixes). Muse Spark plans and looks, Muse Wonder writes and repairs (lib/code.mjs). Keys stay in env vars.

import { charge, refund } from "../lib/credits.mjs";
import { requireUser, rateLimit } from "../lib/auth.mjs";
import { planGame, generateGame, changeGame, repairGame, lookAtGame, normalizePlan, actionFor, cleanReport, makeFixToken, readFixToken, MAX_FIXES, CODE_MODEL, MAX_HTML, MIN_HTML } from "../lib/code.mjs";

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
  return res.status(400).json({ error: "Unknown task: every game is written as code now (plan, code, fix or look)." });
}

/** The last turns of the chat, cleaned for the planner. */
function cleanHistory(history, max = 12) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-max)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 600) }));
}

/** A plan for a game the code builder will write: Muse Spark, a few seconds, not charged. */
async function plan(res, user, body) {
  const message = String(body.message || "").slice(0, 2000).trim();
  let image = typeof body.image === "string" && body.image ? body.image : null;
  if (image && !image.startsWith("data:")) image = "data:image/jpeg;base64," + image;
  if (image && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 2_000_000)) return res.status(400).json({ error: "The picture must be a JPEG, PNG or WebP under 1.5 MB." });
  if (!message && !image) return res.status(400).json({ error: "Say what game to plan." });
  try {
    const dimension = body.mode === "3d" ? "3d" : body.mode === "2d" ? "2d" : null;   // the Studio's 2D | 3D switch
    const out = await planGame({ message, image, dimension, previousPlan: body.plan && typeof body.plan === "object" ? body.plan : null, history: cleanHistory(body.history, 8) }, { timeoutMs: 50_000 });
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
const pick = (out) => ({ html: out.html, notes: out.notes, scan: out.scan, engine: out.engine, ms: out.ms, usage: out.usage, patch: out.patch || null });

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
      const assets = body.assets && typeof body.assets === "object" ? body.assets : {};
      const opts = { provider: c.provider, model: c.model || CODE_MODEL, timeoutMs: 270_000, onProgress: (p) => ev({ e: "progress", ...p }) };
      const out = previousHtml ? await changeGame({ plan: planIn, prompt, html: previousHtml, change, assets }, opts)   // patches first, the whole file if they do not fit
        : await generateGame({ plan: planIn, prompt, assets }, opts);
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
