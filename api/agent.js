// api/agent.js — the studio game agent endpoint.
// Step 1 (this version): understands a few built-in actions and answers the rest with a short, honest reply
// so the chat loop, projects and versions can be exercised end to end. Step 2 puts Muse Spark behind it
// with create_level / edit_level tools.
//   POST { project_id, message, level?, attachments? } -> { reply, actions: [...], level? }
// Actions the page already knows how to run itself: "scan" (an attached image), "playtest" (reachability + AI fix).

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const body = typeof req.body === "string" ? safeJson(req.body) : (req.body || {});
  const text = String(body.message || "").trim();
  const hasLevel = !!(body.level && Array.isArray(body.level.objects));
  const hasImage = Array.isArray(body.attachments) && body.attachments.some((a) => a && String(a.type || "").startsWith("image/"));
  const lower = text.toLowerCase();

  if (hasImage) return res.status(200).json({ reply: "Got your picture. I am reading it as a level now.", actions: [{ type: "scan" }] });
  if (/playtest|reachable|fix/.test(lower)) {
    if (!hasLevel) return res.status(200).json({ reply: "There is no level yet. Describe one, or attach a drawing, and I will playtest it.", actions: [] });
    return res.status(200).json({ reply: "Running the playtest agent: checking every jump and fixing what is impossible.", actions: [{ type: "playtest" }] });
  }
  if (/share/.test(lower)) return res.status(200).json({ reply: "Sharing links arrive in a later step. For now, use the Share button in the top bar once it is enabled.", actions: [] });
  if (/3d/.test(lower)) return res.status(200).json({ reply: "3D modes (side view and world) are coming in a later step. The 2D game is live in the preview.", actions: [] });
  if (/art|generate/.test(lower)) return res.status(200).json({ reply: "Art generation with Muse Image and SAM cut-outs comes in a later step. The notebook style stays for now.", actions: [] });
  if (!text) return res.status(200).json({ reply: "Tell me what to build, or attach a drawing.", actions: [] });

  // No designer brain yet: say so clearly instead of pretending.
  const reply = hasLevel
    ? `I heard: "${text.slice(0, 120)}". Editing levels by chat lands in the next step. Until then you can attach a drawing, ask me to playtest, or pick a version from History.`
    : `I heard: "${text.slice(0, 120)}". Building levels from words lands in the next step. Attach a drawing or a picture and I will turn it into a level right now.`;
  return res.status(200).json({ reply, actions: [] });
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
