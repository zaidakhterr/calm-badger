/**
 * Contract for bounded catalogue matching.
 *
 * Two kinds of test live here. The retrieval fixtures call the retrieval module
 * against the seeded catalogue directly, because "which candidates come back,
 * in what order" is the behaviour that ticket asks for and it is decidable
 * without a run. Everything else drives the public workflow boundary — create a
 * run, wait for the persisted steps, read the evidence projections — with the
 * deterministic contract fakes pinned in `vitest.config.ts`.
 *
 * No test reaches a live provider. The fake reranker scores the shortlist text
 * it is handed by lexical overlap and knows nothing about the gold fixtures, so
 * the repair, schema, integrity, and heuristic paths below are the real ones.
 */

import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import {
  ensureCatalogIndexes,
  retrieveForLine,
  searchCatalog,
  SHORTLIST_SIZE,
  type LineRetrieval,
} from "../worker/catalog/retrieval"
import {
  applyIntegrityChecks,
  decideMatch,
  readMatchHeuristics,
  RERANK_INSTRUCTION,
  validateRerankOutput,
  type MatchAlternative,
} from "../worker/product-matching"
import { selectRerankProvider } from "../worker/providers/rerank"
import { SCENARIOS } from "../worker/scenarios"

const base = "https://example.test"

function envWith(overrides: Record<string, string>): Env {
  return { ...env, ...overrides }
}

type RunStep = {
  key: string
  status: string
  summary: string
  startedAt: string | null
  completedAt: string | null
}

type Run = {
  viewId: string
  status: string
  workflowState: string
  steps: RunStep[]
}

type CandidateEvidence = {
  stepKey: string
  state: string
  method: string | null
  shortlistSize: number
  customerScoped: boolean
  catalog: {
    activeProducts: number
    totalProducts: number
    archivedExcluded: number
  } | null
  lines: {
    position: number
    reference: string
    query: string
    state: string
    supersededSku: string | null
    note: string
    candidates: {
      rank: number
      sku: string
      name: string
      source: string
      score: number
      evidence: string
      nearDuplicateOf: string | null
    }[]
  }[]
  totals: {
    lineCount: number
    exactCount: number
    retrievedCount: number
    candidateCount: number
    elapsedMs: number
  } | null
}

type MatchEvidence = {
  stepKey: string
  state: string
  message: string | null
  provider: string | null
  model: string | null
  heuristics: { winnerStrength: number; winnerGap: number; note: string } | null
  lines: {
    position: number
    reference: string
    state: string
    sku: string | null
    productName: string | null
    method: string
    decisionEvidence: string
    confidence: { label: string; score: number; heuristic: string } | null
    winnerScore: number
    winnerGap: number
    alternatives: MatchAlternative[]
    rejected: { sku: string; reason: string }[]
    shortlistSize: number
    repaired: boolean
    issues: string[]
    originalOutput: string | null
    latencyMs: number | null
    usage: { totalTokens: number } | null
  }[]
  totals: {
    lineCount: number
    acceptedCount: number
    reviewCount: number
    deterministicCount: number
    rerankedCount: number
    modelCalls: number
    providerLatencyMs: number
    usage: { totalTokens: number } | null
    estimatedCostUsd: number | null
    elapsedMs: number
  } | null
}

async function createCuratedRun(scenarioId: string) {
  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  })

  expect(response.status).toBe(201)
  return response.json<{ run: Run; ownerCapability: string }>()
}

async function createCustomRun(emailBody: string) {
  const form = new FormData()
  form.set("emailBody", emailBody)

  const response = await exports.default.fetch(`${base}/api/runs`, {
    method: "POST",
    body: form,
  })

  expect(response.status).toBe(201)
  return response.json<{ run: Run }>()
}

