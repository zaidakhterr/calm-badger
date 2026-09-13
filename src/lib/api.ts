/**
 * The API as this interface reads it.
 *
 * Every response body is parsed with the schema for what was asked for, and the
 * exported types are inferred from those schemas: the Worker is not part of this
 * bundle, so on this side the schema is the contract. Identity and state fields
 * are required — a body missing one of those is not the answer to this request —
 * while enrichment (measurements, provider metadata, region overlays) reads as
 * `null` when it is absent or unreadable, exactly as it renders today.
 */

import { z } from "zod"

import { readOwnerCapability, workspaceId } from "@/lib/run-store"

const RUN_STEP_STATUS_SCHEMA = z.enum([
  "waiting",
  "active",
  "complete",
  "review_required",
  "error",
])

export type RunStepStatus = z.infer<typeof RUN_STEP_STATUS_SCHEMA>

const RUN_STEP_SCHEMA = z.object({
  key: z.string(),
  title: z.string(),
  position: z.number(),
  status: RUN_STEP_STATUS_SCHEMA,
  summary: z.string(),
  startedAt: z.string().nullable().catch(null),
  completedAt: z.string().nullable().catch(null),
})

export type RunStep = z.infer<typeof RUN_STEP_SCHEMA>

const RUN_SCHEMA = z.object({
  viewId: z.string(),
  status: z.string(),
  workflowState: z.string(),
  source: z.object({
    kind: z.string(),
    scenarioId: z.string().nullable().catch(null),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  steps: z.array(RUN_STEP_SCHEMA),
})

export type Run = z.infer<typeof RUN_SCHEMA>

const VIEWER_SCHEMA = z.object({
  isOwner: z.boolean(),
  access: z.enum(["owner", "shared"]),
  canMutate: z.boolean(),
})

export type Viewer = z.infer<typeof VIEWER_SCHEMA>

const RUN_VIEW_SCHEMA = z.object({ run: RUN_SCHEMA, viewer: VIEWER_SCHEMA })

export type RunView = z.infer<typeof RUN_VIEW_SCHEMA>

const REQUESTED_ITEM_SCHEMA = z.object({
  position: z.number(),
  reference: z.string(),
  description: z.string(),
  quantity: z.number(),
  unit: z.string(),
  note: z.string(),
})

export type RequestedItem = z.infer<typeof REQUESTED_ITEM_SCHEMA>

const SCENARIO_ATTACHMENT_SCHEMA = z.object({
  kind: z.enum(["pdf", "image"]),
  filename: z.string(),
  url: z.string(),
  title: z.string(),
  caption: z.string(),
})

export type ScenarioAttachment = z.infer<typeof SCENARIO_ATTACHMENT_SCHEMA>

/** The curated source material the landing page shows before processing. */
const SCENARIO_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  featured: z.boolean(),
  sources: z.string(),
  difficulty: z.object({
    level: z.enum(["Low", "Medium", "High"]),
    summary: z.string(),
    expectedReview: z.string(),
  }),
  email: z.object({
    from: z.object({
      name: z.string(),
      email: z.string(),
      company: z.string(),
    }),
    to: z.string(),
    subject: z.string(),
    receivedAt: z.string(),
    forwarded: z
      .object({ from: z.string(), date: z.string(), subject: z.string() })
      .nullable()
      .catch(null),
    body: z.array(z.string()),
    signature: z.array(z.string()),
  }),
  inlineImage: SCENARIO_ATTACHMENT_SCHEMA,
  pdfAttachment: SCENARIO_ATTACHMENT_SCHEMA,
  requestedItems: z.array(REQUESTED_ITEM_SCHEMA),
})

export type Scenario = z.infer<typeof SCENARIO_SCHEMA>

const SOURCE_PAGE_SCHEMA = z.object({
  pageNumber: z.number(),
  markdown: z.string(),
  width: z.number().nullable().catch(null),
  height: z.number().nullable().catch(null),
  dpi: z.number().nullable().catch(null),
  /** The overlay is enrichment: a page whose regions cannot be read shows text. */
  regions: z
    .array(
      z.object({
        id: z.string(),
        box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      })
    )
    .catch([]),
})

export type SourcePage = z.infer<typeof SOURCE_PAGE_SCHEMA>

const SOURCE_KIND_SCHEMA = z.enum(["email_body", "inline_image", "attachment"])

export type SourceKind = z.infer<typeof SOURCE_KIND_SCHEMA>

/** One source exactly as it was received: the email text, or the stored file. */
const RECEIVED_SOURCE_SCHEMA = z.object({
  id: z.string(),
  kind: SOURCE_KIND_SCHEMA,
  label: z.string(),
  mediaType: z.string(),
  byteSize: z.number(),
  text: z.string().nullable().catch(null),
  previewUrl: z.string().nullable().catch(null),
})

export type ReceivedSource = z.infer<typeof RECEIVED_SOURCE_SCHEMA>

