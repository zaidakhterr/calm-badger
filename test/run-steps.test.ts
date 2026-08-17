/**
 * Contract for the Run-step recorder.
 *
 * This is the one place raw `run_steps` / `run_step_evidence` assertions are
 * legitimate: the recorder's whole job is those two tables plus the run's
 * `workflow_state`, so the test drives its interface and reads the rows back.
 *
 * Runs are seeded straight into D1 rather than through `POST /api/runs`, which
 * starts the real workflow and would rewrite the same step rows underneath
 * these assertions. The seed mirrors `createRun`'s inserts: an active run in
 * `pending`, eight steps at positions 0–7, `rfq-received` already complete.
 */

import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { BUILD_ESTIMATE_STEP_KEY } from "../worker/build-estimate"
import { DELIVER_STEP_KEY } from "../worker/deliver"
import { MATCH_PRODUCTS_STEP_KEY } from "../worker/match-products"
import { READ_DOCUMENTS_STEP_KEY } from "../worker/read-documents"
import { RESOLVE_CUSTOMER_STEP_KEY } from "../worker/resolve-customer"
import { RETRIEVE_CANDIDATES_STEP_KEY } from "../worker/retrieve-candidates"
import { REVIEW_STEP_KEY, REVIEW_STEP_TITLE } from "../worker/review"
import { RFQ_RECEIVED_STEP_KEY } from "../worker/runs"
import { STRUCTURE_RFQ_STEP_KEY } from "../worker/structure-rfq"
import {
  createRunStepRecorder,
  type CompleteVariant,
  type RunStepKey,
} from "../worker/run-steps"

const SEEDED_STEPS: { key: RunStepKey; title: string; waiting: string }[] = [
  {
    key: "rfq-received",
    title: "RFQ received",
    waiting: "Waiting for a request.",
  },
  {
    key: "read-documents",
    title: "Read documents",
    waiting: "Waiting to read.",
  },
  {
    key: "structure-rfq",
    title: "Structure RFQ",
    waiting: "Waiting for text.",
  },
  {
    key: "resolve-customer",
    title: "Resolve customer",
    waiting: "Waiting for evidence.",
  },
  {
    key: "retrieve-candidates",
    title: "Retrieve candidates",
    waiting: "Waiting for lines.",
  },
  {
    key: "match-products",
    title: "Match products",
    waiting: "Waiting for a shortlist.",
  },
  {
    key: "build-estimate",
    title: "Build estimate",
    waiting: "Waiting for matches.",
  },
  {
    key: "deliver",
    title: "Deliver",
    waiting: "Waiting for the canonical quote.",
  },
]

const RECEIPT_SUMMARY = "Stored 3 sources and queued the request."
const SEEDED_AT = "2026-01-01T00:00:00.000Z"

type StepRow = {
  step_key: string
  position: number
  title: string
  status: string
  summary: string
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

type RunRow = { status: string; workflow_state: string; updated_at: string }

type EvidenceRow = { step_key: string; kind: string; payload: string }

async function seedRun(): Promise<string> {
  const runId = crypto.randomUUID()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO runs (
         id, view_id, owner_capability_hash, source_kind, scenario_id,
         status, workflow_instance_id, workflow_state, workspace_hash,
         created_at, updated_at
       ) VALUES (?, ?, 'hash', 'curated', 'messy-forwarded-request',
                 'active', NULL, 'pending', NULL, ?, ?)`
    ).bind(runId, crypto.randomUUID(), SEEDED_AT, SEEDED_AT),
    ...SEEDED_STEPS.map((step, index) => {
      const isReceived = step.key === "rfq-received"

      return env.DB.prepare(
        `INSERT INTO run_steps (
           id, run_id, step_key, position, title, status, summary,
           started_at, completed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        runId,
        step.key,
        index,
        step.title,
        isReceived ? "complete" : "waiting",
        isReceived ? RECEIPT_SUMMARY : step.waiting,
        isReceived ? SEEDED_AT : null,
        isReceived ? SEEDED_AT : null,
        SEEDED_AT
      )
    }),
  ])

  return runId
}

async function readStep(runId: string, stepKey: string): Promise<StepRow> {
  const row = await env.DB.prepare(
    `SELECT step_key, position, title, status, summary, started_at,
            completed_at, updated_at
       FROM run_steps WHERE run_id = ? AND step_key = ?`
  )
    .bind(runId, stepKey)
    .first<StepRow>()

  expect(row).not.toBeNull()
  return row as StepRow
}

