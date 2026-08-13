/**
 * RFQ sources: what a run was given to read, and where those bytes live.
 *
 * Every run has one `email_body` source plus zero or more binary sources. The
 * originals are written to private R2 under the run's prefix and are only ever
 * served back through the Worker; D1 keeps provenance (which source, which
 * page, which region) and the text read from each page.
 *
 * Uploads are validated here, before a run row exists and therefore before any
 * provider capacity can be consumed: an unsupported media type or an oversized
 * combined upload never reaches the workflow.
 */

import { findScenario, type Scenario } from "./scenarios"

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_UPLOAD_FILES = 6
export const MAX_EMAIL_BODY_CHARS = 20_000

export const SUPPORTED_UPLOAD_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const

export type UploadMediaType = (typeof SUPPORTED_UPLOAD_TYPES)[number]

export type SourceKind = "email_body" | "inline_image" | "attachment"

export type PreparedSource = {
  kind: SourceKind
  label: string
  mediaType: UploadMediaType | "text/plain"
  bytes: ArrayBuffer
}

export type StoredSource = {
  id: string
  position: number
  kind: SourceKind
  label: string
  mediaType: string
  byteSize: number
  storageKey: string
}

export type ValidationResult =
  { ok: true; sources: PreparedSource[] } | { ok: false; error: string }

const encoder = new TextEncoder()

/** Leading bytes each accepted format must actually start with. */
const MAGIC_BYTES: Record<UploadMediaType, number[][]> = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
}

export function isSupportedUploadType(value: string): value is UploadMediaType {
  return (SUPPORTED_UPLOAD_TYPES as readonly string[]).includes(value)
}

export function describeUploadLimits(): string {
  return `Attach PDF, JPEG, or PNG files only, up to ${MAX_UPLOAD_FILES} files and ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB combined.`
}

/**
 * Validates a submitted custom RFQ. Nothing is written and no provider is
 * called until this returns `ok`.
 */
