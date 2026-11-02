// shared/inkart.js — "your drawing is the art": cut every object out of the picture the level came from.
// Classic script (window.InkArt). The level grid (1000 x 1000) covers the whole picture, so an object's box
// maps straight onto the image. Each crop keeps the pen strokes and turns the paper transparent.
// Crops with almost no ink (an object the chat added, or a box that missed the drawing) are skipped,
// and the game draws its usual shape for those.
window.InkArt = (() => {
  const ART_TYPES = new Set(["platform", "moving_platform", "coin", "enemy", "spike", "goal", "decoration"]);
  const PAD = 0.1;          // grow each box by 10% per side: the AI boxes are tight and strokes touch the edge
  const MIN_INK = 0.02;      // at least 2% of the crop must be ink
  const MIN_PX = 6;          // crops smaller than this (in picture pixels) are too blurry to use
  const SOURCE_SIDE = 720;   // pictures are brought to this long side first (PhotoUtil.THUMB_SIDE)

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image"));
      img.src = src;
    });
  }

  /** The padded box of an object, in grid units, clamped to the grid. Shared with the game so sprite and crop line up. */
  function paddedBox(o) {
    const px = o.w * PAD, py = o.h * PAD;
    const x0 = Math.max(0, o.x - px), y0 = Math.max(0, o.y - py);
    const x1 = Math.min(1000, o.x + o.w + px), y1 = Math.min(1000, o.y + o.h + py);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Brightness of the paper around this crop: a high percentile, so ink and shadows do not pull it down. */
  function paperLevel(d) {
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) { hist[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++; n++; }
    let acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.25) return Math.max(v, 60); }
    return 255;
  }

  /** Crop one box of the (720px) source and key out the paper. Ink inside any of the `exclude` grid boxes is dropped
   *  (an enemy standing on the ground must not carry the ground line along). Returns a canvas, or null when there
   *  is not enough ink. */
  function cut(img, box, exclude = []) {
    const W = img.width, H = img.height;
    const sx = Math.floor((box.x / 1000) * W), sy = Math.floor((box.y / 1000) * H);
    const sw = Math.ceil((box.w / 1000) * W), sh = Math.ceil((box.h / 1000) * H);
    if (sw < MIN_PX || sh < MIN_PX) return null;
    // Small crops are upscaled before keying so the edges stay smooth when the game stretches them.
    const k = Math.max(1, Math.min(4, 96 / Math.min(sw, sh)));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const d = data.data;
    const paper = paperLevel(d);
    const w = c.width, h = c.height, n = w * h;
    const alpha = new Float32Array(n), strong = new Uint8Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      const dark = (paper - lum) / paper;                       // 0 = paper, 1 = black
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max ? (max - min) / max : 0;                  // colored markers count even when light
      alpha[p] = Math.max(smooth(dark, 0.22, 0.45), sat > 0.4 ? smooth(dark, 0.06, 0.22) : 0);
      strong[p] = dark > 0.42 || (sat > 0.4 && dark > 0.15) ? 1 : 0;
    }
    // Printed notebook rules are thin (1px at 720) and light (darkness 0.25-0.38 on a real photo), pen strokes are
    // darker or thicker. Light ink only stays where it survives an opening of ~1 source pixel.
    const keep = open(alpha, w, h, Math.max(1, Math.round(k * 0.9)));
    // Excluded areas, as pixel rectangles of this crop.
    const ex = exclude.map((e) => ({
      x0: ((e.x - box.x) / box.w) * w, x1: ((e.x + e.w - box.x) / box.w) * w,
      y0: ((e.y - box.y) / box.h) * h, y1: ((e.y + e.h - box.y) / box.h) * h,
    })).filter((e) => e.x1 > 0 && e.x0 < w && e.y1 > 0 && e.y0 < h);
    let ink = 0, bottom = 0;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      let a = strong[p] ? alpha[p] : Math.min(alpha[p], keep[p]);
      if (a && ex.length) { const x = p % w, y = (p / w) | 0; if (ex.some((e) => x >= e.x0 && x < e.x1 && y >= e.y0 && y < e.y1)) a = 0; }
      if (a > 0.5) { ink++; bottom = (p / w) | 0; }
      // Deepen the strokes a little so pencil reads well on the game background.
      d[i] *= 0.75; d[i + 1] *= 0.75; d[i + 2] *= 0.75; d[i + 3] = Math.round(a * 255);
    }
    if (ink / n < MIN_INK) return null;
    ctx.putImageData(data, 0, 0);
    c.inkBottom = (bottom + 1) / h;          // lowest ink row, 0..1 of the crop: lets a walker stand on its feet
    return c;
  }
  const smooth = (v, lo, hi) => (v <= lo ? 0 : v >= hi ? 1 : (v - lo) / (hi - lo));

  /** Morphological opening with a square of radius r (separable min, then separable max), slightly dilated
   *  once more so stroke edges keep their soft alpha. */
  function open(a, w, h, r) {
    const pass = (src, fn, rad) => {
      const t = new Float32Array(src.length), o = new Float32Array(src.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = src[y * w + x];
        for (let dx = -rad; dx <= rad; dx++) { const xx = x + dx; if (xx >= 0 && xx < w) v = fn(v, src[y * w + xx]); }
        t[y * w + x] = v;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = t[y * w + x];
        for (let dy = -rad; dy <= rad; dy++) { const yy = y + dy; if (yy >= 0 && yy < h) v = fn(v, t[yy * w + x]); }
        o[y * w + x] = v;
      }
      return o;
    };
    return pass(pass(a, Math.min, r), Math.max, r + 1);
  }

  /**
   * Cut the art for a level. Returns { [objectIndex]: { canvas, box } } (box = padded grid box; canvas.inkBottom
   * = lowest ink row as a fraction of the height), or {} when
   * there is no picture or it cannot be read.
   */
  async function build(level, src) {
    if (!src || !Array.isArray(level?.objects)) return {};
    let photo;
    try { photo = await loadImage(src); } catch { return {}; }
    // Same scale for every source (Studio and phone pictures are 720px already), so the thresholds mean the same.
    const s = Math.min(1, SOURCE_SIDE / Math.max(photo.naturalWidth, photo.naturalHeight));
    const img = document.createElement("canvas");
    img.width = Math.round(photo.naturalWidth * s); img.height = Math.round(photo.naturalHeight * s);
    const ictx = img.getContext("2d"); ictx.imageSmoothingQuality = "high"; ictx.drawImage(photo, 0, 0, img.width, img.height);
    const out = {};
    const ground = level.objects.filter((o) => o.type === "platform");
    level.objects.forEach((o, i) => {
      if (!ART_TYPES.has(o.type) || !(o.w > 0 && o.h > 0)) return;
      const box = paddedBox(o);
      // Platform ink belongs to the platform: a walking enemy must not carry the ground line along, and an undrawn
      // flag standing on the ground must not "find" the ground line and wear it.
      const canvas = cut(img, box, o.type === "platform" ? [] : ground);
      if (canvas) out[i] = { canvas, box };
    });
    return out;
  }

  return { build, paddedBox, ART_TYPES };
})();
