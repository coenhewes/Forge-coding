# Forge Local-Model Layer

A best-effort, **non-authoritative** delegation layer that runs bounded,
structured sub-tasks on cheap local models so the frontier model is not re-sent
large raw payloads on every turn.

> TL;DR: the same frontier model performs better in a leaner context. The local
> layer trims that context (and triages/extracts/ranks) without ever becoming
> the source of truth.

## Why this layer exists

Every turn of the agent loop re-sends the message history — including large tool
outputs — to the frontier model. That is the dominant driver of cost, latency,
and context pressure on long tasks. Forge already had a local provider (Ollama,
cost tier 0) and a capability router (`selectProvider`); what was missing was an
**architectural layer** that delegates the right sub-tasks to it.

## What it does (and does not)

| Goes local (`@forge/local-model`) | Stays frontier |
|---|---|
| `summarize` — compact large tool outputs / history | Plan, interpret, decide next action |
| `classify` — triage failures (flaky vs real, error category) | Make & verify claims; set belief confidence |
| `extract` — structured fields from logs/test output | Author code edits |
| `rerank` — relevance ranking of retrieval candidates | Decide completion / resolve contradictions |
| `embed` — embeddings for semantic retrieval | Review / approve |

### Hard boundaries (enforced in types & flow)
- **Never the source of truth.** Every result is `authoritative: false`.
- **Never gates completion.** Verification gating only counts deterministic
  verified claims; signals tagged `source = local_model` cannot flip a claim to
  `verified`.
- **Exact evidence stays recoverable.** Each call stores the byte-exact input as
  an artifact (`local_model_input`) and the output as `local_model_output`, and
  records a `local_model_runs` row linking the two **stable references**. A
  compacted summary is always traceable back to its original via the
  context-server `evidence.get_exact_artifact` capability.
- **Bounded & resumable.** Inputs are truncated to a char budget; calls are
  timeout-capped; on any failure the service returns a **deterministic fallback**
  (head/tail truncation, `unknown` label, identity rank, regex extraction) and
  never throws into the agent loop.
- **No raw internals exposed.** The layer is called by the harness, not the
  model; anything it injects into model context flows through the normal
  context-server slicing contract.

## Architecture

```
agent-loop ──► CompactionPolicy ──► LocalModelService ──► LocalModelRouter ──► provider
                                          │                     │
                          EvidenceMemory (stable refs)   selectProvider (tier ≤ 1, local-first)
                          TraceRecorder (local_model_invoked)
                          local_model_runs (provenance)
```

- **`LocalModelRouter`** — decides availability (`auto` probes Ollama once and
  caches; `on`/`off` are explicit) and maps each task kind to a provider config
  (instruct model for summarize/classify/extract/rerank, embedding model for
  embed). Reuses `selectProvider` so selection is consistent with the rest of
  Forge. All network/factory deps are injectable for hermetic tests.
- **`LocalModelService`** — the harness entry point. Persists input/output
  artifacts, records provenance + trace, and always falls back deterministically.
- **`CompactionPolicy`** — threshold-triggered rewrite of oversized `tool`
  messages into `summary + ref`. Adapted from opencode's
  `session/{overflow,compaction,summary}.ts` (MIT, see [NOTICE](../NOTICE)).
- **`similarity.ts`** — in-process cosine ranking for embeddings (no pgvector
  dependency).

## Configuration

`.forge/config.json` (`localModel` block) — defaults are opt-in/auto:

```json
{
  "localModel": {
    "enabled": "auto",
    "maxInputChars": 24000,
    "timeoutMs": 20000,
    "summaryTargetTokens": 200,
    "compactionThresholdChars": 4000
  }
}
```

- `enabled`: `auto` (use only if Ollama reachable) | `on` | `off`.
- `instruct` / `embed`: optional `ProviderConfig` overrides. Defaults to local
  Ollama (`qwen2.5-coder` and `nomic-embed-text`).

Environment (see `.env.example`): `OLLAMA_BASE_URL`, `OLLAMA_EMBED_MODEL`.

## CLI

```
forge local status   # enablement, configured models, reachability
forge local test     # round-trip a tiny summarize + embed (shows fallback if down)
```

## Persistence (migration v4)

- `local_model_runs` — provenance: task, kind, model/provider, input/output
  artifact ids, latency, tokens, confidence, `fallback_used`.
- `embeddings` — `(repo_id, target_type, target_ref, model)` unique; vector as
  `jsonb` float[]; `content_hash` to skip re-embedding unchanged targets.

## Expected cost / latency impact

- **Frontier tokens:** a ~4k-token command output re-sent across ~15 turns
  ≈ 60k input tokens; replaced by a ~150-token summary ≈ ~2.3k → **~95%
  reduction per large artifact**, at tier-0 (free) local cost.
- **Latency:** one local summarize (~1–3s on local hardware) per large output,
  removed from every later frontier turn. Net positive on long horizons.
- **Caveats:** short tasks, CPU-only/slow local, or no Ollama → fallback path
  with bounded (timeout-capped) overhead. This is exactly why the default is
  opt-in/`auto`.
- **Measurement:** `local_model_runs` records latency + token deltas; compare
  `forge-eval` runs with the layer on/off.

## Later extensions

- pgvector-backed embeddings + ANN index (today: jsonb + in-process cosine).
- Rerank wired as a weighted component into `EvidenceValueScorer` / `ProbePlanner`.
- Speculative drafting (local drafts, frontier verifies).
- Fine-tuned specialist local models per task kind.
- Content-hash caching of local outputs.
