/**
 * Scoring the three curated workflows.
 *
 * This harness drives complete runs across the public API — create, poll,
 * answer the review node, price, deliver — and scores what the run persisted
 * against `gold-scenarios.ts`. It never calls a workflow step directly, never
 * reads a table, and never inspects a prompt: everything it measures is a fact
 * the same projections a browser reads already carry.
 *
 * Two rules keep the score honest:
 *
 * 1. The gold answers steer nothing. Review decisions accept whatever the run
 *    proposed, so a scored line is the pipeline's own answer rather than one the
 *    evaluation supplied. Where a proposal is missing, the harness records the
 *    line as unanswerable instead of filling it in from the fixtures.
 * 2. Divergence is reported, not hidden. A conservative extra review is a
 *    different result from a wrong acceptance, so the report distinguishes them
 *    and carries both.
 *
 * The same code scores the deterministic contract fakes and the live providers.
 * Only the bindings differ, which is why `providers` is read back from the
 * system projection rather than assumed.
 */

import type { ReferenceEvaluationSummary } from "../../worker/evaluation-summary"
import type { GoldDecision, GoldScenario } from "./gold-scenarios"
import { GOLD_SCENARIOS } from "./gold-scenarios"

export type { ReferenceEvaluationSummary }

export type EvaluationFetcher = (
  path: string,
  init?: RequestInit
) => Promise<Response>

export type EvaluationOptions = {
  /** How many times a run is polled before it is called stuck. */
  pollAttempts?: number
  pollIntervalMs?: number
  /** Adapter the export outcome is measured through. */
  adapter?: string
}

export type LineOutcome = {
  position: number
  /** The request's own wording, as the run extracted it. */
  reference: string | null
  quantity: number | null
  goldSku: string
  goldDecision: GoldDecision
  /** The gold article number survived retrieval into the bounded shortlist. */
  shortlisted: boolean
  /** …and survived reranking into the top three shown as evidence. */
  inTopThree: boolean
  /** What matching selected before any human was asked. */
  matchedSku: string | null
  matchMethod: string | null
  reviewedByRun: boolean
  reviewedInGold: boolean
  /** What the priced quote finally carried for this line. */
  finalSku: string | null
  finalCorrect: boolean
  quantityCorrect: boolean
}

export type ScenarioEvaluation = {
  scenarioId: string
  workflowState: string
  /** Divergences and failures, in the order they were observed. */
  notes: string[]
  extraction: {
    lineCount: number
    lineCountInGold: number
    lineCountCorrect: boolean
    deliveryLocation: string | null
    /** The delivery fact the request states reached the structured RFQ. */
    deliveryLocationCarried: boolean
    sources: string[]
    sourcesInGold: string[]
    sourcesCovered: boolean
    complete: boolean
  }
  resolution: {
    customerId: string | null
    contactEmail: string | null
    locationId: string | null
    method: string | null
    customerCorrect: boolean
    contactCorrect: boolean
    locationCorrect: boolean
  }
  retrieval: { lines: number; shortlistHits: number; shortlistSize: number }
  reranking: {
    lines: number
    topThreeHits: number
    /** Lines whose pre-review selection already equals the gold article. */
    winnerCorrect: number
    modelCalls: number
  }
  review: {
    occurred: boolean
    occursInGold: boolean
    linesInGold: number[]
    linesObserved: number[]
    /** Observed reviews the fixtures did not call for: caution, not error. */
    extraLines: number[]
    /** Lines the fixtures call uncertain that the run accepted on its own. */
    missedLines: number[]
    approved: boolean
  }
  pricing: {
    priced: boolean
    lineCount: number
    subtotalCents: number
    vatRateBp: number
    totalCents: number
    rules: string[]
  }
  export: {
    delivered: boolean
    adapter: string | null
    hasExternalId: boolean
    simulated: boolean
  }
  selection: {
    correct: number
    lines: number
    quantityCorrect: number
    /** Diverging lines the run had already stopped to ask about. */
    divergedAfterAsking: number
    /** Diverging lines the run settled on its own: the serious kind. */
    divergedWithoutAsking: number
  }
  lines: LineOutcome[]
  timings: {
    wallClockMs: number
    ocrLatencyMs: number | null
    extractionLatencyMs: number | null
    rerankLatencyMs: number | null
  }
  usage: {
    pagesProcessed: number | null
    extractionTokens: number | null
    rerankTokens: number | null
    estimatedCostUsd: number | null
  }
}

