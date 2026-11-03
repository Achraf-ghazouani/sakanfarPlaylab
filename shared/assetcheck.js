// shared/assetcheck.js — cheap local checks on an uploaded picture, before (or instead of) asking Muse Spark (window.AssetCheck).
// Looks at the pixels only: transparency, size and aspect, a grid of cells (sprite sheet, tileset, font sheet), a straight
// frame border (panel, button), paper with dark strokes (a level drawing), a wide opaque scene (background). Returns the facts
// and a guess { role, confidence, why }; a confident guess (>= SURE) saves the classify credit, anything else goes to the model
// with the facts as hints. Roles are the ones lib/image.mjs knows: level, player, enemy, collectible, hazard, goal, texture,
// tileset, spritesheet, background, decoration, ui_button, ui_panel, ui_hud, ui_icon, ui_logo, ui_cursor, ui_font, ui_mockup.
window.AssetCheck = (() => {
  const WORK = 256;        // pixel analysis runs on at most this many pixels per side
  const SURE = 0.8;        // a local guess at or above this skips Muse Spark

  function load(src) {
    return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("image")); i.src = src; });
  }

  /** Runs of "filled" entries in a 0/1 line -> [{ start, end }] (end exclusive). */
  function runs(line) {
    const out = []; let start = -1;
    for (let i = 0; i <= line.length; i++) {
      const on = i < line.length && line[i];
      if (on && start < 0) start = i;
      if (!on && start >= 0) { out.push({ start, end: i }); start = -1; }
    }
    return out;
  }
  /** A grid of cells separated by clear gutters: cells of about the same size, 2 or more in a direction. */
  function gridOf(colFilled, rowFilled) {
    const cols = runs(colFilled), rows = runs(rowFilled);
    const similar = (rs) => { if (rs.length < 2) return false; const ws = rs.map((r) => r.end - r.start), m = ws.reduce((a, b) => a + b, 0) / ws.length; return ws.every((w) => Math.abs(w - m) <= Math.max(3, m * 0.35)); };
    const cs = similar(cols), rsim = similar(rows);
    if (!cs && !rsim) return null;
    return { cols: cs ? cols.length : 1, rows: rsim ? rows.length : 1, cellW: cols.length ? Math.round(cols.reduce((a, r) => a + r.end - r.start, 0) / cols.length) : 0, cellH: rows.length ? Math.round(rows.reduce((a, r) => a + r.end - r.start, 0) / rows.length) : 0 };
  }

  /**
   * @param {string} src a data URL or an image URL
   * @returns {Promise<{ width, height, aspect, transparent, clear, grid, frame, paper, colors, ink, guess: { role, confidence, why }, sure }>}
   */
  async function inspect(src) {
    const img = await load(src);
    const width = img.naturalWidth, height = img.naturalHeight, aspect = width / Math.max(1, height);
    const s = Math.min(1, WORK / Math.max(width, height));
    const W = Math.max(1, Math.round(width * s)), H = Math.max(1, Math.round(height * s));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data, n = W * H;

    // transparency, luminance, saturation, distinct colours, dark strokes
    let clear = 0, lumSum = 0, satSum = 0, dark = 0, opaque = 0;
    const colFilled = new Uint8Array(W), rowFilled = new Uint8Array(H), colors = new Set();
    for (let p = 0; p < n; p++) {
      const i = p * 4, a = d[i + 3];
      if (a < 20) { clear++; continue; }
      opaque++;
      const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), lum = 0.299 * r + 0.587 * g + 0.114 * b;
      lumSum += lum; satSum += mx ? (mx - mn) / mx : 0;
      if (lum < 90) dark++;
      colFilled[p % W] = 1; rowFilled[(p / W) | 0] = 1;
      if ((p & 3) === 0) colors.add(((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5));   // 512 bins, every 4th pixel
    }
    const clearShare = clear / n, transparent = clearShare > 0.05, lum = opaque ? lumSum / opaque : 0, sat = opaque ? satSum / opaque : 0, ink = opaque ? dark / opaque : 0;
    const grid = transparent ? gridOf(colFilled, rowFilled) : null;
    const cells = grid ? grid.cols * grid.rows : 0;

    // a frame: the outer ring is opaque and one colour, the inside is different (a panel or a button)
    let frame = false;
    if (clearShare < 0.4) {
      const ring = Math.max(2, Math.round(Math.min(W, H) * 0.025)), rs = [];   // thin: inside a panel's border
      let ringOpaque = 0, ringN = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const onRing = x < ring || y < ring || x >= W - ring || y >= H - ring;
        if (!onRing) continue;
        ringN++; const i = (y * W + x) * 4;
        if (d[i + 3] >= 20) { ringOpaque++; rs.push(d[i], d[i + 1], d[i + 2]); }
      }
      if (ringOpaque > ringN * 0.75) {
        const m = [0, 1, 2].map((k) => { let t = 0; for (let j = k; j < rs.length; j += 3) t += rs[j]; return t / (rs.length / 3); });
        let v = 0; for (let j = 0; j < rs.length; j += 3) v += Math.abs(rs[j] - m[0]) + Math.abs(rs[j + 1] - m[1]) + Math.abs(rs[j + 2] - m[2]);
        const spread = v / (rs.length / 3);
        const cx = (W / 2) | 0, cy = (H / 2) | 0, ci = (cy * W + cx) * 4;
        const centerDiff = Math.abs(d[ci] - m[0]) + Math.abs(d[ci + 1] - m[1]) + Math.abs(d[ci + 2] - m[2]);
        // a border is a thin stripe: its colour must be a minority of the picture (a white page around a drawing is not a frame)
        let same = 0; for (let p = 0; p < n; p++) { const i = p * 4; if (d[i + 3] >= 20 && Math.abs(d[i] - m[0]) + Math.abs(d[i + 1] - m[1]) + Math.abs(d[i + 2] - m[2]) < 60) same++; }
        frame = spread < 60 && centerDiff > 40 && same < opaque * 0.45;
      }
    }
    const paper = !transparent && lum > 165 && sat < 0.25 && ink > 0.005 && ink < 0.3 && colors.size < 60;

    // the guess, most certain first
    let guess;
    if (grid && cells >= 20 && colors.size <= 4) guess = { role: "ui_font", confidence: 0.8, why: `${grid.cols} x ${grid.rows} cells in one colour` };
    else if (grid && cells >= 6 && grid.cellW && Math.abs(grid.cellW - grid.cellH) <= Math.max(2, grid.cellW * 0.15) && clearShare < 0.45) guess = { role: "tileset", confidence: 0.85, why: `${grid.cols} x ${grid.rows} square cells` };
    else if (grid && (grid.cols >= 3 || cells >= 4)) guess = grid.rows === 1 && colors.size <= 4 ? { role: "ui_logo", confidence: 0.5, why: "a row of same-size shapes in one colour" } : { role: "spritesheet", confidence: 0.85, why: `${grid.cols} x ${grid.rows} frames` };
    else if (paper) guess = { role: "level", confidence: 0.85, why: "paper with pen strokes" };
    else if (frame && aspect >= 1.8 && aspect <= 7 && height <= 200) guess = { role: "ui_button", confidence: 0.8, why: "a wide framed shape" };
    else if (frame && aspect >= 0.4 && aspect <= 2.5 && Math.min(width, height) >= 100) guess = { role: "ui_panel", confidence: 0.8, why: "a framed box" };
    else if (!transparent && aspect >= 1.3 && width >= 480 && colors.size >= 24) guess = { role: "background", confidence: 0.6, why: "a wide full scene" };   // a photo of a drawing can look like this: let the model confirm
    else if (transparent && Math.max(width, height) <= 160 && aspect >= 0.85 && aspect <= 1.2) guess = { role: "ui_icon", confidence: 0.5, why: "a small square cut-out" };
    else if (transparent && aspect >= 1.8) guess = { role: "ui_logo", confidence: 0.45, why: "a wide cut-out" };
    else if (transparent) guess = { role: "player", confidence: 0.4, why: "a cut-out figure" };
    else if (!transparent && aspect >= 0.9 && aspect <= 1.1 && width <= 512 && colors.size >= 3 && !paper) guess = { role: "texture", confidence: 0.45, why: "a square opaque picture" };
    else guess = { role: "level", confidence: 0.3, why: "an opaque picture" };

    return { width, height, aspect: +aspect.toFixed(2), transparent, clear: +clearShare.toFixed(2), grid, frame, paper, colors: colors.size, ink: +ink.toFixed(3), guess, sure: guess.confidence >= SURE };
  }

  /** The facts, in words, for the model's prompt. */
  function describe(f) {
    if (!f) return "";
    return `${f.width} x ${f.height} px, ${f.transparent ? `transparent background (${Math.round(f.clear * 100)}% clear)` : "no transparency"}${f.grid ? `, a grid of ${f.grid.cols} x ${f.grid.rows} cells` : ""}${f.frame ? ", a straight frame border" : ""}${f.paper ? ", looks like paper with pen strokes" : ""}, about ${f.colors} colour bins`;
  }

  return { inspect, describe, SURE };
})();
