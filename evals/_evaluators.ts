import type { Catalog } from "../worker/catalog/dataset"
import {
  contactFingerprint,
  type ExpectedOutput,
  type RunProjection,
  type ScenarioInput,
} from "./_contracts"

/** Ignore presentation differences; added wording must start or end on a token. */
export function sameReference(value: string | null, expected: string): boolean {
  if (value === null) return false
  const normalize = (text: string) =>
    text
      .normalize("NFKC")
      .toLocaleLowerCase("en")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  const observed = normalize(value)
  const source = normalize(expected)
  return (
    observed === source ||
    observed.startsWith(`${source} `) ||
    observed.endsWith(` ${source}`) ||
    observed.includes(` ${source} `)
  )
}
function mentions(value: string | null, hint: string): boolean {
  if (!value) return false
  const normalize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  const words = normalize(hint)
    .split(" ")
    .filter((word) => word.length > 3)
  return words.length === 0
    ? normalize(value).length > 0
    : words.some((word) => normalize(value).includes(word))
}

/** Catalog consistency checks formerly asserted against the committed answer fixture. */
export function evaluateCatalog(
  expected: ExpectedOutput,
  input: ScenarioInput,
  catalog: Catalog
) {
  const customer = catalog.customers.find(
    (entry) => entry.id === expected.customerId
  )
  const product = (sku: string) =>
    catalog.products.find((entry) => entry.sku === sku)
  const aliases = catalog.products.flatMap((entry) =>
    entry.aliases.map((alias) => ({ sku: entry.sku, ...alias }))
  )
  const basisSupported = expected.lines.filter((line) => {
    if (line.basis === "sku") return line.sourceReference === line.expectedSku
    const reference = line.sourceReference.toLowerCase()
    if (line.basis === "alias" || line.basis === "typo_alias")
      return aliases.some(
        (alias) =>
          alias.sku === line.expectedSku &&
          (reference.includes(alias.alias.toLowerCase()) ||
            alias.alias.toLowerCase().includes(reference))
      )
    if (line.basis === "legacy_alias") {
      const legacy = aliases.find(
        (alias) =>
          alias.kind === "legacy" &&
          reference.includes(alias.alias.toLowerCase())
      )
      const archived = legacy ? product(legacy.sku) : undefined
      return (
        archived?.status === "archived" &&
        archived.replacementSku === line.expectedSku &&
        line.alternatives.includes(archived.sku)
      )
    }
    return true
  }).length
  const reviewLines = expected.lines.filter(
    (line) => line.decision === "review"
  )
  return {
    expectedCustomerExists: Number(!!customer),
    expectedContactExists: Number(
      customer?.contacts.some(
        (contact) => contact.email === expected.contactEmail
      ) ?? false
    ),
    expectedLocationExists: Number(
      customer?.locations.some(
        (location) => location.id === expected.locationId
      ) ?? false
    ),
    expectedSkusExist: expected.lines.filter(
      (line) => !!product(line.expectedSku)
    ).length,
    expectedSkusActive: expected.lines.filter(
      (line) => product(line.expectedSku)?.status === "active"
    ).length,
    alternativesExist: Number(
      expected.lines.every((line) =>
        line.alternatives.every((sku) => !!product(sku))
      )
    ),
    basisSupported,
    reviewDecisionsConsistent: Number(
      reviewLines.length === expected.expectedReviewPositions.length &&
        reviewLines.every((line) =>
          expected.expectedReviewPositions.includes(line.position)
        )
    ),
    reviewAmbiguitySupported: Number(
      reviewLines.every((line) =>
        line.alternatives.some((sku) => {
          const alternative = product(sku)
          return (
            alternative !== undefined &&
            (alternative.status === "archived" ||
              alternative.nearDuplicateOf === line.expectedSku ||
              product(line.expectedSku)?.nearDuplicateOf === sku)
          )
        })
      )
    ),
    scenarioSourcesPresent: Number(input.sources.length > 0),
  }
}

