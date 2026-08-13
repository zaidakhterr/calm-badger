import type { D1Migration } from "cloudflare:test"
import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { beforeAll } from "vitest"

// `TEST_D1_MIGRATIONS` is injected by `vitest.config.ts` and is deliberately
// absent from the generated Worker environment types.
const migrations = (env as unknown as { TEST_D1_MIGRATIONS: D1Migration[] })
  .TEST_D1_MIGRATIONS

beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations)
})
