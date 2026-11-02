// lib/credits.mjs — pay for AI work. Server-side only.
// The database does the money part in one transaction (public.charge: price x model multiplier, balance, daily limit,
// ledger). This file wraps an AI call: charge first, run the work, refund automatically if the work throws.

import { rpc, srv, serverConfigured } from "./db.mjs";

export const CREDIT_ERRORS = {
  insufficient_credits: (r) => `Not enough credits: this costs ${r.cost} and you have ${r.balance}.`,
  daily_limit: (r) => `Daily limit reached: you have used ${r.spent_today} of ${r.daily_limit} credits today.`,
  model_disabled: () => "That model is switched off right now. Pick another one.",
  unknown_action: () => "Unknown action.",
  blocked: () => "Your account cannot use paid actions right now.",
};

/** Charge the caller. Returns { ok, ledgerId, cost, balance, provider, model } or { ok:false, status, body }. */
export async function charge(ctx, action, { model = null, gameId = null } = {}) {
  let r;
  try { r = await rpc("charge", { p_action: action, p_model: model, p_game_id: gameId }, ctx.token); }
  catch (err) { return { ok: false, status: 502, body: { error: "Could not check your credits. Try again." } }; }
  if (!r?.ok) {
    const status = r?.error === "blocked" ? 403 : r?.error === "unknown_action" ? 400 : r?.error === "model_disabled" ? 409 : 402;
    const msg = (CREDIT_ERRORS[r?.error] || (() => "Payment failed."))(r || {});
    return { ok: false, status, body: { error: msg, credits: { error: r?.error, cost: r?.cost, balance: r?.balance, action, daily_limit: r?.daily_limit, spent_today: r?.spent_today }, ...(r?.blocked ? { blocked: r.blocked } : {}) } };
  }
  return { ok: true, ledgerId: r.ledger_id, cost: r.cost, balance: r.balance, model: r.model, provider: r.provider, modelName: r.model_name };
}

/** Give a charge back. Never throws (a failed refund is logged and shows up in the ledger audit). */
export async function refund(ledgerId, reason = "refund: the AI call failed") {
  if (!ledgerId || !serverConfigured()) return null;
  try { return await srv("srv_refund", { p_ledger_id: ledgerId, p_reason: reason }); }
  catch (err) { console.error("REFUND FAILED for ledger", ledgerId, err.message); return null; }
}

/**
 * Charge, run `work(paid)`, refund if it throws. Sends the 402/403 response itself when the charge is refused
 * and returns undefined in that case. On success returns { result, credits: { spent, balance, action, model } }.
 */
export async function paid(ctx, res, action, opts, work) {
  const c = await charge(ctx, action, opts);
  if (!c.ok) { res.status(c.status).json(c.body); return undefined; }
  try {
    const result = await work(c);
    return { result, ledgerId: c.ledgerId, credits: { spent: c.cost, balance: c.balance, action, model: c.model } };
  } catch (err) {
    const back = await refund(c.ledgerId);
    err.refunded = !!back?.ok;
    err.balance = back?.balance ?? c.balance;
    throw err;
  }
}
