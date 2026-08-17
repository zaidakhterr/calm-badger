import fs from "node:fs"
import path from "node:path"
import { parse, printParseErrorCode } from "jsonc-parser"

const [configPath, slug, d1Id] = process.argv.slice(2)

if (!configPath || !slug || !d1Id) {
  throw new Error(
    "Usage: node scripts/update-wrangler-config.mjs <config-path> <slug> <d1-id>"
  )
}

/**
 * The Wrangler configuration this script rewrites. Wrangler writes many more
 * entries; they are read back and written out untouched.
 *
 * @typedef {{ binding: string }} BindingEntry
 * @typedef {{
 *   name: string
 *   vars: Record<string, string>
 *   d1_databases: BindingEntry[]
 *   r2_buckets: BindingEntry[]
 *   workflows: BindingEntry[]
 * }} WranglerConfig
 */

/** The kinds of entry `readJson` can require of a configuration key. */
const ENTRY_KINDS = {
  array: {
    description: "an array",
    accepts: (value) => Array.isArray(value),
  },
  object: {
    description: "an object",
    accepts: (value) => value instanceof Object && !Array.isArray(value),
  },
}

/**
 * Reads `filePath` as the JSONC Wrangler writes, and returns it only once every
 * key in `expected` is present with the kind named there. A configuration this
 * script cannot rewrite is refused before anything is written.
 *
 * @param {string} filePath
 * @param {Record<string, keyof typeof ENTRY_KINDS>} expected
 * @returns {WranglerConfig}
 */
function readJson(filePath, expected) {
  const source = fs.readFileSync(filePath, "utf8")
  const parseErrors = []
  const parsed = parse(source, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  })

  if (parseErrors.length > 0) {
    const details = parseErrors
      .map(
        ({ error, offset }) =>
          `${printParseErrorCode(error)} at character ${offset}`
      )
      .join(", ")
    throw new Error(`Unable to parse ${filePath} as JSONC: ${details}`)
  }

  if (!ENTRY_KINDS.object.accepts(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`)
  }

  for (const [key, kind] of Object.entries(expected)) {
    if (!ENTRY_KINDS[kind].accepts(parsed[key])) {
      throw new Error(
        `${filePath} must contain "${key}" as ${ENTRY_KINDS[kind].description}`
      )
    }
  }

  return parsed
}

const config = readJson(configPath, {
  d1_databases: "array",
  r2_buckets: "array",
  workflows: "array",
  vars: "object",
})

const binding = (collectionName, bindingName) => {
  const entry = config[collectionName].find(
    (candidate) => candidate?.binding === bindingName
  )

  if (!entry) {
    throw new Error(
      `${configPath} is missing the ${bindingName} binding in ${collectionName}`
    )
  }

  return entry
}

const database = binding("d1_databases", "DB")
const artifactBucket = binding("r2_buckets", "ARTIFACTS")
const workflow = binding("workflows", "RFQ_WORKFLOW")

config.name = slug
database.database_name = `${slug}-db`
database.database_id = d1Id
artifactBucket.bucket_name = `${slug}-artifacts`
workflow.name = `${slug}-workflow`
config.vars.APP_ENV = "production"

const temporaryPath = path.join(
  path.dirname(configPath),
  `.${path.basename(configPath)}.${process.pid}.tmp`
)

try {
  fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`)
  fs.renameSync(temporaryPath, configPath)
} finally {
  if (fs.existsSync(temporaryPath)) {
    fs.unlinkSync(temporaryPath)
  }
}
