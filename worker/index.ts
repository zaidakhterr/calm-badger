import { z } from "zod"

import { capturePageview, captureFunnelEvent, logRoute } from "./analytics"
import { loadQuote } from "./build-estimate"
import { CATALOGUE_SECTION_SCHEMA, loadCatalogueProjection } from "./catalogue"
import { ConfigError, readConfig } from "./env"
import {
  loadCandidateEvidence,
  loadCustomerEvidence,
  loadDeliveryEvidence,
  loadDocumentEvidence,
  loadEstimateEvidence,
  loadMatchEvidence,
  loadReceivedEvidence,
  loadStructureEvidence,
} from "./evidence"
import { OWNER_FEEDBACK_BODY_SCHEMA, recordOwnerFeedback } from "./feedback"
import {
  loadReviewEvidence,
  recordDecisions,
  REVIEW_DECISION_SCHEMA,
  REVIEW_DECISIONS_BODY_SCHEMA,
  REVIEW_EVENT_TYPE,
  REVIEW_SETTLEMENT_BODY_SCHEMA,
  searchReviewCatalog,
  searchReviewCustomers,
  settleReview,
  type DecisionInput,
} from "./review"
import {
  authorizeOwner,
  createRun,
  CURATED_RUN_BODY_SCHEMA,
  deleteRun,
  isOwnerRequest,
  loadRun,
  resolveRunId,
  workflowInstanceId,
  type RunInput,
} from "./runs"
import { checkRateLimit, visitorHash } from "./rate-limit"
import { runRetentionSweep } from "./retention"
import { scenarioPreviews } from "./scenarios"
import { loadSystemDetails } from "./system"
import {
  loadSources,
  MAX_UPLOAD_BYTES,
  toArrayBuffer,
  UPLOAD_MEDIA_TYPE_SCHEMA,
  validateCustomSubmission,
} from "./sources"

export { RfqWorkflow } from "./workflow"

type HealthResponse = {
  status: "ok"
  environment: string
  services: {
    d1: "ready"
    r2: "ready"
    workflow: "configured"
  }
  timestamp: string
}

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url)
    const requestId = crypto.randomUUID()
    // A view identifier is a bearer read-link and a query string can carry
    // anything, so the log records the route that was taken, not the URL that
    // was requested. Operators still get method, route, status, and timing.
    const route = logRoute(url.pathname)

    // Configuration is parsed before anything is routed, so a misconfigured
    // deployment says so once, on the first request, rather than halfway
    // through a run that has already spent a provider call. Parsing is
    // memoized per isolate, so this costs one map lookup afterwards.
    try {
      readConfig(env)
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "config_invalid",
          requestId,
          route,
          // The variables that are wrong and why, never their values.
          issues: error instanceof ConfigError ? error.issues : [],
        })
      )

      return Response.json(
        { error: "Internal server error", requestId },
        { status: 500, headers: jsonHeaders }
      )
    }

    try {
      const response = await routeRequest(request, env, url, ctx)

      console.log(
        JSON.stringify({
          event: "http_request",
          requestId,
          method: request.method,
          route,
          status: response.status,
        })
      )

      // Measurement never stands between a built response and its caller. A
      // failure here would otherwise fall into the catch below and turn a
      // response that was already built into a 500.
      try {
        await capturePageview(env, ctx, request, response)
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "pageview_capture_failed",
            requestId,
            error: error instanceof Error ? error.name : "unknown",
          })
        )
      }

      return response
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "http_request_failed",
          requestId,
          method: request.method,
          route,
          // The name of the failure, never its message: a binding error can
          // carry a query, a storage path, or a key in its text.
          error: error instanceof Error ? error.name : "unknown",
        })
      )

      return Response.json(
        { error: "Internal server error", requestId },
        { status: 500, headers: jsonHeaders }
      )
    }
  },

  /**
   * The daily cleanup. One bounded batch: whatever it cannot finish is left
   * for the next schedule, and a partially purged run is picked up first.
   */
  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): void {
    ctx.waitUntil(sweepQuietly(env, new Date(controller.scheduledTime)))
  },
} satisfies ExportedHandler<Env>

/**
 * The sweep, with its failure kept off the schedule. A cleanup that could not
 * run is a log line and a run left for tomorrow, never an unhandled rejection.
 */
