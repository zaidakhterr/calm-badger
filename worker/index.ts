import { isAdapterId } from "./adapters"
import { loadQuote } from "./build-estimate"
import { deliverRun, previewDelivery } from "./deliver"
import {
  loadCandidateEvidence,
  loadCustomerEvidence,
  loadDeliveryEvidence,
  loadDocumentEvidence,
  loadEstimateEvidence,
  loadMatchEvidence,
  loadStructureEvidence,
} from "./evidence"
import {
  loadReviewEvidence,
  recordDecisions,
  REVIEW_EVENT_TYPE,
  searchReviewCatalog,
  searchReviewCustomers,
  settleReview,
  type DecisionInput,
} from "./review"
import {
  authorizeOwner,
  createRun,
  deleteRun,
  isOwnerRequest,
  isScenarioId,
  loadRun,
  resolveRunId,
  workflowInstanceId,
  type RunInput,
} from "./runs"
import { scenarioPreviews } from "./scenarios"
import { loadSystemDetails } from "./system"
import {
  isSupportedUploadType,
  loadSources,
  MAX_UPLOAD_BYTES,
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const requestId = crypto.randomUUID()

    try {
      const response = await routeRequest(request, env, url)

      console.log(
        JSON.stringify({
          event: "http_request",
          requestId,
          method: request.method,
          path: url.pathname,
          status: response.status,
        })
      )

      return response
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "http_request_failed",
          requestId,
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : "Unknown error",
        })
      )

      return Response.json(
        { error: "Internal server error", requestId },
        { status: 500, headers: jsonHeaders }
      )
    }
  },
} satisfies ExportedHandler<Env>

async function routeRequest(
  request: Request,
  env: Env,
  url: URL
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

    // Curated source material only. Expected outcomes are test fixtures and are
    // never served to a client.
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

  if (url.pathname === "/api/runs") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST")
    }

    return createRunResponse(request, env)
  }

  const runMatch =
    /^\/api\/runs\/([A-Za-z0-9_-]+)(?:\/(reset|deliver|documents|structure|customer|candidates|matches|estimate|delivery|quote|review)|\/delivery\/(preview)|\/review\/(decisions|catalog|customers)|\/sources\/([A-Za-z0-9-]+))?$/.exec(
      url.pathname
    )

  if (runMatch) {
    const [, viewId, segment, deliveryPreview, reviewSegment, sourceId] =
      runMatch

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
      return reviewDecisionResponse(request, env, viewId)
    }

    if (segment === "reset") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST")
      }

      return resetRunResponse(request, env, viewId)
    }

    if (segment === "deliver") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST")
      }

      return deliverRunResponse(request, env, viewId)
    }

    if (request.method !== "GET") {
      return methodNotAllowed("GET")
    }

    // Inspecting an adapter payload before delivery is an owner action, like
    // delivery itself. What was actually delivered becomes shared evidence.
    if (deliveryPreview) {
      return deliveryPreviewResponse(request, env, viewId, url)
    }

    if (segment === "quote") {
      return quoteDownloadResponse(env, viewId)
    }

    if (segment === "review") {
      return reviewViewResponse(env, viewId)
    }

    if (
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

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "Method not allowed" },
    { status: 405, headers: { ...jsonHeaders, allow } }
  )
}

async function createRunResponse(
  request: Request,
  env: Env
): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? ""
  const input = contentType.includes("multipart/form-data")
    ? await readCustomInput(request)
    : await readCuratedInput(request)

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

  // The plaintext owner capability is returned exactly once, here.
  return Response.json(
    { run, viewer: ownerViewer(true), ownerCapability },
    { status: 201, headers: jsonHeaders }
  )
}

type InputResult =
  | { ok: true; value: RunInput }
  | { ok: false; error: string; reasonCode: string }

/** An opaque browser-generated token, bounded and never logged. */
function readWorkspaceId(request: Request): string | null {
  const value = request.headers.get("x-workspace-id")?.trim() ?? ""

  return value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null
}

async function readCuratedInput(request: Request): Promise<InputResult> {
  const payload = await readJsonBody(request)
  const scenarioId = (payload as { scenarioId?: unknown } | null)?.scenarioId

  if (!isScenarioId(scenarioId)) {
    return {
      ok: false,
      error: "A known curated scenario is required",
      reasonCode: "unknown_scenario",
    }
  }

  return {
    ok: true,
    value: { kind: "curated", scenarioId, requestUrl: request.url },
  }
}

/**
 * Custom submissions are validated before anything is stored, so an
 * unsupported type or an oversized upload cannot reach a paid provider.
 */
async function readCustomInput(request: Request): Promise<InputResult> {
  const declaredLength = Number.parseInt(
    request.headers.get("content-length") ?? "",
    10
  )

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_UPLOAD_BYTES * 1.1
  ) {
    return {
      ok: false,
      error: `The request is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`,
      reasonCode: "upload_too_large",
    }
  }

  let form: FormData

  try {
    form = await request.formData()
  } catch {
    return {
      ok: false,
      error: "The submitted request could not be read",
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
      { error: "This run is unavailable or has expired" },
      { status: 404, headers: jsonHeaders }
    )
  }

  const evidence =
    segment === "documents"
      ? await loadDocumentEvidence(env, runId, viewId)
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
      { error: "This run has no canonical quote yet" },
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

