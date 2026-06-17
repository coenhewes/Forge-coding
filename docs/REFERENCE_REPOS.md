# Reference Repositories

Forge uses two upstream repositories as references while the harness is
being designed and built. They live **outside** this workspace and are
read-only context — Forge does **not** import them as code dependencies.

| Reference repo | Path | License | Allowed to copy into Forge? |
| -------------- | ---- | ------- | --------------------------- |
| `opencode`     | `_refs/opencode/`   (one level above this repo) | MIT (Copyright (c) 2025 opencode)        | Yes — with attribution |
| `claude-code`  | `_refs/claude-code/` (one level above this repo) | UNLICENSED — leaked Anthropic source, research-only | No — do not copy, do not vendor |

The `_refs/` directory is intentionally **not** part of this workspace
(`.gitignore` excludes it). Treat the clones as throwaway read-only
context that can be deleted and re-cloned at any time.

## Licensing rules

### `opencode` — MIT

Files in Forge that are derived from opencode (substantial portions
copied, restructured, or adapted) **must** carry MIT attribution. The
minimum attribution block at the top of each derived file:

```
// Derived from opencode (https://github.com/anomalyco/opencode)
// Original Copyright (c) 2025 opencode — MIT License
// See _refs/opencode/LICENSE for the full license text.
```

This applies to:

* Source files copied verbatim.
* Source files that started as a copy and were then edited.
* Substantial code blocks (more than ~50 lines) translated from
  opencode, even if heavily rewritten.

Pure ideas, interfaces, or short snippets (≤ ~20 lines) do not require
attribution, but the bar is conservative — when in doubt, attribute.

### `claude-code` — UNLICENSED

The `_refs/claude-code/` clone is a leaked copy of Anthropic, PBC's
proprietary source code. It is published for educational/research
context only. **Do not** copy code, configuration, prompts, or any
other material from this clone into Forge. Reading it for context is
fine; redistributing or vendoring it is not.

If a downstream task wants to imitate a Claude Code behavior, do it
from the public Anthropic documentation and product surface, not from
this clone.

## Provenance

When Forge ships code that originated in opencode, record:

* Source path in `opencode` (relative to `_refs/opencode/`).
* Upstream commit hash at time of import.
* A short description of what changed during the port.

This provenance should live in the decision ledger for the relevant
task (per the harness's decision-ledger requirement) and in the PR
description. Subsequent imports of the same file must refresh the
upstream commit hash.

## Pinned snapshots

| Repo | Upstream commit (pinned) | Note |
| ---- | ------------------------ | ---- |
| `opencode`     | `85a79292e699da616321d60dc3f62b9199c2beca` (branch `dev`, 2026-06-17) | Update when starting a new track that pulls more code |
| `claude-code`  | `6a2590911df240ff5ea56aa355696cfb94d128cb` (branch `main`, 2026-04-22) | Reference only — never copy |

To refresh a pinned snapshot:

```bash
git -C _refs/opencode fetch origin
git -C _refs/opencode checkout <new-sha>
```

## Verification

Before merging any task that introduces opencode-derived files, the
task's PR description must include:

1. The list of new files containing opencode-derived code.
2. The MIT attribution block (or note that the file is pure idea / ≤ 20 lines).
3. The upstream commit hash at the time of import.