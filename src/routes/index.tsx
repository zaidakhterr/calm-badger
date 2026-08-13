import { useState } from "react"
import {
  ArrowRightIcon,
  FilePdfIcon,
  ImageSquareIcon,
  PaperclipIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import {
  createCustomRun,
  createRun,
  fetchScenarios,
  UPLOAD_LIMITS,
  type Scenario,
} from "@/lib/api"
import { readRecentRuns, rememberOwnedRun } from "@/lib/run-store"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/")({
  loader: () => fetchScenarios(),
  component: LandingPage,
  pendingComponent: LandingPending,
})

function LandingPage() {
  const scenarios = Route.useLoaderData()
  const featured =
    scenarios.find((scenario) => scenario.featured) ?? scenarios[0]
  const [selectedId, setSelectedId] = useState(featured.id)
  const [isStarting, setIsStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [recentRuns] = useState(() => readRecentRuns())
  const [mode, setMode] = useState<"curated" | "custom">("curated")
  const [emailBody, setEmailBody] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const navigate = useNavigate()

  const selected =
    scenarios.find((scenario) => scenario.id === selectedId) ?? featured

  const uploadProblem = mode === "custom" ? describeUploadProblem(files) : null
  const canStart =
    mode === "curated" ||
    (emailBody.trim().length > 0 && uploadProblem === null)

  async function handleProcessRfq() {
    setIsStarting(true)
    setStartError(null)

    try {
      const { run, ownerCapability } =
        mode === "custom"
          ? await createCustomRun({ emailBody: emailBody.trim(), files })
          : await createRun(selected.id)

      // The capability is returned once, so it is stored before navigating.
      rememberOwnedRun({
        viewId: run.viewId,
        scenarioId: run.source.scenarioId,
        ownerCapability,
      })

      await navigate({ to: "/runs/$viewId", params: { viewId: run.viewId } })
    } catch (error) {
      setStartError(
        error instanceof Error ? error.message : "The run could not be started"
      )
      setIsStarting(false)
    }
  }

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

      <section
        className={cn("mt-9", mode === "custom" && "hidden")}
        aria-labelledby="scenario-heading"
      >
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="scenario-heading" className="text-base font-medium">
              Choose a request
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {featured.name} is selected by default.
            </p>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:block">
            Synthetic data only
          </span>
        </div>

        <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
          {scenarios.map((scenario) => (
            <ScenarioCard
              key={scenario.id}
              scenario={scenario}
              isSelected={scenario.id === selected.id}
              onSelect={() => setSelectedId(scenario.id)}
            />
          ))}
        </div>
      </section>

      {mode === "curated" ? (
        <SourcePreview scenario={selected} />
      ) : (
        <CustomSourceForm
          emailBody={emailBody}
          files={files}
          problem={uploadProblem}
          onEmailBodyChange={setEmailBody}
          onFilesChange={setFiles}
        />
      )}

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button
          variant="ghost"
          size="lg"
          type="button"
          onClick={() => {
            setStartError(null)
            setMode(mode === "custom" ? "curated" : "custom")
          }}
        >
          {mode === "custom" ? "Use a curated RFQ" : "Use your own RFQ"}
        </Button>
        <Button
          size="lg"
          type="button"
          className="w-full sm:w-auto"
          disabled={isStarting || !canStart}
          onClick={() => void handleProcessRfq()}
        >
          {isStarting ? "Starting run…" : "Process RFQ"}
          <ArrowRightIcon data-icon="inline-end" weight="bold" />
        </Button>
      </div>

      {startError ? (
        <p className="mt-3 text-xs text-destructive">{startError}</p>
      ) : null}

      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        This public demo is for synthetic or non-confidential documents only.
        Custom uploads accept PDF, JPEG, and PNG files, up to{" "}
        {UPLOAD_LIMITS.maxFiles} files and{" "}
        {UPLOAD_LIMITS.maxBytes / 1024 / 1024} MB combined.
      </p>

      {recentRuns.length > 0 ? (
        <section className="mt-8" aria-labelledby="recent-runs-heading">
          <h2
            id="recent-runs-heading"
            className="text-[13px] leading-4 font-medium"
          >
            Recent runs in this browser
          </h2>
          <ul className="mt-2 divide-y rounded-lg border bg-card">
            {recentRuns.map((recent) => (
              <li key={recent.viewId}>
                <Link
                  to="/runs/$viewId"
                  params={{ viewId: recent.viewId }}
                  className="flex h-11 items-center justify-between gap-3 px-3.5 text-xs hover:bg-muted/40"
                >
                  <span className="truncate">
                    {scenarios.find(({ id }) => id === recent.scenarioId)
                      ?.name ?? "RFQ run"}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {recent.viewId}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  )
}

function ScenarioCard({
  scenario,
  isSelected,
  onSelect,
}: {
  scenario: Scenario
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={onSelect}
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
      {scenario.featured ? (
        <span className="mt-2 inline-flex h-5 items-center rounded-md border border-workflow-active/20 bg-workflow-active-soft px-1.5 text-[11px] font-medium text-workflow-active">
          Featured
        </span>
      ) : null}
      <span className="mt-2 block text-xs leading-5 text-muted-foreground">
        {scenario.difficulty.summary}
      </span>
      <span className="mt-4 block text-[11px] text-muted-foreground">
        {scenario.sources}
      </span>
      <span className="mt-1 block text-[11px] text-muted-foreground">
        Difficulty {scenario.difficulty.level.toLowerCase()} ·{" "}
        {scenario.difficulty.expectedReview}
      </span>
    </button>
  )
}

/**
 * The same limits the Worker enforces, applied in the browser so an
 * unsupported or oversized file is never uploaded in the first place.
 */
function describeUploadProblem(files: File[]): string | null {
  if (files.length > UPLOAD_LIMITS.maxFiles) {
    return `Attach at most ${UPLOAD_LIMITS.maxFiles} files to one request.`
  }

  const unsupported = files.find(
    (file) =>
      !(UPLOAD_LIMITS.accept as readonly string[]).includes(
        file.type.split(";")[0].trim().toLowerCase()
      )
  )

  if (unsupported) {
    return `${unsupported.name} is not a PDF, JPEG, or PNG file.`
  }

  const combined = files.reduce((total, file) => total + file.size, 0)

  if (combined > UPLOAD_LIMITS.maxBytes) {
    return `The attachments are ${formatBytes(combined)} combined; the limit is ${UPLOAD_LIMITS.maxBytes / 1024 / 1024} MB.`
  }

  return null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function CustomSourceForm({
  emailBody,
  files,
  problem,
  onEmailBodyChange,
  onFilesChange,
}: {
  emailBody: string
  files: File[]
  problem: string | null
  onEmailBodyChange: (value: string) => void
  onFilesChange: (files: File[]) => void
}) {
  return (
    <section
      className="mt-6 overflow-hidden rounded-lg border bg-card shadow-xs"
      aria-labelledby="custom-source-heading"
    >
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div>
          <h2 id="custom-source-heading" className="text-[13px] font-medium">
            Your own RFQ
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Paste an email body and attach the documents it refers to.
          </p>
        </div>
        <PaperclipIcon className="size-4 text-muted-foreground" aria-hidden />
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex gap-2.5 rounded-md border border-workflow-review/40 bg-workflow-review-soft/60 p-3 text-xs leading-5">
          <WarningCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <span className="font-medium">
              Submit synthetic or non-confidential material only.
            </span>{" "}
            This is a public demonstration. Uploads and everything derived from
            them are read by an external OCR provider and deleted after 24
            hours.
          </p>
        </div>

        <div>
          <label
            htmlFor="custom-email-body"
            className="text-[13px] leading-4 font-medium"
          >
            Email body
          </label>
          <textarea
            id="custom-email-body"
            value={emailBody}
            onChange={(event) => onEmailBodyChange(event.target.value)}
            rows={7}
            placeholder="Please quote the following items for our north depot…"
            className="mt-2 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        </div>

        <div>
          <label
            htmlFor="custom-files"
            className="text-[13px] leading-4 font-medium"
          >
            Attachments
          </label>
          <input
            id="custom-files"
            type="file"
            multiple
            accept={UPLOAD_LIMITS.acceptAttribute}
            onChange={(event) =>
              onFilesChange(Array.from(event.target.files ?? []))
            }
            className="mt-2 block w-full text-xs file:mr-3 file:h-8 file:rounded-md file:border file:bg-background file:px-2.5 file:text-xs hover:file:bg-muted/40"
          />
          <p className="mt-2 text-[11px] text-muted-foreground">
            PDF, JPEG, or PNG · at most {UPLOAD_LIMITS.maxFiles} files ·{" "}
            {UPLOAD_LIMITS.maxBytes / 1024 / 1024} MB combined
          </p>

          {files.length > 0 ? (
            <ul className="mt-2 divide-y rounded-md border">
              {files.map((file) => (
                <li
                  key={`${file.name}-${file.size}`}
                  className="flex h-10 items-center justify-between gap-3 px-3 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {file.type === "application/pdf" ? (
                      <FilePdfIcon
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    ) : (
                      <ImageSquareIcon
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                    <span className="truncate">{file.name}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatBytes(file.size)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {problem ? (
            <p className="mt-2 text-xs text-destructive">{problem}</p>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function SourcePreview({ scenario }: { scenario: Scenario }) {
  return (
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
            {scenario.email.forwarded
              ? "Forwarded email, inline photo, and PDF attachment"
              : "Email, inline photo, and PDF attachment"}
          </p>
        </div>
        <PaperclipIcon className="size-4 text-muted-foreground" aria-hidden />
      </div>

      <div className="p-4 sm:p-5">
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">From</dt>
          <dd>
            {scenario.email.from.name} · {scenario.email.from.company}
            <span className="block font-mono text-[11px] text-muted-foreground">
              {scenario.email.from.email}
            </span>
          </dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="font-mono text-[11px] text-muted-foreground">
            {scenario.email.to}
          </dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="font-medium">{scenario.email.subject}</dd>
        </dl>

        {scenario.email.forwarded ? (
          <div className="mt-4 rounded-md border bg-muted/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
            Forwarded from {scenario.email.forwarded.from} ·{" "}
            {scenario.email.forwarded.date} · {scenario.email.forwarded.subject}
          </div>
        ) : null}

        <div className="mt-4 border-l-2 pl-4 text-sm leading-6 text-foreground/85">
          {scenario.email.body.map((paragraph) => (
            <p key={paragraph} className="mt-2 first:mt-0">
              {paragraph}
            </p>
          ))}
          <div className="mt-3 text-xs leading-5 text-muted-foreground">
            {scenario.email.signature.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>

        <figure className="mt-5">
          <img
            src={scenario.inlineImage.url}
            alt={scenario.inlineImage.caption}
            width={520}
            height={200}
            loading="lazy"
            className="w-full max-w-md rounded-md border bg-background"
          />
          <figcaption className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ImageSquareIcon className="size-3.5" aria-hidden />
            {scenario.inlineImage.filename} · {scenario.inlineImage.title}
          </figcaption>
        </figure>

        <a
          href={scenario.pdfAttachment.url}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-xs hover:bg-muted/40"
        >
          <FilePdfIcon className="size-4 text-muted-foreground" aria-hidden />
          {scenario.pdfAttachment.filename}
          <span className="text-muted-foreground">
            {scenario.pdfAttachment.caption}
          </span>
        </a>

        <div className="mt-5">
          <h3 className="text-[13px] leading-4 font-medium">
            Requested lines ({scenario.requestedItems.length})
          </h3>
          <ul className="mt-2 divide-y rounded-md border">
            {scenario.requestedItems.map((item) => (
              <li
                key={item.position}
                className="flex min-h-10 items-start gap-3 px-3 py-2 text-xs"
              >
                <span className="mt-0.5 w-3 shrink-0 text-muted-foreground">
                  {item.position}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[11px]">
                    {item.reference}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {item.description} · {item.note}
                  </span>
                </span>
                <span className="shrink-0 text-right whitespace-nowrap">
                  {item.quantity} {item.unit}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 flex gap-2.5 rounded-md border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
          <WarningCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <span className="font-medium text-foreground">
              Difficulty {scenario.difficulty.level.toLowerCase()}.
            </span>{" "}
            {scenario.difficulty.summary} {scenario.difficulty.expectedReview}
          </p>
        </div>
      </div>
    </section>
  )
}

function LandingPending() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <p className="text-sm text-muted-foreground">Loading requests…</p>
    </main>
  )
}
