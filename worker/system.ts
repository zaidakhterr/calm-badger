/**
 * System details.
 *
 * The technical context a reviewer needs to judge the demo, read from the same
 * configuration and data the workflow actually uses rather than restated in the
 * interface. It is a public, read-only projection: no API keys, no secret
 * names, no gold fixtures, no run contents. Where a capability is designed but
 * not yet built, this says so instead of quoting a number that is not enforced.
 */

import { ADAPTERS, ADAPTER_IDS, DEFAULT_ADAPTER } from "./adapters"
import { SHORTLIST_SIZE } from "./catalog/retrieval"

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
        "Delivered",
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
        provider: "simulated adapters",
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
      state: "planned",
      summary:
        "Short-lived retention is part of the demo design. Start over deletes a run's stored artifacts immediately, and a review window never outlives the run data it decides.",
      rows: [
        "Curated sample runs: intended lifetime seven days.",
        "Custom uploads and everything derived from them: intended lifetime twenty-four hours.",
        "Scheduled expiry is not yet enforced in this build; today a run is removed when its owner resets it. The cleanup job and the storage lifecycle rule land with the expiry work.",
        "Use synthetic or non-confidential documents only.",
      ],
    },
    rateLimit: {
      state: "planned",
      summary:
        "Public rate limiting is designed as five processing runs per hashed IP per hour, with no login and no CAPTCHA, and no raw IP address persisted. It is not yet enforced in this build, so no live limit is claimed here.",
    },
    adapterContract: {
      summary:
        "Both adapters implement one export contract over the provider-neutral canonical quote: transform the document, return a synthetic external identifier and a receipt. The canonical quote is downloadable as JSON before anything is sent.",
      defaultAdapter: DEFAULT_ADAPTER,
      adapters: ADAPTER_IDS.map((id) => ({
        id,
        name: ADAPTERS[id].name,
        contract: ADAPTERS[id].contract,
        payloadFormat: ADAPTERS[id].payloadFormat,
        simulated: true,
      })),
    },
    evaluation: {
      state: "planned",
      summary:
        "Three scenario fixtures record the correct customer resolution, extracted fields, and product selection for the curated requests. The answers themselves stay in the test suite and are never served to a browser.",
      rows: [
        "The workflow contract is covered by deterministic tests that replace the OCR, model, and delivery providers with contract-compatible fakes.",
        "Scored fixture evaluation against those gold scenarios is not yet reported; measured accuracy will appear here once that harness lands.",
        "Live provider evaluation is explicitly invoked and never part of continuous integration.",
      ],
    },
  }
}
