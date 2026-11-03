// shared/code-examples.mjs — three complete games written the PlayLab way (plain canvas, Phaser 3, three.js). They are the
// examples in Muse Wonder's system prompt (lib/code.mjs) and the games tests/sdk.test.mjs runs through the sandbox, so
// what the model is shown is proven to work. No backticks or ${ inside: they are template strings.

export const EXAMPLES = {};

EXAMPLES.snake = `<!doctype html>
<!-- playlab {"note":"snake on a 20 x 20 grid","built":"Steer the snake with the d-pad or the arrow keys, eat apples to grow; hitting a wall or yourself ends the round, A plays again.","missing":""} -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Snake</title>
<style>html, body { margin:0; height:100%; background:#101828; overflow:hidden; display:grid; place-items:center; } canvas { width:min(100vw, 100vh); height:min(100vw, 100vh); }</style>
</head>
<body>
<canvas id="c" width="400" height="400"></canvas>
<script>
const cv = document.getElementById("c"), ctx = cv.getContext("2d"), N = 20, CELL = 20;
let snake, dir, next, apple, score, dead, acc = 0, last = 0, help = true;
PlayLab.controller({ type: "dpad+jump" });
function reset() { snake = [[10, 10], [9, 10], [8, 10]]; dir = [1, 0]; next = dir; score = 0; dead = false; placeApple(); PlayLab.hud.set({ score: 0, text: help ? "arrows / d-pad to steer" : "" }); PlayLab.start(); }
function placeApple() { do { apple = [Math.floor(Math.random() * N), Math.floor(Math.random() * N)]; } while (snake.some(([x, y]) => x === apple[0] && y === apple[1])); }
PlayLab.onRestart(reset);
PlayLab.onResume(() => { last = 0; });
function step() {
  dir = next;
  const head = [snake[0][0] + dir[0], snake[0][1] + dir[1]];
  if (head[0] < 0 || head[1] < 0 || head[0] >= N || head[1] >= N || snake.some(([x, y]) => x === head[0] && y === head[1])) { dead = true; PlayLab.event("lose"); PlayLab.gameOver({ win: false, score }); return; }
  snake.unshift(head);
  if (head[0] === apple[0] && head[1] === apple[1]) { score++; PlayLab.hud.set({ score }); PlayLab.event("coin"); placeApple(); } else snake.pop();
}
function frame(t) {
  requestAnimationFrame(frame);
  const ax = PlayLab.input.axis(1, "x"), ay = PlayLab.input.axis(1, "y");
  if (ax > 0.5 && dir[0] !== -1) next = [1, 0]; else if (ax < -0.5 && dir[0] !== 1) next = [-1, 0]; else if (ay > 0.5 && dir[1] !== -1) next = [0, 1]; else if (ay < -0.5 && dir[1] !== 1) next = [0, -1];
  if (help && (ax || ay)) { help = false; PlayLab.hud.set({ text: "" }); }
  if (dead && PlayLab.input.pressed(1, "A")) reset();
  if (!PlayLab.paused && !dead) { if (last) acc += t - last; if (acc > 140) { acc = 0; step(); } }
  last = t;
  ctx.fillStyle = "#101828"; ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = "#1f2937"; for (let i = 0; i <= N; i++) { ctx.fillRect(i * CELL, 0, 1, 400); ctx.fillRect(0, i * CELL, 400, 1); }
  ctx.fillStyle = "#ef4444"; ctx.fillRect(apple[0] * CELL + 3, apple[1] * CELL + 3, CELL - 6, CELL - 6);
  snake.forEach(([x, y], i) => { ctx.fillStyle = i ? "#22c55e" : "#86efac"; ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2); });
  if (dead) { ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(0, 150, 400, 100); ctx.fillStyle = "#fff"; ctx.font = "bold 26px system-ui"; ctx.textAlign = "center"; ctx.fillText("Game over - " + score, 200, 190); ctx.font = "16px system-ui"; ctx.fillText("A / Space to play again", 200, 222); }
  if (PlayLab.paused) { ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(0, 170, 400, 60); ctx.fillStyle = "#fff"; ctx.font = "bold 24px system-ui"; ctx.textAlign = "center"; ctx.fillText("Paused", 200, 208); }
}
reset();
requestAnimationFrame(frame);
</script>
</body>
</html>`;

