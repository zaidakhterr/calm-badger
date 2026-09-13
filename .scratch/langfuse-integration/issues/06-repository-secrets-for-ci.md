# 06 — Repository secrets for CI

**What to build:** The GitHub repository holds the secrets the CI experiment needs, so the workflow in ticket 07 can run.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY` set on `zaidakhterr/calm-badger` with `gh secret set`, each value read from the local `.dev.vars` without printing it
- [x] Verified by name only with `gh secret list`
- [x] No value appears in any command output, log or transcript

## Comments

- Set all five repository secrets on 2026-09-13. The values were sourced from the primary checkout's local `.dev.vars` and piped through stdin to `gh secret set`.
- `gh secret list --repo zaidakhterr/calm-badger` confirmed the five required names. Output contained names and timestamps only; secret values were not displayed.
- Checks: `npx -y pnpm@11.21.0 check` reached the pre-existing `data:check` baseline and failed because `routine-replenishment` has a stale committed image. `npx -y pnpm@11.21.0 build` passed. A focused test run passed, and the subsequent full `npx -y pnpm@11.21.0 test` passed all 322 tests across 18 files.
