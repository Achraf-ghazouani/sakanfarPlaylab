// shared/reach.mjs — the "playtest agent" brain: can the player reach every platform, coin and goal?
// Pure JS (no Node, no Phaser) so the server, the CLI and the pages can all use it.
// The physics numbers MUST match game.html.

export const PHYS = { gravity: 2400, jumpVel: 1100, runSpeed: 330, playerW: 36, playerH: 54, moverRange: 150 };
export const MAX_JUMP_H = (PHYS.jumpVel * PHYS.jumpVel) / (2 * PHYS.gravity);   // 252 world units
const V_MARGIN = 8;                 // feet must clear a ledge by this much
const H_MARGIN = PHYS.playerW / 2;  // land with the body half over the ledge

export function aspectOf(level) {
  const a = Number(level?.aspect);
  return Number.isFinite(a) && a > 0.4 && a < 3 ? a : 1;
}

/** Horizontal distance (world units) the player covers while rising/falling to a ledge `dy` above the takeoff (negative = below). */
export function jumpReach(dy, ax = 1) {
  const { gravity: g, jumpVel: v, runSpeed } = PHYS;
  const disc = v * v - 2 * g * dy;
  if (disc < 0) return -1;                  // too high
  const t = (v + Math.sqrt(disc)) / g;      // time until the feet come back down to height dy
  return runSpeed * ax * t;
}

/** Standable surfaces in world units. Moving platforms count their whole sweep. */
export function surfacesOf(level) {
  const ax = aspectOf(level), W = 1000 * ax;
  const out = [];
  (level.objects || []).forEach((o, i) => {
    if (o.type !== "platform" && o.type !== "moving_platform") return;
    let left = o.x * ax, right = (o.x + o.w) * ax;
    if (o.type === "moving_platform") {
      const cx = (left + right) / 2, half = (right - left) / 2;
      const range = Math.min(PHYS.moverRange * ax, cx - half, W - cx - half);
      if (range > 10) { left -= range; right += range; }
    }
    out.push({ i, label: o.label || o.type, type: o.type, left, right, top: o.y, bottom: o.y + o.h });
  });
  return out;
}

function boxOf(o, ax) { return { left: o.x * ax, right: (o.x + o.w) * ax, top: o.y, bottom: o.y + o.h }; }

/** Can the player standing on A land on B? Platforms are solid from below, so B above must be approached from the side. */
export function canJump(A, B, ax = 1) {
  const pw = PHYS.playerW;
  const dy = A.top - B.top;                        // > 0: B is higher
  if (dy > MAX_JUMP_H - V_MARGIN) return { ok: false, why: "too high", dy };
  let needed;
  if (dy > 0) {
    const cands = [];
    if (A.left < B.left - pw / 2) cands.push(Math.max(0, B.left - Math.min(A.right, B.left - pw / 2)));      // take off left of B
    if (A.right > B.right + pw / 2) cands.push(Math.max(0, Math.max(A.left, B.right + pw / 2) - B.right));   // take off right of B
    if (!cands.length) return { ok: false, why: "no room beside it to jump from", dy };
    needed = Math.min(...cands);
  } else if (B.right >= A.left && B.left <= A.right) {
    needed = 0;                                                   // spans overlap: drop or hop straight over
  } else {
    needed = B.left > A.right ? B.left - A.right : A.left - B.right;
  }
  const reach = jumpReach(dy, ax);
  return { ok: needed + H_MARGIN <= reach, why: "too far", dy, needed, reach };
}

/** Can the player standing on A touch target box T (coin / goal)? Targets are not solid. */
export function canTouch(A, T, ax = 1) {
  const { playerH: ph } = PHYS;
  // Feet height range (relative to A.top, up = positive) in which the body overlaps T vertically.
  const lo = A.top - (T.bottom + ph) + 6;
  const hi = A.top - T.top - 6;
  if (lo > MAX_JUMP_H - 4) return { ok: false, why: "too high", dy: lo };
  const dy = Math.min(Math.max(lo, -2000), hi);
  let needed;
  const overlap = T.right >= A.left && T.left <= A.right;
  if (lo <= 0 && overlap && T.left > A.left && T.right < A.right && T.top > A.top) {
    needed = Math.max(0, Math.min(A.right - T.right, T.left - A.left));   // target hides under A: walk off an edge and steer back
  } else if (overlap) {
    needed = 0;
  } else {
    needed = T.left > A.right ? T.left - A.right : A.left - T.right;
  }
  const reach = jumpReach(Math.max(dy, lo), ax);
  return { ok: needed <= reach, why: "too far", dy: lo, needed, reach };
}