EXAMPLES.phaser = `<!doctype html>
<!-- playlab {"note":"star catcher, falling rocks","built":"Move the ship left and right to catch stars and dodge rocks. 3 lives, the rain speeds up over time; A plays again after a game over.","missing":""} -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Star Catcher</title>
<style>html, body { margin:0; height:100%; background:#0b1020; overflow:hidden; }</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/phaser/3.80.1/phaser.min.js"></script>
</head>
<body>
<script>
const W = 960, H = 540;
class Main extends Phaser.Scene {
  constructor() { super("main"); }
  preload() {
    const a = PlayLab.assets.get("player");                       // the person's own picture, if they uploaded one
    if (a && a.kind === "image") this.load.image("hero", a.src);
  }
  create() {
    PlayLab.controller({ type: "dpad+jump" });
    // every texture is drawn in code: no files
    const g = this.add.graphics();
    g.fillStyle(0x7c5cff).fillRoundedRect(0, 0, 60, 30, 8).generateTexture("ship", 60, 30);
    g.clear().fillStyle(0xffd166).fillCircle(12, 12, 12).generateTexture("star", 24, 24);
    g.clear().fillStyle(0x8d99ae).fillCircle(16, 16, 16).generateTexture("rock", 32, 32);
    g.destroy();
    this.ship = this.physics.add.image(W / 2, H - 50, this.textures.exists("hero") ? "hero" : "ship").setCollideWorldBounds(true);
    if (this.textures.exists("hero")) this.ship.setDisplaySize(64, 64);
    this.stars = this.physics.add.group(); this.rocks = this.physics.add.group();
    this.physics.add.overlap(this.ship, this.stars, (s, star) => { star.destroy(); this.score++; PlayLab.event("coin"); PlayLab.hud.set({ score: this.score }); });
    this.physics.add.overlap(this.ship, this.rocks, (s, rock) => { rock.destroy(); this.lives--; PlayLab.event("hit"); PlayLab.hud.set({ lives: this.lives }); if (this.lives <= 0) this.end(); });
    this.time.addEvent({ delay: 700, loop: true, callback: () => { if (!this.over && !PlayLab.paused) this.spawn(); } });
    this.msg = this.add.text(W / 2, H / 2, "", { font: "bold 36px sans-serif", color: "#ffffff", align: "center" }).setOrigin(0.5);
    PlayLab.onRestart(() => this.reset());
    PlayLab.onPause(() => this.physics.pause());
    PlayLab.onResume(() => { if (!this.over) this.physics.resume(); });
    this.reset();
  }
  reset() {
    this.score = 0; this.lives = 3; this.over = false; this.speed = 1;
    this.stars.clear(true, true); this.rocks.clear(true, true);
    this.msg.setText(""); this.physics.resume();
    PlayLab.hud.set({ score: 0, lives: 3, text: "left / right to move" });
    PlayLab.start();
  }
  spawn() {
    const x = Phaser.Math.Between(20, W - 20), rock = Math.random() < 0.4;
    const s = rock ? this.rocks.create(x, -20, "rock") : this.stars.create(x, -20, "star");
    s.setVelocityY((rock ? 260 : 200) * this.speed); this.speed += 0.01;
  }
  end() { this.over = true; this.physics.pause(); this.msg.setText("Game over - score " + this.score + "\\nA / Space to play again"); PlayLab.gameOver({ win: false, score: this.score }); }
  update() {
    if (this.over) { if (PlayLab.input.pressed(1, "A")) this.reset(); return; }
    if (PlayLab.paused) return;
    const x = PlayLab.input.axis(1, "x");
    if (x) PlayLab.hud.set({ text: "" });
    this.ship.setVelocityX(x * 420);
    this.stars.children.each((s) => { if (s.y > H + 20) s.destroy(); });
    this.rocks.children.each((r) => { if (r.y > H + 20) r.destroy(); });
  }
}
new Phaser.Game({ type: Phaser.AUTO, width: W, height: H, backgroundColor: "#0b1020", parent: document.body, physics: { default: "arcade" }, input: { keyboard: false }, scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH }, scene: Main });
</script>
</body>
</html>`;

