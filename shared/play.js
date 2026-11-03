// shared/play.js — the play page (/play/<id>, served by api/play.js with window.PLAY = { id, title, author, kind }).
// Loads the published game into the right engine, counts a play, likes, the share sheet (Web Share, copy, QR),
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
  let game = null, ready = false, counted = false, host = null;
  const toGame = (msg) => { try { iframe?.contentWindow?.postMessage(msg, "*"); } catch {} };
  function pushGame() {
    if (!ready || !game) return;
    toGame({ type: "playlab:level", level: game.level, name: game.title, thumb: game.photo || null, player: game.art?.player || null, sprites: game.art?.sprites || null, mode: game.kind === "3d" ? "3d" : "2d" });
    $("loading").style.display = "none";
    if (!counted) { counted = true; api("/api/play", { action: "played", id: P.id }).then((d) => { if (d.plays) $("plays").textContent = d.plays; }).catch(() => {}); }
  }
  window.addEventListener("message", (e) => {
    const m = e.data; if (!m || typeof m !== "object") return;
    if (m.type === "playlab:ready") { ready = true; pushGame(); if (host) syncPlayers(); }
    else if (m.type === "playlab:state" && m.state) host?.broadcast(m.state);
    else if (m.type === "playlab:event") host?.event(m.name, m.slot);
  });
  (async () => {
    try { ({ game } = await api(`/api/play?id=${encodeURIComponent(P.id)}&format=json`)); }
    catch (err) { $("loading").textContent = "Could not load this game: " + err.message; return; }
    $("plays").textContent = game.plays; $("likes").textContent = game.likes;
    iframe.src = game.kind === "arena" ? "/arena.html?embed=1" : "/game.html?embed=1";
    pushGame();
    try { setLiked((await api(`/api/play?id=${encodeURIComponent(P.id)}&liked=${encodeURIComponent(voter)}`)).liked); } catch {}
    window.__play = { game: () => game, ready: () => ready, host: () => host };
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
      onLeave: (p) => { toGame({ type: "playlab:input", slot: p.slot, l: 0, r: 0 }); toGame({ type: "playlab:jump", slot: p.slot, down: false }); toGame({ type: "playlab:stick", slot: p.slot, m: [0, 0], a: [0, 0] }); toGame({ type: "playlab:fire", slot: p.slot, down: false }); syncPlayers(); },
      onInput: (p, input) => toGame({ type: "playlab:input", slot: p.slot, l: input.l, r: input.r }),
      onJump: (p, down) => toGame({ type: "playlab:jump", slot: p.slot, down }),
      onMessage: (p, msg) => { if (msg.t === "menu") toGame({ type: "playlab:menu", action: msg.action }); else if (msg.t === "stick") toGame({ type: "playlab:stick", slot: p.slot, m: msg.m, a: msg.a }); else if (msg.t === "fire") toGame({ type: "playlab:fire", slot: p.slot, down: !!msg.down }); },
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
