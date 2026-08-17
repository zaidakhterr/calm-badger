/**
 * The Run-step recorder.
 *
 * A run step's lifecycle — `begin`, `hold`, `complete`, `fail`, its evidence,
 * the conditional `Review required` insertion, and the nudge that gives a
 * waiting step a better sentence — is written here and nowhere else. Steps hand
 * over the human summary text; the recorder owns status, timestamps, and the
 * run's `workflow_state`.
 *
 * `workflow_state` is never named by a step. It is derived from
 * `(stepKey, outcome[, variant])` through the table below, which was captured
 * from the per-step copies this module replaces. Every row is verbatim: the
 * `COALESCE(started_at, …)` semantics, which statements touch `runs.status`,
 * and the `AND status = 'waiting'` guards are the existing behaviour, not a
 * redesign. An unknown `(step, outcome)` pair throws rather than writing a
 * state nobody chose.
 *
 * Each method issues one `DB.batch` (`insertConditionalStep` reads its anchor
 * position first, exactly as the review slice does today). There is no
 * cross-method transaction, which matches the callers being replaced.
 */

/**
 * The step keys the recorder knows. Deliberately a local union rather than an
 * import of the `*_STEP_KEY` constants: every step module will import this
 * module once the callers are migrated, so importing them back would make the
 * cycle real. `runs.ts` remains the owner of `WORKFLOW_STEPS`, and the two
 * lists are checked against each other by `test/run-steps.test.ts`.
 */
export type RunStepKey =
  | "rfq-received"
  | "read-documents"
  | "structure-rfq"
  | "resolve-customer"
  | "retrieve-candidates"
  | "match-products"
  | "review-required"
  | "build-estimate"
  | "deliver"
  | "delivered"

/** Which `complete` a step means, when a step has more than one ending. */
export type CompleteVariant =
  "resolved" | "unresolved" | "approved" | "rejected" | "expired"

/** The shape of one `complete` row: what it writes to the step and the run. */
type CompleteRow = {
  /** The status the step lands in. `rejected` and `expired` are endings, not successes. */
  stepStatus: "complete" | "error"
  /** `false` only for `rfq-received`, whose receipt summary is written at creation. */
  setSummary: boolean
  /** `coalesce` for steps that may never have been begun. */
  startedAt: "untouched" | "coalesce"
  /** `coalesce` keeps a replayed durable step idempotent. */
  completedAt: "set" | "coalesce"
  /** `null` where the source batch leaves the run's state to a sibling step. */
  workflowState: string | null
  /** Set only where the source statement also moves `runs.status`. */
  runStatus?: "error" | "complete"
}

const DEFAULT_VARIANT = "default"

/** `(stepKey → workflow_state)` for `begin`. Steps absent here cannot begin. */
const BEGIN_STATES: Partial<Record<RunStepKey, string>> = {
  "read-documents": "reading_documents",
  "structure-rfq": "structuring_rfq",
  "resolve-customer": "resolving_customer",
  "retrieve-candidates": "retrieving_candidates",
  "match-products": "matching_products",
}

/** `(stepKey → workflow_state)` for `hold`. Only pricing waits for a human. */
const HOLD_STATES: Partial<Record<RunStepKey, string>> = {
  "build-estimate": "awaiting_review",
}

/** `(stepKey, variant → row)` for `complete`. */
const COMPLETE_ROWS: Partial<
  Record<RunStepKey, Partial<Record<string, CompleteRow>>>
> = {
  "rfq-received": {
    // The request handler already wrote the receipt row; the durable
    // orchestrator only confirms it owns the run, so neither the summary nor
    // an existing completion timestamp is overwritten.
    [DEFAULT_VARIANT]: {
      stepStatus: "complete",
      setSummary: false,
      startedAt: "untouched",
      completedAt: "coalesce",
      workflowState: "accepted",
    },
  },
  "read-documents": {
    [DEFAULT_VARIANT]: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "untouched",
      completedAt: "set",
      workflowState: "documents_read",
    },
  },
  "structure-rfq": {
    [DEFAULT_VARIANT]: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "untouched",
      completedAt: "set",
      workflowState: "rfq_structured",
    },
  },
  "resolve-customer": {
    [DEFAULT_VARIANT]: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "untouched",
      completedAt: "set",
      workflowState: "customer_resolved",
    },
    resolved: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "untouched",
      completedAt: "set",
      workflowState: "customer_resolved",
    },
    // No catalogue customer matched. The run continues; identity stays open.
    unresolved: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "untouched",
      completedAt: "set",
      workflowState: "customer_unresolved",
    },
  },
  "retrieve-candidates": {
    [DEFAULT_VARIANT]: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "untouched",
      completedAt: "set",
      workflowState: "candidates_retrieved",
    },
  },
  "match-products": {
    [DEFAULT_VARIANT]: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "untouched",
      completedAt: "set",
      workflowState: "products_matched",
    },
  },
  "review-required": {
    approved: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "untouched",
      completedAt: "set",
      workflowState: "review_approved",
    },
    // A rejected or expired review ends the run where it stands: the step and
    // the run both go to error, and the later nodes keep waiting forever.
    rejected: {
      stepStatus: "error",
      setSummary: true,
      startedAt: "untouched",
      completedAt: "set",
      workflowState: "review_rejected",
      runStatus: "error",
    },
    expired: {
      stepStatus: "error",
      setSummary: true,
      startedAt: "untouched",
      completedAt: "set",
      workflowState: "review_expired",
      runStatus: "error",
    },
  },
  "build-estimate": {
    // Pricing has no `begin`, so its completion is also where `started_at`
    // first appears.
    [DEFAULT_VARIANT]: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "coalesce",
      completedAt: "set",
      workflowState: "estimate_built",
    },
  },
  deliver: {
    // Delivery's two steps commit together in the source batch, and the run's
    // state belongs to `delivered`, not to this row.
    [DEFAULT_VARIANT]: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "coalesce",
      completedAt: "set",
      workflowState: null,
    },
  },
  delivered: {
    [DEFAULT_VARIANT]: {
      stepStatus: "complete",
      setSummary: true,
      startedAt: "coalesce",
      completedAt: "set",
      workflowState: "delivered",
      runStatus: "complete",
    },
  },
}