EXAMPLES.three = `<!doctype html>
<!-- playlab {"note":"ring flight, 60 seconds","built":"Fly the plane with the stick or arrows, hold A to boost, and pass through as many golden rings as you can in 60 seconds. 10 rings wins.","missing":""} -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ring Flight</title>
<style>html, body { margin:0; height:100%; background:#87ceeb; overflow:hidden; } canvas { display:block; }</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
</head>
<body>
<script type="module">
import * as THREE from "three";
PlayLab.controller({ type: "stick+2buttons" });
const scene = new THREE.Scene(); scene.fog = new THREE.Fog(0x87ceeb, 60, 400);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 600);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight); document.body.appendChild(renderer.domElement);
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
scene.add(new THREE.HemisphereLight(0xffffff, 0x446644, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(50, 100, 20); scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshLambertMaterial({ color: 0x3a8f3a }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -20; scene.add(ground);
const plane = new THREE.Group();
const body = new THREE.Mesh(new THREE.ConeGeometry(1, 4, 8), new THREE.MeshLambertMaterial({ color: 0xff5533 })); body.rotation.x = -Math.PI / 2; plane.add(body);
plane.add(new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 1.2), new THREE.MeshLambertMaterial({ color: 0xffffff })));
scene.add(plane);
const ringGeo = new THREE.TorusGeometry(5, 0.4, 8, 24), gold = new THREE.MeshLambertMaterial({ color: 0xffd700 }), green = new THREE.MeshLambertMaterial({ color: 0x33ff66 });
const rings = [];
for (let i = 0; i < 12; i++) { const r = new THREE.Mesh(ringGeo, gold); rings.push(r); scene.add(r); }
let score, timeLeft, over, help;
function placeRing(r, z) { r.position.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 16, z); r.userData.done = false; r.material = gold; }
function reset() {
  score = 0; timeLeft = 60; over = false; help = true; plane.position.set(0, 0, 0);
  rings.forEach((r, i) => placeRing(r, -60 - i * 40));
  PlayLab.hud.set({ score: 0, timer: 60, text: "stick / arrows to fly, A = boost" });
  PlayLab.start();
}
PlayLab.onRestart(reset);
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!PlayLab.paused && !over) {
    const ax = PlayLab.input.axis(1, "x"), ay = PlayLab.input.axis(1, "y"), boost = PlayLab.input.button(1, "A") ? 1.6 : 1;
    if (help && (ax || ay)) { help = false; PlayLab.hud.set({ text: "" }); }
    plane.position.x = THREE.MathUtils.clamp(plane.position.x + ax * 25 * dt, -20, 20);
    plane.position.y = THREE.MathUtils.clamp(plane.position.y - ay * 20 * dt, -12, 12);
    plane.position.z -= 40 * boost * dt;
    plane.rotation.z = -ax * 0.6; plane.rotation.x = -ay * 0.3;
    timeLeft -= dt; PlayLab.hud.set({ timer: Math.ceil(timeLeft) });
    for (const r of rings) {
      if (!r.userData.done && Math.abs(r.position.z - plane.position.z) < 1.5) {
        r.userData.done = true;
        if (plane.position.distanceTo(r.position) < 5) { score++; r.material = green; PlayLab.event("coin"); PlayLab.hud.set({ score }); }
      }
      if (r.position.z > plane.position.z + 20) placeRing(r, r.position.z - 12 * 40);
    }
    if (timeLeft <= 0) { over = true; PlayLab.hud.set({ timer: 0, text: "Time! A to fly again" }); PlayLab.gameOver({ win: score >= 10, score }); }
  } else if (over && PlayLab.input.pressed(1, "A")) reset();
  camera.position.set(plane.position.x * 0.6, plane.position.y * 0.6 + 4, plane.position.z + 14);
  camera.lookAt(plane.position.x, plane.position.y, plane.position.z - 10);
  renderer.render(scene, camera);
}
reset();
frame();
</script>
</body>
</html>`;
