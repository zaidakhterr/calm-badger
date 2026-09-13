import { z } from "zod"

export const SCENARIO_INPUT = z.object({
  scenarioId: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
})
export const EXPECTED_OUTPUT = z.object({
  customerId: z.string().min(1),
  contactEmail: z.string().min(1),
  locationId: z.string().min(1),
  lines: z
    .array(
      z.object({
        position: z.number().int().positive(),
        sourceReference: z.string().min(1),
        quantity: z.number().positive(),
        expectedSku: z.string().min(1),
        decision: z.enum(["auto_accept", "model_match", "review"]),
        basis: z.enum([
          "sku",
          "alias",
          "typo_alias",
          "legacy_alias",
          "description",
        ]),
        alternatives: z.array(z.string()),
      })
    )
    .min(1)
    .refine(
      (lines) =>
        new Set(lines.map((line) => line.position)).size === lines.length,
      "Expected positions must be unique"
    ),
  expectedReviewPositions: z.array(z.number().int().positive()),
})
const USAGE = z.object({ totalTokens: z.number() }).nullable().optional()
export const STRUCTURE = z.object({
  metrics: z.object({ latencyMs: z.number() }).nullable().optional(),
  usage: USAGE,
  validated: z
    .object({
      customer: z.object({ deliveryLocation: z.string().nullable() }),
      lineItems: z.array(
        z.object({
          position: z.number(),
          reference: z.string(),
          quantity: z.number().nullable(),
        })
      ),
    })
    .nullable(),
})
export const MATCHES = z.object({
  totals: z
    .object({
      modelCalls: z.number(),
      providerLatencyMs: z.number(),
      usage: USAGE,
    })
    .nullable()
    .optional(),
  lines: z.array(
    z.object({
      position: z.number(),
      reference: z.string(),
      state: z.string(),
      sku: z.string().nullable(),
      method: z.string(),
      alternatives: z.array(z.object({ sku: z.string() })),
    })
  ),
})
export const CANDIDATES = z.object({
  shortlistSize: z.number().optional(),
  lines: z.array(
    z.object({
      position: z.number(),
      candidates: z.array(z.object({ sku: z.string() })),
    })
  ),
})
export const REVIEW = z.object({
  state: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      position: z.number(),
      proposal: z.object({
        sku: z.string().nullable(),
        quantity: z.number().nullable(),
      }),
      alternatives: z.array(z.object({ value: z.string() })),
    })
  ),
})
export const QUOTE = z.object({
  lines: z.array(
    z.object({
      position: z.number(),
      sku: z.string().min(1),
      quantity: z.number(),
      pricing: z.object({ rule: z.string() }),
    })
  ),
  totals: z.object({
    subtotalCents: z.number(),
    vatRateBp: z.number(),
    totalCents: z.number(),
  }),
})
const DELIVERY_RECORD = z
  .object({
    adapter: z.string(),
    externalEstimateId: z.string(),
    simulated: z.boolean(),
  })
  .nullable()
export const DELIVERY = z.object({ delivery: DELIVERY_RECORD })
export const RUN_PROJECTION = z.object({
  viewId: z.string(),
  workflowState: z.string(),
  wallClockMs: z.number(),
  measurements: z
    .object({
      ocrLatencyMs: z.number().nullable(),
      extractionLatencyMs: z.number().nullable(),
      rerankLatencyMs: z.number().nullable(),
      pagesProcessed: z.number().nullable(),
      extractionTokens: z.number().nullable(),
      rerankTokens: z.number().nullable(),
      modelCalls: z.number().nullable(),
      shortlistSize: z.number().nullable(),
    })
    .optional(),
  sources: z.array(z.string()),
  structure: STRUCTURE,
  candidates: CANDIDATES,
  matches: MATCHES,
  customer: z.object({
    customerId: z.string().nullable(),
    contactFingerprint: z.string().nullable(),
    locationId: z.string().nullable(),
  }),
  review: REVIEW.nullable(),
  approved: z.boolean(),
  quote: QUOTE.nullable(),
  delivery: DELIVERY_RECORD,
})
export type ScenarioInput = z.infer<typeof SCENARIO_INPUT>
export type ExpectedOutput = z.infer<typeof EXPECTED_OUTPUT>
export type RunProjection = z.infer<typeof RUN_PROJECTION>

/** Compare contacts without putting addresses into experiment output. */
export async function contactFingerprint(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

export const SCENARIO_METADATA = z.object({ expectedReview: z.boolean() })
