#!/usr/bin/env node

/**
 * Runs the reference-workflow evaluation and renders it for a maintainer.
 *
 * The evaluation itself lives in `test/reference-workflows.test.ts`, because
 * driving the Worker's public API is exactly what the test suite already does.
 * This script runs that one file, reads the report it prints, renders a table,
 * and — for the deterministic run — refreshes `worker/evaluation-report.ts`, the
 * committed summary System details serves.
 *
 *   node scripts/run-evaluation.mjs           deterministic, refreshes the summary
 *   node scripts/run-evaluation.mjs --check   deterministic, fails if the summary is stale
 *   node scripts/run-evaluation.mjs --live    live providers, reports latency and usage
 *
 * `--check` is what continuous integration runs: no key, no network, no spend.
 * `--live` selects the live OCR and language-model providers through
 * `vitest.live.config.ts` and never writes anything.
 */

import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import prettier from "prettier"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const reportPath = `${repoRoot}worker/evaluation-report.ts`
const testFile = "test/reference-workflows.test.ts"
const MARKER = /^RFQ_EVAL_REPORT (.+)$/m

const args = new Set(process.argv.slice(2))
const live = args.has("--live")
const check = args.has("--check")

const { report, code } = await runEvaluation(live)

if (!report) {
  console.error(
    "\nThe evaluation produced no report. The output above says why."
  )
  process.exit(code || 1)
}

if (live) {
  renderReport(report)
  renderLive(report)

  if (report.mode !== "live") {
    console.error(
      "\nThis run used the contract fakes, not live providers. Check OCR_PROVIDER,\n" +
        "EXTRACTION_PROVIDER, and RERANK_PROVIDER, and that a key is configured."
    )
    process.exit(1)
  }

  process.exit(code)
}

renderReport(report)

const generated = await renderModule(report)
const committed = readFileSync(reportPath, "utf8")

if (check) {
  if (generated !== committed) {
    console.error(
      "\nworker/evaluation-report.ts is stale — run `pnpm eval:fixtures`."
    )
    process.exit(1)
  }

  console.log("\nThe committed summary matches this evaluation.")
  process.exit(code)
}

if (generated !== committed) {
  writeFileSync(reportPath, generated)
  console.log("\nRefreshed worker/evaluation-report.ts.")

  // The suite compares the committed summary with a fresh evaluation, so a
  // refresh is the ordinary reason a first pass failed. Confirm it now passes.
  if (code !== 0) {
    const confirmation = await runEvaluation(false)
    process.exit(confirmation.code)
  }
} else {
  console.log("\nworker/evaluation-report.ts is already up to date.")
}

process.exit(code)

/* -------------------------------------------------------------------------- */