const RECEIVED_EVIDENCE_SCHEMA = z.object({
  stepKey: z.string(),
  sources: z.array(RECEIVED_SOURCE_SCHEMA),
})

export type ReceivedEvidence = z.infer<typeof RECEIVED_EVIDENCE_SCHEMA>

const EVIDENCE_SOURCE_SCHEMA = z.object({
  id: z.string(),
  kind: SOURCE_KIND_SCHEMA,
  label: z.string(),
  mediaType: z.string(),
  byteSize: z.number(),
  reader: z.string().nullable().catch(null),
  latencyMs: z.number().nullable().catch(null),
  pagesProcessed: z.number().nullable().catch(null),
  estimatedCostUsd: z.number().nullable().catch(null),
  sanitizedResponse: z.json().nullable().catch(null),
  pages: z.array(SOURCE_PAGE_SCHEMA),
})

export type EvidenceSource = z.infer<typeof EVIDENCE_SOURCE_SCHEMA>

/** What a step projection says about itself before it says anything else. */
const EVIDENCE_STATE_SCHEMA = z.enum(["pending", "complete", "error"])

const DOCUMENT_EVIDENCE_SCHEMA = z.object({
  stepKey: z.string(),
  state: EVIDENCE_STATE_SCHEMA,
  message: z.string().nullable().catch(null),
  provider: z.string().nullable().catch(null),
  model: z.string().nullable().catch(null),
  totals: z
    .object({
      sourceCount: z.number(),
      pageCount: z.number(),
      pagesProcessed: z.number(),
      providerLatencyMs: z.number(),
      /** `null` when a page price was not configured; never silently zero. */
      estimatedCostUsd: z.number().nullable().catch(null),
      elapsedMs: z.number(),
    })
    .nullable()
    .catch(null),
  sources: z.array(EVIDENCE_SOURCE_SCHEMA),
})

export type DocumentEvidence = z.infer<typeof DOCUMENT_EVIDENCE_SCHEMA>

/** High, Medium, or Review beside a number the UI always calls a heuristic. */
const CONFIDENCE_SCHEMA = z
  .object({
    label: z.string(),
    score: z.number(),
    heuristic: z.string(),
  })
  .nullable()

export type Confidence = z.infer<typeof CONFIDENCE_SCHEMA>

const VALIDATED_LINE_SCHEMA = z.object({
  position: z.number(),
  reference: z.string(),
  description: z.string(),
  quantity: z.number().nullable().catch(null),
  unit: z.string().nullable().catch(null),
  catalogSku: z.string().nullable().catch(null),
  sourceLabel: z.string(),
  sourcePage: z.number().nullable().catch(null),
  state: z.string(),
  reason: z.string().nullable().catch(null),
})

export type ValidatedLine = z.infer<typeof VALIDATED_LINE_SCHEMA>

const USAGE_SCHEMA = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
})

const MODEL_INPUT_SCHEMA = z.object({
  system: z.string(),
  user: z.string(),
})

export type ModelInput = z.infer<typeof MODEL_INPUT_SCHEMA>

const STRUCTURE_EVIDENCE_SCHEMA = z.object({
  stepKey: z.string(),
  state: EVIDENCE_STATE_SCHEMA,
  message: z.string().nullable().catch(null),
  validated: z
    .object({
      customer: z.object({
        companyName: z.string().nullable().catch(null),
        contactName: z.string().nullable().catch(null),
        contactEmail: z.string().nullable().catch(null),
        contactPhone: z.string().nullable().catch(null),
        deliveryLocation: z.string().nullable().catch(null),
      }),
      source: z.object({
        channel: z.string(),
        subject: z.string().nullable().catch(null),
        receivedAt: z.string().nullable().catch(null),
        references: z.array(z.string()),
      }),
      deadline: z.object({
        date: z.string().nullable().catch(null),
        text: z.string().nullable().catch(null),
      }),
      lineItems: z.array(VALIDATED_LINE_SCHEMA),
    })
    .nullable(),
  confidence: CONFIDENCE_SCHEMA.catch(null),
  repaired: z.boolean(),
  issues: z.array(z.string()),
  modelInput: MODEL_INPUT_SCHEMA.nullable().catch(null),
  originalOutput: z.string().nullable().catch(null),
  provider: z.string().nullable().catch(null),
  model: z.string().nullable().catch(null),
  usage: USAGE_SCHEMA.nullable().catch(null),
  metrics: z
    .object({ latencyMs: z.number(), elapsedMs: z.number() })
    .nullable()
    .catch(null),
  estimatedCostUsd: z.number().nullable().catch(null),
  reportedCostUsd: z.number().nullable().catch(null),
})

export type StructureEvidence = z.infer<typeof STRUCTURE_EVIDENCE_SCHEMA>