export async function evaluateRun(
  input: ScenarioInput,
  expected: ExpectedOutput,
  output: RunProjection,
  catalog: Catalog
) {
  const reviewed = new Set(
    output.review?.items
      .filter((item) => item.kind === "product")
      .map((item) => item.position) ?? []
  )
  const lines = expected.lines.map((line) => {
    const matched = output.matches.lines.find(
      (entry) => entry.position === line.position
    )
    const structured = output.structure.validated?.lineItems.find(
      (entry) => entry.position === line.position
    )
    const quoted = output.quote?.lines.find(
      (entry) => entry.position === line.position
    )
    const topThree = [
      ...(matched?.sku ? [matched.sku] : []),
      ...(matched?.alternatives.map((entry) => entry.sku) ?? []),
    ].slice(0, 3)
    const finalCorrect = quoted?.sku === line.expectedSku
    return {
      referenceCorrect: sameReference(
        structured?.reference ?? matched?.reference ?? null,
        line.sourceReference
      ),
      shortlisted:
        output.candidates.lines
          .find((entry) => entry.position === line.position)
          ?.candidates.some((entry) => entry.sku === line.expectedSku) ===
          true || matched?.sku === line.expectedSku,
      inTopThree: topThree.includes(line.expectedSku),
      winnerCorrect: matched?.sku === line.expectedSku,
      finalCorrect,
      quantityCorrect: quoted?.quantity === line.quantity,
      // A missing quote line is not an answered divergence, even when review occurred.
      divergedAfterAsking:
        !finalCorrect && !!quoted && reviewed.has(line.position),
      divergedWithoutAsking: !finalCorrect && !reviewed.has(line.position),
    }
  })
  const count = (test: (line: (typeof lines)[number]) => boolean) =>
    lines.filter(test).length
  const lineCountCorrect =
    output.structure.validated?.lineItems.length === expected.lines.length
  const location = catalog.customers
    .find((entry) => entry.id === expected.customerId)
    ?.locations.find((entry) => entry.id === expected.locationId)
  const deliveryLocationCarried =
    !!location &&
    mentions(
      output.structure.validated?.customer.deliveryLocation ?? null,
      `${location.label}, ${location.city}`
    )
  const sourcesCovered = input.sources.every((label) =>
    output.sources.includes(label)
  )
  const referencesCorrect = count((line) => line.referenceCorrect)
  const scores = {
    lines: expected.lines.length,
    lineCount: output.structure.validated?.lineItems.length ?? 0,
    lineCountCorrect: Number(lineCountCorrect),
    deliveryLocationCarried: Number(deliveryLocationCarried),
    sourcesCovered: Number(sourcesCovered),
    referencesCorrect,
    extractionComplete: Number(
      lineCountCorrect &&
        deliveryLocationCarried &&
        sourcesCovered &&
        referencesCorrect === expected.lines.length
    ),
    customerCorrect: Number(output.customer.customerId === expected.customerId),
    contactCorrect: Number(
      output.customer.contactFingerprint ===
        (await contactFingerprint(expected.contactEmail))
    ),
    locationCorrect: Number(output.customer.locationId === expected.locationId),
    shortlistHits: count((line) => line.shortlisted),
    topThreeHits: count((line) => line.inTopThree),
    winnerCorrect: count((line) => line.winnerCorrect),
    selectionCorrect: count((line) => line.finalCorrect),
    quantityCorrect: count((line) => line.quantityCorrect),
    divergedAfterAsking: count((line) => line.divergedAfterAsking),
    divergedWithoutAsking: count((line) => line.divergedWithoutAsking),
    reviewOccurred: Number(output.review !== null),
    reviewExpected: Number(expected.expectedReviewPositions.length > 0),
    reviewApproved: Number(output.approved),
    reviewLinesInGold: expected.expectedReviewPositions.length,
    reviewLinesObserved: reviewed.size,
    extraReviewLines: [...reviewed].filter(
      (position) => !expected.expectedReviewPositions.includes(position)
    ).length,
    missedReviewLines: expected.expectedReviewPositions.filter(
      (position) => !reviewed.has(position)
    ).length,
    reviewPositionsCorrect: Number(
      reviewed.size === expected.expectedReviewPositions.length &&
        expected.expectedReviewPositions.every((position) =>
          reviewed.has(position)
        )
    ),
    priced: Number(output.quote !== null),
    pricedLines: output.quote?.lines.length ?? 0,
    subtotalCents: output.quote?.totals.subtotalCents ?? 0,
    vatRateBp: output.quote?.totals.vatRateBp ?? 0,
    totalCents: output.quote?.totals.totalCents ?? 0,
    pricingRules: new Set(
      output.quote?.lines.map((line) => line.pricing.rule) ?? []
    ).size,
    delivered: Number(
      output.workflowState === "delivered" && output.delivery !== null
    ),
    hasExternalId: Number(!!output.delivery?.externalEstimateId),
    simulated: Number(output.delivery?.simulated === true),
    wallClockMs: output.wallClockMs,
    ...evaluateCatalog(expected, input, catalog),
  }
  return scores
}
export type RunScores = Awaited<ReturnType<typeof evaluateRun>>

