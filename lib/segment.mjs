// lib/segment.mjs — SAM 3.1 (Meta Model API) finds the subject of a picture: a box and a pixel mask to cut it out with.
// SERVER-SIDE ONLY (reads MODEL_API_KEY).
//   SAM 3.1 runs over the Responses API (POST /v1/responses, model sam-3.1, dev.meta.ai/docs/sam/overview): one user message
//   with an input_text prompt and an input_image (a data URL is accepted). The prompt is either a short noun phrase
//   ("red robot": every match comes back) or SAM's own box/point tokens ("<0f>1<|point;x=..;y=..;w=W;h=H|>": the object under
//   that point comes back under id 1). The answer is special-token text (dev.meta.ai/docs/sam/reading-segmentation), one line,
//   one record per object:
//     <0f>0<|box;x1=..;y1=..;x2=..;y2=..;w=W;h=H|><|mask;x=0;y=0;data=H,W,!payload|>,1<|box;...|><|mask;...|>
//   The box is in source pixels (x2/y2 inclusive, w/h the picture's size); the mask raster (height,width) covers the box
//   (scaled down past 1024 px). The payload is Meta's packed mask encoding ("!" one_bit, "~" lossless): the page decodes it
//   with Meta's @meta-sam/parser (shared/cutout.js), so this file only reads the grammar and picks the subject.

const MAX_SIDE = 8192;

/** SAM's output text -> [{ id, box: { x1, y1, x2, y2, w, h, c? }, mask: { height, width, encoding, payload } }]. Exported for tests. */
export function parseSegmentation(text) {
  const out = [];
  const re = /(\d+)<\|box;([^|]*)\|><\|mask;([^|]*?);data=(\d+),(\d+),(.)([^|]*)\|>/g;
  for (const m of String(text || "").matchAll(re)) {
    const f = fields(m[2]);
    const box = { x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2, w: f.w, h: f.h };
    if (Object.values(box).some((v) => !Number.isInteger(v) || v < 0) || box.x2 < box.x1 || box.y2 < box.y1 || box.x2 >= box.w || box.y2 >= box.h) continue;
    if (Number.isFinite(f.c)) box.c = f.c;
    const mask = { height: Number(m[4]), width: Number(m[5]), encoding: m[6] === "!" ? "one_bit" : "lossless", payload: m[6] + m[7] };
    if (!(mask.height > 0 && mask.width > 0) || !m[7]) continue;
    out.push({ id: Number(m[1]), box, mask });
  }
  return out;
}
function fields(s) { const o = {}; for (const part of String(s).split(";")) { const i = part.indexOf("="); if (i > 0) o[part.slice(0, i)] = Number(part.slice(i + 1)); } return o; }

/** The record most likely to be the subject: the biggest box, nudged towards the middle of the picture. Exported for tests. */
export function pickSubject(records) {
  let best = null, bestScore = -1;
  for (const r of records || []) {
    const b = r.box, area = (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1);
    const off = Math.hypot(((b.x1 + b.x2) / 2 - b.w / 2) / b.w, ((b.y1 + b.y2) / 2 - b.h / 2) / b.h);   // 0 at the middle, ~0.7 in a corner
    const score = area * (1 - 0.4 * Math.min(1, off));
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

/** A positive point prompt (the middle unless told otherwise): the object under it comes back under id 1. Exported for tests. */
export function pointPrompt(width, height, point) {
  const x = clampInt(point?.x, 0, width - 1, Math.floor(width / 2)), y = clampInt(point?.y, 0, height - 1, Math.floor(height / 2));
  return `<0f>1<|point;x=${x};y=${y};w=${width};h=${height}|>`;
}
const clampInt = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : dflt);

/** A name from the classifier -> a SAM concept prompt (a short noun phrase), or "" when there is nothing concrete to name. Exported for tests. */
export function conceptPhrase(name) {
  const s = String(name || "").toLowerCase().replace(/[^a-z0-9 '-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!s || /^(your |a |an |the )?(character|level|object|thing|picture|enemy|decoration|hero|player)$/.test(s)) return "";
  return s;
}

/**
 * The subject of a picture: tries the concept phrase first (when there is one), then a point in the middle.
 * Returns { box, mask, how: "phrase"|"point", phrase, matches, ms }. Errors carry .status (400 bad prompt, 429, 503...).
 */
export async function findSubject({ imageDataUrl, phrase = "", width, height, point, timeoutMs = 40_000 }) {
  const w = Number(width), h = Number(height);
  if (![w, h].every((v) => Number.isInteger(v) && v > 0 && v <= MAX_SIDE)) { const e = new Error("width and height must be the picture's pixel size."); e.status = 400; throw e; }
  const t0 = Date.now(), concept = conceptPhrase(phrase);
  let records = [], how = "";
  if (concept) { records = parseSegmentation(await segment(imageDataUrl, concept, timeoutMs)); how = "phrase"; }
  if (!records.length) { records = parseSegmentation(await segment(imageDataUrl, pointPrompt(w, h, point), timeoutMs)); how = "point"; }
  const best = pickSubject(records);
  if (!best) throw new Error("SAM 3.1 found nothing to cut out.");
  return { box: best.box, mask: best.mask, how, phrase: concept, matches: records.length, ms: Date.now() - t0 };
}

/** One SAM 3.1 call (non-streaming; one_bit masks, the smallest). Returns the output text. */
async function segment(imageDataUrl, text, timeoutMs) {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new Error("MODEL_API_KEY is not set.");
  const base = (process.env.MODEL_SAM_URL || process.env.MODEL_IMAGE_URL || "https://api.meta.ai/v1").replace(/\/+$/, "");
  const body = {
    model: process.env.MODEL_SAM_NAME || "sam-3.1",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: imageDataUrl }] }],
    metadata: { mask_encoding: "one_bit" },
  };
  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) {
    let code = ""; try { code = JSON.parse(raw)?.error?.code || ""; } catch {}
    const err = new Error(`SAM 3.1 error ${res.status}${code ? " " + code : ""}: ${raw.slice(0, 300)}`);
    err.status = res.status; err.code = code;
    throw err;
  }
  let data; try { data = JSON.parse(raw); } catch { throw new Error("SAM 3.1 returned non-JSON."); }
  return (data.output || []).flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("\n");
}
