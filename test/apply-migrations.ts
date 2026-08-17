import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { beforeAll, beforeEach } from "vitest"
import { z } from "zod"

import { seedCatalog } from "./seed-catalog"

/**
 * The migrations `vitest.config.ts` injects into the environment.
 *
 * They are deliberately absent from the generated Worker environment types, so
 * the injection is a boundary like any other: an environment that arrives
 * without a readable migration list says so here, rather than inside the first
 * query of a suite that has no schema.
 */
const TEST_MIGRATIONS_SCHEMA = z.object({
  TEST_D1_MIGRATIONS: z.array(
    z.object({ name: z.string(), queries: z.array(z.string()) })
  ),
})

const { TEST_D1_MIGRATIONS: migrations } = TEST_MIGRATIONS_SCHEMA.parse(env)

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
