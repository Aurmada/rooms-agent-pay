// Minimal PayPal REST client (sandbox by default). Uses only fetch, so it runs on
// Cloudflare Workers/Pages Functions and on Node 18+.
// APIs used: OAuth2 client credentials, Orders v2 (create / get / capture),
// Payments v2 captures (refund), Payouts v1 (create batch / get batch).

export const SANDBOX = "https://api-m.sandbox.paypal.com";

export function money(cents, currency) {
  return { currency_code: currency, value: (cents / 100).toFixed(2) };
}

export class PayPal {
  constructor({ clientId, clientSecret, base = SANDBOX, fetchImpl }) {
    if (!clientId || !clientSecret) throw new Error("paypal_not_configured");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.base = base;
    this.fetch = fetchImpl || fetch.bind(globalThis);
    this._token = null;
    this._exp = 0;
  }

  async token() {
    if (this._token && Date.now() < this._exp - 60_000) return this._token;
    const basic = btoa(`${this.clientId}:${this.clientSecret}`);
    const r = await this.fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const j = await r.json();
    if (!r.ok) throw new PayPalError("oauth_failed", r.status, j);
    this._token = j.access_token;
    this._exp = Date.now() + (j.expires_in || 300) * 1000;
    return this._token;
  }

  async call(method, path, body, { requestId } = {}) {
    const headers = { authorization: `Bearer ${await this.token()}`, "content-type": "application/json", prefer: "return=representation" };
    if (requestId) headers["paypal-request-id"] = requestId; // idempotency
    const r = await this.fetch(`${this.base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 500) }; }
    if (!r.ok) throw new PayPalError(j.name || "paypal_error", r.status, j);
    return j;
  }

  // Human funds the room's spend cap. Money is captured into the platform's (sandbox) business account,
  // which acts as escrow for the room until agents are paid out or the rest is refunded.
  createOrder({ roomId, cents, currency, description }) {
    return this.call("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: roomId,
        custom_id: roomId,
        description: description.slice(0, 127),
        soft_descriptor: "ROOMS AGENTPAY",
        amount: money(cents, currency),
      }],
      payment_source: { paypal: { experience_context: { brand_name: "Rooms by Aurmada", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } } },
    }, { requestId: `order-${roomId}-${cents}` });
  }

  getOrder(orderId) { return this.call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`); }

  captureOrder(orderId) {
    return this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, { requestId: `capture-${orderId}` });
  }

  refundCapture({ captureId, cents, currency, note, requestId }) {
    return this.call("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      amount: money(cents, currency), note_to_payer: note.slice(0, 255),
    }, { requestId });
  }

  // Pay an agent (its operator's PayPal account) for a delivered, verified job.
  createPayout({ batchId, receiver, cents, currency, note, itemId }) {
    return this.call("POST", "/v1/payments/payouts", {
      sender_batch_header: { sender_batch_id: batchId, email_subject: "You were paid by an agent in Rooms", email_message: note.slice(0, 1000) },
      items: [{ recipient_type: "EMAIL", receiver, amount: { value: (cents / 100).toFixed(2), currency }, note: note.slice(0, 4000), sender_item_id: itemId }],
    }, { requestId: batchId });
  }

  getPayout(batchId) { return this.call("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`); }
}

export class PayPalError extends Error {
  constructor(name, status, body) {
    super(`${name} (${status})${body?.message ? ": " + body.message : ""}`);
    this.name = "PayPalError";
    this.code = name;
    this.status = status;
    this.body = body;
    this.debugId = body?.debug_id;
  }
}

// Pull the capture out of an Orders v2 capture response.
export function captureFrom(order) {
  const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
  if (!cap) return null;
  return {
    id: cap.id,
    status: cap.status,
    cents: Math.round(Number(cap.amount?.value || 0) * 100),
    currency: cap.amount?.currency_code,
    payer: order?.payer?.email_address || null,
  };
}
