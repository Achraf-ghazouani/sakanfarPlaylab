// api/play.js — published games, for everyone (no login unless noted). /play/<id> is rewritten here (vercel.json, serve.mjs).
//   GET  /play/<id>  = /api/play?id=<id>           -> the play page (HTML with Open Graph tags, loads shared/play.js)
//   GET  /api/play?id=<id>&format=json             -> { game }   the published game: level, art, title, author, plays, likes
//   GET  /api/play?id=<id>&cover=1                 -> the link-preview picture (JPEG bytes)
//   GET  /api/play?id=<id>&liked=<voter>           -> { liked }
//   GET  /api/play?action=explore&sort=&kind=&q=   -> { games }  the public gallery
//   POST /api/play { action: "played", id }        -> { plays }
//   POST /api/play { action: "like", id, voter }   -> { liked, likes }
//   POST /api/play { action: "report", id, reason, details?, reporter? } -> { ok }
//   POST /api/play { action: "remix", id }         -> { project }   login required, charged as an edit

import { rpc, dbConfigured, getProject } from "../lib/db.mjs";
import { requireUser, readBody } from "../lib/auth.mjs";
import { paid } from "../lib/credits.mjs";

const ID = /^[a-z0-9]{6,12}$/;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KIND_NAME = { "2d": "2D platformer", "3d": "3D platformer", arena: "3D arena shooter" };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!dbConfigured()) return res.status(503).json({ error: "Not configured." });
  const q = req.query || {};
  try {
    if (req.method === "GET") {
      if (q.action === "explore") {
        const sort = ["trending", "newest", "featured"].includes(q.sort) ? q.sort : "trending";
        const kind = ["2d", "3d", "arena"].includes(q.kind) ? q.kind : null;
        const games = await rpc("explore_games", { p_sort: sort, p_kind: kind, p_q: String(q.q || "").slice(0, 60) || null, p_limit: 60, p_offset: Math.max(0, Number(q.offset) || 0) });
        return res.status(200).json({ games });
      }
      const id = String(q.id || "").toLowerCase();
      if (!ID.test(id)) return q.format === "json" ? res.status(400).json({ error: "Bad game id." }) : page(res, null, req);
      if (q.format === "json") {
        const game = await rpc("public_game", { p_share_id: id });
        return game ? res.status(200).json({ game }) : res.status(404).json({ error: "This game is not published." });
      }
      if (q.liked) {
        const liked = await rpc("liked_by", { p_share_id: id, p_voter: String(q.liked).slice(0, 64) });
        return res.status(200).json({ liked: !!liked });
      }
      const card = await rpc("public_game_card", { p_share_id: id });
      if (q.cover) {
        const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(card?.og_image || card?.cover || "");
        if (!m) { res.statusCode = 404; return res.end("no cover"); }
        res.statusCode = 200; res.setHeader("Content-Type", `image/${m[1]}`); res.setHeader("Cache-Control", "public, max-age=300");
        return res.end(Buffer.from(m[2], "base64"));
      }
      return page(res, card, req);
    }

    if (req.method === "POST") {
      const b = readBody(req);
      const id = String(b.id || "").toLowerCase();
      if (!ID.test(id)) return res.status(400).json({ error: "Bad game id." });
      switch (b.action) {
        case "played": return res.status(200).json({ plays: (await rpc("played_game", { p_share_id: id })) ?? 0 });
        case "like": {
          const voter = String(b.voter || "").slice(0, 64);
          if (voter.length < 16) return res.status(400).json({ error: "Missing voter." });
          return res.status(200).json(await rpc("toggle_like", { p_share_id: id, p_voter: voter }));
        }
        case "report": {
          const reason = ["inappropriate", "broken", "spam", "copyright", "other"].includes(b.reason) ? b.reason : "other";
          await rpc("report_game", { p_share_id: id, p_reason: reason, p_details: String(b.details || "").slice(0, 500), p_reporter: String(b.reporter || "").slice(0, 64) || null });
          return res.status(200).json({ ok: true });
        }
        case "remix": {
          const user = await requireUser(req, res);
          if (!user) return;
          const card = await rpc("public_game_card", { p_share_id: id });
          if (!card) return res.status(404).json({ error: "This game is not published." });
          const action = card.kind === "2d" ? "edit_2d" : "edit_3d";   // a remix costs one edit of that kind
          const out = await paid(user, res, action, {}, () => rpc("remix_game", { p_share_id: id }, user.token));
          if (!out) return;
          const project = await getProject(user, out.result);
          return res.status(200).json({ project, credits: out.credits });
        }
        default: return res.status(400).json({ error: "Unknown action." });
      }
    }
    return res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    const msg = String(err.detail || err.message || "");
    if (/too many/i.test(msg)) return res.status(429).json({ error: msg.replace(/^.*?:\s*/, "").slice(0, 120) });
    if (/no such game|bad voter|login required/i.test(msg)) return res.status(400).json({ error: msg.replace(/^.*?:\s*/, "").slice(0, 120) });
    console.error("play:", msg);
    return res.status(502).json({ error: "Database error. Try again." });
  }
}

