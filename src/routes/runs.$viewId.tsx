import { useEffect, useState } from "react"
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CheckIcon,
  CircleIcon,
  CircleNotchIcon,
  FilePdfIcon,
  ImageSquareIcon,
  LinkSimpleIcon,
  EnvelopeSimpleIcon,
  WarningIcon,
} from "@phosphor-icons/react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  fetchDocumentEvidence,
  fetchRun,
  resetRun,
  type DocumentEvidence,
  type EvidenceSource,
  type RunStep,
  type RunView,
} from "@/lib/api"
import { forgetRun } from "@/lib/run-store"
import { cn } from "@/lib/utils"

const READ_DOCUMENTS_STEP = "read-documents"
const POLL_INTERVAL_MS = 1000
/** A bound on live polling; the server, not the client, owns step state. */
const POLL_LIMIT_MS = 90_000

type RunSnapshot = RunView & { evidence: DocumentEvidence | null }

/** One server read of everything the graph shows, used by the loader and the poll. */
async function readRunSnapshot(viewId: string): Promise<RunSnapshot> {
  const view = await fetchRun(viewId)
  const step = view.run.steps.find((entry) => entry.key === READ_DOCUMENTS_STEP)

  return {
    ...view,
    evidence:
      step && step.status !== "waiting"
        ? await fetchDocumentEvidence(viewId)
        : null,
  }
}

export const Route = createFileRoute("/runs/$viewId")({
  loader: ({ params }) => readRunSnapshot(params.viewId),
  component: RunPage,
  pendingComponent: RunPending,
  errorComponent: RunUnavailable,
})

