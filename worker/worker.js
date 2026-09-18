// Cloudflare Worker — agent-memory: a small mem0/Supermemory-style long-term
// memory layer for AI agents. POST /remember extracts atomic facts from raw
// text (via Claude Haiku 4.5), embeds them (Workers AI bge-m3) and stores
// them in Vectorize (semantic search) + D1 (structured metadata). POST
// /recall retrieves facts re-ranked by similarity, importance and recency.
// Deploy: see README.md

const ALLOWED_ORIGIN = "*"; // personal demo/portfolio tool, not gated to one site
const IP_DAILY_LIMIT = 30;
const GLOBAL_DAILY_LIMIT = 300;
const KV_TTL_SECONDS = 172800; // 2 days — safe buffer past the UTC day boundary

const EMBEDDING_MODEL = "@cf/baai/bge-m3";
const EXTRACTION_MODEL = "claude-haiku-4-5";
const TOP_K_CANDIDATES = 15; // over-fetch from Vectorize before re-ranking
const DEFAULT_RECALL_LIMIT = 5;
const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_FLOOR = 0.4; // an old but important fact should never hit ~0 weight

const EXTRACTION_SYSTEM = `You extract discrete, atomic, memorable facts from text for a long-term AI memory system (mem0/Supermemory style). Return ONLY a JSON array, no prose, no markdown fences.

Each item: {"text": "<standalone fact, third person, no pronouns that need outside context>", "type": "preference|fact|event|correction", "importance": <integer 1-5>}.

Rules:
- importance 5 = identity, names, major decisions/deadlines; 3 = generally useful info; 1 = trivial/ephemeral detail.
- "correction" type = this fact explicitly corrects or supersedes something said earlier in the same text.
- Skip filler, small talk, and anything not worth remembering long-term.
- If nothing is memorable, return [].`;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
  });
}

async function embed(env, text) {
  const res = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
  return res.data[0];
}

function checkRateLimit(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  return {
    ipKey: `ip:${ip}:${today}`,
    globalKey: `global:${today}`,
  };
}

async function enforceRateLimit(env, request, cors) {
  const { ipKey, globalKey } = checkRateLimit(env, request);
  const [ipCountStr, globalCountStr] = await Promise.all([
    env.RATE_LIMIT.get(ipKey),
    env.RATE_LIMIT.get(globalKey),
  ]);
  const ipCount = parseInt(ipCountStr || "0", 10);
  const globalCount = parseInt(globalCountStr || "0", 10);

  if (ipCount >= IP_DAILY_LIMIT) return { blocked: json({ error: "rate_limited", scope: "ip" }, 429, cors) };
  if (globalCount >= GLOBAL_DAILY_LIMIT) return { blocked: json({ error: "rate_limited", scope: "global" }, 429, cors) };

  return {
    bump: (ctx) =>
      ctx.waitUntil(
        Promise.allSettled([
          env.RATE_LIMIT.put(ipKey, String(ipCount + 1), { expirationTtl: KV_TTL_SECONDS }),
          env.RATE_LIMIT.put(globalKey, String(globalCount + 1), { expirationTtl: KV_TTL_SECONDS }),
        ])
      ),
  };
}

// --- Fact extraction via Claude Haiku 4.5 ---
async function extractFacts(env, text) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      max_tokens: 500,
      temperature: 0,
      system: EXTRACTION_SYSTEM,
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error("extraction_upstream_error", res.status, errBody);
    throw new Error("extraction_upstream_error");
  }

  const data = await res.json();
  const raw = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  // Defensive parse — strip accidental markdown fences if the model adds them anyway.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  let facts;
  try {
    facts = JSON.parse(cleaned);
  } catch (e) {
    facts = [];
  }
  if (!Array.isArray(facts)) return [];

  return facts
    .filter((f) => f && typeof f.text === "string" && f.text.trim().length > 0)
    .map((f) => ({
      text: f.text.trim().slice(0, 500),
      type: ["preference", "fact", "event", "correction"].includes(f.type) ? f.type : "fact",
      importance: Number.isInteger(f.importance) ? Math.min(5, Math.max(1, f.importance)) : 3,
    }));
}