async function readSteps(runId: string): Promise<StepRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT step_key, position, title, status, summary, started_at,
            completed_at, updated_at
       FROM run_steps WHERE run_id = ? ORDER BY position`
  )
    .bind(runId)
    .all<StepRow>()

  return results
}

async function readRun(runId: string): Promise<RunRow> {
  const row = await env.DB.prepare(
    `SELECT status, workflow_state, updated_at FROM runs WHERE id = ?`
  )
    .bind(runId)
    .first<RunRow>()

  expect(row).not.toBeNull()
  return row as RunRow
}

async function readEvidence(runId: string): Promise<EvidenceRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT step_key, kind, payload FROM run_step_evidence
      WHERE run_id = ? ORDER BY kind`
  )
    .bind(runId)
    .all<EvidenceRow>()

  return results
}

describe("the step keys the recorder writes", () => {
  it("are the keys the workflow modules already publish", () => {
    const published: RunStepKey[] = [
      RFQ_RECEIVED_STEP_KEY,
      READ_DOCUMENTS_STEP_KEY,
      STRUCTURE_RFQ_STEP_KEY,
      RESOLVE_CUSTOMER_STEP_KEY,
      RETRIEVE_CANDIDATES_STEP_KEY,
      MATCH_PRODUCTS_STEP_KEY,
      REVIEW_STEP_KEY,
      BUILD_ESTIMATE_STEP_KEY,
      DELIVER_STEP_KEY,
    ]

    expect(published).toEqual([
      "rfq-received",
      "read-documents",
      "structure-rfq",
      "resolve-customer",
      "retrieve-candidates",
      "match-products",
      "review-required",
      "build-estimate",
      "deliver",
    ])
  })
})

describe("beginning a step", () => {
  const rows: [RunStepKey, string][] = [
    ["read-documents", "reading_documents"],
    ["structure-rfq", "structuring_rfq"],
    ["resolve-customer", "resolving_customer"],
    ["retrieve-candidates", "retrieving_candidates"],
    ["match-products", "matching_products"],
  ]

  for (const [stepKey, workflowState] of rows) {
    it(`makes ${stepKey} active and moves the run to ${workflowState}`, async () => {
      const runId = await seedRun()

      await createRunStepRecorder(env, runId, stepKey).begin("Working…")

      const step = await readStep(runId, stepKey)
      expect(step.status).toBe("active")
      expect(step.summary).toBe("Working…")
      expect(step.started_at).not.toBeNull()
      expect(step.completed_at).toBeNull()
      expect(step.updated_at).not.toBe(SEEDED_AT)

      const run = await readRun(runId)
      expect(run.status).toBe("active")
      expect(run.workflow_state).toBe(workflowState)
      expect(run.updated_at).not.toBe(SEEDED_AT)
    })
  }

  it("keeps the first start time when a durable step replays", async () => {
    const runId = await seedRun()
    const recorder = createRunStepRecorder(env, runId, "read-documents")

    await recorder.begin("First attempt…")
    const first = await readStep(runId, "read-documents")

    await recorder.begin("Second attempt…")
    const second = await readStep(runId, "read-documents")

    expect(second.started_at).toBe(first.started_at)
    expect(second.summary).toBe("Second attempt…")
  })

  it("refuses steps that never begin", async () => {
    const runId = await seedRun()

    for (const stepKey of [
      "rfq-received",
      "review-required",
      "build-estimate",
      "deliver",
    ] as RunStepKey[]) {
      await expect(
        createRunStepRecorder(env, runId, stepKey).begin("Working…")
      ).rejects.toThrow(/No workflow state is defined/)
    }
  })
})

