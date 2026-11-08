// The room engine: a human sets a spend cap and funds it with PayPal; the host agent plans hires;
// specialists deliver; the host verifies; PayPal Payouts pays each agent; unspent budget is refunded.
// Every money movement is written to the ledger and posted into the room transcript as a receipt.
import { PayPal, captureFrom } from "./paypal.js";
import { planHires, doWork, verify, agentBySlug, payeeFor, HOST } from "./agents.js";

export const LIMITS = { minCapCents: 500, maxCapCents: 5000, defaultAutoApproveCents: 500, feeBps: 500 };

const now = () => Date.now();
const fmt = (c, cur = "USD") => `${cur === "USD" ? "$" : ""}${(c / 100).toFixed(2)}${cur === "USD" ? "" : " " + cur}`;
const rid = (n = 10) => { const a = "abcdefghijkmnopqrstuvwxyz23456789"; let s = ""; const b = crypto.getRandomValues(new Uint8Array(n)); for (const x of b) s += a[x % a.length]; return s; };

export class RoomError extends Error { constructor(code, status = 400, msg) { super(msg || code); this.code = code; this.status = status; } }

export function paypalFor(env) {
  return new PayPal({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, base: env.PAYPAL_API_BASE || undefined });
}

async function post(db, roomId, author, kind, body, meta) {
  await db.prepare("INSERT INTO messages (room_id, author, kind, body, meta, created_at) VALUES (?,?,?,?,?,?)")
    .bind(roomId, author, kind, body, meta ? JSON.stringify(meta) : null, now()).run();
}
async function ledger(db, roomId, type, party, amountCents, ref, status, note) {
  await db.prepare("INSERT INTO ledger (room_id, ts, type, party, amount_cents, paypal_ref, status, note) VALUES (?,?,?,?,?,?,?,?)")
    .bind(roomId, now(), type, party, amountCents, ref || null, status, note || null).run();
}
async function getRoom(db, id) {
  const r = await db.prepare("SELECT * FROM rooms WHERE id = ?").bind(id).first();
  if (!r) throw new RoomError("room_not_found", 404);
  return r;
}

export async function loadRoom(env, id) {
  const db = env.DB;
  const room = await getRoom(db, id);
  const [m, h, l] = await Promise.all([
    db.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY id").bind(id).all(),
    db.prepare("SELECT * FROM hires WHERE room_id = ? ORDER BY seq").bind(id).all(),
    db.prepare("SELECT * FROM ledger WHERE room_id = ? ORDER BY id").bind(id).all(),
  ]);
  const messages = (m.results || []).map(x => ({ ...x, meta: x.meta ? JSON.parse(x.meta) : null }));
  const available = room.funded_cents - room.spent_cents - room.refunded_cents;
  return { room: { ...room, available_cents: available }, messages, hires: h.results || [], ledger: l.results || [] };
}