async function sweepQuietly(env: Env, now: Date): Promise<void> {
  try {
    await runRetentionSweep(env, { now, trigger: "scheduled" })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "retention_sweep_failed",
        error: error instanceof Error ? error.name : "unknown",
      })
    )
  }
}

async function routeRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  if (url.pathname === "/api/health") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET")
    }

    return healthResponse(env)
  }

  if (url.pathname === "/api/scenarios") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET")
    }

    // Curated source material only. Expected outcomes live only in the
    // Langfuse dataset, so the Worker has nothing to serve.
    return Response.json(
      { scenarios: scenarioPreviews() },
      { headers: jsonHeaders }
    )
  }

  if (url.pathname === "/api/system") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET")
    }

    // Configuration and catalogue scale, read from what the workflow uses. No
    // secret, key, or run content is part of this projection.
    return Response.json(
      { system: await loadSystemDetails(env) },
      { headers: jsonHeaders }
    )
  }

  const catalogueMatch = /^\/api\/catalogue\/([^/]+)$/.exec(url.pathname)

  if (catalogueMatch) {
    const section = CATALOGUE_SECTION_SCHEMA.safeParse(catalogueMatch[1])

    if (!section.success) {
      return Response.json(
        { error: "Catalogue section not found" },
        { status: 404, headers: jsonHeaders }
      )
    }

    if (request.method !== "GET") {
      return methodNotAllowed("GET")
    }

    return Response.json(
      { catalogue: await loadCatalogueProjection(env, section.data) },
      { headers: jsonHeaders }
    )
  }

  if (url.pathname === "/api/runs") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST")
    }

    return createRunResponse(request, env, ctx)
  }

  const runMatch =
    /^\/api\/runs\/([A-Za-z0-9_-]+)(?:\/(reset|received|documents|structure|customer|candidates|matches|estimate|delivery|quote|review|feedback)|\/review\/(decisions|catalog|customers)|\/sources\/([A-Za-z0-9-]+))?$/.exec(
      url.pathname
    )

  if (runMatch) {
    const [, viewId, segment, reviewSegment, sourceId] = runMatch

    if (reviewSegment === "decisions") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST")
      }

      return reviewDecisionsResponse(request, env, viewId)
    }

    if (reviewSegment === "catalog" || reviewSegment === "customers") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET")
      }

      return reviewSearchResponse(request, env, viewId, reviewSegment, url)
    }

    if (segment === "review" && request.method === "POST") {
      return reviewDecisionResponse(request, env, ctx, viewId)
    }

    if (segment === "feedback") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST")
      }

      return ownerFeedbackResponse(request, env, viewId)
    }

    if (segment === "reset") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST")
      }

      return resetRunResponse(request, env, viewId)
    }

    if (request.method !== "GET") {
      return methodNotAllowed("GET")
    }

    if (segment === "quote") {
      return quoteDownloadResponse(env, viewId)
    }

    if (segment === "review") {
      return reviewViewResponse(env, viewId)
    }

    if (
      segment === "received" ||
      segment === "documents" ||
      segment === "structure" ||
      segment === "customer" ||
      segment === "candidates" ||
      segment === "matches" ||
      segment === "estimate" ||
      segment === "delivery"
    ) {
      return stepEvidenceResponse(env, viewId, segment)
    }

    if (sourceId) {
      return sourcePreviewResponse(env, viewId, sourceId)
    }

    return runViewResponse(request, env, viewId)
  }

  if (url.pathname.startsWith("/api/")) {
    return Response.json(
      { error: "API route not found" },
      { status: 404, headers: jsonHeaders }
    )
  }

  return env.ASSETS.fetch(request)
}

