import {
  LangfuseClient,
  RegressionError,
  RunnerContext,
} from "@langfuse/client"
import { LangfuseSpanProcessor } from "@langfuse/otel"
// langfuse/experiment-action loads this package from the project, so it stays.
import { NodeSDK } from "@opentelemetry/sdk-node"
import { maskContactDetails } from "../worker/langfuse/tracing"
import { experiment } from "./rfq"

const processor = new LangfuseSpanProcessor({ mask: maskContactDetails })
const sdk = new NodeSDK({ spanProcessors: [processor] })
sdk.start()
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
  await sdk.shutdown()
}