/** `(stepKey → row)` for `insertConditionalStep`. */
const CONDITIONAL_STEPS: Partial<
  Record<
    RunStepKey,
    {
      /** The step the conditional one is inserted after. */
      anchorStepKey: RunStepKey
      /** Used when the anchor is missing, matching the source fallback. */
      anchorFallbackPosition: number
      workflowState: string
    }
  >
> = {
  "review-required": {
    anchorStepKey: "match-products",
    anchorFallbackPosition: 5,
    workflowState: "awaiting_review",
  },
}

/** Every failure is the same ending: the step errors and the run fails. */
const FAILED_WORKFLOW_STATE = "failed"

export type RunStepRecorder = {
  readonly stepKey: RunStepKey
  /** The step is working. Idempotent on `started_at`. */
  begin(summary: string): Promise<void>
  /** The step stops short and stays waiting, saying why. Only if still waiting. */
  hold(summary: string): Promise<void>
  /**
   * The step ends. `summary` is `null` only for steps whose row preserves the
   * existing sentence (`rfq-received`), and required everywhere else.
   */
  complete(
    summary: string | null,
    options?: { variant?: CompleteVariant }
  ): Promise<void>
  /** The step errored, and so did the run. No opt-out. */
  fail(message: string): Promise<void>
  /** Upserts this step's evidence of `kind`, stringifying the payload. */
  attachEvidence(kind: string, payload: unknown): Promise<void>
  /** Inserts the conditional step after its anchor, shifting later steps down. */
  insertConditionalStep(options: {
    title: string
    summary: string
    blocks?: { stepKey: RunStepKey; summary: string }
  }): Promise<void>
  /** Gives another still-waiting step a summary that says what it waits for. */
  setWaitingSummary(stepKey: RunStepKey, summary: string): Promise<void>
}

/**
 * Binds a recorder to one run and one step. Created inside a step function and
 * used for that step's whole lifecycle.
 */