async function waitForStep(
  viewId: string,
  stepKey: string,
  statuses: string[]
): Promise<RunStep> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await exports.default.fetch(`${base}/api/runs/${viewId}`)
    const { run } = await response.json<{ run: Run }>()
    const step = run.steps.find((candidate) => candidate.key === stepKey)!

    if (statuses.includes(step.status)) return step

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Step ${stepKey} never reached ${statuses.join(" or ")}`)
}

async function readCandidates(viewId: string): Promise<CandidateEvidence> {
  const response = await exports.default.fetch(
    `${base}/api/runs/${viewId}/candidates`
  )

  expect(response.status).toBe(200)
  return (await response.json<{ evidence: CandidateEvidence }>()).evidence
}

async function readMatches(viewId: string): Promise<MatchEvidence> {
  const response = await exports.default.fetch(
    `${base}/api/runs/${viewId}/matches`
  )

  expect(response.status).toBe(200)
  return (await response.json<{ evidence: MatchEvidence }>()).evidence
}

async function readRun(viewId: string): Promise<Run> {
  const response = await exports.default.fetch(`${base}/api/runs/${viewId}`)
  return (await response.json<{ run: Run }>()).run
}

async function runIdOf(viewId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM runs WHERE view_id = ?`)
    .bind(viewId)
    .first<{ id: string }>()

  return row!.id
}

function retrieve(
  reference: string,
  options: {
    description?: string
    catalogSku?: string
    customerId?: string
  } = {}
): Promise<LineRetrieval> {
  return retrieveForLine(
    env,
    {
      reference,
      description: options.description ?? reference,
      catalogSku: options.catalogSku ?? null,
    },
    options.customerId ?? null
  )
}

function skusOf(retrieval: LineRetrieval): string[] {
  return retrieval.state === "exact"
    ? [retrieval.candidate.sku]
    : retrieval.shortlist.map((candidate) => candidate.sku)
}

/* -------------------------------------------------------------------------- */