const CUSTOMER_EVIDENCE_SCHEMA = z.object({
  stepKey: z.string(),
  /** `error` only ever means the stored row could not be read. */
  state: z.enum(["pending", "resolved", "unresolved", "error"]),
  message: z.string().nullable().catch(null),
  method: z.string().nullable().catch(null),
  resolution: z
    .object({
      customerId: z.string(),
      name: z.string(),
      tier: z.string(),
      contact: z
        .object({
          id: z.string(),
          name: z.string(),
          role: z.string(),
          email: z.string(),
        })
        .nullable(),
      location: z
        .object({
          id: z.string(),
          label: z.string(),
          city: z.string(),
          country: z.string(),
        })
        .nullable(),
    })
    .nullable(),
  confidence: CONFIDENCE_SCHEMA.catch(null),
  signals: z.array(
    z.object({ kind: z.string(), detail: z.string(), weight: z.number() })
  ),
  candidates: z.array(
    z.object({
      customerId: z.string(),
      name: z.string(),
      score: z.number(),
      signals: z.array(z.string()),
    })
  ),
  inputs: z
    .object({
      contactEmail: z.string().nullable().catch(null),
      companyName: z.string().nullable().catch(null),
      deliveryLocation: z.string().nullable().catch(null),
      referenceCount: z.number(),
    })
    .nullable()
    .catch(null),
  metrics: z.object({ elapsedMs: z.number() }).nullable().catch(null),
})

export type CustomerEvidence = z.infer<typeof CUSTOMER_EVIDENCE_SCHEMA>

const RETRIEVED_CANDIDATE_SCHEMA = z.object({
  rank: z.number(),
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  manufacturer: z.string(),
  unit: z.string(),
  source: z.string(),
  score: z.number(),
  evidence: z.string(),
  nearDuplicateOf: z.string().nullable().catch(null),
})

export type RetrievedCandidate = z.infer<typeof RETRIEVED_CANDIDATE_SCHEMA>

const CANDIDATE_LINE_SCHEMA = z.object({
  position: z.number(),
  reference: z.string(),
  description: z.string(),
  query: z.string(),
  state: z.string(),
  supersededSku: z.string().nullable().catch(null),
  note: z.string(),
  candidates: z.array(RETRIEVED_CANDIDATE_SCHEMA),
})

export type CandidateLine = z.infer<typeof CANDIDATE_LINE_SCHEMA>

const CANDIDATE_EVIDENCE_SCHEMA = z.object({
  stepKey: z.string(),
  state: EVIDENCE_STATE_SCHEMA,
  message: z.string().nullable().catch(null),
  method: z.string().nullable().catch(null),
  shortlistSize: z.number(),
  customerScoped: z.boolean(),
  catalog: z
    .object({
      activeProducts: z.number(),
      totalProducts: z.number(),
      archivedExcluded: z.number(),
    })
    .nullable()
    .catch(null),
  lines: z.array(CANDIDATE_LINE_SCHEMA),
  totals: z
    .object({
      lineCount: z.number(),
      exactCount: z.number(),
      retrievedCount: z.number(),
      candidateCount: z.number(),
      elapsedMs: z.number(),
    })
    .nullable()
    .catch(null),
})

export type CandidateEvidence = z.infer<typeof CANDIDATE_EVIDENCE_SCHEMA>

const MATCH_ALTERNATIVE_SCHEMA = z.object({
  sku: z.string(),
  name: z.string(),
  score: z.number(),
  reason: z.string(),
  nearDuplicateOf: z.string().nullable().catch(null),
})

export type MatchAlternative = z.infer<typeof MATCH_ALTERNATIVE_SCHEMA>

const MATCH_LINE_SCHEMA = z.object({
  position: z.number(),
  reference: z.string(),
  description: z.string(),
  state: z.string(),
  sku: z.string().nullable().catch(null),
  productName: z.string().nullable().catch(null),
  method: z.string(),
  decisionEvidence: z.string(),
  confidence: CONFIDENCE_SCHEMA.catch(null),
  winnerScore: z.number(),
  winnerGap: z.number(),
  alternatives: z.array(MATCH_ALTERNATIVE_SCHEMA),
  rejected: z.array(z.object({ sku: z.string(), reason: z.string() })),
  candidateCount: z.number(),
  shortlistSize: z.number(),
  repaired: z.boolean(),
  issues: z.array(z.string()),
  modelInput: MODEL_INPUT_SCHEMA.nullable().catch(null),
  originalOutput: z.string().nullable().catch(null),
  latencyMs: z.number().nullable().catch(null),
  usage: USAGE_SCHEMA.nullable().catch(null),
})

export type MatchLine = z.infer<typeof MATCH_LINE_SCHEMA>

