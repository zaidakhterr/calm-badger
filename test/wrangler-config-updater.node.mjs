import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const updaterPath = path.join(
  repositoryRoot,
  "scripts",
  "update-wrangler-config.mjs"
)

const wranglerJsonc = `{
  // Wrangler preserves JSONC and may add trailing commas.
  "name": "replace-with-codename",
  "d1_databases": [{
    "binding": "DB",
    "database_name": "calm-badger-db",
    "database_id": "existing-id",
  }],
  "r2_buckets": [{
    "binding": "ARTIFACTS",
    "bucket_name": "calm-badger-artifacts",
  }],
  "workflows": [{
    "binding": "RFQ_WORKFLOW",
    "name": "replace-with-codename-workflow",
    "class_name": "RfqWorkflow",
  }],
  "vars": {
    "APP_ENV": "development",
    "PRESERVED": "value",
  },
}`

test("updates Wrangler-generated JSONC and preserves existing settings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rfq-wrangler-config-"))
  const configPath = path.join(directory, "wrangler.jsonc")

  try {
    await writeFile(configPath, wranglerJsonc)

    const result = spawnSync(
      process.execPath,
      [updaterPath, configPath, "calm-badger", "new-d1-id"],
      { encoding: "utf8" }
    )

    assert.equal(result.status, 0, result.stderr)

    const config = JSON.parse(await readFile(configPath, "utf8"))
    assert.equal(config.name, "calm-badger")
    assert.equal(config.d1_databases[0].database_name, "calm-badger-db")
    assert.equal(config.d1_databases[0].database_id, "new-d1-id")
    assert.equal(config.r2_buckets[0].bucket_name, "calm-badger-artifacts")
    assert.equal(config.workflows[0].name, "calm-badger-workflow")
    assert.equal(config.vars.APP_ENV, "production")
    assert.equal(config.vars.PRESERVED, "value")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("leaves the config untouched when the JSONC is invalid", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rfq-wrangler-config-"))
  const configPath = path.join(directory, "wrangler.jsonc")
  const invalidConfig = '{ "name": "broken", '

  try {
    await writeFile(configPath, invalidConfig)

    const result = spawnSync(
      process.execPath,
      [updaterPath, configPath, "calm-badger", "new-d1-id"],
      { encoding: "utf8" }
    )

    assert.notEqual(result.status, 0)
    assert.equal(await readFile(configPath, "utf8"), invalidConfig)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
