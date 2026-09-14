import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/production")({
  component: ProductionPage,
})

type ProductionImprovement = {
  title: string
  current: string
  improvement: string
}

const PRODUCTION_IMPROVEMENTS = [
  {
    title: "Identity and tenant isolation",
    current:
      "An owner capability stored in this browser controls review and deletion.",
    improvement: "Add accounts, organizations, roles, and tenant isolation.",
  },
  {
    title: "Reliable delivery",
    current: "Delivery creates a simulated ERP webhook receipt.",
    improvement:
      "Use a durable outbox, idempotency, retries, and reconciliation.",
  },
  {
    title: "Operations console",
    current:
      "Langfuse shows run volume, failures, review demand, cost, and business-step latency.",
    improvement:
      "Add service targets, alerts, cost budgets, and operator actions.",
  },
  {
    title: "Retrieval quality",
    current: "Exact aliases and full-text search create the product shortlist.",
    improvement:
      "Add hybrid retrieval, calibrated confidence, and richer decision evidence.",
  },
  {
    title: "Quote output",
    current: "The canonical quote is available as JSON.",
    improvement:
      "Generate branded PDFs, send email, and keep versions and approvals.",
  },
  {
    title: "More RFQ inputs",
    current: "A run accepts email text, PDF, JPEG, and PNG files.",
    improvement:
      "Accept spreadsheets, GAEB, Word, voice, batches, and a shared inbox.",
  },
  {
    title: "Evaluation and quality gates",
    current:
      "Langfuse runs three synthetic scenarios and checks each pull request.",
    improvement:
      "Add held-out sets, calibrated confidence, and broader regression targets.",
  },
  {
    title: "Controlled learning loop",
    current: "Approved corrections create temporary customer-specific aliases.",
    improvement:
      "Create reviewed organization knowledge with provenance and rollback.",
  },
] satisfies ProductionImprovement[]

function ProductionPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="sr-only">Production improvements</h1>

      <section
        className="grid gap-3 lg:grid-cols-2"
        aria-label="Production improvements"
      >
        {PRODUCTION_IMPROVEMENTS.map((item) => (
          <ProductionCard key={item.title} item={item} />
        ))}
      </section>
    </main>
  )
}

function ProductionCard({ item }: { item: ProductionImprovement }) {
  return (
    <article className="overflow-hidden rounded-lg border bg-card shadow-xs">
      <header className="px-4 pt-4 pb-3 sm:px-5 sm:pt-5">
        <h2 className="text-sm leading-5 font-medium tracking-[-0.01em]">
          {item.title}
        </h2>
      </header>

      <dl className="grid gap-4 px-4 pb-4 sm:grid-cols-2 sm:gap-6 sm:px-5 sm:pb-5">
        <div>
          <dt className="text-[11px] leading-4 font-medium tracking-wide text-muted-foreground uppercase">
            Current demo
          </dt>
          <dd className="mt-2 text-[13px] leading-5">{item.current}</dd>
        </div>

        <div>
          <dt className="text-[11px] leading-4 font-medium tracking-wide text-workflow-active uppercase">
            Production improvement
          </dt>
          <dd className="mt-2 text-[13px] leading-5">{item.improvement}</dd>
        </div>
      </dl>
    </article>
  )
}
