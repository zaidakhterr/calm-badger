/**
 * The "Resolve customer" workflow step.
 *
 * Identity is decided by deterministic code over the seeded catalogue, never by
 * a model, and never by looking at which products were requested. Six signals
 * are considered — the sender's address, the sender's domain, the company name,
 * a delivery location, wording this customer alone is known to use, and order
 * history — and each contributes a fixed weight to a demo heuristic.
 *
 * A request that does not clear the threshold stays explicitly unresolved. The
 * demo never invents a customer record: an unknown sender is a fact worth
 * showing, not a gap to fill.
 */

import { labelFor, type Confidence } from "./rfq-extraction"
import { createRunStepRecorder, type RunStepRecorder } from "./run-steps"

export const RESOLVE_CUSTOMER_STEP_KEY = "resolve-customer"

/** The one kind of evidence this step records. */
const CUSTOMER_EVIDENCE_KIND = "customer"

/** Fixed weights. They are demo judgement, stated openly in the evidence. */
const WEIGHTS = {
  contactEmail: 0.6,
  domain: 0.25,
  companyNameExact: 0.2,
  companyNamePartial: 0.1,
  location: 0.1,
  alias: 0.08,
  aliasCap: 0.16,
  historyAny: 0.05,
  historySku: 0.05,
} as const

/** Below this, or too close to the runner-up, the run stays unresolved. */
const RESOLUTION_THRESHOLD = 0.5
const RESOLUTION_GAP = 0.1

export type ResolveCustomerOutcome =
  | { state: "resolved"; customerId: string; label: string; elapsedMs: number }
  | { state: "unresolved"; elapsedMs: number }
  | { state: "error"; message: string }

type Signal = { kind: string; detail: string; weight: number }

type Candidate = {
  customerId: string
  name: string
  tier: string
  score: number
  signals: Signal[]
  contactId: string | null
  locationId: string | null
}

type RfqRow = {
  company_name: string | null
  contact_name: string | null
  contact_email: string | null
  delivery_location: string | null
}

type CustomerRow = {
  id: string
  name: string
  domain: string
  tier: string
}

export async function resolveCustomer(
  env: Env,
  runId: string
): Promise<ResolveCustomerOutcome> {
  const step = createRunStepRecorder(env, runId, RESOLVE_CUSTOMER_STEP_KEY)

  try {
    return await resolve(env, runId, step)
  } catch (error) {
    const message = "The customer could not be resolved."

    console.error(
      JSON.stringify({
        event: "resolve_customer_failed",
        runId,
        step: RESOLVE_CUSTOMER_STEP_KEY,
        reason: "unexpected",
        error: error instanceof Error ? error.name : "unknown",
      })
    )

    try {
      await step.fail(message)
    } catch {
      // Nowhere left to record the failure; returning still stops the workflow.
    }

    return { state: "error", message }
  }
}

