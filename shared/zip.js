// shared/zip.js — opens a ZIP dropped into the Studio and hands back its pictures and 3D models as File objects (window.ZipRead).
// Reads the central directory at the end of the file, then each entry's local header; "stored" entries are sliced out,
// "deflate" entries are inflated with the browser's DecompressionStream("deflate-raw"). No ZIP64, no encryption; folders,
// __MACOSX junk, dotfiles and anything that is not a PNG, JPEG, WebP, GLB, GLTF or FBX are skipped.
window.ZipRead = (() => {
  const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", glb: "model/gltf-binary", gltf: "model/gltf+json", fbx: "model/fbx" };
  const MAX_FILES = 60, MAX_BYTES = 40_000_000;

  /** @param {ArrayBuffer} buf  @returns {Promise<File[]>} */
  async function files(buf) {
    const v = new DataView(buf), u8 = new Uint8Array(buf), n = buf.byteLength;
    let eocd = -1;
    for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("not a ZIP file");
    const count = v.getUint16(eocd + 10, true), cdOffset = v.getUint32(eocd + 16, true);
    const out = []; let p = cdOffset, total = 0;
    for (let k = 0; k < count && p + 46 <= n; k++) {
      if (v.getUint32(p, true) !== 0x02014b50) break;
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
      const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      const base = name.split("/").pop(), ext = (base.split(".").pop() || "").toLowerCase();
      if (!base || name.endsWith("/") || /(^|\/)__MACOSX\//.test(name) || base.startsWith(".") || !TYPES[ext]) continue;
      if (csize === 0xffffffff || usize === 0xffffffff) continue;                                  // ZIP64: not supported
      if (local + 30 > n || v.getUint32(local, true) !== 0x04034b50) continue;
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      if (start + csize > n) continue;
      const raw = buf.slice(start, start + csize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
      else continue;
      total += data.byteLength;
      if (out.length >= MAX_FILES || total > MAX_BYTES) break;
      out.push(new File([data], base, { type: TYPES[ext] }));
    }
    return out;
  }

  return { files };
})();
