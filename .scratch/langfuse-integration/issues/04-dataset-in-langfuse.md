# 04 — Dataset in Langfuse

**What to build:** The three curated scenarios and their gold answers exist as a Langfuse dataset, visible in the UI, ready for experiments.

**Blocked by:** 02 — Extraction prompt from Langfuse (reuses the sync script).

**Status:** done

- [x] Sync script upserts dataset `rfq-scenarios` with one item per scenario, idempotent on rerun
- [x] Item input: scenario id and source labels. Expected output: customer id, contact email, location id, six lines with position, source reference, quantity, expected SKU, decision, basis, alternatives; expected review positions. Metadata: difficulty level and expected review flag
- [x] Items are read from the current gold fixture; the fixture is not deleted in this ticket
- [x] Verified with the Langfuse CLI: three items with the expected shape

**Comments:**

- `npx -y pnpm@11.21.0 check` passed formatting, lint, wizard checks, and 13 of 14 data checks. It stopped at the known pre-existing generated scenario PNG mismatch in `test/scenario-assets.node.mjs`.
- Independent `build` passed. A clean full test run passed all 350 tests. JSON report: `/private/tmp/ticket04-tests.json`.
- Langfuse Cloud dataset `rfq-scenarios` id `cmu09dh30014aad0cq703wi5l` contains 3 active items: `rfq-scenarios-routine-replenishment`, `rfq-scenarios-messy-forwarded-request`, and `rfq-scenarios-ambiguous-replacement-parts`. Inputs use the curated labels `Email body`, the inline image filename, and the PDF filename in worker order. A second sync preserved all three IDs and the item count. Project link: `https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/datasets/cmu09dh30014aad0cq703wi5l`.
