import { useCallback, useEffect, useState } from "react"
import {
  CaretDownIcon,
  CheckIcon,
  CircleIcon,
  CircleNotchIcon,
  CopySimpleIcon,
  DownloadSimpleIcon,
  FilePdfIcon,
  ImageSquareIcon,
  LinkSimpleIcon,
  EnvelopeSimpleIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  deliverQuote,
  fetchAdapterPreview,
  fetchCandidateEvidence,
  fetchCustomerEvidence,
  fetchDeliveryEvidence,
  fetchDocumentEvidence,
  fetchEstimateEvidence,
  fetchMatchEvidence,
  fetchReview,
  fetchRun,
  fetchStructureEvidence,
  quoteDownloadUrl,
  searchCatalog,
  searchCustomers,
  settleReview,
  submitReviewDecisions,
  type CatalogSearchResult,
  type CustomerSearchResult,
  type Review,
  type ReviewDecisionInput,
  type ReviewItem,
  type CandidateEvidence,
  type CandidateLine,
  type Confidence,
  type CustomerEvidence,
  type DeliveryEvidence,
  type DocumentEvidence,
  type EstimateEvidence,
  type EvidenceSource,
  type MatchEvidence,
  type MatchLine,
  type QuoteLine,
  type RunStep,
  type RunView,
  RunNotFoundError,
  type StructureEvidence,
  type ValidatedLine,
  resetRun,
} from "@/lib/api"
import { usePublishRunHeader } from "@/lib/run-header"
import { forgetRun } from "@/lib/run-store"
import { cn } from "@/lib/utils"

const READ_DOCUMENTS_STEP = "read-documents"
const STRUCTURE_RFQ_STEP = "structure-rfq"
const RESOLVE_CUSTOMER_STEP = "resolve-customer"
const RETRIEVE_CANDIDATES_STEP = "retrieve-candidates"
const MATCH_PRODUCTS_STEP = "match-products"
const REVIEW_STEP = "review-required"
const BUILD_ESTIMATE_STEP = "build-estimate"
const DELIVER_STEP = "deliver"
const DELIVERED_STEP = "delivered"
const EVIDENCE_STEPS = [
  READ_DOCUMENTS_STEP,
  STRUCTURE_RFQ_STEP,
  RESOLVE_CUSTOMER_STEP,
  RETRIEVE_CANDIDATES_STEP,
  MATCH_PRODUCTS_STEP,
  REVIEW_STEP,
  BUILD_ESTIMATE_STEP,
]
const POLL_INTERVAL_MS = 1000
const SLOW_POLL_INTERVAL_MS = 5000
/** Long provider work keeps updating, but backs off after the expected demo window. */
const SLOW_POLL_AFTER_MS = 90_000

type RunSnapshot = RunView & {
  documents: DocumentEvidence | null
  structure: StructureEvidence | null
  customer: CustomerEvidence | null
  candidates: CandidateEvidence | null
  matches: MatchEvidence | null
  review: Review | null
  estimate: EstimateEvidence | null
  delivery: DeliveryEvidence | null
}

