// Publish, share, remix against the real Supabase project and the dev server (api/projects publish, api/play, api/admin games).
// Start the dev server first (node serve.mjs), then:  node tests/publish.test.mjs [baseUrl]
// Makes a maker, a remixer and an admin (throwaway accounts, deleted at the end; their games go with them).
import { EXAMPLES } from "../shared/code-examples.mjs";
try { process.loadEnvFile(".env"); } catch {}
const BASE = process.argv[2] || "http://localhost:3000";
const SB = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), ANON = process.env.SUPABASE_ANON_KEY, KEY = process.env.PLAYLAB_SERVER_KEY;

let fails = 0;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 220) : ""}`); if (!cond) fails++; }
const rnd = () => Math.random().toString(36).slice(2, 10);
async function api(path, { method = "GET", body, token } = {}) {
  const h = { "Content-Type": "application/json" }; if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(`${BASE}/${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, type: r.headers.get("content-type") || "" };
}
async function sb(path, body, token) {
  const r = await fetch(`${SB}/rest/v1${path}`, { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + (token || ANON), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const srv = (fn, args) => sb(`/rpc/${fn}`, { p_key: KEY, ...args });
async function login(email, password) {
  const r = await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return (await r.json().catch(() => ({}))).access_token;
}
const made = [];
async function makeUser(role, credits, name) {
  const username = `pub_${role}_${rnd()}`, password = "Test-" + rnd() + rnd();
  const r = await srv("srv_create_user", { p_email: null, p_password: password, p_username: username, p_display_name: name, p_credits: credits, p_role: role, p_is_demo: true, p_tag: "Tester", p_expires_at: null, p_daily_limit: null });
  if (r.status !== 200) throw new Error("srv_create_user " + r.status + " " + JSON.stringify(r.data));
  made.push(r.data);
  return { id: r.data, username, token: await login(`${username}@demo.playlab.invalid`, password) };
}

// a game written as code (the only kind PlayLab makes now): the snake example with its plan and notes
const LEVEL = { genre: "code", engine: "canvas", title: "Pub test", theme: "pub test meadow", note: "v1", prompt: "a snake game", plan: { title: "Pub test", genre: "snake", engine: "canvas", goal: "eat", controls: "d-pad", controller: "dpad+jump", win: "-", lose: "-", entities: [], opponents: "none", levels: "-", players: 1, notes: "" }, html: EXAMPLES.snake, notes: { note: "v1", built: "x", missing: "" }, objects: [] };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

try {
  const A = await makeUser("user", 50, "Maker Mia"), B = await makeUser("user", 50, "Remixer Rob"), AD = await makeUser("admin", 0, "Admin");
  check("three throwaway accounts", !!A.token && !!B.token && !!AD.token);

  // a game, then publish it
  const created = await api("api/projects", { method: "POST", token: A.token, body: { title: "Pub test", level: LEVEL } });
  const pid = created.data.project?.id;
  check("maker creates a game", created.status === 200 && !!pid);
  check("publishing needs public or unlisted", (await api("api/projects", { method: "PATCH", token: A.token, body: { id: pid, publish: { visibility: "secret" } } })).status === 400);
  const pub = await api("api/projects", { method: "PATCH", token: A.token, body: { id: pid, publish: { visibility: "public", title: "Pub test game", description: "jump to the flag", cover: PNG, og_image: PNG } } });
  const sid = pub.data.project?.share_id;
  check("publish: a short share id, public, kind code, published_at", pub.status === 200 && /^[a-z0-9]{8}$/.test(sid || "") && pub.data.project.visibility === "public" && pub.data.project.kind === "code" && !!pub.data.project.published_at, { status: pub.status, project: pub.data.project && { share_id: sid, visibility: pub.data.project.visibility, kind: pub.data.project.kind } });
  check("the maker's list shows it as public", (await api("api/projects", { token: A.token })).data.projects?.find((p) => p.id === pid)?.visibility === "public");

  // the play page, for everyone
  const html = await api(`play/${sid}`);
  check("/play/<id> is an HTML page with Open Graph tags", html.status === 200 && /text\/html/.test(html.type) && /og:title" content="Pub test game"/.test(html.data) && /og:description" content="jump to the flag"/.test(html.data) && new RegExp(`og:image" content="[^"]*/api/play\\?id=${sid}&amp;cover=1"`).test(html.data), { status: html.status, type: html.type });
  check("/play/<unknown> is a not-found page", (await api("play/zzzzzzzz")).status === 404);
  const cover = await fetch(`${BASE}/api/play?id=${sid}&cover=1`);
  check("the link preview picture is served as an image", cover.status === 200 && /^image\/png/.test(cover.headers.get("content-type") || ""), cover.headers.get("content-type"));
  const game = await api(`api/play?id=${sid}&format=json`);
  check("the public game JSON has the level and author, never the owner", game.status === 200 && game.data.game.level?.genre === "code" && game.data.game.level.html.length > 1000 && game.data.game.author === "Maker Mia" && game.data.game.owner === undefined && game.data.game.plays === 0, game.data.game && Object.keys(game.data.game));

  // plays, likes, reports
  check("a play is counted", (await api("api/play", { method: "POST", body: { action: "played", id: sid } })).data.plays === 1);
  const voter = rnd() + rnd() + rnd() + rnd();
  const like1 = await api("api/play", { method: "POST", body: { action: "like", id: sid, voter } });
  check("a like", like1.status === 200 && like1.data.liked === true && like1.data.likes === 1, like1.data);
  check("the like is remembered for that voter", (await api(`api/play?id=${sid}&liked=${voter}`)).data.liked === true);
  check("a second like from the same voter takes it back", (await api("api/play", { method: "POST", body: { action: "like", id: sid, voter } })).data.likes === 0);
  check("a short voter is refused", (await api("api/play", { method: "POST", body: { action: "like", id: sid, voter: "short" } })).status === 400);
  check("a report", (await api("api/play", { method: "POST", body: { action: "report", id: sid, reason: "spam", details: "test report", reporter: voter } })).status === 200);
  const direct = await fetch(`${SB}/rest/v1/projects?id=eq.${pid}`, { method: "PATCH", headers: { apikey: ANON, Authorization: "Bearer " + A.token, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ like_count: 99 }) });
  check("the maker cannot bump their own likes through the database", direct.status >= 400, direct.status);

  // explore
  const ex = await api("api/play?action=explore&sort=newest");
  check("explore lists the public game with its author and cover", ex.status === 200 && ex.data.games.some((g) => g.id === sid && g.author === "Maker Mia" && g.cover === PNG && g.kind === "code"));
  check("explore filters by kind", !(await api("api/play?action=explore&kind=arena")).data.games.some((g) => g.id === sid) && (await api("api/play?action=explore&kind=code")).data.games.some((g) => g.id === sid));
  check("explore searches titles", (await api("api/play?action=explore&q=Pub%20test")).data.games.some((g) => g.id === sid));
  const unl = await api("api/projects", { method: "PATCH", token: A.token, body: { id: pid, publish: { visibility: "unlisted" } } });
  check("unlisted: the link works but Explore does not list it", unl.data.project?.visibility === "unlisted" && (await api(`api/play?id=${sid}&format=json`)).status === 200 && !(await api("api/play?action=explore&sort=newest")).data.games.some((g) => g.id === sid));
  check("the share id stays the same when re-published", unl.data.project?.share_id === sid);
  check("unpublish takes the link down", (await api("api/projects", { method: "PATCH", token: A.token, body: { id: pid, unpublish: true } })).data.project?.visibility === "private" && (await api(`api/play?id=${sid}&format=json`)).status === 404 && (await api(`play/${sid}`)).status === 404);
  await api("api/projects", { method: "PATCH", token: A.token, body: { id: pid, publish: { visibility: "public" } } });

  // remix
  check("remix needs a login", (await api("api/play", { method: "POST", body: { action: "remix", id: sid } })).status === 401);
  const rx = await api("api/play", { method: "POST", token: B.token, body: { action: "remix", id: sid } });
  check("remix: a copy in the remixer's games, charged as a code change (6 credits)", rx.status === 200 && rx.data.project?.title === "Remix of Pub test game" && rx.data.project.owner === B.id && rx.data.credits?.spent === 6 && rx.data.credits.balance === 44 && rx.data.credits.action === "code_edit", rx.data.credits || rx.data);
  const rxp = await api(`api/projects?id=${rx.data.project?.id}`, { token: B.token });
  check("the remix has the level, version 1 and a remix card", rxp.data.project?.level?.genre === "code" && rxp.data.versions?.[0]?.n === 1 && rxp.data.messages?.some((m) => /Remixed from/.test(m.content)));
  check("the original is untouched", (await api(`api/play?id=${sid}&format=json`)).data.game.title === "Pub test game");

  // admin
  const games = await api("api/admin?action=games&filter=published", { token: AD.token });
  check("admin sees the published game with its open report", games.status === 200 && games.data.games.some((g) => g.id === pid && g.open_reports === 1 && g.email === `${A.username}@demo.playlab.invalid`));
  check("a regular user cannot list games as admin", (await api("api/admin?action=games", { token: A.token })).status === 403);
  const feat = await api("api/admin", { method: "POST", token: AD.token, body: { action: "game_set", id: pid, featured: true } });
  check("admin features it and Explore puts it first", feat.data.game?.featured === true && (await api("api/play?action=explore&sort=featured")).data.games[0]?.id === sid && (await api("api/play?action=explore&sort=featured")).data.games[0].featured === true);
  const reps = await api("api/admin?action=reports&status=open", { token: AD.token });
  const rep = reps.data.reports?.find((r) => r.share_id === sid);
  check("the report is in the queue with the game's title", !!rep && rep.reason === "spam" && rep.title === "Pub test game");
  check("admin closes the report", (await api("api/admin", { method: "POST", token: AD.token, body: { action: "report_close", id: rep?.id } })).status === 200 && !(await api("api/admin?action=reports&status=open", { token: AD.token })).data.reports.some((r) => r.id === rep?.id));
  check("admin unpublishes", (await api("api/admin", { method: "POST", token: AD.token, body: { action: "game_set", id: pid, visibility: "private" } })).data.game?.visibility === "private" && (await api(`api/play?id=${sid}&format=json`)).status === 404);
  check("admin deletes the game", (await api("api/admin", { method: "POST", token: AD.token, body: { action: "game_delete", id: pid } })).status === 200 && (await api(`api/projects?id=${pid}`, { token: A.token })).status === 404);
} catch (err) {
  console.log("ERROR", err.message); fails++;
} finally {
  for (const id of made) await srv("srv_delete_user", { p_user: id });
  console.log(`deleted ${made.length} test account(s) (their games went with them)`);
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
}