export type EvaluationReport = {
  /** `fixtures` when every seam is the deterministic contract fake. */
  mode: "fixtures" | "live"
  providers: { ocr: string; extraction: string; rerank: string }
  scenarios: ScenarioEvaluation[]
  totals: {
    scenarios: number
    lines: number
    extractionComplete: number
    customerCorrect: number
    shortlistHits: number
    topThreeHits: number
    winnerCorrect: number
    selectionCorrect: number
    quantityCorrect: number
    divergedAfterAsking: number
    divergedWithoutAsking: number
    reviewLinesInGold: number
    reviewLinesObserved: number
    extraReviewLines: number
    missedReviewLines: number
    priced: number
    delivered: number
    wallClockMs: number
  }
  /** Every scenario note, prefixed with its scenario. Empty means clean. */
  failures: string[]
  /** The counts that are committed and served, derived here so that the
   * generator and the suite cannot disagree about them. */
  summary: ReferenceEvaluationSummary
}

/* -------------------------------------------------------------------------- */
/* Projections, as a browser reads them                                       */
/* -------------------------------------------------------------------------- */

type RunView = { viewId: string; status: string; workflowState: string }

type ReviewItemView = {
  id: string
  kind: string
  position: number
  proposal: { sku: string | null; quantity: number | null }
  alternatives: { value: string }[]
}

type ReviewView = { state: string; items: ReviewItemView[] }

type StructureView = {
  state: string
  validated: {
    customer: { deliveryLocation: string | null }
    lineItems: {
      position: number
      reference: string
      quantity: number | null
    }[]
  } | null
  metrics: { latencyMs: number } | null
  usage: { totalTokens: number } | null
  estimatedCostUsd: number | null
}

type CustomerView = {
  state: string
  method: string | null
  resolution: {
    customerId: string
    contact: { email: string } | null
    location: { id: string } | null
  } | null
}

type CandidatesView = {
  shortlistSize: number
  lines: { position: number; candidates: { sku: string }[] }[]
}

type MatchesView = {
  lines: {
    position: number
    reference: string
    state: string
    sku: string | null
    method: string
    alternatives: { sku: string }[]
  }[]
  totals: {
    modelCalls: number
    providerLatencyMs: number
    usage: { totalTokens: number } | null
    estimatedCostUsd: number | null
  } | null
}

type DocumentsView = {
  sources: { kind: string; mediaType: string }[]
  totals: {
    pagesProcessed: number
    providerLatencyMs: number
    estimatedCostUsd: number | null
  } | null
}

type QuoteView = {
  lines: {
    position: number
    sku: string
    quantity: number
    pricing: { rule: string }
  }[]
  totals: { subtotalCents: number; vatRateBp: number; totalCents: number }
}

type DeliveryView = {
  delivery: {
    adapter: string
    externalEstimateId: string
    simulated: boolean
  } | null
}

type SystemView = {
  providers: { role: string; provider: string }[]
}

const SETTLED_STATES = [
  "estimate_built",
  "matches_need_review",
  "review_rejected",
  "review_expired",
  "failed",
]

/* -------------------------------------------------------------------------- */
/* Driving one run                                                            */
/* -------------------------------------------------------------------------- */