const MATCH_EVIDENCE_SCHEMA = z.object({
  stepKey: z.string(),
  state: EVIDENCE_STATE_SCHEMA,
  message: z.string().nullable().catch(null),
  provider: z.string().nullable().catch(null),
  model: z.string().nullable().catch(null),
  heuristics: z
    .object({
      winnerStrength: z.number(),
      winnerGap: z.number(),
      note: z.string(),
    })
    .nullable()
    .catch(null),
  lines: z.array(MATCH_LINE_SCHEMA),
  totals: z
    .object({
      lineCount: z.number(),
      acceptedCount: z.number(),
      reviewCount: z.number(),
      deterministicCount: z.number(),
      rerankedCount: z.number(),
      modelCalls: z.number(),
      providerLatencyMs: z.number(),
      usage: USAGE_SCHEMA.nullable().catch(null),
      estimatedCostUsd: z.number().nullable().catch(null),
      elapsedMs: z.number(),
    })
    .nullable()
    .catch(null),
})

export type MatchEvidence = z.infer<typeof MATCH_EVIDENCE_SCHEMA>

const REVIEW_ALTERNATIVE_SCHEMA = z.object({
  /** A catalogue article number or a customer identifier, never free text. */
  value: z.string(),
  label: z.string(),
  detail: z.string(),
  score: z.number(),
})

export type ReviewAlternative = z.infer<typeof REVIEW_ALTERNATIVE_SCHEMA>

const REVIEW_ITEM_SCHEMA = z.object({
  id: z.string(),
  /** `customer`, `product`, `quantity`, or `field`. */
  kind: z.string(),
  position: z.number(),
  sourcePhrase: z.string(),
  detail: z.string(),
  proposal: z.object({
    label: z.string(),
    sku: z.string().nullable().catch(null),
    quantity: z.number().nullable().catch(null),
    customerId: z.string().nullable().catch(null),
  }),
  confidence: z.object({
    label: z.string(),
    score: z.number(),
    heuristic: z.string(),
  }),
  reasons: z.array(z.string()),
  alternatives: z.array(REVIEW_ALTERNATIVE_SCHEMA),
  state: z.string(),
  decision: z.string().nullable().catch(null),
  resolved: z.object({
    sku: z.string().nullable().catch(null),
    quantity: z.number().nullable().catch(null),
    customerId: z.string().nullable().catch(null),
    at: z.string().nullable().catch(null),
  }),
})

export type ReviewItem = z.infer<typeof REVIEW_ITEM_SCHEMA>

const REVIEW_SCHEMA = z.object({
  stepKey: z.string(),
  state: z.enum(["not_required", "pending", "approved", "rejected", "expired"]),
  openedAt: z.string().nullable().catch(null),
  expiresAt: z.string().nullable().catch(null),
  decidedAt: z.string().nullable().catch(null),
  summary: z.string().nullable().catch(null),
  itemCount: z.number(),
  resolvedCount: z.number(),
  canApprove: z.boolean(),
  note: z.string(),
  items: z.array(REVIEW_ITEM_SCHEMA),
})

export type Review = z.infer<typeof REVIEW_SCHEMA>

/**
 * One correction, as this browser submits it.
 *
 * This is the only contract here that is written rather than read, so it stays
 * a type: the compiler checks it at the call site, and the Worker parses the
 * body with its own schema when it arrives. There is nothing on this side to
 * parse.
 */
export type ReviewDecisionInput = {
  itemId: string
  action: "accept" | "alternative" | "catalog" | "quantity" | "customer"
  sku?: string
  quantity?: number
  customerId?: string
}

const PRICING_RULE_SCHEMA = z.enum([
  "historical_override",
  "customer_tier",
  "quantity_break",
  "catalog_base",
])

export type PricingRule = z.infer<typeof PRICING_RULE_SCHEMA>

const QUOTE_LINE_SCHEMA = z.object({
  position: z.number(),
  requested: z.object({
    reference: z.string(),
    description: z.string(),
    sourceLabel: z.string(),
    sourcePage: z.number().nullable().catch(null),
  }),
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  quantity: z.number(),
  pricing: z.object({
    rule: PRICING_RULE_SCHEMA,
    ruleLabel: z.string(),
    basePriceCents: z.number(),
    unitPriceCents: z.number(),
    discountBp: z.number().nullable().catch(null),
    explanation: z.string(),
  }),
  subtotalCents: z.number(),
  match: z.object({ method: z.string(), confidenceLabel: z.string() }),
})

export type QuoteLine = z.infer<typeof QUOTE_LINE_SCHEMA>

/**
 * The provider-neutral quote. Adapters transform this and nothing else.
 *
 * Nothing here defaults: a quote is what a customer would be charged, so a
 * document this build cannot read is shown as no quote rather than as an amount
 * with a gap in it.
 */
