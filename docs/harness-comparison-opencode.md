# Forge vs opencode — Harness Design Comparison & Diagnosis

**Date:** 2026-06-21
**Question:** opencode (same model, MiniMax-M3) cleanly fixes 4/4 independent bugs where Forge gets
the same model stuck at 1/4. Is the thesis wrong, or are we stacking the right blocks wrong?

**Verdict:** The thesis is **not** wrong — but it is **mis-applied**. Forge applies its
"durable-state / bounded-context" medicine on *every turn*, including when the task comfortably fits
the model's context window. That **replaces the model's own reasoning transcript with a regenerated
state summary each turn**, which destroys the model's ability to execute a multi-step plan. opencode
keeps the model's full transcript until it actually overflows, and only then compacts. We have the
right building blocks; we're putting the heavy machinery in the hot path instead of at the boundary.

---

## 1. How opencode actually works (the parts that matter)

Source: `_refs/opencode/packages/opencode/src/session/`.

**Context strategy — keep everything until you can't (`overflow.ts`, 34 lines):**
- Every turn, the model receives the **entire append-only transcript** since the last compaction:
  `MessageV2.toModelMessagesEffect(msgs, model)` (prompt.ts).
- It compacts **only** when `tokens.total >= context_limit − ~20K buffer` (`isOverflow`). On a task
  that fits the window, opencode **never** compacts and **never** drops context.
- Compaction = summarize the head, mark a `tail_start_id`, keep the recent tail verbatim. One event,
  at the boundary, not a per-turn tax.

**Loop — trust the model, light guardrails (`processor.ts`, `prompt.ts`):**
- Standard ReAct: stream assistant text + tool calls → execute tools → append results to the
  transcript → loop. No stage machine, no per-turn "situation report."
- **One** anti-spin guard: `DOOM_LOOP_THRESHOLD = 3` — if the last 3 tool parts are the *same tool
  with the same input*, ask permission (effectively stop). That's the entire spin defense.
- Overflow flips `needsCompaction`; otherwise it just continues.

**The model owns its plan — the `todowrite` tool + persistence prompt:**
- opencode gives the model a **todo-list tool** (`tool/todo.ts`) and the prompt tells it to break the
  task into a markdown todo list, check items off as it goes, **display progress**, and — critically —
  *"Make sure that you ACTUALLY continue on to the next step after checking off a step instead of
  ending your turn"* and *"keep working until … all items in the todo list are checked off. Do not end
  your turn until you have completed all steps."* (beast/anthropic prompts; default prompt is the
  classic concise Claude-Code agent prompt.)
- This is the mechanism that makes multi-bug tasks converge: the model writes "fix A, fix B, fix C,
  fix D," and the prompt forbids it from stopping until all are checked.

**Tools:** read, write, edit, apply_patch, glob, grep, bash(shell), task(subagent), **todowrite**.
Clean, small, model-driven. Reads return full content.

---

## 2. How Forge works (the contrast)

Source: `packages/forge-agent/src/agent-loop.ts`.

- **Per-turn context = regenerated state, not the transcript.** Each turn we build a fresh
  `situation report` (goal, acceptance criteria, verification matrix, evidence, failures, files,
  nudges) + a **bounded/compacted window**, and that is what the model sees — not its own
  append-only reasoning chain. The model's plan-in-progress is effectively erased and re-summarized
  every turn.
- **A stage machine** (LOCALIZE→PROBE→EDIT→VERIFY→REPAIR→FINALIZE) drives control flow and can
  *force* behavior (withhold tools, block commands, pause).
- **Heavy guardrails:** EDIT spin counters, read-withholding, shell/test blocks, escalating nudges,
  finish_task gating, acceptance-criterion bookkeeping. (We spent an entire session debugging these.)
- **Proactive compaction every turn** (sliding window + per-result truncation) regardless of whether
  we're anywhere near the context limit.
- **Externally-imposed goals:** acceptance criteria + verification matrix, instead of a model-owned
  todo list. The model must satisfy *our* contract rather than execute *its* plan.

---

## 3. Why Forge fails (mapped to the evidence)

Gauntlet evidence (golden gate, fresh DB, mandatory local model):
- **GG01** (1-bug zod): Forge competitive (~47K vs opencode 45K, more minimal). Single-step → the
  regeneration tax is survivable.
- **GL02** (4 *easy* independent bugs): **opencode PASS 4/4, 124K; Forge FAIL 1/4, 196K** (86 calls,
  88 read/search ops, 4 edits to ONE file). Multi-step → Forge collapses.
