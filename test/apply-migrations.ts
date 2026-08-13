import type { D1Migration } from "cloudflare:test"
import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { beforeAll, beforeEach } from "vitest"

import { seedCatalog } from "./seed-catalog"

// `TEST_D1_MIGRATIONS` is injected by `vitest.config.ts` and is deliberately
// absent from the generated Worker environment types.
const migrations = (env as unknown as { TEST_D1_MIGRATIONS: D1Migration[] })
  .TEST_D1_MIGRATIONS

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations)
  // The workflow validates references and resolves customers against the
  // catalogue, so the deterministic dataset has to be present for the contract
  // tests to mean anything.
  await seedCatalog(env.DB)
})

/**
 * Every test in a file shares one client address, so the hourly processing
 * counter would otherwise carry from one test into the next and start failing
 * unrelated runs at the sixth. The limit itself is not relaxed anywhere: the
 * counter simply starts empty for each test, exactly as it does for a visitor
 * whose hour has rolled over, and `test/rate-limit.test.ts` drives the real
 * boundary inside a single test.
 */
beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM rate_limit_windows`).run()
})