export function isRegression(
  totals: Pick<
    RunScores,
    | "lines"
    | "selectionCorrect"
    | "divergedAfterAsking"
    | "divergedWithoutAsking"
  >
): boolean {
  return (
    totals.divergedWithoutAsking > 0 ||
    totals.selectionCorrect + totals.divergedAfterAsking < totals.lines
  )
}

/** Missing scores and failed items cannot count as zero-line successes. */
export function aggregateScores(
  items: { expectedLines: number; scores: RunScores | null }[]
) {
  return items.reduce(
    (totals, item) => ({
      lines: totals.lines + item.expectedLines,
      selectionCorrect:
        totals.selectionCorrect + (item.scores?.selectionCorrect ?? 0),
      divergedAfterAsking:
        totals.divergedAfterAsking + (item.scores?.divergedAfterAsking ?? 0),
      divergedWithoutAsking:
        totals.divergedWithoutAsking +
        (item.scores?.divergedWithoutAsking ?? 0),
    }),
    {
      lines: 0,
      selectionCorrect: 0,
      divergedAfterAsking: 0,
      divergedWithoutAsking: 0,
    }
  )
}

/** Compare the Cloud answer's source facts with the request shipped by this build. */
export function evaluateRequest(
  expected: ExpectedOutput,
  requestedItems: { position: number; reference: string; quantity: number }[]
) {
  return {
    expectedLineCountCorrect: Number(
      expected.lines.length === requestedItems.length
    ),
    expectedSourceFactsCorrect: Number(
      requestedItems.every((item) =>
        expected.lines.some(
          (line) =>
            line.position === item.position &&
            line.sourceReference === item.reference &&
            line.quantity === item.quantity
        )
      )
    ),
  }
}

/** Cloud metadata replaces scenario-specific gold assertions about whether to ask. */
export function evaluateReviewExpectation(
  expected: ExpectedOutput,
  metadata: { expectedReview: boolean }
) {
  return {
    expectedReviewFlagConsistent: Number(
      metadata.expectedReview === expected.expectedReviewPositions.length > 0
    ),
  }
}

/** The SDK returns original dataset fields under item, even though its type also declares them at the top level. */
export async function evaluateExperiment(
  cases: { input: ScenarioInput; expectedOutput: ExpectedOutput }[],
  results: {
    item: { input: ScenarioInput }
    output: RunProjection | null
    evaluations: { name: string }[]
  }[],
  catalog: Catalog
) {
  const items = await Promise.all(
    cases.map(async (source) => {
      const result = results.find(
        (entry) => entry.item.input.scenarioId === source.input.scenarioId
      )
      const output = result?.output
      const complete =
        result !== undefined &&
        output !== undefined &&
        output !== null &&
        output.workflowState === "delivered" &&
        output.delivery !== null &&
        result.evaluations.some((score) => score.name === "selectionCorrect") &&
        result.evaluations.some(
          (score) => score.name === "divergedWithoutAsking"
        )
      return {
        expectedLines: source.expectedOutput.lines.length,
        scores: complete
          ? await evaluateRun(
              source.input,
              source.expectedOutput,
              output,
              catalog
            )
          : null,
      }
    })
  )
  return aggregateScores(items)
}