const CANONICAL_QUOTE_SCHEMA = z.object({
  schema: z.string(),
  quoteNumber: z.string(),
  issuedAt: z.string(),
  currency: z.string(),
  priceBasis: z.string(),
  customer: z.object({
    customerId: z.string(),
    name: z.string(),
    tier: z.string(),
    tierDiscountBp: z.number(),
    contact: z
      .object({ name: z.string(), role: z.string(), email: z.string() })
      .nullable(),
    location: z
      .object({
        label: z.string(),
        street: z.string(),
        postalCode: z.string(),
        city: z.string(),
        country: z.string(),
      })
      .nullable(),
  }),
  source: z.object({
    channel: z.string(),
    subject: z.string().nullable(),
    receivedAt: z.string().nullable(),
    references: z.array(z.string()),
    documents: z.array(
      z.object({
        kind: z.string(),
        label: z.string(),
        mediaType: z.string(),
        pageCount: z.number(),
      })
    ),
  }),
  lines: z.array(QUOTE_LINE_SCHEMA),
  totals: z.object({
    lineCount: z.number(),
    subtotalCents: z.number(),
    vatRateBp: z.number(),
    vatCents: z.number(),
    totalCents: z.number(),
  }),
  metadata: z.object({
    generator: z.string(),
    schemaVersion: z.string(),
    pricingPrecedence: z.array(PRICING_RULE_SCHEMA),
    rounding: z.string(),
    note: z.string(),
  }),
})

export type CanonicalQuote = z.infer<typeof CANONICAL_QUOTE_SCHEMA>

const ESTIMATE_EVIDENCE_SCHEMA = z.object({
  stepKey: z.string(),
  state: EVIDENCE_STATE_SCHEMA,
  message: z.string().nullable().catch(null),
  quote: CANONICAL_QUOTE_SCHEMA.nullable(),
  rules: z
    .object({
      precedence: z.array(z.string()),
      applied: z.array(z.object({ rule: z.string(), lineCount: z.number() })),
      vatRateBp: z.number(),
      rounding: z.string(),
      note: z.string(),
    })
    .nullable()
    .catch(null),
  totals: z
    .object({
      lineCount: z.number(),
      subtotalCents: z.number(),
      vatRateBp: z.number(),
      vatCents: z.number(),
      totalCents: z.number(),
      elapsedMs: z.number(),
    })
    .nullable()
    .catch(null),
})

export type EstimateEvidence = z.infer<typeof ESTIMATE_EVIDENCE_SCHEMA>

const ADAPTER_ID_SCHEMA = z.enum(["generic-erp-webhook"])

export type AdapterId = z.infer<typeof ADAPTER_ID_SCHEMA>

const DELIVERY_ADAPTER_SCHEMA = z.object({
  id: ADAPTER_ID_SCHEMA,
  name: z.string(),
  contract: z.string(),
  payloadFormat: z.string(),
  simulated: z.boolean(),
  notice: z.string(),
})

export type DeliveryAdapter = z.infer<typeof DELIVERY_ADAPTER_SCHEMA>

const DELIVERY_EVIDENCE_SCHEMA = z.object({
  stepKey: z.string(),
  adapters: z.array(DELIVERY_ADAPTER_SCHEMA),
  defaultAdapter: ADAPTER_ID_SCHEMA,
  quoteAvailable: z.boolean(),
  quoteNumber: z.string().nullable().catch(null),
  delivery: z
    .object({
      adapter: z.string(),
      adapterName: z.string(),
      externalEstimateId: z.string(),
      deliveredAt: z.string(),
      simulated: z.boolean(),
      notice: z.string(),
      /**
       * The stored documents, shown as JSON and read as JSON. They are `null`
       * when the Worker could no longer read what it stored.
       */
      payload: z.json().nullable().catch(null),
      receipt: z.json().nullable().catch(null),
    })
    .nullable(),
})

export type DeliveryEvidence = z.infer<typeof DELIVERY_EVIDENCE_SCHEMA>

/** Mirrors the Worker's upload policy so a rejected file never leaves the browser. */
export const UPLOAD_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 6,
  accept: ["application/pdf", "image/jpeg", "image/png"],
  acceptAttribute: ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png",
} as const

/**
 * Mirrors the Worker's processing limit so the landing copy states the number
 * that is actually enforced.
 */
export const PROCESSING_LIMIT_PER_HOUR = 5

/**
 * Being over the hourly processing limit is not a failure of the visitor's
 * request; the interface says so in its own voice rather than as an error.
 */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number

  constructor(message: string, retryAfterSeconds: number) {
    super(message)
    this.name = "RateLimitedError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * The two bodies an unhappy response carries. Both fields are enrichment on a
 * status code that already said what happened, so an unrecognised body falls
 * back to this interface's own sentence rather than failing a second time.
 */
const RATE_LIMIT_BODY_SCHEMA = z
  .object({
    error: z.string().optional().catch(undefined),
    retryAfterSeconds: z.number().optional().catch(undefined),
  })
  .catch({})

const ERROR_BODY_SCHEMA = z
  .object({ error: z.string().optional().catch(undefined) })
  .catch({})

async function readRateLimit(response: Response): Promise<RateLimitedError> {
  try {
    const body = RATE_LIMIT_BODY_SCHEMA.parse(await response.json())

    return new RateLimitedError(
      body.error ?? "This demo is at its hourly run limit",
      body.retryAfterSeconds ?? 3600
    )
  } catch {
    return new RateLimitedError("This demo is at its hourly run limit", 3600)
  }
}

export class RunNotFoundError extends Error {
  constructor() {
    super("This run is unavailable or has expired")
    this.name = "RunNotFoundError"
  }
}

async function readError(response: Response): Promise<string> {
  try {
    return (
      ERROR_BODY_SCHEMA.parse(await response.json()).error ??
      "The request failed"
    )
  } catch {
    return "The request failed"
  }
}

/**
 * One successful response body, read as what was asked for.
 *
 * A body that does not fit its schema is a failed request rather than a panel
 * rendered from half of it. The sentence names the request, never the field:
 * nothing about the mismatch is the reader's problem to solve.
 */
async function readBody<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
  subject: string
): Promise<z.output<Schema>> {
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success)
    throw new Error(`The ${subject} response could not be read`)

  return parsed.data
}

