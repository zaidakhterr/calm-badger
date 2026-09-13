# 08 — Review outcome scores

**What to build:** When the owner settles a Review, each corrected line and the approve or reject decision become scores on the run's trace, so wrong matches and rejected quotes can be filtered in Langfuse.

**Blocked by:** 01 — Langfuse provider seam.

**Status:** done

- [x] The step that applies the Review outcome writes `review-line-correct` (boolean) on the `match-line` observation of each reviewed position: true for an accepted proposal, false for any correction, comment holds the corrected SKU when one exists
- [x] The same step writes `review-approved` (boolean) on the trace: true on approve, false on reject; nothing on expiry
- [x] Observation and trace ids are derived server-side from the run id and observation name, as tracing already does
- [x] Score names are constants in one place
- [x] Tests through the public API with the contract fake recorder: corrections yield one line score each with the SKU comment; approve without corrections yields only the trace score; reject yields false
- [x] Verified on Langfuse Cloud with the curated run that requires review

## Comments

- Review score writes are awaited before the review node is completed. Stable score ids make a durable retry update the same score after a partial write failure.
- A reviewed position receives at most one line score. An accepted product proposal is true; product, quantity, and field corrections are false, with a corrected SKU as the comment when present. A correction takes precedence when decisions share a position. Customer-only approval writes only the trace score.
- `match-line` span ids are deterministically derived from the run id, observation name, and line position. The tracer id generator consumes that requested id once, so nested model generations retain distinct ids. Tests prove repeatability, distinct positions, the actual emitted span id, and no nested reuse.
- Current Langfuse documentation consulted: [user feedback](https://langfuse.com/docs/observability/features/user-feedback) and [scores via SDK](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk).
- Cloud verification used curated run `4353f622-4bfd-4f1f-8f76-789ed9e77dd8`: [trace `daba4e9e73e25afb912be294754624d0`](https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/traces/daba4e9e73e25afb912be294754624d0). Score `2b5d243155a59eeb925347257078ee0c` is true on real `match-line` observation `1749675c901cc77a`; score `a65c6a44e427045530fe7e70ef26265d` is false with comment `NX-SEA-9121` on real `match-line` observation `84674a2854e6cc33`; trace score `f60c28b180678b25b2d5e5e0f4ad2290` is true. All three are BOOLEAN scores returned by the Cloud API.
- Validation: `npx -y pnpm@11.21.0 check` passes formatting, lint, and wizard checks. It stops at the known scenario asset reproducibility failure (`test/scenario-assets.node.mjs:63`): 13 data checks passed and 1 baseline failure.
- Independently ran `npx -y pnpm@11.21.0 build`: passed TypeScript, client production build, and Worker deployment dry run. Independently ran `npx -y pnpm@11.21.0 test`: **336 tests passed across 19 files**. Final formatting, lint, and `git diff --check` pass.
