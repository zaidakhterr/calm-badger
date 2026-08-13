import { useState } from "react"
import {
  ArrowClockwiseIcon,
  CheckIcon,
  CircleIcon,
  CircleNotchIcon,
  LinkSimpleIcon,
  WarningIcon,
} from "@phosphor-icons/react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"

import { Button, buttonVariants } from "@/components/ui/button"
import { fetchRun, resetRun, type RunStep } from "@/lib/api"
import { forgetRun } from "@/lib/run-store"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/runs/$viewId")({
  loader: ({ params }) => fetchRun(params.viewId),
  component: RunPage,
  pendingComponent: RunPending,
  errorComponent: RunUnavailable,
})

function RunPage() {
  const { viewId } = Route.useParams()
  const { run, viewer } = Route.useLoaderData()
  const navigate = useNavigate()
  const [isResetting, setIsResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)

  const completed = run.steps.filter(
    (step) => step.status === "complete"
  ).length

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
        {run.steps.map((step, index) => (
          <WorkflowStepRow
            key={step.key}
            step={step}
            isLast={index === run.steps.length - 1}
          />
        ))}
      </ol>
    </main>
  )
}

function WorkflowStepRow({ step, isLast }: { step: RunStep; isLast: boolean }) {
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
              isComplete && "bg-workflow-complete"
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
      </article>
    </li>
  )
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
