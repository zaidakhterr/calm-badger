/**
 * System details.
 *
 * The technical context a reviewer needs to judge the demo, read from the same
 * configuration and data the workflow actually uses rather than restated in the
 * interface. It is a public, read-only projection: no API keys, no secret
 * names, no gold fixtures, no run contents. Where a capability is designed but
 * not yet built, this says so instead of quoting a number that is not enforced.
 */

import { ADAPTERS, DEFAULT_ADAPTER } from "./adapters"
import { SHORTLIST_SIZE } from "./catalog/retrieval"
import { REFERENCE_EVALUATION } from "./evaluation-report"
import { evaluationSection } from "./evaluation-summary"
import { RATE_LIMIT_MAX_RUNS } from "./rate-limit"

export type SystemDetails = {
  architecture: {
    summary: string
    pieces: { name: string; detail: string }[]
    steps: string[]
  }
  providers: {
    role: string
    provider: string
    model: string | null
    live: boolean
    detail: string
  }[]
  catalog: {
    activeProducts: number
    archivedProducts: number
    customers: number
    contacts: number
    locations: number
    historicalOrders: number
    aliases: number
    note: string
  }
  retrieval: { steps: string[]; shortlistSize: number; note: string }
  retention: { state: "planned" | "enforced"; summary: string; rows: string[] }
  rateLimit: { state: "planned" | "enforced"; summary: string }
  adapterContract: {
    summary: string
    defaultAdapter: string
    adapters: {
      id: string
      name: string
      contract: string
      payloadFormat: string
      simulated: boolean
    }[]
  }
  evaluation: { state: "planned" | "measured"; summary: string; rows: string[] }
}

const COUNT_QUERY = `
  SELECT
    (SELECT COUNT(*) FROM catalog_products WHERE status = 'active') AS activeProducts,
    (SELECT COUNT(*) FROM catalog_products WHERE status <> 'active') AS archivedProducts,
    (SELECT COUNT(*) FROM catalog_customers) AS customers,
    (SELECT COUNT(*) FROM catalog_customer_contacts) AS contacts,
    (SELECT COUNT(*) FROM catalog_customer_locations) AS locations,
    (SELECT COUNT(*) FROM catalog_orders) AS historicalOrders,
    (SELECT COUNT(*) FROM catalog_product_aliases) AS aliases
`

type Counts = {
  activeProducts: number
  archivedProducts: number
  customers: number
  contacts: number
  locations: number
  historicalOrders: number
  aliases: number
}

/** A provider is live when it is not the deterministic contract fake. */
function providerEntry(
  role: string,
  provider: string,
  model: string | null,
  detail: string
) {
  return {
    role,
    provider,
    model: provider === "contract-fake" ? null : model,
    live: provider !== "contract-fake",
    detail:
      provider === "contract-fake"
        ? `${detail} This build is configured with the deterministic contract fake, so no external provider is called.`
        : detail,
  }
}

