import { z } from "zod"
import type { DecisionInput } from "../worker/review"
import {
  CANDIDATES,
  DELIVERY,
  MATCHES,
  QUOTE,
  REVIEW,
  STRUCTURE,
  contactFingerprint,
  type RunProjection,
  type ScenarioInput,
} from "./_contracts"

export type RunFetcher = (path: string, init?: RequestInit) => Promise<Response>
const RUN = z.object({
  run: z.object({ viewId: z.string(), workflowState: z.string() }),
})
const CREATED = RUN.extend({ ownerCapability: z.string() })
const CUSTOMER = z.object({
  resolution: z
    .object({
      customerId: z.string(),
      contact: z.object({ email: z.string() }).nullable(),
      location: z.object({ id: z.string() }).nullable(),
    })
    .nullable(),
})
const DOCUMENTS = z.object({
  totals: z
    .object({ pagesProcessed: z.number(), providerLatencyMs: z.number() })
    .nullable()
    .optional(),
  sources: z.array(z.object({ label: z.string() })),
})
const settled = [
  "delivered",
  "matches_need_review",
  "review_rejected",
  "review_expired",
  "failed",
]

async function request<T>(
  fetcher: RunFetcher,
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit
): Promise<T> {
  const response = await fetcher(path, init)
  if (!response.ok)
    throw new Error(`Run API request failed (${response.status})`)
  return schema.parse(await response.json())
}
function evidence<T>(
  fetcher: RunFetcher,
  path: string,
  schema: z.ZodType<T>
): Promise<T> {
  return request(fetcher, path, z.object({ evidence: schema })).then(
    (value) => value.evidence
  )
}

/** Accept the run's proposal, then its first alternative. Expected answers never steer review. */
export function reviewDecision(
  item: z.infer<typeof REVIEW>["items"][number],
  structure: z.infer<typeof STRUCTURE>
): DecisionInput {
  if (
    item.kind === "product" &&
    !item.proposal.sku &&
    item.alternatives.length > 0
  ) {
    return {
      itemId: item.id,
      action: "alternative",
      sku: item.alternatives[0].value,
    }
  }
  if (item.kind === "quantity") {
    const quantity =
      item.proposal.quantity ??
      structure.validated?.lineItems.find(
        (line) => line.position === item.position
      )?.quantity
    if (quantity) return { itemId: item.id, action: "quantity", quantity }
  }
  return { itemId: item.id, action: "accept" }
}

export async function driveRun(
  fetcher: RunFetcher,
  input: ScenarioInput,
  options: { pollAttempts?: number; pollIntervalMs?: number } = {}
): Promise<RunProjection> {
  const startedAt = Date.now()
  const created = await request(fetcher, "/api/runs", CREATED, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: input.scenarioId }),
  })
  const viewId = created.run.viewId
  const path = `/api/runs/${viewId}`
  async function waitForRun(states: string[]) {
    for (let attempt = 0; attempt < (options.pollAttempts ?? 1200); attempt++) {
      const { run } = await request(fetcher, path, RUN)
      if (states.includes(run.workflowState)) return run.workflowState
      await new Promise((resolve) =>
        setTimeout(resolve, options.pollIntervalMs ?? 250)
      )
    }
    throw new Error(
      `Run ${viewId} did not settle before the experiment timeout`
    )
  }
  let workflowState = await waitForRun(["awaiting_review", ...settled])
  const [matches, candidates] = await Promise.all([
    evidence(fetcher, `${path}/matches`, MATCHES),
    evidence(fetcher, `${path}/candidates`, CANDIDATES),
  ])
  let review: RunProjection["review"] = null
  let approved = false
  if (workflowState === "awaiting_review") {
    review = (
      await request(fetcher, `${path}/review`, z.object({ review: REVIEW }))
    ).review
    const structure = await evidence(fetcher, `${path}/structure`, STRUCTURE)
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${created.ownerCapability}`,
    }
    for (const [suffix, body] of [
      [
        "/review/decisions",
        {
          decisions: review.items.map((item) =>
            reviewDecision(item, structure)
          ),
        },
      ],
      ["/review", { action: "approve" }],
    ] satisfies [
      string,
      { decisions: DecisionInput[] } | { action: string },
    ][]) {
      const response = await fetcher(`${path}${suffix}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
      if (!response.ok)
        throw new Error(
          `Review was refused (${response.status}) for run ${viewId}`
        )
    }
    approved = true
    workflowState = await waitForRun(settled)
  }
  const [documents, structure, customer] = await Promise.all([
    evidence(fetcher, `${path}/documents`, DOCUMENTS),
    evidence(fetcher, `${path}/structure`, STRUCTURE),
    evidence(fetcher, `${path}/customer`, CUSTOMER),
  ])
  const quoteResponse = await fetcher(`${path}/quote`)
  const quote = quoteResponse.ok
    ? QUOTE.parse(await quoteResponse.json())
    : null
  const delivery = quote
    ? (await evidence(fetcher, `${path}/delivery`, DELIVERY)).delivery
    : null
  return {
    viewId,
    workflowState,
    wallClockMs: Date.now() - startedAt,
    measurements: {
      ocrLatencyMs: documents.totals?.providerLatencyMs ?? null,
      extractionLatencyMs: structure.metrics?.latencyMs ?? null,
      rerankLatencyMs: matches.totals?.providerLatencyMs ?? null,
      pagesProcessed: documents.totals?.pagesProcessed ?? null,
      extractionTokens: structure.usage?.totalTokens ?? null,
      rerankTokens: matches.totals?.usage?.totalTokens ?? null,
      modelCalls: matches.totals?.modelCalls ?? null,
      shortlistSize: candidates.shortlistSize ?? null,
    },
    sources: documents.sources.map((source) => source.label),
    structure,
    matches,
    candidates,
    review,
    approved,
    quote,
    delivery,
    customer: {
      customerId: customer.resolution?.customerId ?? null,
      contactFingerprint: customer.resolution?.contact
        ? await contactFingerprint(customer.resolution.contact.email)
        : null,
      locationId: customer.resolution?.location?.id ?? null,
    },
  }
}

export async function requireLiveProviders(fetcher: RunFetcher): Promise<void> {
  const { system } = await request(
    fetcher,
    "/api/system",
    z.object({
      system: z.object({
        providers: z.array(
          z.object({ role: z.string(), provider: z.string() })
        ),
      }),
    })
  )
  for (const [role, provider] of [
    ["Document reading", "mistral"],
    ["RFQ structuring", "openrouter"],
    ["Candidate reranking", "openrouter"],
  ]) {
    if (
      !system.providers.some(
        (entry) => entry.role.includes(role) && entry.provider === provider
      )
    )
      throw new Error(`Experiment requires real ${role} provider ${provider}`)
  }
}
