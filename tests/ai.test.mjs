// Unit checks for lib/ai.mjs reply parsing (no network).  Run: npm test
import { messageText, stripReasoning, isConfigured, resolveProvider, describeEmptyReply } from "../lib/ai.mjs";

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 200) : ""}`);
  if (!cond) fails++;
}
const reply = (content, extra = {}) => ({ choices: [{ message: { role: "assistant", content, ...extra } }] });

check("plain string content", messageText(reply('{"ok":1}')) === '{"ok":1}');
check("array-of-parts content", messageText(reply([{ type: "text", text: "a" }, { type: "text", text: "b" }])) === "a\nb");
check("reasoning parts in arrays are dropped", messageText(reply([{ type: "reasoning", text: "hmm" }, { type: "text", text: "answer" }])) === "answer");
check("separate reasoning field is ignored", messageText(reply("final", { reasoning_content: "long thinking", reasoning: "more" })) === "final");
check("<think> block stripped", messageText(reply("<think>let me see... 1+1</think>\n{\"ok\":true}")) === '{"ok":true}');
check("<thinking> with attributes stripped", stripReasoning('<thinking budget="x">plan</thinking> result') === "result");
check("two think blocks stripped", stripReasoning("<think>a</think>x<think>b</think>y") === "xy");
check("unterminated think (cut off) leaves nothing after it", stripReasoning("<think>still thinking and the output was cut") === "");
check("text before an open think is kept", stripReasoning("answer first <think>then cut") === "answer first");
check("no tags -> unchanged", stripReasoning("  {\"a\":1}  ") === '{"a":1}');
check("empty / missing content", messageText({}) === "" && messageText(reply(null)) === "");
const cut = { choices: [{ finish_reason: "length", message: { role: "assistant", content: null, reasoning_content: "thinking..." } }] };
check("cut-off reasoning is explained", /cut off while reasoning/.test(describeEmptyReply(cut, "baseten")) && /raise max tokens/.test(describeEmptyReply(cut)));
check("plain empty reply is explained", describeEmptyReply(reply(""), "meta") === "meta returned an empty reply");

// provider config defaults (no network)
const saved = { ...process.env };
process.env.BASETEN_API_KEY = "k"; delete process.env.BASETEN_BASE_URL; delete process.env.BASETEN_MODEL;
const p = resolveProvider("baseten");
check("baseten defaults: model and chat URL", p.model === "meta-models/muse-spark-open-1026" && p.url === "https://inference.baseten.co/v1/chat/completions", { model: p.model, url: p.url });
process.env.BASETEN_BASE_URL = "https://x.example/v1/";
check("baseten URL with trailing slash", resolveProvider("baseten").url === "https://x.example/v1/chat/completions");
process.env.BASETEN_BASE_URL = "https://x.example/v1/chat/completions";
check("baseten URL already complete", resolveProvider("baseten").url === "https://x.example/v1/chat/completions");
delete process.env.BASETEN_API_KEY;
check("baseten not configured without key", isConfigured("baseten") === false);
process.env = saved;

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