/** The technical context behind System details. Public and read-only. */
const SYSTEM_DETAILS_SCHEMA = z.object({
  architecture: z.object({
    summary: z.string(),
    pieces: z.array(z.object({ name: z.string(), detail: z.string() })),
    steps: z.array(z.string()),
  }),
  providers: z.array(
    z.object({
      role: z.string(),
      provider: z.string(),
      model: z.string().nullable().catch(null),
      live: z.boolean(),
      detail: z.string(),
    })
  ),
  catalog: z.object({
    activeProducts: z.number(),
    archivedProducts: z.number(),
    customers: z.number(),
    contacts: z.number(),
    locations: z.number(),
    historicalOrders: z.number(),
    aliases: z.number(),
    note: z.string(),
  }),
  retrieval: z.object({
    steps: z.array(z.string()),
    shortlistSize: z.number(),
    note: z.string(),
  }),
  retention: z.object({
    state: z.enum(["planned", "enforced"]),
    summary: z.string(),
    rows: z.array(z.string()),
  }),
  rateLimit: z.object({
    state: z.enum(["planned", "enforced"]),
    summary: z.string(),
  }),
  adapterContract: z.object({
    summary: z.string(),
    defaultAdapter: z.string(),
    adapters: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        contract: z.string(),
        payloadFormat: z.string(),
        simulated: z.boolean(),
      })
    ),
  }),
  evaluation: z.object({
    state: z.enum(["planned", "measured"]),
    summary: z.string(),
    rows: z.array(z.string()),
  }),
})

export type SystemDetails = z.infer<typeof SYSTEM_DETAILS_SCHEMA>

export async function fetchSystemDetails(): Promise<SystemDetails> {
  const response = await fetch("/api/system")

  if (!response.ok) throw new Error(await readError(response))

  const body = await readBody(
    response,
    z.object({ system: SYSTEM_DETAILS_SCHEMA }),
    "system details"
  )

  return body.system
}

export const CATALOGUE_SECTIONS = [
  "products",
  "customers",
  "orders",
  "aliases",
] as const

const CATALOGUE_SECTION_SCHEMA = z.enum(CATALOGUE_SECTIONS)

export type CatalogueSection = z.infer<typeof CATALOGUE_SECTION_SCHEMA>

/** A catalogue URL segment is visitor input, so it is parsed, not trusted. */
export function isCatalogueSection(value: string): value is CatalogueSection {
  return CATALOGUE_SECTION_SCHEMA.safeParse(value).success
}

const CATALOGUE_PRODUCT_SCHEMA = z.object({
  sku: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  manufacturer: z.string(),
  unit: z.string(),
  basePriceCents: z.number(),
  status: z.string(),
  replacementSku: z.string().nullable().catch(null),
  nearDuplicateOf: z.string().nullable().catch(null),
})

export type CatalogueProduct = z.infer<typeof CATALOGUE_PRODUCT_SCHEMA>

const CATALOGUE_CUSTOMER_SCHEMA = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  tier: z.string(),
  tierDiscountBp: z.number(),
  contactCount: z.number(),
  contactNames: z.array(z.string()),
  locationCount: z.number(),
  cities: z.array(z.string()),
})

export type CatalogueCustomer = z.infer<typeof CATALOGUE_CUSTOMER_SCHEMA>

const CATALOGUE_ORDER_SCHEMA = z.object({
  id: z.string(),
  orderedAt: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  contactName: z.string(),
  city: z.string(),
  lineCount: z.number(),
  totalQuantity: z.number(),
  totalCents: z.number(),
  skus: z.array(z.string()),
})

export type CatalogueOrder = z.infer<typeof CATALOGUE_ORDER_SCHEMA>

const CATALOGUE_ALIAS_SCHEMA = z.object({
  alias: z.string(),
  kind: z.string(),
  sku: z.string(),
  productName: z.string(),
  customerId: z.string().nullable().catch(null),
  customerName: z.string().nullable().catch(null),
})

export type CatalogueAlias = z.infer<typeof CATALOGUE_ALIAS_SCHEMA>

