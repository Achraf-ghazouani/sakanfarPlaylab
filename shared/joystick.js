// shared/joystick.js — touch joysticks and hold buttons for phones (window.Joystick). Classic script, used by the
// phone pad (pad.html, as a controller for the computer).
// A stick reports { x, y, active } with x right and y forward in -1..1; a button reports down / up. Each tracks its
// own pointer, so two thumbs (move + aim, or move + fire) work at once.
window.Joystick = (() => {
  function stick(el, onChange, { dead = 0.12 } = {}) {
    const knob = document.createElement("div"); knob.className = "jk"; el.appendChild(knob);
    let id = null, cx = 0, cy = 0, R = 1, last = { x: 0, y: 0 };
    const report = (x, y, active) => {
      knob.style.transform = `translate(${(x * R * 0.55).toFixed(1)}px, ${(-y * R * 0.55).toFixed(1)}px)`;
      if (active && Math.abs(x - last.x) < 0.015 && Math.abs(y - last.y) < 0.015) return;
      last = { x, y }; onChange({ x, y, active });
    };
    const move = (e) => {
      if (e.pointerId !== id) return;
      let dx = (e.clientX - cx) / R, dy = (cy - e.clientY) / R;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; } else if (m < dead) { dx = 0; dy = 0; }
      report(dx, dy, true);
    };
    el.addEventListener("pointerdown", (e) => {
      if (id !== null) return;
      id = e.pointerId; try { el.setPointerCapture(id); } catch {}
      const r = el.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; R = r.width / 2;
      el.classList.add("on"); last = { x: NaN, y: NaN }; move(e); e.preventDefault();
    });
    el.addEventListener("pointermove", move);
    const end = (e) => { if (e.pointerId !== id) return; id = null; el.classList.remove("on"); last = { x: NaN, y: NaN }; report(0, 0, false); };
    el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    return { release: () => { if (id !== null) { id = null; el.classList.remove("on"); report(0, 0, false); } } };
  }

  function button(el, onDown, onUp) {
    const active = new Set();
    el.addEventListener("pointerdown", (e) => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch {} active.add(e.pointerId); el.classList.add("pressed"); if (active.size === 1) onDown(); });
    const release = (e) => { if (!active.delete(e.pointerId)) return; if (!active.size) { el.classList.remove("pressed"); onUp(); } };
    for (const ev of ["pointerup", "pointercancel"]) { el.addEventListener(ev, release); window.addEventListener(ev, release); }
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** The CSS the sticks and buttons need; call once per page. */
  function css() {
    if (document.getElementById("joystick-css")) return;
    const s = document.createElement("style"); s.id = "joystick-css";
    s.textContent = `
      .stick { position:absolute; width:124px; height:124px; border-radius:50%; background:rgba(255,255,255,.12); border:2px solid rgba(255,255,255,.4); touch-action:none; pointer-events:auto; user-select:none; -webkit-user-select:none; }
      .stick.on { background:rgba(255,255,255,.18); }
      .stick .jk { position:absolute; left:50%; top:50%; width:54px; height:54px; margin:-27px 0 0 -27px; border-radius:50%; background:rgba(255,255,255,.65); box-shadow:0 2px 8px rgba(0,0,0,.35); pointer-events:none; }
      .stick .lbl { position:absolute; left:0; right:0; bottom:-22px; text-align:center; font-size:11px; color:rgba(255,255,255,.75); letter-spacing:.08em; }
      .hold { position:absolute; width:90px; height:90px; border-radius:50%; display:flex; align-items:center; justify-content:center; font:800 15px system-ui, sans-serif; letter-spacing:.08em; color:#fff; border:3px solid rgba(255,255,255,.8); background:rgba(239,68,68,.55); touch-action:none; pointer-events:auto; user-select:none; -webkit-user-select:none; }
      .hold.pressed { background:rgba(239,68,68,.95); transform:scale(.94); }`;
    document.head.appendChild(s);
  }
  return { stick, button, css };
})();
