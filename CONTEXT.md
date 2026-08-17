# RFQ Relay — domain context

Single bounded context. Terms below are the ubiquitous language; use them in code, issues, and docs. See README for the narrative.

## Glossary

**Run** — one execution of the workflow for one RFQ, addressed by `viewId`. Owns its steps, evidence, sources, and estimate.

**Run step** — one of the ten stable, ordered business steps of a run (`rfq-received` … `delivered`), each with a status (`waiting | active | complete | review_required | error`), a human summary, and timestamps. Steps mean business progress, not provider machinery. `Review required` is the only conditional step.

**Run-step recorder** — the single module that writes a run step's lifecycle: `begin`, `hold`, `complete`, `fail`, attaching evidence, inserting the conditional review step, and nudging a waiting step's summary. It also derives and writes the run's `workflow_state` from `(step, outcome)`. Nothing else writes `run_steps`, `run_step_evidence`, or step-transition `workflow_state`. _Avoid_: "step helper", "step writer" scattered per module.

**Evidence** — the persisted, validated artifact attached to a step (documents, structure, customer, candidates, match, estimate, delivery), keyed by `(run, step, kind)`. Written by the recorder on behalf of a step; read by the run-view projection.

**Workflow state** — the run-level progress string (`accepted`, `reading_documents`, … `delivered`, `failed`) shown to the client. Derived vocabulary of the recorder; steps do not choose it directly.

**Review** — the consolidated human decision point; the workflow hibernates until the owner decides.

**Estimate / Quote** — the deterministic priced result; "canonical quote" is what delivery transforms.