/** Writes explicit owner feedback without exposing Langfuse credentials. */
async function ownerFeedbackResponse(
  request: Request,
  env: Env,
  viewId: string
): Promise<Response> {
  const authorization = await authorizeOwner(
    env,
    viewId,
    request.headers.get("authorization")
  )

  if (!authorization.ok) return ownerRejection(authorization.reason)

  const body = await readJsonBody(request, OWNER_FEEDBACK_BODY_SCHEMA)

  if (!body.ok) {
    return Response.json(
      { error: "Choose a known feedback target and a thumbs value." },
      { status: 400, headers: jsonHeaders }
    )
  }

  const outcome = await recordOwnerFeedback(
    env,
    authorization.runId,
    body.value
  )

  if (outcome.state === "before_matches") {
    return Response.json(
      { error: "Feedback is available after product matches." },
      { status: 409, headers: jsonHeaders }
    )
  }

  if (outcome.state === "unknown_line") {
    return Response.json(
      { error: "This run does not have that matched line." },
      { status: 400, headers: jsonHeaders }
    )
  }

  if (outcome.state === "unavailable") {
    return Response.json(
      { error: "Feedback could not be saved right now. Try again later." },
      { status: 503, headers: jsonHeaders }
    )
  }

  return Response.json({ status: "recorded" }, { headers: jsonHeaders })
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "Method not allowed" },
    { status: 405, headers: { ...jsonHeaders, allow } }
  )
}

async function createRunResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const media = readRunRequestMedia(request)

  if (!media) {
    return Response.json(
      {
        error: "Run requests must use application/json or multipart/form-data.",
      },
      {
        status: 415,
        headers: {
          ...jsonHeaders,
          "accept-post": "application/json, multipart/form-data",
        },
      }
    )
  }

  const { kind } = media

  // Counted before the body is read: processing is what costs money, so the
  // limit applies before an upload is buffered and long before a provider is
  // called. Reading an existing run is never limited.
  const limit = await checkRateLimit(env, request)

  if (!limit.allowed) {
    console.log(
      JSON.stringify({
        event: "run_rate_limited",
        sourceKind: kind,
        limit: limit.limit,
        windowSeconds: limit.windowSeconds,
      })
    )

    captureFunnelEvent(env, ctx, {
      event: "rfq_run_rate_limited",
      distinctId: await analyticsVisitorId(env, request),
      properties: { source_kind: kind },
    })

    return Response.json(
      {
        error: `You can start ${limit.limit} runs each hour. Try again in approximately ${Math.ceil(limit.retryAfterSeconds / 60)} minutes. You can still open a stored run.`,
        limit: limit.limit,
        windowSeconds: limit.windowSeconds,
        retryAfterSeconds: limit.retryAfterSeconds,
        resetAt: limit.resetAt,
      },
      {
        status: 429,
        headers: {
          ...jsonHeaders,
          "retry-after": String(limit.retryAfterSeconds),
        },
      }
    )
  }

  // Both supported representations are buffered through a hard ceiling before
  // either JSON.parse or the platform multipart parser sees a byte. A missing
  // or dishonest Content-Length therefore cannot turn either path into an
  // unbounded allocation.
  const body = await readBoundedBody(request, media.maxBytes)
  const input = body.ok
    ? kind === "custom"
      ? await readCustomInput(body.bytes, media.contentType)
      : readCuratedInput(request, body.bytes)
    : rejectedRunBody(kind, body.reason)

  if (input.ok) {
    // The anonymous workspace this browser learns in. It is optional, opaque,
    // and only ever stored as a hash; it identifies no person and unlocks
    // nothing but wording this same browser confirmed earlier.
    input.value.workspaceId = readWorkspaceId(request)
  }

  if (!input.ok) {
    // Nothing is persisted and no provider is called for a rejected request.
    console.log(
      JSON.stringify({ event: "run_rejected", reason: input.reasonCode })
    )

    captureFunnelEvent(env, ctx, {
      event: "rfq_run_rejected",
      distinctId: await analyticsVisitorId(env, request),
      // A reason code, from a fixed list. Never the file, its name, or the
      // message the visitor is about to read.
      properties: { source_kind: kind, reason: input.reasonCode },
    })

    return Response.json(
      { error: input.error },
      { status: 400, headers: jsonHeaders }
    )
  }

  const { runId, run, ownerCapability } = await createRun(env, input.value)

  console.log(
    JSON.stringify({
      event: "run_created",
      runId,
      sourceKind: input.value.kind,
      scenarioId:
        input.value.kind === "curated" ? input.value.scenarioId : null,
      steps: run.steps.length,
    })
  )

  // The funnel starts here. The run identifier is the distinct id, so a funnel
  // is a run's own progress rather than a visitor's history.
  captureFunnelEvent(env, ctx, {
    event: "rfq_run_started",
    distinctId: runId,
    properties: {
      source_kind: input.value.kind,
      scenario_id:
        input.value.kind === "curated" ? input.value.scenarioId : "none",
    },
  })

  // The plaintext owner capability is returned exactly once, here.
  return Response.json(
    { run, viewer: ownerViewer(true), ownerCapability },
    { status: 201, headers: jsonHeaders }
  )
}

