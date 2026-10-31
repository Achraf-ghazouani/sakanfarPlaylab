// Live check of the game agent against the real Meta Model API (costs credits, needs MODEL_API_KEY in .env).
// Run: node tests/agent.live.mjs [--provider baseten]
try { process.loadEnvFile(".env"); } catch {}
import { runAgent } from "../lib/agent.mjs";

const provider = process.argv.includes("--provider") ? process.argv[process.argv.indexOf("--provider") + 1] : undefined;
let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 300) : ""}`); if (!cond) fails++; }
const count = (lvl, t) => lvl.objects.filter((o) => o.type === t).length;
const history = [];
let level = null;

async function turn(message) {
  const t0 = Date.now();
  const r = await runAgent({ message, level, history }, { provider });
  console.log(`\n> ${message}\n  ${r.meta?.provider || "-"} ${r.meta?.ms || 0} ms (${Date.now() - t0} total) kind=${r.kind || "reply"} note=${JSON.stringify(r.note || "")} objects=${r.level?.objects?.length ?? "-"} theme=${JSON.stringify(r.level?.theme || "")} fixed=${r.playtest?.fixed ?? 0} diff=${JSON.stringify(r.diff || "")}\n  reply: ${r.reply}`);
  history.push({ role: "user", content: message }, { role: "assistant", content: r.reply });
  if (r.level) level = r.level;
  return r;
}

const a = await turn("A lava castle with moving platforms");
check("create: a level with a lava theme", a.kind === "create" && a.level && /lava|castle/i.test(a.level.theme) && a.level.objects.length >= 6, { theme: a.level?.theme, n: a.level?.objects?.length });
check("create: has a moving platform", a.level && count(a.level, "moving_platform") >= 1);
check("create: one start, one goal", a.level && count(a.level, "start") === 1 && count(a.level, "goal") >= 1);
const before = { coins: count(level, "coin"), enemies: count(level, "enemy"), spikes: count(level, "spike"), n: level.objects.length };

const b = await turn("Make it harder");
check("harder: edit with more hazards", b.kind === "edit" && (count(b.level, "enemy") + count(b.level, "spike") > before.enemies + before.spikes || b.level.objects.length !== before.n), { enemies: count(b.level, "enemy"), spikes: count(b.level, "spike") });

const c = await turn("Add more coins");
check("coins: at least 2 more coins", c.kind === "edit" && count(c.level, "coin") >= count(b.level, "coin") + 2, { before: count(b.level, "coin"), after: count(c.level, "coin") });

const d = await turn("Change theme");
check("theme: a different theme, same layout size", d.kind === "edit" && d.level.theme !== c.level.theme && Math.abs(d.level.objects.length - c.level.objects.length) <= 2, { from: c.level.theme, to: d.level.theme });

const e = await turn("Is every coin reachable?");
check("question: playtest action or a text answer", (e.actions?.[0]?.type === "playtest") || (!e.level && e.reply.length > 0), { actions: e.actions, hasLevel: !!e.level });

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
