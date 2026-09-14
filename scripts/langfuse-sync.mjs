/** Seed a fresh project. Existing UI-authored prompts and labels remain authoritative. */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import { z } from "zod"

const root = fileURLToPath(new URL("../", import.meta.url))
const envelope = z.object({ status: z.number(), body: z.json() })
const promptVersion = z.object({ name: z.string(), version: z.number() })
const modelPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      modelName: z.string(),
      matchPattern: z.string(),
      isLangfuseManaged: z.boolean(),
      unit: z.string().nullable(),
      pricingTiers: z.array(
        z.object({
          isDefault: z.boolean(),
          prices: z.record(
            z.string(),
            z.union([
              z.number(),
              z.object({ price: z.number() }).transform((value) => value.price),
            ])
          ),
        })
      ),
    })
  ),
  meta: z.object({ totalPages: z.number() }),
})

const OCR_MODEL_NAME = "mistral-ocr-latest"
// Matches every Mistral OCR model id, so MISTRAL_OCR_MODEL can change.
const OCR_MODEL_MATCH_PATTERN = "(?i)^mistral-ocr(-[a-z0-9.-]+)?$"
// Mistral's current OCR 4.1 price is $4 per 1,000 pages.
const OCR_PAGE_PRICE_USD = 0.004

function cli(args, input) {
  const result = spawnSync(
    "npx",
    ["-y", "langfuse-cli@1.2.3", "api", ...args, "--json"],
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
  const { bundledPrompt } = await loader.ssrLoadModule(
    "/worker/langfuse/fallbacks.ts"
  )
  for (const seed of [
    {
      name: "rfq/extract",
      commitMessage: "Ticket 02: migrate the extraction prompt and schema",
    },
    {
      name: "rfq/rerank",
      commitMessage:
        "Ticket 03: migrate the rerank prompt, schema, and thresholds",
    },
  ]) {
    const fallback = bundledPrompt(seed.name)
    const existing = cli(["prompts", "get", fallback.name, "--label", "latest"])
    if (existing.status === 200) {
      const prompt = promptVersion.parse(existing.body)
      console.log(
        `Preserved ${prompt.name} version ${prompt.version}; Langfuse owns edits and labels.`
      )
      continue
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
        commitMessage: seed.commitMessage,
      })
    )
    if (created.status < 200 || created.status >= 300)
      throw new Error(`Prompt creation failed (${created.status})`)
    const prompt = promptVersion.parse(created.body)
    console.log(
      `Created ${prompt.name} version ${prompt.version} with label production.`
    )
  }
}

