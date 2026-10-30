// Unit checks for shared/paper.js on synthetic frames (no canvas needed).  Run: npm test
// package.json is "type": "module", so the classic-script file is loaded as ESM and registers itself on globalThis.
await import("../shared/paper.js");
const Paper = globalThis.Paper;

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 200) : ""}`);
  if (!cond) fails++;
}

// A synthetic photo: dark desk, a slightly rotated bright sheet, dark pen strokes on it.
const W = 320, H = 240;
function frame({ strokes = true, extraStroke = false, rot = 0.12 } = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  const sheet = [[70, 40], [250, 30], [262, 200], [60, 210]];   // TL TR BR BL, a bit of perspective
  const cx = 160, cy = 120;
  const q = sheet.map(([x, y]) => { const dx = x - cx, dy = y - cy; return [cx + dx * Math.cos(rot) - dy * Math.sin(rot), cy + dx * Math.sin(rot) + dy * Math.cos(rot)]; });
  const inside = (x, y) => { let pos = 0, neg = 0; for (let i = 0; i < 4; i++) { const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4]; const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax); if (c >= 0) pos++; else neg++; } return !pos || !neg; };
  // strokes are drawn in sheet-local coordinates (0..1) and mapped through the sheet quad
  const Hm = Paper.homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
  const toImg = (u, v) => { const d = Hm[6] * u + Hm[7] * v + 1; return [(Hm[0] * u + Hm[1] * v + Hm[2]) / d, (Hm[3] * u + Hm[4] * v + Hm[5]) / d]; };
  const ink = new Set();
  const line = (u0, v0, u1, v1) => { for (let t = 0; t <= 1; t += 0.002) { const [x, y] = toImg(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) ink.add(((y | 0) + dy) * W + ((x | 0) + dx)); } };
  if (strokes) { line(0.1, 0.85, 0.9, 0.85); line(0.2, 0.85, 0.2, 0.6); line(0.5, 0.6, 0.7, 0.6); }
  if (extraStroke) line(0.3, 0.4, 0.6, 0.4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    let v = 55 + ((x * 7 + y * 3) % 11);            // desk, slightly noisy
    if (inside(x, y)) v = 225 + ((x + y) % 7);       // paper
    if (ink.has(y * W + x)) v = 40;                  // pen
    data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
  }
  return { img: { width: W, height: H, data }, quad: q };
}

const { img, quad } = frame();
const small = Paper.downsample(img, 160, 120);
const det = Paper.detectPaper(small);
check("paper detected on the small frame", !!det && det.coverage > 0.25 && det.coverage < 0.8, det && det.coverage);
if (det) {
  const up = det.quad.map(([x, y]) => [x * 2, y * 2]);
  const err = Paper.quadDistance(up, quad);
  check("corners within 6 px of the truth", err < 6, { err: +err.toFixed(1), found: up.map((p) => p.map(Math.round)), truth: quad.map((p) => p.map(Math.round)) });
}
check("no paper in a dark frame", Paper.detectPaper({ width: 40, height: 30, data: new Uint8ClampedArray(40 * 30 * 4).fill(30) }) === null);
check("quadDistance of equal quads is 0", Paper.quadDistance(quad, quad) === 0);

// warp the detected sheet flat and check the strokes land where they were drawn
const flat = Paper.warp(img, quad, 200, 150);
const flatMask = Paper.inkMask(Paper.boostContrast(flat));
const at = (u, v) => flatMask.mask[((v * 150) | 0) * 200 + ((u * 200) | 0)];
check("flattened: ground line found at (0.5, 0.85)", at(0.5, 0.85) === 1);
check("flattened: vertical stroke at (0.2, 0.7)", at(0.2, 0.7) === 1);
check("flattened: blank paper at (0.5, 0.3)", at(0.5, 0.3) === 0);
check("ink mask counts a few percent of pixels", flatMask.count > 0.01 * 200 * 150 && flatMask.count < 0.15 * 200 * 150, flatMask.count);
check("contrast boost makes paper bright and ink dark", flatMask.paper > 230, flatMask.paper);

// change detection: an extra stroke changes the mask by a small but clear fraction
const flat2 = Paper.warp(frame({ extraStroke: true }).img, quad, 200, 150);
const mask2 = Paper.inkMask(Paper.boostContrast(flat2));
const d = Paper.maskDiff(flatMask.mask, mask2.mask);
check("extra stroke -> mask diff above 0.3%", d > 0.003, +d.toFixed(4));
const flatSame = Paper.warp(frame({ rot: 0.12 }).img, quad, 200, 150);
const dSame = Paper.maskDiff(flatMask.mask, Paper.inkMask(Paper.boostContrast(flatSame)).mask);
check("same drawing -> mask diff below 0.1%", dSame < 0.001, +dSame.toFixed(4));
// tolerant diff: a one-pixel shift of every stroke is ignored, a new stroke is not
const shifted = new Uint8Array(flatMask.mask.length);
for (let y = 0; y < 150; y++) for (let x = 1; x < 200; x++) shifted[y * 200 + x] = flatMask.mask[y * 200 + x - 1];
const dShiftExact = Paper.maskDiff(flatMask.mask, shifted), dShiftTol = Paper.maskDiff(flatMask.mask, shifted, 200, 150);
check("1px shift: exact diff is large, tolerant diff is ~0", dShiftExact > 0.005 && dShiftTol < 0.0005, { exact: +dShiftExact.toFixed(4), tolerant: +dShiftTol.toFixed(5) });
const dNewTol = Paper.maskDiff(flatMask.mask, mask2.mask, 200, 150);
check("new stroke: tolerant diff above 0.1%", dNewTol > 0.001, +dNewTol.toFixed(4));
const shifted2 = new Uint8Array(flatMask.mask.length);
for (let y = 2; y < 150; y++) for (let x = 2; x < 200; x++) shifted2[y * 200 + x] = flatMask.mask[(y - 2) * 200 + x - 2];
check("bestDiff: a 2px misalignment is ~0, a new stroke still counts", Paper.bestDiff(flatMask.mask, shifted2, 200, 150) < 0.0003 && Paper.bestDiff(flatMask.mask, mask2.mask, 200, 150) > 0.001, { shifted: +Paper.bestDiff(flatMask.mask, shifted2, 200, 150).toFixed(5), newStroke: +Paper.bestDiff(flatMask.mask, mask2.mask, 200, 150).toFixed(4) });

// homography round trip
const Hm = Paper.homography([[0, 0], [10, 0], [10, 10], [0, 10]], [[5, 5], [25, 7], [23, 29], [3, 27]]);
const map = (x, y) => { const dd = Hm[6] * x + Hm[7] * y + 1; return [(Hm[0] * x + Hm[1] * y + Hm[2]) / dd, (Hm[3] * x + Hm[4] * y + Hm[5]) / dd]; };
check("homography maps corners exactly", map(10, 10).map((v) => +v.toFixed(3)).join() === "23,29" && map(0, 10).map((v) => +v.toFixed(3)).join() === "3,27");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
