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
    url: chatUrl(process.env.BASETEN_BASE_URL),
    key: process.env.BASETEN_API_KEY,
    model: process.env.BASETEN_MODEL,
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
    max_tokens: maxTokens,
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

  return { text: messageText(data), usage: data.usage, provider: p.name, model: p.model, ms: Date.now() - t0 };
}

/** Same as chat(), image required. */
export async function chatVision(opts) {
  if (!opts?.imageBase64) throw new Error("Missing image data.");
  return chat(opts);
}

/** Handles string content and array-of-parts content. */
function messageText(data) {
  const content = data?.choices?.[0]?.message?.content ?? data?.output_text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n");
  return String(content);
}