async function syncDataset(loader) {
  const datasetName = "rfq-scenarios"
  const existing = cli(["datasets", "get", datasetName])
  const { SCENARIO_INPUT, EXPECTED_OUTPUT, SCENARIO_METADATA } =
    await loader.ssrLoadModule("/evals/_contracts.ts")
  const { SCENARIOS } = await loader.ssrLoadModule("/worker/scenarios.ts")
  const item = z.object({
    input: SCENARIO_INPUT,
    expectedOutput: EXPECTED_OUTPUT,
    metadata: z.json().optional(),
  })
  const exported = z.object({ items: z.array(item) })
  const validate = (items) => {
    for (const entry of items) SCENARIO_METADATA.parse(entry.metadata)
    if (
      items.length !== SCENARIOS.length ||
      SCENARIOS.some(
        (scenario) =>
          items.filter((entry) => entry.input.scenarioId === scenario.id)
            .length !== 1
      )
    ) {
      throw new Error("Dataset must contain each curated scenario exactly once")
    }
  }
  if (existing.status === 200) {
    const response = cli([
      "dataset-items",
      "list",
      "--dataset-name",
      datasetName,
      "--limit",
      "100",
    ])
    if (response.status !== 200)
      throw new Error(`Dataset item lookup failed (${response.status})`)
    const listing = z
      .object({
        data: z.array(
          z.object({
            status: z.string(),
            input: z.json(),
            expectedOutput: z.json(),
            metadata: z.json().optional(),
          })
        ),
        meta: z.object({ totalItems: z.number() }),
      })
      .parse(response.body)
    if (listing.meta.totalItems > listing.data.length)
      throw new Error(
        "Dataset has more items than this curated experiment supports"
      )
    validate(
      listing.data
        .filter((entry) => entry.status === "ACTIVE")
        .map((entry) => item.parse(entry))
    )
    console.log("Preserved rfq-scenarios; Langfuse owns expected answers.")
    return
  }
  if (existing.status !== 404)
    throw new Error(`Dataset lookup failed (${existing.status})`)
  const bootstrapFile = process.env.LANGFUSE_DATASET_BOOTSTRAP
  if (!bootstrapFile)
    throw new Error(
      "Fresh project needs LANGFUSE_DATASET_BOOTSTRAP: an uncommitted export of rfq-scenarios with an items array. Expected answers live in Cloud."
    )
  const dataset = exported.parse(
    JSON.parse(readFileSync(bootstrapFile, "utf8"))
  )
  validate(dataset.items)
  const created = cli(
    ["datasets", "create", "--body-file", "-"],
    JSON.stringify({
      name: datasetName,
      description: "Curated RFQ Relay scenarios for public API experiments.",
    })
  )
  if (created.status < 200 || created.status >= 300)
    throw new Error(`Dataset creation failed (${created.status})`)
  for (const entry of dataset.items) {
    const response = cli(
      ["dataset-items", "create", "--body-file", "-"],
      JSON.stringify({
        datasetName,
        id: `rfq-scenarios-${entry.input.scenarioId}`,
        ...entry,
      })
    )
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Dataset item creation failed (${response.status})`)
    console.log(`Created dataset item ${entry.input.scenarioId}.`)
  }
}

function syncOcrModel() {
  for (let page = 1; ; page += 1) {
    const response = cli([
      "models",
      "list",
      "--page",
      String(page),
      "--limit",
      "100",
    ])
    if (response.status !== 200)
      throw new Error(`Model lookup failed (${response.status})`)
    const existing = modelPage.parse(response.body)
    const model = existing.data.find(
      (entry) => !entry.isLangfuseManaged && entry.modelName === OCR_MODEL_NAME
    )
    if (model) {
      // Cloud owns an existing model definition. A drifted price, unit, or
      // pattern is reported, never overwritten.
      const defaultTier = model.pricingTiers.find((tier) => tier.isDefault)
      if (
        model.unit !== "REQUESTS" ||
        model.matchPattern !== OCR_MODEL_MATCH_PATTERN ||
        defaultTier?.prices.pages !== OCR_PAGE_PRICE_USD
      ) {
        console.warn(
          `Preserved ${model.modelName} model ${model.id}. Its unit, pattern, or pages price differs from the seed.`
        )
        return
      }
      console.log(`Preserved ${model.modelName} model ${model.id}.`)
      return
    }
    if (page >= existing.meta.totalPages) break
  }

  const created = cli(
    ["models", "create", "--body-file", "-"],
    JSON.stringify(ocrModelBody())
  )
  if (created.status < 200 || created.status >= 300)
    throw new Error(`Model creation failed (${created.status})`)
  const model = z
    .object({ id: z.string(), modelName: z.string() })
    .parse(created.body)
  console.log(
    `Created ${model.modelName} model ${model.id} with pages pricing.`
  )
}

function ocrModelBody() {
  return {
    modelName: OCR_MODEL_NAME,
    matchPattern: OCR_MODEL_MATCH_PATTERN,
    unit: "REQUESTS",
    pricingTiers: [
      {
        name: "Standard",
        isDefault: true,
        priority: 0,
        conditions: [],
        prices: { pages: OCR_PAGE_PRICE_USD },
      },
    ],
  }
}

try {
  syncOcrModel()
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
