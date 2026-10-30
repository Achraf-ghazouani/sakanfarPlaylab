// shared/phonelink.js — phone <-> big screen link over PeerJS (WebRTC).
// Host = game.html on the computer, Client = pad.html on the phone. Classic script: window.PhoneLink.
//
// Data messages (JSON):
//   phone -> game : { t:"input", l:0|1, r:0|1 }   { t:"jump", down:bool }   { t:"ping" }   { t:"mode", mode:"camera"|"pad" }
//   game  -> phone: { t:"welcome", slot, color, name, mode }   { t:"event", name }   { t:"pong" }   { t:"full" }
// Live video: the phone places a one-way PeerJS media call to the game (its camera canvas stream);
// the game answers without a stream and shows it.
window.PhoneLink = (() => {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";          // no 0/O/1/I confusion
  const COLORS = [["green", "#22c55e"], ["blue", "#3b82f6"], ["orange", "#f97316"], ["pink", "#ec4899"]];
  const MAX_PLAYERS = 4;
  const CONNECT_TIMEOUT_MS = 5000;
  const RETRY_MS = 2000;
  const randomCode = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
  const peerId = (code) => "sakanfar-playlab-" + String(code).toUpperCase();
  const PEER_OPTS = { debug: 0, config: { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] } };

  /** The game side: owns the room code, accepts phones, hands out player slots, receives video. */
  class Host {
    constructor(handlers = {}) {
      this.h = handlers; this.code = null; this.peer = null; this.status = "idle";
      this.players = new Map();   // slot -> { conn, slot, color, name, peerId, mode, input, lastSeen, stream, call }
      // Phones ping every 3 s. A phone silent for 8 s (screen off, network gone) is dropped right away
      // instead of waiting for WebRTC to notice.
      this.watchdog = setInterval(() => {
        for (const p of [...this.players.values()]) if (Date.now() - p.lastSeen > 8000) { try { p.conn.close(); } catch {} this.drop(p); }
      }, 2000);
    }
    start(code) {
      if (this.peer && !this.peer.destroyed) { try { this.peer.destroy(); } catch {} }
      this.code = (code || randomCode()).toUpperCase();
      this.h.onCode?.(this.code);
      this.setStatus("connecting");
      const peer = this.peer = new Peer(peerId(this.code), PEER_OPTS);
      peer.on("open", () => { this.idRetries = 0; this.setStatus(this.players.size ? "connected" : "waiting"); });
      peer.on("connection", (conn) => this.accept(conn));
      peer.on("call", (call) => {
        // One-way video from a phone. Match it to the player by peer id (phones call only after "welcome").
        const p = [...this.players.values()].find((q) => q.peerId === call.peer);
        call.answer();
        call.on("stream", (stream) => { if (p) { p.stream = stream; p.call = call; this.h.onStream?.(p, stream); } });
        const ended = () => { if (p && p.call === call) { p.stream = null; p.call = null; this.h.onStreamEnd?.(p); } };
        call.on("close", ended);
        call.on("error", ended);
      });
      peer.on("disconnected", () => { if (!peer.destroyed) { this.setStatus("reconnecting"); setTimeout(() => { try { peer.reconnect(); } catch {} }, 1000); } });
      peer.on("error", (err) => {
        const t = err.type;
        if (t === "unavailable-id") {
          // After a page reload the server may still hold our id for a moment: retry the same code a few
          // times (so the phone can reconnect to the same room), then give up and pick a fresh one.
          this.idRetries = (this.idRetries || 0) + 1;
          const next = this.idRetries <= 4 ? this.code : randomCode();
          this.setStatus("connecting", "room busy, retrying");
          setTimeout(() => this.start(next), 1500);
          return;
        }
        if (["server-error", "socket-error", "socket-closed", "network"].includes(t)) {
          this.setStatus("reconnecting", t);
          if (peer.destroyed) setTimeout(() => this.start(this.code), 2500);   // fatal for PeerJS: make a new peer
          return;
        }
        this.setStatus("error", t);
      });
      return this.code;
    }
    accept(conn) {
      const slot = [1, 2, 3, 4].find((s) => !this.players.has(s));
      if (!slot) { conn.on("open", () => { conn.send({ t: "full" }); setTimeout(() => conn.close(), 500); }); return; }
      const [name, color] = COLORS[slot - 1];
      const p = { conn, slot, color, name, peerId: conn.peer, mode: "pad", input: { l: 0, r: 0 }, lastSeen: Date.now(), stream: null, call: null };
      this.players.set(slot, p);
      const bye = () => this.drop(p);
      conn.on("open", () => {
        p.lastSeen = Date.now();
        const extra = this.h.welcome?.(p) || {};          // the game decides e.g. mode: "camera" | "pad"
        if (extra.mode) p.mode = extra.mode;
        conn.send({ t: "welcome", slot, color, name, ...extra });
        this.setStatus("connected");
        this.h.onJoin?.(p);
      });
      conn.on("data", (msg) => this.onData(p, msg));
      conn.on("close", bye);
      conn.on("error", bye);
    }
    onData(p, msg) {
      p.lastSeen = Date.now();
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "input") { p.input = { l: msg.l ? 1 : 0, r: msg.r ? 1 : 0 }; this.h.onInput?.(p, p.input); }
      else if (msg.t === "jump") this.h.onJump?.(p, !!msg.down);
      else if (msg.t === "ping") { if (p.conn.open) p.conn.send({ t: "pong" }); }
      else if (msg.t === "mode") { p.mode = msg.mode === "camera" ? "camera" : "pad"; this.h.onMode?.(p, p.mode); }
      else this.h.onMessage?.(p, msg);
    }
    drop(p) {
      if (this.players.get(p.slot) !== p) return;
      this.players.delete(p.slot);
      if (p.stream) { p.stream = null; p.call = null; this.h.onStreamEnd?.(p); }
      this.h.onLeave?.(p);
      this.setStatus(this.players.size ? "connected" : "waiting");
    }
    send(slot, msg) { const p = this.players.get(slot); if (p?.conn.open) p.conn.send(msg); }
    broadcast(msg) { for (const p of this.players.values()) if (p.conn.open) p.conn.send(msg); }
    /** Game event for vibration on the phone(s): "jump" | "coin" | "hit" | "goal" | "level". */
    event(name, slot) { const msg = { t: "event", name }; if (slot) this.send(slot, msg); else this.broadcast(msg); }
    get count() { return this.players.size; }
    url(base = location.href) { const u = new URL("pad.html", base); u.search = "?room=" + this.code; return u.href; }
    setStatus(status, detail) { this.status = status; this.h.onStatus?.(status, detail); }
    destroy() { clearInterval(this.watchdog); try { this.peer?.destroy(); } catch {} this.players.clear(); }
  }

  /** The phone side: joins a room by code, retries forever, reports status, can stream video. */
  class Client {
    constructor(code, handlers = {}) {
      this.code = String(code || "").toUpperCase(); this.h = handlers;
      this.peer = null; this.conn = null; this.status = "idle"; this.stopped = false;
      this.input = { l: 0, r: 0 }; this.hb = null; this.retryTimer = null; this.attempts = 0;
      this.stream = null; this.call = null;
    }
    start() {
      this.stopped = false;
      this.setStatus("connecting");
      if (this.peer && !this.peer.destroyed) { if (this.peer.disconnected) this.peer.reconnect(); else if (this.peer.open) this.open(); return; }
      const peer = this.peer = new Peer(PEER_OPTS);
      peer.on("open", () => this.open());
      peer.on("disconnected", () => { if (!this.stopped) { this.setStatus("reconnecting"); this.retry(); } });
      peer.on("error", (err) => {
        if (this.stopped) return;
        this.setStatus("reconnecting", err.type === "peer-unavailable" ? "waiting for the game" : err.type);
        this.retry();
      });
    }
    open() {
      if (this.stopped || !this.peer?.open) return;
      try { this.conn?.close(); } catch {}
      this.attempts++;
      const conn = this.conn = this.peer.connect(peerId(this.code), { reliable: true, serialization: "json" });
      const deadline = setTimeout(() => {
        if (conn.open) return;
        this.setStatus("reconnecting", "timeout");
        try { conn.close(); } catch {}
        this.h.onTimeout?.(this.attempts);
        this.retry();
      }, CONNECT_TIMEOUT_MS);
      conn.on("open", () => { clearTimeout(deadline); this.attempts = 0; this.lastPong = Date.now(); this.setStatus("connected"); this.sendInput(this.input, true); this.heartbeat(); });
      conn.on("data", (msg) => {
        if (!msg || typeof msg !== "object") return;
        this.lastPong = Date.now();
        if (msg.t === "welcome") { this.h.onWelcome?.(msg); if (this.stream) this.placeCall(); }
        else if (msg.t === "event") this.h.onEvent?.(msg.name);
        else if (msg.t === "full") { this.setStatus("error", "room is full (4 players)"); this.stop(); }
      });
      const dropped = () => { clearTimeout(deadline); if (!this.stopped) { this.setStatus("reconnecting"); this.retry(); } };
      conn.on("close", dropped);
      conn.on("error", dropped);
    }
    retry() {
      clearTimeout(this.retryTimer);
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => {
        if (this.stopped) return;
        if (!this.peer || this.peer.destroyed) this.start();
        else if (this.peer.disconnected) this.peer.reconnect();
        else if (this.peer.open) this.open();
      }, RETRY_MS);
    }
    heartbeat() {
      clearInterval(this.hb);
      this.hb = setInterval(() => {
        if (!this.conn?.open) return;
        this.conn.send({ t: "ping" });
        if (Date.now() - this.lastPong > 9000) { this.setStatus("reconnecting", "no answer"); this.open(); }   // game silent: redial
      }, 3000);
    }
    /** Stream a MediaStream (camera canvas) to the game. Re-placed automatically after reconnects. */
    startVideo(stream) { this.stream = stream; this.placeCall(); }
    stopVideo() { this.stream = null; try { this.call?.close(); } catch {} this.call = null; }
    placeCall() {
      if (!this.stream || !this.peer?.open || !this.conn?.open) return;
      try { this.call?.close(); } catch {}
      const call = this.call = this.peer.call(peerId(this.code), this.stream);
      call.on("close", () => { if (this.call === call) this.call = null; });
      call.on("error", () => { if (this.call === call) this.call = null; });
      this.h.onVideo?.(true);
    }
    sendInput(state, force) {
      const next = { l: state.l ? 1 : 0, r: state.r ? 1 : 0 };
      if (!force && next.l === this.input.l && next.r === this.input.r) return;
      this.input = next;
      if (this.conn?.open) this.conn.send({ t: "input", ...next });
    }
    sendJump(down) { if (this.conn?.open) this.conn.send({ t: "jump", down: !!down }); }
    sendMode(mode) { if (this.conn?.open) this.conn.send({ t: "mode", mode }); }
    send(msg) { if (this.conn?.open) this.conn.send(msg); }
    get connected() { return !!this.conn?.open; }
    setStatus(status, detail) { this.status = status; this.h.onStatus?.(status, detail); }
    stop() { this.stopped = true; clearInterval(this.hb); clearTimeout(this.retryTimer); this.stopVideo(); try { this.conn?.close(); } catch {} }
  }

  return { Host, Client, randomCode, COLORS, MAX_PLAYERS };
})();
