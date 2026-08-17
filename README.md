# RFQ Relay

RFQ Relay turns a messy request for quotation — a forwarded email with a PDF
and a phone photograph attached — into an auditable, priced quote, and shows
every decision it made on the way there.

It is a public demonstration of one workflow, not a product. The document
reading and the language-model extraction are **live**; the pricing is
**deterministic**; the delivery to an external business system is
**simulated**. Those boundaries are stated again, precisely, in
[What is real and what is simulated](#what-is-real-and-what-is-simulated), and
the capabilities a production system would need but this demo deliberately does
not have are listed in [Production extensions](#production-extensions).

All data is synthetic. The catalogue, the customers, the order history, the
scenario emails and their attachments are generated from a fixed seed and
belong to no real company.

## Contents

- [The problem](#the-problem)
- [What is real and what is simulated](#what-is-real-and-what-is-simulated)
- [Architecture](#architecture)
- [The workflow](#the-workflow)
- [Retrieval and matching](#retrieval-and-matching)
- [Validation and what the model is not trusted with](#validation-and-what-the-model-is-not-trusted-with)
- [Pricing and delivery](#pricing-and-delivery)
- [Synthetic dataset and curated scenarios](#synthetic-dataset-and-curated-scenarios)
- [Security boundaries](#security-boundaries)
- [Retention](#retention)
- [Analytics](#analytics)
- [Local development](#local-development)
- [Checks](#checks)
- [Evaluation](#evaluation)
- [Cloudflare runtime](#cloudflare-runtime)
- [First infrastructure setup](#first-infrastructure-setup)
- [Continuous integration and deployment](#continuous-integration-and-deployment)
- [Production extensions](#production-extensions)
- [License](#license)

## The problem

A B2B distributor's inbound demand does not arrive as structured data. It
arrives as a forwarded email thread, a scanned item list, a photograph of a
shelf label, an attachment with six lines and no article numbers. Someone in
inside sales reads it, works out which customer it is, guesses which of 250
near-identical catalogue products each line means, checks whether that customer
has a negotiated price, and types a quote.

Every part of that is automatable and every part of it is risky. Extraction
invents fields. Matching picks a product that differs from the right one by one
dimension. A model asked to price something will happily produce a plausible
number. The interesting engineering question is not "can a language model read
an RFQ" — it can — but **where the model's judgment is allowed to reach the
customer, and what stands between the two**.

RFQ Relay is one answer to that question, made inspectable. It is generic: it
models a general industrial and facilities distributor and contains no
references to any specific company, customer, or commercial product.

## What is real and what is simulated

| Stage                    | Status        | What that means                                                                        |
| ------------------------ | ------------- | -------------------------------------------------------------------------------------- |
| Document reading (OCR)   | **Live**      | PDFs and images go to Mistral OCR over the network. No prerecorded output, no fallback |
| RFQ structuring          | **Live**      | A language model via OpenRouter, with a strict output schema                           |
| Customer resolution      | Deterministic | Email identity, domains, aliases, contacts, locations, and order history               |
| Candidate retrieval      | Deterministic | Exact SKU and alias lookup, then D1 full-text search over the whole catalogue          |
| Reranking                | **Live**      | A language model narrows a shortlist of eight to a ranked three, with evidence         |
| Human review             | Real          | The workflow genuinely hibernates until a person decides                               |
| Pricing                  | Deterministic | Catalogue and customer rules only. No model is asked for a number                      |
| Delivery to external ERP | **Simulated** | See below                                                                              |

Delivery is the one place where nothing leaves the system. Both delivery
adapters — CoreBridge Sandbox and Generic ERP Webhook — are independently
designed, fictional transformations of the canonical quote. They make no
network call, hold no credential, are connected to no third party, and return a
synthetic external estimate ID. They exist to make the adapter boundary
inspectable, not to claim an integration. Neither name implies any relationship
with, or endorsement by, any real vendor.

The confidence figure the interface shows is a **demo heuristic**: a
winner-strength and winner-gap threshold over rerank scores, labelled High,
Medium, or Review. It is not a calibrated probability, and the interface says so
where it appears.

## Architecture

One Cloudflare Worker serves the built React application and every `/api/*`
route. It is the only public surface.

```
browser ──► Worker (assets + /api/*) ──► Workflow (durable orchestration)
                │                              │
                │                              ├─► Mistral OCR        (live)
                │                              ├─► OpenRouter LLM     (live)
                │                              └─► delivery adapter   (simulated)
                │
                ├─► D1        run, step, customer, line, match, estimate, rate-limit state
                └─► R2        private source documents and large model artifacts
```

- **Client** — React 19, TypeScript, Vite, Tailwind CSS v4, TanStack Router,
  shadcn/ui from preset `b1D0ekIC` (Mira, Neutral, Inter, Phosphor icons, Base
  UI primitives). Two typed routes: `/` for source selection and
  `/runs/:viewId` for one run.
- **Orchestration** — a Cloudflare Workflow owns the long-running pipeline. It
  survives provider latency and, at human review, calls `waitForEvent` and
  hibernates: a run waiting for a decision consumes no compute and needs no
  client polling to stay alive.
- **Persistence** — every workflow step writes its business state to D1 as it
  completes, so the graph the browser polls (about once a second while active)
  reflects durable server state rather than client animation. A run survives
  refresh, and its evidence outlives the request that produced it. The
  Run-step recorder (`worker/run-steps.ts`) is the single writer of step
  lifecycle state and evidence, and derives the run's workflow state from the
  step and its outcome.
- **Provider seams** — OCR, language model, delivery, and analytics each sit
  behind a narrow interface in `worker/providers/` and `worker/adapters.ts`.
  Each has a contract-compatible fake, which is what tests and fixture
  evaluation run against. The fakes refuse to run when `APP_ENV` is
  `production`, so a deployment cannot silently serve fake results.

The domain step state persisted for the graph is deliberately separate from
provider execution internals. Steps mean business progress; the evidence
attached to them carries the machinery.

## The workflow

Ten stable step titles, in one strictly linear vertical sequence. Status copy
changes; titles do not, so the graph does not jump while work proceeds.

1. **RFQ received** — the run and its first completed step are persisted before
   anything else happens.
2. **Read documents** — attachments are stored in private R2, read back, and
   sent to OCR. Page markdown and source provenance are persisted.
3. **Structure RFQ** — schema-constrained extraction of customer signals,
   delivery location, and requested lines.
4. **Resolve customer** — identity, domain, alias, contact, location, and
   history evidence. A custom upload may legitimately end unresolved; the demo
   never invents a customer record.
5. **Retrieve candidates** — bounded retrieval, shown before any reranking, so
   it is visible that the whole catalogue is never sent to a model.
6. **Match products** — reranking to a top three with evidence.
7. **Review required** — appears in the main sequence only when needed, and
   blocks every later step until a decision.
8. **Build estimate** — deterministic pricing.
9. **Deliver** — canonical quote transformed by the selected adapter.
10. **Delivered** — synthetic external estimate ID.

Each node exposes, where relevant: its sources, the validated structured
result, the decision evidence, the sanitized original model output, and
provider/model/latency/token/cost metadata. The validated result is shown
first, because that is the operational artifact; the raw provider response is
available underneath it.

## Retrieval and matching

Sending 250 products to a language model and asking it to pick would work at
this scale and stop working at any real one, so the demo does not do it.

1. **Exact SKU and known-alias lookup.** A line that matches deterministically
   is accepted automatically and never reaches a model. Deterministic evidence
   outranks model judgment.
2. **D1 full-text retrieval** over the complete catalogue for everything else,
   producing a shortlist of eight.
3. **LLM reranking** of those eight to a ranked three, each with a stated
   reason.
4. **Threshold.** A reranked winner is accepted only if it scores at least
   `MATCH_WINNER_STRENGTH` and leads the runner-up by at least
   `MATCH_WINNER_GAP` (both in `wrangler.jsonc`). Anything else goes to review
   rather than being quietly accepted.

Retrieval sits behind its own interface, so embeddings or Vectorize could
replace the FTS stage without touching orchestration — see
[Production extensions](#production-extensions).

Human review consolidates every uncertainty — product, customer, quantity,
extracted field — into one linear node rather than branching the workflow. The
owner can approve the proposal, choose one of the top three alternatives, search
the entire catalogue when the shortlist is simply wrong, and correct quantity or
customer. Creating a product is not offered. An approved correction is
remembered as an alias inside that browser's anonymous workspace only; it never
mutates the global catalogue or another visitor's data.

## Validation and what the model is not trusted with

Model text is never persisted as fact. Every response passes through:

1. one JSON-repair attempt,
2. Zod schema validation,
3. business validation against the database.

A referenced customer, product, or quantity that does not exist sends the run
to review or to a terminal error. It is never accepted. The consequence is that
a hallucinated article number cannot become a line on a quote, and a
hallucinated customer cannot become a customer.

A terminal provider or validation error is displayed as a terminal state.
There is no retry interface and no automatic retry — see
[Production extensions](#production-extensions).

## Pricing and delivery

Pricing is computed, not generated. Precedence:

1. an active customer-specific historical override,
2. the customer's pricing tier,
3. the quantity-break discount,
4. the catalogue base price.

Every applied rule is retained as evidence, so each line price can be traced to
the rule that produced it. Estimates are in EUR, show line pricing excluding
VAT, add 19% VAT, and report subtotal and total.

The result is a **canonical quote**: resolved customer and location, source
references, selected products, quantities, unit prices, tax, totals, and
adapter-independent metadata. It is downloadable as JSON. Adapters transform
that one stable contract; the transformation is shown before delivery so the
boundary is inspectable. Both adapters are simulated, as described above.

## Synthetic dataset and curated scenarios

Everything the demo quotes against is invented and generated from one fixed
seed in `worker/catalog/dataset.ts`: 250 industrial and facilities products, 25
customers with two to four contacts and one to three locations, and about 150
historical orders. The data is deliberately messy, because that is what makes
retrieval and matching a real problem: trade aliases, typographical variants,
superseded item numbers, near-duplicate products that differ in one dimension,
archived products with successors, customer pricing tiers, quantity breaks, and
customer-specific historical prices.

No record corresponds to a real company, person, product, or price. Scenario
email addresses use the reserved `.example` suffix, and every generated PDF is
stamped `SYNTHETIC DEMONSTRATION DOCUMENT`. A check enforces both.

```bash
pnpm seed:build     # rerender seed/catalog.sql from the generator
pnpm assets:build   # rerender the scenario PDF and image attachments
pnpm data:check     # verify both are current, importable, and additive
```

`seed/catalog.sql` is generated, and importing it is additive: every statement
is an `INSERT OR IGNORE` into a `catalog_` table, so reseeding a running
deployment adds missing rows and cannot remove or overwrite anything a demo has
accumulated. After migrations, deployment checks the remote product and customer
counts. It imports the foundation and catalogue seeds only when both are zero,
then verifies the deterministic minimum of 250 products and 25 customers. A
partial or unexpectedly small catalogue stops deployment without importing seed
data. The setup wizard still imports both seeds together as one confirmed step.

`GET /api/scenarios` serves the three curated requests — Routine replenishment,
Messy forwarded request (featured and selected by default), and Ambiguous
replacement parts. Each one carries a forwarded-email body, an inline
photograph, a PDF item list under `public/scenarios/`, six requested lines, and
a plain statement of what makes it easy or hard.

The expected outcome of each scenario — customer, extracted fields, and the
catalogue product behind every requested line — lives in
`test/fixtures/gold-scenarios.ts`, deliberately outside `worker/` so no runtime
path can read an answer instead of producing one. Those fixtures are evaluation
material; the deterministic tests only assert that every expectation is
resolvable in the generated catalogue.

Visitors may also upload their own email text with PDF, JPEG, or PNG
attachments, subject to a MIME allowlist, a combined 10 MB limit, and at most
20 PDF or image pages per run. The interface asks for synthetic or
non-confidential documents only, because this is a public demo.

## Security boundaries

There are no accounts. Authority comes from two separate values created when a
run starts:

- `POST /api/runs` creates a run, records `RFQ received` as its first completed
  step, starts the durable workflow, and returns the run plus a plaintext owner
  capability **once**. Only the SHA-256 hash of that 32-byte capability is
  stored.
- `GET /api/runs/:viewId` returns an allowlisted read-only projection to any
  holder of the URL. Sending the owner capability as
  `Authorization: Bearer <capability>` additionally marks the viewer as owner.
- Mutations — `reset`, `review`, `deliver`, and adapter payload preview —
  require that capability, scoped to that exact run, and validate the run's
  state before acting. **The public view identifier is never accepted as
  authorization.**

The originating browser keeps its owner capability and a short recent-run list
in `localStorage`. A browser that only opened a copied URL is a shared viewer:
same workflow evidence, no approval or reset controls. Shared run URLs are
bearer links — anyone holding the URL can read the run. The interface says so.
That is an acceptable trade for synthetic demo data and is not a substitute for
authentication in production.

Other boundaries:

- **Rate limiting** — five processing runs per hour per visitor, with a
  friendly message afterwards. The Worker hashes the IP address with a rotating
  secret (`RATE_LIMIT_SALT`) and persists no raw IP. There is no login and no
  CAPTCHA; the point is to protect the provider keys without adding friction.
- **Uploads** — MIME allowlist plus a combined 10 MB transport limit, rejected
  before any processing. Paid OCR is capped at 20 PDF or image pages per run;
  an over-limit document ends with an actionable message instead of being
  processed without a bound or silently truncated.
- **Secrets** — provider keys exist only as encrypted Cloudflare Worker secrets
  and, locally, in the git-ignored `.dev.vars`. They are never in
  `wrangler.jsonc`, never in the repository, and never sent to GitHub. CI
  receives only a Cloudflare deployment token and account ID.
- **Source documents** — uploaded PDFs and images live in a private R2 bucket
  and are served only through capability-checked or run-scoped endpoints.
- **Logs** — structured and keyed by run, workflow, and step. They do not
  contain RFQ text, customer data, or secrets.

## Retention

A public demo should forget.

- **Curated sample runs** are deleted seven days after creation, so a shared
  link stays inspectable for a while.
- **Custom uploads and everything derived from them** are deleted after 24
  hours.
- A **daily Cron sweep** (`23 3 * * *`) deletes private R2 objects _before_ the
  D1 rows that point at them, in bounded batches, resuming an interrupted
  cleanup on the next schedule. A run with a live pending review is deferred
  rather than swept out from under the person deciding it.
- **R2 lifecycle rules** are the safety net beneath all of it, for bytes whose
  D1 row is already gone: `runs/custom/` expires after one day and
  `runs/curated/` after eight days. The broad eight-day `runs/` rule remains for
  legacy keys created before retention-class prefixes existed; the earlier
  custom rule wins where prefixes overlap. These are account-side bucket
  settings rather than Worker configuration, so the setup wizard adds them.

An expired run returns a plain expired-or-not-found state instead of a broken
graph. `Start over` genuinely deletes the current run's stored artifacts.

## Analytics

Measurement is cookieless, server-side, EU-hosted PostHog with no identity, no
person profiles, no autocapture, no session replay, no heatmaps, and no
exception or performance capture.

What can be captured is a closed set, enforced in `worker/analytics.ts` rather
than trusted at each call site: automatic pageviews with the view identifier
and the entire query string removed before the event is built, and five funnel
events — `rfq_run_started`, `rfq_run_rejected`, `rfq_run_rate_limited`,
`rfq_review_decided`, `rfq_quote_delivered`. Every property is a small,
enumerated bucket. No RFQ or customer or product content, no filenames, no
prices, no prompts, no model output, no raw errors, no free text of any kind
can be attached to an event.

Set `ANALYTICS_PROVIDER=none` to disable measurement entirely. The committed
`.dev.vars.example` sets `APP_ENV=development`, which keeps local traffic out of
the deployed project after it is copied to `.dev.vars`.

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars   # then fill in your own keys
pnpm cf:types
pnpm db:migrate:local
pnpm db:seed:local
pnpm dev:worker
```

`.dev.vars.example` sets the non-secret local environment mode and lists exactly
the four secrets the Worker reads with empty values. `.dev.vars` is git-ignored;
keep real keys only there.

`pnpm dev:worker` builds the React client and starts one local Cloudflare Worker
with emulated D1, R2, and Workflow bindings, while OCR and language-model calls
go to the real providers — the complete application, locally. Visit
`http://localhost:8787` and check the runtime with:

```bash
curl http://localhost:8787/api/health
```

For client-only UI work with Vite HMR, use `pnpm dev`.

## Checks

```bash
pnpm typecheck   # wrangler types --check, then tsc -b
pnpm lint
pnpm format:check
pnpm wizard:check
pnpm data:check
pnpm test
pnpm build
```

`pnpm check` runs all of these, and is what CI runs.

## Evaluation

The three curated workflows are scored against gold fixtures by replaying them
across the public API. The deterministic run uses the contract-compatible fake
OCR, language-model, and delivery providers, so it needs no credential, makes no
network call, and costs nothing:

```bash
pnpm eval:fixtures                        # score and refresh worker/evaluation-report.ts
node scripts/run-evaluation.mjs --check    # score without writing; what CI runs
```

The committed summary is what System details reports. It is fixture-based and
measured through the fakes, not a claim about production traffic, and three
scenarios is a demonstration rather than a statistically meaningful sample.

The same scoring runs against the configured live OCR and language-model
providers, reporting latency, usage, and failures. It is explicitly invoked,
never part of CI, and costs real money:

```bash
pnpm eval:live
```

Provider selection comes from the environment (`OCR_PROVIDER`,
`EXTRACTION_PROVIDER`, `RERANK_PROVIDER`), and keys are read from `.dev.vars` or
the environment. A live run that ends up on the fakes fails rather than
reporting fake results as live ones.

## Cloudflare runtime

The demo targets the paid Workers plan: waiting on providers is remote I/O, but
durable orchestration and active processing use paid allowances.

The Worker configuration in `wrangler.jsonc` declares:

- `DB` — local or deployed D1 storage, with additive migrations in `migrations/`
- `ARTIFACTS` — private R2 source and model artifacts
- `RFQ_WORKFLOW` — durable RFQ orchestration
- `ASSETS` — the built React application

Non-secret configuration — provider selection, model identifiers, cost
constants, match thresholds, review windows, analytics host — lives in the
`vars` block of `wrangler.jsonc`, each with a comment explaining what it does.

Every generated resource is named from one neutral codename slug the wizard
selects: the Worker is `<slug>`, the database `<slug>-db`, the bucket
`<slug>-artifacts`, and the workflow `<slug>-workflow`. RFQ Relay remains the
in-product name; the infrastructure names are deliberately meaningless. The
checked-in `calm-badger` names and D1 ID are setup placeholders, replaced by
`scripts/update-wrangler-config.mjs` during setup.

Provider credentials are never stored in `wrangler.jsonc`. Local development
uses the ignored `.dev.vars` file. Production uses encrypted Worker secrets —
these four, and only these four:

```bash
pnpm wrangler secret put MISTRAL_API_KEY
pnpm wrangler secret put OPENROUTER_API_KEY
pnpm wrangler secret put POSTHOG_API_KEY
pnpm wrangler secret put RATE_LIMIT_SALT
```

## First infrastructure setup

Run the committed interactive wizard from an unconfigured checkout:

```bash
./scripts/setup-infrastructure.sh
```

It checks prerequisites (Node, pnpm, GitHub CLI, Wrangler, and authentication)
with install guidance when something is missing; offers three generated neutral
codenames or a validated custom slug; creates the public repository; opens
Workers Paid billing; provisions or reuses D1 and R2 and rewrites
`wrangler.jsonc`; guides a least-privilege Cloudflare token and account ID;
migrates and seeds; builds and deploys; guides Mistral, spend-limited
OpenRouter, and EU PostHog setup; generates the rate-limit salt; uploads the
four Worker secrets; sets the GitHub Actions credentials; health-checks the
deployed public application at `<app>/api/health` and opens it; and only then
shows the publication scope and offers to commit and push.

Each dashboard page is opened for you before the value it wants is requested,
so setup does not depend on knowing where anything lives. Secrets are entered
hidden and written to the ignored `.dev.vars` and `.setup.vars` idempotently, so
reruns detect existing values, resources, remotes, and deployed secrets instead
of duplicating them. Provider keys go directly to Cloudflare and are never
written to GitHub.

Every external mutation has its own confirmation gate — repository creation,
resource provisioning, migration, seeding, deployment, secret upload, staging,
commit, and push — so the script can be stopped at any point and safely rerun.
**Publication is the last gate and stays human.** Before the push, the wizard
prints the staged diff, the complete list of tracked files, and the commit
history behind them, then asks; declining stops the script and pushes nothing.

The wizard's non-interactive structural check opens no browser and mutates
nothing:

```bash
./scripts/setup-infrastructure.sh --check
```

## Continuous integration and deployment

Both workflows use pnpm with a frozen lockfile.

**`.github/workflows/validate.yml`** — pull requests and every branch except
`main`: `pnpm check` (format, lint, wizard structural check, generated-data
check, Worker integration tests, `wrangler types --check`, `tsc`, client build,
and `wrangler deploy --dry-run`), then the deterministic fixture evaluation.

**`.github/workflows/deploy.yml`** — pushes to `main` and manual dispatch, in
the `production` environment, with a `production` concurrency group so
deployments never overlap. It runs the identical validation and fixture
evaluation **first**, and only if both pass does it apply additive D1 migrations
and deploy through the official Wrangler action. A failing check or a drifted
evaluation summary stops the deployment before anything external is touched.

Deployment applies migrations, then verifies catalogue readiness. A newly
migrated database with zero products and zero customers receives the idempotent
foundation and catalogue seeds; a ready database receives no seed writes. If
either table is partially populated or below the deterministic 250-product,
25-customer baseline, deployment fails loudly instead of masking the partial
state. The seed uses `INSERT OR IGNORE` and cannot overwrite an existing row.
Live provider evaluation is never part of CI: it costs money and would make
automated deployment non-deterministic.

CI needs exactly two values, set on the repository by the wizard:

- `CLOUDFLARE_API_TOKEN` — an Actions secret
- `CLOUDFLARE_ACCOUNT_ID` — an Actions variable

No provider key is ever available to GitHub.

## Production extensions

These are **not implemented**. They are the honest list of what this demo would
need before it could carry real commercial traffic, and they are omitted
deliberately to keep one workflow legible rather than to hide a gap.

- **Authenticated workspaces.** There are no accounts, organizations, roles, or
  collaboration. Authority is a per-run bearer capability, and shared links are
  readable by anyone holding them. Real use needs real identity and tenancy.
- **Vector retrieval.** Retrieval is D1 full-text search behind an interface
  chosen so embeddings, Vectorize, or a hybrid ranker could replace it without
  changing orchestration. That replacement has not been made.
- **Retries and failure handling.** A provider or validation failure is a
  terminal, visible state. There is no automatic retry, no backoff, no
  dead-letter path, and no operator retry interface.
- **Delivery idempotency.** Delivery is simulated and at-most-once by
  construction. A real integration needs idempotency keys, a durable outbox,
  and safety against duplicate submission.
- **Reconciliation.** Nothing confirms after the fact that an external system
  actually holds what was sent, and nothing repairs a divergence.
- **Expanded formats.** Email bodies, PDFs, JPEG, and PNG only. No GAEB,
  spreadsheets, Word documents, presentations, voice intake, supplier batch
  RFQs, or duplicate-project detection.
- **Stronger observability.** Structured logs and Workers traces at a low
  sampling rate, and nothing else: no SLOs, no alerting, no per-step cost
  budgets, no tracing across provider calls, no dashboards.
- **Calibrated evaluation.** Three gold scenarios scored through fakes. There is
  no held-out set, no regression gate on quality, no inter-annotator agreement,
  and no calibration — which is why confidence is presented as a demo heuristic
  labelled High, Medium, or Review rather than as a probability.

Also intentionally absent: quote PDF generation (the canonical quote downloads
as JSON), autonomous price generation by a model, creation of customers or
products from model output, globally learned feedback, and any aggregate
dashboard or activity feed.

## License

MIT. See [LICENSE](LICENSE).