export async function evaluateReferenceWorkflows(
  fetcher: EvaluationFetcher,
  options: EvaluationOptions = {}
): Promise<EvaluationReport> {
  const providers = await readProviders(fetcher)
  const scenarios: ScenarioEvaluation[] = []

  for (const gold of GOLD_SCENARIOS) {
    scenarios.push(await evaluateScenario(fetcher, gold, options))
  }

  const failures = scenarios.flatMap((scenario) =>
    scenario.notes.map((note) => `${scenario.scenarioId}: ${note}`)
  )

  const report: Omit<EvaluationReport, "summary"> = {
    mode: Object.values(providers).every((name) => name === "contract-fake")
      ? "fixtures"
      : "live",
    providers,
    scenarios,
    totals: totalsOf(scenarios),
    failures,
  }

  return { ...report, summary: summarize(report) }
}

async function evaluateScenario(
  fetcher: EvaluationFetcher,
  gold: GoldScenario,
  options: EvaluationOptions
): Promise<ScenarioEvaluation> {
  const adapter = options.adapter ?? "corebridge-sandbox"
  const notes: string[] = []
  const startedAt = Date.now()

  const created = await request<{
    run: RunView
    ownerCapability: string
  }>(fetcher, "/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: gold.scenarioId }),
  })

  const viewId = created.run.viewId
  const capability = created.ownerCapability

  let state = await waitForRun(
    fetcher,
    viewId,
    ["awaiting_review", ...SETTLED_STATES],
    options
  )

  // Matching's own answer, read before a human is asked, so that reranking and
  // review can be scored separately from the corrected outcome.
  const matches = await read<MatchesView>(
    fetcher,
    `/api/runs/${viewId}/matches`
  )
  const candidates = await read<CandidatesView>(
    fetcher,
    `/api/runs/${viewId}/candidates`
  )

  let review: ReviewView | null = null
  let approved = false

  if (state === "awaiting_review") {
    review = (
      await request<{ review: ReviewView }>(
        fetcher,
        `/api/runs/${viewId}/review`
      )
    ).review
    const structuredForReview = await read<StructureView>(
      fetcher,
      `/api/runs/${viewId}/structure`
    )

    const decisions = review.items.map((item) =>
      decisionFor(item, structuredForReview, notes)
    )

    const recorded = await fetcher(`/api/runs/${viewId}/review/decisions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${capability}`,
      },
      body: JSON.stringify({ decisions }),
    })

    if (!recorded.ok) {
      notes.push(`review decisions were refused (${recorded.status})`)
    }

    const settled = await fetcher(`/api/runs/${viewId}/review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${capability}`,
      },
      body: JSON.stringify({ action: "approve" }),
    })

    approved = settled.ok
    if (!settled.ok) {
      notes.push(`review approval was refused (${settled.status})`)
    }

    state = await waitForRun(fetcher, viewId, SETTLED_STATES, options)
  }

  if (state !== "estimate_built") {
    notes.push(`the run ended in ${state} instead of a priced estimate`)
  }

  const [documents, structured, customer] = [
    await read<DocumentsView>(fetcher, `/api/runs/${viewId}/documents`),
    await read<StructureView>(fetcher, `/api/runs/${viewId}/structure`),
    await read<CustomerView>(fetcher, `/api/runs/${viewId}/customer`),
  ]

  let quote: QuoteView | null = null
  const quoteResponse = await fetcher(`/api/runs/${viewId}/quote`)
  if (quoteResponse.ok) {
    quote = await quoteResponse.json<QuoteView>()
  } else {
    notes.push(`no canonical quote was produced (${quoteResponse.status})`)
  }

  let delivery: DeliveryView["delivery"] = null
  if (quote) {
    const delivered = await fetcher(`/api/runs/${viewId}/deliver`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${capability}`,
      },
      body: JSON.stringify({ adapter }),
    })

    if (!delivered.ok) {
      notes.push(`delivery was refused (${delivered.status})`)
    }

    delivery = (
      await read<DeliveryView>(fetcher, `/api/runs/${viewId}/delivery`)
    ).delivery
  }

  const wallClockMs = Date.now() - startedAt

  /* ---------------------------------------------------------------------- */
  /* Scoring                                                                */
  /* ---------------------------------------------------------------------- */

  const reviewedPositions = new Set(
    (review?.items ?? [])
      .filter((item) => item.kind === "product")
      .map((item) => item.position)
  )

  const lines: LineOutcome[] = gold.matches.map((goldLine) => {
    const shortlist =
      candidates.lines.find((line) => line.position === goldLine.position)
        ?.candidates ?? []
    const matched = matches.lines.find(
      (line) => line.position === goldLine.position
    )
    const topThree = matched
      ? [
          ...(matched.sku ? [matched.sku] : []),
          ...matched.alternatives.map((alternative) => alternative.sku),
        ].slice(0, 3)
      : []
    const structuredLine = structured.validated?.lineItems.find(
      (line) => line.position === goldLine.position
    )
    const quoteLine = quote?.lines.find(
      (line) => line.position === goldLine.position
    )

    return {
      position: goldLine.position,
      reference: structuredLine?.reference ?? matched?.reference ?? null,
      quantity: structuredLine?.quantity ?? quoteLine?.quantity ?? null,
      goldSku: goldLine.expectedSku,
      goldDecision: goldLine.decision,
      shortlisted:
        shortlist.some((candidate) => candidate.sku === goldLine.expectedSku) ||
        matched?.sku === goldLine.expectedSku,
      inTopThree: topThree.includes(goldLine.expectedSku),
      matchedSku: matched?.sku ?? null,
      matchMethod: matched?.method ?? null,
      reviewedByRun: reviewedPositions.has(goldLine.position),
      reviewedInGold: gold.expectedReviewPositions.includes(goldLine.position),
      finalSku: quoteLine?.sku ?? null,
      finalCorrect: quoteLine?.sku === goldLine.expectedSku,
      quantityCorrect: quoteLine?.quantity === goldLine.quantity,
    }
  })

  for (const line of lines) {
    if (line.reviewedInGold && !line.reviewedByRun) {
      notes.push(
        `line ${line.position} was accepted without asking, though the fixtures call it uncertain`
      )
    }

    if (!line.reviewedInGold && line.reviewedByRun) {
      notes.push(
        `line ${line.position} was sent to review the fixtures do not call for (a cautious extra question, not a wrong acceptance)`
      )
    }

    if (!line.finalCorrect) {
      notes.push(
        `line ${line.position} was quoted as ${line.finalSku ?? "nothing"} rather than the fixture's article` +
          (line.reviewedByRun
            ? ", on a line the run had stopped to ask about (the evaluation approves proposals unchanged; an owner would have corrected it here)"
            : ", and the run did not ask")
      )
    }
  }

  const observedSources = [...new Set(documents.sources.map(sourceKind))].sort()
  const sourcesCovered = gold.extraction.sourcesUsed.every((kind) =>
    observedSources.includes(kind)
  )
  const deliveryLocation =
    structured.validated?.customer.deliveryLocation ?? null
  const deliveryLocationCarried = mentions(
    deliveryLocation,
    gold.extraction.deliveryHint
  )
  const lineCount = structured.validated?.lineItems.length ?? 0
  const lineCountCorrect = lineCount === gold.extraction.lineItemCount

  if (!lineCountCorrect) {
    notes.push(
      `${lineCount} requested lines were structured rather than ${gold.extraction.lineItemCount}`
    )
  }

  if (!deliveryLocationCarried) {
    notes.push("the stated delivery place did not reach the structured RFQ")
  }

  if (!sourcesCovered) {
    notes.push(
      `only ${observedSources.join(", ") || "no"} sources were read of ${gold.extraction.sourcesUsed.join(", ")}`
    )
  }

  const resolution = {
    customerId: customer.resolution?.customerId ?? null,
    contactEmail: customer.resolution?.contact?.email ?? null,
    locationId: customer.resolution?.location?.id ?? null,
    method: customer.method,
    customerCorrect:
      customer.resolution?.customerId === gold.customer.customerId,
    contactCorrect:
      customer.resolution?.contact?.email === gold.customer.contactEmail,
    locationCorrect:
      customer.resolution?.location?.id === gold.customer.locationId,
  }

  if (!resolution.customerCorrect) {
    notes.push(
      `the run resolved ${resolution.customerId ?? "no customer"} rather than the fixture's account`
    )
  }

  const observedReviewLines = [...reviewedPositions].sort((a, b) => a - b)

  return {
    scenarioId: gold.scenarioId,
    workflowState: state,
    notes,
    extraction: {
      lineCount,
      lineCountInGold: gold.extraction.lineItemCount,
      lineCountCorrect,
      deliveryLocation,
      deliveryLocationCarried,
      sources: observedSources,
      sourcesInGold: [...gold.extraction.sourcesUsed],
      sourcesCovered,
      complete: lineCountCorrect && deliveryLocationCarried && sourcesCovered,
    },
    resolution,
    retrieval: {
      lines: lines.length,
      shortlistHits: lines.filter((line) => line.shortlisted).length,
      shortlistSize: candidates.shortlistSize,
    },
    reranking: {
      lines: lines.length,
      topThreeHits: lines.filter((line) => line.inTopThree).length,
      winnerCorrect: lines.filter((line) => line.matchedSku === line.goldSku)
        .length,
      modelCalls: matches.totals?.modelCalls ?? 0,
    },
    review: {
      occurred: review !== null,
      occursInGold: gold.expectedReviewPositions.length > 0,
      linesInGold: [...gold.expectedReviewPositions],
      linesObserved: observedReviewLines,
      extraLines: observedReviewLines.filter(
        (position) => !gold.expectedReviewPositions.includes(position)
      ),
      missedLines: gold.expectedReviewPositions.filter(
        (position) => !reviewedPositions.has(position)
      ),
      approved,
    },
    pricing: {
      priced: quote !== null,
      lineCount: quote?.lines.length ?? 0,
      subtotalCents: quote?.totals.subtotalCents ?? 0,
      vatRateBp: quote?.totals.vatRateBp ?? 0,
      totalCents: quote?.totals.totalCents ?? 0,
      rules: [
        ...new Set((quote?.lines ?? []).map((line) => line.pricing.rule)),
      ].sort(),
    },
    export: {
      delivered: delivery !== null,
      adapter: delivery?.adapter ?? null,
      hasExternalId: (delivery?.externalEstimateId ?? "").length > 0,
      simulated: delivery?.simulated === true,
    },
    selection: {
      correct: lines.filter((line) => line.finalCorrect).length,
      lines: lines.length,
      quantityCorrect: lines.filter((line) => line.quantityCorrect).length,
      divergedAfterAsking: lines.filter(
        (line) => !line.finalCorrect && line.reviewedByRun
      ).length,
      divergedWithoutAsking: lines.filter(
        (line) => !line.finalCorrect && !line.reviewedByRun
      ).length,
    },
    lines,
    timings: {
      wallClockMs,
      ocrLatencyMs: documents.totals?.providerLatencyMs ?? null,
      extractionLatencyMs: structured.metrics?.latencyMs ?? null,
      rerankLatencyMs: matches.totals?.providerLatencyMs ?? null,
    },
    usage: {
      pagesProcessed: documents.totals?.pagesProcessed ?? null,
      extractionTokens: structured.usage?.totalTokens ?? null,
      rerankTokens: matches.totals?.usage?.totalTokens ?? null,
      estimatedCostUsd: sumCosts([
        documents.totals?.estimatedCostUsd ?? null,
        structured.estimatedCostUsd,
        matches.totals?.estimatedCostUsd ?? null,
      ]),
    },
  }
}