export function createRunStepRecorder(
  env: Env,
  runId: string,
  stepKey: RunStepKey
): RunStepRecorder {
  /**
   * `null` where the row writes nothing to the run at all — `deliver` leaves
   * that to `delivered`, which the source commits in the same batch.
   */
  const runsUpdate = (
    now: string,
    workflowState: string | null,
    runStatus?: "error" | "complete"
  ): D1PreparedStatement | null => {
    if (workflowState === null && !runStatus) return null

    const assignments = [
      runStatus ? "status = ?" : null,
      workflowState === null ? null : "workflow_state = ?",
      "updated_at = ?",
    ].filter((assignment) => assignment !== null)

    const bindings = [
      ...(runStatus ? [runStatus] : []),
      ...(workflowState === null ? [] : [workflowState]),
      now,
      runId,
    ]

    return env.DB.prepare(
      `UPDATE runs SET ${assignments.join(", ")} WHERE id = ?`
    ).bind(...bindings)
  }

  /** One method, one batch. Absent statements are dropped, not sent as no-ops. */
  const write = async (
    statements: (D1PreparedStatement | null)[]
  ): Promise<void> => {
    await env.DB.batch(statements.filter((statement) => statement !== null))
  }

  const waitingSummaryUpdate = (
    now: string,
    targetStepKey: RunStepKey,
    summary: string
  ): D1PreparedStatement =>
    env.DB.prepare(
      `UPDATE run_steps SET summary = ?, updated_at = ?
        WHERE run_id = ? AND step_key = ? AND status = 'waiting'`
    ).bind(summary, now, runId, targetStepKey)

  return {
    stepKey,

    async begin(summary: string): Promise<void> {
      const workflowState = BEGIN_STATES[stepKey]
      if (!workflowState) throw unknownOutcome(stepKey, "begin")

      const now = new Date().toISOString()

      await write([
        env.DB.prepare(
          `UPDATE run_steps
              SET status = 'active',
                  summary = ?,
                  started_at = COALESCE(started_at, ?),
                  updated_at = ?
            WHERE run_id = ? AND step_key = ?`
        ).bind(summary, now, now, runId, stepKey),
        runsUpdate(now, workflowState),
      ])
    },

    async hold(summary: string): Promise<void> {
      const workflowState = HOLD_STATES[stepKey]
      if (!workflowState) throw unknownOutcome(stepKey, "hold")

      const now = new Date().toISOString()

      await write([
        waitingSummaryUpdate(now, stepKey, summary),
        runsUpdate(now, workflowState),
      ])
    },

    async complete(
      summary: string | null,
      options?: { variant?: CompleteVariant }
    ): Promise<void> {
      const variant = options?.variant ?? DEFAULT_VARIANT
      const row = COMPLETE_ROWS[stepKey]?.[variant]
      if (!row) throw unknownOutcome(stepKey, `complete:${variant}`)

      if (row.setSummary && summary === null) {
        throw new Error(
          `The ${stepKey} step must supply a summary when it completes`
        )
      }
      if (!row.setSummary && summary !== null) {
        throw new Error(
          `The ${stepKey} step keeps the summary it was created with`
        )
      }

      const now = new Date().toISOString()

      const assignments = [
        `status = '${row.stepStatus}'`,
        row.setSummary ? "summary = ?" : null,
        row.startedAt === "coalesce"
          ? "started_at = COALESCE(started_at, ?)"
          : null,
        row.completedAt === "coalesce"
          ? "completed_at = COALESCE(completed_at, ?)"
          : "completed_at = ?",
        "updated_at = ?",
      ].filter((assignment) => assignment !== null)

      const bindings = [
        ...(row.setSummary ? [summary as string] : []),
        ...(row.startedAt === "coalesce" ? [now] : []),
        now,
        now,
        runId,
        stepKey,
      ]

      await write([
        env.DB.prepare(
          `UPDATE run_steps SET ${assignments.join(", ")}
            WHERE run_id = ? AND step_key = ?`
        ).bind(...bindings),
        runsUpdate(now, row.workflowState, row.runStatus),
      ])
    },

    async fail(message: string): Promise<void> {
      const now = new Date().toISOString()

      await write([
        env.DB.prepare(
          `UPDATE run_steps
              SET status = 'error', summary = ?, completed_at = ?, updated_at = ?
            WHERE run_id = ? AND step_key = ?`
        ).bind(message, now, now, runId, stepKey),
        runsUpdate(now, FAILED_WORKFLOW_STATE, "error"),
      ])
    },

    async attachEvidence(kind: string, payload: unknown): Promise<void> {
      const now = new Date().toISOString()

      await write([
        env.DB.prepare(
          `INSERT INTO run_step_evidence (id, run_id, step_key, kind, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id, step_key, kind) DO UPDATE SET
             payload = excluded.payload,
             created_at = excluded.created_at`
        ).bind(
          crypto.randomUUID(),
          runId,
          stepKey,
          kind,
          JSON.stringify(payload),
          now
        ),
      ])
    },

    async insertConditionalStep(options: {
      title: string
      summary: string
      blocks?: { stepKey: RunStepKey; summary: string }
    }): Promise<void> {
      const row = CONDITIONAL_STEPS[stepKey]
      if (!row) throw unknownOutcome(stepKey, "insert")

      const now = new Date().toISOString()

      const anchor = await env.DB.prepare(
        `SELECT position FROM run_steps WHERE run_id = ? AND step_key = ?`
      )
        .bind(runId, row.anchorStepKey)
        .first<{ position: number }>()

      const position = (anchor?.position ?? row.anchorFallbackPosition) + 1

      await write([
        env.DB.prepare(
          `UPDATE run_steps SET position = position + 1, updated_at = ?
            WHERE run_id = ? AND position >= ?`
        ).bind(now, runId, position),
        env.DB.prepare(
          `INSERT INTO run_steps (
             id, run_id, step_key, position, title, status, summary,
             started_at, completed_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'review_required', ?, ?, NULL, ?)
           ON CONFLICT (run_id, step_key) DO UPDATE SET
             status = 'review_required',
             summary = excluded.summary,
             updated_at = excluded.updated_at`
        ).bind(
          crypto.randomUUID(),
          runId,
          stepKey,
          position,
          options.title,
          options.summary,
          now,
          now
        ),
        // The node that is actually blocked says so, rather than leaving its
        // generic waiting copy in place while the graph stops above it.
        ...(options.blocks
          ? [
              waitingSummaryUpdate(
                now,
                options.blocks.stepKey,
                options.blocks.summary
              ),
            ]
          : []),
        runsUpdate(now, row.workflowState),
      ])
    },

    async setWaitingSummary(
      targetStepKey: RunStepKey,
      summary: string
    ): Promise<void> {
      const now = new Date().toISOString()

      await write([waitingSummaryUpdate(now, targetStepKey, summary)])
    },
  }
}

function unknownOutcome(stepKey: RunStepKey, outcome: string): Error {
  return new Error(`No workflow state is defined for ${stepKey}/${outcome}`)
}