async function deliveryPreviewResponse(
  request: Request,
  env: Env,
  viewId: string,
  url: URL
): Promise<Response> {
  const authorization = await authorizeOwner(
    env,
    viewId,
    request.headers.get("authorization")
  )

  if (!authorization.ok) return ownerRejection(authorization.reason)

  const adapter = url.searchParams.get("adapter")

  if (!isAdapterId(adapter)) {
    return Response.json(
      { error: "A known delivery adapter is required" },
      { status: 400, headers: jsonHeaders }
    )
  }

  const preview = await previewDelivery(env, authorization.runId, adapter)

  if (!preview) {
    return Response.json(
      { error: "This run has no canonical quote yet" },
      { status: 409, headers: jsonHeaders }
    )
  }

  return Response.json(preview, { headers: jsonHeaders })
}

/**
 * Delivery is owner-only and deliberate: the capability is checked, the run
 * must already be priced, and a second attempt returns what was delivered
 * rather than delivering twice.
 */
async function deliverRunResponse(
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

  const payload = await readJsonBody(request)
  const adapter = (payload as { adapter?: unknown } | null)?.adapter

  if (!isAdapterId(adapter)) {
    return Response.json(
      { error: "A known delivery adapter is required" },
      { status: 400, headers: jsonHeaders }
    )
  }

  const outcome = await deliverRun(env, authorization.runId, adapter)

  if (outcome.state === "not_priced") {
    return Response.json(
      { error: "This run has no canonical quote to deliver yet" },
      { status: 409, headers: jsonHeaders }
    )
  }

  if (outcome.state === "already_delivered") {
    return Response.json(
      { status: "already_delivered", delivery: outcome.delivery },
      { status: 409, headers: jsonHeaders }
    )
  }

  return Response.json(
    { status: "delivered", delivery: outcome.delivery },
    { headers: jsonHeaders }
  )
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
      { error: "This run is unavailable or has expired" },
      { status: 404, headers: jsonHeaders }
    )
  }

  return Response.json(
    { review: await loadReviewEvidence(env, runId) },
    { headers: jsonHeaders }
  )
}

const REVIEW_ACTIONS = new Set([
  "accept",
  "alternative",
  "catalog",
  "quantity",
  "customer",
])

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

  const payload = await readJsonBody(request)
  const submitted = (payload as { decisions?: unknown } | null)?.decisions

  if (!Array.isArray(submitted)) {
    return Response.json(
      { error: "A list of review decisions is required" },
      { status: 400, headers: jsonHeaders }
    )
  }

  const decisions: DecisionInput[] = []

  for (const entry of submitted) {
    const decision = entry as Record<string, unknown>

    if (
      typeof decision.itemId !== "string" ||
      typeof decision.action !== "string" ||
      !REVIEW_ACTIONS.has(decision.action)
    ) {
      return Response.json(
        { error: "Each decision needs a known item and action" },
        { status: 400, headers: jsonHeaders }
      )
    }

    decisions.push({
      itemId: decision.itemId,
      action: decision.action as DecisionInput["action"],
      sku: decision.sku,
      quantity: decision.quantity,
      customerId: decision.customerId,
    })
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
  viewId: string
): Promise<Response> {
  const authorization = await authorizeOwner(
    env,
    viewId,
    request.headers.get("authorization")
  )

  if (!authorization.ok) return ownerRejection(authorization.reason)

  const payload = await readJsonBody(request)
  const action = (payload as { action?: unknown } | null)?.action

  if (action !== "approve" && action !== "reject") {
    return Response.json(
      { error: "A review decision must be approve or reject" },
      { status: 400, headers: jsonHeaders }
    )
  }

  const outcome = await settleReview(env, authorization.runId, action)

  if (outcome.state === "absent") {
    return Response.json(
      { error: "This run has nothing waiting for review" },
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
 * Searching beyond the shortlist. Both searches are owner actions, like the
 * adapter preview: they exist to make a correction possible, and a shared
 * viewer has no correction to make.
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
      { error: "An owner capability is required" },
      { status: 401, headers: { ...jsonHeaders, "www-authenticate": "Bearer" } }
    )
  }

  if (reason === "unknown_run") {
    return Response.json(
      { error: "This run is unavailable or has expired" },
      { status: 404, headers: jsonHeaders }
    )
  }

  return Response.json(
    { error: "This capability does not own this run" },
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
      { error: "This run is unavailable or has expired" },
      { status: 404, headers: jsonHeaders }
    )
  }

  const source = (await loadSources(env, runId)).find(
    (candidate) => candidate.id === sourceId
  )

  if (!source || !isSupportedUploadType(source.mediaType)) {
    return Response.json(
      { error: "This source is unavailable" },
      { status: 404, headers: jsonHeaders }
    )
  }

  const object = await env.ARTIFACTS.get(source.storageKey)

  if (!object) {
    return Response.json(
      { error: "This source is unavailable" },
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
      { error: "This run is unavailable or has expired" },
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

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
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
    environment: env.APP_ENV,
    services: {
      d1: "ready",
      r2: "ready",
      workflow: "configured",
    },
    timestamp: new Date().toISOString(),
  }

  return Response.json(body, { headers: jsonHeaders })
}
