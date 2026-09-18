# 🧠 agent-memory

A small, self-hosted long-term memory layer for AI agents — mem0 / Supermemory style — built entirely on Cloudflare's free tier plus Claude Haiku 4.5.

**[Live Demo →](https://evgeniimatveev.github.io/agent-memory/)**

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)
![Vectorize](https://img.shields.io/badge/Vectorize-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)
![Workers AI](https://img.shields.io/badge/Workers_AI-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)
![D1](https://img.shields.io/badge/D1_Database-4B5563?style=for-the-badge&logo=cloudflare&logoColor=white)
![Claude API](https://img.shields.io/badge/Claude_API-D97757?style=for-the-badge&logo=anthropic&logoColor=white)
![GitHub Pages](https://img.shields.io/badge/GitHub_Pages-222222?style=for-the-badge&logo=github&logoColor=white)

**API base:** `https://evgeniimatveev-agent-memory.evgeniimatveevusa.workers.dev` · [live stats →](https://evgeniimatveev-agent-memory.evgeniimatveevusa.workers.dev/stats)

## What it does

Most RAG demos embed-and-search a fixed corpus. This is different: it's a *write path* for memory. You feed it raw text (a conversation turn, a note, anything), and it:

1. **Extracts** discrete, atomic, memorable facts from the text (Claude Haiku 4.5) — not the whole blob, just what's actually worth remembering, typed as `preference | fact | event | correction` with an importance score (1–5).
2. **Embeds** each fact (`@cf/baai/bge-m3`, 1024-dim) and stores it in **Vectorize** for semantic search, plus a structured row in **D1** (type, importance, timestamps).
3. On recall, **re-ranks** candidates by `similarity × importance × recency-decay` — not raw cosine similarity alone. A highly-relevant but week-old trivial fact loses to a slightly-less-relevant but important, fresh one.

## Architecture

```mermaid
flowchart LR
    U1(["you: /remember"]) -->|"raw text"| W["Cloudflare Worker<br/>agent-memory"]
    W -->|"extract atomic facts"| C["Claude Haiku 4.5"]
    C -->|"facts: type + importance"| W
    W -->|"embed each fact"| AI["Workers AI<br/>bge-m3"]
    AI --> V[("Vectorize<br/>fact embeddings")]
    W --> D[("D1<br/>type / importance / timestamps")]

    U2(["you: /recall"]) -->|"query"| W
    W -.->|"embed query"| AI
    V -.->|"top-K candidates"| W
    D -.->|"join: importance + created_at"| W
    W -->|"re-rank: similarity × importance × recency"| R(["ranked facts"])
```

`/remember` is the write path (top), `/recall` is the read path (bottom) — both share the same Worker, embedding model, Vectorize index and D1 table; nothing is duplicated per-endpoint.

| Component | Role |
|---|---|
| Cloudflare Vectorize | semantic search over fact embeddings (1024-dim, cosine) |
| Cloudflare D1 | structured fact metadata — type, importance, timestamps |
| Workers AI (`bge-m3`) | embeddings |
| Claude Haiku 4.5 | fact extraction from raw text |
| Cloudflare Workers | the API itself (`/remember`, `/recall`, `/stats`) |

Same Cloudflare stack as [civics-sql-rag](https://github.com/evgeniimatveev/civics-sql-rag) (this developer's earlier RAG project) — reused deliberately rather than re-deriving the pattern.

## Known limitations

Found by hands-on testing against the live demo, not just theorized:

- **Vectorize indexing lag.** A freshly-`remember`ed fact isn't always immediately queryable — Cloudflare indexes new vectors asynchronously, and this can take anywhere from a few seconds to roughly a minute. `/recall` right after `/remember` may briefly return `considered: 0` for facts that were just stored. This is Vectorize's own eventual-consistency behavior (confirmed via `wrangler vectorize info`, watching `vectorCount` lag behind actual upserts), not a bug in this app — retrying the same query a little later resolves it every time.

- **Importance can outrank true relevance.** Taught three facts, then asked "what BI tool does this person like more?" The one fact that actually answered the question had the *highest* raw similarity (0.655) but only importance 3/5 (weight 0.84), while two unrelated facts had importance 5/5 (weight 1.0). Final scores: unrelated fact 0.592, actually-relevant fact 0.55 — the importance multiplier flipped the ranking. The weighting formula currently applies importance as a flat multiplier regardless of how relevant a candidate already is, instead of only using it as a tie-breaker between similarly-relevant candidates.

- **No automatic conflict resolution (confirmed live, and it compounds with the issue above).** Taught "I live in Burbank" (extracted importance 5), then separately "Correction: I moved to Los Angeles, not Burbank" (extracted importance 4 — LLM judged the correction itself as slightly less critical than the original fact). Recall for "where does this person currently live?" returned the outdated Burbank fact *above* the correction (score 0.536 vs 0.494) — the system doesn't just fail to suppress the old fact, it can actively rank the wrong answer first. The `correction` type is extracted correctly but is currently just a label, not a mechanism (see design decision below).

- **No relevance floor on recall.** `/recall` has no minimum-similarity cutoff, unlike this developer's earlier RAG project (`civics-sql-rag`'s `MIN_SCORE = 0.3`). A query about a completely untaught topic ("what programming language does this person prefer?") still returned 5 stored facts (similarity 0.48–0.60, none actually about programming languages) instead of an empty/no-match response. Worth adding a similarity floor in v2 rather than always returning "least-bad" matches.

## Design decisions worth calling out

- **Conflict resolution is intentionally v1-scoped out.** The schema has a `superseded_by` column and the `correction` fact type is already extracted and flagged — but automatically deciding "does this new fact contradict/replace an old one" needs its own LLM-judge pass, which is a distinct v2 feature, not bolted onto the write path for a first release. (Confirmed live — see Known limitations above for what this looks like in practice today.)
- **Recency decay has a floor (0.4), not a hard cutoff.** An important fact from 60 days ago should still surface for a clearly-relevant query — just below an equally-relevant fresh one. A pure exponential decay with no floor would eventually make anything old invisible regardless of importance, which isn't how memory should work.
- **Rate-limited (30/day per IP, 300/day global)** since `/remember` is a public write endpoint that triggers a real LLM call — same defensive pattern as this developer's other public Cloudflare-backed demos.

## Try it

```bash
curl -X POST https://evgeniimatveev-agent-memory.evgeniimatveevusa.workers.dev/remember \
  -H "Content-Type: application/json" \
  -d '{"text": "I prefer DuckDB over plain PostgreSQL for local analytics work because it is faster for OLAP queries."}'

curl -X POST https://evgeniimatveev-agent-memory.evgeniimatveevusa.workers.dev/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "what database do they prefer?"}'
```

## Stack

Cloudflare Workers · Vectorize · Workers AI · D1 · Claude Haiku 4.5 (Anthropic API)
