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
      return Response.json(
        { error: "Method not allowed" },
        {
          status: 405,
          headers: { ...jsonHeaders, allow: "GET" },
        }
      )
    }

    return healthResponse(env)
  }

  if (url.pathname.startsWith("/api/")) {
    return Response.json(
      { error: "API route not found" },
      { status: 404, headers: jsonHeaders }
    )
  }

  return env.ASSETS.fetch(request)
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
