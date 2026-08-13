/**
 * Public processing limits.
 *
 * The demo is open: no login, no CAPTCHA. What protects the funded provider
 * calls is a count of *processing* requests per visitor per hour. Reading an
 * existing run is never limited — a shared link has to keep working — and the
 * check runs before a request body is read, so an oversized upload cannot spend
 * anything either.
 *
 * A visitor is identified only as a hash. The key is SHA-256 over the rotating
 * secret, a purpose label, the fixed hour the request fell in, and the client
 * address. The hour is part of the input, so the same visitor produces an
 * unrelated key every hour: nothing in the database can be joined across
 * windows into a per-person history, and the raw address is never written
 * anywhere — not to a table, not to a log, not to an analytics event.
 */

const HOUR_MS = 60 * 60 * 1000

export const RATE_LIMIT_MAX_RUNS = 5
export const RATE_LIMIT_WINDOW_SECONDS = HOUR_MS / 1000

/** Generated once per isolate, and only used if the secret is absent. */
let fallbackSalt: string | null = null

export type RateLimitDecision = {
  allowed: boolean
  limit: number
  /** Remaining runs in this window, floored at zero. */
  remaining: number
  windowSeconds: number
  retryAfterSeconds: number
  resetAt: string
}

/**
 * Counts this request and says whether it may proceed.
 *
 * The count is a single conditional upsert so that two simultaneous requests
 * cannot both read "four so far" and both be allowed.
 */
export async function checkRateLimit(
  env: Env,
  request: Request,
  now: Date = new Date()
): Promise<RateLimitDecision> {
  const windowStart = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS)
  const windowEnd = new Date(windowStart.getTime() + HOUR_MS)
  const bucketHash = await visitorHash(env, request, "rate-limit", windowStart)

  const row = await env.DB.prepare(
    `INSERT INTO rate_limit_windows (bucket_hash, window_start, window_end, hits)
       VALUES (?, ?, ?, 1)
     ON CONFLICT (bucket_hash) DO UPDATE SET hits = hits + 1
     RETURNING hits`
  )
    .bind(bucketHash, windowStart.toISOString(), windowEnd.toISOString())
    .first<{ hits: number }>()

  const hits = row?.hits ?? 1

  return {
    allowed: hits <= RATE_LIMIT_MAX_RUNS,
    limit: RATE_LIMIT_MAX_RUNS,
    remaining: Math.max(0, RATE_LIMIT_MAX_RUNS - hits),
    windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowEnd.getTime() - now.getTime()) / 1000)
    ),
    resetAt: windowEnd.toISOString(),
  }
}

/** Drops counters whose hour has passed. Called by the daily sweep. */
export async function pruneRateLimitWindows(
  env: Env,
  now: Date = new Date()
): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM rate_limit_windows WHERE window_end <= ?`
  )
    .bind(now.toISOString())
    .run()

  return result.meta.changes ?? 0
}

/**
 * The rotating per-visitor hash. `purpose` keeps the limiter's key and the
 * analytics visitor key from being the same value, so neither can be used to
 * look the other up.
 */
export async function visitorHash(
  env: Env,
  request: Request,
  purpose: "rate-limit" | "analytics",
  windowStart: Date
): Promise<string> {
  // A request without a client address is counted in one shared bucket. That is
  // stricter than letting it through unlimited, and it identifies no one.
  const address = request.headers.get("cf-connecting-ip")?.trim() || "unknown"
  const material = `${rotatingSalt(env)}:${purpose}:${windowStart.toISOString()}:${address}`

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material)
  )

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * The secret half of the hash. It is a Worker secret in every deployed
 * environment; if it is ever missing, a random per-isolate value is used rather
 * than an empty one, so an unsalted — and therefore guessable — address hash
 * cannot be persisted.
 */
function rotatingSalt(env: Env): string {
  const configured = env.RATE_LIMIT_SALT?.trim()
  if (configured) return configured

  if (!fallbackSalt) {
    fallbackSalt = crypto.randomUUID()
    console.warn(
      JSON.stringify({
        event: "rate_limit_salt_missing",
        detail: "using an ephemeral per-isolate salt",
      })
    )
  }

  return fallbackSalt
}
