# 10 — Identity and masking

**What to build:** Every trace carries a session id and a stable user id so runs group per owner in Langfuse, and contact details are masked before export.

**Blocked by:** 01 — Langfuse provider seam.

**Status:** done

- [x] Trace `sessionId` is the run view id; trace `userId` is a salted hash of the owner capability hash using the existing rate-limit salt; both set through the propagated attributes on every step
- [x] A mask hook on the span processor replaces email addresses and phone numbers with fixed placeholders in input, output and metadata
- [x] README states that names are not masked
- [x] Tests on the in-memory exporter: session id equals view id, same user id across two runs by one owner, different across owners, no email or phone pattern in any exported attribute
- [x] Verified on Langfuse Cloud: sessions view shows the run, user view shows the owner

## Comments

- `npx -y pnpm@11.21.0 test`: 19 files and 332 tests pass.
- `npx -y pnpm@11.21.0 build`, type checking, lint, formatting, local D1 migrations, and both local seeds pass.
- `npx -y pnpm@11.21.0 check` stops only at the accepted baseline failure: the stale `routine-replenishment` scenario image.
- Cloud run `9nU--s3bLDx8m1CP60tfBA` delivered as trace [`d58c0228992a33bff94b289e8b4ce3a3`](https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/traces/d58c0228992a33bff94b289e8b4ce3a3).
- All 20 observations carry session `9nU--s3bLDx8m1CP60tfBA` and user `01058a05e67e2d7e490d6b16a17a89d6f1730d5264f3bb1b4eb61d8f043cf33b`.
- The [session](https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/sessions/9nU--s3bLDx8m1CP60tfBA) and [user](https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/users/01058a05e67e2d7e490d6b16a17a89d6f1730d5264f3bb1b4eb61d8f043cf33b) filters each return the trace.
- The expanded Cloud audit scanned 13 inputs, 19 outputs, and 20 metadata values. An independent audit checked exact scenario contacts and broader email and phone patterns; both found zero contact-bearing fields. It found six email placeholders and four phone placeholders.
- The earlier audit reused the implementation's boundary rule and missed two phone numbers after serialized `\\n` escapes. Regression coverage now round-trips doubly serialized JSON with newline-adjacent email and phone values after masking.
- The current Langfuse JS mask hook does not visit AI SDK 7 `gen_ai.*` content attributes. An ordered span processor masks those attributes before Langfuse, while the native hook masks Langfuse attributes.
- Run creation makes a new owner capability for every run. The user ID is stable for one stored owner hash, so production grouping remains per run until owner identity persists across runs. The README states this limit.
