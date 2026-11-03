// Draws the sample pictures in tests/samples/ (one per asset role) with a tiny PNG writer, no canvas needed:
//   node tests/make-samples.mjs
// They are checked in; run this again only when a sample changes. Used by tests/assets.test.mjs and tests/image.test.mjs.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");
fs.mkdirSync(OUT, { recursive: true });

// ---- a minimal RGBA PNG encoder ----
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A tiny drawing surface: fill, rect, rounded rect, circle, line, noise. Colours are [r,g,b,a]. */
function surface(w, h, bg = [0, 0, 0, 0]) {
  const px = Buffer.alloc(w * h * 4);
  const set = (x, y, c) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3] ?? 255; };
  const fill = (c) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, c); };
  const rect = (x0, y0, rw, rh, c) => { for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) set(x, y, c); };
  const rrect = (x0, y0, rw, rh, r, c) => { for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) { const dx = Math.max(x0 + r - x, 0, x - (x0 + rw - 1 - r)), dy = Math.max(y0 + r - y, 0, y - (y0 + rh - 1 - r)); if (dx * dx + dy * dy <= r * r) set(x, y, c); } };
  const circle = (cx, cy, r, c) => { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, c); };
  const line = (x0, y0, x1, y1, t, c) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); for (let i = 0; i <= n; i++) { const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n); for (let dy = -t; dy <= t; dy++) for (let dx = -t; dx <= t; dx++) set(x + dx, y + dy, c); } };
  fill(bg);
  return { w, h, px, set, fill, rect, rrect, circle, line, save: (name) => fs.writeFileSync(path.join(OUT, name), png(w, h, px)) };
}
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function figure(s, x, y, body, skin) {   // a little character: head, body, legs, eyes
  s.circle(x + 24, y + 14, 12, skin); s.rect(x + 12, y + 28, 24, 30, body); s.rect(x + 14, y + 58, 8, 20, [20, 20, 30]); s.rect(x + 26, y + 58, 8, 20, [20, 20, 30]);
  s.set(x + 20, y + 12, [0, 0, 0]); s.set(x + 28, y + 12, [0, 0, 0]); s.set(x + 21, y + 12, [0, 0, 0]); s.set(x + 29, y + 12, [0, 0, 0]);
}

