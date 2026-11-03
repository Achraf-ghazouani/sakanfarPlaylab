// shared/play.js — the play page (/play/<id>, served by api/play.js with window.PLAY = { id, title, author, kind }).
// Loads the published game into the right engine (a game written as code into the sandbox, shared/coderun.mjs), counts a play, likes, the share sheet (Web Share, copy, QR),
// phones as controllers (PhoneLink host, like the Studio), and the report form. No account needed.
(() => {
  const $ = (id) => document.getElementById(id);
  const P = window.PLAY; if (!P) return;
  function toast(text, ms = 2500) { const t = $("toast"); t.textContent = text; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms); }
  async function api(path, body) {
    const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d;
  }
  // who likes and reports: the login id when there is one, otherwise a token this browser keeps
  let voter = null;
  try { voter = localStorage.getItem("playlab.voter"); if (!voter) { voter = crypto.randomUUID().replace(/-/g, ""); localStorage.setItem("playlab.voter", voter); } } catch { voter = crypto.randomUUID().replace(/-/g, ""); }

  const iframe = $("game"), url = location.origin + "/play/" + P.id;
  let game = null, ready = false, counted = false, host = null, code = null;
  const toGame = (msg) => { try { if (code) code.send(msg); else iframe?.contentWindow?.postMessage(msg, "*"); } catch {} };
  const isCode = () => game?.level?.genre === "code";
  function countPlay() { $("loading").style.display = "none"; if (!counted) { counted = true; api("/api/play", { action: "played", id: P.id }).then((d) => { if (d.plays) $("plays").textContent = d.plays; }).catch(() => {}); } }
  /** The person's pictures for PlayLab.assets.get(role) inside a game written as code (the same roles as in the Studio). */
  function codeAssets(art = {}) {
    const out = {};
    if (art.player) out.player = { src: art.player, kind: "image", name: "player" };
    for (const [role, src] of Object.entries(art.sprites || {})) if (src) out[role] = { src, kind: "image", name: role };
    for (const a of art.assets || []) if (a?.src && a.role && !out[a.role]) out[a.role] = { src: a.src, kind: "image", name: a.name || a.role, width: a.width, height: a.height };
    if (art.model?.src) out[art.model.role || "player"] = { src: art.model.src, kind: "model", name: art.model.name || "model" };
    return out;
  }
  /** A game written as code: its HTML runs in the sandbox (shared/coderun.mjs, no origin, strict policy), the SDK inside talks back. */
  function mountCode() {
    if (!window.CodeRun) { setTimeout(mountCode, 100); return; }   // the module scripts run after this one
    code = CodeRun.mount(iframe, game.level.html, { assets: codeAssets(game.art || {}), on: (m) => {
      if (m.type === "playlab:ready") { ready = true; countPlay(); if (host) syncPlayers(); }
      else if (m.type === "playlab:state" && m.state) { window.__playState = m.state; host?.broadcast(m.state); $("codePause").textContent = m.state.state === "paused" ? "\u25B6 Resume" : "\u275A\u275A Pause"; }
      else if (m.type === "playlab:event") host?.event(m.name || m.kind, m.slot);
      else if (m.type === "playlab:error" && !ready) $("loading").textContent = "This game hit an error: " + m.message;
    } });
    // restart and pause over the game, like the Studio's bar (the phones have the same menu)
    const bar = document.createElement("span"); bar.id = "codeBar"; bar.style.cssText = "display:inline-flex;gap:6px";
    bar.innerHTML = '<button class="tb" id="codeRestart" title="Restart">\u21BB <span class="lbl">Restart</span></button><button class="tb" id="codePause" title="Pause">\u275A\u275A Pause</button>';
    $("phonesBtn").before(bar);
    $("codeRestart").addEventListener("click", () => toGame({ type: "playlab:menu", action: "restart" }));
    $("codePause").addEventListener("click", () => toGame({ type: "playlab:menu", action: "toggle-pause" }));
  }
  function pushGame() {
    if (!ready || !game || isCode()) return;
    toGame({ type: "playlab:level", level: game.level, name: game.title, thumb: game.photo || null, player: game.art?.player || null, sprites: game.art?.sprites || null, mode: game.kind === "3d" ? "3d" : "2d" });
    countPlay();
  }
  window.addEventListener("message", (e) => {
    const m = e.data; if (!m || typeof m !== "object" || code) return;   // a game written as code answers through CodeRun
    if (m.type === "playlab:ready") { ready = true; pushGame(); if (host) syncPlayers(); }
    else if (m.type === "playlab:state" && m.state) host?.broadcast(m.state);
    else if (m.type === "playlab:event") host?.event(m.name, m.slot);
  });
  (async () => {
    try { ({ game } = await api(`/api/play?id=${encodeURIComponent(P.id)}&format=json`)); }
    catch (err) { $("loading").textContent = "Could not load this game: " + err.message; return; }
    $("plays").textContent = game.plays; $("likes").textContent = game.likes;
    if (isCode()) mountCode();
    else { $("loading").textContent = "This game was made with PlayLab's classic engine, which is retired. Remix it in the Studio to rebuild it with AI code."; }
    try { setLiked((await api(`/api/play?id=${encodeURIComponent(P.id)}&liked=${encodeURIComponent(voter)}`)).liked); } catch {}
    window.__play = { game: () => game, ready: () => ready, host: () => host, code: () => code, toGame };
  })();

  // like
  function setLiked(on) { $("likeIcon").innerHTML = on ? "&#9829;" : "&#9825;"; $("likeBtn").classList.toggle("on", !!on); }
  $("likeBtn").addEventListener("click", async () => {
    try { const d = await api("/api/play", { action: "like", id: P.id, voter }); setLiked(d.liked); $("likes").textContent = d.likes; toast(d.liked ? "Liked!" : "Like removed"); }
    catch (err) { toast(err.message); }
  });

  // modals
  const modal = (id, show) => $(id).classList.toggle("show", show);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest(".modal").classList.remove("show")));
  document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("show"); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".modal.show").forEach((m) => m.classList.remove("show")); });

  // share: the link, copy, the device's share sheet, a QR code
  $("shareBtn").addEventListener("click", () => {
    $("shareUrl").value = url;
    if (window.qrcode) { const qr = qrcode(0, "M"); qr.addData(url); qr.make(); $("shareQr").innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }); }
    $("webShareBtn").hidden = !navigator.share;
    modal("shareModal", true);
  });
  $("copyBtn").addEventListener("click", async () => { try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { $("shareUrl").select(); toast("Press Ctrl+C to copy"); } });
  $("webShareBtn").addEventListener("click", () => navigator.share({ title: P.title, text: `Play "${P.title}" by ${P.author} on PlayLab`, url }).catch(() => {}));

  // phones as controllers: this page hosts the room, the game gets the input, the phones get the state
  function syncPlayers() {
    const pads = host ? [...host.players.values()].filter((p) => p.mode === "pad").map(({ slot, color, name }) => ({ slot, color, name })) : [];
    toGame({ type: "playlab:players", players: pads });
    $("phonePlayers").innerHTML = pads.length ? pads.map((p) => `<span class="pl"><i style="background:${p.color}"></i>player ${p.slot}</span>`).join("") : "waiting for a phone to scan the code...";
  }
  function startHost() {
    if (host) return;
    if (!window.PhoneLink || !window.Peer || !window.qrcode) { setTimeout(startHost, 300); return; }
    host = new PhoneLink.Host({
      onCode: (code) => { const u = host.url(); const qr = qrcode(0, "M"); qr.addData(u); qr.make(); $("phoneQr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); $("phoneCode").textContent = code; },
      welcome: () => ({ mode: "pad" }),
      onJoin: syncPlayers, onMode: syncPlayers,
      onLeave: (p) => { for (const m of PadRoute.releaseAll(p.slot)) toGame(m); syncPlayers(); },
      // every phone message through the shared route (shared/padroute.mjs): the engines and games written as code read the same messages
      onInput: (p, input) => { for (const m of PadRoute.toGame(p.slot, { t: "input", ...input })) toGame(m); },
      onJump: (p, down) => { for (const m of PadRoute.toGame(p.slot, { t: "jump", down })) toGame(m); },
      onMessage: (p, msg) => { for (const m of PadRoute.toGame(p.slot, msg)) toGame(m); },
    });
    fetch("/api/config", { cache: "no-store" }).then((r) => r.json()).then((c) => { if (c.relay && host) host.startRelay(c.relay); }).catch(() => {});
    host.start();
    toGame({ type: "playlab:state" });
  }
  $("phonesBtn").addEventListener("click", () => { modal("phonesModal", true); startHost(); });
  window.addEventListener("pagehide", () => { try { host?.destroy(); } catch {} });

  // report
  $("reportBtn").addEventListener("click", () => modal("reportModal", true));
  $("reportSend").addEventListener("click", async () => {
    try { await api("/api/play", { action: "report", id: P.id, reason: $("reportReason").value, details: $("reportDetails").value, reporter: voter }); modal("reportModal", false); $("reportDetails").value = ""; toast("Thanks. We will look at it."); }
    catch (err) { toast(err.message); }
  });
})();