/**
 * The review answer.
 *
 * A proposal is accepted exactly as the run made it; a missing proposal is
 * answered from what the run itself extracted, never from the fixtures. An
 * unanswerable question is recorded rather than guessed.
 */
function decisionFor(
  item: ReviewItemView,
  structured: StructureView,
  notes: string[]
): Record<string, unknown> {
  if (item.kind === "product") {
    if (item.proposal.sku) return { itemId: item.id, action: "accept" }
    if (item.alternatives.length > 0) {
      return {
        itemId: item.id,
        action: "alternative",
        sku: item.alternatives[0].value,
      }
    }

    notes.push(
      `line ${item.position} offered neither a proposal nor an alternative to accept`
    )
    return { itemId: item.id, action: "accept" }
  }

  if (item.kind === "quantity") {
    const extracted = structured.validated?.lineItems.find(
      (line) => line.position === item.position
    )?.quantity

    if (item.proposal.quantity ?? extracted) {
      return {
        itemId: item.id,
        action: "quantity",
        quantity: item.proposal.quantity ?? extracted,
      }
    }

    notes.push(`line ${item.position} asked for a quantity nothing supplied`)
    return { itemId: item.id, action: "accept" }
  }

  if (item.kind === "customer") {
    // Identity the run could not settle is a genuine gap in a curated scenario,
    // and the evaluation refuses to close it with the answer sheet.
    notes.push("the run could not settle the customer without being told")
    return { itemId: item.id, action: "accept" }
  }

  return { itemId: item.id, action: "accept" }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

export function summarize(
  report: Omit<EvaluationReport, "summary">
): ReferenceEvaluationSummary {
  return {
    mode: report.mode,
    providers: report.providers,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      lines: scenario.selection.lines,
      extractionComplete: scenario.extraction.complete,
      customerCorrect: scenario.resolution.customerCorrect,
      shortlistHits: scenario.retrieval.shortlistHits,
      topThreeHits: scenario.reranking.topThreeHits,
      selectionCorrect: scenario.selection.correct,
      quantityCorrect: scenario.selection.quantityCorrect,
      divergedAfterAsking: scenario.selection.divergedAfterAsking,
      divergedWithoutAsking: scenario.selection.divergedWithoutAsking,
      reviewLinesInGold: scenario.review.linesInGold.length,
      reviewLinesObserved: scenario.review.linesObserved.length,
      extraReviewLines: scenario.review.extraLines.length,
      missedReviewLines: scenario.review.missedLines.length,
      priced: scenario.pricing.priced,
      delivered: scenario.export.delivered,
    })),
    totals: {
      scenarios: report.totals.scenarios,
      lines: report.totals.lines,
      extractionComplete: report.totals.extractionComplete,
      customerCorrect: report.totals.customerCorrect,
      shortlistHits: report.totals.shortlistHits,
      topThreeHits: report.totals.topThreeHits,
      selectionCorrect: report.totals.selectionCorrect,
      quantityCorrect: report.totals.quantityCorrect,
      divergedAfterAsking: report.totals.divergedAfterAsking,
      divergedWithoutAsking: report.totals.divergedWithoutAsking,
      reviewLinesInGold: report.totals.reviewLinesInGold,
      reviewLinesObserved: report.totals.reviewLinesObserved,
      extraReviewLines: report.totals.extraReviewLines,
      missedReviewLines: report.totals.missedReviewLines,
      priced: report.totals.priced,
      delivered: report.totals.delivered,
    },
  }
}

