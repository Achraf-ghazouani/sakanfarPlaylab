// shared/phonelink.js — phone <-> big screen link. Classic script: window.PhoneLink.
// Host = the Studio or the play page on the computer, Client = pad.html on the phone.
//
// Transports
//   1. WebRTC data channels through PeerJS (low latency, also carries the live video as a media call).
//   2. Relay: Supabase Realtime Broadcast on channel "playlab-<CODE>" (event "msg", payload { from, to, msg }).
//      The host listens on both. A phone falls back to the relay when WebRTC has not connected within 5 s.
//      The relay carries controls only (no video).
//
// Data messages (JSON):
//   phone -> game : { t:"hello" } (relay only)  { t:"input", l:0|1, r:0|1 }  { t:"jump", down:bool }  { t:"ping" }  { t:"mode", mode:"camera"|"pad" }
//                   { t:"menu", action:"restart"|"toggle-pause"|"mute" }  { t:"ink" | "level", ... } (camera mode, via sendLarge)
//   game  -> phone: { t:"welcome", slot, color, name, mode, transport }  { t:"event", name }  { t:"pong" }  { t:"full" }
//                   { t:"state", level, theme, state, coins, total, muted, players, layout }
window.PhoneLink = (() => {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";          // no 0/O/1/I confusion
  const COLORS = [["green", "#22c55e"], ["blue", "#3b82f6"], ["orange", "#f97316"], ["pink", "#ec4899"]];
  const MAX_PLAYERS = 4;
  const CONNECT_TIMEOUT_MS = 5000;
  const RETRY_MS = 2000;
  const randomCode = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
  const peerId = (code) => "sakanfar-playlab-" + String(code).toUpperCase();
  const channelName = (code) => "playlab-" + String(code).toUpperCase();
  const peerOpts = (peerHost) => {
    const o = { debug: 0, config: { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] } };
    if (peerHost) { o.host = peerHost; o.port = 443; o.secure = true; }   // tests: point at a dead server to force the fallback
    return o;
  };
  const makeSupabase = (cfg) => (cfg?.url && cfg?.key && window.supabase?.createClient)
    ? window.supabase.createClient(cfg.url, cfg.key, { realtime: { params: { eventsPerSecond: 40 } } })
    : null;

  /** The game side: owns the room code, accepts phones (WebRTC and relay), hands out player slots, receives video. */
  class Host {
    constructor(handlers = {}) {
      this.h = handlers; this.code = null; this.peer = null; this.status = "idle";
      this.players = new Map();        // slot -> { conn, slot, color, name, peerId, mode, transport, input, lastSeen, stream, call }
      this.relayPlayers = new Map();   // relay phone id -> player
      this.relayCfg = null; this.sb = null; this.relay = null; this.relayState = "off";
      // Phones ping every 3 s. A phone silent for 8 s (screen off, network gone) is dropped right away.
      this.watchdog = setInterval(() => {
        for (const p of [...this.players.values()]) if (Date.now() - p.lastSeen > 8000) { try { p.conn.close(); } catch {} this.drop(p); }
      }, 2000);
    }
    start(code) {
      if (this.peer && !this.peer.destroyed) { try { this.peer.destroy(); } catch {} }
      this.code = (code || randomCode()).toUpperCase();
      this.h.onCode?.(this.code);
      this.setStatus("connecting");
      const peer = this.peer = new Peer(peerId(this.code), peerOpts());
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
      if (this.relayCfg) this.startRelay(this.relayCfg);
      return this.code;
    }

    // --- relay (Supabase Realtime Broadcast) ---
    startRelay(cfg) {
      this.relayCfg = cfg;
      if (!this.code) return;
      if (!this.sb) this.sb = makeSupabase(cfg);
      if (!this.sb) { this.relayState = "unavailable"; return; }
      if (this.relay) { try { this.sb.removeChannel(this.relay); } catch {} }
      this.relayState = "connecting";
      const ch = this.relay = this.sb.channel(channelName(this.code), { config: { broadcast: { self: false } } });
      ch.on("broadcast", { event: "msg" }, ({ payload }) => this.onRelay(payload));
      ch.subscribe((status) => { this.relayState = status === "SUBSCRIBED" ? "ready" : status.toLowerCase(); this.h.onRelay?.(this.relayState); });
    }
    relaySend(to, msg) { if (this.relay) this.relay.send({ type: "broadcast", event: "msg", payload: { from: "host", to, msg } }); }
    onRelay(payload) {
      if (!payload || payload.to !== "host" || !payload.from || !payload.msg) return;
      let p = this.relayPlayers.get(payload.from);
      if (!p) { if (payload.msg.t !== "hello") return; p = this.acceptRelay(payload.from); if (!p) return; return; }
      if (payload.msg.t === "hello") { p.lastSeen = Date.now(); p.conn.send(this.welcomeFor(p)); return; }   // duplicate hello: answer again
      this.onData(p, payload.msg);
    }
    acceptRelay(from) {
      const slot = [1, 2, 3, 4].find((s) => !this.players.has(s));
      if (!slot) { this.relaySend(from, { t: "full" }); return null; }
      const [name, color] = COLORS[slot - 1];
      const conn = { open: true, peer: from, send: (m) => this.relaySend(from, m), close: () => { conn.open = false; } };
      const p = { conn, slot, color, name, peerId: from, mode: "pad", transport: "relay", input: { l: 0, r: 0 }, lastSeen: Date.now(), stream: null, call: null };
      this.players.set(slot, p); this.relayPlayers.set(from, p);
      conn.send(this.welcomeFor(p));
      this.setStatus("connected");
      this.h.onJoin?.(p);
      return p;
    }
    welcomeFor(p) {
      const extra = this.h.welcome?.(p) || {};
      if (extra.mode) p.mode = extra.mode;
      return { t: "welcome", slot: p.slot, color: p.color, name: p.name, transport: p.transport, ...extra };
    }

    // --- WebRTC ---
    accept(conn) {
      const slot = [1, 2, 3, 4].find((s) => !this.players.has(s));
      if (!slot) { conn.on("open", () => { conn.send({ t: "full" }); setTimeout(() => conn.close(), 500); }); return; }
      const [name, color] = COLORS[slot - 1];
      const p = { conn, slot, color, name, peerId: conn.peer, mode: "pad", transport: "webrtc", input: { l: 0, r: 0 }, lastSeen: Date.now(), stream: null, call: null };
      this.players.set(slot, p);
      const bye = () => this.drop(p);
      conn.on("open", () => { p.lastSeen = Date.now(); conn.send(this.welcomeFor(p)); this.setStatus("connected"); this.h.onJoin?.(p); });
      conn.on("data", (msg) => this.onData(p, msg));
      conn.on("close", bye);
      conn.on("error", bye);
    }
    onData(p, msg) {
      p.lastSeen = Date.now();
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "chunk") {   // large message split by Client.sendLarge(): reassemble, then handle as one
        const box = (p.chunks ||= {});
        const c = (box[msg.id] ||= { n: msg.n, parts: [], got: 0, at: Date.now() });
        if (!c.parts[msg.i]) { c.parts[msg.i] = msg.part; c.got++; }
        for (const k of Object.keys(box)) if (Date.now() - box[k].at > 60000) delete box[k];
        if (c.got < c.n) return;
        delete box[msg.id];
        let whole; try { whole = JSON.parse(c.parts.join("")); } catch { return; }
        return this.onData(p, whole);
      }
      if (msg.t === "input") { p.input = { l: msg.l ? 1 : 0, r: msg.r ? 1 : 0, u: msg.u ? 1 : 0, d: msg.d ? 1 : 0 }; this.h.onInput?.(p, p.input); }
      else if (msg.t === "jump") this.h.onJump?.(p, !!msg.down);
      else if (msg.t === "ping") { if (p.conn.open) p.conn.send({ t: "pong" }); }
      else if (msg.t === "mode") { p.mode = msg.mode === "camera" ? "camera" : "pad"; this.h.onMode?.(p, p.mode); }
      else if (msg.t === "hello") { /* already in */ }
      else this.h.onMessage?.(p, msg);
    }
    drop(p) {
      if (this.players.get(p.slot) !== p) return;
      this.players.delete(p.slot);
      this.relayPlayers.delete(p.peerId);
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
    destroy() {
      clearInterval(this.watchdog);
      try { this.peer?.destroy(); } catch {}
      try { if (this.sb && this.relay) this.sb.removeChannel(this.relay); } catch {}
      this.players.clear(); this.relayPlayers.clear();
    }
  }

  /** The phone side: joins a room by code over WebRTC, falls back to the relay, retries forever, can stream video. */
  class Client {
    constructor(code, handlers = {}, opts = {}) {
      this.code = String(code || "").toUpperCase(); this.h = handlers; this.opts = opts;   // opts: { relay: {url,key}, forceRelay, peerHost }
      this.peer = null; this.conn = null; this.status = "idle"; this.stopped = false; this.transport = "webrtc";
      this.input = { l: 0, r: 0, u: 0, d: 0 }; this.hb = null; this.retryTimer = null; this.attempts = 0; this.startedAt = 0;
      this.stream = null; this.call = null;
      this.sb = null; this.relay = null; this.relayId = null; this.helloTimer = null;
    }
    start() {
      this.stopped = false;
      if (!this.startedAt) this.startedAt = Date.now();
      if (this.opts.forceRelay) return this.useRelay();
      if (this.transport === "relay") return this.useRelay();
      this.setStatus("connecting");
      if (this.peer && !this.peer.destroyed) { if (this.peer.disconnected) this.peer.reconnect(); else if (this.peer.open) this.open(); return; }
      const peer = this.peer = new Peer(peerOpts(this.opts.peerHost));
      peer.on("open", () => this.open());
      peer.on("disconnected", () => { if (!this.stopped) { this.setStatus("reconnecting"); this.retry(); } });
      peer.on("error", (err) => {
        if (this.stopped) return;
        this.setStatus("reconnecting", err.type === "peer-unavailable" ? "waiting for the game" : err.type);
        if (!this.maybeFallback()) this.retry();
      });
      // WebRTC gets 5 s, then the relay takes over if it is configured.
      setTimeout(() => this.maybeFallback(), CONNECT_TIMEOUT_MS + 200);
    }
    open() {
      if (this.stopped || !this.peer?.open || this.transport === "relay") return;
      try { this.conn?.close(); } catch {}
      this.attempts++;
      const conn = this.conn = this.peer.connect(peerId(this.code), { reliable: true, serialization: "json" });
      const deadline = setTimeout(() => {
        if (conn.open) return;
        this.setStatus("reconnecting", "timeout");
        try { conn.close(); } catch {}
        this.h.onTimeout?.(this.attempts);
        if (!this.maybeFallback()) this.retry();
      }, CONNECT_TIMEOUT_MS);
      conn.on("open", () => { clearTimeout(deadline); this.attempts = 0; this.lastPong = Date.now(); this.setStatus("connected"); this.sendInput(this.input, true); this.heartbeat(); });
      conn.on("data", (msg) => this.handle(msg));
      const dropped = () => { clearTimeout(deadline); if (!this.stopped && this.transport === "webrtc") { this.setStatus("reconnecting"); this.retry(); } };
      conn.on("close", dropped);
      conn.on("error", dropped);
    }
    /** Switch to the relay if WebRTC has not delivered a connection within the timeout. Returns true when switching. */
    maybeFallback() {
      if (this.stopped || this.transport === "relay" || this.conn?.open) return false;
      if (!this.opts.relay || !window.supabase) return false;
      if (Date.now() - this.startedAt < CONNECT_TIMEOUT_MS) return false;
      this.useRelay();
      return true;
    }
    useRelay() {
      if (this.stopped) return;
      this.transport = "relay";
      clearTimeout(this.retryTimer);
      try { this.peer?.destroy(); } catch {}
      this.peer = null;
      this.stopVideo();
      if (!this.sb) this.sb = makeSupabase(this.opts.relay);
      if (!this.sb) { this.setStatus("error", "relay not configured"); return; }
      this.setStatus("connecting", "relay");
      this.relayId = this.relayId || ("phone-" + Math.random().toString(36).slice(2, 10));
      if (this.relay) { try { this.sb.removeChannel(this.relay); } catch {} }
      const ch = this.relay = this.sb.channel(channelName(this.code), { config: { broadcast: { self: false } } });
      const conn = this.conn = { open: false, send: (m) => ch.send({ type: "broadcast", event: "msg", payload: { from: this.relayId, to: "host", msg: m } }), close: () => { conn.open = false; } };
      ch.on("broadcast", { event: "msg" }, ({ payload }) => { if (payload?.to === this.relayId && payload.msg) this.handle(payload.msg, conn); });
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") this.sayHello(conn);
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") { this.setStatus("reconnecting", "relay " + status.toLowerCase()); this.retry(); }
      });
      this.h.onTransport?.("relay");
    }
    sayHello(conn) {
      clearInterval(this.helloTimer);
      const hello = () => { if (!conn.open) conn.send({ t: "hello" }); else clearInterval(this.helloTimer); };
      hello();
      this.helloTimer = setInterval(hello, 2000);   // the game may subscribe a moment after us
    }
    handle(msg, conn = this.conn) {
      if (!msg || typeof msg !== "object") return;
      this.lastPong = Date.now();
      if (msg.t === "welcome") {
        if (conn && !conn.open) { conn.open = true; this.attempts = 0; this.setStatus("connected", this.transport === "relay" ? "relay" : undefined); this.sendInput(this.input, true); this.heartbeat(); }
        this.h.onWelcome?.(msg);
        if (this.stream && this.transport === "webrtc") this.placeCall();
      }
      else if (msg.t === "event") this.h.onEvent?.(msg.name);
      else if (msg.t === "full") { this.setStatus("error", "room is full (4 players)"); this.stop(); }
      else if (msg.t === "state") this.h.onState?.(msg);
      else if (msg.t !== "pong") this.h.onMessage?.(msg);
    }
    retry() {
      clearTimeout(this.retryTimer);
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => {
        if (this.stopped) return;
        if (this.transport === "relay") { this.useRelay(); return; }
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
        if (Date.now() - this.lastPong > 9000) {   // game silent: redial
          this.setStatus("reconnecting", "no answer");
          if (this.transport === "relay") { this.conn.open = false; this.sayHello(this.conn); } else this.open();
        }
      }, 3000);
    }
    /** Stream a MediaStream (camera canvas) to the game. WebRTC only; re-placed automatically after reconnects. */
    startVideo(stream) { this.stream = stream; this.placeCall(); }
    stopVideo() { this.stream = null; try { this.call?.close(); } catch {} this.call = null; }
    placeCall() {
      if (!this.stream || this.transport !== "webrtc" || !this.peer?.open || !this.conn?.open) return;
      try { this.call?.close(); } catch {}
      const call = this.call = this.peer.call(peerId(this.code), this.stream);
      call.on("close", () => { if (this.call === call) this.call = null; });
      call.on("error", () => { if (this.call === call) this.call = null; });
      this.h.onVideo?.(true);
    }
    get canStreamVideo() { return this.transport === "webrtc"; }
    sendInput(state, force) {
      const next = { l: state.l ? 1 : 0, r: state.r ? 1 : 0, u: state.u ? 1 : 0, d: state.d ? 1 : 0 };   // up and down for the d-pad of generated games
      if (!force && next.l === this.input.l && next.r === this.input.r && next.u === this.input.u && next.d === this.input.d) return;
      this.input = next;
      if (this.conn?.open) this.conn.send({ t: "input", ...next });
    }
    sendJump(down) { if (this.conn?.open) this.conn.send({ t: "jump", down: !!down }); }
    sendMode(mode) { if (this.conn?.open) this.conn.send({ t: "mode", mode }); }
    send(msg) { if (this.conn?.open) this.conn.send(msg); }
    /** Send a big message (ink PNG, camera picture) in 12 KB chunks. PeerJS splits binary messages above ~16 KB itself and
     *  those internal pieces get lost in practice, so every piece we send stays below that size. */
    sendLarge(msg) {
      if (!this.conn?.open) return false;
      const text = JSON.stringify(msg), SIZE = 12000;
      if (text.length <= SIZE) { this.conn.send(msg); return true; }
      const id = Math.random().toString(36).slice(2, 10), n = Math.ceil(text.length / SIZE);
      for (let i = 0; i < n; i++) this.conn.send({ t: "chunk", id, i, n, part: text.slice(i * SIZE, (i + 1) * SIZE) });
      return true;
    }
    get connected() { return !!this.conn?.open; }
    setStatus(status, detail) { this.status = status; this.h.onStatus?.(status, detail); }
    stop() {
      this.stopped = true; clearInterval(this.hb); clearTimeout(this.retryTimer); clearInterval(this.helloTimer);
      this.stopVideo(); try { this.conn?.close(); } catch {}
      try { if (this.sb && this.relay) this.sb.removeChannel(this.relay); } catch {}
    }
  }

  return { Host, Client, randomCode, COLORS, MAX_PLAYERS };
})();
