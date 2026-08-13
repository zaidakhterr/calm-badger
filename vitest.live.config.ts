import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

/**
 * The live evaluation (`pnpm eval:live`).
 *
 * Same Worker, same public API, same scoring as the deterministic run — only
 * the provider seams differ. Nothing here selects a fake, so a missing key
 * fails the run visibly rather than quietly measuring a fake and calling it
 * live. Keys come from the environment or from `.dev.vars`, which the pool
 * loads for the local Worker; this file never reads or prints their values.
 *
 * It is never part of continuous integration: it costs money, needs credentials,
 * and its results move with the models behind them.
 */

const migrations = await readD1Migrations("./migrations")

/** Provider selection is configuration, so the environment decides it. */
const provider = (name: string, fallback: string) =>
  process.env[name] && process.env[name].length > 0
    ? process.env[name]
    : fallback

const keys: Record<string, string> = {}
for (const name of ["MISTRAL_API_KEY", "OPENROUTER_API_KEY"]) {
  // Only set when present: an absent value must fall through to `.dev.vars`
  // rather than being overridden with an empty string.
  if (process.env[name]) keys[name] = process.env[name]
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_D1_MIGRATIONS: migrations,
          // Not production: the guard that refuses a fake in production is not
          // what is being exercised here, and a local evaluation must stay out
          // of the deployed project's measurement.
          APP_ENV: "development",
          OCR_PROVIDER: provider("OCR_PROVIDER", "mistral"),
          EXTRACTION_PROVIDER: provider("EXTRACTION_PROVIDER", "openrouter"),
          RERANK_PROVIDER: provider("RERANK_PROVIDER", "openrouter"),
          ANALYTICS_PROVIDER: "none",
          POSTHOG_API_KEY: "",
          RATE_LIMIT_SALT: "local-evaluation-salt",
          // Long enough that a live run is never raced by its own review
          // window, short enough that a stuck evaluation still ends.
          REVIEW_WINDOW_SECONDS_CURATED: "900",
          REVIEW_WINDOW_SECONDS_CUSTOM: "900",
          ...keys,
        },
      },
    }),
  ],
  test: {
    include: ["test/reference-workflows.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    // Live providers are remote I/O; the evaluation waits for real work.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
})
