import { useState } from "react"
import {
  ArrowRightIcon,
  FileImageIcon,
  FilePdfIcon,
  PaperclipIcon,
} from "@phosphor-icons/react"
import { createFileRoute, Link } from "@tanstack/react-router"

import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const scenarios = [
  {
    id: "routine-replenishment",
    name: "Routine replenishment",
    difficulty: "Clean request with known SKUs and customer details.",
    sources: "Email · PDF · image",
    review: "Expected to complete automatically",
    sender: "Lena Vogt",
    company: "Northline Property Services",
    subject: "Replenishment request — August",
    preview:
      "Hi team, please quote the attached replenishment list for our Berlin service depot. The six usual items and delivery to the Spandau location, please.",
  },
  {
    id: "messy-forwarded-request",
    name: "Messy forwarded request",
    difficulty: "Forwarded thread with incomplete names and mixed sources.",
    sources: "Forwarded email · PDF · image",
    review: "One match may require review",
    sender: "Marta Klein",
    company: "Bergmann Facility Group",
    subject: "Fwd: parts for the maintenance round",
    preview:
      "Could you price these for the south site? Quantities are in Daniel’s note below. The photo is the replacement fitting we discussed; I’m not sure the old item number is still current.",
  },
  {
    id: "ambiguous-replacement-parts",
    name: "Ambiguous replacement parts",
    difficulty: "Near-duplicate products with an archived reference.",
    sources: "Email · PDF · image",
    review: "Product confirmation expected",
    sender: "Jonas Richter",
    company: "Westmark Industrial Care",
    subject: "Quote needed: replacement parts",
    preview:
      "Please find our replacement request attached. The labels on two units are worn, so I included photos and the measurements from our technician.",
  },
] as const

type ScenarioId = (typeof scenarios)[number]["id"]

export const Route = createFileRoute("/")({
  component: LandingPage,
})

function LandingPage() {
  const [selectedId, setSelectedId] = useState<ScenarioId>(
    "messy-forwarded-request"
  )
  const selectedScenario = scenarios.find(({ id }) => id === selectedId)!

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <section aria-labelledby="page-title">
        <p className="text-[13px] font-medium text-muted-foreground">
          Auditable quote workflow
        </p>
        <h1
          id="page-title"
          className="mt-2 max-w-xl text-2xl leading-tight font-medium tracking-[-0.025em]"
        >
          Turn a messy request into a quote you can explain.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          Choose a synthetic RFQ to inspect how documents, customer evidence,
          product decisions, and pricing move through one traceable workflow.
        </p>
      </section>

      <section className="mt-9" aria-labelledby="scenario-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="scenario-heading" className="text-base font-medium">
              Choose a request
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Messy forwarded request is selected by default.
            </p>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:block">
            Synthetic data only
          </span>
        </div>

        <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
          {scenarios.map((scenario) => {
            const isSelected = scenario.id === selectedId

            return (
              <button
                key={scenario.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelectedId(scenario.id)}
                className={cn(
                  "relative min-h-40 rounded-lg border bg-card p-4 text-left shadow-xs transition-colors outline-none hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30",
                  isSelected && "border-foreground bg-muted/30"
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-4 right-4 size-3 rounded-full border",
                    isSelected && "border-[3px] border-foreground"
                  )}
                />
                <span className="block pr-5 text-[13px] leading-4 font-medium">
                  {scenario.name}
                </span>
                <span className="mt-2 block text-xs leading-5 text-muted-foreground">
                  {scenario.difficulty}
                </span>
                <span className="mt-4 block text-[11px] text-muted-foreground">
                  {scenario.sources}
                </span>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  {scenario.review}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section
        className="mt-6 overflow-hidden rounded-lg border bg-card shadow-xs"
        aria-labelledby="source-preview-heading"
      >
        <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
          <div>
            <h2 id="source-preview-heading" className="text-[13px] font-medium">
              Source preview
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Forwarded email and two attachments
            </p>
          </div>
          <PaperclipIcon className="size-4 text-muted-foreground" aria-hidden />
        </div>

        <div className="p-4 sm:p-5">
          <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">From</dt>
            <dd>
              {selectedScenario.sender} · {selectedScenario.company}
            </dd>
            <dt className="text-muted-foreground">Subject</dt>
            <dd className="font-medium">{selectedScenario.subject}</dd>
          </dl>

          <div className="mt-5 border-l-2 pl-4 text-sm leading-6 text-foreground/85">
            <p>Hello,</p>
            <p className="mt-2">{selectedScenario.preview}</p>
            <p className="mt-2">Thanks,</p>
            <p>{selectedScenario.sender.split(" ")[0]}</p>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <span className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-xs">
              <FilePdfIcon
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              requested-items.pdf
            </span>
            <span className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-xs">
              <FileImageIcon
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              fitting-reference.jpg
            </span>
          </div>
        </div>
      </section>

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" size="lg" type="button" disabled>
          Use your own RFQ
          <span className="text-muted-foreground">Coming next</span>
        </Button>
        <Link
          to="/runs/$viewId"
          params={{ viewId: `sample-${selectedScenario.id}` }}
          className={buttonVariants({
            size: "lg",
            className: "w-full sm:w-auto",
          })}
        >
          Process RFQ
          <ArrowRightIcon data-icon="inline-end" weight="bold" />
        </Link>
      </div>

      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        This public demo is for synthetic or non-confidential documents only.
        Custom uploads will accept PDF, JPEG, and PNG files up to 10 MB.
      </p>
    </main>
  )
}