async function resolve(
  env: Env,
  runId: string,
  step: RunStepRecorder
): Promise<ResolveCustomerOutcome> {
  const rfq = await env.DB.prepare(
    `SELECT company_name, contact_name, contact_email, delivery_location
       FROM run_rfq WHERE run_id = ?`
  )
    .bind(runId)
    .first<RfqRow>()

  if (!rfq) {
    const message = "No structured request was available to resolve."
    await step.fail(message)
    return { state: "error", message }
  }

  const startedAt = Date.now()
  await step.begin("Matching the sender against catalogue customers…")

  const references = await loadReferences(env, runId)
  const candidates = await scoreCandidates(env, rfq, references)

  const best = candidates[0] ?? null
  const runnerUp = candidates[1] ?? null
  const gap = best ? best.score - (runnerUp?.score ?? 0) : 0

  const resolved =
    best !== null && best.score >= RESOLUTION_THRESHOLD && gap >= RESOLUTION_GAP

  const confidence = describeConfidence(best, resolved, gap)
  const elapsedMs = Date.now() - startedAt

  await persistResolution(env, runId, resolved ? best : null, confidence)

  await step.attachEvidence(CUSTOMER_EVIDENCE_KIND, {
    state: resolved ? "resolved" : "unresolved",
    method: "deterministic-catalog-lookup",
    message: resolved
      ? null
      : "No catalogue customer matched this request closely enough. The demo never creates a customer record from a request.",
    resolution: resolved && best ? await describeResolution(env, best) : null,
    confidence,
    signals: best?.signals ?? [],
    candidates: candidates.slice(0, 3).map((candidate) => ({
      customerId: candidate.customerId,
      name: candidate.name,
      score: round(candidate.score),
      signals: candidate.signals.map((signal) => signal.kind),
    })),
    inputs: {
      contactEmail: rfq.contact_email,
      companyName: rfq.company_name,
      deliveryLocation: rfq.delivery_location,
      referenceCount: references.length,
    },
    metrics: { elapsedMs },
  })

  // Two endings, one step: an unresolved run continues, so it is a completion
  // with its own variant rather than a failure.
  if (resolved && best) {
    await step.complete(
      `Resolved to ${best.name}. Confidence ${confidence.label} (${confidence.score.toFixed(2)}).`
    )
  } else {
    await step.complete(
      "No catalogue customer matched. The request stays unresolved rather than creating one.",
      { variant: "unresolved" }
    )
  }

  console.log(
    JSON.stringify({
      event: "resolve_customer_completed",
      runId,
      step: RESOLVE_CUSTOMER_STEP_KEY,
      resolved,
      confidence: confidence.label,
      candidates: candidates.length,
      elapsedMs,
    })
  )

  return resolved && best
    ? {
        state: "resolved",
        customerId: best.customerId,
        label: confidence.label,
        elapsedMs,
      }
    : { state: "unresolved", elapsedMs }
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

async function scoreCandidates(
  env: Env,
  rfq: RfqRow,
  references: { reference: string; catalogSku: string | null }[]
): Promise<Candidate[]> {
  const email = rfq.contact_email?.trim().toLowerCase() ?? null
  const domain = email?.includes("@") ? email.split("@")[1] : null
  const company = normalise(rfq.company_name)

  const signals = new Map<string, Signal[]>()
  const contacts = new Map<string, string>()
  const record = (customerId: string, signal: Signal) => {
    const existing = signals.get(customerId)
    if (existing) existing.push(signal)
    else signals.set(customerId, [signal])
  }

  // 1. The sender's own address, which is the strongest identity available.
  if (email) {
    const row = await env.DB.prepare(
      `SELECT id, customer_id, name, role FROM catalog_customer_contacts
        WHERE lower(email) = ?`
    )
      .bind(email)
      .first<{ id: string; customer_id: string; name: string; role: string }>()

    if (row) {
      contacts.set(row.customer_id, row.id)
      record(row.customer_id, {
        kind: "contact_email",
        detail: `${row.name} (${row.role}) is a known contact at this address.`,
        weight: WEIGHTS.contactEmail,
      })
    }
  }

  // 2. The sending domain, which survives an unknown colleague writing in.
  if (domain) {
    const rows = await env.DB.prepare(
      `SELECT id, name FROM catalog_customers WHERE lower(domain) = ?`
    )
      .bind(domain)
      .all<{ id: string; name: string }>()

    for (const row of rows.results) {
      record(row.id, {
        kind: "email_domain",
        detail: `The sending domain ${domain} belongs to ${row.name}.`,
        weight: WEIGHTS.domain,
      })
    }
  }

  // 3. The company as the request names it.
  if (company) {
    const rows = await env.DB.prepare(
      `SELECT id, name FROM catalog_customers`
    ).all<{ id: string; name: string }>()

    for (const row of rows.results) {
      const candidateName = normalise(row.name)
      if (!candidateName) continue

      if (candidateName === company) {
        record(row.id, {
          kind: "company_name",
          detail: `The stated company name matches ${row.name} exactly.`,
          weight: WEIGHTS.companyNameExact,
        })
      } else if (
        candidateName.includes(company) ||
        company.includes(candidateName)
      ) {
        record(row.id, {
          kind: "company_name_partial",
          detail: `The stated company name overlaps ${row.name}.`,
          weight: WEIGHTS.companyNamePartial,
        })
      }
    }
  }

  // 4. A delivery address the request named, matched to a stored location.
  const locations = new Map<string, string>()
  const stated = normalise(rfq.delivery_location)

  if (stated) {
    const rows = await env.DB.prepare(
      `SELECT id, customer_id, label, city FROM catalog_customer_locations`
    ).all<{ id: string; customer_id: string; label: string; city: string }>()

    for (const row of rows.results) {
      const label = normalise(row.label)
      const city = normalise(row.city)
      const matches =
        (label && (stated.includes(label) || label.includes(stated))) ||
        (city && stated.includes(city))

      if (!matches || locations.has(row.customer_id)) continue

      locations.set(row.customer_id, row.id)
      record(row.customer_id, {
        kind: "location",
        detail: `The delivery address matches the ${row.label} in ${row.city}.`,
        weight: WEIGHTS.location,
      })
    }
  }

  // 5. Wording only one customer is recorded as using. This is an identity
  //    signal, not a product decision: no product is selected here.
  if (references.length > 0) {
    const wanted = references.map((entry) => entry.reference.toLowerCase())
    const placeholders = wanted.map(() => "?").join(", ")
    const rows = await env.DB.prepare(
      `SELECT DISTINCT customer_id, alias FROM catalog_product_aliases
        WHERE customer_id IS NOT NULL AND lower(alias) IN (${placeholders})`
    )
      .bind(...wanted)
      .all<{ customer_id: string; alias: string }>()

    const perCustomer = new Map<string, string[]>()
    for (const row of rows.results) {
      const list = perCustomer.get(row.customer_id) ?? []
      list.push(row.alias)
      perCustomer.set(row.customer_id, list)
    }

    for (const [customerId, aliases] of perCustomer) {
      record(customerId, {
        kind: "customer_alias",
        detail: `This customer is the only one recorded using ${aliases.length === 1 ? `the wording “${aliases[0]}”` : `${aliases.length} of these wordings`}.`,
        weight: Math.min(WEIGHTS.aliasCap, WEIGHTS.alias * aliases.length),
      })
    }
  }

  // 6. History, which only ever confirms an identity another signal proposed.
  const candidateIds = [...signals.keys()]

  if (candidateIds.length > 0) {
    const placeholders = candidateIds.map(() => "?").join(", ")
    const rows = await env.DB.prepare(
      `SELECT customer_id, COUNT(*) AS orders FROM catalog_orders
        WHERE customer_id IN (${placeholders}) GROUP BY customer_id`
    )
      .bind(...candidateIds)
      .all<{ customer_id: string; orders: number }>()

    for (const row of rows.results) {
      if (row.orders > 0) {
        record(row.customer_id, {
          kind: "order_history",
          detail: `${row.orders} previous ${row.orders === 1 ? "order" : "orders"} are on record for this customer.`,
          weight: WEIGHTS.historyAny,
        })
      }
    }

    const skus = [
      ...new Set(
        references
          .map((entry) => entry.catalogSku)
          .filter((sku): sku is string => Boolean(sku))
      ),
    ]

    if (skus.length > 0) {
      const skuPlaceholders = skus.map(() => "?").join(", ")
      const reordered = await env.DB.prepare(
        `SELECT DISTINCT o.customer_id FROM catalog_orders o
           JOIN catalog_order_lines l ON l.order_id = o.id
          WHERE o.customer_id IN (${placeholders}) AND l.sku IN (${skuPlaceholders})`
      )
        .bind(...candidateIds, ...skus)
        .all<{ customer_id: string }>()

      for (const row of reordered.results) {
        record(row.customer_id, {
          kind: "reordered_article",
          detail:
            "This customer has ordered one of the referenced articles before.",
          weight: WEIGHTS.historySku,
        })
      }
    }
  }

  const customers = await loadCustomers(env, [...signals.keys()])

  const candidates: Candidate[] = [...signals.entries()].flatMap(
    ([customerId, entries]) => {
      const customer = customers.get(customerId)
      if (!customer) return []

      return [
        {
          customerId,
          name: customer.name,
          tier: customer.tier,
          score: round(
            Math.min(
              1,
              entries.reduce((total, signal) => total + signal.weight, 0)
            )
          ),
          signals: entries,
          contactId: contacts.get(customerId) ?? null,
          locationId: locations.get(customerId) ?? null,
        },
      ]
    }
  )

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.customerId.localeCompare(right.customerId)
  )

  return candidates
}

