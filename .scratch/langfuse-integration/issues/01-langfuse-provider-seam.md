# 01 — Langfuse provider seam

**What to build:** One config-selected Langfuse provider that owns prompt fetch and score writes, with a contract fake for tests, the same way OCR, extraction, rerank and analytics are selected today. Nothing the user sees changes yet. This is the prefactor every other ticket builds on.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] New variable `LANGFUSE_PROVIDER` with values `langfuse`, `contract-fake`, `none`; default `none` in development, `langfuse` in the deployed config, `contract-fake` in the test pool bindings
- [x] `contract-fake` is refused when `APP_ENV` is `production`, like the other fakes
- [x] The `langfuse` provider requires the three existing Langfuse secrets and builds one Langfuse client per isolate
- [x] `none` disables prompt fetch and scores while tracing stays as configured
- [x] The Worker folder for tracing is renamed to `langfuse` and the tracing target moves under it; all imports and tests updated
- [x] The provider exposes `prompts.get(name)` and `scores.write(...)`; the contract fake serves bundled fallback prompts and records scores that tests can read back, mirroring the analytics fake
- [x] Config tests cover selection, production refusal and `none`
- [x] `pnpm check` passes except the pre-existing `data:check` failure on main


## Comments

- Implemented `selectLangfuseProvider(config)` with `prompts.get(name)` and `scores.write(score)`.
- The config schema rejects missing live credentials and the fake in production. Tracing resolves independently.
- The SDK client is cached by the parsed isolate configuration. The fake returns independent bundled copies and records idempotent score writes.
- Existing prompt instructions, schema consumers, model calls, model variables, and thresholds remain in place. Bundled copies reference existing instruction and schema exports. Later tickets migrate the callers.
- Renamed `worker/tracing` to `worker/langfuse`, with tracing in `tracing.ts` and target configuration in `target.ts`.
- Verified current stable `@langfuse/client` version **5.11.1** with npm on 2026-09-13. It matches the installed Langfuse tracing packages.
- Documentation consulted: [prompt management](https://langfuse.com/docs/prompt-management/get-started), [scores](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk), and the installed SDK declarations/source.
- Implementation choice: scores use the SDK's direct `api.scores.create` endpoint. The queue's `flush()` swallows ingestion errors. The direct request has zero retries and a five-second timeout, and exposes only a sanitized error.
- Validation: `npx -y pnpm@11.21.0 check` passes formatting, lint, and wizard checks. It stops at the existing scenario asset reproducibility failure (`test/scenario-assets.node.mjs:63`). Data checks: 13 passed, 1 baseline failure.
- Independently ran `npx -y pnpm@11.21.0 build`: passed, including generated binding verification, TypeScript, client build, and Worker deployment dry run.
- Independently ran `npx -y pnpm@11.21.0 test`: **330 tests passed across 19 files**. All tests use blank Langfuse pool bindings. The live-selection test only constructs the SDK with synthetic `.test` credentials and sends no requests.
- `git diff --check` passes. No Cloud resources changed or Cloud verification performed; ticket 01 introduces an unused seam and has no live criterion.

- Review correction: the legacy live-evaluation pool also selects the Langfuse contract fake and blanks all three Langfuse keys. It may use live OCR and model providers, but cannot fetch prompts, write scores, or export traces to Langfuse.
