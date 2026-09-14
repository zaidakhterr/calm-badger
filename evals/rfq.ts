import { trace } from "@opentelemetry/api"
import { LangfuseOtelSpanAttributes } from "@langfuse/core"
import { maskContactDetails } from "../worker/langfuse/tracing"
import {
  RegressionError,
  type RunnerContext,
  type Evaluation,
} from "@langfuse/client"
import { z } from "zod"
import { generateCatalog } from "../worker/catalog/dataset"
import { SCENARIOS } from "../worker/scenarios"
import {
  EXPECTED_OUTPUT,
  RUN_PROJECTION,
  SCENARIO_INPUT,
  SCENARIO_METADATA,
} from "./_contracts"
import {
  evaluateExperiment,
  evaluateRun,
  isRegression,
  evaluateRequest,
  evaluateReviewExpectation,
} from "./_evaluators"
import { driveRun, requireLiveProviders, type RunFetcher } from "./_task"

/** Entry point for langfuse/experiment-action v1.0.10 and the local runner. */
export async function experiment(context: RunnerContext) {
  const base = new URL(process.env.RFQ_BASE_URL ?? "http://localhost:8787")
  if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    throw new Error("Experiments require a local Worker")
  const fetcher: RunFetcher = (path, init) => fetch(new URL(path, base), init)
  await requireLiveProviders(fetcher)
  const data =
    context.data ??
    (
      await context.client.dataset.get("rfq-scenarios", {
        version: context.datasetVersion,
      })
    ).items
  const inputs = data.map((item) => SCENARIO_INPUT.parse(item.input))
  if (
    inputs.length !== SCENARIOS.length ||
    SCENARIOS.some(
      (scenario) =>
        inputs.filter((input) => input.scenarioId === scenario.id).length !== 1
    )
  )
    throw new Error("Dataset must contain each curated scenario exactly once")
  for (const item of data) {
    SCENARIO_METADATA.parse(item.metadata)
    const expected = EXPECTED_OUTPUT.parse(item.expectedOutput)
    const input = SCENARIO_INPUT.parse(item.input)
    const scenario = SCENARIOS.find((entry) => entry.id === input.scenarioId)
    if (expected.lines.length !== scenario?.requestedItems.length)
      throw new Error("Dataset line count must cover every requested line")
  }
  const catalog = generateCatalog()
  const result = await context.runExperiment({
    name: "RFQ Relay curated scenarios",
    data,
    maxConcurrency: 1,
    task: ({ input, expectedOutput }) => {
      // The action owns its exporter. Mask the SDK's expected-output span attribute
      // here while retaining Cloud answers for the pure evaluator.
      trace.getActiveSpan()?.setAttribute(
        LangfuseOtelSpanAttributes.EXPERIMENT_ITEM_EXPECTED_OUTPUT,
        maskContactDetails({
          data: JSON.stringify(EXPECTED_OUTPUT.parse(expectedOutput)),
        })
      )
      return driveRun(fetcher, SCENARIO_INPUT.parse(input)).then((output) =>
        RUN_PROJECTION.parse(
          JSON.parse(maskContactDetails({ data: JSON.stringify(output) }))
        )
      )
    },
    evaluators: [
      async ({ input, expectedOutput, output, metadata }) => {
        const scores = await evaluateRun(
          SCENARIO_INPUT.parse(input),
          EXPECTED_OUTPUT.parse(expectedOutput),
          RUN_PROJECTION.parse(output),
          catalog
        )
        const inputValue = SCENARIO_INPUT.parse(input)
        const requestedItems =
          SCENARIOS.find((scenario) => scenario.id === inputValue.scenarioId)
            ?.requestedItems ?? []
        return Object.entries({
          ...scores,
          ...evaluateReviewExpectation(
            EXPECTED_OUTPUT.parse(expectedOutput),
            SCENARIO_METADATA.parse(metadata)
          ),
          ...evaluateRequest(
            EXPECTED_OUTPUT.parse(expectedOutput),
            requestedItems
          ),
        }).map(
          ([name, value]) =>
            ({ name, value, dataType: "NUMERIC" }) satisfies Evaluation
        )
      },
    ],
    runEvaluators: [
      async ({ itemResults }) => {
        const totals = await evaluateExperiment(
          data.map((source) => ({
            input: SCENARIO_INPUT.parse(source.input),
            expectedOutput: EXPECTED_OUTPUT.parse(source.expectedOutput),
          })),
          itemResults.map((result) => {
            const output = RUN_PROJECTION.safeParse(result.output)
            return {
              item: { input: SCENARIO_INPUT.parse(result.item.input) },
              output: output.success ? output.data : null,
              evaluations: result.evaluations,
            }
          }),
          catalog
        )
        return [
          ...Object.entries(totals).map(
            ([name, value]) =>
              ({ name, value, dataType: "NUMERIC" }) satisfies Evaluation
          ),
          {
            name: "regression",
            value: Number(isRegression(totals)),
            dataType: "NUMERIC",
          } satisfies Evaluation,
        ]
      },
    ],
  })
  const regression = z
    .literal(0)
    .safeParse(
      result.runEvaluations.find((score) => score.name === "regression")?.value
    )
  if (!regression.success) throw new RegressionError({ result })
  return result
}
