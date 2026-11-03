// shared/model3d.js — 3D models uploaded to the Studio (window.Model3D): load a GLB / GLTF / FBX from a data URL into a
// three.js object that stands on y = 0, centred, a given height tall; and bake one into a one-row sprite sheet (a side view
// at a few angles) for the 2D game. Loaders come from three's own examples (GLTFLoader, FBXLoader) through the page's
// import map ("three" -> the same three.module.js the engines use), fetched the first time they are needed.
window.Model3D = (() => {
  const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
  const ADDONS = "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/";
  const LOADERS = { glb: "GLTFLoader", gltf: "GLTFLoader", fbx: "FBXLoader" };
  let THREE = null; const loaders = {};
  const three = () => (THREE ? Promise.resolve(THREE) : import(THREE_URL).then((m) => (THREE = m)));
  const extOf = (name) => String(name || "").split(".").pop().toLowerCase();
  const isModelName = (name) => !!LOADERS[extOf(name)];
  async function loaderFor(ext) {
    const name = LOADERS[ext]; if (!name) throw new Error("not a GLB, GLTF or FBX file");
    if (!loaders[name]) loaders[name] = import(`${ADDONS}${name}.js`).then((m) => m[name]);
    return loaders[name];
  }
  function bytesOf(src) { const b64 = String(src).split(",")[1] || "", bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }

  /** Wrap an object so its feet are at y = 0, it is centred on x and z and `height` tall; meshes cast shadows. */
  function fit(object, height) {
    const box = new THREE.Box3().setFromObject(object), size = new THREE.Vector3(); box.getSize(size);
    const k = height / Math.max(size.y, 1e-6), g = new THREE.Group();
    g.add(object);
    object.scale.setScalar(k);
    object.position.set(-(box.min.x + size.x / 2) * k, -box.min.y * k, -(box.min.z + size.z / 2) * k);
    object.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    g.userData.size = { w: size.x * k, h: height, d: size.z * k };
    g.userData.model = true;
    return g;
  }

  /**
   * @param {{ src: string, name: string }} model  a data URL and the file name (the extension picks the loader)
   * @param {number} height  how tall the result is, in the caller's units
   * @returns {Promise<{ object: THREE.Group, clips: THREE.AnimationClip[], raw: THREE.Object3D }>}
   */
  async function load(model, height = 1) {
    await three();
    const ext = extOf(model.name), Loader = await loaderFor(ext), loader = new Loader(), buf = bytesOf(model.src);
    let object, clips = [];
    if (ext === "fbx") { object = loader.parse(buf, ""); clips = object.animations || []; }
    else { const gltf = await new Promise((ok, no) => loader.parse(buf, "", ok, no)); object = gltf.scene || gltf.scenes?.[0]; clips = gltf.animations || []; }
    if (!object) throw new Error("the model has no scene");
    return { object: fit(object, height), clips, raw: object };
  }

  /** The model as a one-row sprite sheet (PNG data URL): a side view at `frames` slightly different angles, `height` px tall. */
  async function bake(model, { frames = 4, height = 256 } = {}) {
    await three();
    const { object } = await load(model, 1);
    const w = Math.round(height * 0.9), sheet = document.createElement("canvas"); sheet.width = w * frames; sheet.height = height;
    const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1); r.setSize(w, height, false); r.setClearColor(0x000000, 0); r.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene(); scene.add(object);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(2, 4, 3); scene.add(sun);
    const cam = new THREE.PerspectiveCamera(28, w / height, 0.01, 100); cam.position.set(0, 0.5, 2.45); cam.lookAt(0, 0.5, 0);
    const ctx = sheet.getContext("2d");
    for (let i = 0; i < frames; i++) {   // facing right (+x), with a little turn per frame so the frames differ
      object.rotation.y = Math.PI / 2 + Math.sin((i / frames) * Math.PI * 2) * 0.35;
      r.render(scene, cam); ctx.drawImage(r.domElement, i * w, 0);
    }
    r.dispose();
    return { src: sheet.toDataURL("image/png"), grid: { cols: frames, rows: 1 }, w: sheet.width, h: sheet.height };
  }

  return { load, bake, fit, extOf, isModelName, three };
})();