describe("retrieval ranking fixtures", () => {
  it("settles a printed article number without any shortlist", async () => {
    const result = await retrieve("NX-FLT-1120", { catalogSku: "NX-FLT-1120" })

    expect(result.state).toBe("exact")
    if (result.state !== "exact") return
    expect(result.candidate.sku).toBe("NX-FLT-1120")
    expect(result.candidate.source).toBe("exact_sku")
    expect(result.candidate.evidence).toContain("NX-FLT-1120")
  })

  it("settles wording the catalogue records as a product name", async () => {
    const result = await retrieve("EP2 grease cartridge 400g")

    expect(result.state).toBe("exact")
    if (result.state !== "exact") return
    expect(result.candidate.sku).toBe("NX-LUB-3040")
    expect(result.candidate.source).toBe("known_alias")
  })

  it("uses customer wording only for the customer it belongs to", async () => {
    const owned = await retrieve("standard depot filter", {
      customerId: "CUST-1001",
    })

    expect(owned.state).toBe("exact")
    if (owned.state !== "exact") return
    expect(owned.candidate.sku).toBe("NX-FLT-1120")
    expect(owned.candidate.source).toBe("customer_alias")

    // An unresolved run, and a different customer, simply never see it.
    for (const customerId of [undefined, "CUST-1002"]) {
      const other = await retrieve("standard depot filter", { customerId })
      expect(other.state).not.toBe("exact")
    }
  })

  it("keeps two customers' identical wording apart in the alias index", async () => {
    // What an approved review correction will write in the next ticket: two
    // workspaces teaching the same phrase for the same product. Neither may
    // overwrite the other, and neither may leak to anyone else.
    const phrase = "the usual depot panel"

    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO catalog_product_aliases
             (sku, alias, alias_kind, customer_id) VALUES (?, ?, 'customer', ?)`
        ).bind("NX-FLT-1120", phrase, "CUST-1001"),
        env.DB.prepare(
          `INSERT OR IGNORE INTO catalog_product_aliases
             (sku, alias, alias_kind, customer_id) VALUES (?, ?, 'customer', ?)`
        ).bind("NX-FLT-1120", phrase, "CUST-1002"),
      ])

      await ensureCatalogIndexes(env)

      const stored = await env.DB.prepare(
        `SELECT customer_id FROM catalog_alias_lookup
          WHERE normalised = ? ORDER BY customer_id ASC`
      )
        .bind(phrase)
        .all<{ customer_id: string | null }>()

      expect(stored.results.map((row) => row.customer_id)).toEqual([
        "CUST-1001",
        "CUST-1002",
      ])

      for (const customerId of ["CUST-1001", "CUST-1002"]) {
        const owned = await retrieve(phrase, { customerId })

        expect(owned.state).toBe("exact")
        if (owned.state !== "exact") return
        expect(owned.candidate.sku).toBe("NX-FLT-1120")
        expect(owned.candidate.source).toBe("customer_alias")
      }

      // A run that resolved to nobody, and a third customer, never see it.
      for (const customerId of [undefined, "CUST-1003"]) {
        expect((await retrieve(phrase, { customerId })).state).not.toBe("exact")
      }
    } finally {
      // The catalogue is shared by every fixture in this file, so the two
      // added phrases are removed and the indexes rebuilt from it again.
      await env.DB.prepare(
        `DELETE FROM catalog_product_aliases WHERE alias = ?`
      )
        .bind(phrase)
        .run()

      await ensureCatalogIndexes(env)
    }
  })

  it("retrieves a misspelling without accepting it outright", async () => {
    const result = await retrieve("pleeted panel filter 592x592")

    expect(result.state).toBe("retrieved")
    if (result.state !== "retrieved") return
    expect(result.shortlist[0].sku).toBe("NX-FLT-1120")
    expect(result.shortlist[0].source).toBe("typo_alias")
    expect(result.shortlist[0].evidence).toContain("misspelling")
  })

  it("finds a synonym through full-text retrieval", async () => {
    const result = await retrieve("nitrile safety glove size 9 knitted")

    expect(skusOf(result)).toContain("NX-SFT-2210")
  })

  it("keeps near duplicates in a meaningful order", async () => {
    const result = await retrieve("panel filter 592 x 592 x 48 ISO Coarse")
    const shortlist = skusOf(result)

    expect(shortlist).toContain("NX-FLT-1120")
    expect(shortlist).toContain("NX-FLT-1121")
    // The requested dimensions decide which of the pair leads.
    expect(shortlist.indexOf("NX-FLT-1120")).toBeLessThan(
      shortlist.indexOf("NX-FLT-1121")
    )
  })

  it("never returns an archived product, and offers its successor instead", async () => {
    const printed = await retrieve("seal kit", { catalogSku: "NX-PMP-8130" })

    expect(printed.state).toBe("superseded")
    if (printed.state !== "superseded") return
    expect(printed.supersededSku).toBe("NX-PMP-8130")
    expect(printed.candidate?.sku).toBe("NX-PMP-8140")
    expect(printed.candidate?.source).toBe("archived_successor")
    expect(skusOf(printed)).not.toContain("NX-PMP-8130")
  })

  it("recognises a superseded number quoted inside a longer phrase", async () => {
    const result = await retrieve("old item nr 45-221-B (pump seal)")

    expect(result.state).toBe("superseded")
    if (result.state !== "superseded") return
    expect(result.supersededSku).toBe("NX-PMP-8130")
    expect(result.candidate?.sku).toBe("NX-PMP-8140")
  })

  it("bounds every shortlist to eight active catalogue products", async () => {
    for (const phrase of [
      "ball valve brass lever handle DN25",
      "cutting disc stainless steel box",
      "hydraulic hose assembly DKOL fittings",
      "grease",
    ]) {
      const result = await retrieve(phrase)
      const shortlist = skusOf(result)

      expect(shortlist.length).toBeLessThanOrEqual(SHORTLIST_SIZE)
      expect(new Set(shortlist).size).toBe(shortlist.length)

      const statuses = await statusesOf(shortlist)
      expect(statuses).toEqual(shortlist.map(() => "active"))
    }
  })

  it("searches the complete active catalogue, not a subset", async () => {
    await ensureCatalogIndexes(env)

    const indexed = await env.DB.prepare(
      `SELECT indexed_products FROM catalog_search_state WHERE id = 1`
    ).first<{ indexed_products: number }>()

    const active = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM catalog_products WHERE status = 'active'`
    ).first<{ total: number }>()

    expect(indexed!.indexed_products).toBe(active!.total)
    expect(active!.total).toBeGreaterThan(200)
  })

  it("rebuilds the index deterministically rather than drifting", async () => {
    await ensureCatalogIndexes(env)
    const before = await searchCatalog(env, "pleated panel air filter", 5)

    // A dropped index is rebuilt from the catalogue on the next retrieval.
    await env.DB.prepare(`DELETE FROM catalog_search`).run()
    await env.DB.prepare(`DELETE FROM catalog_search_state`).run()

    const after = await searchCatalog(env, "pleated panel air filter", 5)

    expect(after.map((entry) => entry.sku)).toEqual(
      before.map((entry) => entry.sku)
    )
  })

  it("cannot be steered by query syntax in a request", async () => {
    // Every token is quoted before it reaches FTS5, so this reads as words.
    const result = await retrieve('flange gasket" OR sku:* NEAR/9 --')
    const shortlist = skusOf(result)

    expect(shortlist).toContain("NX-SEA-9120")
    expect(shortlist.length).toBeLessThanOrEqual(SHORTLIST_SIZE)
  })
})