export async function validateCustomSubmission(
  form: FormData
): Promise<ValidationResult> {
  const rawBody = form.get("emailBody")
  const emailBody = typeof rawBody === "string" ? rawBody.trim() : ""

  if (emailBody.length === 0) {
    return { ok: false, error: "An email body is required to start a run" }
  }

  if (emailBody.length > MAX_EMAIL_BODY_CHARS) {
    return {
      ok: false,
      error: `The email body is limited to ${MAX_EMAIL_BODY_CHARS} characters`,
    }
  }

  const files = form.getAll("files").filter((entry): entry is File => {
    return entry instanceof File && entry.size > 0
  })

  if (files.length > MAX_UPLOAD_FILES) {
    return {
      ok: false,
      error: `Attach at most ${MAX_UPLOAD_FILES} files to one request`,
    }
  }

  const combinedBytes = files.reduce((total, file) => total + file.size, 0)
  if (combinedBytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `The attachments are ${formatMegabytes(combinedBytes)} MB combined; the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
    }
  }

  const sources: PreparedSource[] = [
    {
      kind: "email_body",
      label: "Email body",
      mediaType: "text/plain",
      bytes: toArrayBuffer(encoder.encode(emailBody)),
    },
  ]

  for (const file of files) {
    const mediaType = (file.type || "").split(";")[0].trim().toLowerCase()

    if (!isSupportedUploadType(mediaType)) {
      return {
        ok: false,
        error: `${describeFile(file)} is not a supported file type. ${describeUploadLimits()}`,
      }
    }

    const bytes = await file.arrayBuffer()

    if (!hasExpectedMagicBytes(mediaType, bytes)) {
      return {
        ok: false,
        error: `${describeFile(file)} does not contain valid ${mediaType} content`,
      }
    }

    sources.push({
      kind: mediaType === "application/pdf" ? "attachment" : "inline_image",
      label: describeFile(file),
      mediaType,
      bytes,
    })
  }

  return { ok: true, sources }
}

/**
 * The sources of a curated scenario: the email text a reviewer can read on the
 * landing page, the inline photograph, and the PDF attachment. The per-line
 * `note` copy is preview material for the interface and is deliberately absent,
 * because it describes the expected outcome.
 */
export async function curatedSources(
  env: Env,
  scenarioId: Parameters<typeof findScenario>[0],
  requestUrl: string
): Promise<PreparedSource[]> {
  const scenario = findScenario(scenarioId)

  const sources: PreparedSource[] = [
    {
      kind: "email_body",
      label: "Email body",
      mediaType: "text/plain",
      bytes: toArrayBuffer(encoder.encode(emailBodyText(scenario))),
    },
  ]

  for (const attachment of [scenario.inlineImage, scenario.pdfAttachment]) {
    const asset = await env.ASSETS.fetch(new URL(attachment.url, requestUrl))

    if (!asset.ok) {
      throw new Error(`Curated source ${attachment.filename} is unavailable`)
    }

    sources.push({
      kind: attachment.kind === "pdf" ? "attachment" : "inline_image",
      label: attachment.filename,
      mediaType: attachment.kind === "pdf" ? "application/pdf" : "image/png",
      bytes: await asset.arrayBuffer(),
    })
  }

  return sources
}

/** The forwarded email exactly as a recipient would read it. */
export function emailBodyText(scenario: Scenario): string {
  const lines = [
    `From: ${scenario.email.from.name} <${scenario.email.from.email}>`,
    `Company: ${scenario.email.from.company}`,
    `To: ${scenario.email.to}`,
    `Subject: ${scenario.email.subject}`,
    `Received: ${scenario.email.receivedAt}`,
  ]

  if (scenario.email.forwarded) {
    lines.push(
      "",
      `Forwarded from: ${scenario.email.forwarded.from}`,
      `Forwarded date: ${scenario.email.forwarded.date}`,
      `Forwarded subject: ${scenario.email.forwarded.subject}`
    )
  }

  lines.push("", ...scenario.email.body, "", ...scenario.email.signature)

  return lines.join("\n")
}

export async function storeSources(
  env: Env,
  runId: string,
  sources: PreparedSource[],
  now: string
): Promise<StoredSource[]> {
  const stored: StoredSource[] = []

  for (const [position, source] of sources.entries()) {
    const id = crypto.randomUUID()
    const storageKey = `runs/${runId}/sources/${id}`

    await env.ARTIFACTS.put(storageKey, source.bytes, {
      httpMetadata: { contentType: source.mediaType },
    })

    stored.push({
      id,
      position,
      kind: source.kind,
      label: source.label,
      mediaType: source.mediaType,
      byteSize: source.bytes.byteLength,
      storageKey,
    })
  }

  await env.DB.batch(
    stored.map((source) =>
      env.DB.prepare(
        `INSERT INTO run_sources (
           id, run_id, position, kind, label, media_type, byte_size,
           storage_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        source.id,
        runId,
        source.position,
        source.kind,
        source.label,
        source.mediaType,
        source.byteSize,
        source.storageKey,
        now
      )
    )
  )

  return stored
}

export async function loadSources(
  env: Env,
  runId: string
): Promise<StoredSource[]> {
  const rows = await env.DB.prepare(
    `SELECT id, position, kind, label, media_type, byte_size, storage_key
       FROM run_sources WHERE run_id = ? ORDER BY position ASC`
  )
    .bind(runId)
    .all<{
      id: string
      position: number
      kind: string
      label: string
      media_type: string
      byte_size: number
      storage_key: string
    }>()

  return rows.results.map((row) => ({
    id: row.id,
    position: row.position,
    kind: row.kind as SourceKind,
    label: row.label,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    storageKey: row.storage_key,
  }))
}

/** Removes every stored original for a run. Used by reset and retention. */
export async function deleteStoredSources(
  env: Env,
  runId: string
): Promise<void> {
  const sources = await loadSources(env, runId)

  await Promise.all(
    sources.map((source) => env.ARTIFACTS.delete(source.storageKey))
  )
}

function hasExpectedMagicBytes(
  mediaType: UploadMediaType,
  bytes: ArrayBuffer
): boolean {
  const view = new Uint8Array(bytes)

  return MAGIC_BYTES[mediaType].some((signature) =>
    signature.every((byte, index) => view[index] === byte)
  )
}

function describeFile(file: File): string {
  const name = file.name.trim()
  return name.length > 0 ? name.slice(0, 120) : "The attached file"
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength
  ) as ArrayBuffer
}
