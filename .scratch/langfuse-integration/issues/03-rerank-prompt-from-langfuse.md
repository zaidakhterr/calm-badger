# 03 — Rerank prompt from Langfuse

**What to build:** The Match products step fetches its rerank prompt from Langfuse, and the match thresholds travel with the prompt version, so a prompt and its acceptance rule are one unit.

**Blocked by:** 02 — Extraction prompt from Langfuse.

**Status:** done

- [x] Sync script upserts chat prompt `rfq/rerank` with the current instruction, `{{request}}` as message two, and config `model`, `temperature`, `max_tokens`, `response_format`, `winner_strength`, `winner_gap`
- [x] The step reads winner strength and gap from the prompt config; `OPENROUTER_RERANK_MODEL`, `MATCH_WINNER_STRENGTH`, `MATCH_WINNER_GAP` are removed from config and deployed variables; the fallback constant carries the same values
- [x] Rerank contract keeps `ranked[].sku` and `ranked[].score` required; subset check and `prompt_incompatible` fallback apply
- [x] Each rerank generation links its prompt version
- [x] Step evidence still records the thresholds in use
- [x] Tests: threshold path reads config, nonsense config falls back, prompt version on the generation
- [x] Verified against Langfuse Cloud on one curated run


## Comments

Implemented on `integration/03` after ticket 02 (`862ab76`).

- `scripts/langfuse-sync.mjs` now seeds both managed chat prompts without overwriting an existing latest version or changing its labels. Two consecutive Cloud syncs created `rfq/rerank` version 1 once, then preserved both prompt versions.
- Match products fetches `rfq/rerank` once per step and takes its model, temperature, token cap, output schema, winner strength, and winner gap from that version. The bundled fallback retains `openai/gpt-5.6-luna`, `0.55`, and `0.12` after the three Worker variables were removed.
- The compatibility guard checks required paths recursively through objects and array items and rejects unsupported schema keywords or defaults. Output passes the prompt's unchanged full JSON Schema before the small application contract. The contract also requires `ranked[].reason` because the application reads it.
- AI SDK 7 links each managed generation through `runtimeContext.langfusePrompt` with runtime context included in telemetry. Fallbacks carry plain name, version, and fallback metadata without claiming a managed prompt version.
- This ticket did not deploy the Worker. It did not add datasets, experiments, scores, or cost behavior.

Validation:

- `npx -y pnpm@11.21.0 check`: format, lint, and wizard checks passed; stopped only at the known generated `routine-replenishment` PNG mismatch in `data:check`.
- Independent `npx -y pnpm@11.21.0 build`: passed, including generated-binding check, TypeScript, client build, and Worker dry run.
- Full offline suite: 352 passed, 0 failed across 94 suites. `/tmp/ticket03-vitest-results.json` reports success true. Tests keep Langfuse keys blank and cover nested ranking fields, unchanged schema forwarding, prompt-config thresholds, nonsense and incompatible fallbacks, evidence thresholds, and prompt-version generation attributes.
- `git diff --check`: passed.
- Cloud production lookup returned `rfq/rerank` version 1 with model `openai/gpt-5.6-luna`, thresholds `0.55` and `0.12`, and required ranking item fields `sku`, `score`, and `reason`.

Live evidence, 2026-09-13:

- The orchestrator ran the exact named `calm-badger` preview against this worktree using the messy forwarded request. The run completed matching with six lines, three model calls, four accepted matches, and two review-required matches.
- Run: `e8eae359-8edd-42f7-a5d3-6e10b6d133a9`; view: `WP2P2n42hvavb3zcyWLt7g`.
- Trace: `b13947ca47303f1472c16087bfb87eee`; rerank generations: `4e9bffd3550f816a`, `54b7ca3692811a51`, and `0cb73ce15118b166` (`chat openai/gpt-5.6-luna`).
- The Cloud observations API returned `promptName=rfq/rerank`, `promptVersion=1`, `promptId=89d18018-ff45-4372-8fd7-2659ecf5c51c` on all three rerank generations.
- Stored Match products evidence records `winnerStrength=0.55` and `winnerGap=0.12`, the actual thresholds from that managed prompt version.
- [Linked rerank generation](https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/traces/b13947ca47303f1472c16087bfb87eee?observation=4e9bffd3550f816a).
- Current docs checked: [prompt management](https://langfuse.com/docs/prompt-management/get-started), [prompt configuration](https://langfuse.com/docs/prompt-management/features/config), [prompt linkage](https://langfuse.com/docs/prompt-management/features/link-to-traces), plus installed Langfuse SDK 5.11.1 and AI SDK 7 integration source.
