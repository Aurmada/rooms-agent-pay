// LLM access for the agents. Order of preference:
//  1. Cloudflare Workers AI binding (env.AI) - free tier, no key, used by the hosted demo.
//  2. Any OpenAI-compatible endpoint (env.LLM_API_KEY + LLM_BASE_URL + LLM_MODEL), e.g. Groq or OpenAI.
//  3. A deterministic offline stub, so the payment flow can still be run with no AI account.

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function aiMode(env) {
  if (env.AI && env.AI_DISABLED !== "1") return "workers-ai";
  if (env.LLM_API_KEY) return "openai-compatible";
  return "offline-stub";
}

export async function chat(env, system, user, { maxTokens = 700, temperature = 0.4, stub } = {}) {
  const mode = aiMode(env);
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  try {
    if (mode === "workers-ai") {
      const r = await env.AI.run(env.AI_MODEL || WORKERS_AI_MODEL, { messages, max_tokens: maxTokens, temperature });
      const out = typeof r === "string" ? r : (r?.response ?? r?.result?.response ?? "");
      if (typeof out === "object") return { text: JSON.stringify(out), model: env.AI_MODEL || WORKERS_AI_MODEL };
      if (out) return { text: String(out), model: env.AI_MODEL || WORKERS_AI_MODEL };
    } else if (mode === "openai-compatible") {
      const base = env.LLM_BASE_URL || "https://api.groq.com/openai/v1";
      const model = env.LLM_MODEL || "llama-3.3-70b-versatile";
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.LLM_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      });
      const j = await r.json();
      const out = j?.choices?.[0]?.message?.content;
      if (out) return { text: out, model };
    }
  } catch (e) {
    console.log("ai error", String(e?.message || e));
  }
  return { text: stub ? stub() : "", model: "offline-stub" };
}

// Extract the first JSON object/array from model output.
export function parseJson(text) {
  if (!text) return null;
  if (typeof text === "object") return text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.search(/[[{]/);
  if (start < 0) return null;
  const open = src[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