async function runEvaluation(useLiveProviders) {
  const vitestArgs = ["exec", "vitest", "run", testFile, "--reporter=verbose"]
  if (useLiveProviders) vitestArgs.push("--config", "vitest.live.config.ts")

  const child = spawn("pnpm", vitestArgs, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "inherit"],
  })

  let output = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    output += chunk
    process.stderr.write(chunk)
  })

  const code = await new Promise((resolve) => {
    child.on("close", (value) => resolve(value ?? 1))
  })

  const line = MARKER.exec(output)

  return { report: line ? JSON.parse(line[1]) : null, code }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function renderReport(report) {
  const { totals } = report

  console.log(
    `\nReference workflows — ${report.mode === "live" ? "live providers" : "deterministic contract fakes"}`
  )
  console.log(
    `  OCR: ${report.providers.ocr} · extraction: ${report.providers.extraction} · reranking: ${report.providers.rerank}\n`
  )

  for (const scenario of report.scenarios) {
    console.log(`  ${scenario.scenarioId}`)
    console.log(`    workflow            ${scenario.workflowState}`)
    console.log(
      `    extraction          ${scenario.extraction.lineCount}/${scenario.extraction.lineCountInGold} lines · sources ${scenario.extraction.sources.join(", ")} · delivery place ${yesNo(scenario.extraction.deliveryLocationCarried)}`
    )
    console.log(
      `    resolution          ${scenario.resolution.customerId ?? "unresolved"} ${yesNo(scenario.resolution.customerCorrect)} · location ${yesNo(scenario.resolution.locationCorrect)}`
    )
    console.log(
      `    retrieval           ${scenario.retrieval.shortlistHits}/${scenario.retrieval.lines} in a shortlist of ${scenario.retrieval.shortlistSize}`
    )
    console.log(
      `    reranking           top three ${scenario.reranking.topThreeHits}/${scenario.reranking.lines} · winner ${scenario.reranking.winnerCorrect}/${scenario.reranking.lines} · ${scenario.reranking.modelCalls} model calls`
    )
    console.log(
      `    review              asked ${format(scenario.review.linesObserved)} · fixtures ${format(scenario.review.linesInGold)} · extra ${format(scenario.review.extraLines)} · missed ${format(scenario.review.missedLines)}`
    )
    console.log(
      `    pricing             ${scenario.pricing.lineCount} lines · ${(scenario.pricing.totalCents / 100).toFixed(2)} EUR incl. VAT · ${scenario.pricing.rules.join(", ") || "no rules"}`
    )
    console.log(
      `    export              ${scenario.export.adapter ?? "not delivered"} ${yesNo(scenario.export.hasExternalId)} (simulated)`
    )
    console.log(
      `    selection           ${scenario.selection.correct}/${scenario.selection.lines} correct · quantities ${scenario.selection.quantityCorrect}/${scenario.selection.lines}\n`
    )
  }

  console.log(
    `  Totals: ${totals.selectionCorrect}/${totals.lines} lines selected as the fixtures answer them,\n` +
      `          top-three recall ${totals.topThreeHits}/${totals.lines}, customers ${totals.customerCorrect}/${totals.scenarios},\n` +
      `          review asked on ${totals.reviewLinesObserved} lines against ${totals.reviewLinesInGold} in the fixtures\n` +
      `          (${totals.extraReviewLines} extra, ${totals.missedReviewLines} missed),\n` +
      `          differing lines: ${totals.divergedAfterAsking} after asking, ${totals.divergedWithoutAsking} without asking,\n` +
      `          priced ${totals.priced}/${totals.scenarios}, exported ${totals.delivered}/${totals.scenarios}.`
  )

  if (report.failures.length > 0) {
    console.log("\n  Divergences from the fixtures:")
    for (const failure of report.failures) console.log(`    · ${failure}`)
  } else {
    console.log("\n  No divergence from the fixtures.")
  }
}

function renderLive(report) {
  console.log("\n  Latency, usage, and failures")

  for (const scenario of report.scenarios) {
    const { timings, usage } = scenario
    console.log(`    ${scenario.scenarioId}`)
    console.log(
      `      wall clock        ${timings.wallClockMs} ms (includes polling)`
    )
    console.log(
      `      provider latency  OCR ${ms(timings.ocrLatencyMs)} · extraction ${ms(timings.extractionLatencyMs)} · reranking ${ms(timings.rerankLatencyMs)}`
    )
    console.log(
      `      usage             ${usage.pagesProcessed ?? "?"} pages · ${usage.extractionTokens ?? "?"} extraction tokens · ${usage.rerankTokens ?? "?"} reranking tokens`
    )
    console.log(
      `      estimated cost    ${usage.estimatedCostUsd === null ? "not priced" : `$${usage.estimatedCostUsd.toFixed(4)}`}`
    )
  }

  console.log(
    "\n  Costs are estimates from configured per-token and per-page prices, not an invoice."
  )
}

function yesNo(value) {
  return value ? "yes" : "no"
}

function ms(value) {
  return value === null ? "n/a" : `${value} ms`
}

function format(positions) {
  return positions.length > 0 ? positions.join("/") : "none"
}

/* -------------------------------------------------------------------------- */
/* The committed summary                                                      */
/* -------------------------------------------------------------------------- */

async function renderModule(report) {
  // The harness derives the summary itself, so the generated file and the
  // assertion in the suite cannot drift apart through two mappings.
  const summary = report.summary

  const source = `// Generated by \`pnpm eval:fixtures\`. Do not edit by hand.
//
// Counts only: the scoring inputs, the request wording, and the fixture answers
// stay in the test suite. \`test/reference-workflows.test.ts\` fails if this file
// drifts from a fresh deterministic evaluation, and no timing is recorded here,
// so a rerun that measured the same behaviour produces the same bytes.

import type { ReferenceEvaluationSummary } from "./evaluation-summary"

export const REFERENCE_EVALUATION: ReferenceEvaluationSummary = ${JSON.stringify(summary)}
`

  return prettier.format(source, {
    ...(await prettier.resolveConfig(reportPath)),
    filepath: reportPath,
  })
}
