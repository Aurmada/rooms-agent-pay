// End-to-end engine test with an in-memory SQLite D1 shim, the offline AI stub and a mocked PayPal API.
// Run: npm test   (Node >= 22.5)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handle } from "../src/api.js";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
  });
  return { prepare: (sql) => stmt(sql) };
}

function mockPayPal() {
  const calls = [];
  let order = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), body = init.body && init.body.startsWith?.("{") ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: u.pathname, body, requestId: init.headers?.["paypal-request-id"] });
    const ok = (j) => new Response(JSON.stringify(j), { status: 200 });
    if (u.pathname === "/v1/oauth2/token") return ok({ access_token: "t", expires_in: 3600 });
    if (u.pathname === "/v2/checkout/orders") { order = { id: "ORDER1", amount: body.purchase_units[0].amount }; return ok({ id: "ORDER1", status: "CREATED" }); }
    if (u.pathname.endsWith("/capture")) return ok({ id: order.id, status: "COMPLETED", payer: { email_address: "judge-buyer@example.com" },
      purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: order.amount }] } }] });
    if (u.pathname === "/v1/payments/payouts") return ok({ batch_header: { payout_batch_id: "BATCH-" + body.items[0].sender_item_id, batch_status: "PENDING" } });
    if (u.pathname.startsWith("/v1/payments/payouts/")) return ok({ batch_header: { batch_status: "SUCCESS" }, items: [{ transaction_status: "SUCCESS" }] });
    if (u.pathname.endsWith("/refund")) return ok({ id: "REFUND1", status: "COMPLETED" });
    return new Response("{}", { status: 404 });
  };
  return calls;
}

const env = () => ({ DB: d1(), PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", CURRENCY: "USD" });
const api = async (e, method, path, body) => {
  const r = await handle(new Request("http://x/api" + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } }), e);
  return { status: r.status, j: await r.json() };
};

test("fund → hire → verify → payout → refund, never past the cap", async () => {
  const calls = mockPayPal();
  const e = env();
  const c = await api(e, "POST", "/rooms", { task: "Write a launch announcement for our product", cap_cents: 1000, auto_approve_cents: 300 });
  assert.equal(c.status, 201);
  const id = c.j.room.id;
  assert.equal(c.j.room.status, "awaiting_funds");
  const planned = c.j.hires.reduce((s, h) => s + h.price_cents, 0);
  assert.ok(planned <= 1000);
  // research ($4) is above the $3 auto-approve line, so it waits for the human.
  assert.equal(c.j.hires[0].status, "needs_approval");

  assert.equal((await api(e, "POST", `/rooms/${id}/step`)).status, 402); // can't spend before funding
  const o = await api(e, "POST", `/rooms/${id}/fund/order`);
  assert.equal(o.j.orderID, "ORDER1");
  assert.equal((await api(e, "POST", `/rooms/${id}/fund/capture`, { orderID: "WRONG" })).status, 409);
  const f = await api(e, "POST", `/rooms/${id}/fund/capture`, { orderID: "ORDER1" });
  assert.equal(f.j.room.funded_cents, 1000);

  let s = await api(e, "POST", `/rooms/${id}/step`);
  assert.equal(s.j.waiting, "approval");
  await api(e, "POST", `/rooms/${id}/hires/${s.j.hire_id}/approve`);
  for (let i = 0; i < 5; i++) { s = await api(e, "POST", `/rooms/${id}/step`); if (s.j.waiting === "close") break; }
  assert.equal(s.j.waiting, "close");
  const paid = s.j.hires.filter(h => h.status === "paid");
  assert.equal(paid.length, 2);
  const payouts = calls.filter(c => c.path === "/v1/payments/payouts");
  assert.equal(payouts.length, 2);
  assert.equal(payouts[0].body.items[0].amount.value, "3.80"); // $4 minus 5% fee
  assert.ok(payouts.every(p => p.requestId?.startsWith("rooms-"))); // idempotent payouts

  await api(e, "POST", `/rooms/${id}/payouts/refresh`);
  const done = await api(e, "POST", `/rooms/${id}/close`);
  assert.equal(done.j.room.status, "closed");
  assert.equal(done.j.room.refunded_cents, 1000 - 700);
  const refund = calls.find(c => c.path.endsWith("/refund"));
  assert.equal(refund.body.amount.value, "3.00");
  const sum = done.j.ledger.reduce((s, l) => s + l.amount_cents, 0);
  assert.equal(sum, 0); // every cent funded is paid out, kept as fee, or refunded
  assert.ok(done.j.ledger.filter(l => l.type === "payout").every(l => l.status === "SUCCESS"));
  assert.ok(done.j.messages.some(m => m.kind === "receipt" && m.meta?.type === "refund"));
});

test("cap limits are enforced", async () => {
  mockPayPal();
  const e = env();
  assert.equal((await api(e, "POST", "/rooms", { task: "Something useful to do", cap_cents: 100 })).status, 400);
  assert.equal((await api(e, "POST", "/rooms", { task: "Something useful to do", cap_cents: 999999 })).status, 400);
});
