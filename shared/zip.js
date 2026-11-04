// shared/zip.js — opens a ZIP dropped into the Studio and hands back its pictures and 3D models as File objects (window.ZipRead),
// and makes one for "Download the project" (window.ZipWrite: stored entries, CRC-32, UTF-8 names; every unzip tool opens it).
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

window.ZipWrite = (() => {
  const T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = T[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  /** @param {{ name: string, data: Uint8Array | string }[]} files  @returns {Blob} a ZIP with every file stored (no compression) */
  function make(files, date = new Date()) {
    const enc = new TextEncoder(), parts = [], central = [];
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    let offset = 0, cdSize = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data instanceof Uint8Array ? f.data : enc.encode(String(f.data)), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
      local.setUint16(10, time, true); local.setUint16(12, day, true); local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(local, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, day, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(c, name); cdSize += 46 + name.length;
      offset += 30 + name.length + data.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }
  return { make, crc32 };
})();