describe("matching a curated request", () => {
  it("accepts every article number of the routine request without a model", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    const step = await waitForStep(run.viewId, "match-products", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("complete")

    const candidates = await readCandidates(run.viewId)
    const matches = await readMatches(run.viewId)

    expect(candidates.totals!.exactCount).toBe(6)
    expect(matches.totals!.acceptedCount).toBe(6)
    expect(matches.totals!.modelCalls).toBe(0)
    expect(matches.totals!.usage).toBeNull()

    for (const line of matches.lines) {
      expect(line.method).toBe("exact_sku")
      expect(line.confidence!.label).toBe("High")
      expect(line.originalOutput).toBeNull()
      expect(line.decisionEvidence).toContain("article number")
    }
  })

  it("separates exact evidence, reranking, and superseded numbers", async () => {
    const { run } = await createCuratedRun("messy-forwarded-request")
    await waitForStep(run.viewId, "match-products", ["complete", "error"])

    const candidates = await readCandidates(run.viewId)
    const matches = await readMatches(run.viewId)

    const alias = matches.lines.find((line) => line.method === "known_alias")!
    expect(alias.state).toBe("accepted")
    expect(alias.sku).toBe("NX-LUB-3040")

    const superseded = matches.lines.find(
      (line) => line.method === "superseded"
    )!
    expect(superseded.state).toBe("review_required")
    expect(superseded.sku).toBe("NX-PMP-8140")
    expect(superseded.decisionEvidence).toContain("archived")

    const reranked = matches.lines.filter((line) => line.method === "rerank")
    expect(reranked.length).toBeGreaterThan(0)
    expect(matches.totals!.modelCalls).toBe(reranked.length)
    expect(matches.totals!.usage!.totalTokens).toBeGreaterThan(0)

    // A retrieved line is only ever asked about a bounded shortlist.
    for (const line of candidates.lines) {
      expect(line.candidates.length).toBeLessThanOrEqual(SHORTLIST_SIZE)
    }
  })

  it("sends two equally good near duplicates to review rather than guessing", async () => {
    const { run } = await createCuratedRun("messy-forwarded-request")
    await waitForStep(run.viewId, "match-products", ["complete", "error"])

    const matches = await readMatches(run.viewId)
    const gasket = matches.lines.find((line) =>
      line.reference.toLowerCase().includes("gasket")
    )!

    expect(gasket.state).toBe("review_required")
    expect(gasket.winnerGap).toBeLessThan(0.12)
    expect(gasket.alternatives.map((entry) => entry.sku)).toEqual(
      expect.arrayContaining(["NX-SEA-9120", "NX-SEA-9121"])
    )
    expect(gasket.confidence!.label).toBe("Review")
    expect(gasket.confidence!.heuristic).toContain("demo heuristic")
  })

  it("uses the stated detail to separate near duplicates when it can", async () => {
    const { run } = await createCuratedRun("ambiguous-replacement-parts")
    await waitForStep(run.viewId, "match-products", ["complete", "error"])

    const matches = await readMatches(run.viewId)
    const thickness = matches.lines.find((line) =>
      line.reference.toLowerCase().includes("gasket")
    )!

    expect(thickness.state).toBe("accepted")
    expect(thickness.sku).toBe("NX-SEA-9121")
    expect(thickness.winnerGap).toBeGreaterThanOrEqual(0.12)

    const bearing = matches.lines.find((line) =>
      line.reference.toLowerCase().includes("6205")
    )!
    expect(bearing.state).toBe("review_required")
    expect(bearing.sku).toBe("NX-BRG-3311")
  })

  it("persists the two steps as distinct graph states", async () => {
    const { run } = await createCuratedRun("messy-forwarded-request")
    await waitForStep(run.viewId, "match-products", ["complete", "error"])

    const settled = await readRun(run.viewId)
    const retrieveStep = settled.steps.find(
      (step) => step.key === "retrieve-candidates"
    )!
    const matchStep = settled.steps.find(
      (step) => step.key === "match-products"
    )!

    expect(retrieveStep.status).toBe("complete")
    expect(matchStep.status).toBe("complete")
    expect(retrieveStep.summary).toContain("Retrieved")
    expect(retrieveStep.summary).toContain("settled by exact evidence")
    expect(matchStep.summary).toContain("Matched")
    expect(retrieveStep.summary).not.toBe(matchStep.summary)

    for (const step of [retrieveStep, matchStep]) {
      expect(step.startedAt).not.toBeNull()
      expect(step.completedAt).not.toBeNull()
    }

    // This request has lines a human still has to decide, so the run stops
    // before pricing rather than quoting an unreviewed match.
    expect(settled.workflowState).toBe("awaiting_review")

    const stored = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM run_line_candidates WHERE run_id = ?1) AS candidates,
         (SELECT COUNT(*) FROM run_line_matches WHERE run_id = ?1) AS matches`
    )
      .bind(await runIdOf(run.viewId))
      .first<{ candidates: number; matches: number }>()

    expect(stored!.matches).toBe(6)
    expect(stored!.candidates).toBeGreaterThan(6)
  })

  it("gives a shared viewer the same evidence as the owner", async () => {
    const { run } = await createCuratedRun("routine-replenishment")
    await waitForStep(run.viewId, "match-products", ["complete", "error"])

    for (const segment of ["candidates", "matches"]) {
      const owned = await exports.default.fetch(
        `${base}/api/runs/${run.viewId}/${segment}`
      )
      const shared = await exports.default.fetch(
        `${base}/api/runs/${run.viewId}/${segment}`,
        { headers: { authorization: "Bearer not-the-owner" } }
      )

      expect(await owned.text()).toBe(await shared.text())
    }
  })
})

describe("an unresolved customer", () => {
  it("still retrieves and matches, without that customer's wording", async () => {
    const { run } = await createCustomRun(
      [
        "From: someone@unknown-buyer.example",
        "",
        "Please quote 12 brass ball valve DN25 with lever handle.",
      ].join("\n")
    )

    const step = await waitForStep(run.viewId, "match-products", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("complete")

    const candidates = await readCandidates(run.viewId)
    expect(candidates.customerScoped).toBe(false)
    expect(candidates.lines.length).toBeGreaterThan(0)

    const matches = await readMatches(run.viewId)
    expect(matches.lines.length).toBe(candidates.lines.length)

    // The run is not finished and not failed: it simply has no active step
    // until the review node exists.
    const settled = await readRun(run.viewId)
    expect(settled.status).toBe("active")
    expect(
      settled.steps.filter((step) => step.status === "active")
    ).toHaveLength(0)
  })
})

describe("model output that has to be validated", () => {
  it("never lets an invented product reach a match", async () => {
    const { run } = await createCustomRun(
      "Please quote 6 trigger-rerank-invented-sku brass ball valve DN25."
    )

    await waitForStep(run.viewId, "match-products", ["complete", "error"])

    const matches = await readMatches(run.viewId)
    const line = matches.lines[0]

    expect(line.rejected.map((entry) => entry.sku)).toContain("NX-ZZZ-9999")
    expect(line.rejected[0].reason).toContain("not one of the candidates")
    expect(line.sku).not.toBe("NX-ZZZ-9999")
    expect(line.alternatives.map((entry) => entry.sku)).not.toContain(
      "NX-ZZZ-9999"
    )
    expect(line.decisionEvidence).toContain("discarded before pricing")

    const stored = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM run_line_matches
        WHERE run_id = ? AND sku = 'NX-ZZZ-9999'`
    )
      .bind(await runIdOf(run.viewId))
      .first<{ total: number }>()

    expect(stored!.total).toBe(0)
  })

  it("sends a line to review when the ranking cannot be read", async () => {
    const { run } = await createCustomRun(
      "Please quote 6 trigger-rerank-unparsable brass ball valve DN25."
    )

    const step = await waitForStep(run.viewId, "match-products", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("complete")

    const line = (await readMatches(run.viewId)).lines[0]

    expect(line.state).toBe("review_required")
    expect(line.sku).toBeNull()
    expect(line.decisionEvidence).toContain("One repair attempt was made")
    expect(line.originalOutput).not.toBeNull()
  })

  it("accepts a ranking that one repair attempt can rescue", async () => {
    const { run } = await createCustomRun(
      "Please quote 6 trigger-rerank-repairable brass ball valve DN25."
    )

    await waitForStep(run.viewId, "match-products", ["complete", "error"])

    const line = (await readMatches(run.viewId)).lines[0]

    expect(line.repaired).toBe(true)
    expect(line.alternatives.length).toBeGreaterThan(0)
    expect(line.originalOutput).toContain("```json")
  })

  it("stops the run when the reranking provider itself fails", async () => {
    const { run } = await createCustomRun(
      "Please quote 6 trigger-rerank-error brass ball valve DN25."
    )

    const step = await waitForStep(run.viewId, "match-products", [
      "complete",
      "error",
    ])

    expect(step.status).toBe("error")
    expect(step.summary).toContain("reranking model")

    const stopped = await readRun(run.viewId)
    expect(stopped.status).toBe("error")
    expect(
      stopped.steps.filter((entry) => entry.status === "active")
    ).toHaveLength(0)

    const evidence = await readMatches(run.viewId)
    expect(evidence.state).toBe("error")
    expect(JSON.stringify(evidence)).not.toContain("Bearer")
    expect(JSON.stringify(evidence)).not.toContain("openrouter.ai")
  })

  it("refuses to build the contract fake in production", () => {
    expect(() =>
      selectRerankProvider(
        envWith({ RERANK_PROVIDER: "contract-fake", APP_ENV: "production" })
      )
    ).toThrow(/not allowed in production/)

    expect(
      selectRerankProvider(
        envWith({ RERANK_PROVIDER: "contract-fake", APP_ENV: "test" })
      ).name
    ).toBe("contract-fake")
  })
})

