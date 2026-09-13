# 12 — Operations view and docs

**What to build:** A saved Langfuse dashboard replaces the missing operations console, the product page says so, the workspace can query traces from Claude Code, and the README documents the whole integration in one section.

**Blocked by:** 05, 07, 09, 10, 11.

**Status:** done

- [x] Saved dashboard in the Langfuse project: runs per day, accepted exact components for error rate, review rate, and cost per run, plus p95 latency per step name; link recorded in the README
- [x] Production gaps page and README mark the operations-console gap as addressed by Langfuse
- [x] Langfuse MCP server entry in the workspace `.mcp.json`
- [x] README `## Tracing` becomes `## Langfuse` covering prompts, datasets, experiments, feedback, masking, cost and the dashboard; `## Evaluation` removed
- [x] Deployed variables and `.dev.vars.example` list only the variables that still exist
- [x] `pnpm check` passes except the pre-existing `data:check` failure on main

## Comments

- Saved dashboard `cmu0d75jf027ead0imtrxhgio` has five persisted widgets. The 30-day link renders daily run buckets.
- Error and review widgets count distinct trace IDs, so repeated observations cannot double-count a run. Cost includes all observations, including generations. The denominator is the distinct trace count in the cost widget.
- Langfuse v4 custom widgets do not support calculated fields. The user explicitly chose “Accept the documented components” for the three calculations.
- The rendered 30-day view showed 1 error run, 24 review runs, 26 total runs, $0.149048 total cost, and p95 latency for all ten business steps.
- Workspace `.mcp.json` stores only the endpoint and an environment-variable reference. An authenticated MCP handshake and `listObservations` call succeeded. A trace-scoped follow-up returned three observations from the same trace.
- The deployed secret list contains the four provider secrets and three Langfuse connection values in `.dev.vars.example`. Wrangler has only the current non-secret variables.
- `pnpm check` passed format, lint, and wizard checks, then stopped at the known stale PNG fixture. The full build passed. The isolated full test run passed 361 tests in 21 files.
