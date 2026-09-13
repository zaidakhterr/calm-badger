# 07 — CI experiment gate

**What to build:** Every pull request runs the experiment through the Langfuse GitHub action and blocks the merge on regression, with a PR comment showing scores and a link to the comparison view.

**Blocked by:** 05 — Experiment and offline test reduction; 06 — Repository secrets for CI.

**Status:** claimed

- [ ] Workflow triggers on pull request from branches in the repository (forked PRs cannot read secrets; documented)
- [ ] Workflow installs dependencies, applies local migrations and seed, starts `wrangler dev --local` with the provider keys, then runs the Langfuse experiment action with `should_fail_on_regression: true` and the dataset name
- [ ] PR comment appears with scores and the comparison link
- [ ] Verified by opening a pull request from the branch and observing the check
