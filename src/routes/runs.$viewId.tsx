import {
  CheckIcon,
  CircleIcon,
  CircleNotchIcon,
  InfoIcon,
} from "@phosphor-icons/react"
import { createFileRoute } from "@tanstack/react-router"

import { cn } from "@/lib/utils"

const workflowSteps = [
  {
    title: "RFQ received",
    status: "complete",
    detail: "Source registered for this route preview.",
  },
  {
    title: "Read documents",
    status: "active",
    detail: "The live document provider will connect at this step.",
  },
  {
    title: "Structure RFQ",
    status: "waiting",
    detail: "Waiting for validated document text.",
  },
  {
    title: "Resolve customer",
    status: "waiting",
    detail: "Waiting for structured customer evidence.",
  },
  {
    title: "Retrieve candidates",
    status: "waiting",
    detail: "Waiting for extracted line items.",
  },
  {
    title: "Match products",
    status: "waiting",
    detail: "Waiting for the bounded candidate shortlist.",
  },
  {
    title: "Build estimate",
    status: "waiting",
    detail: "Waiting for confirmed customer and product matches.",
  },
  {
    title: "Deliver",
    status: "waiting",
    detail: "Waiting for the canonical quote.",
  },
  {
    title: "Delivered",
    status: "waiting",
    detail: "The simulated external estimate will finish here.",
  },
] as const

export const Route = createFileRoute("/runs/$viewId")({
  component: RunPage,
})

function RunPage() {
  const { viewId } = Route.useParams()

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex h-5 items-center rounded-md border border-workflow-active/20 bg-workflow-active-soft px-2 text-[11px] font-medium text-workflow-active">
              Foundation preview
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {viewId}
            </span>
          </div>
          <h1 className="mt-3 text-xl leading-7 font-medium tracking-[-0.02em]">
            RFQ workflow
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The typed run route is ready for persisted workflow state.
          </p>
        </div>
      </div>

      <div className="mt-7 flex gap-3 rounded-lg border bg-muted/30 p-3.5 text-xs leading-5 text-muted-foreground">
        <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          This screen demonstrates the routing and visual shell only. It does
          not advance steps with client-side timers; later slices will render
          persisted backend state here.
        </p>
      </div>

      <ol className="mt-7" aria-label="RFQ workflow progress">
        {workflowSteps.map((step, index) => (
          <WorkflowStep
            key={step.title}
            {...step}
            isLast={index === workflowSteps.length - 1}
          />
        ))}
      </ol>
    </main>
  )
}

type WorkflowStepProps = (typeof workflowSteps)[number] & {
  isLast: boolean
}

function WorkflowStep({ title, status, detail, isLast }: WorkflowStepProps) {
  const isComplete = status === "complete"
  const isActive = status === "active"

  return (
    <li className="grid grid-cols-[1.75rem_1fr] gap-3">
      <div className="flex flex-col items-center" aria-hidden>
        <span
          className={cn(
            "z-10 flex size-7 items-center justify-center rounded-full border bg-background",
            isComplete &&
              "border-workflow-complete bg-workflow-complete-soft text-workflow-complete",
            isActive &&
              "border-workflow-active bg-workflow-active-soft text-workflow-active"
          )}
        >
          {isComplete ? (
            <CheckIcon className="size-3.5" weight="bold" />
          ) : isActive ? (
            <CircleNotchIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
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
          isActive && "border-workflow-active/40"
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[13px] leading-4 font-medium">{title}</h2>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              {detail}
            </p>
          </div>
          <span
            className={cn(
              "mt-0.5 text-[11px] whitespace-nowrap text-muted-foreground",
              isComplete && "text-workflow-complete",
              isActive && "text-workflow-active"
            )}
          >
            {isComplete ? "Complete" : isActive ? "Active" : "Waiting"}
          </span>
        </div>
      </article>
    </li>
  )
}