export async function loadSystemDetails(env: Env): Promise<SystemDetails> {
  const counts = await env.DB.prepare(COUNT_QUERY).first<Counts>()

  return {
    architecture: {
      summary:
        "One Cloudflare Worker serves the interface and the API. A Workflow orchestrates the pipeline and hibernates while it waits for a human decision; business step state lives in D1 and the browser polls it about once a second while a run is active.",
      pieces: [
        {
          name: "Worker",
          detail:
            "Serves static assets and /api/*. Owns run creation, evidence projections, and every capability check.",
        },
        {
          name: "Workflow",
          detail:
            "Durable orchestration of read, structure, resolve, retrieve, match, review, price, and deliver. waitForEvent hibernates at review rather than holding compute open.",
        },
        {
          name: "D1",
          detail:
            "Runs, steps, extracted lines, matches, reviews, quotes, deliveries, and the synthetic catalogue, including its full-text index.",
        },
        {
          name: "R2",
          detail:
            "Private storage for original source documents and large model artifacts, referenced from D1. The bucket is never public.",
        },
      ],
      steps: [
        "RFQ received",
        "Read documents",
        "Structure RFQ",
        "Resolve customer",
        "Retrieve candidates",
        "Match products",
        "Review required, when applicable",
        "Build estimate",
        "Deliver",
      ],
    },
    providers: [
      providerEntry(
        "Document reading (OCR)",
        env.OCR_PROVIDER,
        env.MISTRAL_OCR_MODEL,
        "Reads the email body, inline images, and PDF attachments into page markdown with source provenance."
      ),
      providerEntry(
        "RFQ structuring",
        env.EXTRACTION_PROVIDER,
        env.OPENROUTER_EXTRACTION_MODEL,
        "Schema-constrained extraction through the Vercel AI SDK, followed by one JSON repair attempt, Zod validation, and database integrity checks."
      ),
      providerEntry(
        "Candidate reranking",
        env.RERANK_PROVIDER,
        env.OPENROUTER_RERANK_MODEL,
        "Ranks the bounded shortlist for one requested line at a time and returns evidence for its ordering."
      ),
      {
        role: "Delivery",
        provider: "simulated webhook",
        model: null,
        live: false,
        detail:
          "Delivery is simulated in-process. No external business system is contacted and no affiliation is implied.",
      },
    ],
    catalog: {
      activeProducts: counts?.activeProducts ?? 0,
      archivedProducts: counts?.archivedProducts ?? 0,
      customers: counts?.customers ?? 0,
      contacts: counts?.contacts ?? 0,
      locations: counts?.locations ?? 0,
      historicalOrders: counts?.historicalOrders ?? 0,
      aliases: counts?.aliases ?? 0,
      note: "Deterministic synthetic data from a fixed seed. It deliberately contains aliases, misspellings, near duplicates, archived articles, pricing tiers, quantity breaks, and historical overrides.",
    },
    retrieval: {
      shortlistSize: SHORTLIST_SIZE,
      steps: [
        "Exact article-number lookup",
        "Known-alias lookup, including wording this browser's workspace confirmed earlier",
        "D1 full-text search across the complete active catalogue",
        `Shortlist of at most ${SHORTLIST_SIZE} candidates per line`,
        "Model reranking to a top three with evidence",
        "Acceptance heuristics, or one review node",
      ],
      note: "Exact and known-alias evidence settles a line without a model call. Only the shortlist is ever sent to a model, never the catalogue. The retrieval interface is the seam a vector index would replace.",
    },
    retention: {
      state: "enforced",
      summary:
        "This demo forgets. A daily cleanup deletes the private originals before it cascades the database records, Start over deletes a run immediately, and a review window never outlives the run data it decides.",
      rows: [
        "Curated sample runs: deleted seven days after they start.",
        "Custom uploads and everything derived from them: deleted twenty-four hours after they start.",
        "A run still inside a live review window is left until that window closes, then removed on the next sweep.",
        "Wording confirmed in this browser's workspace inherits its source run's deadline: seven days for a curated scenario and twenty-four hours for a custom upload. Start over removes the run immediately but leaves that short-lived browser memory until its deadline.",
        "A storage lifecycle rule on the run prefix expires any orphaned object as a safety net beneath the cleanup job.",
        "Durable workflow instances carry only a run identifier and a state name, and are terminated when a run is deleted, so what the platform keeps about a finished instance contains no request content.",
        "Measurement is cookieless, EU-hosted, and server-side: page paths are bucketed, view identifiers and query strings are never sent, and no RFQ, customer, filename, product, price, prompt, or model output is measured.",
        "Use synthetic or non-confidential documents only.",
      ],
    },
    rateLimit: {
      state: "enforced",
      summary: `Processing is limited to ${RATE_LIMIT_MAX_RUNS} runs per hour from one place, with no login and no CAPTCHA. The address is hashed together with a rotating value and the hour it arrived in, so no raw address and no stable per-visitor identifier is ever stored. Reading or sharing an existing run is never limited.`,
    },
    adapterContract: {
      summary:
        "The Generic ERP Webhook transforms the provider-neutral canonical quote and returns a synthetic external identifier and receipt. It is the fixed simulated destination, so there is nothing to select. The canonical quote is downloadable as JSON before anything is sent.",
      defaultAdapter: DEFAULT_ADAPTER,
      adapters: [DEFAULT_ADAPTER].map((id) => ({
        id,
        name: ADAPTERS[id].name,
        contract: ADAPTERS[id].contract,
        payloadFormat: ADAPTERS[id].payloadFormat,
        simulated: true,
      })),
    },
    // Measured, not asserted in copy: the counts come from the committed
    // scoreboard that `pnpm eval:fixtures` regenerates by replaying the three
    // curated requests across this API. What it says is true of those fixtures
    // under the contract fakes, which is exactly what it claims.
    evaluation: evaluationSection(REFERENCE_EVALUATION),
  }
}