/** One server read of everything the graph shows, used by the loader and the poll. */
async function readRunSnapshot(viewId: string): Promise<RunSnapshot> {
  const view = await fetchRun(viewId)
  const started = (key: string) =>
    view.run.steps.some(
      (entry) => entry.key === key && entry.status !== "waiting"
    )

  // The estimate and fixed delivery destination are read once matching has
  // finished, so the delivery node can open as soon as the quote exists.
  const priced = started(MATCH_PRODUCTS_STEP)

  // The review node only exists when the run needed one; when it does, it is
  // the node the reader is being asked to act on.
  const paused = view.run.steps.some((entry) => entry.key === REVIEW_STEP)

  const [
    documents,
    structure,
    customer,
    candidates,
    matches,
    review,
    estimate,
    delivery,
  ] = await Promise.all([
    started(READ_DOCUMENTS_STEP) ? fetchDocumentEvidence(viewId) : null,
    started(STRUCTURE_RFQ_STEP) ? fetchStructureEvidence(viewId) : null,
    started(RESOLVE_CUSTOMER_STEP) ? fetchCustomerEvidence(viewId) : null,
    started(RETRIEVE_CANDIDATES_STEP) ? fetchCandidateEvidence(viewId) : null,
    started(MATCH_PRODUCTS_STEP) ? fetchMatchEvidence(viewId) : null,
    paused ? fetchReview(viewId) : null,
    priced ? fetchEstimateEvidence(viewId) : null,
    priced ? fetchDeliveryEvidence(viewId) : null,
  ])

  return {
    ...view,
    documents,
    structure,
    customer,
    candidates,
    matches,
    review,
    estimate,
    delivery,
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

  const publishHeader = usePublishRunHeader()

  const [snapshot, setSnapshot] = useState<RunSnapshot>(loaded)
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({})
  const [isResetting, setIsResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [pollingNotice, setPollingNotice] = useState<string | null>(null)
  const [isUnavailable, setIsUnavailable] = useState(false)

  const { run, viewer } = snapshot
  const completed = run.steps.filter(
    (step) => step.status === "complete"
  ).length
  const stoppedStep = run.steps.find(
    (step) => step.status === "error" && EVIDENCE_STEPS.includes(step.key)
  )
  const isSettled =
    run.status !== "active" ||
    run.steps.every(
      (step) => step.status !== "active" && step.status !== "waiting"
    )

  // Step state lives on the server. Keep re-reading it until the persisted run
  // settles: a multi-document provider call can legitimately take longer than
  // the usual demo window, and its eventual completion/error must still appear
  // without requiring a reload. Slow work backs off to reduce read traffic.
  useEffect(() => {
    if (isSettled || isUnavailable) return

    let cancelled = false
    let timer: number | undefined
    const startedAt = Date.now()

    const schedule = () => {
      const interval =
        Date.now() - startedAt > SLOW_POLL_AFTER_MS
          ? SLOW_POLL_INTERVAL_MS
          : POLL_INTERVAL_MS
      timer = window.setTimeout(poll, interval)
    }

    const poll = async () => {
      try {
        const next = await readRunSnapshot(viewId)
        if (cancelled) return

        setSnapshot(next)
        setPollingNotice(
          Date.now() - startedAt > SLOW_POLL_AFTER_MS
            ? "This run is taking longer than usual. It is still processing, and this page will keep updating."
            : null
        )
      } catch (error) {
        if (cancelled) return

        if (error instanceof RunNotFoundError) {
          setIsUnavailable(true)
          return
        }

        setPollingNotice(
          "Updates were interrupted. This page will keep trying while the server-owned run continues."
        )
      }

      if (!cancelled) schedule()
    }

    schedule()

    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [isSettled, isUnavailable, viewId])

  /**
   * Start over is a real deletion, not a navigation: the server drops the run's
   * artifacts, this browser forgets the capability and the recent-run entry,
   * and only then does the reviewer return to selection.
   */
  const handleStartOver = useCallback(async () => {
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
  }, [navigate, viewId])

  // The header shows the same state the graph does, from the same snapshot.
  const headerStatus = runStatusSentence(run, completed)
  const canReset = viewer.canMutate

  useEffect(() => {
    if (isUnavailable) {
      publishHeader(null)
      return
    }

    publishHeader({
      status: headerStatus,
      startOver: canReset
        ? {
            label: isResetting ? "Deleting…" : "Start over",
            disabled: isResetting,
            onSelect: () => void handleStartOver(),
          }
        : null,
    })

    return () => publishHeader(null)
  }, [
    publishHeader,
    headerStatus,
    canReset,
    isResetting,
    handleStartOver,
    isUnavailable,
  ])

  if (isUnavailable) return <RunUnavailable />

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-5 items-center rounded-md border border-workflow-active/20 bg-workflow-active-soft px-2 text-[11px] font-medium text-workflow-active">
          {viewer.isOwner ? "Your run" : "Shared view"}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {run.viewId}
        </span>
        <span className="text-[11px] text-muted-foreground">
          started {formatTimestamp(run.createdAt)}
          {run.source.kind === "custom" ? " · your own sources" : ""}
        </span>
      </div>

      {resetError ? (
        <p className="mt-3 text-sm text-destructive">{resetError}</p>
      ) : null}

      <div className="mt-4 flex gap-3 rounded-lg border bg-muted/30 p-3.5 text-[13px] leading-5 text-muted-foreground">
        <LinkSimpleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          {viewer.isOwner
            ? "This run is stored on the server and survives a refresh. Anyone you send this URL to can view it, but only this browser can approve or reset it."
            : "You are viewing a shared run. Anyone holding this URL can view it; approval and reset controls stay with the browser that started the run."}
        </p>
      </div>

      {!isSettled && pollingNotice ? (
        <p className="mt-3 rounded-md border border-workflow-review/30 bg-workflow-review-soft px-3 py-2 text-[13px] leading-5 text-workflow-review">
          {pollingNotice}
        </p>
      ) : null}

      <ol className="mt-6" aria-label="RFQ workflow progress">
        {run.steps.map((step, index) => {
          const panel = evidencePanel(step, snapshot, viewId, () => {
            void readRunSnapshot(viewId).then(setSnapshot)
          })

          return (
            <WorkflowStepRow
              key={step.key}
              step={step}
              isLast={index === run.steps.length - 1}
              nextStatus={run.steps[index + 1]?.status ?? null}
              isOpen={openSteps[step.key] ?? opensItself(step, snapshot)}
              onToggle={
                panel
                  ? () =>
                      setOpenSteps((current) => ({
                        ...current,
                        [step.key]: !(
                          current[step.key] ?? opensItself(step, snapshot)
                        ),
                      }))
                  : null
              }
            >
              {panel}
            </WorkflowStepRow>
          )
        })}
      </ol>

      {stoppedStep ? (
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
          The workflow stopped at this step and will not continue. This demo has
          no retry: start over to run another request.
        </p>
      ) : null}
    </main>
  )
}

/**
 * A node opens by itself when it is where the run currently is: the step doing
 * the work, the step asking for a decision, or the step it stopped at. Anything
 * the reviewer opened by hand is remembered separately and stays open.
 *
 * Deliver is the exception the graph's own status cannot express. It still
 * reads `waiting` while it holds the only action left in the flow, so once the
 * quote exists and nothing has been delivered yet, the node opens itself rather
 * than hiding the delivery action behind "Show evidence".
 */
function opensItself(step: RunStep, snapshot: RunSnapshot): boolean {
  if (
    step.key === DELIVER_STEP &&
    snapshot.delivery?.quoteAvailable &&
    !snapshot.delivery.delivery
  ) {
    return true
  }

  return (
    step.status === "active" ||
    step.status === "review_required" ||
    step.status === "error"
  )
}

/** The one-line status the header carries, from the same polled snapshot. */
function runStatusSentence(run: RunView["run"], completed: number): string {
  const total = run.steps.length
  const stopped = run.steps.find((step) => step.status === "error")

  if (stopped) return `Stopped · ${stopped.title}`

  const review = run.steps.find((step) => step.status === "review_required")
  if (review) return "Waiting for review"

  const activeIndex = run.steps.findIndex((step) => step.status === "active")

  if (activeIndex >= 0) {
    return `${run.steps[activeIndex].title} · step ${activeIndex + 1} of ${total}`
  }

  if (completed === total) return "Complete · delivered"

  return `${completed} of ${total} steps complete`
}

/** Only steps that actually decided something offer evidence. */
function evidencePanel(
  step: RunStep,
  snapshot: RunSnapshot,
  viewId: string,
  onChanged: () => void
): React.ReactNode | null {
  // The review node is the one place a reader is asked to decide rather than
  // to read, so it offers its questions in every state, including waiting.
  if (step.key === REVIEW_STEP && snapshot.review) {
    return (
      <ReviewPanel
        review={snapshot.review}
        viewId={viewId}
        canDecide={snapshot.viewer.canMutate}
        onChanged={onChanged}
      />
    )
  }

  // Delivery is the one node that offers an action while it is still waiting.
  // Once delivered, the terminal node owns the historical delivery evidence.
  if (
    step.key === DELIVER_STEP &&
    snapshot.delivery?.quoteAvailable &&
    !snapshot.delivery.delivery
  ) {
    return (
      <DeliveryPanel
        evidence={snapshot.delivery}
        viewId={viewId}
        canDeliver={snapshot.viewer.canMutate}
        onDelivered={onChanged}
      />
    )
  }

  if (step.key === DELIVERED_STEP && snapshot.delivery?.delivery) {
    return <DeliveredPanel evidence={snapshot.delivery} viewId={viewId} />
  }

  if (step.status === "waiting") return null

  if (step.key === BUILD_ESTIMATE_STEP && snapshot.estimate) {
    return (
      <EstimateEvidencePanel evidence={snapshot.estimate} viewId={viewId} />
    )
  }

  if (step.key === READ_DOCUMENTS_STEP && snapshot.documents) {
    return <DocumentEvidencePanel evidence={snapshot.documents} />
  }

  if (step.key === STRUCTURE_RFQ_STEP && snapshot.structure) {
    return <StructureEvidencePanel evidence={snapshot.structure} />
  }

  if (step.key === RESOLVE_CUSTOMER_STEP && snapshot.customer) {
    return <CustomerEvidencePanel evidence={snapshot.customer} />
  }

  if (step.key === RETRIEVE_CANDIDATES_STEP && snapshot.candidates) {
    return <CandidateEvidencePanel evidence={snapshot.candidates} />
  }

  if (step.key === MATCH_PRODUCTS_STEP && snapshot.matches) {
    return <MatchEvidencePanel evidence={snapshot.matches} />
  }

  return null
}

/**
 * One node of the vertical graph.
 *
 * The title never changes; the status sentence underneath it does, so the
 * column does not reflow as work progresses. State is carried by icon, line
 * treatment, and words as well as colour. The connector below a node traces the
 * step that follows it: it animates only while that next step is running, and
 * turns solid once the path through it is complete.
 */
function WorkflowStepRow({
  step,
  isLast,
  nextStatus,
  isOpen,
  onToggle,
  children,
}: {
  step: RunStep
  isLast: boolean
  nextStatus: RunStep["status"] | null
  isOpen: boolean
  onToggle: (() => void) | null
  children: React.ReactNode
}) {
  const isComplete = step.status === "complete"
  const isActive = step.status === "active"
  const isReview = step.status === "review_required"
  const isError = step.status === "error"
  const elapsed = stepDuration(step)
  const triggerId = `workflow-step-${step.key}-trigger`
  const panelId = `workflow-step-${step.key}-evidence`

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
            isReview &&
              "border-workflow-review bg-workflow-review-soft text-workflow-review",
            isError && "border-destructive bg-destructive/10 text-destructive"
          )}
        >
          {isComplete ? (
            <CheckIcon className="size-3.5" weight="bold" />
          ) : isActive ? (
            <CircleNotchIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : isReview ? (
            <WarningIcon className="size-3.5" />
          ) : isError ? (
            <XIcon className="size-3.5" weight="bold" />
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
              isComplete && nextStatus !== "waiting" && "bg-workflow-complete",
              nextStatus === "active" &&
                "animate-workflow-trace bg-workflow-active bg-gradient-to-b from-workflow-active/25 via-workflow-active to-workflow-active/25 bg-[length:100%_200%] motion-reduce:animate-none"
            )}
          />
        ) : null}
      </div>

      <article
        className={cn(
          "mb-3 overflow-hidden rounded-lg border bg-card shadow-xs",
          isActive && "border-workflow-active/40",
          isReview && "border-workflow-review/40",
          isError && "border-destructive/40"
        )}
      >
        <div
          className={cn("relative px-4 py-3.5", onToggle && "cursor-pointer")}
        >
          {onToggle ? (
            <button
              id={triggerId}
              type="button"
              onClick={onToggle}
              aria-expanded={isOpen}
              aria-controls={panelId}
              aria-label={`${isOpen ? "Hide" : "Show"} evidence for ${step.title}`}
              className="absolute inset-0 z-10 rounded-lg transition-colors outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset"
            />
          ) : null}

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-base leading-5 font-medium">{step.title}</h2>
              <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
                {step.summary}
              </p>
            </div>
            <div className="mt-0.5 flex shrink-0 items-center gap-2">
              <span
                className={cn(
                  "inline-flex h-5 items-center rounded-md border px-2 text-[11px] font-medium whitespace-nowrap text-muted-foreground",
                  isComplete &&
                    "border-workflow-complete/30 bg-workflow-complete-soft text-workflow-complete",
                  isActive &&
                    "border-workflow-active/20 bg-workflow-active-soft text-workflow-active",
                  isReview &&
                    "border-workflow-review/30 bg-workflow-review-soft text-workflow-review",
                  isError &&
                    "border-destructive/30 bg-destructive/10 text-destructive"
                )}
              >
                {statusLabel(step.status)}
              </span>
              {onToggle ? (
                <CaretDownIcon
                  className={cn(
                    "size-4 text-muted-foreground transition-transform",
                    isOpen && "rotate-180"
                  )}
                  aria-hidden
                />
              ) : null}
            </div>
          </div>

          {step.completedAt ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {isError ? "Stopped" : "Completed"} at{" "}
              {formatTimestamp(step.completedAt)}
              {elapsed ? ` · took ${elapsed}` : ""}
            </p>
          ) : null}
        </div>

        {onToggle && isOpen ? (
          <div
            id={panelId}
            role="region"
            aria-labelledby={triggerId}
            className="border-t px-4 py-4"
          >
            {children}
          </div>
        ) : null}
      </article>
    </li>
  )
}

