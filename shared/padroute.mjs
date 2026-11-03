// shared/padroute.mjs — what a phone's message becomes for the game in the preview (window.PadRoute, also an ES module).
// The phone (pad.html) sends the same few messages whatever the layout: input {l, r, u, d} for the d-pad and the steering
// arrows, jump {down} for the A button (JUMP / GAS / A), fire {down} for the B button (FIRE / BRAKE / B), stick {m, a} for the
// sticks, tap {nx, ny} for the tap pad, menu {action} for restart / pause / sound. The engines (game.html, arena.html) and the
// PlayLab SDK inside generated games all read the playlab:* messages this returns, so one route serves every kind of game.
// The layouts a generated game can ask for with PlayLab.controller({ type }), and what each shows on the phone.
export const CODE_LAYOUTS = {
  "dpad+jump": { pad: "dpad", a: "JUMP", b: null },
  "dpad+2buttons": { pad: "dpad", a: "A", b: "B" },
  "stick+2buttons": { pad: "stick", a: "A", b: "B" },
  "stick+fire": { pad: "twin", a: null, b: "FIRE" },
  "steering+gas+brake": { pad: "steer", a: "GAS", b: "BRAKE" },
  "tap": { pad: "tap", a: null, b: null },
};
/** The phone layout for a state's layout: one of CODE_LAYOUTS, or null for the engines' own ("2d", "3d", "arena"). */
export function codeLayout(layout) { return Object.prototype.hasOwnProperty.call(CODE_LAYOUTS, layout) ? CODE_LAYOUTS[layout] : null; }

const bit = (v) => (v ? 1 : 0);
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
/** The playlab:* messages for one phone message from player `slot`. Unknown messages give an empty list. */
export function toGame(slot, msg) {
  const m = msg && typeof msg === "object" ? msg : {}, s = [1, 2, 3, 4].includes(slot) ? slot : 1;
  switch (m.t) {
    case "input": return [{ type: "playlab:input", slot: s, l: bit(m.l), r: bit(m.r), u: bit(m.u), d: bit(m.d) }];
    case "jump": return [{ type: "playlab:jump", slot: s, down: !!m.down }];
    case "fire": return [{ type: "playlab:fire", slot: s, down: !!m.down }];
    case "stick": {
      const m2 = Array.isArray(m.m) ? m.m : [0, 0], a2 = Array.isArray(m.a) ? m.a : [0, 0];
      return [{ type: "playlab:stick", slot: s, m: [num(m2[0], -1, 1), num(m2[1], -1, 1)], a: [num(a2[0], -1, 1), num(a2[1], -1, 1)] }];
    }
    case "tap": return [{ type: "playlab:tap", slot: s, nx: num(m.nx, 0, 1), ny: num(m.ny, 0, 1) }];
    case "menu": return ["restart", "pause", "resume", "toggle-pause", "mute"].includes(m.action) ? [{ type: "playlab:menu", action: m.action }] : [];
    default: return [];
  }
}
/** Everything a phone that left was holding, released (so no key stays down in the game). */
export function releaseAll(slot) {
  return [
    { type: "playlab:input", slot, l: 0, r: 0, u: 0, d: 0 }, { type: "playlab:jump", slot, down: false },
    { type: "playlab:stick", slot, m: [0, 0], a: [0, 0] }, { type: "playlab:fire", slot, down: false },
  ];
}

if (typeof window !== "undefined") window.PadRoute = { CODE_LAYOUTS, codeLayout, toGame, releaseAll };