describe("the acceptance heuristics", () => {
  const winner: MatchAlternative = {
    sku: "NX-FLT-1120",
    name: "Pleated panel air filter",
    score: 0.9,
    reason: "Dimensions agree.",
    nearDuplicateOf: null,
  }

  const runnerUp: MatchAlternative = {
    sku: "NX-FLT-1121",
    name: "Pleated panel air filter, half size",
    score: 0.86,
    reason: "Half the height.",
    nearDuplicateOf: "NX-FLT-1120",
  }

  const heuristics = { winnerStrength: 0.55, winnerGap: 0.12 }

  it("accepts a strong winner that is clear of the runner-up", () => {
    const decision = decideMatch(
      [winner, { ...runnerUp, score: 0.4 }],
      heuristics
    )

    expect(decision.state).toBe("accepted")
    expect(decision.sku).toBe("NX-FLT-1120")
    expect(decision.confidence.label).toBe("High")
    expect(decision.confidence.heuristic).toContain("demo heuristic")
  })

  it("reviews a winner the runner-up is too close to", () => {
    const decision = decideMatch([winner, runnerUp], heuristics)

    expect(decision.state).toBe("review_required")
    expect(decision.confidence.label).toBe("Review")
    expect(decision.reason).toContain("too close to accept")
    // The proposal survives for the reviewer to confirm or correct.
    expect(decision.sku).toBe("NX-FLT-1120")
  })

  it("reviews a winner that is not convincing on its own", () => {
    const decision = decideMatch(
      [
        { ...winner, score: 0.4 },
        { ...runnerUp, score: 0.1 },
      ],
      heuristics
    )

    expect(decision.state).toBe("review_required")
    expect(decision.reason).toContain("only scores")
  })

  it("returns at most three alternatives", () => {
    const decision = decideMatch(
      Array.from({ length: 8 }, (_, index) => ({
        ...winner,
        sku: `NX-TST-${1000 + index}`,
        score: 0.9 - index * 0.1,
      })),
      heuristics
    )

    expect(decision.topThree).toHaveLength(3)
  })

  it("reads both thresholds from configuration and ignores nonsense", () => {
    expect(readMatchHeuristics(env)).toEqual({
      winnerStrength: 0.55,
      winnerGap: 0.12,
    })

    expect(
      readMatchHeuristics(
        envWith({ MATCH_WINNER_STRENGTH: "0.9", MATCH_WINNER_GAP: "0.3" })
      )
    ).toEqual({ winnerStrength: 0.9, winnerGap: 0.3 })

    expect(
      readMatchHeuristics(
        envWith({ MATCH_WINNER_STRENGTH: "strict", MATCH_WINNER_GAP: "-2" })
      )
    ).toEqual({ winnerStrength: 0.55, winnerGap: 0.12 })

    // A stricter configuration turns the same ranking into a review.
    expect(
      decideMatch([winner, { ...runnerUp, score: 0.4 }], {
        winnerStrength: 0.95,
        winnerGap: 0.12,
      }).state
    ).toBe("review_required")
  })
})

