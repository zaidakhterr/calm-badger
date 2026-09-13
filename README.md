# RFQ Relay

RFQ Relay converts a request for quotation (RFQ) into an auditable quote. The
request can include email text, a PDF file, and a photo. The run shows each
decision.

This repository is a public demo. It is not a production product.

- Document reading is live.
- Language-model extraction and product ranking are live.
- Customer matching and price calculation use deterministic rules.
- A person confirms uncertain results.
- Delivery is simulated.

All data is synthetic. No record belongs to a real company or person.

Public product text follows the [product text style](docs/content-style.md).
This style is based on ASD-STE100 Simplified Technical English.

## Contents

- [The problem](#the-problem)
- [System limits](#system-limits)
- [Architecture](#architecture)
- [Workflow](#workflow)
- [Retrieval and product matching](#retrieval-and-product-matching)
- [Validation](#validation)
- [Price calculation and delivery](#price-calculation-and-delivery)
- [Synthetic data](#synthetic-data)
- [Security](#security)
- [Data retention](#data-retention)
- [Analytics](#analytics)
- [Local development](#local-development)
- [Checks](#checks)
- [Cloudflare resources](#cloudflare-resources)
- [First setup](#first-setup)
- [Continuous integration and deployment](#continuous-integration-and-deployment)
- [Production gaps](#production-gaps)
- [License](#license)

## The problem

A distributor can receive an RFQ as an email thread, a scanned list, or a
photo. The request can omit product numbers. It can also use old product names.

An inside-sales user must do these tasks:

1. Read the documents.
2. Identify the customer.
3. Match each line to a product.
4. Apply the correct price rule.
5. Create the quote.

Automation can make incorrect decisions. A model can invent a field. It can
also select a product with the wrong size. RFQ Relay limits where a model can
make a decision. It keeps evidence for each decision.

## System limits

| Stage             | Type          | Behavior                                                               |
| ----------------- | ------------- | ---------------------------------------------------------------------- |
| Document reading  | Live          | Mistral optical character recognition (OCR) reads PDF and image files. |
| RFQ structuring   | Live          | A language model returns data with a fixed schema.                     |
| Customer matching | Deterministic | Catalogue data and fixed scores identify a customer.                   |
| Product retrieval | Deterministic | Exact lookup and full-text search create a shortlist.                  |
| Product ranking   | Live          | A language model ranks a maximum of eight products.                    |
| Review            | Human         | The Workflow waits for the owner.                                      |
| Price calculation | Deterministic | Catalogue and customer rules calculate all amounts.                    |
| Delivery          | Simulated     | A local adapter creates a payload and a synthetic receipt.             |

The interface shows confidence labels. These labels use demo rules. They are
not calibrated probabilities.

The Generic ERP Webhook is simulated. It does not make a network request. It
does not use credentials. It does not connect to a third-party system.

## Architecture

One Cloudflare Worker serves the React client and all `/api/*` routes.

```text
browser -> Worker -> Cloudflare Workflow
              |              |-> Mistral OCR
              |              |-> OpenRouter language model
              |              `-> simulated delivery adapter
              |-> D1: run and catalogue data
              `-> R2: private source files and large model results
```

- **Client:** React 19, TypeScript, Vite, Tailwind CSS, and TanStack Router.
- **Workflow:** Cloudflare Workflow controls the long run. It stops compute
  while it waits for review.
- **D1:** Stores each Run step, its evidence, reviews, quotes, and catalogue
  data.
- **R2:** Stores private source files and large model results.
- **Provider interfaces:** OCR, extraction, ranking, delivery, and analytics
  use narrow interfaces. Tests use compatible test providers.

The Run-step recorder is the only module that changes Run step state. See
`worker/run-steps.ts`. A Run step records business progress. Provider details
stay in Evidence.

## Workflow

The run has nine possible steps:

1. **RFQ received:** Stores the email text and files.
2. **Read documents:** Reads the stored files. Stores page text and its source.
3. **Structure RFQ:** Extracts customer data, a deadline, and requested lines.
4. **Resolve customer:** Matches the request to an existing customer.
5. **Retrieve candidates:** Searches the active product catalogue.
6. **Match products:** Ranks the shortlist and selects products when safe.
7. **Review required:** Asks the owner to confirm uncertain data. This step is
   conditional.
8. **Build estimate:** Applies price rules.
9. **Deliver:** Creates the simulated delivery payload and receipt.

Each completed step can show its validated result and decision evidence.
Technical details are optional. They include model output, latency, token use,
and estimated cost.

## Retrieval and product matching

The system does not send the full catalogue to a language model.

1. It checks an exact product number and known aliases.
2. It searches all active products with D1 full-text search.
3. It keeps a maximum of eight products.
4. A model ranks the best three products.
5. The system checks the product score and the score gap.
6. It sends an uncertain line to Review.

The rerank prompt in Langfuse stores the product score and score-gap limits.

The owner can use the proposed product, select an alternative, or search the
catalogue. The owner can also correct a customer or quantity. The system cannot
create a product or customer from model output.

An approved product correction creates a temporary browser-workspace alias.
The alias is customer-specific. It cannot change the global catalogue or
another visitor's data.

## Validation

The system does not store model text as a business fact. It applies these
checks:

1. Try one JSON repair.
2. Validate the fixed Zod schema.
3. Check the customer, product, and quantity against D1.

An invalid value goes to Review or stops the run. A model cannot add an unknown
customer or product to a quote.

The demo does not retry a provider or validation error.

## Price calculation and delivery

The first applicable price rule sets the price:

1. Active customer-specific price.
2. Customer price tier.
3. Quantity discount.
4. Catalogue base price.

The system stores the applied rule for each line. All amounts use integer
cents. It calculates 19% value-added tax (VAT) once from the subtotal.

The result is the canonical quote. It contains the customer, source references,
products, quantities, prices, tax, and totals. You can download it as JSON.

The simulated webhook converts this quote to one stable event format. The
delivery step shows the payload and its synthetic receipt.

## Synthetic data

`worker/catalog/dataset.ts` creates the synthetic catalogue from a fixed seed.
It contains:

- 250 products.
- 25 customers.
- Approximately 150 historical orders.
- Aliases and spelling errors.
- Similar products and old product numbers.
- Price tiers, quantity discounts, and customer-specific prices.

All scenario email addresses use the reserved `.example` suffix. Each generated
PDF contains the text `SYNTHETIC DEMONSTRATION DOCUMENT`.

```bash
pnpm seed:build
pnpm assets:build
pnpm data:check
```

The seed uses `INSERT OR IGNORE`. It can add missing records. It cannot change
or delete stored records.

`GET /api/scenarios` returns three sample requests. Each request contains email
text, one photo, one PDF file, and six lines. Expected results stay in
the Langfuse dataset `rfq-scenarios`. Runtime code cannot read them.

Custom requests can contain email text and PDF, JPEG, or PNG files. The maximum
size is 10 MB. A run can contain a maximum of 20 pages.

## Security

This demo does not have user accounts.

`POST /api/runs` returns two values:

- A public `viewId`. Anyone with this value can read the run.
- An owner capability. Only the SHA-256 hash of this value is stored.

Review and deletion require the owner capability. The public `viewId` does not
give write access.

The browser stores its owner capability in `localStorage`. A shared browser can
read the same Evidence. It cannot approve or delete the run.

Other controls:

- **Rate limit:** Five new runs per hour from one location. The Worker stores a
  rotating hash. It does not store the network address.
- **Uploads:** The Worker checks the media type, byte limit, file count, and
  page count before a provider call.
- **Secrets:** Production uses encrypted Worker secrets. Local development uses
  the ignored `.dev.vars` file.
- **Files:** R2 is private. Run routes control access to stored files.
- **Logs:** Structured logs do not contain RFQ text, customer data, or secrets.

## Data retention

- The system deletes sample runs after seven days.
- The system deletes custom runs after 24 hours.
- A daily task deletes R2 files before D1 records.
- The task keeps a run while Review is open.
- R2 lifecycle rules delete files that the daily task does not delete.
- **Start again** deletes the current run immediately.

An expired or deleted run returns one unavailable state.

## Analytics

PostHog analytics are server-side and hosted in the European Union. The system
does not use cookies, person profiles, automatic capture, session replay,
heatmaps, exception capture, or performance capture.

`worker/analytics.ts` allows these product events only:

- `rfq_run_started`
- `rfq_run_rejected`
- `rfq_run_rate_limited`
- `rfq_review_decided`
- `rfq_quote_delivered`

The event schema uses fixed value groups. PostHog does not receive RFQ text,
customer data, file names, products, prices, prompts, model output, raw errors,
or free text.

Set `ANALYTICS_PROVIDER=none` to turn analytics off. Set
`APP_ENV=development` in `.dev.vars` to keep local events out of production
analytics.

## Tracing

Langfuse tracing is optional. It is off until all three values are set:

```bash
pnpm wrangler secret put LANGFUSE_PUBLIC_KEY
pnpm wrangler secret put LANGFUSE_SECRET_KEY
pnpm wrangler secret put LANGFUSE_BASE_URL
```

For local development, set the same three values in `.dev.vars`. Use the
European Union region, `https://cloud.langfuse.com`, to match the analytics
choice above, or the URL of a self-hosted Langfuse.

One run is one trace. Each business step is one observation in it, and the
model calls of a step nest under it. The trace carries the `environment` from
`APP_ENV`, a tag with the source kind (`curated` or `custom`), and the run,
view, and scenario identifiers as metadata.

Each trace uses its run view ID as the session ID. The user ID is a salted hash
of the stored owner-capability hash. The app currently creates a new owner
capability for each run. User grouping is per run until the app stores one
owner identity across runs.

Unlike analytics, tracing sends business content. Langfuse receives:

- the model input and output of every extraction and reranking call. The
  input holds the document text after reading, and the output holds the
  customer name and contact details the model extracted.
- the name, media type, and size of every document, but not the document bytes
- the page count and cost of every document read
- the outcome and message of every step

Langfuse masks email addresses and phone numbers before export. It does not
mask names.

Custom runs are tagged `custom`, so their traces can be filtered or deleted to
match the 24-hour retention of the run.

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm cf:types
pnpm db:migrate:local
pnpm db:seed:local
pnpm dev:worker
```

Add provider keys to `.dev.vars`. Do not commit this file.

`pnpm dev:worker` builds the client and starts a local Worker. It emulates D1,
R2, and Workflow bindings. OCR and language-model requests use the configured
providers.

Open `http://localhost:8787`. Check the runtime with this command:

```bash
curl http://localhost:8787/api/health
```

Use `pnpm dev` for client-only work with Vite hot module replacement.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm wizard:check
pnpm data:check
pnpm build
pnpm test
```

`pnpm check` runs all checks. Continuous integration (CI) uses this command.

The lint command runs ESLint and Oxlint. The local Oxlint plug-in requires code
to parse data at each interface. Zod schemas define stored evidence, provider
responses, configuration, client responses, and script data.

For experiments with real providers, see [RFQ experiments](evals/README.md).

## Cloudflare resources

`wrangler.jsonc` declares these resources:

- `DB`: D1 storage.
- `ARTIFACTS`: Private R2 storage.
- `RFQ_WORKFLOW`: Durable Workflow control.
- `ASSETS`: The built React client.

The `vars` section stores non-secret configuration. Encrypted Worker secrets
store provider credentials.

```bash
pnpm wrangler secret put MISTRAL_API_KEY
pnpm wrangler secret put OPENROUTER_API_KEY
pnpm wrangler secret put POSTHOG_API_KEY
pnpm wrangler secret put RATE_LIMIT_SALT
```

The setup tool selects one neutral resource name. It uses this name for the
Worker, D1 database, R2 bucket, and Workflow. The committed `calm-badger` names
are placeholders.

## First setup

Run the interactive setup tool from an unconfigured repository:

```bash
./scripts/setup-infrastructure.sh
```

The tool does these tasks:

1. Checks Node, pnpm, GitHub CLI, Wrangler, and authentication.
2. Selects a neutral resource name.
3. Creates or reuses the GitHub and Cloudflare resources.
4. Applies D1 migrations and imports the synthetic seed.
5. Configures Mistral, OpenRouter, PostHog, and the rate-limit secret.
6. Adds GitHub Actions credentials.
7. Builds and deploys the application.
8. Checks `<app>/api/health`.
9. Shows all files and changes before publication.

The tool asks before each external change. It asks again before it commits or
pushes. You can stop the tool and run it again. It does not duplicate existing
resources.

Run the structural check without external changes:

```bash
./scripts/setup-infrastructure.sh --check
```

## Continuous integration and deployment

`.github/workflows/validate.yml` runs for pull requests and non-main branches.
It runs `pnpm check`.

`.github/workflows/langfuse-experiment.yml` runs the curated Langfuse
experiment for pull requests from branches in this repository. It uses real
Mistral and OpenRouter providers against a local Worker and a local D1
database. The gate posts scores and the comparison link on the pull request.
Fork pull requests skip this workflow because GitHub does not give repository
secrets or a write token to fork workflows.

`.github/workflows/deploy.yml` runs for changes to `main` and for manual
deployments. It performs these tasks in order:

1. Runs all checks.
2. Applies additive D1 migrations.
3. Checks the remote catalogue.
4. Adds the seed only when the catalogue is empty.
5. Deploys the Worker.

A failed check stops deployment. Deployments do not overlap.

CI uses these GitHub values:

- `CLOUDFLARE_API_TOKEN`: Actions secret.
- `CLOUDFLARE_ACCOUNT_ID`: Actions variable.
- `MISTRAL_API_KEY`: Actions secret for the experiment Worker.
- `OPENROUTER_API_KEY`: Actions secret for the experiment Worker.
- `LANGFUSE_PUBLIC_KEY`: Actions secret for the experiment and Worker.
- `LANGFUSE_SECRET_KEY`: Actions secret for the experiment and Worker.
- `LANGFUSE_BASE_URL`: Actions secret for the Langfuse project URL.

The experiment creates a new rate-limit salt for each CI run. It disables
PostHog for the local Worker.

## Production gaps

The demo does not implement these production functions:

- User accounts, organizations, roles, and tenant isolation.
- Vector or hybrid product retrieval.
- Automatic retry, backoff, dead-letter handling, and operator recovery.
- Real delivery, idempotency, a durable outbox, and reconciliation.
- GAEB, spreadsheet, Word, presentation, voice, and batch RFQ inputs.
- Service-level objectives, alerts, cost budgets, and full provider traces.
- A held-out evaluation set, quality gates, and confidence calibration.
- Global learning from human feedback.
- PDF quote generation and a production activity dashboard.

## License

MIT. See [LICENSE](LICENSE).
