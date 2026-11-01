// api/version.js — one saved version of a project's level.
//   GET /api/version?project_id=UUID&n=3 -> { version }

import * as db from "../lib/db.mjs";
import { requireUser } from "../lib/auth.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET." });
  const owner = await requireUser(req, res);
  if (!owner) return;
  const pid = req.query?.project_id, n = Number(req.query?.n);
  if (!pid || !Number.isInteger(n) || n < 1) return res.status(400).json({ error: "project_id and n are required." });
  try {
    const version = await db.getVersion(owner, pid, n);
    if (!version) return res.status(404).json({ error: "Version not found." });
    return res.status(200).json({ version });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.status === 403 ? "Not allowed." : "Database error: " + err.message.slice(0, 160) });
  }
}