// --- POST /remember ---
async function handleRemember(request, env, ctx, cors) {
  const limit = await enforceRateLimit(env, request, cors);
  if (limit.blocked) return limit.blocked;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request" }, 400, cors);
  }

  const text = (body && body.text ? String(body.text) : "").trim().slice(0, 4000);
  const source = (body && body.source ? String(body.source) : "demo").trim().slice(0, 100);
  if (!text) return json({ error: "empty_text" }, 400, cors);

  let facts;
  try {
    facts = await extractFacts(env, text);
  } catch (e) {
    return json({ error: "extraction_failed" }, 502, cors);
  }

  if (facts.length === 0) {
    limit.bump(ctx);
    return json({ stored: [], count: 0, note: "nothing_memorable" }, 200, cors);
  }

  const now = new Date().toISOString();
  const vectors = [];
  const stored = [];

  for (const fact of facts) {
    const id = crypto.randomUUID();
    const values = await embed(env, fact.text);
    vectors.push({
      id,
      values,
      metadata: { text: fact.text, type: fact.type, importance: fact.importance, created_at: now },
    });
    stored.push({ id, ...fact });
  }

  await env.VECTORIZE.upsert(vectors);

  const insertStmt = env.DB.prepare(
    "INSERT INTO facts (id, text, type, importance, source, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  await env.DB.batch(
    stored.map((f) => insertStmt.bind(f.id, f.text, f.type, f.importance, source, now))
  );

  limit.bump(ctx);
  return json({ stored, count: stored.length }, 200, cors);
}

// --- POST /recall ---
async function handleRecall(request, env, ctx, cors) {
  const limit = await enforceRateLimit(env, request, cors);
  if (limit.blocked) return limit.blocked;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request" }, 400, cors);
  }

  const query = (body && body.query ? String(body.query) : "").trim().slice(0, 500);
  const recallLimit = Number.isInteger(body && body.limit) ? Math.min(20, Math.max(1, body.limit)) : DEFAULT_RECALL_LIMIT;
  if (!query) return json({ error: "empty_query" }, 400, cors);

  const queryVector = await embed(env, query);
  const matches = await env.VECTORIZE.query(queryVector, { topK: TOP_K_CANDIDATES });
  const candidates = matches.matches || [];

  if (candidates.length === 0) {
    limit.bump(ctx);
    return json({ results: [], considered: 0 }, 200, cors);
  }

  const ids = candidates.map((m) => m.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB
    .prepare(`SELECT id, text, type, importance, created_at FROM facts WHERE id IN (${placeholders}) AND superseded_by IS NULL`)
    .bind(...ids)
    .all();

  const rowById = new Map((rows.results || []).map((r) => [r.id, r]));
  const now = Date.now();

  const scored = candidates
    .map((m) => {
      const row = rowById.get(m.id);
      if (!row) return null; // superseded or missing — excluded from recall
      const ageDays = (now - new Date(row.created_at).getTime()) / 86400000;
      const importanceWeight = 0.6 + 0.08 * row.importance;
      const recencyWeight = Math.max(RECENCY_FLOOR, Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS));
      const finalScore = m.score * importanceWeight * recencyWeight;
      return {
        id: row.id,
        text: row.text,
        type: row.type,
        importance: row.importance,
        similarity: Math.round(m.score * 1000) / 1000,
        age_days: Math.round(ageDays * 10) / 10,
        score: Math.round(finalScore * 1000) / 1000,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, recallLimit);

  if (scored.length > 0) {
    const touchStmt = env.DB.prepare("UPDATE facts SET last_accessed_at = ? WHERE id = ?");
    const nowIso = new Date().toISOString();
    ctx.waitUntil(env.DB.batch(scored.map((r) => touchStmt.bind(nowIso, r.id))));
  }

  limit.bump(ctx);
  return json({ results: scored, considered: candidates.length }, 200, cors);
}

// --- GET /stats ---
async function handleStats(env, cors) {
  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM facts WHERE superseded_by IS NULL").first();
  const byType = await env.DB
    .prepare("SELECT type, COUNT(*) AS n FROM facts WHERE superseded_by IS NULL GROUP BY type ORDER BY n DESC")
    .all();
  return json(
    { total: (totalRow && totalRow.n) || 0, by_type: (byType.results || []).map((r) => ({ type: r.type, count: r.n })) },
    200,
    cors
  );
}

// --- POST /admin/clear — wipe demo data (D1 + Vectorize) ---
async function handleClear(request, env, cors) {
  const adminKey = request.headers.get("X-Admin-Key") || "";
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return json({ error: "forbidden" }, 403, cors);

  const rows = await env.DB.prepare("SELECT id FROM facts").all();
  const ids = (rows.results || []).map((r) => r.id);
  if (ids.length > 0) await env.VECTORIZE.deleteByIds(ids);
  await env.DB.prepare("DELETE FROM facts").run();

  return json({ cleared: ids.length }, 200, cors);
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders();
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (request.method === "GET" && url.pathname === "/stats") return handleStats(env, cors);

    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);

    if (url.pathname === "/remember") return handleRemember(request, env, ctx, cors);
    if (url.pathname === "/recall") return handleRecall(request, env, ctx, cors);
    if (url.pathname === "/admin/clear") return handleClear(request, env, cors);

    return json({ error: "not_found" }, 404, cors);
  },
};
