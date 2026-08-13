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
  fetchCandidateEvidence,
  fetchCustomerEvidence,
  fetchDocumentEvidence,
  fetchMatchEvidence,
  fetchRun,
  fetchStructureEvidence,
  type CandidateEvidence,
  type CandidateLine,
  type Confidence,
  type CustomerEvidence,
  type DocumentEvidence,
  type EvidenceSource,
  type MatchEvidence,
  type MatchLine,
  type RunStep,
  type RunView,
  type StructureEvidence,
  type ValidatedLine,
  resetRun,
} from "@/lib/api"
import { forgetRun } from "@/lib/run-store"
import { cn } from "@/lib/utils"

const READ_DOCUMENTS_STEP = "read-documents"
const STRUCTURE_RFQ_STEP = "structure-rfq"
const RESOLVE_CUSTOMER_STEP = "resolve-customer"
const RETRIEVE_CANDIDATES_STEP = "retrieve-candidates"
const MATCH_PRODUCTS_STEP = "match-products"
const EVIDENCE_STEPS = [
  READ_DOCUMENTS_STEP,
  STRUCTURE_RFQ_STEP,
  RESOLVE_CUSTOMER_STEP,
  RETRIEVE_CANDIDATES_STEP,
  MATCH_PRODUCTS_STEP,
]
const POLL_INTERVAL_MS = 1000
/** A bound on live polling; the server, not the client, owns step state. */
const POLL_LIMIT_MS = 90_000

type RunSnapshot = RunView & {
  documents: DocumentEvidence | null
  structure: StructureEvidence | null
  customer: CustomerEvidence | null
  candidates: CandidateEvidence | null
  matches: MatchEvidence | null
}

/** One server read of everything the graph shows, used by the loader and the poll. */
async function readRunSnapshot(viewId: string): Promise<RunSnapshot> {
  const view = await fetchRun(viewId)
  const started = (key: string) =>
    view.run.steps.some(
      (entry) => entry.key === key && entry.status !== "waiting"
    )

  const [documents, structure, customer, candidates, matches] =
    await Promise.all([
      started(READ_DOCUMENTS_STEP) ? fetchDocumentEvidence(viewId) : null,
      started(STRUCTURE_RFQ_STEP) ? fetchStructureEvidence(viewId) : null,
      started(RESOLVE_CUSTOMER_STEP) ? fetchCustomerEvidence(viewId) : null,
      started(RETRIEVE_CANDIDATES_STEP) ? fetchCandidateEvidence(viewId) : null,
      started(MATCH_PRODUCTS_STEP) ? fetchMatchEvidence(viewId) : null,
    ])

  return { ...view, documents, structure, customer, candidates, matches }
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
          const panel = evidencePanel(step, snapshot)

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
                panel
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
              {panel}
            </WorkflowStepRow>
          )
        })}
      </ol>

      {stoppedStep ? (
        <p className="mt-2 text-xs text-muted-foreground">
          The workflow stopped at this step. There is no retry in this demo.
        </p>
      ) : null}
    </main>
  )
}

/** Only steps that actually decided something offer evidence. */
function evidencePanel(
  step: RunStep,
  snapshot: RunSnapshot
): React.ReactNode | null {
  if (step.status === "waiting") return null

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
        <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-xs leading-5">
          {evidence.message}
        </p>
      ) : null}

      {validated ? (
        <>
          <div>
            <h3 className="text-[13px] leading-4 font-medium">
              Validated request
            </h3>
            <dl className="mt-2 divide-y rounded-md border text-xs">
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
          <summary className="cursor-pointer px-3 py-2 text-xs">
            Original model output
            {evidence.repaired ? " (repaired before validation)" : ""}
          </summary>
          <pre className="max-h-64 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap">
            {evidence.originalOutput}
          </pre>
        </details>
      ) : null}

      <div>
        <h3 className="text-[13px] leading-4 font-medium">Model and usage</h3>
        <dl className="mt-2 divide-y rounded-md border text-xs">
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
        "rounded-md border px-3 py-2 text-xs",
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
        <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-xs leading-5">
          {evidence.message}
        </p>
      ) : null}

      {evidence.resolution ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">
            Resolved customer
          </h3>
          <dl className="mt-2 divide-y rounded-md border text-xs">
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
          <ul className="mt-2 space-y-1.5 text-xs">
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
          <dl className="mt-2 divide-y rounded-md border text-xs">
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
          <dl className="mt-2 divide-y rounded-md border text-xs">
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
        <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-xs leading-5">
          {evidence.message}
        </p>
      ) : null}

      {evidence.totals && evidence.catalog ? (
        <div>
          <h3 className="text-[13px] leading-4 font-medium">
            What was searched
          </h3>
          <dl className="mt-2 divide-y rounded-md border text-xs">
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
    <li className="rounded-md border px-3 py-2 text-xs">
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
        <p className="rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-xs leading-5">
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
          <dl className="mt-2 divide-y rounded-md border text-xs">
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
          <dl className="mt-2 divide-y rounded-md border text-xs">
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
        "rounded-md border px-3 py-2 text-xs",
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
          <summary className="cursor-pointer px-3 py-2 text-xs">
            Original model output
            {line.repaired ? " (repaired before validation)" : ""}
          </summary>
          <pre className="max-h-64 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap">
            {line.originalOutput}
          </pre>
        </details>
      ) : null}
    </li>
  )
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
