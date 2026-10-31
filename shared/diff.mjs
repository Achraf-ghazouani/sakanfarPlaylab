// shared/diff.mjs — what changed between two scans of the same drawing? Pure JS.
// Objects are matched by type and nearest center (grid units); no ids needed, so it is robust
// to the AI numbering things differently between scans.

const SAME_DIST = 30;   // closer than this, with a similar size, counts as unchanged

export function diffLevels(prev, next) {
  const P = prev?.objects || [], N = next?.objects || [];
  const used = new Set();
  const same = [], moved = [], added = [];
  const center = (o) => [o.x + o.w / 2, o.y + o.h / 2];

  N.forEach((n, j) => {
    let best = null;
    P.forEach((p, i) => {
      if (used.has(i) || p.type !== n.type) return;
      const [nx, ny] = center(n), [px, py] = center(p);
      const d = Math.hypot(nx - px, ny - py);
      const tol = Math.max(80, 0.6 * Math.max(n.w, n.h, p.w, p.h));
      if (d <= tol && (!best || d < best.d)) best = { i, d };
    });
    if (!best) { added.push(j); return; }
    used.add(best.i);
    const p = P[best.i];
    const sizeDelta = Math.abs(p.w - n.w) + Math.abs(p.h - n.h);
    if (best.d <= SAME_DIST && sizeDelta <= 40) same.push({ prev: best.i, next: j });
    else moved.push({ prev: best.i, next: j });
  });
  let removed = P.map((_, i) => i).filter((i) => !used.has(i));

  // Second pass: something of a type vanished and a new one of the same type appeared far away?
  // That is a move (the person erased it and redrew it elsewhere), not a removal plus an addition.
  for (const type of new Set(removed.map((i) => P[i].type))) {
    let gone = removed.filter((i) => P[i].type === type);
    let fresh = added.filter((j) => N[j].type === type);
    while (gone.length && fresh.length) {
      let best = null;
      for (const i of gone) for (const j of fresh) {
        const [px, py] = center(P[i]), [nx, ny] = center(N[j]);
        const d = Math.hypot(nx - px, ny - py);
        if (!best || d < best.d) best = { i, j, d };
      }
      moved.push({ prev: best.i, next: best.j });
      gone = gone.filter((i) => i !== best.i); fresh = fresh.filter((j) => j !== best.j);
      removed = removed.filter((i) => i !== best.i);
      added.splice(added.indexOf(best.j), 1);
    }
  }
  moved.sort((a, b) => a.next - b.next);

  return { same, moved, added, removed, summary: summarize(P, N, { moved, added, removed }), short: shortSummary(P, N, { moved, added, removed }) };
}

const plural = (k, v) => (v > 1 ? (k.endsWith("y") ? k.slice(0, -1) + "ies" : k + "s") : k);   // enemy -> enemies

/** Compact form for toasts: "+1 coin, +2 enemies, -1 spike, ~1 goal" (empty string when nothing changed). */
function shortSummary(P, N, { moved, added, removed }) {
  const name = (o) => (o.label && /^step \(/i.test(o.label)) ? "step" : String(o.type || "thing").replace("_", " ");
  const tally = (indexes, src, sign) => {
    const c = {};
    for (const i of indexes) { const k = name(src[i]); c[k] = (c[k] || 0) + 1; }
    return Object.entries(c).map(([k, v]) => `${sign}${v} ${plural(k, v)}`);
  };
  return [...tally(added, N, "+"), ...tally(removed, P, "-"), ...tally(moved.map((m) => m.next), N, "~")].join(", ");
}

function summarize(P, N, { moved, added, removed }) {
  const name = (o) => (o.label && /^step \(/i.test(o.label)) ? "step" : String(o.type || "thing").replace("_", " ");
  const count = (indexes, src) => {
    const c = {};
    for (const i of indexes) { const k = name(src[i]); c[k] = (c[k] || 0) + 1; }
    return Object.entries(c).map(([k, v]) => `${v} ${plural(k, v)}`).join(", ");
  };
  const parts = [];
  if (added.length) parts.push("added " + count(added, N));
  if (removed.length) parts.push("removed " + count(removed, P));
  if (moved.length) parts.push("moved " + count(moved.map((m) => m.next), N));
  return parts.length ? parts.join(" · ") : "no changes spotted";
}
