import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

const migrations = await readD1Migrations("./migrations")

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_D1_MIGRATIONS: migrations,
          // Tests never reach a live provider: the deterministic contract fake
          // is selected here, and no API key is present in the test isolate.
          APP_ENV: "test",
          OCR_PROVIDER: "contract-fake",
          EXTRACTION_PROVIDER: "contract-fake",
          RERANK_PROVIDER: "contract-fake",
          MISTRAL_API_KEY: "",
          OPENROUTER_API_KEY: "",
          // Analytics is a seam like the providers: the deterministic recorder
          // is selected here, so a test asserts what would have been sent to
          // PostHog without a key, a host, or a network call existing at all.
          ANALYTICS_PROVIDER: "contract-fake",
          POSTHOG_API_KEY: "",
          // A fixed salt keeps the rotating visitor hash reproducible within a
          // test run. It is not a secret and matches nothing deployed.
          RATE_LIMIT_SALT: "test-rate-limit-salt",
          // The review window is seconds rather than days here, so the
          // hibernating workflow's own expiry can be driven and observed
          // instead of being described. Every review test decides immediately
          // after the node opens; only the expiry tests wait it out.
          REVIEW_WINDOW_SECONDS_CURATED: "5",
          REVIEW_WINDOW_SECONDS_CUSTOM: "5",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // Starting a run writes to D1, spawns a workflow, and reads the scenario
    // attachment through ASSETS. Several tests do that half a dozen times in
    // sequence, which is fast locally and much slower on a contended CI
    // runner, so the per-test budget is well above the 5s default.
    testTimeout: 30_000,
  },
})
