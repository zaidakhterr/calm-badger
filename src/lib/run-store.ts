/**
 * Browser-local record of runs this browser started.
 *
 * The owner capability is bearer authority for mutations, so it never leaves
 * this browser except as an `Authorization` header. A browser that only opened
 * a copied run URL simply has no entry here and stays a shared viewer.
 */

import { z } from "zod"

const CAPABILITY_KEY_PREFIX = "rfq-relay:run-capability:"
const WORKSPACE_KEY = "rfq-relay:workspace"
const RECENT_RUNS_KEY = "rfq-relay:recent-runs"
const RECENT_RUNS_LIMIT = 10

/**
 * One remembered run. The view identifier is what the entry is for, so an entry
 * without one is not a run; the rest is what the list shows beside it and reads
 * as unknown when an earlier build wrote it differently.
 */
const RECENT_RUN_SCHEMA = z.object({
  viewId: z.string(),
  scenarioId: z.string().nullable().catch(null),
  startedAt: z.string().catch(""),
})

export type RecentRun = z.infer<typeof RECENT_RUN_SCHEMA>

/** The `recent-runs` entry as it is stored: a list of entries, as JSON text. */
const STORED_RECENT_RUNS_SCHEMA = z
  .string()
  .transform((raw, ctx) => {
    try {
      const decoded: unknown = JSON.parse(raw)
      return decoded
    } catch {
      ctx.addIssue({ code: "custom", message: "The entry is not JSON text." })
      return z.NEVER
    }
  })
  .pipe(z.array(z.json()))
  .catch([])

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * The anonymous workspace this browser learns in.
 *
 * Approved review corrections are remembered against it, so a later run in this
 * browser recognises wording an earlier review confirmed. It identifies no
 * person, is generated here rather than assigned by the server, and the server
 * only ever stores its hash.
 */
export function workspaceId(): string | null {
  const store = storage()
  if (!store) return null

  const existing = store.getItem(WORKSPACE_KEY)
  if (existing) return existing

  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const created = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

  store.setItem(WORKSPACE_KEY, created)
  return created
}

export function readOwnerCapability(viewId: string): string | null {
  return storage()?.getItem(CAPABILITY_KEY_PREFIX + viewId) ?? null
}

export function rememberOwnedRun(run: {
  viewId: string
  scenarioId: string | null
  ownerCapability: string
}): void {
  const store = storage()
  if (!store) return

  store.setItem(CAPABILITY_KEY_PREFIX + run.viewId, run.ownerCapability)

  const recent: RecentRun[] = [
    {
      viewId: run.viewId,
      scenarioId: run.scenarioId,
      startedAt: new Date().toISOString(),
    },
    ...readRecentRuns().filter((entry) => entry.viewId !== run.viewId),
  ].slice(0, RECENT_RUNS_LIMIT)

  store.setItem(RECENT_RUNS_KEY, JSON.stringify(recent))
}

export function forgetRun(viewId: string): void {
  const store = storage()
  if (!store) return

  store.removeItem(CAPABILITY_KEY_PREFIX + viewId)
  store.setItem(
    RECENT_RUNS_KEY,
    JSON.stringify(readRecentRuns().filter((entry) => entry.viewId !== viewId))
  )
}

/**
 * The remembered list, parsed entry by entry.
 *
 * This is a browser-local convenience, so nothing here throws and nothing here
 * is trusted: a stored value that is not a list of entries reads as no runs,
 * and one entry this build cannot read costs that entry and not the list.
 */
export function readRecentRuns(): RecentRun[] {
  const raw = storage()?.getItem(RECENT_RUNS_KEY)
  if (!raw) return []

  return STORED_RECENT_RUNS_SCHEMA.parse(raw).flatMap((entry) => {
    const parsed = RECENT_RUN_SCHEMA.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}
