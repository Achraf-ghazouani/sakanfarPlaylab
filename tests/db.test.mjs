// Round trip against the real Supabase tables through lib/db.mjs, as two real (throwaway) accounts.
// Run: node tests/db.test.mjs   (needs SUPABASE_URL, SUPABASE_ANON_KEY, PLAYLAB_SERVER_KEY and db/003_server_users.sql)
try { process.loadEnvFile(".env"); } catch {}
const db = await import("../lib/db.mjs");

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 200) : ""}`);
  if (!cond) fails++;
}
if (!db.serverConfigured()) { console.log("SKIP  no SUPABASE_URL / SUPABASE_ANON_KEY / PLAYLAB_SERVER_KEY in .env"); process.exit(0); }

const rnd = () => Math.random().toString(36).slice(2, 10);
const users = [];
async function account() {
  const username = "db_" + rnd(), password = "Test-" + rnd() + "-" + rnd();
  let id;
  try { id = await db.srv("srv_create_user", { p_email: null, p_password: password, p_username: username, p_display_name: null, p_credits: 0, p_role: "user", p_is_demo: false, p_tag: null, p_expires_at: null, p_daily_limit: null }); }
  catch (err) { if (/srv_create_user|Could not find/i.test(err.message)) { console.log("SKIP  run db/003_server_users.sql first"); process.exit(0); } throw err; }
  users.push(id);
  const s = await db.authApi("/token?grant_type=password", { method: "POST", body: { email: `${username}@demo.playlab.invalid`, password } });
  return { token: s.access_token, uid: id };
}

const level = { theme: "db test", objects: [{ type: "platform", label: "ground", x: 0, y: 900, w: 1000, h: 50 }, { type: "start", x: 40, y: 840, w: 40, h: 60 }, { type: "goal", x: 900, y: 840, w: 40, h: 60 }] };
let project = null, owner = null;
try {
  owner = await account();
  const other = await account();
  project = await db.createProject(owner, { title: "DB test game", level });
  check("create project", !!project?.id && project.title === "DB test game" && project.owner === owner.uid, project && { id: project.id });
  const v1 = await db.addVersion(owner, project.id, level, "created");
  check("first version is n=1", v1?.n === 1);
  check("owner sees the project in the list", (await db.listProjects(owner)).some((p) => p.id === project.id));
  // a game from before accounts (keyed by the browser's old "u-" id) is claimed on login
  const anon = "u-" + Array.from({ length: 24 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  await db.srv("srv_set_project_owner", { p_id: project.id, p_owner: anon });
  check("an anonymous game is not in the list", !(await db.listProjects(owner)).some((p) => p.id === project.id));
  check("claiming with another id moves nothing", (await db.srv("srv_claim_projects", { p_owner: "u-" + "0".repeat(24), p_user: other.uid })) === 0);
  check("claiming with the browser's id moves it to the account", (await db.srv("srv_claim_projects", { p_owner: anon, p_user: owner.uid })) === 1 && (await db.listProjects(owner)).some((p) => p.id === project.id));
  let badClaim = null; try { await db.srv("srv_claim_projects", { p_owner: "not-an-id", p_user: owner.uid }); } catch (e) { badClaim = e; }
  check("a malformed id is refused", !!badClaim);
  const foreign = await db.listProjects(other);
  check("another account cannot see it (RLS)", !foreign.some((p) => p.id === project.id), foreign.length);
  check("another account cannot fetch it by id", (await db.getProject(other, project.id)) === null);
  const msg = await db.addMessage(owner, project.id, { role: "user", content: "hello", meta: { a: 1 } });
  check("add message", msg?.role === "user" && msg.content === "hello");
  let bad = null; try { await db.addMessage(other, project.id, { role: "user", content: "intruder" }); } catch (e) { bad = e; }
  check("another account cannot post messages (RLS)", !!bad, bad && bad.status);
  let stolen = null; try { stolen = await db.createProject(other, { title: "x", owner: owner.uid }); } catch (e) { stolen = e; }
  check("nobody can create a project in someone else's name", stolen instanceof Error || stolen?.owner === other.uid);
  const msgs = await db.listMessages(owner, project.id);
  check("list messages", msgs.length === 1 && msgs[0].meta?.a === 1);
  const updated = await db.updateProject(owner, project.id, { title: "Renamed", level: { ...level, theme: "v2" } });
  check("update project", updated?.title === "Renamed" && updated.level.theme === "v2");
  check("another account cannot update it", (await db.updateProject(other, project.id, { title: "hacked" })) === null);
  const v2 = await db.addVersion(owner, project.id, updated.level, "edited");
  check("second version is n=2", v2?.n === 2);
  const versions = await db.listVersions(owner, project.id);
  check("versions listed newest first", versions.length === 2 && versions[0].n === 2);
  check("get a version", (await db.getVersion(owner, project.id, 1))?.level.theme === "db test");
  check("shared project not visible publicly before sharing", (await db.getSharedProject("nope-" + rnd())) === null);
  const shared = await db.updateProject(owner, project.id, { share_id: "t" + rnd() });
  const pub = await db.getSharedProject(shared.share_id);
  check("shared project readable without a login", pub?.id === project.id && pub.owner === undefined);
  const count = await db.rpc("bump_play_count", { p_share_id: shared.share_id });
  check("play count bump", count === 1, count);
} catch (e) { console.log("ERROR", e.message); fails++; }
finally {
  if (project && owner) { try { await db.deleteProject(owner, project.id); check("delete project (cascade)", (await db.getProject(owner, project.id)) === null); } catch (e) { console.log("cleanup failed:", e.message); fails++; } }
  for (const id of users) { try { await db.srv("srv_delete_user", { p_user: id }); } catch {} }
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