/** How long a finished step actually took, from persisted timestamps. */
function stepDuration(step: RunStep): string | null {
  if (!step.startedAt || !step.completedAt) return null

  const elapsed =
    new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()

  return elapsed > 0 ? formatDuration(elapsed) : null
}

function DocumentEvidencePanel({ evidence }: { evidence: DocumentEvidence }) {
  return (
    <div className="space-y-4">
      {evidence.state === "error" && evidence.message ? (
        <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-sm leading-6">
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
          <dl className="mt-2 divide-y rounded-md border text-[13px]">
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
              value={
                evidence.totals.estimatedCostUsd === null
                  ? "Unknown"
                  : `$${evidence.totals.estimatedCostUsd.toFixed(4)}`
              }
            />
          </dl>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Cost is an estimate from the configured page price, not a billed
            amount. It reads Unknown when that price is not configured.
          </p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Structure RFQ. The order is deliberate: the business result, then the reason
 * to trust it, then the model's own response, then provider metadata.
 */
function StructureEvidencePanel({ evidence }: { evidence: StructureEvidence }) {
  const validated = evidence.validated
  const flagged =
    validated?.lineItems.filter((line) => line.state !== "accepted") ?? []

  return (
    <div className="space-y-4">
      {evidence.message ? (
        <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-sm leading-6">
          {evidence.message}
        </p>
      ) : null}

      {validated ? (
        <>
          <div>
            <h3 className="text-[13px] leading-4 font-medium">
              Validated request
            </h3>
            <dl className="mt-2 divide-y rounded-md border text-[13px]">
              <MetaRow
                label="Company"
                value={validated.customer.companyName ?? "Not stated"}
              />
              <MetaRow
                label="Contact"
                value={
                  validated.customer.contactName ??
                  validated.customer.contactEmail ??
                  "Not stated"
                }
              />
              <MetaRow
                label="Delivery"
                value={validated.customer.deliveryLocation ?? "Not stated"}
              />
              <MetaRow
                label="Deadline"
                value={
                  validated.deadline.text ??
                  validated.deadline.date ??
                  "Not stated"
                }
              />
              <MetaRow label="Channel" value={validated.source.channel} />
            </dl>
          </div>

          <div>
            <h3 className="text-[13px] leading-4 font-medium">
              Line items ({validated.lineItems.length})
            </h3>
            <ul className="mt-2 space-y-2">
              {validated.lineItems.map((line) => (
                <LineItemRow key={line.position} line={line} />
              ))}
            </ul>
            {flagged.length > 0 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {flagged.length}{" "}
                {flagged.length === 1 ? "line needs" : "lines need"} human
                review. The rejected value was discarded rather than carried
                forward.
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {evidence.issues.length > 0 ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">Schema failures</h3>
          <ul className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
            {evidence.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <ConfidenceBlock confidence={evidence.confidence} />

      {evidence.originalOutput ? (
        <details className="rounded-md border bg-background">
          <summary className="cursor-pointer px-3 py-2 text-[13px]">
            Original model output
            {evidence.repaired ? " (repaired before validation)" : ""}
          </summary>
          <CopyableCode value={evidence.originalOutput} />
        </details>
      ) : null}

      <div>
        <h3 className="text-[13px] leading-4 font-medium">Model and usage</h3>
        <dl className="mt-2 divide-y rounded-md border text-[13px]">
          <MetaRow label="Provider" value={evidence.provider ?? "—"} />
          <MetaRow label="Model" value={evidence.model ?? "—"} mono />
          <MetaRow
            label="Model latency"
            value={
              evidence.metrics
                ? formatDuration(evidence.metrics.latencyMs)
                : "—"
            }
          />
          <MetaRow
            label="Step elapsed"
            value={
              evidence.metrics
                ? formatDuration(evidence.metrics.elapsedMs)
                : "—"
            }
          />
          <MetaRow
            label="Tokens"
            value={
              evidence.usage
                ? `${evidence.usage.inputTokens} in · ${evidence.usage.outputTokens} out · ${evidence.usage.totalTokens} total`
                : "—"
            }
          />
          <MetaRow
            label="Estimated cost"
            value={
              evidence.estimatedCostUsd === null
                ? "Unknown"
                : `$${evidence.estimatedCostUsd.toFixed(4)}`
            }
          />
          {evidence.reportedCostUsd !== null ? (
            <MetaRow
              label="Provider-reported cost"
              value={`$${evidence.reportedCostUsd.toFixed(4)}`}
            />
          ) : null}
        </dl>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Cost is an estimate from the configured token prices, not a billed
          amount. It reads Unknown when those prices are not configured, rather
          than showing a misleading zero.
        </p>
      </div>
    </div>
  )
}

function LineItemRow({ line }: { line: ValidatedLine }) {
  const needsReview = line.state !== "accepted"

  return (
    <li
      className={cn(
        "rounded-md border px-3 py-2 text-[13px]",
        needsReview && "border-workflow-review/40 bg-workflow-review-soft/40"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="text-muted-foreground">{line.position}.</span>{" "}
          <span className="font-medium">{line.reference}</span>
          {line.catalogSku ? (
            <span className="ml-2 font-mono text-[11px] text-muted-foreground">
              {line.catalogSku}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">
          {line.quantity === null
            ? "quantity unknown"
            : `${line.quantity}${line.unit ? ` ${line.unit}` : ""}`}
        </span>
      </div>
      {line.description && line.description !== line.reference ? (
        <p className="mt-1 text-muted-foreground">{line.description}</p>
      ) : null}
      <p className="mt-1 text-[11px] text-muted-foreground">
        From {line.sourceLabel}
        {line.sourcePage !== null ? `, page ${line.sourcePage}` : ""}
      </p>
      {needsReview && line.reason ? (
        <p className="mt-1 text-[11px] text-workflow-review">{line.reason}</p>
      ) : null}
    </li>
  )
}

/** Resolve customer. Deterministic, so there is no model metadata to show. */
function CustomerEvidencePanel({ evidence }: { evidence: CustomerEvidence }) {
  return (
    <div className="space-y-4">
      {evidence.message ? (
        <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-sm leading-6">
          {evidence.message}
        </p>
      ) : null}

      {evidence.resolution ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">
            Resolved customer
          </h3>
          <dl className="mt-2 divide-y rounded-md border text-[13px]">
            <MetaRow label="Customer" value={evidence.resolution.name} />
            <MetaRow
              label="Account"
              value={evidence.resolution.customerId}
              mono
            />
            <MetaRow label="Pricing tier" value={evidence.resolution.tier} />
            {evidence.resolution.contact ? (
              <MetaRow
                label="Contact"
                value={`${evidence.resolution.contact.name} · ${evidence.resolution.contact.role}`}
              />
            ) : null}
            {evidence.resolution.location ? (
              <MetaRow
                label="Location"
                value={`${evidence.resolution.location.label}, ${evidence.resolution.location.city}`}
              />
            ) : null}
          </dl>
        </div>
      ) : null}

      {evidence.signals.length > 0 ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">
            Identity evidence
          </h3>
          <ul className="mt-2 space-y-1.5 text-[13px]">
            {evidence.signals.map((signal) => (
              <li key={signal.kind} className="flex items-start gap-2">
                <span className="mt-px shrink-0 font-mono text-[11px] text-muted-foreground">
                  +{signal.weight.toFixed(2)}
                </span>
                <span className="text-muted-foreground">{signal.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {evidence.candidates.length > 1 ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">
            Other candidates
          </h3>
          <dl className="mt-2 divide-y rounded-md border text-[13px]">
            {evidence.candidates.slice(1).map((candidate) => (
              <MetaRow
                key={candidate.customerId}
                label={candidate.name}
                value={candidate.score.toFixed(2)}
              />
            ))}
          </dl>
        </div>
      ) : null}

      <ConfidenceBlock confidence={evidence.confidence} />

      {evidence.inputs ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">
            What was considered
          </h3>
          <dl className="mt-2 divide-y rounded-md border text-[13px]">
            <MetaRow
              label="Sender address"
              value={evidence.inputs.contactEmail ?? "Not stated"}
            />
            <MetaRow
              label="Stated company"
              value={evidence.inputs.companyName ?? "Not stated"}
            />
            <MetaRow
              label="Delivery address"
              value={evidence.inputs.deliveryLocation ?? "Not stated"}
            />
            <MetaRow label="Method" value={evidence.method ?? "—"} mono />
            <MetaRow
              label="Elapsed"
              value={
                evidence.metrics
                  ? formatDuration(evidence.metrics.elapsedMs)
                  : "—"
              }
            />
          </dl>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Identity is decided by catalogue lookups, not by a language model,
            and separately from any product decision.
          </p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Retrieve candidates. The point of the step is the bound, so the catalogue
 * scale and the shortlist size come before the candidates themselves.
 */
function CandidateEvidencePanel({ evidence }: { evidence: CandidateEvidence }) {
  return (
    <div className="space-y-4">
      {evidence.message ? (
        <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-sm leading-6">
          {evidence.message}
        </p>
      ) : null}

      {evidence.totals && evidence.catalog ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">
            What was searched
          </h3>
          <dl className="mt-2 divide-y rounded-md border text-[13px]">
            <MetaRow
              label="Catalogue searched"
              value={`${evidence.catalog.activeProducts} active products (${evidence.catalog.archivedExcluded} archived excluded)`}
            />
            <MetaRow
              label="Settled by exact evidence"
              value={`${evidence.totals.exactCount} of ${evidence.totals.lineCount} lines`}
            />
            <MetaRow
              label="Shortlisted for reranking"
              value={`${evidence.totals.retrievedCount} lines, at most ${evidence.shortlistSize} candidates each`}
            />
            <MetaRow
              label="Customer wording"
              value={
                evidence.customerScoped
                  ? "Included for the resolved customer"
                  : "Unavailable: no customer was resolved"
              }
            />
            <MetaRow label="Method" value={evidence.method ?? "—"} mono />
            <MetaRow
              label="Elapsed"
              value={formatDuration(evidence.totals.elapsedMs)}
            />
          </dl>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Retrieval is a D1 full-text search over the whole active catalogue.
            Only the shortlist below is ever sent to a model.
          </p>
        </div>
      ) : null}

      <div>
        <h3 className="text-[13px] leading-4 font-medium">
          Requested lines ({evidence.lines.length})
        </h3>
        <ul className="mt-2 space-y-2">
          {evidence.lines.map((line) => (
            <CandidateLineRow key={line.position} line={line} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function CandidateLineRow({ line }: { line: CandidateLine }) {
  return (
    <li className="rounded-md border px-3 py-2 text-[13px]">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="text-muted-foreground">{line.position}.</span>{" "}
          <span className="font-medium">{line.reference}</span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">
          {line.state === "exact"
            ? "exact evidence"
            : `${line.candidates.length} candidates`}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{line.note}</p>
      <ul className="mt-1.5 space-y-1">
        {line.candidates.map((candidate) => (
          <li key={candidate.sku} className="flex items-start gap-2">
            <span className="mt-px shrink-0 font-mono text-[11px] text-muted-foreground">
              {candidate.rank}. {candidate.sku}
            </span>
            <span className="min-w-0 text-muted-foreground">
              {candidate.name}
              {candidate.nearDuplicateOf ? (
                <span className="ml-1 text-[11px]">
                  (near duplicate of {candidate.nearDuplicateOf})
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {line.query ? (
        <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
          query: {line.query}
        </p>
      ) : null}
    </li>
  )
}

/**
 * Match products. Business decision first, then the evidence for it, then the
 * alternatives, then the model's own output and its metadata.
 */
function MatchEvidencePanel({ evidence }: { evidence: MatchEvidence }) {
  return (
    <div className="space-y-4">
      {evidence.message ? (
        <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-sm leading-6">
          {evidence.message}
        </p>
      ) : null}

      <div>
        <h3 className="text-[13px] leading-4 font-medium">
          Product decisions ({evidence.lines.length})
        </h3>
        <ul className="mt-2 space-y-2">
          {evidence.lines.map((line) => (
            <MatchLineRow key={line.position} line={line} />
          ))}
        </ul>
      </div>

      {evidence.heuristics ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">
            Acceptance heuristics
          </h3>
          <dl className="mt-2 divide-y rounded-md border text-[13px]">
            <MetaRow
              label="Winner strength"
              value={evidence.heuristics.winnerStrength.toFixed(2)}
            />
            <MetaRow
              label="Winner gap"
              value={evidence.heuristics.winnerGap.toFixed(2)}
            />
          </dl>
          <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
            {evidence.heuristics.note}
          </p>
        </div>
      ) : null}

      {evidence.totals ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">Model and usage</h3>
          <dl className="mt-2 divide-y rounded-md border text-[13px]">
            <MetaRow label="Provider" value={evidence.provider ?? "—"} />
            <MetaRow label="Model" value={evidence.model ?? "—"} mono />
            <MetaRow
              label="Decided without a model"
              value={`${evidence.totals.deterministicCount} of ${evidence.totals.lineCount} lines`}
            />
            <MetaRow
              label="Model calls"
              value={`${evidence.totals.modelCalls} (one per reranked line)`}
            />
            <MetaRow
              label="Model latency"
              value={formatDuration(evidence.totals.providerLatencyMs)}
            />
            <MetaRow
              label="Step elapsed"
              value={formatDuration(evidence.totals.elapsedMs)}
            />
            <MetaRow
              label="Tokens"
              value={
                evidence.totals.usage
                  ? `${evidence.totals.usage.inputTokens} in · ${evidence.totals.usage.outputTokens} out · ${evidence.totals.usage.totalTokens} total`
                  : "—"
              }
            />
            <MetaRow
              label="Estimated cost"
              value={
                evidence.totals.estimatedCostUsd === null
                  ? "Unknown"
                  : `$${evidence.totals.estimatedCostUsd.toFixed(4)}`
              }
            />
          </dl>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Cost is an estimate from the configured token prices, not a billed
            amount. It reads Unknown when those prices are not configured.
          </p>
        </div>
      ) : null}
    </div>
  )
}

function MatchLineRow({ line }: { line: MatchLine }) {
  const needsReview = line.state !== "accepted"

  return (
    <li
      className={cn(
        "rounded-md border px-3 py-2 text-[13px]",
        needsReview && "border-workflow-review/40 bg-workflow-review-soft/40"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="text-muted-foreground">{line.position}.</span>{" "}
          <span className="font-medium">{line.reference}</span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">
          {needsReview ? "Needs review" : "Accepted"}
        </span>
      </div>

      <p className="mt-1">
        {line.sku ? (
          <>
            <span className="font-mono text-[11px]">{line.sku}</span>{" "}
            <span className="text-muted-foreground">{line.productName}</span>
          </>
        ) : (
          <span className="text-muted-foreground">No product selected</span>
        )}
      </p>

      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
        {line.decisionEvidence}
      </p>

      {line.confidence ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {line.confidence.label} · {line.confidence.score.toFixed(2)} ·{" "}
          {line.confidence.heuristic} This is a demo heuristic, not calibrated
          certainty.
        </p>
      ) : null}

      {line.alternatives.length > 1 ? (
        <div className="mt-1.5">
          <p className="text-[11px] text-muted-foreground">
            Top {line.alternatives.length} of {line.shortlistSize} shortlisted:
          </p>
          <ul className="mt-1 space-y-1">
            {line.alternatives.map((alternative) => (
              <li key={alternative.sku} className="flex items-start gap-2">
                <span className="mt-px shrink-0 font-mono text-[11px] text-muted-foreground">
                  {alternative.score.toFixed(2)} {alternative.sku}
                </span>
                <span className="min-w-0 text-muted-foreground">
                  {alternative.name}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {line.rejected.length > 0 ? (
        <p className="mt-1.5 text-[11px] text-workflow-review">
          Discarded before pricing:{" "}
          {line.rejected.map((entry) => entry.sku).join(", ")}
        </p>
      ) : null}

      {line.originalOutput ? (
        <details className="mt-1.5 rounded-md border bg-background">
          <summary className="cursor-pointer px-3 py-2 text-[13px]">
            Original model output
            {line.repaired ? " (repaired before validation)" : ""}
          </summary>
          <CopyableCode value={line.originalOutput} />
        </details>
      ) : null}
    </li>
  )
}

/**
 * Build estimate. The priced lines come first, then the totals, then the rules
 * that produced them, then the canonical document itself.
 */
function EstimateEvidencePanel({
  evidence,
  viewId,
}: {
  evidence: EstimateEvidence
  viewId: string
}) {
  const quote = evidence.quote

  if (!quote) {
    return (
      <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-sm leading-6">
        {evidence.message ??
          "This run is not priced yet. Pricing runs once every line has an accepted product and a confirmed quantity."}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[13px] leading-4 font-medium">
          Estimate {quote.quoteNumber}
        </h3>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {quote.customer.name} · {quote.customer.tier} tier
          {quote.customer.location
            ? ` · ${quote.customer.location.label}, ${quote.customer.location.city}`
            : ""}
        </p>
        <ul className="mt-2 space-y-2">
          {quote.lines.map((line) => (
            <EstimateLineRow key={line.position} line={line} />
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-[13px] leading-4 font-medium">Totals</h3>
        <dl className="mt-2 divide-y rounded-md border text-[13px]">
          <MetaRow
            label="Subtotal (excl. VAT)"
            value={euro(quote.totals.subtotalCents)}
          />
          <MetaRow
            label={`VAT (${(quote.totals.vatRateBp / 100).toFixed(0)}%)`}
            value={euro(quote.totals.vatCents)}
          />
          <MetaRow label="Total (EUR)" value={euro(quote.totals.totalCents)} />
        </dl>
      </div>

      {evidence.rules ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">Pricing rules</h3>
          <dl className="mt-2 divide-y rounded-md border text-[13px]">
            {evidence.rules.applied.map((entry) => (
              <MetaRow
                key={entry.rule}
                label={ruleLabel(entry.rule)}
                value={`${entry.lineCount} ${entry.lineCount === 1 ? "line" : "lines"}`}
              />
            ))}
          </dl>
          <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
            Precedence: {evidence.rules.precedence.map(ruleLabel).join(" → ")}.{" "}
            {evidence.rules.note} {evidence.rules.rounding}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <a
          className={buttonVariants({ variant: "outline", size: "lg" })}
          href={quoteDownloadUrl(viewId)}
          download={`${quote.quoteNumber}.json`}
        >
          <DownloadSimpleIcon data-icon="inline-start" />
          Download canonical quote
        </a>
        <span className="text-[11px] text-muted-foreground">
          Provider-neutral JSON · schema {quote.schema}
        </span>
      </div>

      <details className="rounded-md border bg-background">
        <summary className="cursor-pointer px-3 py-2 text-[13px]">
          Canonical quote
        </summary>
        <CopyableCode
          value={JSON.stringify(quote, null, 2)}
          codeClassName="max-h-72"
        />
      </details>
    </div>
  )
}

function EstimateLineRow({ line }: { line: QuoteLine }) {
  return (
    <li className="rounded-md border px-3 py-2 text-[13px]">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="font-mono text-[11px] text-muted-foreground">
            {line.position}. {line.sku}
          </span>{" "}
          <span className="font-medium">{line.name}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px]">
          {euro(line.subtotalCents)}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {line.quantity} {line.unit} × {euro(line.pricing.unitPriceCents)} ·{" "}
        {line.pricing.ruleLabel}
        {line.pricing.discountBp !== null
          ? ` (${(line.pricing.discountBp / 100).toFixed(2)}%)`
          : ""}
      </p>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
        {line.pricing.explanation}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Requested as “{line.requested.reference}” in{" "}
        {line.requested.sourceLabel}
        {line.requested.sourcePage !== null
          ? `, page ${line.requested.sourcePage}`
          : ""}
        .
      </p>
    </li>
  )
}

/** Deliver through the fixed simulated webhook, with an optional preview. */
/**
 * The review node.
 *
 * It is a normal node in the linear graph, not a modal or a branch: the same
 * evidence for everyone, and controls only for the browser that started the
 * run. Every control chooses between records that already exist — a proposal,
 * one of the top three alternatives, a catalogue search result, an existing
 * customer, or a whole-number quantity. Nothing here creates anything.
 */
function ReviewPanel({
  review,
  viewId,
  canDecide,
  onChanged,
}: {
  review: Review
  viewId: string
  canDecide: boolean
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)

  const open = review.state === "pending"
  const interactive = canDecide && open

  async function apply(decision: ReviewDecisionInput) {
    setError(null)
    setIsWorking(true)

    try {
      await submitReviewDecisions(viewId, [decision])
      onChanged()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "That correction could not be recorded"
      )
    } finally {
      setIsWorking(false)
    }
  }

  async function settle(action: "approve" | "reject") {
    setError(null)
    setIsWorking(true)

    try {
      await settleReview(viewId, action)
      onChanged()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "That decision could not be recorded"
      )
      setIsWorking(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-sm leading-6">
        <p>
          {review.state === "pending"
            ? `${review.resolvedCount} of ${review.itemCount} decisions confirmed. Pricing and delivery stay blocked until this node is approved.`
            : review.state === "approved"
              ? "Approved. The workflow resumed through the same deterministic pricing path."
              : review.state === "rejected"
                ? "Rejected by the owner. The run stops here; nothing was priced."
                : "The review window closed before a decision was made, so this run was never priced."}
        </p>
        {review.expiresAt && open ? (
          <p className="mt-1 text-muted-foreground">
            Decide before {formatDeadline(review.expiresAt)}. A review never
            outlives the run data it decides.
          </p>
        ) : null}
      </div>

      <ol className="space-y-3">
        {review.items.map((item) => (
          <ReviewItemRow
            key={item.id}
            item={item}
            viewId={viewId}
            interactive={interactive && !isWorking}
            onDecide={apply}
          />
        ))}
      </ol>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {interactive ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="lg"
            type="button"
            disabled={!review.canApprove || isWorking}
            onClick={() => void settle("approve")}
          >
            {isWorking ? "Working…" : "Approve matches"}
          </Button>
          <Button
            size="lg"
            variant="outline"
            type="button"
            disabled={isWorking}
            onClick={() => void settle("reject")}
          >
            Reject
          </Button>
          {!review.canApprove ? (
            <span className="text-[11px] text-muted-foreground">
              Confirm every decision above to approve.
            </span>
          ) : null}
        </div>
      ) : null}

      {!canDecide ? (
        <p className="text-[11px] leading-5 text-muted-foreground">
          {review.note}
        </p>
      ) : null}
    </div>
  )
}

function ReviewItemRow({
  item,
  viewId,
  interactive,
  onDecide,
}: {
  item: ReviewItem
  viewId: string
  interactive: boolean
  onDecide: (decision: ReviewDecisionInput) => Promise<void>
}) {
  const [quantity, setQuantity] = useState("")
  const [query, setQuery] = useState("")
  const [products, setProducts] = useState<CatalogSearchResult[] | null>(null)
  const [customers, setCustomers] = useState<CustomerSearchResult[] | null>(
    null
  )
  const [searchError, setSearchError] = useState<string | null>(null)

  const resolved = item.state === "resolved"

  async function search() {
    setSearchError(null)

    try {
      if (item.kind === "customer") {
        setCustomers(await searchCustomers(viewId, query))
      } else {
        setProducts(await searchCatalog(viewId, query))
      }
    } catch (cause) {
      setSearchError(
        cause instanceof Error ? cause.message : "The search failed"
      )
    }
  }

  return (
    <li className="rounded-md border bg-background px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {reviewKindLabel(item.kind)}
            {item.position >= 0 ? ` · line ${item.position}` : ""}
          </p>
          <p className="mt-1 font-mono text-[11px] break-words text-muted-foreground">
            “{item.sourcePhrase}”
          </p>
        </div>
        <span
          className={cn(
            "inline-flex h-5 items-center rounded-md border px-2 text-[11px] font-medium",
            resolved
              ? "border-workflow-complete/30 bg-workflow-complete-soft text-workflow-complete"
              : "border-workflow-review/30 bg-workflow-review-soft text-workflow-review"
          )}
        >
          {resolved ? "Confirmed" : "Needs a decision"}
        </span>
      </div>

      <p className="mt-2 leading-5 text-muted-foreground">{item.detail}</p>

      <ul className="mt-2 space-y-1 text-[11px] leading-5 text-muted-foreground">
        {item.reasons.map((reason) => (
          <li key={reason}>· {reason}</li>
        ))}
      </ul>

      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        Confidence {item.confidence.label} · {item.confidence.score.toFixed(2)}{" "}
        · {item.confidence.heuristic}
      </p>

      {resolved ? (
        <p className="mt-2 leading-5">
          Confirmed:{" "}
          <span className="font-mono">
            {item.resolved.sku ??
              item.resolved.customerId ??
              item.resolved.quantity}
          </span>
        </p>
      ) : (
        <p className="mt-2 leading-5">
          {/* A description of what would be used, not an instruction: the
              label is the catalogue product behind the SKU beside it. */}
          Proposed:{" "}
          {item.proposal.sku ? (
            <>
              <span className="font-mono text-[11px]">{item.proposal.sku}</span>{" "}
              ·{" "}
            </>
          ) : null}
          {item.proposal.label}
        </p>
      )}

      {interactive && !resolved ? (
        <div className="mt-3 space-y-2">
          {/* The action says what the button does; what is being accepted is
              the proposal line above it. */}
          {item.proposal.sku ? (
            <Button
              size="lg"
              type="button"
              onClick={() =>
                void onDecide({ itemId: item.id, action: "accept" })
              }
            >
              Accept proposal
            </Button>
          ) : null}

          {item.kind === "field" ? (
            <Button
              size="lg"
              type="button"
              onClick={() =>
                void onDecide({ itemId: item.id, action: "accept" })
              }
            >
              Confirm this reading
            </Button>
          ) : null}

          {item.alternatives.length > 0 ? (
            <ul className="space-y-1.5">
              {item.alternatives.map((alternative) => (
                <li
                  key={alternative.value}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                >
                  <span className="min-w-0">
                    <span className="font-mono text-[11px]">
                      {alternative.value}
                    </span>{" "}
                    {alternative.label}
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {alternative.detail}
                    </span>
                  </span>
                  <Button
                    size="lg"
                    variant="outline"
                    type="button"
                    onClick={() =>
                      void onDecide(
                        item.kind === "customer"
                          ? {
                              itemId: item.id,
                              action: "alternative",
                              customerId: alternative.value,
                            }
                          : {
                              itemId: item.id,
                              action: "alternative",
                              sku: alternative.value,
                            }
                      )
                    }
                  >
                    Choose
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          {item.kind === "quantity" ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                placeholder="Quantity"
                className="h-8 w-28 rounded-md border bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              />
              <Button
                size="lg"
                type="button"
                onClick={() =>
                  void onDecide({
                    itemId: item.id,
                    action: "quantity",
                    quantity: Number(quantity),
                  })
                }
              >
                Confirm quantity
              </Button>
            </div>
          ) : null}

          {item.kind === "product" || item.kind === "customer" ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={
                    item.kind === "customer"
                      ? "Search existing customers"
                      : "Search the complete catalogue"
                  }
                  className="h-8 min-w-52 flex-1 rounded-md border bg-background px-2.5 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                />
                <Button
                  size="lg"
                  variant="outline"
                  type="button"
                  onClick={() => void search()}
                >
                  Search
                </Button>
              </div>

              {searchError ? (
                <p className="text-[13px] text-destructive">{searchError}</p>
              ) : null}

              {products && item.kind === "product" ? (
                <ul className="max-h-56 space-y-1.5 overflow-auto">
                  {products.map((product) => (
                    <li
                      key={product.sku}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                    >
                      <span className="min-w-0">
                        <span className="font-mono text-[11px]">
                          {product.sku}
                        </span>{" "}
                        {product.name}
                      </span>
                      <Button
                        size="lg"
                        variant="outline"
                        type="button"
                        onClick={() =>
                          void onDecide({
                            itemId: item.id,
                            action: "catalog",
                            sku: product.sku,
                          })
                        }
                      >
                        Use
                      </Button>
                    </li>
                  ))}
                  {products.length === 0 ? (
                    <li className="text-[11px] text-muted-foreground">
                      No active catalogue product matched that search.
                    </li>
                  ) : null}
                </ul>
              ) : null}

              {customers && item.kind === "customer" ? (
                <ul className="max-h-56 space-y-1.5 overflow-auto">
                  {customers.map((customer) => (
                    <li
                      key={customer.customerId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                    >
                      <span className="min-w-0">
                        {customer.name}
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {customer.customerId} · {customer.tier}
                          {customer.city ? ` · ${customer.city}` : ""}
                        </span>
                      </span>
                      <Button
                        size="lg"
                        variant="outline"
                        type="button"
                        onClick={() =>
                          void onDecide({
                            itemId: item.id,
                            action: "customer",
                            customerId: customer.customerId,
                          })
                        }
                      >
                        Select
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}

              <p className="text-[11px] leading-5 text-muted-foreground">
                {item.kind === "customer"
                  ? "Only existing customers can be selected; this demo never creates one from a request."
                  : "Only active catalogue products can be chosen; nothing here creates a product."}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function reviewKindLabel(kind: string): string {
  switch (kind) {
    case "customer":
      return "Customer"
    case "product":
      return "Product match"
    case "quantity":
      return "Quantity"
    default:
      return "Extracted field"
  }
}

function DeliveryPanel({
  evidence,
  viewId,
  canDeliver,
  onDelivered,
}: {
  evidence: DeliveryEvidence
  viewId: string
  canDeliver: boolean
  onDelivered: () => void
}) {
  const [preview, setPreview] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const destination = evidence.adapters[0]
  const delivered = evidence.delivery

  async function handlePreview() {
    setPreview(null)
    setError(null)
    setIsWorking(true)

    try {
      const result = await fetchAdapterPreview(viewId)
      setPreview(JSON.stringify(result.payload, null, 2))
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The payload could not be read"
      )
    } finally {
      setIsWorking(false)
    }
  }

  async function handleDeliver() {
    setError(null)
    setIsWorking(true)

    try {
      await deliverQuote(viewId)
      onDelivered()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The quote could not be sent"
      )
      setIsWorking(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[13px] leading-4 font-medium">
          Delivery destination
        </h3>
        <div className="mt-2 rounded-md border px-3 py-2 text-[13px]">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{destination?.name}</span>
            <span className="inline-flex h-5 items-center rounded-md border border-workflow-review/30 bg-workflow-review-soft px-2 text-[11px] font-medium text-workflow-review">
              Simulated
            </span>
          </span>
          <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">
            {destination?.contract}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
          {destination?.notice}
        </p>
      </div>

      {canDeliver && !delivered ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="lg"
            variant="outline"
            type="button"
            disabled={isWorking}
            onClick={() => void handlePreview()}
          >
            Inspect payload
          </Button>
          <Button
            size="lg"
            type="button"
            disabled={isWorking}
            onClick={() => void handleDeliver()}
          >
            {isWorking ? "Working…" : "Send via simulated webhook"}
          </Button>
        </div>
      ) : null}

      {!canDeliver ? (
        <p className="text-[11px] leading-5 text-muted-foreground">
          Delivery stays with the browser that started this run. A shared viewer
          sees the webhook contract and, once it happens, the delivered payload.
        </p>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {preview ? (
        <details className="rounded-md border bg-background" open>
          <summary className="cursor-pointer px-3 py-2 text-[13px]">
            {destination?.name} payload · {destination?.payloadFormat} · not
            sent yet
          </summary>
          <CopyableCode value={preview} codeClassName="max-h-72" />
        </details>
      ) : null}
    </div>
  )
}

/** Delivered. The terminal node: the synthetic identifier and what was sent. */
function DeliveredPanel({
  evidence,
  viewId,
}: {
  evidence: DeliveryEvidence
  viewId: string
}) {
  const delivered = evidence.delivery
  if (!delivered) return null

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[13px] leading-4 font-medium">
          Simulated external estimate
        </h3>
        <dl className="mt-2 divide-y rounded-md border text-[13px]">
          <MetaRow
            label="External estimate ID"
            value={delivered.externalEstimateId}
            mono
          />
          <MetaRow
            label="Accepted"
            value={formatTimestamp(delivered.deliveredAt)}
          />
        </dl>
        <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
          {delivered.notice}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <a
          className={buttonVariants({ variant: "outline", size: "lg" })}
          href={quoteDownloadUrl(viewId)}
          download={`${evidence.quoteNumber ?? "quote"}.json`}
        >
          <DownloadSimpleIcon data-icon="inline-start" />
          Download canonical quote
        </a>
      </div>

      <details className="rounded-md border bg-background">
        <summary className="cursor-pointer px-3 py-2 text-[13px]">
          Transformed payload
        </summary>
        <CopyableCode
          value={JSON.stringify(delivered.payload, null, 2)}
          codeClassName="max-h-72"
        />
      </details>

      <details className="rounded-md border bg-background">
        <summary className="cursor-pointer px-3 py-2 text-[13px]">
          Adapter receipt
        </summary>
        <CopyableCode value={JSON.stringify(delivered.receipt, null, 2)} />
      </details>
    </div>
  )
}

/** Raw and structured evidence stays selectable and can be copied verbatim. */
function CopyableCode({
  value,
  className,
  codeClassName,
}: {
  value: string
  className?: string
  codeClassName?: string
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle"
  )

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(value)
      setCopyStatus("copied")
    } catch {
      setCopyStatus("error")
    }

    window.setTimeout(() => setCopyStatus("idle"), 2_000)
  }

  const label =
    copyStatus === "copied"
      ? "Copied"
      : copyStatus === "error"
        ? "Copy failed"
        : "Copy"

  return (
    <div className={cn("border-t", className)}>
      <div className="flex justify-end border-b bg-muted/20 px-1.5 py-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void copy()}
          aria-label="Copy evidence to clipboard"
        >
          <CopySimpleIcon data-icon="inline-start" />
          <span aria-live="polite">{label}</span>
        </Button>
      </div>
      <pre
        className={cn(
          "max-h-64 overflow-auto px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap",
          codeClassName
        )}
      >
        {value}
      </pre>
    </div>
  )
}

/** `1490` → `€14.90`, from integer cents, without floating arithmetic. */
function euro(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  const absolute = Math.abs(cents)

  return `${sign}€${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`
}

function ruleLabel(rule: string): string {
  if (rule === "historical_override") return "Historical override"
  if (rule === "customer_tier") return "Customer tier"
  if (rule === "quantity_break") return "Quantity break"
  if (rule === "catalog_base") return "Catalogue base price"
  return rule
}

function ConfidenceBlock({ confidence }: { confidence: Confidence }) {
  if (!confidence) return null

  return (
    <div>
      <h3 className="text-[13px] leading-4 font-medium">Confidence</h3>
      <div className="mt-2 flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-5 items-center rounded-md border px-2 text-[11px] font-medium",
            confidence.label === "High" &&
              "border-workflow-complete/30 bg-workflow-complete-soft text-workflow-complete",
            confidence.label === "Review" &&
              "border-workflow-review/30 bg-workflow-review-soft text-workflow-review"
          )}
        >
          {confidence.label}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {confidence.score.toFixed(2)}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
        {confidence.heuristic} This is a demo heuristic, not calibrated
        certainty.
      </p>
    </div>
  )
}

function SourceEvidenceCard({ source }: { source: EvidenceSource }) {
  return (
    <li className="rounded-md border">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-[13px]">
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
              className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-[13px] hover:bg-muted/40"
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
            <CopyableCode
              value={page.markdown}
              className="mt-1.5 rounded-md border bg-muted/30"
            />
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
            <summary className="cursor-pointer px-3 py-2 text-[13px]">
              Sanitized provider response
            </summary>
            <CopyableCode
              value={JSON.stringify(source.sanitizedResponse, null, 2)}
            />
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

/**
 * Not found, or expired. One compact state with one way back: a run that no
 * longer exists is not a broken graph, and this browser stops offering a link
 * to it.
 */
function RunUnavailable() {
  const { viewId } = Route.useParams()

  useEffect(() => {
    forgetRun(viewId)
  }, [viewId])

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-12 sm:px-6">
      <div className="rounded-lg border bg-card p-5 shadow-xs">
        <h1 className="text-base leading-5 font-medium">
          This run is not available
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The link may be incorrect, the run may have been reset, or its
          short-lived demo data may already be gone. Nothing is broken; there is
          simply nothing left to show.
        </p>
        <Link
          to="/"
          className={buttonVariants({ size: "lg", className: "mt-4" })}
        >
          Start a new request
        </Link>
      </div>
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

/**
 * A deadline, unlike an event that already happened, can sit days away: a
 * seven-day review window shown as a bare clock time reads as "later today".
 * The date is added whenever the instant is not today.
 */
function formatDeadline(value: string): string {
  const deadline = new Date(value)
  const isToday = deadline.toDateString() === new Date().toDateString()

  return isToday
    ? formatTimestamp(value)
    : deadline.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
}