/** Surface under a point (x in world units), the one whose top is closest to feetY within tol. */
function surfaceUnder(surfaces, x, feetY, tol = 80) {
  let best = null;
  for (const s of surfaces) {
    if (x < s.left - 5 || x > s.right + 5) continue;
    const d = Math.abs(s.top - feetY);
    if (d <= tol && (!best || d < best.d)) best = { s, d };
  }
  return best?.s ?? null;
}

/**
 * Check a level. Returns { ok, goalReachable, reachable: [object indexes], problems: [...] }.
 * Each problem: { kind: "platform"|"coin"|"goal", index, label, why, from: {index,label}, dy, needed, reach, message }
 * Distances in messages are grid units (what the level JSON uses).
 */
export function checkLevel(level) {
  const ax = aspectOf(level);
  const objs = level.objects || [];
  const surfaces = surfacesOf(level);
  if (!surfaces.length) return { ok: false, goalReachable: false, reachable: [], problems: [{ kind: "level", message: "no platforms at all" }] };

  // Where does the player start?
  const start = objs.find((o) => o.type === "start");
  let startSurf = null;
  if (start) startSurf = surfaceUnder(surfaces, (start.x + start.w / 2) * ax, start.y + start.h);
  if (!startSurf && start) {
    const sx = (start.x + start.w / 2) * ax, sy = start.y + start.h;
    startSurf = surfaces.reduce((a, b) => (dist(b, sx, sy) < dist(a, sx, sy) ? b : a));
  }
  if (!startSurf) startSurf = surfaces.reduce((a, b) => (b.left < a.left ? b : a));

  // BFS over surfaces
  const reached = new Set([startSurf.i]);
  const queue = [startSurf];
  while (queue.length) {
    const A = queue.shift();
    for (const B of surfaces) {
      if (reached.has(B.i)) continue;
      if (canJump(A, B, ax).ok) { reached.add(B.i); queue.push(B); }
    }
  }
  const reachableSurfaces = surfaces.filter((s) => reached.has(s.i));

  const problems = [];
  const g = (v) => Math.round(v / ax);   // world x -> grid units for messages

  for (const B of surfaces) {
    if (reached.has(B.i)) continue;
    const best = closest(reachableSurfaces, (A) => canJump(A, B, ax));
    problems.push(problem("platform", B.i, B.label, best, g));
  }

  let goalReachable = false;
  objs.forEach((o, i) => {
    if (o.type !== "coin" && o.type !== "goal") return;
    const T = boxOf(o, ax);
    const hit = reachableSurfaces.some((A) => canTouch(A, T, ax).ok);
    if (hit) { if (o.type === "goal") goalReachable = true; return; }
    const best = closest(reachableSurfaces, (A) => canTouch(A, T, ax));
    problems.push(problem(o.type, i, o.label || o.type, best, g));
  });
  if (!objs.some((o) => o.type === "goal")) problems.push({ kind: "level", message: "no goal" });

  return { ok: problems.length === 0, goalReachable, reachable: [...reached], startIndex: startSurf.i, problems };
}

function dist(s, x, y) { const cx = Math.max(s.left, Math.min(x, s.right)); return Math.hypot(cx - x, s.top - y); }

/** Among reachable surfaces, the one that comes closest to making the jump (smallest deficit). */
function closest(surfaces, test) {
  let best = null;
  for (const A of surfaces) {
    const r = test(A);
    const deficit = r.why === "too high" ? 1e6 + r.dy : r.why === "no room beside it to jump from" ? 5e5 : (r.needed + H_MARGIN - r.reach);
    if (!best || deficit < best.deficit) best = { A, r, deficit };
  }
  return best;
}

function problem(kind, index, label, best, g) {
  const p = { kind, index, label, from: best ? { index: best.A.i, label: best.A.label } : null, why: best?.r.why, dy: best ? Math.round(best.r.dy) : null, needed: best ? g(best.r.needed ?? 0) : null, reach: best ? g(Math.max(0, best.r.reach ?? 0)) : null };
  const what = kind === "platform" ? `platform "${label}"` : `${kind} "${label}"`;
  if (!best) p.message = `${what} cannot be reached`;
  else if (best.r.why === "too high") p.message = `${what} is ${p.dy} above "${best.A.label}" but the player jumps at most ${Math.round(MAX_JUMP_H - V_MARGIN)}`;
  else if (best.r.why === "no room beside it to jump from") p.message = `${what} sits right above "${best.A.label}" with no room beside it to jump from (platforms are solid from below)`;
  else p.message = `${what} is ${p.needed} across from "${best.A.label}" but the longest jump at that height is ${p.reach}`;
  return p;
}