- **GL01** (4 harder bugs): opencode PASS 168K; Forge fixed 7/9 tests then ground past 200K.

The failure mode is always the same on multi-step work: **Forge fixes one bug, then "loses the
thread" and re-reads/searches endlessly without converting to edits for the rest.** Direct causes:

1. **No persistent plan in context.** The model's "I'll fix A, then B, then C" lives in its
   transcript. Forge throws the transcript away each turn and hands back a regenerated situation
   report, so the model literally cannot see its own plan or what it already decided to do next. It
   re-derives "where am I?" every turn and stalls.
2. **No model-owned todo list + no persistence mandate.** opencode's single biggest multi-step lever
   is absent. Forge instead offers *off-ramps* (finish_task, "all acceptance criteria verified") that
   let the model stop after partial progress (it literally did: fixed 1 bug, ran a subset, quit).
3. **Proactive context-bounding causes loss that isn't needed.** GL02 fits the window with room to
   spare, yet Forge compacts/bounds every turn. opencode keeps full fidelity and never pays this cost.
4. **Guardrails fight the model instead of helping it.** We burned ~18 runs on spin/nudge/withhold
   logic; opencode achieves better convergence with *one* doom-loop check. Our forcing functions
   interrupt the model's flow; they treat "thinking/localizing" as misbehavior.

---

## 4. Is the thesis wrong?

**No — but its scope was wrong.** "Durable state + bounded context + local-model offload degrade
*less* as tasks get harder/longer" is a claim about the **overflow / long-horizon / crash** regime.
It is true *there*. The mistake is running that machinery in the **common case** (tasks that fit the
window), where it is pure overhead and actively harms the model's multi-step execution.

The correct mental model (which opencode embodies):
- **Hot path = the model's append-only transcript.** Cheap now that we have prompt caching.
- **Durable state / embeddings / belief are BOUNDARY tools**, not hot-path replacements. They earn
  their keep exactly when the transcript can't fit anymore (smart compaction with exact recovery by
  ref), when the process crashes (resume), and on large repos (semantic retrieval). That is precisely
  the "degrade less when it gets hard" regime the thesis promises.

So: right blocks, wrong stacking. We put the compaction/state layer *in front of* the model every
turn instead of *behind* it at the boundary.

---

## 5. What we're missing in harness design — the fixes

Prioritised, highest-leverage first:

**A. Make the model's append-only transcript the primary context.** Stop regenerating a situation
report as the per-turn context. Send the real conversation (system + task + full transcript), exactly
like opencode. Prompt caching (already shipped) makes this cheap. Keep durable state as a *sidecar*
the model can query, not the thing it's handed every turn.

**B. Add a model-owned todo tool + a persistence prompt.** Give the model `todowrite`/`todoread`
(or equivalent), and instruct: break the task into a checklist, work through it, check items off,
**do not end your turn until every item is done and the full suite passes.** This is the missing
multi-step convergence engine. It also subsumes our anti-fixation nudges for free.

**C. Compact only at overflow (opencode's `isOverflow`).** Replace per-turn bounding with: keep the
full transcript until `tokens ≈ context_limit − buffer`, then run ONE compaction. **This is where
Forge's differentiators belong** — use the local model + embeddings + belief to produce a *better*
summary than opencode's, with exact artifacts recoverable by ref. Same trigger as opencode, superior
compaction = the real, defensible edge.

**D. Replace forcing/nudges with one doom-loop guard.** Drop the EDIT spin counters, read-withholding,
and escalating nudges. Use opencode's rule: same tool + same input N times → intervene. Trust the
model + prompt for everything else.

**E. Remove off-ramps; the gate is the full suite.** finish_task should require the actual verify gate
green, not "acceptance criteria marked." (We already saw the subset-pass off-ramp cause a premature
finish.) Acceptance criteria can remain as *evidence*, not as a completion shortcut.

**Keep (genuine wins from this session, all compatible with A–E):** prompt caching; the read-budget
fix (full reads); `search_semantic` retrieval; durable Postgres state for crash-resume + compaction
recovery; deterministic test-failure parsing.

---

## 6. Recommended next step

Build a **"clean-core" Forge**: an opencode-style ReAct loop (full transcript, todo tool, persistence
prompt, doom-loop guard, compact-only-at-overflow) with Forge's durable state, semantic retrieval, and
superior compaction layered at the boundary. Then re-run the gauntlet. Expectation: it matches
opencode on GG01/GL02 (convergence restored), and *beats* it on genuinely long / compaction-heavy /
large-repo tasks — which is where the thesis was always meant to win.