describe("completing a step", () => {
  const rows: {
    stepKey: RunStepKey
    variant?: CompleteVariant
    workflowState: string
    runStatus: string
    stepStatus: string
  }[] = [
    {
      stepKey: "read-documents",
      workflowState: "documents_read",
      runStatus: "active",
      stepStatus: "complete",
    },
    {
      stepKey: "structure-rfq",
      workflowState: "rfq_structured",
      runStatus: "active",
      stepStatus: "complete",
    },
    {
      stepKey: "resolve-customer",
      workflowState: "customer_resolved",
      runStatus: "active",
      stepStatus: "complete",
    },
    {
      stepKey: "resolve-customer",
      variant: "resolved",
      workflowState: "customer_resolved",
      runStatus: "active",
      stepStatus: "complete",
    },
    {
      stepKey: "resolve-customer",
      variant: "unresolved",
      workflowState: "customer_unresolved",
      runStatus: "active",
      stepStatus: "complete",
    },
    {
      stepKey: "retrieve-candidates",
      workflowState: "candidates_retrieved",
      runStatus: "active",
      stepStatus: "complete",
    },
    {
      stepKey: "match-products",
      workflowState: "products_matched",
      runStatus: "active",
      stepStatus: "complete",
    },
    {
      stepKey: "build-estimate",
      workflowState: "estimate_built",
      runStatus: "active",
      stepStatus: "complete",
    },
    {
      stepKey: "deliver",
      workflowState: "delivered",
      runStatus: "complete",
      stepStatus: "complete",
    },
  ]

  for (const row of rows) {
    const label = row.variant ? `${row.stepKey}/${row.variant}` : row.stepKey

    it(`moves the run to ${row.workflowState} for ${label}`, async () => {
      const runId = await seedRun()

      await createRunStepRecorder(env, runId, row.stepKey).complete("Done.", {
        variant: row.variant,
      })

      const step = await readStep(runId, row.stepKey)
      expect(step.status).toBe(row.stepStatus)
      expect(step.summary).toBe("Done.")
      expect(step.completed_at).not.toBeNull()

      const run = await readRun(runId)
      expect(run.workflow_state).toBe(row.workflowState)
      expect(run.status).toBe(row.runStatus)
    })
  }

  it("stamps a start time on steps that were never begun", async () => {
    const runId = await seedRun()

    await createRunStepRecorder(env, runId, "build-estimate").complete(
      "Priced 4 lines."
    )

    const step = await readStep(runId, "build-estimate")
    expect(step.started_at).not.toBeNull()
    expect(step.started_at).toBe(step.completed_at)
  })

  it("keeps the receipt's own sentence and completion time", async () => {
    const runId = await seedRun()

    await createRunStepRecorder(env, runId, "rfq-received").complete(null)

    const step = await readStep(runId, "rfq-received")
    expect(step.status).toBe("complete")
    expect(step.summary).toBe(RECEIPT_SUMMARY)
    expect(step.completed_at).toBe(SEEDED_AT)
    expect(step.updated_at).not.toBe(SEEDED_AT)

    expect((await readRun(runId)).workflow_state).toBe("accepted")
  })

  it("finishes the run when `deliver` completes", async () => {
    const runId = await seedRun()

    await env.DB.prepare(
      `UPDATE runs SET workflow_state = 'estimate_built' WHERE id = ?`
    )
      .bind(runId)
      .run()

    await createRunStepRecorder(env, runId, "deliver").complete(
      "Simulated external estimate ERP-SIM-1 accepted."
    )

    // Delivery has no `begin`, so completion is where `started_at` appears.
    const step = await readStep(runId, "deliver")
    expect(step.status).toBe("complete")
    expect(step.started_at).toBe(step.completed_at)

    const run = await readRun(runId)
    expect(run.status).toBe("complete")
    expect(run.workflow_state).toBe("delivered")
  })

  it("ends the run on an approved, rejected, or expired review", async () => {
    for (const [variant, workflowState, runStatus, stepStatus] of [
      ["approved", "review_approved", "active", "complete"],
      ["rejected", "review_rejected", "error", "error"],
      ["expired", "review_expired", "error", "error"],
    ] as [CompleteVariant, string, string, string][]) {
      const runId = await seedRun()
      const recorder = createRunStepRecorder(env, runId, "review-required")

      await recorder.insertConditionalStep({
        title: REVIEW_STEP_TITLE,
        summary: "Two matches need a decision.",
      })
      await recorder.complete("The owner decided.", { variant })

      const step = await readStep(runId, "review-required")
      expect(step.status).toBe(stepStatus)
      expect(step.summary).toBe("The owner decided.")
      expect(step.completed_at).not.toBeNull()

      const run = await readRun(runId)
      expect(run.workflow_state).toBe(workflowState)
      expect(run.status).toBe(runStatus)
    }
  })

  it("insists on a summary, except where the row preserves one", async () => {
    const runId = await seedRun()

    await expect(
      createRunStepRecorder(env, runId, "read-documents").complete(null)
    ).rejects.toThrow(/must supply a summary/)

    await expect(
      createRunStepRecorder(env, runId, "rfq-received").complete("Overwritten.")
    ).rejects.toThrow(/keeps the summary it was created with/)
  })

  it("refuses an outcome nothing defines", async () => {
    const runId = await seedRun()

    await expect(
      createRunStepRecorder(env, runId, "resolve-customer").complete("Done.", {
        variant: "approved",
      })
    ).rejects.toThrow(/No workflow state is defined/)

    await expect(
      createRunStepRecorder(env, runId, "review-required").complete("Done.")
    ).rejects.toThrow(/No workflow state is defined/)
  })
})

