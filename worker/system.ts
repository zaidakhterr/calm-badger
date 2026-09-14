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
import { readConfig } from "./env"
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
  evaluation: { url: string }
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
        ? `${detail} This build uses a test provider. It does not call an external provider.`
        : detail,
  }
}

export async function loadSystemDetails(env: Env): Promise<SystemDetails> {
  const config = readConfig(env)
  const counts = await env.DB.prepare(COUNT_QUERY).first<Counts>()

  return {
    architecture: {
      summary:
        "One Cloudflare Worker serves the user interface and the API. A Workflow controls the run. D1 stores each Run step.",
      pieces: [
        {
          name: "Worker",
          detail:
            "Serves the user interface and /api/*. Creates runs and checks access.",
        },
        {
          name: "Workflow",
          detail:
            "Controls each Run step. It stops compute while it waits for a review decision.",
        },
        {
          name: "D1",
          detail:
            "Stores runs, evidence, reviews, quotes, deliveries, and the synthetic catalogue.",
        },
        {
          name: "R2",
          detail:
            "Stores source files and large model results. The bucket is private.",
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
        config.ocrProvider,
        config.mistralOcrModel,
        "Reads email text, images, and PDF files. Keeps the source of each page."
      ),
      providerEntry(
        "RFQ structuring",
        config.extractionProvider,
        null,
        "Uses the model and schema from the extraction prompt in Langfuse. Repairs JSON once. Then it checks the catalogue."
      ),
      providerEntry(
        "Candidate reranking",
        config.rerankProvider,
        null,
        "Uses the model, schema, and acceptance rules from the rerank prompt in Langfuse. Returns a reason for the order."
      ),
      {
        role: "Delivery",
        provider: "simulated webhook",
        model: null,
        live: false,
        detail:
          "Delivery is simulated. The system does not contact an external business system.",
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
      note: "A fixed seed creates this synthetic data. It includes aliases, spelling errors, similar products, old products, and price rules.",
    },
    retrieval: {
      shortlistSize: SHORTLIST_SIZE,
      steps: [
        "Exact article-number lookup",
        "Known-alias lookup, including text that this browser confirmed",
        "Full-text search of all active products",
        `Shortlist of at most ${SHORTLIST_SIZE} candidates per line`,
        "Model ranking of the best three products",
        "Automatic acceptance or review",
      ],
      note: "Exact matches and known aliases do not use a model. The model receives the shortlist only. It does not receive the catalogue.",
    },
    retention: {
      state: "enforced",
      summary:
        "The system deletes demo data. A daily task deletes private files before it deletes database records.",
      rows: [
        "The system deletes sample runs after seven days.",
        "The system deletes custom runs after 24 hours.",
        "The system keeps a run while its review is open. It deletes the run after the review closes.",
        "The system deletes confirmed browser aliases when it deletes their source run.",
        "A storage rule deletes files that the daily task does not delete.",
        "A finished Workflow stores a run ID and a state only. It does not store request content.",
        "PostHog receives grouped page paths and approved event values only. It does not receive request or model content.",
        "Use synthetic or non-confidential documents only.",
      ],
    },
    rateLimit: {
      state: "enforced",
      summary: `You can start ${RATE_LIMIT_MAX_RUNS} runs each hour from one location. The system stores a temporary hash, not the network address. Reading a stored run does not use the limit.`,
    },
    adapterContract: {
      summary:
        "The Generic ERP Webhook converts the canonical quote to a JSON event. It returns a synthetic ID and receipt. Delivery is simulated.",
      defaultAdapter: DEFAULT_ADAPTER,
      adapters: [DEFAULT_ADAPTER].map((id) => ({
        id,
        name: ADAPTERS[id].name,
        contract: ADAPTERS[id].contract,
        payloadFormat: ADAPTERS[id].payloadFormat,
        simulated: true,
      })),
    },
    evaluation: {
      url: "https://cloud.langfuse.com/project/cmtykeufs0geead0ii4y5mwhq/datasets/cmu09dh30014aad0cq703wi5l/experiments",
    },
  }
}
