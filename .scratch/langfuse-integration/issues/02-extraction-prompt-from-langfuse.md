# 02 — Extraction prompt from Langfuse

**What to build:** The Structure RFQ step fetches its prompt from Langfuse instead of code. A prompt author can edit the system text, user template, model, temperature, token cap and output schema in the Langfuse UI and see the new version used on the next run, with the version visible on the generation. A version that drops a field the app reads is refused and the bundled fallback is used.

**Blocked by:** 01 — Langfuse provider seam.

**Status:** done

- [x] A new sync script upserts chat prompt `rfq/extract` with the current system instruction as message one, `{{documents}}` as message two, and config `model`, `temperature`, `max_tokens`, `response_format` holding the JSON schema generated from the current zod schema; labelled `production`
- [x] The Worker fetches label `production` in production and `latest` with zero cache TTL in development; tests never fetch
- [x] A bundled fallback constant holds text, model, temperature, token cap and schema; `OPENROUTER_EXTRACTION_MODEL` is removed from config and deployed variables
- [x] A hand-written zod contract names only the fields the app reads; at fetch the provider refuses a prompt whose schema `required` set misses a contract required key, logs `prompt_incompatible` with name and version, and returns the fallback
- [x] Model output is validated with a zod schema built from the config JSON schema, then parsed with the contract; the existing repair and business gates still run
- [x] The generation links the prompt name and version through the AI SDK telemetry metadata
- [x] Contract fake serves the fallback and honours a trigger source label that serves a schema missing a contract field
- [x] Tests: curated run evidence unchanged, prompt name and version present on the generation in the in-memory exporter, incompatible trigger completes the run on the fallback with the log line
- [x] Verified against Langfuse Cloud: one curated run shows the linked prompt version on the extraction generation


## Comments

Implemented on `integration/02` after ticket 01 (`e46cdf7`).

- `scripts/langfuse-sync.mjs` seeds the extraction chat prompt with the unchanged instruction, documents variable, full schema, settings, and production label. Repeated sync preserves existing Langfuse versions and labels. The UI remains authoritative after first upload.
- Structure RFQ fetches through the config-selected provider. Production uses the SDK cache and production label. Development uses latest with zero TTL. The fake and disabled providers stay offline.
- The compatibility guard checks required paths through objects and array items. Unsupported schema keywords and defaults cause fallback. This is deliberate: Zod 4.4.3 ignores some constraints and applies defaults that could hide a missing required field. Complex schema definitions that cannot establish these direct paths also fail closed.
- The original JSON Schema reaches OpenRouter without a conversion round trip. Local validation uses the converted schema, then the hand-written RFQ contract. Repair and business gates remain in place.
- AI SDK 7 links `runtimeContext.langfusePrompt` through `telemetry.includeRuntimeContext`. Bundled fallbacks are not misrepresented as managed prompt versions.
- `OPENROUTER_EXTRACTION_MODEL` was removed from Worker config, Wrangler variables, generated bindings, and tests. The System drawer directs readers to the managed extraction prompt. This ticket did not deploy the Worker; its changed deployment configuration is ready for the parent integration deployment.

Validation:

- `npx -y pnpm@11.21.0 check`: format, lint, and wizard checks passed; stopped only at the pre-existing generated scenario PNG mismatch in `data:check`.
- Independent `npx -y pnpm@11.21.0 build`: passed, including types and Worker dry run.
- Full offline suite: 344 passed, 0 failed. `/private/tmp/ticket02-vitest-results.json` reports success true. Tests keep all Langfuse keys blank. Coverage includes public API fallback completion, nested required fields, missing required defaults, schema policy violations, unchanged curated evidence, full schema forwarding, and prompt-version generation attributes.
- `git diff --check`: passed.
- Sync ran twice against Cloud: created `rfq/extract` version 1 with production; second run preserved version 1.

Live evidence, 2026-09-13:

- The orchestrator ran the exact named `calm-badger` preview against this worktree. Routine replenishment validated six lines and delivered.
- Run: `4ca8eb35-fcfc-4959-9998-772a39de4351`; view: `nMG4hHw6aJKP6JqUhrvgKQ`.
- Trace: `8cdde9182865c92c9352176bd6ea85cd`; extraction generation: `a93aa1dded4af049` (`chat openai/gpt-5.6-luna`).
- The Cloud observations API returned `promptName=rfq/extract`, `promptVersion=1`, `promptId=ff9c0e16-253a-42b9-893d-6ce2b93ab578` on that generation.
- [Linked extraction generation](https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/traces/8cdde9182865c92c9352176bd6ea85cd?observation=a93aa1dded4af049).
- Current docs checked: [prompt management](https://langfuse.com/docs/prompt-management/get-started), [prompt linkage](https://langfuse.com/docs/prompt-management/features/link-to-traces), [caching](https://langfuse.com/docs/prompt-management/features/caching), plus installed SDK 5.11.1 runtime-context integration and Zod converter source.
