const DAY_MS = 24 * 60 * 60 * 1000

export const CURATED_RETENTION_MS = 7 * DAY_MS
export const CUSTOM_RETENTION_MS = DAY_MS

/**
 * The deletion deadline for a run and anything derived from its source.
 * Unknown source kinds take the shorter window so malformed legacy data fails
 * toward privacy rather than retention.
 */
export function retentionDeadline(
  sourceKind: string,
  createdAt: string
): string | null {
  const createdAtMs = Date.parse(createdAt)
  if (!Number.isFinite(createdAtMs)) return null

  const retentionMs =
    sourceKind === "curated" ? CURATED_RETENTION_MS : CUSTOM_RETENTION_MS

  return new Date(createdAtMs + retentionMs).toISOString()
}