describe("handing the completion statements to a caller's own batch", () => {
  const DELIVERED_AT = "2026-03-04T05:06:07.000Z"

  it("writes what `complete` writes when the caller sends the batch", async () => {
    const runId = await seedRun()

    await env.DB.batch(
      createRunStepRecorder(env, runId, "deliver").completeStatements(
        "Simulated external estimate ERP-SIM-1 accepted."
      )
    )

    const step = await readStep(runId, "deliver")
    expect(step.status).toBe("complete")
    expect(step.summary).toBe("Simulated external estimate ERP-SIM-1 accepted.")
    expect(step.completed_at).not.toBeNull()

    const run = await readRun(runId)
    expect(run.status).toBe("complete")
    expect(run.workflow_state).toBe("delivered")
  })

  it("pins every timestamp to the moment the caller supplies", async () => {
    const runId = await seedRun()

    await env.DB.batch(
      createRunStepRecorder(env, runId, "deliver").completeStatements(
        "Simulated external estimate ERP-SIM-1 accepted.",
        { at: DELIVERED_AT }
      )
    )

    // One moment across the step and the run, which is what lets delivery tie
    // its graph to the stored `delivered_at`.
    const step = await readStep(runId, "deliver")
    expect(step.started_at).toBe(DELIVERED_AT)
    expect(step.completed_at).toBe(DELIVERED_AT)
    expect(step.updated_at).toBe(DELIVERED_AT)

    expect((await readRun(runId)).updated_at).toBe(DELIVERED_AT)
  })

  it("always emits the step statement and the run statement", async () => {
    const runId = await seedRun()

    expect(
      createRunStepRecorder(env, runId, "deliver").completeStatements(
        "Accepted."
      )
    ).toHaveLength(2)
  })

  it("refuses a bad summary or an undefined outcome before composing", async () => {
    const runId = await seedRun()

    expect(() =>
      createRunStepRecorder(env, runId, "read-documents").completeStatements(
        null
      )
    ).toThrow(/must supply a summary/)

    expect(() =>
      createRunStepRecorder(env, runId, "rfq-received").completeStatements(
        "Overwritten."
      )
    ).toThrow(/keeps the summary it was created with/)

    expect(() =>
      createRunStepRecorder(env, runId, "review-required").completeStatements(
        "Done."
      )
    ).toThrow(/No workflow state is defined/)
  })
})

describe("holding a step", () => {
  it("says why pricing waits without leaving the waiting state", async () => {
    const runId = await seedRun()

    await createRunStepRecorder(env, runId, "build-estimate").hold(
      "Waiting for owner review before pricing. Two matches need a decision."
    )

    const step = await readStep(runId, "build-estimate")
    expect(step.status).toBe("waiting")
    expect(step.summary).toBe(
      "Waiting for owner review before pricing. Two matches need a decision."
    )
    expect(step.started_at).toBeNull()

    const run = await readRun(runId)
    expect(run.status).toBe("active")
    expect(run.workflow_state).toBe("awaiting_review")
  })

  it("leaves a step that already moved on alone, but still moves the run", async () => {
    const runId = await seedRun()
    const recorder = createRunStepRecorder(env, runId, "build-estimate")

    await recorder.complete("Priced 4 lines.")
    await recorder.hold("Waiting for owner review before pricing.")

    const step = await readStep(runId, "build-estimate")
    expect(step.status).toBe("complete")
    expect(step.summary).toBe("Priced 4 lines.")

    expect((await readRun(runId)).workflow_state).toBe("awaiting_review")
  })

  it("refuses steps that never hold", async () => {
    const runId = await seedRun()

    await expect(
      createRunStepRecorder(env, runId, "read-documents").hold("Waiting…")
    ).rejects.toThrow(/No workflow state is defined/)
  })
})

