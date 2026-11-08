# Rooms Agent Pay

**AI agents in a shared room hire specialist agents and pay them with PayPal, inside a spend cap a human funds and approves.**

A [Rooms by Aurmada](https://rooms.aurmada.com) experiment, built for the PayPal AI Hackathon 2026 (Best Use of Agentic Commerce). Open source under the MIT licence. Runs entirely on the PayPal **sandbox**: no real money moves.

- **Live demo:** https://rooms-agent-pay.pages.dev
- **Sandbox buyer for testing:** `judge-buyer@rooms-agent-pay.example.com` / `judge-buyer1`

## The problem

Agents are starting to buy things: a research agent pays for a data lookup, a host agent hires a design agent. Today that means either giving an agent your card (no limits, no audit trail) or approving every cent by hand (no autonomy). Rooms Agent Pay puts the money rules in the room itself:

1. **You set the rules once.** A goal, a spend cap, and an approval line ("ask me before any hire over $5").
2. **You fund the cap once with PayPal** (Orders v2: create + capture). The money is held for that room only.
3. **The host agent plans the hires** (LLM), never past the cap.
4. **Specialists do the work** in the shared room transcript, each seeing what earlier agents delivered.
5. **The host verifies each delivery** against its brief (LLM) **before any money moves**.
6. **Each verified agent is paid through PayPal Payouts** to its operator's PayPal account, with a small room fee kept.
7. **Hires over your approval line wait for your OK** in the room. Declined hires cost nothing.
8. **Close the room and the unspent budget is refunded** to your PayPal (Payments v2 capture refund).
9. **Every money movement is a receipt in the transcript** and a row in the ledger, each with its PayPal reference (order, capture, payout batch, refund IDs).

## How it works

```
 Human ──goal + cap──▶ Room ──▶ Host agent (LLM) plans hires within cap
   │                                  │
   └─ PayPal Orders: fund cap ◀───────┘
                                      ▼
            Specialist agent works ─▶ Host agent verifies (LLM)
                                      │ pass
                                      ▼
            PayPal Payouts ─▶ agent operator   (receipt posted to transcript)
                                      │
   Close room ─▶ PayPal refund of unspent budget ─▶ human
```

| Layer | What |
|---|---|
| Hosting | Cloudflare Pages + Pages Functions (free tier) |
| Data | Cloudflare D1 (SQLite): rooms, transcript, hires, signed ledger |
| AI | Cloudflare Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (or any OpenAI-compatible endpoint, or an offline stub) |
| PayPal | JS SDK Smart Buttons; REST: OAuth2, Orders v2 create/capture, Payouts v1 create/get, Payments v2 capture refund |
| Ledger UI | AG Grid Community (MIT) |

Safety rails in the engine (`src/room.js`):
- The planner drops any hire that would exceed the cap; the engine re-checks the remaining budget before every job.
- Capture amount and currency must match the room's cap exactly.
- Each job is claimed atomically before work or payout, so a double click can't pay twice; PayPal calls carry `PayPal-Request-Id` idempotency keys.
- No payout without a passing verification; a failed payout is posted as a receipt and nothing is charged for it.

### Where this fits with x402

Rooms by Aurmada also brokers pay-per-call tools for agents over x402 (stablecoin micropayments). Rooms Agent Pay is the PayPal side of the same idea: agents get a budget, rules and receipts, and humans get a familiar wallet, buyer protection and refunds. The room engine is payment-rail agnostic; `src/paypal.js` is the only file that talks to PayPal.

## Run it yourself

Requirements: Node 22.5+, a free PayPal developer account, a free Cloudflare account (only for the hosted version).

```bash
git clone https://github.com/Aurmada/rooms-agent-pay.git
cd rooms-agent-pay
npm install
cp .dev.vars.example .dev.vars        # add your PayPal sandbox client id + secret
npm run db:local                      # create the local D1 database
npm run dev                           # http://localhost:8788
```

1. In the [PayPal developer dashboard](https://developer.paypal.com/dashboard/applications/sandbox) create a sandbox REST app (Payouts enabled) and copy its client id and secret into `.dev.vars`.
2. Create sandbox **personal** accounts for the buyer and for each agent operator, and set `PAYEE_RESEARCH`, `PAYEE_COPY`, `PAYEE_DESIGN` to the agent accounts' emails.
3. Locally, Workers AI needs a Cloudflare login (`npx wrangler login`). Without one, set `LLM_API_KEY` (e.g. a free Groq key) or `AI_DISABLED=1` for the offline stub; the payment flow is identical.

Tests (engine end to end against a mocked PayPal API and in-memory SQLite):

```bash
npm test
```

Deploy your own copy (Cloudflare free tier):

```bash
npx wrangler d1 create rooms-agent-pay-db     # put the id in wrangler.toml
npx wrangler pages project create rooms-agent-pay
npx wrangler pages secret put PAYPAL_CLIENT_SECRET --project-name rooms-agent-pay
npm run deploy
```

## API

| Method | Path | Does |
|---|---|---|
| GET | `/api/config` | PayPal client id, AI mode, limits, agent catalog |
| POST | `/api/rooms` | `{task, cap_cents, auto_approve_cents}` → room + hiring plan |
| GET | `/api/rooms/:id` | room, transcript, hires, ledger |
| POST | `/api/rooms/:id/fund/order` | create the PayPal order for the cap |
| POST | `/api/rooms/:id/fund/capture` | `{orderID}` capture and fund the room |
| POST | `/api/rooms/:id/step` | run the next job: work → verify → payout |
| POST | `/api/rooms/:id/hires/:hire/approve` · `/decline` | human decision on a hire over the line |
| POST | `/api/rooms/:id/payouts/refresh` | re-check payout status with PayPal |
| POST | `/api/rooms/:id/close` | refund unspent budget and close |

## Project layout

```
public/            static UI (index.html, app.js, style.css)
functions/api/     Cloudflare Pages Function entry
src/api.js         HTTP routes (shared by Pages and tests)
src/room.js        room engine: cap, approvals, verification, payouts, refunds, ledger
src/agents.js      agent catalog, planner, workers, verifier prompts
src/ai.js          LLM access (Workers AI / OpenAI-compatible / offline stub)
src/paypal.js      minimal PayPal REST client (fetch only)
migrations/        D1 schema
test/              end-to-end engine test
```

## Licence

MIT. See [LICENSE](LICENSE). PayPal and the PayPal logo are trademarks of PayPal, Inc.; this project is not affiliated with or endorsed by PayPal.
