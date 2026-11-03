// Unit checks for lib/agent.mjs with a fake model (no network).  Run: npm test
import { runAgent, TOOLS, cleanHistory, systemPrompt, quickReply, BRIEF } from "../lib/agent.mjs";
check("the brief asks for the person's language and keeps the level JSON in English", /language the person writes in/.test(BRIEF) && /French in, French out/.test(BRIEF) && /stay in English/.test(BRIEF));

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`);
  if (!cond) fails++;
}
const saved = { ...process.env };
process.env.MODEL_API_KEY = "test-key"; delete process.env.BASETEN_API_KEY; delete process.env.AI_PROVIDER;

const ground = { type: "platform", label: "ground", x: 0, y: 900, w: 1000, h: 60 };
const start = { type: "start", label: "hero", x: 40, y: 840, w: 40, h: 60 };
const goal = { type: "goal", label: "flag", x: 900, y: 840, w: 40, h: 60 };
const base = { theme: "meadow", aspect: 1.5, objects: [ground, start, goal] };
const toolReply = (name, args, content = "Sure thing.") => ({ content, toolCalls: [{ id: "call_1", type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }], finishReason: "tool_calls", provider: "meta", model: "muse-spark-1.3", ms: 7, usage: { total_tokens: 10 } });
const textReply = (content) => ({ content, toolCalls: [], finishReason: "stop", provider: "meta", model: "muse-spark-1.3", ms: 3 });
let calls = [];
const fake = (reply) => async (opts) => { calls.push(opts); return typeof reply === "function" ? reply(opts) : reply; };

// tools
check("five tools with the right names", TOOLS.map((t) => t.function.name).join() === "create_level,edit_level,create_arena,edit_arena,playtest_level" && TOOLS.every((t) => t.type === "function" && t.function.parameters.type === "object"));

// 1. create: a level with an impossible ledge gets quick-fixed, aspect defaults to 4:3
calls = [];
const created = await runAgent({ message: "A desert level with a high ledge" }, {
  complete: fake(toolReply("create_level", { theme: "desert dunes", note: "desert, one high ledge", objects: [ground, start, goal, { type: "platform", label: "high ledge", x: 400, y: 300, w: 200, h: 30 }, { type: "coin", label: "gem", x: 480, y: 240, w: 30, h: 30 }, { type: "enemy", label: "scorpion", x: 600, y: 850, w: 40, h: 50 }] })),
});
check("create returns a level", created.kind === "create" && created.level?.objects?.length >= 6, { kind: created.kind, n: created.level?.objects?.length });
check("note and theme kept", created.note === "desert, one high ledge" && created.level.theme === "desert dunes");
check("new level uses 4:3", Math.abs(created.level.aspect - 1.333) < 0.01, created.level.aspect);
check("impossible ledge patched by the quick fix", created.playtest.fixed >= 1 && created.level.objects.length > 6 && /patched/.test(created.reply), { fixed: created.playtest.fixed, reply: created.reply });
check("reply starts with the model text", created.reply.startsWith("Sure thing."));
check("tools sent, one call per turn, low effort", calls[0].tools === TOOLS && calls[0].parallelToolCalls === false && calls[0].reasoningEffort === "low" && calls[0].provider === "meta");
check("system prompt says there is no game yet", /no game yet/.test(calls[0].messages[0].content) && calls[0].messages[0].role === "system");
check("user message is last", calls[0].messages.at(-1).role === "user" && calls[0].messages.at(-1).content === "A desert level with a high ledge");
check("meta provider reported", created.meta.provider === "meta" && created.meta.fallback === false);

// 2. edit: keeps the previous aspect, reports a diff
calls = [];
const edited = await runAgent({ message: "Add more coins", level: base }, {
  complete: fake(toolReply("edit_level", { theme: "meadow", note: "two more coins", objects: [...base.objects, { type: "coin", label: "coin", x: 300, y: 820, w: 30, h: 30 }, { type: "coin", label: "coin", x: 500, y: 820, w: 30, h: 30 }] })),
});
check("edit returns the edited level", edited.kind === "edit" && edited.level.objects.length === 5 && edited.note === "two more coins");
check("edit keeps the previous aspect", edited.level.aspect === 1.5, edited.level.aspect);
check("edit carries a short diff", typeof edited.diff === "string" && edited.diff.length > 0, edited.diff);
check("system prompt carries the current level", /CURRENT GAME: a 2D PLATFORMER/.test(calls[0].messages[0].content) && /"ground"/.test(calls[0].messages[0].content));
check("edit with no level becomes a create", (await runAgent({ message: "x" }, { complete: fake(toolReply("edit_level", { theme: "t", note: "n", objects: [ground, start, goal] })) })).kind === "create");

// 3. history: trimmed to 12 user/assistant turns, tool cards dropped
calls = [];
const hist = []; for (let i = 0; i < 20; i++) hist.push({ role: i % 3 === 0 ? "tool" : i % 2 ? "assistant" : "user", content: "turn " + i + " " + "x".repeat(700) });
await runAgent({ message: "hi", history: hist }, { complete: fake(textReply("Hello!")) });
const sent = calls[0].messages;
check("history trimmed and cleaned", sent.length <= 14 && sent.slice(1, -1).every((m) => (m.role === "user" || m.role === "assistant") && m.content.length <= 600), sent.length);
check("cleanHistory drops empty and tool messages", cleanHistory([{ role: "tool", content: "a" }, { role: "user", content: "  " }, { role: "assistant", content: "ok" }]).length === 1);

// 4. playtest tool -> page action; without a level -> explanation
check("playtest tool becomes a page action", JSON.stringify((await runAgent({ message: "Playtest it", level: base }, { complete: fake(toolReply("playtest_level", {}, "On it.")) })).actions) === '[{"type":"playtest"}]');
const noLevel = await runAgent({ message: "Playtest it" }, { complete: fake(toolReply("playtest_level", {})) });
check("playtest without a level explains", noLevel.actions.length === 0 && /no game yet/.test(noLevel.reply));

// 5. plain text answer
const chat = await runAgent({ message: "What can you do?", level: base }, { complete: fake(textReply("I build platformer levels.")) });
check("text reply, no level", chat.reply === "I build platformer levels." && !chat.level && chat.actions.length === 0);

// 6. bad arguments never throw
const bad = await runAgent({ message: "x" }, { complete: fake(toolReply("create_level", "{not json", "Hmm.")) });
check("invalid JSON arguments -> graceful reply", !bad.level && /could not put that level together/.test(bad.reply) && bad.error === "bad tool arguments");
const few = await runAgent({ message: "x" }, { complete: fake(toolReply("create_level", { theme: "t", note: "n", objects: [ground] })) });
check("too few objects -> graceful reply", !few.level && /could not/.test(few.reply));
const garbage = await runAgent({ message: "x", level: base }, { complete: fake(toolReply("edit_level", { theme: 5, note: null, objects: [{ type: "what", x: "a" }, null, { type: "coin", x: 5000, y: -5, w: 1, h: 1 }] })) });
check("garbage objects are normalized, not fatal", garbage.level && garbage.level.objects.every((o) => o.x >= 0 && o.x <= 1000), garbage.level?.objects?.length);

// 7. quick replies without a model call
calls = [];
for (const [msg, re] of [["Make it 3D", /3D view/], ["switch to 2d", /2D view/], ["Generate art", /Muse Image draws it/], ["Share", /later step/], ["", /Tell me what to build/]]) {
  const r = await runAgent({ message: msg, level: base }, { complete: fake(textReply("should not be called")) });
  check(`quick reply for "${msg || "(empty)"}"`, re.test(r.reply), r.reply);
}
check("quick replies made no model call", calls.length === 0);
check("image attachment -> scan action", JSON.stringify(quickReply("look", false, [{ type: "image/jpeg" }]).actions) === '[{"type":"scan"}]');
check("normal prompt -> no quick reply", quickReply("a lava level", false, []) === null);

// 8. fallback to Baseten with the JSON protocol when Meta fails
process.env.BASETEN_API_KEY = "b";
calls = [];
const fb = await runAgent({ message: "An ice level" }, {
  complete: fake((opts) => {
    if (opts.provider === "meta") { const e = new Error("meta API error 503: down"); e.status = 503; throw e; }
    return { content: '<think>hmm</think>{"tool":"create_level","reply":"Here is an ice world.","theme":"ice world","note":"ice world, 2 ledges","objects":' + JSON.stringify([ground, start, goal, { type: "platform", label: "ice ledge", x: 300, y: 760, w: 200, h: 30 }]) + "}", toolCalls: [], provider: "baseten", model: "meta-models/muse-spark-open-1026", ms: 9 };
  }),
});
check("falls back to baseten with JSON", fb.level?.objects?.length === 4 && fb.meta.provider === "baseten" && fb.meta.fallback === true && fb.reply.startsWith("Here is an ice world."), { n: fb.level?.objects?.length, meta: fb.meta });
check("baseten call has no tools and a JSON brief", calls[1].provider === "baseten" && !calls[1].tools && /ONE JSON object/.test(calls[1].messages[0].content));
check("json protocol 'none' is a text reply", (await runAgent({ message: "hi" }, { provider: "baseten", complete: fake({ content: '{"tool":"none","reply":"Hey!"}', toolCalls: [], model: "m", ms: 1 }) })).reply === "Hey!");
delete process.env.BASETEN_API_KEY;

// 9. no fallback configured -> the error surfaces
let threw = null;
try { await runAgent({ message: "x" }, { complete: fake(() => { throw new Error("meta API error 500"); }) }); } catch (e) { threw = e; }
check("meta failure without fallback throws", !!threw && /500/.test(threw.message));

check("systemPrompt json flag adds the protocol", /ONE JSON object/.test(systemPrompt(null, { json: true })) && !/ONE JSON object/.test(systemPrompt(null)));

process.env = saved;
// 9. arena shooter: the model's create_arena becomes a checked arena with the 3D genre
calls = [];
const arenaArgs = { view: "fps", theme: "zombie graveyard", note: "graveyard, 5 waves", waves: 5, objects: [
  { type: "start", label: "you", x: 480, y: 480, w: 40, h: 40 }, { type: "spawner", label: "zombie gate", x: 40, y: 40, w: 40, h: 40 }, { type: "spawner", label: "zombie gate", x: 900, y: 900, w: 40, h: 40 },
  { type: "wall", label: "crypt wall", x: 300, y: 200, w: 300, h: 40 }, { type: "prop", label: "tombstone", x: 600, y: 600, w: 40, h: 40 }, { type: "ammo", label: "ammo box", x: 200, y: 700, w: 30, h: 30 }, { type: "health", label: "medkit", x: 800, y: 300, w: 30, h: 30 },
] };
const arena = await runAgent({ message: "create a first person shooter with zombie waves" }, { complete: fake(toolReply("create_arena", arenaArgs, "Zombies incoming!")) });
check("create_arena returns an arena", arena.kind === "create" && arena.level?.genre === "arena" && arena.level.view === "fps" && arena.level.waves === 5 && arena.level.objects.length === 7 && arena.level.checked === true, { genre: arena.level?.genre, view: arena.level?.view, n: arena.level?.objects?.length });
check("arena reply and note", arena.reply.startsWith("Zombies incoming!") && arena.note === "graveyard, 5 waves");
check("the brief names both kinds and when to pick them", /ARENA SHOOTER/.test(calls[0].messages[0].content) && /never a platformer/.test(calls[0].messages[0].content));
check("the brief carries the game design knowledge (teach-test-twist, enemy kinds, honest about missing features)", /GAME DESIGN KNOWLEDGE/.test(calls[0].messages[0].content) && /Teach, then test, then twist/.test(calls[0].messages[0].content) && /"brute" gate/.test(calls[0].messages[0].content) && /Never promise a feature/.test(calls[0].messages[0].content));

// 10. the genre guard: the model answered a shooter request with a platformer -> an arena is generated from the words
calls = [];
const guarded = await runAgent({ message: "crtrate first persone shooter game that zoot zombie waves" }, { complete: fake(toolReply("create_level", { theme: "zombie shootout", note: "zombie waves starter level", objects: [ground, start, goal] }, "Got it: turning your zombie shooter idea into a 2D survivor run!")) });
check("a shooter request never becomes a platformer", guarded.level?.genre === "arena" && guarded.kind === "create" && guarded.guard === "arena" && guarded.level.view === "fps" && /zombie/.test(guarded.level.theme), { genre: guarded.level?.genre, view: guarded.level?.view, theme: guarded.level?.theme });
check("the guarded reply does not promise a 2D run", !/2D|survivor run/.test(guarded.reply) && /first-person shooter/.test(guarded.reply), guarded.reply);
check("a platformer request still builds a platformer", (await runAgent({ message: "a jungle platformer with coins" }, { complete: fake(toolReply("create_level", { theme: "jungle", note: "jungle", objects: [ground, start, goal] })) })).level?.genre === undefined);

// 11. editing an arena: the current arena is in the brief, the diff is in words, the view can change
calls = [];
const arenaEdit = await runAgent({ message: "more waves and switch to top down", level: arena.level, history: [] }, { complete: fake(toolReply("edit_arena", { ...arenaArgs, view: "top", waves: 8, note: "harder: 8 waves, top-down", objects: [...arenaArgs.objects, { type: "spawner", label: "zombie gate", x: 900, y: 40, w: 40, h: 40 }] })) });
check("arena edit keeps the genre, changes view and waves", arenaEdit.kind === "edit" && arenaEdit.level.genre === "arena" && arenaEdit.level.view === "top" && arenaEdit.level.waves === 8 && /\+1 spawner/.test(arenaEdit.diff) && /view top/.test(arenaEdit.diff) && /8 waves/.test(arenaEdit.diff), { diff: arenaEdit.diff });
check("the brief carries the current arena", /CURRENT GAME: a 3D ARENA SHOOTER/.test(calls[0].messages[0].content) && /edit_arena/.test(calls[0].messages[0].content));

// 12. arena playtest runs in the server, no action: a walled-off gate is fixed
const walled = { ...arena.level, objects: [...arena.level.objects, { type: "wall", label: "n", x: 820, y: 820, w: 180, h: 40 }, { type: "wall", label: "w", x: 820, y: 820, w: 40, h: 180 }] };
const pt = await runAgent({ message: "playtest it", level: walled }, { complete: fake(toolReply("playtest_level", {})) });
check("arena playtest fixes the walled-off gate without an action", pt.kind === "edit" && pt.playtest.fixed === 1 && pt.level.genre === "arena" && pt.actions.length === 0 && /walled off/.test(pt.reply), { reply: pt.reply, fixes: pt.playtest.fixes });
check("a fine arena is just confirmed", (await runAgent({ message: "playtest it", level: arena.level }, { complete: fake(toolReply("playtest_level", {})) })).playtest?.ok === true);

// 13. view switches on an arena are free
check("\"switch to third person\" on an arena is a free view action", JSON.stringify((await runAgent({ message: "switch to third person", level: arena.level }, { complete: fake(textReply("x")) })).actions) === JSON.stringify([{ type: "view", view: "tps" }]));
check("\"make it 2D\" on an arena explains, no action", /3D games/.test((await runAgent({ message: "make it 2D", level: arena.level }, { complete: fake(textReply("x")) })).reply));

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
