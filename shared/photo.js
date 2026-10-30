// shared/photo.js — browser helpers to turn a photo File into a resized JPEG data URL.
// Classic script (no module) so both index.html and game.html can use window.PhotoUtil.
window.PhotoUtil = {
  /** Decode a File into an <img>. Browsers apply EXIF rotation to <img>, so canvases drawn from it are upright. */
  loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  },
  /** Resize so the long edge is at most maxSide and return a JPEG data URL. Transparent PNG areas become white paper. */
  toJpeg(img, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", quality);
  },
  UPLOAD_SIDE: 1600,
  THUMB_SIDE: 480,
};