function totalsOf(scenarios: ScenarioEvaluation[]): EvaluationReport["totals"] {
  const sum = (read: (scenario: ScenarioEvaluation) => number) =>
    scenarios.reduce((total, scenario) => total + read(scenario), 0)

  return {
    scenarios: scenarios.length,
    lines: sum((scenario) => scenario.selection.lines),
    extractionComplete: sum((scenario) =>
      scenario.extraction.complete ? 1 : 0
    ),
    customerCorrect: sum((scenario) =>
      scenario.resolution.customerCorrect ? 1 : 0
    ),
    shortlistHits: sum((scenario) => scenario.retrieval.shortlistHits),
    topThreeHits: sum((scenario) => scenario.reranking.topThreeHits),
    winnerCorrect: sum((scenario) => scenario.reranking.winnerCorrect),
    selectionCorrect: sum((scenario) => scenario.selection.correct),
    quantityCorrect: sum((scenario) => scenario.selection.quantityCorrect),
    divergedAfterAsking: sum(
      (scenario) => scenario.selection.divergedAfterAsking
    ),
    divergedWithoutAsking: sum(
      (scenario) => scenario.selection.divergedWithoutAsking
    ),
    reviewLinesInGold: sum((scenario) => scenario.review.linesInGold.length),
    reviewLinesObserved: sum(
      (scenario) => scenario.review.linesObserved.length
    ),
    extraReviewLines: sum((scenario) => scenario.review.extraLines.length),
    missedReviewLines: sum((scenario) => scenario.review.missedLines.length),
    priced: sum((scenario) => (scenario.pricing.priced ? 1 : 0)),
    delivered: sum((scenario) => (scenario.export.delivered ? 1 : 0)),
    wallClockMs: sum((scenario) => scenario.timings.wallClockMs),
  }
}

