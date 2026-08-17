# RFQ Relay — domain context

Single bounded context. Terms below are the ubiquitous language; use them in code, issues, and docs. See README for the narrative.

## Glossary

**Run** — one execution of the workflow for one RFQ, addressed by `viewId`. Owns its steps, evidence, sources, and estimate.

**Run step** — one of the nine stable, ordered business steps of a run (`rfq-received` … `deliver`), each with a status (`waiting | active | complete | review_required | error`), a human summary, and timestamps. Steps mean business progress, not provider machinery. `Review required` is the only conditional step.

**Run-step recorder** — the single module that writes a run step's lifecycle: `begin`, `hold`, `complete`, `fail`, attaching evidence, inserting the conditional review step, and nudging a waiting step's summary. It also derives and writes the run's `workflow_state` from `(step, outcome)`. Nothing else writes `run_steps`, `run_step_evidence`, or step-transition `workflow_state`. _Avoid_: "step helper", "step writer" scattered per module.

**Evidence** — the persisted, validated artifact attached to a step (documents, structure, customer, candidates, match, estimate, delivery), keyed by `(run, step, kind)`. Written by the recorder on behalf of a step; read by the run-view projection.

**Boundary schema** — the Zod schema a module exports for the contract it writes or owns: a step's evidence payload, the slice of a provider response an adapter consumes, `AppConfig`, the API responses the client reads. Every boundary parses once, there: writers check their payload with `satisfies`, readers `safeParse`. Persisted enrichment fields are lenient (defaulted, nullable, or caught) so a row from an earlier build still renders; identity and state fields are required. A failed parse becomes the projection's `error` state with an `evidence_payload_invalid` log line, a provider error, or a `config_invalid` 500 — never a throw mid-projection.

**Workflow state** — the run-level progress string (`accepted`, `reading_documents`, … `delivered`, `failed`) shown to the client. Derived vocabulary of the recorder; steps do not choose it directly.

**Review** — the consolidated human decision point; the workflow hibernates until the owner decides, then wakes and applies the outcome. Review itself writes only the review tables and the claim that settles them.

**Review outcome** — the settled result of a Review: `approved | rejected | expired`, when it was decided, and the resolved decisions. Read as a value by the Workflow, which applies it in one durable step. _Avoid_: "approval effects", "settlement effects".

**Correction** — one owner decision from an outcome, applied by the step that owns the affected table: Resolve customer applies a chosen customer, Structure RFQ confirms or corrects a line, Match products applies a product choice and remembers the workspace alias. No step writes another's table.

**Estimate / Quote** — the deterministic priced result; "canonical quote" is what delivery transforms.
