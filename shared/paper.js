// shared/paper.js — paper sheet detection, perspective flattening, contrast boost and ink mask.
// Pure JS over ImageData-like objects ({ width, height, data: RGBA Uint8ClampedArray }), no OpenCV,
// so it runs in the browser (pad.html) and in Node (tests). Classic script: window.Paper, or module.exports.
(function (root, factory) {
  const P = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = P; else root.Paper = P;
})(typeof self !== "undefined" ? self : globalThis, function () {

  /** Luma plane (0-255). */
  function gray(img) {
    const { width: w, height: h, data } = img;
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    return g;
  }

  /** Otsu threshold of a luma plane. */
  function otsu(g) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    const total = g.length;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, thr = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = i; }
    }
    return thr;
  }

  /** Nearest-neighbour downsample to w x h. */
  function downsample(img, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    const sx = img.width / w, sy = img.height / h;
    for (let y = 0; y < h; y++) {
      const iy = Math.min(img.height - 1, (y * sy + sy / 2) | 0);
      for (let x = 0; x < w; x++) {
        const ix = Math.min(img.width - 1, (x * sx + sx / 2) | 0);
        const s = (iy * img.width + ix) * 4, o = (y * w + x) * 4;
        out[o] = img.data[s]; out[o + 1] = img.data[s + 1]; out[o + 2] = img.data[s + 2]; out[o + 3] = 255;
      }
    }
    return { width: w, height: h, data: out };
  }

  /**
   * Find the paper: the largest bright connected region. Returns { quad: [TL, TR, BR, BL], coverage } in image
   * pixels, or null. Works on a small frame (e.g. 160x120) for speed; scale the quad up afterwards.
   */
  function detectPaper(img, opts = {}) {
    const w = img.width, h = img.height, g = gray(img);
    const thr = Math.max(opts.minBright ?? 110, Math.min(otsu(g), 200));
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) mask[i] = g[i] >= thr ? 1 : 0;

    // Largest 4-connected bright component (iterative flood fill).
    const label = new Int32Array(w * h);
    let bestArea = 0, bestId = 0, id = 0;
    const stack = new Int32Array(w * h);
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || label[s]) continue;
      id++; let area = 0, top = 0;
      stack[top++] = s; label[s] = id;
      while (top) {
        const p = stack[--top]; area++;
        const x = p % w, y = (p - x) / w;
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[top++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[top++] = p + 1; }
        if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[top++] = p - w; }
        if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[top++] = p + w; }
      }
      if (area > bestArea) { bestArea = area; bestId = id; }
    }
    if (bestArea < (opts.minCoverage ?? 0.12) * w * h) return null;

    // Corners = extreme points of the component (works for sheets rotated less than ~45 degrees).
    let tl = null, tr = null, br = null, bl = null, mTL = Infinity, mBR = -Infinity, mTR = -Infinity, mBL = Infinity;
    for (let p = 0; p < w * h; p++) {
      if (label[p] !== bestId) continue;
      const x = p % w, y = (p - x) / w, s = x + y, d = x - y;
      if (s < mTL) { mTL = s; tl = [x, y]; }
      if (s > mBR) { mBR = s; br = [x + 1, y + 1]; }
      if (d > mTR) { mTR = d; tr = [x + 1, y]; }
      if (d < mBL) { mBL = d; bl = [x, y + 1]; }
    }
    const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (len(tl, tr) < 0.25 * w || len(bl, br) < 0.25 * w || len(tl, bl) < 0.25 * h || len(tr, br) < 0.25 * h) return null;
    return { quad: [tl, tr, br, bl], coverage: bestArea / (w * h) };
  }

  /** Largest corner movement between two quads (pixels). */
  function quadDistance(a, b) {
    if (!a || !b) return Infinity;
    let m = 0;
    for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
    return m;
  }

  /** Solve A x = b (small dense system) by Gaussian elimination with partial pivoting. */
  function solve(A, b) {
    const n = b.length, M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c] || 1e-12;
      for (let k = c; k <= n; k++) M[c][k] /= d;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((row) => row[n]);
  }

  /** Homography H (3x3, row-major, h8 = 1) with H * [x, y, 1] ~ [u, v, 1] for the 4 point pairs (from -> to). */
  function homography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [u, v] = to[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  /** Flatten the quad [TL, TR, BR, BL] of img into an outW x outH image (nearest sampling). */
  function warp(img, quad, outW, outH) {
    const H = homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);   // output -> source
    const out = new Uint8ClampedArray(outW * outH * 4);
    const { width: w, height: h, data } = img;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const den = H[6] * x + H[7] * y + 1;
        const sx = (H[0] * x + H[1] * y + H[2]) / den, sy = (H[3] * x + H[4] * y + H[5]) / den;
        const ix = sx | 0, iy = sy | 0, o = (y * outW + x) * 4;
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255; continue; }
        const s = (iy * w + ix) * 4;
        out[o] = data[s]; out[o + 1] = data[s + 1]; out[o + 2] = data[s + 2]; out[o + 3] = 255;
      }
    }
    return { width: outW, height: outH, data: out };
  }

  /** Stretch levels so the 3rd..97th luma percentiles span 0..255 (in place). Returns img. */
  function boostContrast(img, lo = 0.03, hi = 0.97) {
    const g = gray(img), hist = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    const n = g.length;
    let acc = 0, pLo = 0, pHi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= lo * n) { pLo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= (1 - hi) * n) { pHi = i; break; } }
    const range = Math.max(40, pHi - pLo);
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, ((i - pLo) * 255) / range));
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    return img;
  }

  /** Dark pen strokes: 1 where luma is well below the paper (median) brightness. */
  function inkMask(img, delta = 70) {
    const g = gray(img), hist = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let acc = 0, median = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= g.length / 2) { median = i; break; } }
    const thr = Math.max(20, median - delta);
    const mask = new Uint8Array(g.length);
    let count = 0;
    for (let i = 0; i < g.length; i++) if (g[i] < thr) { mask[i] = 1; count++; }
    return { mask, count, width: img.width, height: img.height, paper: median };
  }

  /**
   * Fraction of pixels that differ between two masks (0..1). With w and h given, a pixel only counts when
   * the other mask has no ink within one pixel of it, so thin strokes that jitter by a pixel do not count
   * but a new stroke does.
   */
  function maskDiff(a, b, w, h, radius = 1) {
    if (!a || !b || a.length !== b.length) return 1;
    let diff = 0;
    if (!w || !h) { for (let i = 0; i < a.length; i++) diff += a[i] ^ b[i]; return diff / a.length; }
    const near = (m, x, y) => {
      for (let dy = -radius; dy <= radius; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -radius; dx <= radius; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && m[yy * w + xx]) return true; } }
      return false;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (a[i] === b[i]) continue;
      if (a[i] ? !near(b, x, y) : !near(a, x, y)) diff++;
    }
    return diff / a.length;
  }

  /** Smallest tolerant diff over small x/y shifts of b (handles a slightly different flatten alignment). */
  function bestDiff(a, b, w, h, radius = 1, maxShift = 2) {
    let best = 1;
    const shifted = new Uint8Array(a.length);
    for (let sy = -maxShift; sy <= maxShift; sy++) for (let sx = -maxShift; sx <= maxShift; sx++) {
      shifted.fill(0);
      for (let y = 0; y < h; y++) { const yy = y + sy; if (yy < 0 || yy >= h) continue; for (let x = 0; x < w; x++) { const xx = x + sx; if (xx >= 0 && xx < w) shifted[y * w + x] = b[yy * w + xx]; } }
      const d = maskDiff(a, shifted, w, h, radius);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
    return best;
  }

  /** Render a mask as RGBA pixels (ink colour on transparent). */
  function maskToRGBA(mask, w, h, rgb = [27, 21, 53]) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < mask.length; i++) if (mask[i]) { const o = i * 4; out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255; }
    return out;
  }

  return { gray, otsu, downsample, detectPaper, quadDistance, homography, warp, boostContrast, inkMask, maskDiff, bestDiff, maskToRGBA };
});