async function readProviders(
  fetcher: EvaluationFetcher
): Promise<EvaluationReport["providers"]> {
  const { system } = await request<{ system: SystemView }>(
    fetcher,
    "/api/system"
  )

  const named = (fragment: string) =>
    system.providers.find((entry) => entry.role.includes(fragment))?.provider ??
    "unknown"

  return {
    ocr: named("Document reading"),
    extraction: named("RFQ structuring"),
    rerank: named("Candidate reranking"),
  }
}

async function waitForRun(
  fetcher: EvaluationFetcher,
  viewId: string,
  accept: string[],
  options: EvaluationOptions
): Promise<string> {
  const attempts = options.pollAttempts ?? 400
  const interval = options.pollIntervalMs ?? 25

  for (let attempt = 0; attempt < attempts; attempt++) {
    const { run } = await request<{ run: RunView }>(
      fetcher,
      `/api/runs/${viewId}`
    )

    if (accept.includes(run.workflowState)) return run.workflowState
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  throw new Error(
    `Run ${viewId} never reached ${accept.join(" or ")} while being evaluated`
  )
}

/** Every step projection is served under one `evidence` key. */
async function read<T>(fetcher: EvaluationFetcher, path: string): Promise<T> {
  const { evidence } = await request<{ evidence: T }>(fetcher, path)

  return evidence
}

async function request<T>(
  fetcher: EvaluationFetcher,
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetcher(path, init)

  if (!response.ok) {
    throw new Error(`${path} answered ${response.status} while being evaluated`)
  }

  return response.json<T>()
}

/**
 * The kind of material a source is, in the fixtures' vocabulary. The run names
 * its own sources by role (`email_body`, `attachment`, `inline_image`); what the
 * fixtures record is the medium, so the media type decides.
 */
function sourceKind(source: { kind: string; mediaType: string }): string {
  if (source.mediaType === "application/pdf") return "pdf"
  if (source.mediaType.startsWith("image/")) return "image"
  if (source.kind === "email_body") return "email"

  return source.kind
}

/** Loose containment: wording may differ, the place must still be there. */
function mentions(value: string | null, hint: string): boolean {
  if (!value) return false

  const normalize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()

  const haystack = normalize(value)
  const words = normalize(hint)
    .split(" ")
    .filter((word) => word.length > 3)

  if (words.length === 0) return haystack.length > 0

  return words.some((word) => haystack.includes(word))
}

function sumCosts(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null)
  if (known.length === 0) return null

  return (
    Math.round(known.reduce((total, value) => total + value, 0) * 1e6) / 1e6
  )
}
