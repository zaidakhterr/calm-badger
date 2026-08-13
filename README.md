# RFQ Relay

RFQ Relay is a mobile-first workflow demo that turns synthetic requests for
quotation into an auditable quote flow.

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm cf:types
pnpm db:migrate:local
pnpm dev:worker
```

`pnpm dev:worker` builds the React client and starts one local Cloudflare Worker
with emulated D1, R2, and Workflow bindings. Visit `http://localhost:8787` and
check the runtime with:

```bash
curl http://localhost:8787/api/health
```

For client-only UI work with Vite HMR, use `pnpm dev`.

The application currently exposes two typed TanStack Router routes:

- `/` — curated RFQ source selection
- `/runs/:viewId` — the persisted vertical workflow for one run

The UI baseline is generated from shadcn preset `b1D0ekIC` (Mira, Neutral,
Inter, Phosphor icons, and the Base UI primitive layer).

## Runs, sharing, and owner authority

Starting a run creates server state, so the workflow is never a client-side
animation:

- `POST /api/runs` creates a run, records `RFQ received` as its first completed
  step, starts the durable workflow, and returns the run plus a plaintext owner
  capability **once**. Only the SHA-256 hash of that capability is stored.
- `GET /api/runs/:viewId` returns an allowlisted read-only projection to any
  holder of the URL. Sending the owner capability as
  `Authorization: Bearer <capability>` additionally marks the viewer as owner.
- `POST /api/runs/:viewId/reset` is a mutation and requires the capability
  scoped to that exact run. The public view identifier is never accepted as
  authorization.

The originating browser keeps its owner capability and a short recent-run list
in `localStorage`. A browser that only opened a copied URL is a shared viewer:
it sees the same workflow evidence, but no approval or reset controls. Shared
run URLs are bearer links, which is appropriate only for synthetic demo data.

## Cloudflare runtime

The Worker configuration in `wrangler.jsonc` declares:

- `DB` — local or deployed D1 storage, with additive migrations in `migrations/`
- `ARTIFACTS` — private R2 source and model artifacts
- `RFQ_WORKFLOW` — durable RFQ orchestration
- `ASSETS` — the built React application

The checked-in resource names and D1 ID are deliberate setup placeholders. The
infrastructure wizard replaces them with one selected neutral codename before a
production deployment.

Provider credentials are never stored in `wrangler.jsonc`. Local development
uses the ignored `.dev.vars` file. Production uses encrypted Worker secrets:

```bash
pnpm wrangler secret put MISTRAL_API_KEY
pnpm wrangler secret put OPENROUTER_API_KEY
pnpm wrangler secret put POSTHOG_API_KEY
pnpm wrangler secret put RATE_LIMIT_SALT
```

GitHub Actions only requires:

- `CLOUDFLARE_API_TOKEN` as a production environment secret
- `CLOUDFLARE_ACCOUNT_ID` as a production environment variable

Pushes and pull requests run formatting, linting, Worker integration tests,
type generation checks, and a deployment dry run. Pushes to `main` additionally
apply additive D1 migrations and deploy through the official Wrangler action.

## First infrastructure setup

Run the committed interactive wizard from an unconfigured checkout:

```bash
./scripts/setup-infrastructure.sh
```

It verifies prerequisites, selects a neutral codename, guides each provider
dashboard, provisions or reuses Cloudflare resources, writes ignored local
state idempotently, deploys, checks the public health endpoint, and finally
shows the exact staged publication scope before offering to commit or push.
Every external mutation has its own confirmation gate, so the script can be
stopped and safely rerun. On reruns, valid Cloudflare credentials are loaded
from the ignored `.setup.vars` file and verified without reopening the account
setup pages or prompting for them again. The guided credential flow returns
only when those values are missing or authentication fails.

The wizard’s non-interactive structural check does not open a browser or mutate
external state:

```bash
./scripts/setup-infrastructure.sh --check
```

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm wizard:check
pnpm test
pnpm build
```
