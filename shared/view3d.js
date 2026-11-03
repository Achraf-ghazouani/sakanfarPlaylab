// shared/view3d.js — the 3D view of a PlayLab level (window.View3D), drawn with three.js.
// The game itself does not change: Phaser still runs the level (physics, input, phones, sounds, the playtest agent's
// level), its canvas is just hidden. Every frame this file mirrors the scene into a three.js scene: platforms are solid
// blocks with a grass top, spikes are metal cones, coins spin, enemies and characters are little blocks with eyes,
// the goal is a pole with a waving flag. Pictures (drawn ink, Muse Image sprites, the player picture) become paper
// cut-outs standing in the world; ink drawn on a platform sits on its front face.
// World units are the level grid: x right, y DOWN in Phaser; three.js has y up, so y3 = H - y.
window.View3D = (() => {
  const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
  const DEPTH = 150;            // how deep platforms are (the level is a corridor this thick)
  let THREE = null, loading = null;
  let renderer = null, scene3 = null, camera = null, sun = null, canvas = null;
  let on = false, built = null;  // built = the Phaser scene the 3D scene was made from
  let mirror = [];               // [{ go, mesh, kind, ... }] dynamic things synced each frame
  let avatarMeshes = new Map();  // avatar -> mesh
  let playerModel = null, playerModelSrc = null, playerModelGen = 0, modelMixer = null, lastSync = 0;   // the main character's 3D model (shared/model3d.js)
  let texCache = new Map();      // Phaser texture key -> THREE.Texture
  const camPos = { x: 0, y: 0, ready: false };

  function load() {
    if (THREE) return Promise.resolve(THREE);
    if (!loading) loading = import(THREE_URL).then((m) => (THREE = m));
    return loading;
  }

  function ensureRenderer(host) {
    if (renderer) return;
    canvas = document.createElement("canvas");
    canvas.id = "view3d";
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:1;";
    host.appendChild(canvas);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    camera = new THREE.PerspectiveCamera(42, 1, 5, 9000);
    const fit = () => {
      const w = host.clientWidth || innerWidth, h = host.clientHeight || innerHeight;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    fit();
    new ResizeObserver(fit).observe(host);
  }

  const color = (n) => new THREE.Color(n);
  const mat = (c, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0, ...extra });

  function textureOf(img) {
    const key = img.texture?.key;
    if (key && texCache.has(key)) return texCache.get(key);
    const src = img.texture?.getSourceImage?.();
    if (!src) return null;
    const t = src instanceof HTMLCanvasElement ? new THREE.CanvasTexture(src) : new THREE.Texture(src);
    t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; t.anisotropy = 4;
    if (key) texCache.set(key, t);
    return t;
  }

  function linesTexture(paper, lines) {
    const c = document.createElement("canvas"); c.width = 512; c.height = 512;
    const g = c.getContext("2d");
    g.fillStyle = "#" + paper.toString(16).padStart(6, "0"); g.fillRect(0, 0, 512, 512);
    if (lines != null) { g.strokeStyle = "#" + lines.toString(16).padStart(6, "0"); g.globalAlpha = 0.8; g.lineWidth = 2; for (let y = 25; y < 512; y += 51) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); } }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }

  function eyes(w, h, d) {
    const grp = new THREE.Group();
    const white = mat(0xffffff), black = mat(0x111111);
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(Math.max(3, w * 0.13), 12, 10), white);
      e.position.set(sx * w * 0.2, h * 0.28, d / 2 + 1);
      const p = new THREE.Mesh(new THREE.SphereGeometry(Math.max(1.6, w * 0.065), 10, 8), black);
      p.position.set(sx * w * 0.2 + w * 0.03, h * 0.28, d / 2 + Math.max(3, w * 0.12));
      grp.add(e, p);
    }
    return grp;
  }

  /** A little block character (or enemy): body + eyes, origin at its feet. */
  function blockBody(w, h, d, col) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(col, { roughness: 0.6 }));
    body.position.y = h / 2; body.castShadow = true; body.receiveShadow = true;
    const e = eyes(w, h, d); e.position.y = h / 2;
    g.add(body, e); g.userData.body = body;
    return g;
  }

  /** A paper cut-out for a Phaser Image (drawn ink, Muse Image sprite...). */
  function cutout(img) {
    const t = textureOf(img); if (!t) return null;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.08, side: THREE.DoubleSide, roughness: 0.9 }));
    m.castShadow = true;
    m.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: t, alphaTest: 0.5 });
    return m;
  }

  function clearScene() {
    if (!scene3) return;
    scene3.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose && m.dispose()); });
    mirror = []; avatarMeshes = new Map(); texCache.forEach((t) => t.dispose()); texCache = new Map();
  }

  /** Build the 3D scene from a Phaser PlayScene that has just been created. ctx: { level, pal, toWorld, playerW, playerH } */
  function build(s, ctx) {
    if (!THREE || !renderer) return;
    clearScene();
    built = s;
    const W = s.W, H = s.H, L = ctx.level, pal = ctx.pal;
    const X = (x) => x - W / 2, Y = (y) => H - y;
    scene3 = new THREE.Scene();
    scene3.background = color(pal.sky);
    scene3.fog = new THREE.Fog(pal.sky, 1600, 4200);

    // light: soft sky light + a sun that follows the camera (so the shadow box stays sharp around the player)
    scene3.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.15));
    sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -900, right: 900, top: 700, bottom: -700, near: 10, far: 4000 });
    sun.shadow.bias = -0.0008;
    scene3.add(sun, sun.target);

    // the paper behind the level, and a floor far below so falling looks like falling
    const wallTex = linesTexture(pal.paper, pal.lines ?? null); wallTex.repeat.set((W + 4000) / 520, (H + 3000) / 520);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(W + 4000, H + 3000), new THREE.MeshStandardMaterial({ map: wallTex, roughness: 1 }));
    wall.position.set(0, H / 2, -DEPTH / 2 - 260); wall.receiveShadow = true; scene3.add(wall);

    // which Phaser images belong to platforms (their ink goes on the block's front face)
    const front = new Set();
    for (const [i, gos] of s.created) {
      const t = L.objects[i]?.type;
      if (t === "platform" || t === "moving_platform") for (const go of gos) if (go.type === "Image") front.add(go);
    }
    const hasImage = (i) => (s.created.get(i) || []).some((go) => go.type === "Image");

    const brown = mat(0x8b5a2b), dirt = mat(0x6e4825), grass = mat(0x5fbf4a, { roughness: 0.9 }), blue = mat(0x60a5fa, { roughness: 0.5 });
    const steel = mat(0xa7adb6, { metalness: 0.6, roughness: 0.35 }), gold = mat(0xffc93c, { metalness: 0.35, roughness: 0.35, emissive: 0x8a5a00, emissiveIntensity: 0.55 });
    L.objects.forEach((o, i) => {
      const w = ctx.toWorld(o);
      if (o.type === "platform") {
        const g = new THREE.Group();
        const block = new THREE.Mesh(new THREE.BoxGeometry(w.Wd, w.Ht, DEPTH), [brown, brown, grass, dirt, brown, brown]);
        block.castShadow = true; block.receiveShadow = true;
        const top = new THREE.Mesh(new THREE.BoxGeometry(w.Wd + 4, Math.min(10, w.Ht * 0.5), DEPTH + 4), grass);
        top.position.y = w.Ht / 2; top.receiveShadow = true; top.castShadow = true;
        g.add(block, top); g.position.set(X(w.cx), Y(w.cy), 0); scene3.add(g);
      } else if (o.type === "spike" && !hasImage(i)) {
        const teeth = Math.max(1, Math.round(w.Wd / Math.max(12, w.Ht * 0.9))), tw = w.Wd / teeth;
        for (let k = 0; k < teeth; k++) for (const z of [-DEPTH / 3, 0, DEPTH / 3]) {
          const c = new THREE.Mesh(new THREE.ConeGeometry(tw * 0.45, w.Ht, 4), steel);
          c.position.set(X(w.X + tw * (k + 0.5)), Y(w.Y + w.Ht) + w.Ht / 2, z); c.castShadow = true; scene3.add(c);
        }
      } else if (o.type === "goal" && !hasImage(i)) {
        const poleX = X(w.X + w.Wd * 0.25);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, w.Ht, 10), mat(0x6b7280, { metalness: 0.5 }));
        pole.position.set(poleX, Y(w.Y) - w.Ht / 2, 0); pole.castShadow = true; scene3.add(pole);
        const flag = new THREE.Mesh(new THREE.BoxGeometry(w.Wd * 0.75, w.Ht * 0.25, 3), mat(0xfacc15, { emissive: 0x332200 }));
        flag.geometry.translate(w.Wd * 0.375, 0, 0);
        flag.position.set(poleX, Y(w.Y) - w.Ht * 0.14, 0); flag.castShadow = true; scene3.add(flag);
        mirror.push({ kind: "flag", mesh: flag });
      } else if (o.type === "decoration" && !hasImage(i)) {
        const label = String(o.label || "").toLowerCase();
        if (/tree|bush|plant|forest|palm/.test(label)) {
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(w.Wd * 0.08, w.Wd * 0.1, w.Ht * 0.4, 8), mat(0x6b4423));
          trunk.position.set(X(w.cx), Y(w.Y + w.Ht) + w.Ht * 0.2, -DEPTH * 0.35);
          const crown = new THREE.Mesh(new THREE.ConeGeometry(w.Wd * 0.45, w.Ht * 0.75, 10), mat(0x2f8f3a));
          crown.position.set(X(w.cx), Y(w.Y) - w.Ht * 0.38, -DEPTH * 0.35);
          trunk.castShadow = crown.castShadow = true; scene3.add(trunk, crown);
        } else if (/cloud/.test(label)) {
          for (const [dx, r] of [[-0.25, 0.28], [0, 0.36], [0.25, 0.26]]) {
            const p = new THREE.Mesh(new THREE.SphereGeometry(w.Wd * r, 16, 12), mat(0xffffff, { roughness: 1 }));
            p.position.set(X(w.cx + w.Wd * dx), Y(w.cy), -DEPTH * 0.6); scene3.add(p);
          }
        } else {
          const b = new THREE.Mesh(new THREE.BoxGeometry(w.Wd, w.Ht, 20), mat(0xa78bfa, { transparent: true, opacity: 0.35 }));
          b.position.set(X(w.cx), Y(w.cy), -DEPTH * 0.45); scene3.add(b);
        }
      }
    });

    // moving platforms, coins and enemies are followed every frame
    for (const m of s.movers.getChildren()) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(m.width, m.height, DEPTH * 0.8), blue);
      box.castShadow = box.receiveShadow = true; scene3.add(box); mirror.push({ kind: "go", go: m, mesh: box, z: 0 });
    }
    for (const c of s.coinGroup.getChildren()) {
      if (!c.visible) continue;          // a coin with a sprite shows its picture instead (mirrored below)
      const r = c.radius || 14;
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 7, 24), gold);
      coin.rotation.x = Math.PI / 2; coin.castShadow = true;
      const holder = new THREE.Group(); holder.add(coin); scene3.add(holder);
      mirror.push({ kind: "coin", go: c, mesh: holder, spin: coin });
    }
    for (const e of s.enemies.getChildren()) {
      if (e.getData("art")) continue;    // drawn or Muse Image enemy: its picture is mirrored below
      const g = blockBody(e.width, e.height, 46, 0xef4444); scene3.add(g);
      mirror.push({ kind: "enemy", go: e, mesh: g });
    }
    // every picture in the scene (not the characters' own skins) becomes a paper cut-out
    const skins = new Set((s.avatars || []).map((a) => a.skin));
    for (const img of s.children.list) {
      if (img.type !== "Image" || skins.has(img)) continue;
      const m = cutout(img); if (!m) continue;
      scene3.add(m); mirror.push({ kind: "image", go: img, mesh: m, z: front.has(img) ? DEPTH / 2 + 1.5 : 0 });
    }
    camPos.ready = false;
  }

  function avatarMesh(av, ctx) {
    let m = avatarMeshes.get(av);
    const wantModel = av.slot === 1 && !!playerModel;   // the main character wears the uploaded 3D model
    if (m && m.userData.sprite === !!av.sprite && !!m.userData.model === wantModel && (!wantModel || m === playerModel.object)) return m;
    if (m) { scene3.remove(m); avatarMeshes.delete(av); }
    if (wantModel) { m = playerModel.object; m.userData.sprite = false; }
    else if (av.sprite) { m = cutout(av.skin) || new THREE.Group(); m.userData.sprite = true; }
    else { m = blockBody(ctx.playerW, ctx.playerH, 34, av.color); m.userData.sprite = false; }
    scene3.add(m); avatarMeshes.set(av, m);
    return m;
  }
  /** The main character's 3D model from the Studio ({ src, name } or null); the mesh is swapped on the next frame. */
  async function setModel(model) {
    const src = model?.src || null;
    if (src === playerModelSrc) return false;
    playerModelSrc = src; const gen = ++playerModelGen;
    playerModel = null; modelMixer = null;
    if (!src) return true;
    try {
      await load();
      const loaded = await window.Model3D.load(model, 1);
      if (gen !== playerModelGen) return false;
      playerModel = loaded;
      if (loaded.clips.length) { modelMixer = new THREE.AnimationMixer(loaded.raw); modelMixer.clipAction(loaded.clips.find((c) => /idle|walk|run/i.test(c.name)) || loaded.clips[0]).play(); }
    } catch (err) { console.warn("3D model:", err.message); playerModel = null; }
    return true;
  }

  /** Copy the Phaser scene's state into the 3D scene and draw a frame. Called after each Phaser update. */
  function sync(s, ctx) {
    if (!on || !THREE || !renderer || built !== s || !scene3) return;
    const W = s.W, H = s.H, X = (x) => x - W / 2, Y = (y) => H - y, now = performance.now();
    if (modelMixer) modelMixer.update(Math.min(0.1, (now - (lastSync || now)) / 1000));
    lastSync = now;
    for (const it of mirror) {
      const go = it.go;
      if (go && (!go.active || go.visible === false && it.kind !== "go")) { it.mesh.visible = false; continue; }
      if (it.kind === "go") { it.mesh.position.set(X(go.x), Y(go.y), it.z); }
      else if (it.kind === "coin") { it.mesh.position.set(X(go.x), Y(go.y), 0); it.spin.rotation.z = now / 400; it.mesh.scale.setScalar(go.scaleX || 1); }
      else if (it.kind === "enemy") {
        it.mesh.position.set(X(go.x), Y(go.y + go.height * go.scaleY / 2), 0);
        it.mesh.scale.set(1, go.scaleY, 1);
        it.mesh.rotation.y = (go.getData("dir") || -1) > 0 ? 0.5 : -0.5;
      } else if (it.kind === "image") {
        it.mesh.visible = go.visible !== false && go.alpha > 0.02;
        it.mesh.position.set(X(go.x), Y(go.y), it.z);
        it.mesh.scale.set(go.displayWidth * (go.flipX ? -1 : 1), go.displayHeight, 1);
        it.mesh.rotation.z = -(go.rotation || 0);
        it.mesh.material.opacity = go.alpha;
      } else if (it.kind === "flag") { it.mesh.rotation.y = Math.sin(now / 350) * 0.35; }
    }
    // characters (phones can join and leave at any time)
    const seen = new Set();
    for (const av of s.avatars || []) {
      seen.add(av);
      const m = avatarMesh(av, ctx), sk = av.skin;
      const feet = sk.y;
      if (m.userData.model) {
        const h = ctx.playerH * 1.3;   // the model is 1 unit tall: scale it like the player picture, squash it like the body
        m.position.set(X(sk.x), Y(feet), 8);
        m.scale.set(h * (sk.scaleX / (av.baseSX || 1)), h * (sk.scaleY / (av.baseSY || 1)), h);
        m.rotation.y = av.facing > 0 ? Math.PI / 2 : -Math.PI / 2;
      } else if (av.sprite) {
        m.position.set(X(sk.x), Y(feet) + sk.displayHeight / 2, 8);
        m.scale.set(sk.displayWidth * (sk.flipX ? -1 : 1), sk.displayHeight, 1);
        m.material.color.set(av.dead ? 0xff7070 : 0xffffff);
      } else {
        m.position.set(X(sk.x), Y(feet), 8);
        m.scale.set(sk.scaleX / (av.baseSX || 1), sk.scaleY / (av.baseSY || 1), 1);
        m.rotation.y = av.facing > 0 ? 0.45 : -0.45;
        m.userData.body.material.color.set(av.dead ? 0xef4444 : av.color);
      }
    }
    for (const [av, m] of avatarMeshes) if (!seen.has(av)) { scene3.remove(m); avatarMeshes.delete(av); }

    // camera: behind and a little above the main character, easing after it; a hit shakes it like the 2D camera
    const main = s.avatars?.[0];
    const tx = main ? X(main.obj.x) : 0, ty = main ? Y(main.obj.y) : H / 2;
    if (!camPos.ready) { camPos.x = tx; camPos.y = ty; camPos.ready = true; }
    camPos.x += (tx + (s.lookAhead || 0) - camPos.x) * 0.08;
    camPos.y += (ty - camPos.y) * 0.08;
    const shake = s.cameras.main.shakeEffect?.isRunning ? (Math.random() - 0.5) * 14 : 0;
    const dist = Math.max(620, Math.min(980, 760 * (camera.aspect < 1 ? 1.25 : 1)));
    camera.position.set(camPos.x + shake, camPos.y + 170 + shake, dist);
    camera.lookAt(camPos.x, camPos.y + 30, 0);
    sun.position.set(camPos.x - 500, camPos.y + 900, 700);
    sun.target.position.set(camPos.x, camPos.y, 0);
    renderer.render(scene3, camera);
  }

  /** Switch the 3D view on or off. host = the element that holds the Phaser canvas. Returns a promise. */
  async function setOn(want, host, s, ctx) {
    on = !!want;
    const phaserCanvas = host.querySelector("canvas:not(#view3d)");
    if (!on) { if (canvas) canvas.style.display = "none"; if (phaserCanvas) phaserCanvas.style.visibility = ""; return false; }
    await load();
    if (!on) return false;           // switched back while three.js was loading
    ensureRenderer(host);
    canvas.style.display = "block";
    if (phaserCanvas) phaserCanvas.style.visibility = "hidden";
    if (s && ctx) build(s, ctx);
    return true;
  }

  return { setOn, build, sync, load, setModel, get on() { return on; }, get ready() { return !!THREE; }, get model() { return !!playerModel; },
    debug: () => ({ model: !!playerModel, meshes: [...avatarMeshes.values()].map((m) => ({ model: !!m.userData.model, sprite: !!m.userData.sprite, kids: m.children.length })) }) };
})();