const CATALOGUE_PROJECTION_SCHEMA = z.discriminatedUnion("section", [
  z.object({
    section: z.literal("products"),
    rows: z.array(CATALOGUE_PRODUCT_SCHEMA),
  }),
  z.object({
    section: z.literal("customers"),
    rows: z.array(CATALOGUE_CUSTOMER_SCHEMA),
  }),
  z.object({
    section: z.literal("orders"),
    rows: z.array(CATALOGUE_ORDER_SCHEMA),
  }),
  z.object({
    section: z.literal("aliases"),
    rows: z.array(CATALOGUE_ALIAS_SCHEMA),
  }),
])

export type CatalogueProjection = z.infer<typeof CATALOGUE_PROJECTION_SCHEMA>

/** The complete bounded synthetic catalogue projection for one table. */
export async function fetchCatalogue(
  section: CatalogueSection
): Promise<CatalogueProjection> {
  const response = await fetch(`/api/catalogue/${encodeURIComponent(section)}`)

  if (!response.ok) throw new Error(await readError(response))

  const body = await readBody(
    response,
    z.object({ catalogue: CATALOGUE_PROJECTION_SCHEMA }),
    "catalogue"
  )

  return body.catalogue
}

export async function fetchScenarios(): Promise<Scenario[]> {
  const response = await fetch("/api/scenarios")

  if (!response.ok) throw new Error(await readError(response))

  const body = await readBody(
    response,
    z.object({ scenarios: z.array(SCENARIO_SCHEMA) }),
    "scenarios"
  )

  return body.scenarios
}

const CREATED_RUN_SCHEMA = z.object({
  run: RUN_SCHEMA,
  viewer: VIEWER_SCHEMA,
  /** Bearer authority for this run's mutations. Returned once, stored here. */
  ownerCapability: z.string(),
})

type CreatedRun = z.infer<typeof CREATED_RUN_SCHEMA>

/** The workspace header is what later runs learn in; it is never a credential. */
function workspaceHeaders(): Record<string, string> {
  const workspace = workspaceId()
  return workspace ? { "x-workspace-id": workspace } : {}
}

export async function createRun(scenarioId: string): Promise<CreatedRun> {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json", ...workspaceHeaders() },
    body: JSON.stringify({ scenarioId }),
  })

  if (response.status === 429) throw await readRateLimit(response)
  if (!response.ok) throw new Error(await readError(response))

  return await readBody(response, CREATED_RUN_SCHEMA, "new run")
}

/** Custom submissions post the email text and the original files as multipart. */
export async function createCustomRun(input: {
  emailBody: string
  files: File[]
}): Promise<CreatedRun> {
  const form = new FormData()
  form.set("emailBody", input.emailBody)
  for (const file of input.files) form.append("files", file)

  const response = await fetch("/api/runs", {
    method: "POST",
    headers: workspaceHeaders(),
    body: form,
  })

  if (response.status === 429) throw await readRateLimit(response)
  if (!response.ok) throw new Error(await readError(response))

  return await readBody(response, CREATED_RUN_SCHEMA, "new run")
}

/** One evidence segment, read with the schema for the step that segment shows. */
async function fetchEvidence<Evidence>(
  viewId: string,
  segment: string,
  schema: z.ZodType<Evidence>
): Promise<Evidence> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/${segment}`
  )

  if (response.status === 404) throw new RunNotFoundError()
  if (!response.ok) throw new Error(await readError(response))

  const body = await readBody(
    response,
    z.object({ evidence: schema }),
    "evidence"
  )

  return body.evidence
}

export function fetchReceivedEvidence(
  viewId: string
): Promise<ReceivedEvidence> {
  return fetchEvidence(viewId, "received", RECEIVED_EVIDENCE_SCHEMA)
}

export function fetchDocumentEvidence(
  viewId: string
): Promise<DocumentEvidence> {
  return fetchEvidence(viewId, "documents", DOCUMENT_EVIDENCE_SCHEMA)
}

export function fetchStructureEvidence(
  viewId: string
): Promise<StructureEvidence> {
  return fetchEvidence(viewId, "structure", STRUCTURE_EVIDENCE_SCHEMA)
}

export function fetchCustomerEvidence(
  viewId: string
): Promise<CustomerEvidence> {
  return fetchEvidence(viewId, "customer", CUSTOMER_EVIDENCE_SCHEMA)
}

export function fetchCandidateEvidence(
  viewId: string
): Promise<CandidateEvidence> {
  return fetchEvidence(viewId, "candidates", CANDIDATE_EVIDENCE_SCHEMA)
}

export function fetchMatchEvidence(viewId: string): Promise<MatchEvidence> {
  return fetchEvidence(viewId, "matches", MATCH_EVIDENCE_SCHEMA)
}

export function fetchEstimateEvidence(
  viewId: string
): Promise<EstimateEvidence> {
  return fetchEvidence(viewId, "estimate", ESTIMATE_EVIDENCE_SCHEMA)
}

export function fetchDeliveryEvidence(
  viewId: string
): Promise<DeliveryEvidence> {
  return fetchEvidence(viewId, "delivery", DELIVERY_EVIDENCE_SCHEMA)
}

/** The review as evidence. Any holder of the run URL may read it. */
export async function fetchReview(viewId: string): Promise<Review> {
  const response = await fetch(`/api/runs/${encodeURIComponent(viewId)}/review`)

  if (response.status === 404) throw new RunNotFoundError()
  if (!response.ok) throw new Error(await readError(response))

  const body = await readBody(
    response,
    z.object({ review: REVIEW_SCHEMA }),
    "review"
  )

  return body.review
}

function ownerHeaders(viewId: string) {
  const capability = readOwnerCapability(viewId)
  if (!capability) throw new Error("This browser does not own this run")

  return { authorization: `Bearer ${capability}` }
}

/** Owner-only: records corrections. It releases nothing on its own. */
export async function submitReviewDecisions(
  viewId: string,
  decisions: ReviewDecisionInput[]
): Promise<Review> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/review/decisions`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders(viewId) },
      body: JSON.stringify({ decisions }),
    }
  )

  if (!response.ok) throw new Error(await readError(response))

  const body = await readBody(
    response,
    z.object({ review: REVIEW_SCHEMA }),
    "review"
  )

  return body.review
}