type InputResult =
  | { ok: true; value: RunInput }
  | { ok: false; error: string; reasonCode: string }

/**
 * The hard ceiling on a request body. The upload policy itself lives in
 * `sources.ts`; this is the transport bound that keeps an oversized or
 * open-ended body from being buffered before that policy can be applied. The
 * headroom above the 10 MB upload limit is for multipart framing.
 */
const MAX_MULTIPART_REQUEST_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 1.1)
const MAX_JSON_REQUEST_BYTES = 16 * 1024

type RunRequestMedia =
  | {
      kind: "curated"
      contentType: string
      maxBytes: typeof MAX_JSON_REQUEST_BYTES
    }
  | {
      kind: "custom"
      contentType: string
      maxBytes: typeof MAX_MULTIPART_REQUEST_BYTES
    }

/**
 * HTTP media type tokens are case-insensitive. Parameters are preserved for
 * the multipart boundary, while the essence is normalized for the platform
 * parser that receives the already-bounded body.
 */
function readRunRequestMedia(request: Request): RunRequestMedia | null {
  const raw = request.headers.get("content-type")?.trim()
  if (!raw) return null

  const separator = raw.indexOf(";")
  const essence = (separator === -1 ? raw : raw.slice(0, separator))
    .trim()
    .toLowerCase()
  const parameters = separator === -1 ? "" : raw.slice(separator)

  if (essence === "application/json") {
    return {
      kind: "curated",
      contentType: `application/json${parameters}`,
      maxBytes: MAX_JSON_REQUEST_BYTES,
    }
  }

  if (essence === "multipart/form-data") {
    return {
      kind: "custom",
      contentType: `multipart/form-data${parameters}`,
      maxBytes: MAX_MULTIPART_REQUEST_BYTES,
    }
  }

  return null
}

type BoundedBody =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "unreadable" }

/** The body, abandoned as soon as it exceeds the representation's ceiling. */
async function readBoundedBody(
  request: Request,
  maxBytes: number
): Promise<BoundedBody> {
  const declaredLength = request.headers.get("content-length")?.trim() ?? ""

  if (/^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    return { ok: false, reason: "too_large" }
  }

  if (!request.body) return { ok: true, bytes: new Uint8Array(0) }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      total += value.byteLength

      if (total > maxBytes) {
        await reader.cancel()
        return { ok: false, reason: "too_large" }
      }

      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: "unreadable" }
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return { ok: true, bytes: body }
}

function rejectedRunBody(
  kind: RunRequestMedia["kind"],
  reason: "too_large" | "unreadable"
): InputResult {
  if (reason === "unreadable") {
    return {
      ok: false,
      error: "The system could not read the request",
      reasonCode: "unreadable_body",
    }
  }

  return kind === "custom"
    ? {
        ok: false,
        error: `The request is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`,
        reasonCode: "upload_too_large",
      }
    : {
        ok: false,
        error: "The JSON run request is too large",
        reasonCode: "json_too_large",
      }
}

/** The rotating hash used as a distinct id before a run exists. */
async function analyticsVisitorId(env: Env, request: Request): Promise<string> {
  const hourMs = 60 * 60 * 1000

  return visitorHash(
    env,
    request,
    "analytics",
    new Date(Math.floor(Date.now() / hourMs) * hourMs)
  )
}

/** An opaque browser-generated token, bounded and never logged. */
function readWorkspaceId(request: Request): string | null {
  const value = request.headers.get("x-workspace-id")?.trim() ?? ""

  return value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null
}

function readCuratedInput(request: Request, bytes: Uint8Array): InputResult {
  const body = parseJsonBody(
    new TextDecoder().decode(bytes),
    CURATED_RUN_BODY_SCHEMA
  )

  if (!body.ok) {
    return {
      ok: false,
      error: "A known curated scenario is required",
      reasonCode: "unknown_scenario",
    }
  }

  return {
    ok: true,
    value: {
      kind: "curated",
      scenarioId: body.value.scenarioId,
      requestUrl: request.url,
    },
  }
}

/**
 * Custom submissions are validated before anything is stored, so an
 * unsupported type or an oversized upload cannot reach a paid provider.
 */
