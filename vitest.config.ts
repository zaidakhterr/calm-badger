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
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
})