/** Owner-only: the decision that resumes, or stops, the paused workflow. */
export async function settleReview(
  viewId: string,
  action: "approve" | "reject"
): Promise<Review> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/review`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders(viewId) },
      body: JSON.stringify({ action }),
    }
  )

  if (!response.ok) throw new Error(await readError(response))

  const body = await readBody(
    response,
    z.object({ review: REVIEW_SCHEMA }),
    "review"
  )

  return body.review
}

export type OwnerFeedbackTarget = number | "quote"
export type OwnerFeedbackValue = "up" | "down"

/** Owner-only: records one thumbs signal on a matched line or the quote. */
export async function submitOwnerFeedback(
  viewId: string,
  target: OwnerFeedbackTarget,
  value: OwnerFeedbackValue,
  comment?: string
): Promise<void> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/feedback`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders(viewId) },
      body: JSON.stringify({ target, value, comment }),
    }
  )

  if (!response.ok) throw new Error(await readError(response))

  await readBody(
    response,
    z.object({ status: z.literal("recorded") }),
    "owner feedback"
  )
}

const CATALOG_SEARCH_RESULT_SCHEMA = z.object({
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  manufacturer: z.string(),
  unit: z.string(),
})

export type CatalogSearchResult = z.infer<typeof CATALOG_SEARCH_RESULT_SCHEMA>

/** Owner-only: the complete catalogue, for when the shortlist was wrong. */
export async function searchCatalog(
  viewId: string,
  query: string
): Promise<CatalogSearchResult[]> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/review/catalog?q=${encodeURIComponent(query)}`,
    { headers: ownerHeaders(viewId) }
  )

  if (!response.ok) throw new Error(await readError(response))

  const body = await readBody(
    response,
    z.object({ products: z.array(CATALOG_SEARCH_RESULT_SCHEMA) }),
    "catalogue search"
  )

  return body.products
}

const CUSTOMER_SEARCH_RESULT_SCHEMA = z.object({
  customerId: z.string(),
  name: z.string(),
  tier: z.string(),
  city: z.string().nullable().catch(null),
})

export type CustomerSearchResult = z.infer<typeof CUSTOMER_SEARCH_RESULT_SCHEMA>

/** Owner-only: existing customers. There is no path here that creates one. */
export async function searchCustomers(
  viewId: string,
  query: string
): Promise<CustomerSearchResult[]> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/review/customers?q=${encodeURIComponent(query)}`,
    { headers: ownerHeaders(viewId) }
  )

  if (!response.ok) throw new Error(await readError(response))

  const body = await readBody(
    response,
    z.object({ customers: z.array(CUSTOMER_SEARCH_RESULT_SCHEMA) }),
    "customer search"
  )

  return body.customers
}

/** The canonical quote download. Any holder of the run URL may read it. */
export function quoteDownloadUrl(viewId: string): string {
  return `/api/runs/${encodeURIComponent(viewId)}/quote`
}

/** Reads server state. The owner capability is sent only when this browser holds it. */
export async function fetchRun(viewId: string): Promise<RunView> {
  const capability = readOwnerCapability(viewId)
  const response = await fetch(`/api/runs/${encodeURIComponent(viewId)}`, {
    headers: capability ? { authorization: `Bearer ${capability}` } : undefined,
  })

  if (response.status === 404) throw new RunNotFoundError()
  if (!response.ok) throw new Error(await readError(response))

  return await readBody(response, RUN_VIEW_SCHEMA, "run")
}

export async function resetRun(viewId: string): Promise<void> {
  const capability = readOwnerCapability(viewId)
  if (!capability) throw new Error("This browser does not own this run")

  const response = await fetch(
    `/api/runs/${encodeURIComponent(viewId)}/reset`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${capability}` },
    }
  )

  if (!response.ok) throw new Error(await readError(response))
}