async function readCustomInput(
  bytes: Uint8Array,
  contentType: string
): Promise<InputResult> {
  let form: FormData

  try {
    form = await new Request("https://upload.invalid/", {
      method: "POST",
      headers: { "content-type": contentType },
      body: toArrayBuffer(bytes),
    }).formData()
  } catch {
    return {
      ok: false,
      error: "The system could not read the request",
      reasonCode: "unreadable_form",
    }
  }

  const validation = await validateCustomSubmission(form)

  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
      reasonCode: "invalid_submission",
    }
  }

  return { ok: true, value: { kind: "custom", sources: validation.sources } }
}

/**
 * Step evidence. Every projection is the same allowlist for an owner and for a
 * shared viewer; the URL holder's authority is not consulted here.
 */
async function stepEvidenceResponse(
  env: Env,
  viewId: string,
  segment:
    | "received"
    | "documents"
    | "structure"
    | "customer"
    | "candidates"
    | "matches"
    | "estimate"
    | "delivery"
): Promise<Response> {
  const runId = await resolveRunId(env, viewId)

  if (!runId) {
    return Response.json(
      { error: "This run is not available. It can have expired." },
      { status: 404, headers: jsonHeaders }
    )
  }

  const evidence =
    segment === "received"
      ? await loadReceivedEvidence(env, runId, viewId)
      : segment === "documents"
        ? await loadDocumentEvidence(env, runId)
        : segment === "structure"
          ? await loadStructureEvidence(env, runId)
          : segment === "customer"
            ? await loadCustomerEvidence(env, runId)
            : segment === "candidates"
              ? await loadCandidateEvidence(env, runId)
              : segment === "matches"
                ? await loadMatchEvidence(env, runId)
                : segment === "estimate"
                  ? await loadEstimateEvidence(env, runId)
                  : await loadDeliveryEvidence(env, runId)

  return Response.json({ evidence }, { headers: jsonHeaders })
}

/**
 * The canonical quote as a downloadable file. It is the same allowlisted
 * document the estimate evidence carries, so any holder of the run URL may
 * read it, exactly as they may read every other evidence projection.
 */