function describeConfidence(
  best: Candidate | null,
  resolved: boolean,
  gap: number
): Confidence {
  if (!best) {
    return {
      label: "Review",
      score: 0,
      heuristic:
        "No identity signal matched the catalogue, so the score stays at 0.00.",
    }
  }

  const parts = best.signals
    .map(
      (signal) => `${signal.weight.toFixed(2)} for ${describeKind(signal.kind)}`
    )
    .join(", ")

  const closing = resolved
    ? ` The runner-up is ${gap.toFixed(2)} behind.`
    : gap < RESOLUTION_GAP && best.score >= RESOLUTION_THRESHOLD
      ? ` The runner-up is only ${gap.toFixed(2)} behind, which is too close to accept.`
      : ` That is below the ${RESOLUTION_THRESHOLD.toFixed(2)} needed to resolve a customer.`

  return {
    label: resolved ? labelFor(best.score) : "Review",
    score: best.score,
    heuristic: `Customer confidence sums ${parts}, giving ${best.score.toFixed(2)}.${closing}`,
  }
}

function describeKind(kind: string): string {
  switch (kind) {
    case "contact_email":
      return "a known contact address"
    case "email_domain":
      return "the sending domain"
    case "company_name":
      return "an exact company name"
    case "company_name_partial":
      return "a partial company name"
    case "location":
      return "a known delivery location"
    case "customer_alias":
      return "wording only this customer uses"
    case "order_history":
      return "existing order history"
    case "reordered_article":
      return "a previously ordered article"
    default:
      return kind
  }
}

