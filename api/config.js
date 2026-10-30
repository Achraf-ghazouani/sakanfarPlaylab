// api/config.js — public runtime config for the pages (no secrets).
// GET -> { relay: { url, key } | null }
// The Supabase publishable/anon key is designed to be used from browsers; it only allows what
// Realtime Broadcast permits on public channels. It still lives in env vars, not in the repo.

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  return res.status(200).json({ relay: url && key ? { url, key } : null });
}
