# 07 — CI experiment gate

**What to build:** Every pull request runs the experiment through the Langfuse GitHub action and blocks the merge on regression, with a PR comment showing scores and a link to the comparison view.

**Blocked by:** 05 — Experiment and offline test reduction; 06 — Repository secrets for CI.

**Status:** done

- [x] Workflow triggers on pull request from branches in the repository (forked PRs cannot read secrets; documented)
- [x] Workflow installs dependencies, applies local migrations and seed, starts `wrangler dev --local` with the provider keys, then runs the Langfuse experiment action with `should_fail_on_regression: true` and the dataset name
- [x] PR comment appears with scores and the comparison link
- [x] Verified by opening a pull request from the branch and observing the check

## Comments

- Draft pull request: https://github.com/zaidakhterr/calm-badger/pull/1
- The experiment job passed: https://github.com/zaidakhterr/calm-badger/actions/runs/34784033964/job/103796139258
- The action comment reports 18 lines, 18 correct selections, no divergence, and no regression: https://github.com/zaidakhterr/calm-badger/pull/1#issuecomment-5656291573
- The comment links to the Langfuse comparison view: https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/experiments/results?baseline=c4bdc8b7-55c1-4e17-84bb-9c3dc26d45af
- Active ruleset `23215522` requires the `experiment` check from GitHub Actions integration `15368` on `main`: https://github.com/zaidakhterr/calm-badger/rules/23215522
- The ruleset has no bypass actor. It does not require the branch to be current with `main`.
- Fork pull requests skip the secret-bearing job. The README documents this GitHub limitation.
- `npx -y pnpm@11.21.0 build` passed. The full test suite passed all 357 tests in 20 files.
- `npx -y pnpm@11.21.0 check` stopped only at the known nondeterministic `routine-replenishment` PNG baseline after formatting, lint, and setup checks passed.
- The successful workflow emitted a Node.js 20 deprecation warning for existing first-party setup actions. GitHub forced them to Node.js 24, and the job passed.
