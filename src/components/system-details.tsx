import { useEffect, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { ArrowRightIcon, XIcon } from "@phosphor-icons/react"
import { Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import {
  fetchSystemDetails,
  type CatalogueSection,
  type SystemDetails,
} from "@/lib/api"
import { cn } from "@/lib/utils"

/**
 * System details.
 *
 * A drawer rather than a route: technical context is read beside the workflow
 * and never navigates away from it. Everything here comes from the Worker's
 * public projection, so what it says about providers and catalogue scale is
 * what this deployment is actually running. Capabilities that are designed but
 * not yet built are labelled as such instead of quoting a number.
 */
export function SystemDetailsDrawer() {
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState<SystemDetails | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || details) return

    let cancelled = false

    fetchSystemDetails()
      .then((value) => {
        if (!cancelled) setDetails(value)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "System details could not be read"
          )
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, details])

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        render={
          <Button variant="ghost" size="lg" type="button">
            System details
          </Button>
        }
      />
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 right-0 z-50 flex w-screen max-w-md flex-col border-l bg-background shadow-lg transition-transform duration-200 outline-none data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full">
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
            <Dialog.Title className="text-base leading-5 font-medium">
              System details
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="ghost" size="icon-lg" type="button">
                  <XIcon aria-hidden />
                  <span className="sr-only">Close system details</span>
                </Button>
              }
            />
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : !details ? (
              <p className="text-sm text-muted-foreground">
                Reading configuration…
              </p>
            ) : (
              <SystemDetailsBody
                details={details}
                onNavigate={() => setOpen(false)}
              />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SystemDetailsBody({
  details,
  onNavigate,
}: {
  details: SystemDetails
  onNavigate: () => void
}) {
  return (
    <div className="space-y-6">
      <Section title="Architecture">
        <p className="text-sm leading-6 text-muted-foreground">
          {details.architecture.summary}
        </p>
        <ArchitectureDiagram steps={details.architecture.steps} />
        <dl className="mt-3 divide-y rounded-md border">
          {details.architecture.pieces.map((piece) => (
            <div key={piece.name} className="px-3 py-2">
              <dt className="text-[13px] leading-4 font-medium">
                {piece.name}
              </dt>
              <dd className="mt-1 text-[13px] leading-5 text-muted-foreground">
                {piece.detail}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Providers and models">
        <ul className="space-y-2">
          {details.providers.map((provider) => (
            <li key={provider.role} className="rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] leading-4 font-medium">
                  {provider.role}
                </span>
                <StateBadge
                  tone={provider.live ? "active" : "neutral"}
                  label={provider.live ? "Live" : "Simulated"}
                />
              </div>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {provider.provider}
                {provider.model ? ` · ${provider.model}` : ""}
              </p>
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                {provider.detail}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Catalogue">
        <ul className="divide-y rounded-md border text-sm">
          <CatalogueDetailRow
            label="Products"
            value={`${details.catalog.activeProducts} active · ${details.catalog.archivedProducts} archived`}
            section="products"
            onNavigate={onNavigate}
          />
          <CatalogueDetailRow
            label="Customers"
            value={`${details.catalog.customers} accounts · ${details.catalog.contacts} contacts · ${details.catalog.locations} locations`}
            section="customers"
            onNavigate={onNavigate}
          />
          <CatalogueDetailRow
            label="Historical orders"
            value={`${details.catalog.historicalOrders}`}
            section="orders"
            onNavigate={onNavigate}
          />
          <CatalogueDetailRow
            label="Aliases and variants"
            value={`${details.catalog.aliases}`}
            section="aliases"
            onNavigate={onNavigate}
          />
        </ul>
        <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
          {details.catalog.note}
        </p>
      </Section>

      <Section title="Retrieval">
        <ol className="space-y-1.5 text-[13px] leading-5">
          {details.retrieval.steps.map((step, index) => (
            <li key={step} className="flex gap-2.5">
              <span className="font-mono text-[11px] text-muted-foreground">
                {index + 1}
              </span>
              <span className="text-muted-foreground">{step}</span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
          {details.retrieval.note}
        </p>
      </Section>

      <Section
        title="Retention"
        badge={details.retention.state === "enforced" ? null : "Planned"}
      >
        <p className="text-[13px] leading-5 text-muted-foreground">
          {details.retention.summary}
        </p>
        <ul className="mt-2 space-y-1.5 text-[13px] leading-5 text-muted-foreground">
          {details.retention.rows.map((row) => (
            <li key={row}>· {row}</li>
          ))}
        </ul>
      </Section>

      <Section
        title="Rate limit"
        badge={details.rateLimit.state === "enforced" ? null : "Planned"}
      >
        <p className="text-[13px] leading-5 text-muted-foreground">
          {details.rateLimit.summary}
        </p>
      </Section>

      <Section title="Adapter contract">
        <p className="text-[13px] leading-5 text-muted-foreground">
          {details.adapterContract.summary}
        </p>
        <ul className="mt-2 space-y-2">
          {details.adapterContract.adapters.map((adapter) => (
            <li key={adapter.id} className="rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] leading-4 font-medium">
                  {adapter.name}
                </span>
                <StateBadge tone="review" label="Simulated" />
              </div>
              <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                {adapter.contract}
              </p>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {adapter.payloadFormat}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Evaluation"
        badge={details.evaluation.state === "measured" ? null : "Planned"}
      >
        <p className="text-[13px] leading-5 text-muted-foreground">
          {details.evaluation.summary}
        </p>
        <ul className="mt-2 space-y-1.5 text-[13px] leading-5 text-muted-foreground">
          {details.evaluation.rows.map((row) => (
            <li key={row}>· {row}</li>
          ))}
        </ul>
      </Section>
    </div>
  )
}

/** The same vertical sequence the workflow itself draws, in miniature. */
function ArchitectureDiagram({ steps }: { steps: string[] }) {
  return (
    <ol className="mt-3 rounded-md border bg-muted/30 p-3">
      {steps.map((step, index) => (
        <li key={step} className="grid grid-cols-[0.75rem_1fr] gap-2.5">
          <span className="flex flex-col items-center" aria-hidden>
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
            {index < steps.length - 1 ? (
              <span className="w-px flex-1 bg-border" />
            ) : null}
          </span>
          <span className="pb-2 text-[13px] leading-4 text-muted-foreground last:pb-0">
            {step}
          </span>
        </li>
      ))}
    </ol>
  )
}

function Section({
  title,
  badge,
  children,
}: {
  title: string
  badge?: string | null
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-center gap-2">
        <h3 className="text-base leading-5 font-medium">{title}</h3>
        {badge ? <StateBadge tone="review" label={badge} /> : null}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  )
}

function StateBadge({
  tone,
  label,
}: {
  tone: "active" | "review" | "neutral"
  label: string
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md border px-2 text-[11px] font-medium",
        tone === "active" &&
          "border-workflow-active/20 bg-workflow-active-soft text-workflow-active",
        tone === "review" &&
          "border-workflow-review/30 bg-workflow-review-soft text-workflow-review",
        tone === "neutral" && "bg-muted/40 text-muted-foreground"
      )}
    >
      {label}
    </span>
  )
}

function CatalogueDetailRow({
  label,
  value,
  section,
  onNavigate,
}: {
  label: string
  value: string
  section: CatalogueSection
  onNavigate: () => void
}) {
  return (
    <li>
      <Link
        to="/catalogue/$section"
        params={{ section }}
        onClick={onNavigate}
        className="flex h-10 items-center gap-3 px-3 text-[13px] transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset"
      >
        <span className="text-muted-foreground">{label}</span>
        <span className="ml-auto truncate text-right">{value}</span>
        <ArrowRightIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
      </Link>
    </li>
  )
}