// character (transparent, one figure)
{ const s = surface(96, 128); figure(s, 24, 20, [29, 78, 216], [252, 217, 182]); s.save("character.png"); }
// enemy (transparent blob with eyes)
{ const s = surface(96, 72); s.circle(48, 40, 28, [220, 38, 38]); s.circle(38, 34, 5, [255, 255, 255]); s.circle(58, 34, 5, [255, 255, 255]); s.circle(38, 34, 2, [0, 0, 0]); s.circle(58, 34, 2, [0, 0, 0]); s.save("enemy.png"); }
// coin (small transparent circle)
{ const s = surface(48, 48); s.circle(24, 24, 20, [245, 158, 11]); s.circle(24, 24, 14, [253, 224, 71]); s.rect(21, 14, 6, 20, [245, 158, 11]); s.save("coin.png"); }
// sprite sheet: 4 columns x 3 rows of the figure, clear gutters
{ const s = surface(4 * 56, 3 * 90); for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) figure(s, c * 56 + 4, r * 90 + 6 + (r === 2 ? -4 : 0) + (c % 2 ? 2 : 0), [29, 78, 216], [252, 217, 182]); s.save("spritesheet.png"); }
// tileset: 8 x 4 square tiles with 2 px clear gutters
{ const s = surface(8 * 34, 4 * 34); for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) { const g = [80 + r * 30, 140 + c * 10, 60]; s.rect(c * 34 + 1, r * 34 + 1, 32, 32, g); for (let k = 0; k < 40; k++) s.set(c * 34 + 1 + (rnd() * 32 | 0), r * 34 + 1 + (rnd() * 32 | 0), [g[0] - 30, g[1] - 30, g[2]]); } s.save("tileset.png"); }
// button: wide rounded rect with a border, transparent corners
{ const s = surface(240, 72); s.rrect(0, 0, 240, 72, 18, [67, 56, 202]); s.rrect(6, 6, 228, 60, 14, [129, 140, 248]); s.rect(70, 30, 100, 12, [255, 255, 255]); s.save("button.png"); }
// panel: rounded box with a border
{ const s = surface(300, 220); s.rrect(0, 0, 300, 220, 20, [120, 53, 15]); s.rrect(8, 8, 284, 204, 16, [253, 230, 138]); s.rect(40, 60, 220, 10, [180, 83, 9]); s.rect(40, 100, 160, 10, [180, 83, 9]); s.save("panel.png"); }
// icon: a heart
{ const s = surface(64, 64); s.circle(22, 24, 14, [239, 68, 68]); s.circle(42, 24, 14, [239, 68, 68]); for (let y = 24; y < 58; y++) { const half = Math.round(28 * (58 - y) / 34); s.rect(32 - half, y, half * 2, 1, [239, 68, 68]); } s.save("icon_heart.png"); }
// background: wide opaque scene (sky gradient, hills, sun)
{ const s = surface(800, 450, [0, 0, 0, 255]); for (let y = 0; y < 450; y++) for (let x = 0; x < 800; x++) s.set(x, y, [120 + (y / 450) * 100 | 0, 170 + (y / 450) * 60 | 0, 255]); s.circle(650, 90, 50, [253, 224, 71]); for (let x = 0; x < 800; x++) { const hy = 300 + Math.round(40 * Math.sin(x / 90)) ; s.rect(x, hy, 1, 450 - hy, [34, 160 + Math.round(30 * Math.sin(x / 50)), 60]); } s.save("background.png"); }
// level drawing: paper with dark pen strokes (ground, platforms, a flag, coins)
{ const s = surface(900, 600, [248, 246, 238, 255]); for (let y = 30; y < 600; y += 30) s.line(0, y, 899, y, 0, [215, 225, 240]); s.line(30, 540, 870, 540, 2, [30, 30, 40]); s.line(300, 420, 460, 420, 2, [30, 30, 40]); s.line(560, 330, 700, 330, 2, [30, 30, 40]); s.line(820, 540, 820, 380, 2, [30, 30, 40]); s.line(820, 380, 870, 400, 2, [30, 30, 40]); s.line(870, 400, 820, 420, 2, [30, 30, 40]); for (const x of [340, 380, 420]) { for (let a = 0; a < 360; a += 10) { const r = 12, px = Math.round(x + r * Math.cos(a / 57.3)), py = Math.round(380 + r * Math.sin(a / 57.3)); s.set(px, py, [30, 30, 40]); s.set(px + 1, py, [30, 30, 40]); } } s.save("level_drawing.png"); }
// font sheet: 10 x 4 glyph cells, white on transparent
{ const s = surface(10 * 22, 4 * 30); for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) { const x = c * 22 + 3, y = r * 30 + 4; const k = (r * 10 + c) % 5; s.rect(x, y, 16, 3, [255, 255, 255]); s.rect(x, y, 3, 22, [255, 255, 255]); if (k > 1) s.rect(x + 13, y, 3, 22, [255, 255, 255]); if (k !== 3) s.rect(x, y + 19, 16, 3, [255, 255, 255]); if (k === 4) s.rect(x, y + 10, 16, 3, [255, 255, 255]); } s.save("font.png"); }
// logo: wide transparent block letters
{ const s = surface(400, 120); for (let i = 0; i < 6; i++) { const x = 20 + i * 62; s.rect(x, 20, 48, 12, [124, 58, 237]); s.rect(x, 20, 12, 80, [124, 58, 237]); s.rect(x + 36, 20, 12, 80, [124, 58, 237]); if (i % 2) s.rect(x, 54, 48, 12, [124, 58, 237]); } s.save("logo.png"); }
// texture: a square opaque brick pattern
{ const s = surface(128, 128, [150, 75, 40, 255]); for (let r = 0; r < 8; r++) for (let c = 0; c < 4; c++) { const off = r % 2 ? 16 : 0; s.rect((c * 32 + off + 2) % 128, r * 16 + 2, 28, 12, [190 + (rnd() * 30 | 0), 100, 60]); } s.save("texture.png"); }

console.log("samples written to", OUT, fs.readdirSync(OUT).join(", "));