/** The play page: Open Graph tags for link previews (WhatsApp, Facebook, X) and the game loaded by shared/play.js. */
function page(res, card, req) {
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "sakanfarplaylab.vercel.app";
  const proto = String(req.headers?.["x-forwarded-proto"] || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https")).split(",")[0];   // the dev server has no proxy header
  const origin = `${proto}://${host}`;
  const title = card ? `${card.title} · Sakanfar PlayLab` : "Game not found · Sakanfar PlayLab";
  const desc = card ? (card.description || `A ${KIND_NAME[card.kind] || "game"} by ${card.author}, made in PlayLab. Play it in your browser.`) : "This game is not published (or the link is wrong).";
  const image = card && (card.og_image || card.cover) ? `${origin}/api/play?id=${card.id}&cover=1` : `${origin}/assets/logo.webp`;
  const url = card ? `${origin}/play/${card.id}` : `${origin}/explore.html`;
  const data = card ? { id: card.id, title: card.title, author: card.author, kind: card.kind, description: card.description || "" } : null;
  res.statusCode = card ? 200 : 404;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1b1535">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Sakanfar PlayLab">
<meta property="og:title" content="${esc(card ? card.title : "Game not found")}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(card ? card.title : "Game not found")}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fredoka:wght@600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/shared/play.css">
<script>window.PLAY = ${JSON.stringify(data)};</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js" defer></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js" defer></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.80.0/dist/umd/supabase.min.js" defer></script>
<script src="/shared/phonelink.js" defer></script>
<script src="/shared/auth.js" defer></script>
<script src="/shared/play.js" defer></script>
</head>
<body>
<header class="top">
  <a class="brand" href="/"><img src="/assets/mark-256.webp" alt="">PlayLab</a>
  <div class="who"><b id="title">${esc(card ? card.title : "Game not found")}</b><small id="author">${card ? "by " + esc(card.author) + " · " + esc(KIND_NAME[card.kind] || "game") : ""}</small></div>
  <span class="spacer"></span>
  <button class="tb" id="likeBtn" title="Like"><span id="likeIcon">&#9825;</span> <span id="likes">0</span></button>
  <span class="tb stat" title="Plays">&#9654; <span id="plays">0</span></span>
  <button class="tb" id="phonesBtn" title="Play with your phones">&#128241; <span class="lbl">Phones</span></button>
  <button class="tb primary" id="shareBtn">&#128279; <span class="lbl">Share</span></button>
  <a class="tb" id="remixBtn" href="/login.html?next=${card ? esc(encodeURIComponent("studio.html?remix=" + card.id)) : "studio.html"}">&#127922; <span class="lbl">Remix in Studio</span></a>
  <a class="tb ghost" href="/explore.html">Explore</a>
</header>
<main id="stage">
  ${card ? `<iframe id="game" title="${esc(card.title)}" allow="autoplay; pointer-lock"></iframe><div id="loading">Loading the game...</div>` : `<div class="gone"><h1>This game is not here</h1><p>${esc(desc)}</p><a class="tb primary" href="/explore.html">Explore games</a></div>`}
</main>
<p id="desc" class="desc">${esc(card?.description || "")}</p>
<footer class="foot"><button class="link" id="reportBtn">Report this game</button> &middot; <a href="/">Make your own in PlayLab</a></footer>
<div class="modal" id="shareModal"><div class="sheet"><header><b>Share this game</b><button class="tb" data-close>Close</button></header>
  <div class="body"><div class="row"><input id="shareUrl" readonly><button class="tb primary" id="copyBtn">Copy link</button><button class="tb" id="webShareBtn" hidden>Share...</button></div>
  <div class="qr" id="shareQr"></div><p class="hint">Scan the code to open the game on a phone. Anyone with the link can play, no account needed.</p></div></div></div>
<div class="modal" id="phonesModal"><div class="sheet"><header><b>Play with your phones</b><button class="tb" data-close>Close</button></header>
  <div class="body"><div class="qr" id="phoneQr"></div><div class="code" id="phoneCode">----</div><p class="hint" id="phoneHint">Scan with a phone (same Wi-Fi is fastest). It becomes a controller: arrows and jump for a platformer, sticks and fire for a shooter. Up to 4 phones.</p><div class="hint" id="phonePlayers"></div></div></div></div>
<div class="modal" id="reportModal"><div class="sheet"><header><b>Report this game</b><button class="tb" data-close>Close</button></header>
  <div class="body"><select id="reportReason"><option value="inappropriate">Inappropriate content</option><option value="broken">It does not work</option><option value="spam">Spam</option><option value="copyright">Copyright</option><option value="other">Something else</option></select>
  <textarea id="reportDetails" rows="3" maxlength="500" placeholder="What is wrong? (optional)"></textarea><div class="row"><button class="tb primary" id="reportSend">Send report</button></div></div></div></div>
<div id="toast"></div>
</body>
</html>`);
}