describe("integrity in isolation", () => {
  const active = new Map([
    [
      "NX-FLT-1120",
      { name: "Pleated panel air filter", nearDuplicateOf: null },
    ],
    [
      "NX-FLT-1121",
      {
        name: "Pleated panel air filter, half size",
        nearDuplicateOf: "NX-FLT-1120",
      },
    ],
  ])

  it("keeps only products that were offered and still exist", () => {
    const outcome = applyIntegrityChecks(
      [
        { sku: "NX-ZZZ-9999", score: 0.99, reason: "Invented." },
        { sku: "NX-FLT-1120", score: 0.8, reason: "Dimensions agree." },
        { sku: "NX-PMP-8130", score: 0.7, reason: "Archived." },
        { sku: "NX-FLT-1120", score: 0.1, reason: "Duplicate entry." },
      ],
      ["NX-FLT-1120", "NX-FLT-1121", "NX-PMP-8130"],
      active
    )

    expect(outcome.kept.map((entry) => entry.sku)).toEqual(["NX-FLT-1120"])
    expect(outcome.rejected).toEqual([
      {
        sku: "NX-ZZZ-9999",
        reason: "It was not one of the candidates sent for ranking.",
      },
      {
        sku: "NX-PMP-8130",
        reason: "It is not an active product in the catalogue.",
      },
    ])
  })

  it("reports schema failures by path and rule only", () => {
    const checked = validateRerankOutput({ ranked: "the first one" })

    expect(checked.state).toBe("invalid")
    if (checked.state !== "invalid") return
    expect(checked.issues.join(" ")).toContain("ranked")
    expect(checked.issues.join(" ")).not.toContain("the first one")
  })
})

