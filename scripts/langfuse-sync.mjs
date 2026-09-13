/** Seed a fresh project. Existing UI-authored prompts and labels remain authoritative. */
import { spawnSync } from "node:child_process"
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
const OCR_MODEL_MATCH_PATTERN = "(?i)^mistral-ocr-latest$"
// Mistral's current OCR 4.1 price is $4 per 1,000 pages.
const OCR_PAGE_PRICE_USD = 0.004

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

async function syncPrompts() {
  // Vite resolves the same TypeScript fallback used by the Worker. Middleware mode opens no listener.
  const loader = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
  })
  try {
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
  } finally {
    await loader.close()
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
      (entry) =>
        !entry.isLangfuseManaged &&
        entry.modelName === OCR_MODEL_NAME &&
        entry.matchPattern === OCR_MODEL_MATCH_PATTERN
    )
    if (model) {
      const defaultTier = model.pricingTiers.find((tier) => tier.isDefault)
      if (
        model.unit !== "REQUESTS" ||
        defaultTier?.prices.pages !== OCR_PAGE_PRICE_USD
      ) {
        const updated = cli(
          ["models", "upsert", model.id, "--body-file", "-"],
          JSON.stringify(ocrModelBody())
        )
        if (updated.status < 200 || updated.status >= 300)
          throw new Error(`Model update failed (${updated.status})`)
        console.log(
          `Updated ${model.modelName} model ${model.id} with pages pricing.`
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
  await syncPrompts()
} catch (error) {
  // No CLI request, response headers, or credentials reach the console.
  console.error(error instanceof Error ? error.message : "Langfuse sync failed")
  process.exitCode = 1
}