async function quoteDownloadResponse(
  env: Env,
  viewId: string
): Promise<Response> {
  const runId = await resolveRunId(env, viewId)
  const quote = runId ? await loadQuote(env, runId) : null

  if (!quote) {
    return Response.json(
      { error: "This run does not have a canonical quote." },
      { status: 404, headers: jsonHeaders }
    )
  }

  return new Response(`${JSON.stringify(quote, null, 2)}\n`, {
    headers: {
      ...jsonHeaders,
      "content-disposition": `attachment; filename="${quote.quoteNumber}.json"`,
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Owner review                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The review as evidence. It is the same allowlisted projection for the owner
 * and for a shared viewer: what was asked, what was proposed, on what grounds,
 * and what was decided. Reading it grants nothing — every control that changes
 * it is a separate, capability-checked mutation below.
 */
async function reviewViewResponse(env: Env, viewId: string): Promise<Response> {
  const runId = await resolveRunId(env, viewId)

  if (!runId) {
    return Response.json(
      { error: "This run is not available. It can have expired." },
      { status: 404, headers: jsonHeaders }
    )
  }

  return Response.json(
    { review: await loadReviewEvidence(env, runId) },
    { headers: jsonHeaders }
  )
}

/** Records corrections. It never releases the workflow; approval does that. */
async function reviewDecisionsResponse(
  request: Request,
  env: Env,
  viewId: string
): Promise<Response> {
  const authorization = await authorizeOwner(
    env,
    viewId,
    request.headers.get("authorization")
  )

  if (!authorization.ok) return ownerRejection(authorization.reason)

  const body = await readJsonBody(request, REVIEW_DECISIONS_BODY_SCHEMA)

  if (!body.ok) {
    return Response.json(
      { error: "Send at least one review decision." },
      { status: 400, headers: jsonHeaders }
    )
  }

  const decisions: DecisionInput[] = []

  for (const entry of body.value.decisions) {
    const decision = REVIEW_DECISION_SCHEMA.safeParse(entry)

    if (!decision.success) {
      return Response.json(
        { error: "Each decision must contain a known item and action." },
        { status: 400, headers: jsonHeaders }
      )
    }

    decisions.push(decision.data)
  }

  const outcome = await recordDecisions(env, authorization.runId, decisions)

  if (outcome.state === "invalid") {
    return Response.json(
      { error: outcome.message },
      { status: 400, headers: jsonHeaders }
    )
  }

  if (outcome.state === "closed") {
    return Response.json(
      { error: outcome.message, review: outcome.review },
      { status: 409, headers: jsonHeaders }
    )
  }

  return Response.json(
    { status: "recorded", review: outcome.review },
    { headers: jsonHeaders }
  )
}

/**
 * The decision itself. The capability, the review window, and the exact
 * persisted review state are all validated here; only then is the hibernating
 * workflow released, and even then it re-reads that state rather than trusting
 * the event.
 */
async function reviewDecisionResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  viewId: string
): Promise<Response> {
  const authorization = await authorizeOwner(
    env,
    viewId,
    request.headers.get("authorization")
  )

  if (!authorization.ok) return ownerRejection(authorization.reason)

  const body = await readJsonBody(request, REVIEW_SETTLEMENT_BODY_SCHEMA)

  if (!body.ok) {
    return Response.json(
      { error: "The review action must be approve or reject." },
      { status: 400, headers: jsonHeaders }
    )
  }

  const action = body.value.action
  const outcome = await settleReview(env, authorization.runId, action)

  if (outcome.state === "absent") {
    return Response.json(
      { error: "This run does not have an open review." },
      { status: 409, headers: jsonHeaders }
    )
  }

  if (outcome.state === "incomplete" || outcome.state === "closed") {
    return Response.json(
      {
        error: outcome.message,
        status: outcome.review.state,
        review: outcome.review,
      },
      { status: 409, headers: jsonHeaders }
    )
  }

  await releaseWorkflow(env, authorization.runId)

  captureFunnelEvent(env, ctx, {
    event: "rfq_review_decided",
    distinctId: authorization.runId,
    properties: { decision: action },
  })

  return Response.json(
    {
      status: outcome.decision === "approve" ? "approved" : "rejected",
      review: outcome.review,
    },
    { headers: jsonHeaders }
  )
}

/**
 * Wakes the hibernating instance. The event is a doorbell, not an instruction:
 * it carries no decision, and the workflow reads the persisted review to learn
 * what happened. A failure to deliver leaves the durable business state intact
 * — the wait ends at its deadline and reaches the same conclusion.
 */
async function releaseWorkflow(env: Env, runId: string): Promise<void> {
  const instanceId = await workflowInstanceId(env, runId)
  if (!instanceId) return

  try {
    const instance = await env.RFQ_WORKFLOW.get(instanceId)
    await instance.sendEvent({
      type: REVIEW_EVENT_TYPE,
      payload: { runId },
    })

    // Logged on both paths on purpose: an approval that never woke its
    // instance looks exactly like a slow one until the deadline passes, and
    // these two lines are what tell those apart afterwards.
    console.log(
      JSON.stringify({ event: "review_event_delivered", runId, instanceId })
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "review_event_undelivered",
        runId,
        error: error instanceof Error ? error.name : "unknown",
      })
    )
  }
}

/**
 * Searching beyond the shortlist. Both searches are owner actions: they exist
 * to make a correction possible, and a shared viewer has no correction to make.
 */
async function reviewSearchResponse(
  request: Request,
  env: Env,
  viewId: string,
  segment: "catalog" | "customers",
  url: URL
): Promise<Response> {
  const authorization = await authorizeOwner(
    env,
    viewId,
    request.headers.get("authorization")
  )

  if (!authorization.ok) return ownerRejection(authorization.reason)

  const query = (url.searchParams.get("q") ?? "").slice(0, 120)

  return segment === "catalog"
    ? Response.json(
        { products: await searchReviewCatalog(env, query) },
        { headers: jsonHeaders }
      )
    : Response.json(
        { customers: await searchReviewCustomers(env, query) },
        { headers: jsonHeaders }
      )
}

function ownerRejection(
  reason: "missing" | "unknown_run" | "forbidden"
): Response {
  if (reason === "missing") {
    return Response.json(
      { error: "Owner access is required." },
      { status: 401, headers: { ...jsonHeaders, "www-authenticate": "Bearer" } }
    )
  }

  if (reason === "unknown_run") {
    return Response.json(
      { error: "This run is not available. It can have expired." },
      { status: 404, headers: jsonHeaders }
    )
  }

  return Response.json(
    { error: "This browser does not own the run." },
    { status: 403, headers: jsonHeaders }
  )
}

/**
 * Streams an original source from private R2. The bucket itself stays private;
 * this is the only way back to the bytes, and only for a known run source.
 */
async function sourcePreviewResponse(
  env: Env,
  viewId: string,
  sourceId: string
): Promise<Response> {
  const runId = await resolveRunId(env, viewId)

  if (!runId) {
    return Response.json(
      { error: "This run is not available. It can have expired." },
      { status: 404, headers: jsonHeaders }
    )
  }

  const source = (await loadSources(env, runId)).find(
    (candidate) => candidate.id === sourceId
  )

  if (
    !source ||
    !UPLOAD_MEDIA_TYPE_SCHEMA.safeParse(source.mediaType).success
  ) {
    return Response.json(
      { error: "This source is not available." },
      { status: 404, headers: jsonHeaders }
    )
  }

  const object = await env.ARTIFACTS.get(source.storageKey)

  if (!object) {
    return Response.json(
      { error: "This source is not available." },
      { status: 404, headers: jsonHeaders }
    )
  }

  return new Response(object.body, {
    headers: {
      "cache-control": "private, max-age=60",
      "content-type": source.mediaType,
      "content-disposition": "inline",
      "content-security-policy": "sandbox; default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  })
}

async function runViewResponse(
  request: Request,
  env: Env,
  viewId: string
): Promise<Response> {
  const run = await loadRun(env, viewId)

  if (!run) {
    return Response.json(
      { error: "This run is not available. It can have expired." },
      { status: 404, headers: jsonHeaders }
    )
  }

  const isOwner = await isOwnerRequest(
    env,
    viewId,
    request.headers.get("authorization")
  )

  return Response.json(
    { run, viewer: ownerViewer(isOwner) },
    { headers: jsonHeaders }
  )
}

async function resetRunResponse(
  request: Request,
  env: Env,
  viewId: string
): Promise<Response> {
  const authorization = await authorizeOwner(
    env,
    viewId,
    request.headers.get("authorization")
  )

  if (!authorization.ok) return ownerRejection(authorization.reason)

  await deleteRun(env, authorization.runId)

  console.log(
    JSON.stringify({ event: "run_reset", runId: authorization.runId })
  )

  return Response.json({ status: "deleted" }, { headers: jsonHeaders })
}

function ownerViewer(isOwner: boolean) {
  return {
    isOwner,
    access: isOwner ? "owner" : "shared",
    canMutate: isOwner,
  } as const
}

/**
 * A request body that survived both gates: it was JSON, and it was the JSON the
 * endpoint's owner declared. `ok: false` deliberately says nothing more — every
 * handler answers a malformed body with its own sentence and status.
 */
type JsonBody<Value> = { ok: true; value: Value } | { ok: false }

/** Reads a request body and parses it with the schema its owner exports. */
async function readJsonBody<Value>(
  request: Request,
  schema: z.ZodType<Value>
): Promise<JsonBody<Value>> {
  let decoded: unknown

  try {
    decoded = await request.json()
  } catch {
    return { ok: false }
  }

  const parsed = schema.safeParse(decoded)

  return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}

/** The same two gates over text a caller has already read out of the request. */
function parseJsonBody<Value>(
  text: string,
  schema: z.ZodType<Value>
): JsonBody<Value> {
  let decoded: unknown

  try {
    decoded = JSON.parse(text)
  } catch {
    return { ok: false }
  }

  const parsed = schema.safeParse(decoded)

  return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}

async function healthResponse(env: Env): Promise<Response> {
  const [database, artifacts] = await Promise.all([
    env.DB.prepare("SELECT 1 AS ready").first<{ ready: number }>(),
    env.ARTIFACTS.list({ limit: 1 }),
  ])

  if (database?.ready !== 1 || !Array.isArray(artifacts.objects)) {
    throw new Error("A required local binding did not respond")
  }

  const body: HealthResponse = {
    status: "ok",
    environment: readConfig(env).appEnv,
    services: {
      d1: "ready",
      r2: "ready",
      workflow: "configured",
    },
    timestamp: new Date().toISOString(),
  }

  return Response.json(body, { headers: jsonHeaders })
}