/* -------------------------------------------------------------------------- */
/* Reading and writing                                                        */
/* -------------------------------------------------------------------------- */

async function loadReferences(
  env: Env,
  runId: string
): Promise<{ reference: string; catalogSku: string | null }[]> {
  const rows = await env.DB.prepare(
    `SELECT reference, catalog_sku FROM run_rfq_line_items
      WHERE run_id = ? ORDER BY position ASC`
  )
    .bind(runId)
    .all<{ reference: string; catalog_sku: string | null }>()

  return rows.results.map((row) => ({
    reference: row.reference,
    catalogSku: row.catalog_sku,
  }))
}

async function loadCustomers(
  env: Env,
  ids: string[]
): Promise<Map<string, CustomerRow>> {
  if (ids.length === 0) return new Map()

  const placeholders = ids.map(() => "?").join(", ")
  const rows = await env.DB.prepare(
    `SELECT id, name, domain, tier FROM catalog_customers WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<CustomerRow>()

  return new Map(rows.results.map((row) => [row.id, row]))
}

async function describeResolution(env: Env, best: Candidate) {
  const [contact, location] = await Promise.all([
    best.contactId
      ? env.DB.prepare(
          `SELECT id, name, role, email FROM catalog_customer_contacts WHERE id = ?`
        )
          .bind(best.contactId)
          .first<{ id: string; name: string; role: string; email: string }>()
      : Promise.resolve(null),
    best.locationId
      ? env.DB.prepare(
          `SELECT id, label, city, country FROM catalog_customer_locations WHERE id = ?`
        )
          .bind(best.locationId)
          .first<{ id: string; label: string; city: string; country: string }>()
      : Promise.resolve(null),
  ])

  return {
    customerId: best.customerId,
    name: best.name,
    tier: best.tier,
    contact,
    location,
  }
}

/**
 * Applies the customer the owner chose in review.
 *
 * The chosen identity is a decision, not a guess, so it lands as `resolved` at
 * full confidence. Contact and location default to the customer's first records
 * because review chooses a customer, not a desk. Re-applying is a no-op beyond
 * rewriting the same row. The step's evidence keeps showing what the automatic
 * resolution saw: this writes the fact pricing reads, not the story of how the
 * machine got there.
 */
export async function applyReviewCustomer(
  env: Env,
  runId: string,
  { customerId }: { customerId: string }
): Promise<void> {
  const customer = await env.DB.prepare(
    `SELECT id FROM catalog_customers WHERE id = ?`
  )
    .bind(customerId)
    .first<{ id: string }>()

  // Review only ever offers catalogue customers, so an unknown id is a bug
  // upstream. Failing loudly beats persisting a "resolved" run with no customer.
  if (!customer) {
    throw new Error(`No catalogue customer ${customerId} to apply.`)
  }

  const [contact, location] = await Promise.all([
    env.DB.prepare(
      `SELECT id FROM catalog_customer_contacts
        WHERE customer_id = ? ORDER BY id ASC LIMIT 1`
    )
      .bind(customerId)
      .first<{ id: string }>(),
    env.DB.prepare(
      `SELECT id FROM catalog_customer_locations
        WHERE customer_id = ? ORDER BY id ASC LIMIT 1`
    )
      .bind(customerId)
      .first<{ id: string }>(),
  ])

  await persistResolution(
    env,
    runId,
    {
      customerId,
      contactId: contact?.id ?? null,
      locationId: location?.id ?? null,
    },
    { label: "High", score: 1 }
  )
}

async function persistResolution(
  env: Env,
  runId: string,
  best: {
    customerId: string
    contactId: string | null
    locationId: string | null
  } | null,
  confidence: Pick<Confidence, "label" | "score">
): Promise<void> {
  const now = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO run_customer_resolution (
       run_id, state, customer_id, contact_id, location_id,
       confidence_label, confidence_score, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id) DO UPDATE SET
       state = excluded.state,
       customer_id = excluded.customer_id,
       contact_id = excluded.contact_id,
       location_id = excluded.location_id,
       confidence_label = excluded.confidence_label,
       confidence_score = excluded.confidence_score`
  )
    .bind(
      runId,
      best ? "resolved" : "unresolved",
      best?.customerId ?? null,
      best?.contactId ?? null,
      best?.locationId ?? null,
      confidence.label,
      confidence.score,
      now
    )
    .run()
}

function normalise(value: string | null): string | null {
  if (!value) return null

  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

  return cleaned.length > 0 ? cleaned : null
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
