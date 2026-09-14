import {
  LangfuseClient,
  RegressionError,
  RunnerContext,
} from "@langfuse/client"
import { LangfuseSpanProcessor } from "@langfuse/otel"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { maskContactDetails } from "../worker/langfuse/tracing"
import { experiment } from "./rfq"

const processor = new LangfuseSpanProcessor({ mask: maskContactDetails })
const provider = new NodeTracerProvider({ spanProcessors: [processor] })
provider.register()
const client = new LangfuseClient()
try {
  const result = await experiment(
    new RunnerContext({ client, metadata: { source: "local-public-api" } })
  )
  console.log(
    JSON.stringify({
      datasetRunId: result.datasetRunId,
      datasetRunUrl: result.datasetRunUrl,
      scores: result.runEvaluations,
    })
  )
} catch (error) {
  if (error instanceof RegressionError) {
    console.error(
      JSON.stringify({
        datasetRunId: error.result.datasetRunId,
        datasetRunUrl: error.result.datasetRunUrl,
        scores: error.result.runEvaluations,
      })
    )
    console.error(
      "RFQ experiment detected a regression. See Langfuse for item scores."
    )
  } else {
    console.error(
      "RFQ experiment failed. Check the local Worker and dataset contracts."
    )
    console.error(error)
  }
  process.exitCode = 1
} finally {
  await client.shutdown()
  await provider.shutdown()
}
