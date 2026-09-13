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
      const existing = cli([
        "prompts",
        "get",
        fallback.name,
        "--label",
        "latest",
      ])
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
  } finally {
    await loader.close()
  }
}

try {
  await syncPrompts()
} catch (error) {
  // No CLI request, response headers, or credentials reach the console.
  console.error(error instanceof Error ? error.message : "Langfuse sync failed")
  process.exitCode = 1
}
