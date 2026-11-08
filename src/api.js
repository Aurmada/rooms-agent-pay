// HTTP API shared by the Cloudflare Pages Function and the Node test harness.
import { createRoom, loadRoom, createFundingOrder, captureFunding, decide, step, refreshPayouts, closeRoom, RoomError, LIMITS } from "./room.js";
import { CATALOG } from "./agents.js";
import { aiMode } from "./ai.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const method = request.method;
  const body = method === "POST" ? await request.json().catch(() => ({})) : {};
  const m = path.match(/^\/rooms\/([a-z0-9]+)(\/.*)?$/);
  try {
    if (method === "GET" && path === "/config") {
      return json({
        paypalClientId: env.PAYPAL_CLIENT_ID || null,
        paypalConfigured: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
        currency: env.CURRENCY || "USD",
        environment: "sandbox",
        ai: aiMode(env),
        limits: LIMITS,
        agents: CATALOG.map(({ slug, name, skill, priceCents }) => ({ slug, name, skill, priceCents })),
      });
    }
    if (method === "POST" && path === "/rooms") {
      return json(await createRoom(env, { task: body.task, capCents: body.cap_cents, autoApproveCents: body.auto_approve_cents }), 201);
    }
    if (m) {
      const [, id, sub = ""] = m;
      if (method === "GET" && sub === "") return json(await loadRoom(env, id));
      if (method === "POST" && sub === "/fund/order") return json(await createFundingOrder(env, id));
      if (method === "POST" && sub === "/fund/capture") return json(await captureFunding(env, id, body.orderID));
      if (method === "POST" && sub === "/step") return json(await step(env, id));
      if (method === "POST" && sub === "/payouts/refresh") return json(await refreshPayouts(env, id));
      if (method === "POST" && sub === "/close") return json(await closeRoom(env, id));
      const d = sub.match(/^\/hires\/([a-z0-9-]+)\/(approve|decline)$/);
      if (method === "POST" && d) return json(await decide(env, id, d[1], d[2] === "approve"));
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof RoomError) return json({ error: e.code, message: e.message }, e.status);
    if (e?.name === "PayPalError") return json({ error: "paypal_error", message: e.message, debug_id: e.debugId || null }, 502);
    console.log("api error", e?.stack || e);
    return json({ error: "server_error", message: String(e?.message || e) }, 500);
  }
}