function RunPage() {
  const { viewId } = Route.useParams()
  const loaded = Route.useLoaderData()
  const navigate = useNavigate()

  const [snapshot, setSnapshot] = useState<RunSnapshot>(loaded)
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({})
  const [isResetting, setIsResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  const { run, viewer, evidence } = snapshot
  const completed = run.steps.filter(
    (step) => step.status === "complete"
  ).length
  const documentsStep = run.steps.find(
    (step) => step.key === READ_DOCUMENTS_STEP
  )
  const isSettled =
    run.status !== "active" ||
    run.steps.every(
      (step) => step.status !== "active" && step.status !== "waiting"
    )

  // Step state lives on the server; this only re-reads it while work is in
  // flight, and gives up rather than polling a stalled run forever.
  useEffect(() => {
    if (isSettled) return

    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - startedAt > POLL_LIMIT_MS) {
        clearInterval(timer)
        return
      }

      readRunSnapshot(viewId)
        .then(setSnapshot)
        .catch(() => clearInterval(timer))
    }, POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [isSettled, viewId])

  async function handleStartOver() {
    setIsResetting(true)
    setResetError(null)

    try {
      await resetRun(viewId)
      forgetRun(viewId)
      await navigate({ to: "/" })
    } catch (error) {
      setResetError(
        error instanceof Error ? error.message : "The run could not be reset"
      )
      setIsResetting(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-5 items-center rounded-md border border-workflow-active/20 bg-workflow-active-soft px-2 text-[11px] font-medium text-workflow-active">
              {viewer.isOwner ? "Your run" : "Shared view"}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {run.viewId}
            </span>
          </div>
          <h1 className="mt-3 text-xl leading-7 font-medium tracking-[-0.02em]">
            RFQ workflow
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {completed} of {run.steps.length} steps complete · started{" "}
            {formatTimestamp(run.createdAt)}
            {run.source.kind === "custom" ? " · your own sources" : ""}
          </p>
        </div>

        {viewer.canMutate ? (
          <Button
            size="lg"
            variant="outline"
            type="button"
            disabled={isResetting}
            onClick={() => void handleStartOver()}
          >
            <ArrowClockwiseIcon data-icon="inline-start" />
            {isResetting ? "Deleting run…" : "Start over"}
          </Button>
        ) : null}
      </div>

      {resetError ? (
        <p className="mt-4 text-xs text-destructive">{resetError}</p>
      ) : null}

      <div className="mt-7 flex gap-3 rounded-lg border bg-muted/30 p-3.5 text-xs leading-5 text-muted-foreground">
        <LinkSimpleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          {viewer.isOwner
            ? "This run is stored on the server and survives a refresh. Anyone you send this URL to can view it, but only this browser can approve or reset it."
            : "You are viewing a shared run. Anyone holding this URL can view it; approval and reset controls stay with the browser that started the run."}
        </p>
      </div>

      <ol className="mt-7" aria-label="RFQ workflow progress">
        {run.steps.map((step, index) => {
          const hasEvidence =
            step.key === READ_DOCUMENTS_STEP &&
            step.status !== "waiting" &&
            evidence !== null

          return (
            <WorkflowStepRow
              key={step.key}
              step={step}
              isLast={index === run.steps.length - 1}
              isOpen={
                openSteps[step.key] ??
                (step.status === "active" || step.status === "error")
              }
              onToggle={
                hasEvidence
                  ? () =>
                      setOpenSteps((current) => ({
                        ...current,
                        [step.key]: !(
                          current[step.key] ??
                          (step.status === "active" || step.status === "error")
                        ),
                      }))
                  : null
              }
            >
              {hasEvidence ? (
                <DocumentEvidencePanel evidence={evidence} />
              ) : null}
            </WorkflowStepRow>
          )
        })}
      </ol>

      {documentsStep?.status === "error" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          The workflow stopped at this step. There is no retry in this demo.
        </p>
      ) : null}
    </main>
  )
}

function WorkflowStepRow({
  step,
  isLast,
  isOpen,
  onToggle,
  children,
}: {
  step: RunStep
  isLast: boolean
  isOpen: boolean
  onToggle: (() => void) | null
  children: React.ReactNode
}) {
  const isComplete = step.status === "complete"
  const isActive = step.status === "active"
  const isReview = step.status === "review_required"
  const isError = step.status === "error"

  return (
    <li className="grid grid-cols-[1.75rem_1fr] gap-3">
      <div className="flex flex-col items-center" aria-hidden>
        <span
          className={cn(
            "z-10 flex size-7 items-center justify-center rounded-full border bg-background",
            isComplete &&
              "border-workflow-complete bg-workflow-complete-soft text-workflow-complete",
            isActive &&
              "border-workflow-active bg-workflow-active-soft text-workflow-active",
            (isReview || isError) &&
              "border-workflow-review bg-workflow-review-soft text-workflow-review"
          )}
        >
          {isComplete ? (
            <CheckIcon className="size-3.5" weight="bold" />
          ) : isActive ? (
            <CircleNotchIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : isReview || isError ? (
            <WarningIcon className="size-3.5" />
          ) : (
            <CircleIcon
              className="size-2.5 text-muted-foreground/50"
              weight="fill"
            />
          )}
        </span>
        {!isLast ? (
          <span
            className={cn(
              "min-h-7 w-px flex-1 bg-border",
              isComplete && "bg-workflow-complete",
              isActive && "bg-workflow-active"
            )}
          />
        ) : null}
      </div>

      <article
        className={cn(
          "mb-3 min-h-18 rounded-lg border bg-card px-4 py-3 shadow-xs",
          isActive && "border-workflow-active/40",
          (isReview || isError) && "border-workflow-review/40"
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[13px] leading-4 font-medium">{step.title}</h2>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              {step.summary}
            </p>
          </div>
          <span
            className={cn(
              "mt-0.5 text-[11px] whitespace-nowrap text-muted-foreground",
              isComplete && "text-workflow-complete",
              isActive && "text-workflow-active",
              (isReview || isError) && "text-workflow-review"
            )}
          >
            {statusLabel(step.status)}
          </span>
        </div>

        {step.completedAt ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Completed {formatTimestamp(step.completedAt)}
          </p>
        ) : null}

        {onToggle ? (
          <>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={isOpen}
              className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs outline-none hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              {isOpen ? "Hide evidence" : "Show evidence"}
              <CaretDownIcon
                className={cn(
                  "size-3.5 transition-transform",
                  isOpen && "rotate-180"
                )}
                aria-hidden
              />
            </button>
            {isOpen ? <div className="mt-3">{children}</div> : null}
          </>
        ) : null}
      </article>
    </li>
  )
}

function DocumentEvidencePanel({ evidence }: { evidence: DocumentEvidence }) {
  return (
    <div className="space-y-4">
      {evidence.state === "error" && evidence.message ? (
        <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-xs leading-5">
          {evidence.message}
        </p>
      ) : null}

      <div>
        <h3 className="text-[13px] leading-4 font-medium">Sources</h3>
        <ul className="mt-2 space-y-3">
          {evidence.sources.map((source) => (
            <SourceEvidenceCard key={source.id} source={source} />
          ))}
        </ul>
      </div>

      {evidence.totals ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">Model and usage</h3>
          <dl className="mt-2 divide-y rounded-md border text-xs">
            <MetaRow label="Provider" value={evidence.provider ?? "—"} />
            <MetaRow label="Model" value={evidence.model ?? "—"} mono />
            <MetaRow
              label="Elapsed"
              value={formatDuration(evidence.totals.elapsedMs)}
            />
            <MetaRow
              label="Provider latency"
              value={`${evidence.totals.providerLatencyMs} ms`}
            />
            <MetaRow
              label="Pages processed"
              value={`${evidence.totals.pagesProcessed} of ${evidence.totals.pageCount} pages`}
            />
            <MetaRow
              label="Estimated cost"
              value={`$${evidence.totals.estimatedCostUsd.toFixed(4)}`}
            />
          </dl>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Cost is an estimate from the configured page price, not a billed
            amount.
          </p>
        </div>
      ) : null}
    </div>
  )
}

function SourceEvidenceCard({ source }: { source: EvidenceSource }) {
  return (
    <li className="rounded-md border">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-xs">
          <SourceIcon kind={source.kind} />
          <span className="truncate font-medium">{source.label}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {sourceKindLabel(source.kind)}
          </span>
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatBytes(source.byteSize)}
          {source.latencyMs !== null && source.reader === "ocr-provider"
            ? ` · ${source.latencyMs} ms`
            : ""}
        </span>
      </div>

      <div className="space-y-3 p-3">
        {source.previewUrl ? (
          source.mediaType === "application/pdf" ? (
            <a
              href={source.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-xs hover:bg-muted/40"
            >
              <FilePdfIcon
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              Open the original document
            </a>
          ) : (
            <img
              src={source.previewUrl}
              alt={`Original source ${source.label}`}
              loading="lazy"
              className="w-full max-w-sm rounded-md border bg-background"
            />
          )
        ) : null}

        {source.pages.map((page) => (
          <div key={page.pageNumber}>
            <p className="text-[11px] text-muted-foreground">
              {sourceKindLabel(source.kind)} · page {page.pageNumber}
              {page.width && page.height
                ? ` · ${page.width} × ${page.height}`
                : ""}
              {page.regions.length > 0
                ? ` · ${page.regions.length} image ${page.regions.length === 1 ? "region" : "regions"}`
                : ""}
            </p>
            <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap">
              {page.markdown}
            </pre>
            {page.regions.length > 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Regions:{" "}
                {page.regions
                  .map((region) => `${region.id} [${region.box.join(", ")}]`)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ))}

        {source.sanitizedResponse ? (
          <details className="rounded-md border bg-background">
            <summary className="cursor-pointer px-3 py-2 text-xs">
              Sanitized provider response
            </summary>
            <pre className="max-h-64 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-5">
              {JSON.stringify(source.sanitizedResponse, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </li>
  )
}

function SourceIcon({ kind }: { kind: EvidenceSource["kind"] }) {
  const className = "size-4 shrink-0 text-muted-foreground"

  if (kind === "email_body") {
    return <EnvelopeSimpleIcon className={className} aria-hidden />
  }

  if (kind === "attachment") {
    return <FilePdfIcon className={className} aria-hidden />
  }

  return <ImageSquareIcon className={className} aria-hidden />
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex h-10 items-center justify-between gap-3 px-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono text-[11px]")}>
        {value}
      </dd>
    </div>
  )
}

function sourceKindLabel(kind: EvidenceSource["kind"]): string {
  switch (kind) {
    case "email_body":
      return "Email body"
    case "inline_image":
      return "Inline image"
    default:
      return "Attachment"
  }
}

function formatDuration(elapsedMs: number): string {
  return elapsedMs < 1000
    ? `${Math.max(elapsedMs, 0)} ms`
    : `${(elapsedMs / 1000).toFixed(1)} s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function RunPending() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <p className="text-sm text-muted-foreground">Loading run…</p>
    </main>
  )
}

function RunUnavailable() {
  return (
    <main className="mx-auto flex min-h-[calc(100svh-3rem)] max-w-lg flex-col items-center justify-center px-4 text-center">
      <p className="text-xs font-medium text-muted-foreground">Unavailable</p>
      <h1 className="mt-2 text-base font-medium">This run is not available</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        The link may be incorrect, the run may have been reset, or the temporary
        demo data may have expired.
      </p>
      <Link
        to="/"
        className={buttonVariants({ size: "lg", className: "mt-5" })}
      >
        Return to RFQ Relay
      </Link>
    </main>
  )
}

function statusLabel(status: RunStep["status"]): string {
  switch (status) {
    case "complete":
      return "Complete"
    case "active":
      return "Active"
    case "review_required":
      return "Review required"
    case "error":
      return "Stopped"
    default:
      return "Waiting"
  }
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}
