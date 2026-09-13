# RFQ experiments

The `rfq-scenarios` dataset in Langfuse owns the expected answers. The repository keeps no answer fixture.

`rfq.ts` exports `experiment(context: RunnerContext)` for `langfuse/experiment-action` v1.0.10.
Use `experiment_path: evals/rfq.ts` and `should_skip_sdk_installation: true` after installing the lockfile.
The action supplies dataset version and comparison metadata. It receives a `RegressionError` when the absolute gate fails.

Start the configured local Worker with real Mistral and OpenRouter providers. Seed its local D1 database first.
In this workspace, use only the preview server named `calm-badger` from `.claude/launch.json`.
Load Langfuse credentials into the environment, then run:

```sh
RFQ_BASE_URL=http://localhost:8787 npx -y pnpm@11.21.0 eval:run
```

The task creates each curated run through the public API. It records matches before review.
It accepts the proposal or first offered alternative. Quantity review uses the proposed or extracted quantity.
It never selects a product from the expected answer. The owner capability stays inside the task.
Contact comparison uses SHA-256 fingerprints. The local trace exporter also uses the Worker's contact mask.
Names remain visible. The action task masks its output and the SDK expected-output span attribute before export.
Run projections retain provider latency, token use, page use, model-call count, and shortlist size.

Item scores cover extraction, identity, retrieval, selection, review, pricing, delivery, and catalog consistency.
The `expectedReview` metadata flag replaces hardcoded scenario review expectations. A score checks it against the expected review positions.
The delivery-hint check uses the expected location's catalog label and city. The dataset carries its location ID.
The gate fails when `divergedWithoutAsking > 0` or `selectionCorrect + divergedAfterAsking < lines`.
A missing quote line cannot count as an answered divergence. Failed tasks and missing evaluators retain their expected line count.
An incomplete or duplicate scenario dataset fails before execution.
The offline test checks 18 structured lines, three deliveries, and product changes backed by review items.

## Fresh project

`langfuse:sync` preserves existing Cloud prompts and dataset answers. It validates the dataset without overwriting UI edits.
A fresh project needs an explicit uncommitted dataset export. This replaces the original one-time seed from the deleted fixture.
Use `langfuse-cli api dataset-items list --dataset-name rfq-scenarios` to read the source project.
Save active entries from its `data` array as `{ "items": [...] }` in a private file.
Set `LANGFUSE_DATASET_BOOTSTRAP` to that JSON file when running sync against the fresh project.
Never commit this file. Without it, sync reports the missing bootstrap instead of recreating stale answers from code.