/**
 * Algorithmic repair: add small stepping platforms until everything is reachable (max `maxSteps`).
 * Coins/goals that cannot be touched get a platform right under them, which the stepping logic then connects.
 * Returns { level, changes: [string] }. Never moves or removes drawn objects.
 */
export function autoFixLevel(level, maxSteps = 8) {
  const ax = aspectOf(level);
  const W = 1000 * ax;
  const out = { ...level, objects: level.objects.map((o) => ({ ...o })) };
  const changes = [];
  const STEP_W = 100;                        // world units
  const hop = MAX_JUMP_H - 36;               // comfortable vertical hop
  const seen = new Set();

  const makeStep = (label, cxWorld, top) => {
    const cx = Math.max(STEP_W / 2 + 5, Math.min(W - STEP_W / 2 - 5, cxWorld));
    const w = STEP_W / ax;
    return { type: "platform", label, x: Math.round(cx / ax - w / 2), y: Math.round(Math.max(20, Math.min(975, top))), w: Math.round(w), h: 18 };
  };
  const surfOf = (s) => ({ left: s.x * ax, right: (s.x + s.w) * ax, top: s.y });

  for (let n = 0; n < maxSteps; n++) {
    const check = checkLevel(out);
    if (check.ok) break;
    const p = check.problems.find((q) => q.kind !== "level");
    if (!p) break;
    const target = out.objects[p.index];
    const surfaces = surfacesOf(out);
    const reachable = surfaces.filter((s) => check.reachable.includes(s.i));

    let step = null;
    if (p.kind === "coin" || p.kind === "goal") {
      // A perch right under the target; the loop then connects the perch like any platform.
      step = makeStep(`step (auto) under ${target.label || p.kind}`, (target.x + target.w / 2) * ax, target.y + target.h + 2);
    } else {
      const B = surfaces.find((s) => s.i === p.index);
      const A = reachable.find((s) => s.i === p.from?.index) || reachable[0];
      const aC = (A.left + A.right) / 2, bC = (B.left + B.right) / 2;
      const label = `step (auto) to ${B.label}`;
      const candidates = [];

      if (p.why === "too far") {
        // Halfway across the gap, at the lower of the two tops (raised by up to one hop if B is higher).
        const gapLeft = Math.min(A.right, B.right), gapRight = Math.max(A.left, B.left);
        const low = Math.max(A.top, B.top), high = Math.min(A.top, B.top);
        candidates.push([(gapLeft + gapRight) / 2, low - Math.min(hop, (low - high) / 2)]);
      } else if (p.why === "no room beside it to jump from") {
        // B sits right above A: put a perch just outside B's span, a little below B's top.
        const top = Math.max(B.top + 40, A.top - hop);
        candidates.push([B.right + 10 + STEP_W / 2, top], [B.left - 10 - STEP_W / 2, top]);
      } else {
        // Too high: climb one hop from A, drifting sideways toward B, but never end up directly under B
        // when the next hop could reach it (platforms are solid from below).
        const top = A.top - hop;
        const dir = bC >= aC ? 1 : -1;
        const drift = Math.max(60, Math.min(Math.abs(bC - aC), 150));
        const underB = (cx) => cx + STEP_W / 2 > B.left - 20 && cx - STEP_W / 2 < B.right + 20 && top - B.top < MAX_JUMP_H;
        for (const cx of [aC + dir * drift, aC - dir * drift, aC + dir * 60, aC - dir * 60, B.left - 10 - STEP_W / 2, B.right + 10 + STEP_W / 2]) {
          candidates.push([underB(cx) ? (cx <= bC ? B.left - 10 - STEP_W / 2 : B.right + 10 + STEP_W / 2) : cx, top]);
        }
      }

      // Take the first candidate that the player can actually reach from A.
      for (const [cx, top] of candidates) {
        const s = makeStep(label, cx, top);
        if (canJump(A, surfOf(s), ax).ok) { step = s; break; }
      }
      if (!step) step = makeStep(label, candidates[0][0], candidates[0][1]);
    }

    const key = `${step.x},${step.y}`;
    if (seen.has(key)) break;                  // would repeat itself: give up rather than spin
    seen.add(key);
    out.objects.push(step);
    changes.push(`added a small platform "${step.label}" at (${step.x}, ${step.y})`);
  }
  return { level: out, changes, ok: checkLevel(out).ok };
}
