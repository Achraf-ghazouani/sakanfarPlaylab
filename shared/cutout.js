// shared/cutout.js — a character or object picture -> a transparent sprite (window.Cutout).
// Two ways to find the background:
//   SAM 3.1 (api/art "cutout", lib/segment.mjs): the server sends back the subject's box and its pixel mask in Meta's packed
//     mask encoding; Meta's own @meta-sam/parser (loaded from the CDN on first use) decodes it into a 0/1 raster, which
//     becomes the picture's alpha. prepare() makes the copy that is sent, so the mask lands on the same pixel grid.
//   The free fill (no AI): the background is what touches the picture's border: a flood fill from every border pixel takes
//     in neighbours that stay close to the colour it started from (so soft gradients and photo backdrops go, outlines stop it).
// Pictures that are already transparent are only trimmed. The result is trimmed to the subject and scaled to SPRITE_H pixels
// tall, as a WebP (or PNG) data URL.
window.Cutout = (() => {
  const WORK = 512;          // keying runs on at most this many pixels per side
  const SEND_MAX = 1024;     // the longest side of the copy sent to SAM 3.1
  const SPRITE_H = 256;      // output height (the game shows it about 70 units tall)
  const NEAR_SEED = 52;      // max colour distance from the border colour a fill started from
  const NEAR_STEP = 24;      // max colour distance between neighbours inside one fill
  const PARSER_URL = "https://cdn.jsdelivr.net/npm/@meta-sam/parser@0.1.0/+esm";   // Meta's mask decoder (dev.meta.ai/docs/sam/client-libraries)
  let parser = null;
  const loadParser = () => (parser ||= import(PARSER_URL).catch((err) => { parser = null; throw err; }));

  function load(src) {
    return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("image")); i.src = src; });
  }
  const dist = (d, i, r, g, b) => Math.hypot(d[i] - r, d[i + 1] - g, d[i + 2] - b);

  /** The copy of a picture to send to SAM 3.1: at most SEND_MAX px on its longest side. @returns {Promise<{ src: string, width: number, height: number }>} */
  async function prepare(src) {
    const img = await load(src);
    const s = Math.min(1, SEND_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * s)), height = Math.max(1, Math.round(img.naturalHeight * s));
    const c = document.createElement("canvas"); c.width = width; c.height = height;
    const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high"; ctx.drawImage(img, 0, 0, width, height);
    const jpeg = /^data:image\/jpe?g/i.test(src);   // photos stay JPEG (small); drawings and anything with transparency stay PNG
    return { src: jpeg ? c.toDataURL("image/jpeg", 0.92) : c.toDataURL("image/png"), width, height };
  }

  /** SAM's 0/1 raster over the box becomes the alpha: outside the box goes, inside follows the mask (smoothed edges when scaled). */
  async function applyMask(ctx, W, H, { box, mask }) {
    const { decodeMaskToRaster } = await loadParser();
    const raster = decodeMaskToRaster({ encoding: mask.encoding, payload: mask.payload, width: mask.width, height: mask.height });
    const m = document.createElement("canvas"); m.width = mask.width; m.height = mask.height;
    const mx = m.getContext("2d"), md = mx.createImageData(mask.width, mask.height);
    for (let i = 0; i < raster.length; i++) md.data[i * 4 + 3] = raster[i] ? 255 : 0;
    mx.putImageData(md, 0, 0);
    const sx = W / box.w, sy = H / box.h;   // the box is in SAM's pixel grid (box.w x box.h), the work canvas shows the same picture at W x H
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(m, box.x1 * sx, box.y1 * sy, (box.x2 - box.x1 + 1) * sx, (box.y2 - box.y1 + 1) * sy);
    ctx.restore();
  }

  /**
   * @param {string} src  the picture (for opts.sam: the one prepare() returned, so the mask fits)
   * @param {{ sam?: { box, mask } }} opts  sam = the api/art cutout answer; without it, the free fill
   * @returns {Promise<{ src: string, keyed: boolean, how: "sam"|"fill"|"transparent"|"none" }>} keyed=false when the background could not be told apart
   */
  async function character(src, opts = {}) {
    const img = await load(src);
    const s = Math.min(1, WORK / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.max(1, Math.round(img.naturalWidth * s)), H = Math.max(1, Math.round(img.naturalHeight * s));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    let keyed = false, how = "none";

    if (opts.sam) {
      await applyMask(ctx, W, H, opts.sam);
      keyed = true; how = "sam";
    } else {
      const data = ctx.getImageData(0, 0, W, H), d = data.data, n = W * H;
      let clear = 0;
      for (let p = 0; p < n; p++) if (d[p * 4 + 3] < 20) clear++;
      keyed = clear > n * 0.05;            // already has a transparent background
      if (keyed) how = "transparent";
      else {
        const bg = new Uint8Array(n);
        const stack = [];
        const seed = (p) => { const i = p * 4; stack.push(p, d[i], d[i + 1], d[i + 2]); };
        for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
        for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
        while (stack.length) {
          const b = stack.pop(), g = stack.pop(), r = stack.pop(), p = stack.pop();
          if (bg[p]) continue;
          const i = p * 4;
          if (dist(d, i, r, g, b) > NEAR_SEED) continue;
          bg[p] = 1;
          const x = p % W, y = (p / W) | 0;
          const next = (q) => { if (!bg[q] && dist(d, q * 4, d[i], d[i + 1], d[i + 2]) <= NEAR_STEP) stack.push(q, r, g, b); };
          if (x > 0) next(p - 1); if (x < W - 1) next(p + 1); if (y > 0) next(p - W); if (y < H - 1) next(p + W);
        }
        let fg = 0;
        for (let p = 0; p < n; p++) if (!bg[p]) fg++;
        keyed = fg > n * 0.03 && fg < n * 0.97;
        if (keyed) {
          how = "fill";
          for (let p = 0; p < n; p++) {
            if (bg[p]) { d[p * 4 + 3] = 0; continue; }
            const x = p % W, y = (p / W) | 0;   // soften the first ring of the character's edge
            if ((x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) || (y > 0 && bg[p - W]) || (y < H - 1 && bg[p + W])) d[p * 4 + 3] = 170;
          }
          ctx.putImageData(data, 0, 0);
        }
      }
    }

    // trim to what is visible
    const d = ctx.getImageData(0, 0, W, H).data, n = W * H;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, seen = 0;
    for (let p = 0; p < n; p++) if (d[p * 4 + 3] > 20) { seen++; const x = p % W, y = (p / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (how === "sam" && seen < n * 0.005) throw new Error("the mask is empty");   // SAM kept nothing: let the caller fall back
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
    const tw = x1 - x0 + 1, th = y1 - y0 + 1;
    const k = Math.min(SPRITE_H / th, (SPRITE_H * 1.6) / tw);
    const o = document.createElement("canvas"); o.width = Math.max(1, Math.round(tw * k)); o.height = Math.max(1, Math.round(th * k));
    const ox = o.getContext("2d"); ox.imageSmoothingQuality = "high";
    ox.drawImage(c, x0, y0, tw, th, 0, 0, o.width, o.height);
    // WebP keeps the transparency at about a third of the PNG size (browsers that cannot encode WebP give PNG)
    return { src: o.toDataURL("image/webp", 0.92), keyed, how };
  }

  return { character, prepare };
})();
