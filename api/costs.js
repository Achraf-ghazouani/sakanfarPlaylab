// api/costs.js — the price list for the buttons (public, read-only).
//   GET -> { costs: { create_2d: { credits, label }, ... }, models: [{ id, label, description, multiplier, is_default }] }
// Display only: the database computes the real charge (public.charge) from the same tables.

import { rest, dbConfigured } from "../lib/db.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Use GET." });
  if (!dbConfigured()) return res.status(503).json({ error: "Not configured." });
  try {
    const [costs, models] = await Promise.all([
      rest("/costs?select=action,credits,label&order=sort.asc"),
      rest("/models?select=id,label,description,multiplier,is_default,provider&order=sort.asc"),
    ]);
    return res.status(200).json({
      costs: Object.fromEntries(costs.map((c) => [c.action, { credits: c.credits, label: c.label }])),
      models: models.map((m) => ({ ...m, multiplier: Number(m.multiplier) })),
    });
  } catch (err) {
    return res.status(502).json({ error: "Could not load prices." });
  }
}
