# 09 — Owner thumbs feedback

**What to build:** The owner can give a thumbs up or down, with an optional comment, on each matched line and on the whole quote from the run view, without opening Review. Each becomes a score on the trace.

**Blocked by:** 08 — Review outcome scores.

**Status:** done

- [x] New endpoint `POST /api/runs/:viewId/feedback` with body `{ target: position | "quote", value: "up" | "down", comment? }`, owner capability required, rejected before the run has matches
- [x] Writes `owner-line-thumbs` on the `match-line` observation or `owner-quote-thumbs` on the trace, boolean, comment passed through
- [x] Run view shows thumbs on each matched line and on the quote card for the owner only; a viewer without the capability sees none
- [x] Repeat feedback on the same target overwrites, not duplicates
- [x] Tests through the public API: owner writes both kinds with comment, viewer gets forbidden, early feedback rejected
- [x] Verified on Langfuse Cloud: scores visible on the trace after clicking in the run view

## Comments

- The endpoint authorizes the owner capability before parsing feedback, rejects unknown line positions, and waits for the Langfuse write before confirming that feedback was saved.
- Score ids are deterministic per run, signal, and target. Repeating feedback updates the same score. Langfuse preserves an earlier comment when an upsert omits the field; the run view states that a blank comment keeps the earlier text, while entered text replaces it. The contract recorder mirrors this behavior.
- Owner UI verification used run view `oVZAGAhwBNSuKHA7IxIwyQ`: line 1 and quote controls both saved feedback and showed the selected pressed state. A separate viewer session opened the same shared view and expanded Match products and Build estimate; neither thumbs nor comment controls were present.
- Current Langfuse documentation consulted: [user feedback](https://langfuse.com/docs/observability/features/user-feedback) and [scores via SDK](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk).
- Cloud verification used run `ac163647-fc9d-4c0a-b913-e3d8f007147d`: [trace `0e9d2e078700a9302f9697901783ffbc`](https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/traces/0e9d2e078700a9302f9697901783ffbc). A trace-scoped CLI query returned exactly two scores after the final clicks. Score `4e01bc79967454a3a7e81e4a60e67c08` is a true observation-level BOOLEAN score with comment `Updated after owner review` on real `match-line` observation `401ca46bc64dac33`; its stable id is unchanged from the earlier down vote. Score `f72360c3e6531511aee63acce277c88e` is a false trace-level BOOLEAN score with comment `Verified quote feedback from the run view`.
- Validation: `npx -y pnpm@11.21.0 check` passes formatting, lint, and wizard checks. It stops at the known scenario asset reproducibility failure (`test/scenario-assets.node.mjs:63`): 13 data checks passed and 1 baseline failure.
- Independently ran `npx -y pnpm@11.21.0 build`: passed TypeScript, client production build, and Worker deployment dry run. Feedback and provider-contract tests pass 26 tests across 2 files. The final serial full suite passes **361 tests across 20 files**. Final formatting, lint, and `git diff --check` pass.
- One normal parallel full-suite run passed 360 of 361 tests: the existing late review test read scores left by another run from the process-global recorder. The review test passes alone (35 tests), and the full suite passes when files run serially. Ticket 08 will scope those assertions to the current trace during integration.