describe("what leaves the system", () => {
  it("keeps secrets, prompts, and expected-outcome copy out of the evidence", async () => {
    const { run } = await createCuratedRun("messy-forwarded-request")
    await waitForStep(run.viewId, "match-products", ["complete", "error"])

    const serialized = JSON.stringify([
      await readCandidates(run.viewId),
      await readMatches(run.viewId),
    ])

    for (const forbidden of [
      "authorization",
      "Bearer",
      "openrouter.ai",
      "api.mistral.ai",
      "apiKey",
      "capability",
      "storageKey",
      "You rank supplier catalogue products",
    ]) {
      expect(serialized).not.toContain(forbidden)
    }

    for (const scenario of SCENARIOS) {
      for (const item of scenario.requestedItems) {
        expect(serialized).not.toContain(item.note)
      }
    }
  })

  it("never sends the scenario's expected-outcome copy to the reranker", async () => {
    const { run } = await createCuratedRun("messy-forwarded-request")
    await waitForStep(run.viewId, "match-products", ["complete", "error"])

    const runId = await runIdOf(run.viewId)

    // Everything the reranker receives is the instruction, the line as the
    // request wrote it, and the catalogue text of the shortlisted products.
    const lines = await env.DB.prepare(
      `SELECT reference, description FROM run_rfq_line_items WHERE run_id = ?`
    )
      .bind(runId)
      .all<{ reference: string; description: string }>()

    const catalog = await env.DB.prepare(
      `SELECT p.name AS name, p.description AS description,
              COALESCE((SELECT group_concat(a.alias, ' ') FROM catalog_product_aliases a
                         WHERE a.sku = p.sku AND a.customer_id IS NULL), '') AS aliases
         FROM run_line_candidates c
         JOIN catalog_products p ON p.sku = c.sku
        WHERE c.run_id = ?`
    )
      .bind(runId)
      .all<{ name: string; description: string; aliases: string }>()

    const outbound = [
      RERANK_INSTRUCTION,
      ...lines.results.flatMap((line) => [line.reference, line.description]),
      ...catalog.results.flatMap((product) => [
        product.name,
        product.description,
        product.aliases,
      ]),
    ].join("\n")

    for (const scenario of SCENARIOS) {
      for (const item of scenario.requestedItems) {
        expect(outbound).not.toContain(item.note)
      }
    }
  })

  it("removes candidates and matches when the run is reset", async () => {
    const { run, ownerCapability } = await createCuratedRun(
      "routine-replenishment"
    )

    await waitForStep(run.viewId, "match-products", ["complete", "error"])
    const runId = await runIdOf(run.viewId)

    const reset = await exports.default.fetch(
      `${base}/api/runs/${run.viewId}/reset`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ownerCapability}` },
      }
    )
    expect(reset.status).toBe(200)

    const remaining = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM run_line_candidates WHERE run_id = ?1) AS candidates,
         (SELECT COUNT(*) FROM run_line_matches WHERE run_id = ?1) AS matches`
    )
      .bind(runId)
      .first<{ candidates: number; matches: number }>()

    expect(remaining).toEqual({ candidates: 0, matches: 0 })
  })
})

async function statusesOf(skus: string[]): Promise<string[]> {
  if (skus.length === 0) return []

  const placeholders = skus.map(() => "?").join(", ")
  const rows = await env.DB.prepare(
    `SELECT sku, status FROM catalog_products WHERE sku IN (${placeholders})`
  )
    .bind(...skus)
    .all<{ sku: string; status: string }>()

  const statuses = new Map(rows.results.map((row) => [row.sku, row.status]))
  return skus.map((sku) => statuses.get(sku) ?? "missing")
}
