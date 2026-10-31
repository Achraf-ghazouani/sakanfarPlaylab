// Round trip against the real Supabase tables through lib/db.mjs (skipped when .env has no Supabase values).
// Run: node tests/db.test.mjs
try { process.loadEnvFile(".env"); } catch {}
const db = await import("../lib/db.mjs");

let fails = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 200) : ""}`);
  if (!cond) fails++;
}
if (!db.dbConfigured()) { console.log("SKIP  no SUPABASE_URL / SUPABASE_ANON_KEY in .env"); process.exit(0); }

const owner = "test-" + Math.random().toString(36).slice(2, 12);
const other = "test-" + Math.random().toString(36).slice(2, 12);
const level = { theme: "db test", objects: [{ type: "platform", label: "ground", x: 0, y: 900, w: 1000, h: 50 }, { type: "start", x: 40, y: 840, w: 40, h: 60 }, { type: "goal", x: 900, y: 840, w: 40, h: 60 }] };
let project = null;
try {
  project = await db.createProject(owner, { title: "DB test game", level });
  check("create project", !!project?.id && project.title === "DB test game" && project.owner === owner, project && { id: project.id });
  const v1 = await db.addVersion(owner, project.id, level, "created");
  check("first version is n=1", v1?.n === 1);
  const list = await db.listProjects(owner);
  check("owner sees the project in the list", list.some((p) => p.id === project.id));
  const foreign = await db.listProjects(other);
  check("another owner cannot see it (RLS)", !foreign.some((p) => p.id === project.id), foreign.length);
  check("another owner cannot fetch it by id", (await db.getProject(other, project.id)) === null);
  const msg = await db.addMessage(owner, project.id, { role: "user", content: "hello", meta: { a: 1 } });
  check("add message", msg?.role === "user" && msg.content === "hello");
  let bad = null; try { await db.addMessage(other, project.id, { role: "user", content: "intruder" }); } catch (e) { bad = e; }
  check("another owner cannot post messages (RLS)", !!bad, bad && bad.status);
  const msgs = await db.listMessages(owner, project.id);
  check("list messages", msgs.length === 1 && msgs[0].meta?.a === 1);
  const updated = await db.updateProject(owner, project.id, { title: "Renamed", level: { ...level, theme: "v2" } });
  check("update project", updated?.title === "Renamed" && updated.level.theme === "v2");
  const v2 = await db.addVersion(owner, project.id, updated.level, "edited");
  check("second version is n=2", v2?.n === 2);
  const versions = await db.listVersions(owner, project.id);
  check("versions listed newest first", versions.length === 2 && versions[0].n === 2);
  check("get a version", (await db.getVersion(owner, project.id, 1))?.level.theme === "db test");
  check("shared project not visible publicly before sharing", (await db.getSharedProject("nope-" + owner)) === null);
  const shared = await db.updateProject(owner, project.id, { share_id: "t" + owner.slice(5) });
  const pub = await db.getSharedProject(shared.share_id);
  check("shared project readable without owner", pub?.id === project.id && pub.owner === undefined);
  const count = await db.rpc("bump_play_count", { p_share_id: shared.share_id });
  check("play count bump", count === 1, count);
} catch (e) { console.log("ERROR", e.message); fails++; }
finally {
  if (project) { try { await db.deleteProject(owner, project.id); check("delete project (cascade)", (await db.getProject(owner, project.id)) === null); } catch (e) { console.log("cleanup failed:", e.message); fails++; } }
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
