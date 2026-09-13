/** Seed a fresh project. Existing UI-authored prompts and labels remain authoritative. */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { z } from "zod"

const root = fileURLToPath(new URL("../", import.meta.url))
const envelope = z.object({ status: z.number(), body: z.json() })
const promptVersion = z.object({ name: z.string(), version: z.number() })

function cli(args, input) {
  const result = spawnSync(
    "npx",
    ["-y", "langfuse-cli", "api", ...args, "--json"],
    {
      cwd: root,
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        LANGFUSE_HOST:
          process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST,
      },
      maxBuffer: 8 * 1024 * 1024,
    }
  )
  const parsed = envelope.safeParse(JSON.parse(result.stdout || "null"))
  if (!parsed.success)
    throw new Error("Langfuse CLI returned no readable response")
  return parsed.data
}

async function syncPrompts(loader) {
  // Vite resolves the same TypeScript fallback used by the Worker. Middleware mode opens no listener.
  const { bundledPrompt } = await loader.ssrLoadModule(
    "/worker/langfuse/fallbacks.ts"
  )
  const fallback = bundledPrompt("rfq/extract")
  const existing = cli(["prompts", "get", fallback.name, "--label", "latest"])
  if (existing.status === 200) {
    const prompt = promptVersion.parse(existing.body)
    console.log(
      `Preserved ${prompt.name} version ${prompt.version}; Langfuse owns edits and labels.`
    )
    return
  }
  if (existing.status !== 404)
    throw new Error(`Prompt lookup failed (${existing.status})`)
  const created = cli(
    ["prompts", "create", "--body-file", "-"],
    JSON.stringify({
      name: fallback.name,
      type: "chat",
      prompt: fallback.prompt,
      config: fallback.config,
      labels: ["production"],
      commitMessage: "Ticket 02: migrate the extraction prompt and schema",
    })
  )
  if (created.status < 200 || created.status >= 300)
    throw new Error(`Prompt creation failed (${created.status})`)
  const prompt = promptVersion.parse(created.body)
  console.log(
    `Created ${prompt.name} version ${prompt.version} with label production.`
  )
}

async function syncDataset(loader) {
  const datasetName = "rfq-scenarios"
  const existing = cli(["datasets", "get", datasetName])
  if (existing.status === 404) {
    const created = cli(
      ["datasets", "create", "--body-file", "-"],
      JSON.stringify({
        name: datasetName,
        description:
          "Curated RFQ Relay scenarios and gold answers for end-to-end experiments.",
      })
    )
    if (created.status < 200 || created.status >= 300)
      throw new Error(`Dataset creation failed (${created.status})`)
  } else if (existing.status !== 200) {
    throw new Error(`Dataset lookup failed (${existing.status})`)
  }

  const [{ SCENARIOS }, { GOLD_SCENARIOS }] = await Promise.all([
    loader.ssrLoadModule("/worker/scenarios.ts"),
    loader.ssrLoadModule("/test/fixtures/gold-scenarios.ts"),
  ])
  for (const gold of GOLD_SCENARIOS) {
    const scenario = SCENARIOS.find(
      (candidate) => candidate.id === gold.scenarioId
    )
    if (!scenario)
      throw new Error(`No scenario for gold fixture: ${gold.scenarioId}`)
    const expectedReview = gold.expectedReviewPositions.length > 0
    const item = cli(
      ["dataset-items", "create", "--body-file", "-"],
      JSON.stringify({
        datasetName,
        id: `rfq-scenarios-${gold.scenarioId}`,
        input: {
          scenarioId: gold.scenarioId,
          sources: [
            "Email body",
            scenario.inlineImage.filename,
            scenario.pdfAttachment.filename,
          ],
        },
        expectedOutput: {
          customerId: gold.customer.customerId,
          contactEmail: gold.customer.contactEmail,
          locationId: gold.customer.locationId,
          lines: gold.matches.map(
            ({
              position,
              sourceReference,
              quantity,
              expectedSku,
              decision,
              basis,
              alternatives,
            }) => ({
              position,
              sourceReference,
              quantity,
              expectedSku,
              decision,
              basis,
              alternatives,
            })
          ),
          expectedReviewPositions: gold.expectedReviewPositions,
        },
        metadata: {
          difficulty: scenario.difficulty.level,
          expectedReview,
        },
      })
    )
    if (item.status < 200 || item.status >= 300)
      throw new Error(
        `Dataset item upsert failed for ${gold.scenarioId} (${item.status})`
      )
    console.log(`Upserted dataset item ${gold.scenarioId}.`)
  }
}

try {
  const loader = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
  })
  try {
    await syncPrompts(loader)
    await syncDataset(loader)
  } finally {
    await loader.close()
  }
} catch (error) {
  // No CLI request, response headers, or credentials reach the console.
  console.error(error instanceof Error ? error.message : "Langfuse sync failed")
  process.exitCode = 1
}
