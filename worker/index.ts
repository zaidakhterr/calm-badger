import {
  authorizeOwner,
  createRun,
  deleteRun,
  isOwnerRequest,
  isScenarioId,
  loadRun,
} from "./runs"

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

  if (url.pathname === "/api/runs") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST")
    }

    return createRunResponse(request, env)
  }

  const runMatch = /^\/api\/runs\/([A-Za-z0-9_-]+)(\/reset)?$/.exec(
    url.pathname
  )

  if (runMatch) {
    const [, viewId, resetSegment] = runMatch

    if (resetSegment) {
      if (request.method !== "POST") {
        return methodNotAllowed("POST")
      }

      return resetRunResponse(request, env, viewId)
    }

    if (request.method !== "GET") {
      return methodNotAllowed("GET")
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
  const payload = await readJsonBody(request)
  const scenarioId = (payload as { scenarioId?: unknown } | null)?.scenarioId

  if (!isScenarioId(scenarioId)) {
    return Response.json(
      { error: "A known curated scenario is required" },
      { status: 400, headers: jsonHeaders }
    )
  }

  const { runId, run, ownerCapability } = await createRun(env, { scenarioId })

  console.log(
    JSON.stringify({
      event: "run_created",
      runId,
      scenarioId,
      steps: run.steps.length,
    })
  )

  // The plaintext owner capability is returned exactly once, here.
  return Response.json(
    { run, viewer: ownerViewer(true), ownerCapability },
    { status: 201, headers: jsonHeaders }
  )
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
