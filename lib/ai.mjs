// lib/ai.mjs — minimal client for OpenAI-compatible chat APIs with image input.
// SERVER-SIDE ONLY: reads API keys from process.env. Never import this from a page.
//
// Providers:
//   meta     Meta Model API (Muse Spark)      MODEL_API_KEY, MODEL_API_URL?, MODEL_NAME?
//   baseten  Baseten (OpenAI-compatible)      BASETEN_API_KEY, BASETEN_BASE_URL, BASETEN_MODEL
// AI_PROVIDER picks the default (meta). If the default fails and the other one is configured,
// scanLevelFromImage() falls back to it.

const PROVIDERS = {
  meta: () => ({
    name: "meta",
    url: process.env.MODEL_API_URL || "https://api.meta.ai/v1/chat/completions",
    key: process.env.MODEL_API_KEY,
    model: process.env.MODEL_NAME || "muse-spark-1.3",
  }),
  baseten: () => ({
    name: "baseten",
    url: chatUrl(process.env.BASETEN_BASE_URL || "https://inference.baseten.co/v1"),
    key: process.env.BASETEN_API_KEY,
    model: process.env.BASETEN_MODEL || "meta-models/muse-spark-open-1026",
  }),
};

/** BASETEN_BASE_URL may be ".../v1", ".../v1/" or already end in /chat/completions. */
function chatUrl(base) {
  if (!base) return "";
  const b = base.replace(/\/+$/, "");
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
}

export function defaultProviderName() {
  return (process.env.AI_PROVIDER || "meta").toLowerCase();
}

/** True when the provider has everything it needs in env. */
export function isConfigured(name) {
  const p = PROVIDERS[name]?.();
  return !!(p && p.url && p.key && p.model);
}

export function resolveProvider(name = defaultProviderName()) {
  const make = PROVIDERS[name];
  if (!make) throw new Error(`Unknown AI provider "${name}" (use meta or baseten).`);
  const p = make();
  if (!p.key) throw new Error(`Provider "${name}" has no API key. Set ${name === "meta" ? "MODEL_API_KEY" : "BASETEN_API_KEY"} in .env.`);
  if (!p.url || !p.model) throw new Error(`Provider "${name}" is missing its URL or model name in .env.`);
  return p;
}

/**
 * One chat completion with a system prompt, a user prompt and optionally one image.
 * @returns {Promise<{text: string, usage?: object, provider: string, model: string, ms: number}>}
 */
export async function chat({ provider, system, prompt, imageBase64, mime = "image/jpeg", temperature = 0.2, maxTokens = 3000, timeoutMs = 90_000, reasoningEffort }) {
  const p = typeof provider === "string" || provider == null ? resolveProvider(provider ?? undefined) : provider;

  const userContent = imageBase64
    ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${mime};base64,${imageBase64}` } }]
    : prompt;
  const body = {
    model: p.model,
    temperature,
    // Reasoning tokens count against max_tokens. The Baseten model always reasons at length, so give it room
    // or it burns the whole budget thinking and returns empty content.
    max_tokens: Math.max(maxTokens, p.name === "baseten" ? 8000 : 0),
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  };
  // Muse Spark supports reasoning_effort: minimal | low | medium | high | xhigh | max. Other providers may not.
  if (reasoningEffort && p.name === "meta") body.reasoning_effort = reasoningEffort;

  const t0 = Date.now();
  const res = await fetch(p.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${p.name} API error ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${p.name} API returned non-JSON: ${text.slice(0, 200)}`); }

  const answer = messageText(data);
  if (!answer) throw new Error(describeEmptyReply(data, p.name));
  return { text: answer, usage: data.usage, provider: p.name, model: p.model, ms: Date.now() - t0 };
}

/** Why did a reply have no answer text? (exported for tests) */
export function describeEmptyReply(data, providerName = "model") {
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  const reasoned = !!(msg.reasoning_content || msg.reasoning);
  if (choice?.finish_reason === "length" || reasoned) return `${providerName} reply was cut off while reasoning (finish_reason=${choice?.finish_reason ?? "?"}); raise max tokens`;
  return `${providerName} returned an empty reply`;
}

/** Same as chat(), image required. */
export async function chatVision(opts) {
  if (!opts?.imageBase64) throw new Error("Missing image data.");
  return chat(opts);
}

/**
 * The final answer text of a chat completion, without any reasoning.
 * Handles string content, array-of-parts content, and reasoning models that either put their
 * thinking in a separate field (reasoning / reasoning_content, ignored) or inline it in
 * <think>...</think> tags (stripped).
 */
export function messageText(data) {
  const msg = data?.choices?.[0]?.message;
  let content = msg?.content ?? data?.output_text ?? "";
  if (Array.isArray(content)) content = content.filter((p) => !p || p.type !== "reasoning").map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n");
  return stripReasoning(String(content ?? ""));
}

/** Remove <think>/<thinking>/<reasoning> blocks (closed or left open) and return what is left. */
export function stripReasoning(text) {
  let t = String(text);
  t = t.replace(/<(think|thinking|reasoning|reason)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // An unterminated think block (cut off by max_tokens) has no answer after it: keep only what came before.
  t = t.replace(/<(think|thinking|reasoning|reason)\b[^>]*>[\s\S]*$/i, "");
  return t.trim();
}
