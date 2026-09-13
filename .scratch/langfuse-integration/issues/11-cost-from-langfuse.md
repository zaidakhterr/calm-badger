# 11 — Cost from Langfuse

**What to build:** Langfuse is the only place that computes cost. The app stops estimating it and shows only what the provider reports. OCR cost appears in Langfuse from a `pages` unit price.

**Blocked by:** 02 — Extraction prompt from Langfuse (reuses the sync script).

**Status:** done

- [x] Sync script registers `mistral-ocr-latest` in the Langfuse model table with a `pages` usage unit and price
- [x] OCR generation reports `pages` usage without its own cost details
- [x] Deleted: OpenRouter cost estimator, OCR cost estimator, `OCR_COST_PER_1000_PAGES_USD`, `OPENROUTER_COST_PER_1M_INPUT_TOKENS_USD`, `OPENROUTER_COST_PER_1M_OUTPUT_TOKENS_USD` from config and deployed variables
- [x] Run view and step evidence show the provider-reported figure only, absent when the provider reports none
- [x] The OpenRouter-reported cost from usage accounting is passed to each extraction and rerank generation as its cost details, so Langfuse shows the exact figure rather than an inferred one (see langfuse.com/integrations/gateways/openrouter); inference remains the fallback when the provider reports none
- [x] Tests updated: no estimate in evidence, provider-reported figure still surfaces
- [x] README pricing note under Analytics removed
- [x] Verified on Langfuse Cloud: OCR generation shows a cost inferred from pages

## Comments

- Current pricing source: Mistral OCR 4.1 is $4 per 1,000 pages, so the synchronized price is $0.004 per `pages` usage unit: https://docs.mistral.ai/models/ocr-4-1
- Langfuse cost behavior source: ingested provider cost takes priority; otherwise exact usage-detail keys are multiplied by the matching model-table price: https://langfuse.com/docs/observability/features/token-and-cost-tracking
- OpenRouter source: `usage.cost` is the total amount charged to the account: https://openrouter.ai/docs/cookbook/administration/usage-accounting
- Cloud model `cmu0a8wwu01diad0i5a4vuasa`, Standard tier `cmu0a8www01dkad0i6vuu2cxe`: exact `mistral-ocr-latest` regex and `pages=0.004`. The current Models API unit enum has no `PAGES` member, so the model uses `REQUESTS`; the arbitrary price and generation usage key is `pages`.
- Live synthetic run `dDrSghE2Vf5QHLZ__noqSQ`: trace https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/traces/9deaf565c672a3014c978fa1cb175248. OCR generations `fb2113ecb6b1a88d` and `0640755af9fc4cb5` each have `usageDetails.pages=1`, the synchronized model/tier, and inferred `costDetails.pages=0.004` / `totalCost=0.004`. Extraction generation `17bbbc0669f2d680` has exact provider-ingested `costDetails.total=0.001244`; public step evidence returned `reportedCostUsd=0.001244` and legacy `estimatedCostUsd=null`.
- Offline current-SDK proof uses injected provider fetches and an in-memory OpenTelemetry exporter. It verifies exact extraction cost precision, omitted cost staying absent, valid rerank cost `0`, and OCR `pages` usage with no application cost attribute.
- The user explicitly approved removal of the three obsolete price variables and estimator-era tests after reviewing the provider-only display and Langfuse inference fallback. The settings are absent from Worker config, deployed variables, generated bindings, and tests.
- Verification: `npx -y pnpm@11.21.0 check` passed formatting, lint, wizard checks, and 13/14 data tests, then stopped only at the accepted pre-existing `routine-replenishment image is stale` PNG reproducibility failure. Independent `npx -y pnpm@11.21.0 build` passed Wrangler type freshness, TypeScript, client build, and Worker dry run. Independent `npx -y pnpm@11.21.0 test` passed 19 files and 351 tests. The focused current-SDK extraction, rerank, and OCR telemetry suite passed 13 tests.
- README deviation: this base had no estimator pricing note inside the Analytics section. The remaining Analytics reference to product `prices` describes fields withheld from PostHog and remains privacy documentation. Estimate wording was removed from technical details; the Langfuse section now documents page-price inference.
