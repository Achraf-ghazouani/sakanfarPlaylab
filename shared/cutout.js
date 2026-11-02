// shared/cutout.js — a character picture -> a transparent sprite for the player (window.Cutout).
// The background is what touches the picture's border: a flood fill from every border pixel takes in neighbours
// that stay close to the colour it started from (so soft gradients and photo backdrops go, outlines stop it).
// Pictures that are already transparent are only trimmed. The result is trimmed to the character and scaled
// to SPRITE_H pixels tall, as a WebP (or PNG) data URL.
window.Cutout = (() => {
  const WORK = 512;          // keying runs on at most this many pixels per side
  const SPRITE_H = 256;      // output height (the game shows it about 70 units tall)
  const NEAR_SEED = 52;      // max colour distance from the border colour a fill started from
  const NEAR_STEP = 24;      // max colour distance between neighbours inside one fill

  function load(src) {
    return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("image")); i.src = src; });
  }
  const dist = (d, i, r, g, b) => Math.hypot(d[i] - r, d[i + 1] - g, d[i + 2] - b);

  /** @returns {Promise<{ src: string, keyed: boolean }>} keyed=false when the background could not be told apart */
  async function character(src) {
    const img = await load(src);
    const s = Math.min(1, WORK / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.max(1, Math.round(img.naturalWidth * s)), H = Math.max(1, Math.round(img.naturalHeight * s));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H), d = data.data, n = W * H;

    let clear = 0;
    for (let p = 0; p < n; p++) if (d[p * 4 + 3] < 20) clear++;
    let keyed = clear > n * 0.05;            // already has a transparent background
    if (!keyed) {
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
        for (let p = 0; p < n; p++) {
          if (bg[p]) { d[p * 4 + 3] = 0; continue; }
          const x = p % W, y = (p / W) | 0;   // soften the first ring of the character's edge
          if ((x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) || (y > 0 && bg[p - W]) || (y < H - 1 && bg[p + W])) d[p * 4 + 3] = 170;
        }
        ctx.putImageData(data, 0, 0);
      }
    }

    // trim to what is visible
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let p = 0; p < n; p++) if (d[p * 4 + 3] > 20) { const x = p % W, y = (p / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
    const tw = x1 - x0 + 1, th = y1 - y0 + 1;
    const k = Math.min(SPRITE_H / th, (SPRITE_H * 1.6) / tw);
    const o = document.createElement("canvas"); o.width = Math.max(1, Math.round(tw * k)); o.height = Math.max(1, Math.round(th * k));
    const ox = o.getContext("2d"); ox.imageSmoothingQuality = "high";
    ox.drawImage(c, x0, y0, tw, th, 0, 0, o.width, o.height);
    // WebP keeps the transparency at about a third of the PNG size (browsers that cannot encode WebP give PNG)
  return { src: o.toDataURL("image/webp", 0.92), keyed };
  }

  return { character };
})();
