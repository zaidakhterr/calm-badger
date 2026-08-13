import {
  loadCandidateEvidence,
  loadCustomerEvidence,
  loadDocumentEvidence,
  loadMatchEvidence,
  loadStructureEvidence,
} from "./evidence"
import {
  authorizeOwner,
  createRun,
  deleteRun,
  isOwnerRequest,
  isScenarioId,
  loadRun,
  resolveRunId,
  type RunInput,
} from "./runs"
import { scenarioPreviews } from "./scenarios"
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

  if (url.pathname === "/api/runs") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST")
    }

    return createRunResponse(request, env)
  }

  const runMatch =
    /^\/api\/runs\/([A-Za-z0-9_-]+)(?:\/(reset|documents|structure|customer|candidates|matches)|\/sources\/([A-Za-z0-9-]+))?$/.exec(
      url.pathname
    )

  if (runMatch) {
    const [, viewId, segment, sourceId] = runMatch

    if (segment === "reset") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST")
      }

      return resetRunResponse(request, env, viewId)
    }

    if (request.method !== "GET") {
      return methodNotAllowed("GET")
    }

    if (
      segment === "documents" ||
      segment === "structure" ||
      segment === "customer" ||
      segment === "candidates" ||
      segment === "matches"
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
  segment: "documents" | "structure" | "customer" | "candidates" | "matches"
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
            : await loadMatchEvidence(env, runId)

  return Response.json({ evidence }, { headers: jsonHeaders })
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

  if (!authorization.ok) {
    if (authorization.reason === "missing") {
      return Response.json(
        { error: "An owner capability is required" },
        {
          status: 401,
          headers: { ...jsonHeaders, "www-authenticate": "Bearer" },
        }
      )
    }

    if (authorization.reason === "unknown_run") {
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
