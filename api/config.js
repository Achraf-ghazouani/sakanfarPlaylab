// api/config.js — public runtime config for the pages (no secrets).
// GET -> { relay: { url, key } | null, supabase: { url, key } | null }
// The Supabase publishable key is designed for browsers: with row-level security it only reaches what the
// policies allow (a user's own rows, public games). It still lives in env vars, not in the repo.

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  const pub = url && key ? { url, key } : null;
  return res.status(200).json({ relay: pub, supabase: pub });
}
