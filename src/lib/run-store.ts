/**
 * Browser-local record of runs this browser started.
 *
 * The owner capability is bearer authority for mutations, so it never leaves
 * this browser except as an `Authorization` header. A browser that only opened
 * a copied run URL simply has no entry here and stays a shared viewer.
 */

const CAPABILITY_KEY_PREFIX = "rfq-relay:run-capability:"
const RECENT_RUNS_KEY = "rfq-relay:recent-runs"
const RECENT_RUNS_LIMIT = 10

export type RecentRun = {
  viewId: string
  scenarioId: string | null
  startedAt: string
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
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

export function readRecentRuns(): RecentRun[] {
  const raw = storage()?.getItem(RECENT_RUNS_KEY)
  if (!raw) return []

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.filter(
      (entry): entry is RecentRun =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RecentRun).viewId === "string"
    )
  } catch {
    return []
  }
}
