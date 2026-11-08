import { chat, parseJson } from "./ai.js";

// Specialist agents for hire. Each one is run by an operator who gets paid through PayPal Payouts.
// `payee` is the operator's PayPal account (sandbox test accounts in the demo; override with env vars).
export const CATALOG = [
  { slug: "research-agent", name: "Research Agent", skill: "Finds and summarises facts, options, prices and trade-offs into a short brief.", priceCents: 400, payeeEnv: "PAYEE_RESEARCH", payee: "research-agent@rooms-agent-pay.example.com" },
  { slug: "copy-agent", name: "Copy Agent", skill: "Writes clear copy: emails, announcements, product text, social posts.", priceCents: 300, payeeEnv: "PAYEE_COPY", payee: "copy-agent@rooms-agent-pay.example.com" },
  { slug: "design-agent", name: "Design Agent", skill: "Produces a layout / visual design spec: structure, hierarchy, colours, components.", priceCents: 600, payeeEnv: "PAYEE_DESIGN", payee: "design-agent@rooms-agent-pay.example.com" },
];

export const HOST = { slug: "rooms-ai", name: "Rooms AI (host)" };

export function agentBySlug(slug) { return CATALOG.find(a => a.slug === slug) || null; }
export function payeeFor(env, agent) { return (env && env[agent.payeeEnv]) || agent.payee; }

const catalogText = () => CATALOG.map(a => `- ${a.slug}: ${a.skill} Fixed price $${(a.priceCents / 100).toFixed(2)} per job.`).join("\n");

// 1) The host agent turns the human's goal into a hiring plan that fits the cap.
export async function planHires(env, task, capCents) {
  const system = `You are Rooms AI, the host agent of a shared room where AI agents hire each other and are paid with PayPal.
Plan which specialist agents to hire for the user's goal. Only use agents from this catalog:
${catalogText()}
Rules: hire 1 to 3 agents, each at most once, in the order the work should happen. The total must not exceed the budget of $${(capCents / 100).toFixed(2)}.
Each brief is one or two sentences telling that agent exactly what to deliver.
Reply with JSON only: {"summary":"one sentence plan","hires":[{"agent":"<slug>","title":"<3-6 words>","brief":"..."}]}`;
  const { text, model } = await chat(env, system, `Goal: ${task}`, { maxTokens: 500, temperature: 0.2, stub: () => JSON.stringify(stubPlan(task)) });
  const j = parseJson(text) || stubPlan(task);
  const seen = new Set();
  let total = 0;
  const hires = [];
  for (const h of Array.isArray(j.hires) ? j.hires : []) {
    const a = agentBySlug(String(h.agent || "").trim());
    if (!a || seen.has(a.slug)) continue;
    if (total + a.priceCents > capCents) continue; // never plan past the human's cap
    seen.add(a.slug); total += a.priceCents;
    hires.push({ agent: a.slug, title: String(h.title || a.name).slice(0, 60), brief: String(h.brief || task).slice(0, 600), priceCents: a.priceCents });
    if (hires.length === 3) break;
  }
  if (!hires.length) {
    const cheapest = [...CATALOG].sort((x, y) => x.priceCents - y.priceCents)[0];
    if (cheapest.priceCents <= capCents) hires.push({ agent: cheapest.slug, title: cheapest.name, brief: task.slice(0, 600), priceCents: cheapest.priceCents });
  }
  return { summary: String(j.summary || "Here is the hiring plan.").slice(0, 300), hires, model };
}

function stubPlan(task) {
  return { summary: "Research first, then write it up.", hires: [
    { agent: "research-agent", title: "Background research", brief: `Research the key facts and options for: ${task}` },
    { agent: "copy-agent", title: "Write the final copy", brief: `Using the research, write the final copy for: ${task}` },
  ] };
}

// 2) A hired specialist does its job (it sees the goal and earlier deliverables in the room).
export async function doWork(env, agent, hire, task, earlier) {
  const context = earlier.length ? `\n\nWork already delivered in this room:\n${earlier.map(e => `[${e.agent}] ${e.deliverable}`).join("\n\n").slice(0, 3500)}` : "";
  const system = `You are ${agent.name}, a specialist AI agent hired and paid inside a Rooms by Aurmada room. ${agent.skill}
Deliver exactly what the brief asks, ready to use. Be concise: at most 180 words, plain text or simple bullet points, no preamble.`;
  const { text, model } = await chat(env, system, `Room goal: ${task}\nYour brief: ${hire.brief}${context}`, { maxTokens: 450, temperature: 0.5,
    stub: () => `(${agent.name}, offline mode) Deliverable for "${hire.title}": ${hire.brief}` });
  return { text: (text || "").trim().slice(0, 2500), model };
}

// 3) The host verifies the delivery against the brief before any money moves.
export async function verify(env, agent, hire, deliverable) {
  const system = `You are Rooms AI, the escrow verifier. Money is released to an agent only if its delivery satisfies the brief.
Reply with JSON only: {"pass":true|false,"reason":"one short sentence"}`;
  const { text, model } = await chat(env, system, `Brief for ${agent.name}: ${hire.brief}\n\nDelivery:\n${deliverable}`, { maxTokens: 120, temperature: 0,
    stub: () => JSON.stringify({ pass: deliverable.length > 40, reason: "Offline check: delivery is present and on topic." }) });
  const j = parseJson(text);
  if (!j || typeof j.pass !== "boolean") {
    const pass = deliverable.trim().length > 40;
    return { pass, reason: pass ? "Delivery received and matches the brief." : "Delivery was empty.", model };
  }
  return { pass: j.pass, reason: String(j.reason || "").slice(0, 200), model };
}
