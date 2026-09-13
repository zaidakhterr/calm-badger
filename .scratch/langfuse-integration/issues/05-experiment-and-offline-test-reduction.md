# 05 — Experiment and offline test reduction

**What to build:** A Langfuse experiment runs the three scenarios through the public API against a local Worker with real providers, scores every dimension the old scorer scored, and fails on the same rule the tests enforce today. Accuracy then has one home, and the committed evaluation record is deleted.

**Blocked by:** 03 — Rerank prompt from Langfuse; 04 — Dataset in Langfuse.

**Status:** done

- [x] New `evals` folder with an experiment script exporting the runner entry the Langfuse GitHub action expects
- [x] Task starts a curated run through the public API of a local `wrangler dev --local`, polls to completion, applies the review path the old live evaluation applied, returns the run projection
- [x] Evaluators ported from the old scorer and the gold checks in the catalog tests: customer, line count, quantity, shortlist hit, top-three hit, selection, divergence with and without asking, review positions, priced, delivered, every expected SKU exists
- [x] Run-level gate raises a regression when `divergedWithoutAsking` is above zero or `selectionCorrect + divergedAfterAsking` is below the line count
- [x] Evaluator unit tests with small inline projections cover each score and the gate
- [x] Offline curated-run test keeps structural assertions only: 18 lines, 3 delivered, no line changed without a review item
- [x] Deleted: gold fixture, reference scorer, evaluation report and summary modules, run-evaluation script, live vitest config, `eval:fixtures` and `eval:live` scripts, the scenario test asserting expected outcomes are never served
- [x] System drawer Evaluation card becomes a link to the Langfuse experiment view
- [x] Verified: one experiment run visible in Langfuse Cloud with per-item scores

## Comments

- Implemented `evals/rfq.ts` against current `langfuse/experiment-action` v1.0.10 and `@langfuse/client` 5.11.1. The action receives `RegressionError({ result })` from the absolute gate.
- Pure tests use small inline projections. The task drives the public API and accepts proposed review choices without using expected answers. Capabilities stay inside the task. Contact comparison uses fingerprints; exported expected-output attributes use the shared contact mask.
- Cloud seed inspected with the CLI: dataset `rfq-scenarios`, ID `cmu09dh30014aad0cq703wi5l`, three active items. The revised sync was executed and preserved both version-1 prompts and the active dataset without upserts.
- Verification: build, TypeScript, lint, formatting, wizard checks, and 68 targeted tests passed. Full serial suite passed 355 tests across 20 files. Normal full suite had only the independently confirmed ticket-08 cross-run score-recorder race; the coordinator owns that fix. `pnpm check` stops only at the known PNG determinism failure in `test/scenario-assets.node.mjs`.
- Deviation: a fresh Langfuse project needs `LANGFUSE_DATASET_BOOTSTRAP` pointing to an uncommitted Cloud export. Keeping a one-command code seed after deleting the only gold fixture would recreate a second source of truth. Existing Cloud answers are preserved. The limitation and exact export envelope are documented in `evals/README.md`.
- Deviation: the old delivery hint was not uploaded to the dataset. The evaluator uses the expected location's catalog label and city. All source labels and source-reference comparisons still use the inspected dataset fields.
- Real-provider experiment passed on the named preview: [Cloud experiment](https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/datasets/cmu09dh30014aad0cq703wi5l/runs/026ec27e-74a8-48bc-b770-a185f5cc7e09). CLI verified three experiment items with 48 numeric scores each. Every item scored `selectionCorrect=6`, `delivered=1`, and both divergence counts zero. Cloud aggregate scores: `lines=18`, `selectionCorrect=18`, `divergedAfterAsking=0`, `divergedWithoutAsking=0`, `regression=0`.
- Item proof: routine trace `f962e334442a34c4f8aeba8bd17c46db`, observation `bc33f26cdf217a4f`; messy trace `e876e8b3c5dad1c103f84c5cf21ebc68`, observation `7cbe4737cd4ce049`; ambiguous trace `1656b3ad1f3b35add73fcdbcf738be7e`, observation `1f3374d2dfe7ffb3`. Exported item input, output, and expected output contain no email or owner-capability field.
- Live verification exposed an SDK 5.11.1 type/runtime mismatch: original fields are under `result.item`, although its types also declare top-level fields. The first experiment `0b666da1-b883-4c2b-8085-3daacc94cf77` delivered all three items but failed its aggregate evaluator. The runner now reads `item.input`. An offline contract test covers the actual SDK result, missing items, missing scores, and failed runs. The corrected experiment above passes.
- Review follow-up: source position/reference/quantity and `metadata.expectedReview` consistency are diagnostic scores. Cloud metadata replaces the old hardcoded per-scenario review expectations. No scenario gold answers were recommitted.
- Approval review initially rejected live execution for unclear payload authorization. The identical action was approved after inspection confirmed the bundled requests are entirely synthetic and limited to the ticket's three scenarios. Only this isolated preview's rate-limit test records were cleared for the corrected rerun, as the coordinator authorized.

- Final corrected implementation checks: format, lint, wizard, TypeScript and build passed; full serial suite passed **357/357** across 20 files. The required `pnpm check` has only the pre-existing PNG determinism failure. Eleven evaluator tests include the actual SDK nested-item result contract.
- Non-gating live diagnostics remain visible: the ambiguous scenario has `referencesCorrect=0/6` and one missed expected review (`reviewLinesObserved=1`, expected 2). Its six final SKUs and quantities are correct. The agreed selection/divergence gate passes. Routine and messy scenarios pass their extraction and expected-review checks.