describe("failing a step", () => {
  const stepKeys: RunStepKey[] = [
    "read-documents",
    "structure-rfq",
    "resolve-customer",
    "retrieve-candidates",
    "match-products",
    "build-estimate",
  ]

  for (const stepKey of stepKeys) {
    it(`fails the run when ${stepKey} errors`, async () => {
      const runId = await seedRun()

      await createRunStepRecorder(env, runId, stepKey).fail(
        "The step could not be completed."
      )

      const step = await readStep(runId, stepKey)
      expect(step.status).toBe("error")
      expect(step.summary).toBe("The step could not be completed.")
      expect(step.completed_at).not.toBeNull()

      const run = await readRun(runId)
      expect(run.status).toBe("error")
      expect(run.workflow_state).toBe("failed")
    })
  }

  it("fails the run when the review node cannot be opened", async () => {
    const runId = await seedRun()
    const recorder = createRunStepRecorder(env, runId, "review-required")

    await recorder.insertConditionalStep({
      title: REVIEW_STEP_TITLE,
      summary: "Two matches need a decision.",
    })
    await recorder.fail("The review node could not be opened.")

    const step = await readStep(runId, "review-required")
    expect(step.status).toBe("error")
    expect(step.summary).toBe("The review node could not be opened.")
    expect(step.completed_at).not.toBeNull()

    const run = await readRun(runId)
    expect(run.status).toBe("error")
    expect(run.workflow_state).toBe("failed")
  })
})

describe("attaching evidence", () => {
  it("writes one row per kind and replaces the payload on the next attempt", async () => {
    const runId = await seedRun()
    const recorder = createRunStepRecorder(env, runId, "read-documents")

    await recorder.attachEvidence("documents", { pages: 1 })
    await recorder.attachEvidence("documents", { pages: 7 })
    await recorder.attachEvidence("sources", { count: 3 })

    expect(await readEvidence(runId)).toEqual([
      {
        step_key: "read-documents",
        kind: "documents",
        payload: JSON.stringify({ pages: 7 }),
      },
      {
        step_key: "read-documents",
        kind: "sources",
        payload: JSON.stringify({ count: 3 }),
      },
    ])
  })

  it("keeps each step's evidence to itself", async () => {
    const runId = await seedRun()

    await createRunStepRecorder(env, runId, "read-documents").attachEvidence(
      "shared",
      { from: "read" }
    )
    await createRunStepRecorder(env, runId, "structure-rfq").attachEvidence(
      "shared",
      { from: "structure" }
    )

    const rows = await readEvidence(runId)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.step_key).sort()).toEqual([
      "read-documents",
      "structure-rfq",
    ])
  })
})

describe("inserting the conditional review step", () => {
  it("places the review after matching and shifts the later steps down", async () => {
    const runId = await seedRun()

    await createRunStepRecorder(
      env,
      runId,
      "review-required"
    ).insertConditionalStep({
      title: REVIEW_STEP_TITLE,
      summary: "Two matches need a decision.",
      blocks: {
        stepKey: "build-estimate",
        summary:
          "Waiting for owner review before pricing. Two matches need a decision.",
      },
    })

    const steps = await readSteps(runId)
    expect(steps.map((step) => step.step_key)).toEqual([
      "rfq-received",
      "read-documents",
      "structure-rfq",
      "resolve-customer",
      "retrieve-candidates",
      "match-products",
      "review-required",
      "build-estimate",
      "deliver",
    ])

    const review = await readStep(runId, "review-required")
    expect(review.position).toBe(6)
    expect(review.title).toBe(REVIEW_STEP_TITLE)
    expect(review.status).toBe("review_required")
    expect(review.summary).toBe("Two matches need a decision.")
    expect(review.started_at).not.toBeNull()
    expect(review.completed_at).toBeNull()

    const blocked = await readStep(runId, "build-estimate")
    expect(blocked.status).toBe("waiting")
    expect(blocked.summary).toBe(
      "Waiting for owner review before pricing. Two matches need a decision."
    )

    const run = await readRun(runId)
    expect(run.status).toBe("active")
    expect(run.workflow_state).toBe("awaiting_review")
  })

  it("re-states an existing review rather than inserting a second one", async () => {
    const runId = await seedRun()
    const recorder = createRunStepRecorder(env, runId, "review-required")

    await recorder.insertConditionalStep({
      title: REVIEW_STEP_TITLE,
      summary: "Two matches need a decision.",
    })
    await recorder.insertConditionalStep({
      title: REVIEW_STEP_TITLE,
      summary: "Three matches need a decision.",
    })

    const steps = await readSteps(runId)
    expect(steps).toHaveLength(9)

    const review = await readStep(runId, "review-required")
    expect(review.summary).toBe("Three matches need a decision.")
    // The shift runs before the conflicting insert, so a second call moves the
    // review row and everything below it down again. Recorded, not corrected:
    // the review slice never reopens a node it already inserted.
    expect(review.position).toBe(7)
  })

  it("refuses steps that are not conditional", async () => {
    const runId = await seedRun()

    await expect(
      createRunStepRecorder(env, runId, "build-estimate").insertConditionalStep(
        {
          title: "Build estimate",
          summary: "…",
        }
      )
    ).rejects.toThrow(/No workflow state is defined/)
  })
})