export async function createRoom(env, { task, capCents, autoApproveCents }) {
  task = String(task || "").trim().slice(0, 500);
  if (task.length < 8) throw new RoomError("task_too_short");
  capCents = Math.round(Number(capCents));
  if (!(capCents >= LIMITS.minCapCents && capCents <= LIMITS.maxCapCents)) throw new RoomError("cap_out_of_range", 400, `Spend cap must be between ${fmt(LIMITS.minCapCents)} and ${fmt(LIMITS.maxCapCents)} (sandbox demo).`);
  const auto = Math.max(0, Math.min(capCents, Math.round(Number(autoApproveCents ?? LIMITS.defaultAutoApproveCents))));
  const currency = env.CURRENCY || "USD";
  const db = env.DB, id = rid();
  await db.prepare("INSERT INTO rooms (id, task, currency, cap_cents, auto_approve_cents, status, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, task, currency, capCents, auto, "planning", now()).run();
  await post(db, id, "you", "chat", task, { cap_cents: capCents, auto_approve_cents: auto });
  const plan = await planHires(env, task, capCents);
  let seq = 0, total = 0;
  for (const h of plan.hires) {
    const needs = h.priceCents > auto;
    await db.prepare("INSERT INTO hires (id, room_id, seq, agent, title, brief, price_cents, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(`${id}-${++seq}`, id, seq, h.agent, h.title, h.brief, h.priceCents, needs ? "needs_approval" : "proposed", now()).run();
    total += h.priceCents;
  }
  const lines = plan.hires.map((h, i) => `${i + 1}. @${h.agent} — ${h.title} (${fmt(h.priceCents, currency)})${h.priceCents > auto ? " · needs your OK" : ""}`).join("\n");
  await post(db, id, HOST.slug, "plan", `${plan.summary}\n${lines}\nPlanned total ${fmt(total, currency)} of your ${fmt(capCents, currency)} cap. Fund the room with PayPal to start; anything unspent is refunded when the room closes.`,
    { model: plan.model, total_cents: total });
  await db.prepare("UPDATE rooms SET status = 'awaiting_funds' WHERE id = ?").bind(id).run();
  return loadRoom(env, id);
}

export async function createFundingOrder(env, id) {
  const db = env.DB, room = await getRoom(db, id);
  if (room.funded_cents > 0) throw new RoomError("already_funded", 409);
  const order = await paypalFor(env).createOrder({ roomId: id, cents: room.cap_cents, currency: room.currency, description: `Room budget: ${room.task}` });
  await db.prepare("UPDATE rooms SET order_id = ? WHERE id = ?").bind(order.id, id).run();
  return { orderID: order.id };
}

export async function captureFunding(env, id, orderId) {
  const db = env.DB, room = await getRoom(db, id);
  if (room.funded_cents > 0) return loadRoom(env, id);
  if (!orderId || orderId !== room.order_id) throw new RoomError("order_mismatch", 409);
  const pp = paypalFor(env);
  const order = await pp.captureOrder(orderId);
  const cap = captureFrom(order);
  if (!cap || cap.status !== "COMPLETED") throw new RoomError("capture_not_completed", 402, `PayPal capture status: ${cap?.status || order.status}`);
  if (cap.cents !== room.cap_cents || cap.currency !== room.currency) throw new RoomError("amount_mismatch", 409);
  const upd = await db.prepare("UPDATE rooms SET funded_cents = ?, capture_id = ?, status = 'funded' WHERE id = ? AND funded_cents = 0").bind(cap.cents, cap.id, id).run();
  if (upd.meta?.changes === 0) return loadRoom(env, id);
  await ledger(db, id, "funding", cap.payer || "payer", cap.cents, cap.id, cap.status, `Order ${orderId}`);
  await post(db, id, "paypal", "receipt", `Room funded: ${fmt(cap.cents, room.currency)} captured from ${cap.payer || "the payer"}. Agents can now spend up to this cap.`,
    { type: "funding", order_id: orderId, capture_id: cap.id, status: cap.status, amount_cents: cap.cents });
  return loadRoom(env, id);
}

export async function decide(env, id, hireId, approve) {
  const db = env.DB, room = await getRoom(db, id);
  if (room.status === "closed") throw new RoomError("room_closed", 409);
  const h = await db.prepare("SELECT * FROM hires WHERE id = ? AND room_id = ?").bind(hireId, id).first();
  if (!h) throw new RoomError("hire_not_found", 404);
  if (h.status !== "needs_approval") throw new RoomError("not_awaiting_approval", 409);
  await db.prepare("UPDATE hires SET status = ? WHERE id = ? AND status = 'needs_approval'").bind(approve ? "approved" : "declined", hireId).run();
  await post(db, id, "you", "approval", approve ? `Approved: @${h.agent} for ${fmt(h.price_cents, room.currency)}.` : `Declined: @${h.agent}. No money will move for this job.`, { hire_id: hireId, approve: !!approve });
  return loadRoom(env, id);
}

// Advance the room by one job. Safe to call repeatedly; a job is claimed atomically before any work or payout.
export async function step(env, id) {
  const db = env.DB, room = await getRoom(db, id);
  if (room.funded_cents <= 0) throw new RoomError("not_funded", 402, "Fund the room with PayPal first.");
  if (room.status === "closed") return { ...(await loadRoom(env, id)), waiting: "closed" };
  const next = await db.prepare("SELECT * FROM hires WHERE room_id = ? AND status IN ('proposed','approved','needs_approval','working') ORDER BY seq LIMIT 1").bind(id).first();
  if (!next) {
    if (room.status !== "done") {
      await db.prepare("UPDATE rooms SET status = 'done' WHERE id = ?").bind(id).run();
      const left = room.funded_cents - room.spent_cents - room.refunded_cents;
      await post(db, id, HOST.slug, "chat", `All jobs are finished. Spent ${fmt(room.spent_cents, room.currency)} of ${fmt(room.funded_cents, room.currency)}. Close the room to refund the unspent ${fmt(left, room.currency)} to your PayPal.`);
    }
    return { ...(await loadRoom(env, id)), waiting: "close" };
  }
  if (next.status === "needs_approval") return { ...(await loadRoom(env, id)), waiting: "approval", hire_id: next.id };
  if (next.status === "working") return { ...(await loadRoom(env, id)), waiting: "working" };
  const available = room.funded_cents - room.spent_cents - room.refunded_cents;
  if (next.price_cents > available) {
    await db.prepare("UPDATE hires SET status = 'declined' WHERE id = ?").bind(next.id).run();
    await post(db, id, HOST.slug, "chat", `Skipped @${next.agent}: ${fmt(next.price_cents, room.currency)} would exceed the remaining budget of ${fmt(available, room.currency)}. The cap holds.`);
    return loadRoom(env, id);
  }
  const claim = await db.prepare("UPDATE hires SET status = 'working' WHERE id = ? AND status IN ('proposed','approved')").bind(next.id).run();
  if (claim.meta?.changes === 0) return { ...(await loadRoom(env, id)), waiting: "working" };
  await db.prepare("UPDATE rooms SET status = 'working' WHERE id = ?").bind(id).run();

  const agent = agentBySlug(next.agent);
  const earlier = ((await db.prepare("SELECT agent, deliverable FROM hires WHERE room_id = ? AND status = 'paid' ORDER BY seq").bind(id).all()).results) || [];
  await post(db, id, HOST.slug, "chat", `@${agent.slug} you're hired for "${next.title}" at ${fmt(next.price_cents, room.currency)}. Payment is held until I verify the delivery.`, { hire_id: next.id });
  const work = await doWork(env, agent, next, room.task, earlier);
  await post(db, id, agent.slug, "deliverable", work.text || "(no delivery)", { hire_id: next.id, model: work.model });
  const v = await verify(env, agent, next, work.text || "");
  await post(db, id, HOST.slug, "verdict", `${v.pass ? "Verified" : "Rejected"}: ${v.reason}`, { hire_id: next.id, pass: v.pass, model: v.model });
  if (!v.pass) {
    await db.prepare("UPDATE hires SET status = 'rejected', deliverable = ?, verdict = ? WHERE id = ?").bind(work.text, v.reason, next.id).run();
    return loadRoom(env, id);
  }

  const fee = Math.round(next.price_cents * LIMITS.feeBps / 10000);
  const net = next.price_cents - fee;
  const receiver = payeeFor(env, agent);
  try {
    const p = await paypalFor(env).createPayout({ batchId: `rooms-${next.id}`, receiver, cents: net, currency: room.currency, itemId: next.id,
      note: `Payment for "${next.title}" in a Rooms by Aurmada room (job ${next.id}).` });
    const batch = p.batch_header || {};
    await db.prepare("UPDATE hires SET status = 'paid', deliverable = ?, verdict = ?, payout_batch_id = ?, payout_status = ? WHERE id = ?")
      .bind(work.text, v.reason, batch.payout_batch_id, batch.batch_status, next.id).run();
    await db.prepare("UPDATE rooms SET spent_cents = spent_cents + ? WHERE id = ?").bind(next.price_cents, id).run();
    await ledger(db, id, "payout", receiver, -net, batch.payout_batch_id, batch.batch_status || "PENDING", `${agent.name}: ${next.title}`);
    await ledger(db, id, "platform_fee", "Rooms by Aurmada", -fee, batch.payout_batch_id, "RETAINED", `${LIMITS.feeBps / 100}% fee`);
    await post(db, id, "paypal", "receipt", `Paid @${agent.slug} ${fmt(net, room.currency)} via PayPal Payouts (+ ${fmt(fee, room.currency)} room fee). Batch ${batch.payout_batch_id}: ${batch.batch_status}.`,
      { type: "payout", hire_id: next.id, payout_batch_id: batch.payout_batch_id, status: batch.batch_status, amount_cents: net, fee_cents: fee, receiver });
  } catch (e) {
    await db.prepare("UPDATE hires SET status = 'failed', deliverable = ?, verdict = ? WHERE id = ?").bind(work.text, `payout failed: ${e.message}`, next.id).run();
    await post(db, id, "paypal", "receipt", `Payout to @${agent.slug} failed: ${e.message}. No money moved for this job.`, { type: "payout_failed", hire_id: next.id, debug_id: e.debugId || null });
  }
  return loadRoom(env, id);
}

export async function refreshPayouts(env, id) {
  const db = env.DB;
  const pending = ((await db.prepare("SELECT * FROM hires WHERE room_id = ? AND payout_batch_id IS NOT NULL AND (payout_status IS NULL OR payout_status NOT IN ('SUCCESS','DENIED'))").bind(id).all()).results) || [];
  const pp = pending.length ? paypalFor(env) : null;
  for (const h of pending) {
    try {
      const b = await pp.getPayout(h.payout_batch_id);
      const item = b.items?.[0];
      const st = item?.transaction_status || b.batch_header?.batch_status;
      await db.prepare("UPDATE hires SET payout_status = ? WHERE id = ?").bind(st, h.id).run();
      await db.prepare("UPDATE ledger SET status = ? WHERE room_id = ? AND type = 'payout' AND paypal_ref = ?").bind(st, id, h.payout_batch_id).run();
    } catch (e) { console.log("refresh payout", h.id, e.message); }
  }
  return loadRoom(env, id);
}

export async function closeRoom(env, id) {
  const db = env.DB, room = await getRoom(db, id);
  if (room.status === "closed") return loadRoom(env, id);
  const working = await db.prepare("SELECT COUNT(*) AS n FROM hires WHERE room_id = ? AND status = 'working'").bind(id).first();
  if (working?.n) throw new RoomError("job_in_progress", 409, "Wait for the current job to finish.");
  await db.prepare("UPDATE hires SET status = 'declined' WHERE room_id = ? AND status IN ('proposed','approved','needs_approval')").bind(id).run();
  const left = room.funded_cents - room.spent_cents - room.refunded_cents;
  if (left > 0 && room.capture_id) {
    const r = await paypalFor(env).refundCapture({ captureId: room.capture_id, cents: left, currency: room.currency, requestId: `refund-${id}`, note: "Unspent room budget returned by Rooms by Aurmada." });
    await db.prepare("UPDATE rooms SET refunded_cents = refunded_cents + ? WHERE id = ?").bind(left, id).run();
    await ledger(db, id, "refund", "payer", -left, r.id, r.status, "Unspent budget");
    await post(db, id, "paypal", "receipt", `Refunded the unspent ${fmt(left, room.currency)} to your PayPal. Refund ${r.id}: ${r.status}.`, { type: "refund", refund_id: r.id, status: r.status, amount_cents: left });
  }
  await db.prepare("UPDATE rooms SET status = 'closed' WHERE id = ?").bind(id).run();
  await post(db, id, HOST.slug, "chat", "Room closed. Every payment above has a PayPal reference in the ledger.");
  return loadRoom(env, id);
}
